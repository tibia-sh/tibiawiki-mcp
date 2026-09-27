import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
 * takes its token from GH_TOKEN.
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

/** An open pull request from a generator/<version> branch of this repository. */
export interface GeneratorPr {
  version: string;
  number: number;
  autoMerge: boolean;
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
 * - `noop` for the pinned version, for a version with an open PR whose auto-merge is on,
 *   and while a PR for a newer version is open, since that one supersedes the request;
 * - `refuse` for a version below the pin;
 * - `rearm` for a version with an open PR whose auto-merge is off, as a run interrupted
 *   after it opened the PR leaves it;
 * - `propose` otherwise.
 *
 * `rearm` and `propose` supersede the open PRs for versions below the request.
 */
export function decideGenerator(pinned: string, requested: string, prs: readonly GeneratorPr[]): GeneratorDecision {
  const toPinned = compareVersions(requested, pinned);
  for (const pr of prs) {
    assertGeneratorVersion(pr.version);
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) throw new Error(`${pr.number} is not a pull request number.`);
    if (prs.some((other) => other !== pr && other.version === pr.version)) {
      throw new Error(`There are two open pull requests for ${pr.version}, so which one to merge is not clear.`);
    }
  }
  if (toPinned === 0) return { action: 'noop', supersede: [] };
  if (toPinned < 0) return { action: 'refuse', supersede: [] };
  if (prs.some((pr) => compareVersions(pr.version, requested) > 0)) return { action: 'noop', supersede: [] };
  const supersede = prs.filter((pr) => compareVersions(pr.version, requested) < 0).map((pr) => pr.number);
  const open = prs.find((pr) => pr.version === requested);
  if (open === undefined) return { action: 'propose', supersede };
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

/**
 * The open PRs into main from this repository's generator/<version> branches. A PR from a
 * fork counts for nothing, whatever its branch is called: its branch name is anyone's to
 * choose, and a rearm would turn on its auto-merge.
 */
function openGeneratorPrs(): GeneratorPr[] {
  const output = execFileSync('gh', [
    'api', '--paginate', 'repos/{owner}/{repo}/pulls?state=open&base=main&per_page=100',
    '--jq', '.[] | {number, ref: .head.ref, headRepo: .head.repo.full_name, baseRepo: .base.repo.full_name, autoMerge: (.auto_merge != null)}',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 });
  return output.split('\n').filter((line) => line !== '').flatMap((line) => {
    const pr = JSON.parse(line) as PrLine;
    const version = /^generator\/(.*)$/.exec(pr.ref)?.[1];
    if (pr.headRepo !== pr.baseRepo || version === undefined || !GENERATOR_VERSION_PATTERN.test(version)) return [];
    if (typeof pr.autoMerge !== 'boolean') throw new Error(`gh printed a pull request it could not read: ${line}`);
    return [{ version, number: pr.number, autoMerge: pr.autoMerge }];
  });
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
function decide(version: string): GeneratorDecision {
  assertGeneratorVersion(version);
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 });
  git(['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const pinned = pinnedGenerator(git(['show', 'refs/remotes/origin/main:src/indexer/build-index.ts']));
  return decideGenerator(pinned, version, openGeneratorPrs());
}

if (import.meta.main) {
  const [command, version, ...rest] = process.argv.slice(2);
  if (version === undefined || rest.length > 0 || (command !== 'set' && command !== 'decide')) {
    throw new Error('Usage: node scripts/set-generator.ts set <version> | decide <version>');
  }
  if (command === 'set') {
    process.stdout.write(`${await set(version)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(decide(version))}\n`);
  }
}
