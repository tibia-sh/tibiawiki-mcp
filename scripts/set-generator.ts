import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertGeneratorVersion, GENERATOR_VERSION_PATTERN, generatorWheelUrl } from '../src/indexer/generator-release.ts';

/**
 * Moves the generator pin, for generator.yml and for a maintainer. It imports only `node:`
 * modules and generator-release.ts, so the job that holds the App token can run it from its
 * own checkout without installing anything.
 *
 *   node scripts/set-generator.ts set <version>      pin <version> and the sha256 of its wheel
 *   node scripts/set-generator.ts decide <version>   print what generator.yml does for <version>
 *
 * `set` downloads the wheel and writes build-index.ts only once it has hashed it, so a failed
 * download writes nothing. It does not verify the attestation: `pnpm lock-generator` does,
 * for the version and sha256 `set` wrote, before it writes the lock.
 *
 * `decide` fetches main and reads the pin there, not in the checkout, since main can have
 * moved since the run started. It reads the open generator/* pull requests with gh, which
 * takes its token from GH_TOKEN, and fetches each one to tell whether it was built on an older pin.
 * For the requested version's open pull request, when it was not, it asks GitHub whether the PR
 * conflicts with main. GitHub may still be computing that, so it asks up to 3 times,
 * MERGEABLE_RETRY_SECONDS apart (5 unless set), and fails when the answer is still unknown.
 */

const BUILD_INDEX_PATH = fileURLToPath(new URL('../src/indexer/build-index.ts', import.meta.url));

const VERSION_LINE = /^export const GENERATOR_VERSION = '([^']*)';$/;
const SHA256_LINE = /^export const GENERATOR_SHA256 = '([^']*)';$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The index of the one line of `lines` that `pattern` matches. Throws unless there is exactly one. */
function onlyLine(lines: readonly string[], pattern: RegExp, name: string): number {
  const found = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
  if (found.length !== 1) {
    throw new Error(`build-index.ts must declare ${name} on one line of its own, but does ${found.length} times.`);
  }
  return found[0]!;
}

/** The generator version a build-index.ts source pins. */
export function pinnedGenerator(source: string): string {
  const lines = source.split('\n');
  const version = VERSION_LINE.exec(lines[onlyLine(lines, VERSION_LINE, 'GENERATOR_VERSION')]!)![1]!;
  assertGeneratorVersion(version);
  return version;
}

/**
 * `source`, a build-index.ts, with GENERATOR_VERSION set to `version` and GENERATOR_SHA256 to
 * `sha256`, and every other byte as it was. Throws when either value is not whole, and when
 * either line is not in `source` exactly once.
 */
export function setGenerator(source: string, version: string, sha256: string): string {
  assertGeneratorVersion(version);
  if (!SHA256.test(sha256)) throw new Error(`${JSON.stringify(sha256)} is not a sha256 in lowercase hex.`);
  const lines = source.split('\n');
  lines[onlyLine(lines, VERSION_LINE, 'GENERATOR_VERSION')] = `export const GENERATOR_VERSION = '${version}';`;
  lines[onlyLine(lines, SHA256_LINE, 'GENERATOR_SHA256')] = `export const GENERATOR_SHA256 = '${sha256}';`;
  return lines.join('\n');
}

/**
 * An open pull request from a generator/<version> branch of this repository. `stale` says it
 * was built on a main whose pin is not main's now, as `isStale` reads its base: the queue's
 * rebase would then conflict on the two constant lines, and the PR could never merge.
 * `conflicting` says GitHub reports that it conflicts with main for any other reason, such as
 * a manual re-lock. Only the requested version's PR, when not stale, is asked; the others carry false.
 */
export interface GeneratorPr {
  version: string;
  number: number;
  autoMerge: boolean;
  stale: boolean;
  conflicting: boolean;
}

/** The GENERATOR_VERSION and GENERATOR_SHA256 lines of a build-index.ts, or undefined without exactly one of each. */
const pinLines = (source: string): string | undefined => {
  const lines = source.split('\n');
  const version = lines.filter((line) => VERSION_LINE.test(line));
  const sha256 = lines.filter((line) => SHA256_LINE.test(line));
  return version.length === 1 && sha256.length === 1 ? `${version[0]}\n${sha256[0]}` : undefined;
};

/**
 * Whether a PR whose one commit sits on a base with build-index.ts `baseSource` is stale
 * against main's `mainSource`: the base pins another version or sha256 than main does, or
 * either file does not declare each constant exactly once. The PR's commit rewrites those
 * two lines, so rebased onto main it conflicts exactly when they differ.
 */
export function isStale(mainSource: string, baseSource: string): boolean {
  const main = pinLines(mainSource);
  return main === undefined || main !== pinLines(baseSource);
}

/**
 * What generator.yml does for a requested version, and the open PRs it closes because the
 * request supersedes them. A `rearm` names the PR whose auto-merge it turns back on.
 */
export type GeneratorDecision =
  | { action: 'noop' | 'refuse' | 'propose'; supersede: number[] }
  | { action: 'rearm'; supersede: number[]; pr: number };

/** A generator version as numbers: the base x.y.z, then the tibiash release. */
const versionParts = (version: string): bigint[] => {
  assertGeneratorVersion(version);
  return version.split(/[.+]/).filter((part) => part !== 'tibiash').map(BigInt);
};

/** Below 0 when `a` is older than `b`, 0 when they are the same, and above 0 when `a` is newer. */
const compareVersions = (a: string, b: string): number => {
  const [left, right] = [versionParts(a), versionParts(b)];
  const index = left.findIndex((part, i) => part !== right[i]);
  return index === -1 ? 0 : left[index]! < right[index]! ? -1 : 1;
};

/**
 * Decides what to do for `requested`, with main pinning `pinned` and `prs` open from this
 * repository's generator/* branches:
 *
 * - `noop` for the pinned version, for a version with a current open PR whose auto-merge
 *   is on, and while a PR for a newer version is open, since that one supersedes the request;
 * - `refuse` for a version below the pin;
 * - `rearm` for a version with a current open PR whose auto-merge is off, as a run
 *   interrupted after it opened the PR leaves it;
 * - `propose` otherwise, a version whose open PR is stale or conflicting included: its branch
 *   is rebuilt on main and force-pushed, so a repeated request repairs a PR that can no longer merge.
 *
 * `rearm` and `propose` supersede the open PRs for versions below the request.
 */
export function decideGenerator(pinned: string, requested: string, prs: readonly GeneratorPr[]): GeneratorDecision {
  const toPinned = compareVersions(requested, pinned);
  for (const pr of prs) {
    assertGeneratorVersion(pr.version);
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error(`${pr.number} is not a pull request number.`);
    if (typeof pr.autoMerge !== 'boolean' || typeof pr.stale !== 'boolean' || typeof pr.conflicting !== 'boolean') {
      throw new Error(`Pull request ${pr.number} has no plain autoMerge, stale and conflicting.`);
    }
    if (prs.some((other) => other !== pr && other.version === pr.version)) {
      throw new Error(`There are two open pull requests for ${pr.version}, so which one to merge is not clear.`);
    }
  }
  if (toPinned === 0) return { action: 'noop', supersede: [] };
  if (toPinned < 0) return { action: 'refuse', supersede: [] };
  if (prs.some((pr) => compareVersions(pr.version, requested) > 0)) return { action: 'noop', supersede: [] };
  const supersede = prs.filter((pr) => compareVersions(pr.version, requested) < 0).map((pr) => pr.number);
  const open = prs.find((pr) => pr.version === requested);
  if (open === undefined || open.stale || open.conflicting) return { action: 'propose', supersede };
  if (open.autoMerge) return { action: 'noop', supersede: [] };
  return { action: 'rearm', supersede, pr: open.number };
}

/** A PR as the gh read in `openGeneratorPrs` prints it, one JSON object per line. */
interface PrLine {
  number: number;
  ref: string;
  headRepo: string | null;
  baseRepo: string;
  autoMerge: boolean;
}

/** Runs git with `args` and returns its stdout. Its errors go to stderr. */
const git = (args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 });

/** Runs gh with `args` and returns its stdout. Its errors go to stderr. */
const gh = (args: string[]): string =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 });

/** How many times `conflictsWithMain` asks GitHub before it gives up. */
const MERGEABLE_READS = 3;

/** The seconds between two reads of `mergeable`: MERGEABLE_RETRY_SECONDS, 5 unless set. Throws unless it is a whole number. */
function mergeableRetrySeconds(): number {
  const value = process.env['MERGEABLE_RETRY_SECONDS'] ?? '5';
  if (!/^(0|[1-9][0-9]{0,5})$/.test(value)) {
    throw new Error(`MERGEABLE_RETRY_SECONDS is ${JSON.stringify(value)}, not a whole number of seconds below 1000000.`);
  }
  return Number(value);
}

/**
 * Whether GitHub reports open pull request `number`, for `version`, as conflicting with main.
 * GitHub computes `mergeable` in the background and answers null until it has, so this asks up
 * to MERGEABLE_READS times, `retrySeconds` apart. It throws when the answer is still null, since
 * an unknown answer must neither rebuild the PR nor leave it, and on anything but a boolean or null.
 */
async function conflictsWithMain(number: number, version: string, retrySeconds: number): Promise<boolean> {
  for (let read = 1; read <= MERGEABLE_READS; read += 1) {
    const body = gh(['api', `repos/{owner}/{repo}/pulls/${number}`]);
    const pr = JSON.parse(body) as unknown;
    const mergeable = typeof pr === 'object' && pr !== null && !Array.isArray(pr) ? (pr as { mergeable?: unknown }).mergeable : undefined;
    if (typeof mergeable === 'boolean') return !mergeable;
    if (mergeable !== null) {
      throw new Error(`gh printed pull request #${number} with a mergeable that is not true, false or null: ${body}`);
    }
    if (read < MERGEABLE_READS) await sleep(retrySeconds * 1000);
  }
  throw new Error(`GitHub has not computed whether pull request #${number} conflicts with main. Dispatch generator.yml again for ${version}.`);
}

/**
 * The open PRs into main from this repository's generator/<version> branches, each fetched
 * from refs/pull/<number>/head to tell whether its base is stale against `mainSource`, main's
 * build-index.ts. The one for `requested`, when not stale, is asked whether it conflicts with
 * main, `retrySeconds` apart. A PR from a fork counts for nothing, whatever its branch is called:
 * its branch name is anyone's to choose, and a rearm would turn on its auto-merge.
 */
async function openGeneratorPrs(mainSource: string, requested: string, retrySeconds: number): Promise<GeneratorPr[]> {
  const output = gh([
    'api', '--paginate', 'repos/{owner}/{repo}/pulls?state=open&base=main&per_page=100',
    '--jq', '.[] | {number, ref: .head.ref, headRepo: .head.repo.full_name, baseRepo: .base.repo.full_name, autoMerge: (.auto_merge != null)}',
  ]);
  const prs: GeneratorPr[] = [];
  for (const line of output.split('\n').filter((entry) => entry !== '')) {
    const pr = JSON.parse(line) as PrLine;
    const version = /^generator\/(.*)$/.exec(pr.ref)?.[1];
    if (pr.headRepo !== pr.baseRepo || version === undefined || !GENERATOR_VERSION_PATTERN.test(version)) continue;
    if (typeof pr.autoMerge !== 'boolean' || !Number.isSafeInteger(pr.number) || pr.number < 1) {
      throw new Error(`gh printed a pull request it could not read: ${line}`);
    }
    // The PR's base is its head's parent, since generator.yml builds the PR as one commit.
    git(['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${pr.number}/head`]);
    let baseSource: string | undefined;
    try {
      baseSource = git(['show', 'FETCH_HEAD^:src/indexer/build-index.ts']);
    } catch {
      // A head without a parent, or a parent without build-index.ts, is rebuilt like a stale one.
    }
    const stale = baseSource === undefined || isStale(mainSource, baseSource);
    // A stale PR is rebuilt anyway, so only a current one for the requested version is asked.
    const conflicting = version === requested && !stale && (await conflictsWithMain(pr.number, version, retrySeconds));
    prs.push({ version, number: pr.number, autoMerge: pr.autoMerge, stale, conflicting });
  }
  return prs;
}

/** Pins `version` and the sha256 of its wheel in build-index.ts, and returns that sha256. */
async function set(version: string): Promise<string> {
  assertGeneratorVersion(version);
  const url = generatorWheelUrl(version);
  // fetch follows the release download's redirect to its storage host.
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}, so build-index.ts was not written.`);
  }
  const sha256 = createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
  const next = setGenerator(readFileSync(BUILD_INDEX_PATH, 'utf8'), version, sha256);
  // Written beside the file and renamed over it, so an interrupted run never leaves half of it.
  const temp = join(dirname(BUILD_INDEX_PATH), `.${basename(BUILD_INDEX_PATH)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, next);
    renameSync(temp, BUILD_INDEX_PATH);
  } finally {
    rmSync(temp, { force: true });
  }
  return sha256;
}

/** What generator.yml does for `version`, from main's pin after a fetch and the open generator PRs. */
async function decide(version: string): Promise<GeneratorDecision> {
  assertGeneratorVersion(version);
  const retrySeconds = mergeableRetrySeconds();
  git(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const mainSource = git(['show', 'refs/remotes/origin/main:src/indexer/build-index.ts']);
  return decideGenerator(pinnedGenerator(mainSource), version, await openGeneratorPrs(mainSource, version, retrySeconds));
}

if (import.meta.main) {
  const [command, version, ...rest] = process.argv.slice(2);
  if (version === undefined || rest.length > 0 || (command !== 'set' && command !== 'decide')) {
    throw new Error('Usage: node scripts/set-generator.ts set <version> | decide <version>');
  }
  if (command === 'set') {
    process.stdout.write(`${await set(version)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(await decide(version))}\n`);
  }
}
