import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDbPath, openDb } from '../db.ts';
import { createWikiApi, type WikiApi } from './wiki-api.ts';
import { enrich, eligibleScenes, formatStats, IMAGE_TYPES, type Enricher } from './enrich.ts';

/**
 * Pinned: the schema this server probes for is this generator's output. The build never
 * names it directly. `pnpm lock-generator` locks exactly this, and the build installs
 * that lock.
 */
export const GENERATOR = 'tibiawikisql==9.0.0';

/**
 * The Pythons the generator environment may be created with. The lock is compiled for
 * the floor, and `pnpm lock-generator` checks it installs on every minor version below
 * the cap, so the two cannot drift apart. The cap is where the lock's wheels end:
 * mwparserfromhell 0.7.2 ships nothing past cp313, and `--no-build` forbids building it
 * from source. Unbounded, uv would pick or download a 3.14 the lock cannot install on.
 *
 * CPython is named because that check proves CPython wheels, and the locked
 * mwparserfromhell ships CPython wheels only. Unnamed, uv could take a PyPy or GraalPy it
 * finds first, which the lock does not install on.
 */
export const GENERATOR_PYTHON = 'cpython>=3.10,<3.14';

/**
 * The generator and every dependency, pinned and hashed, written by `pnpm lock-generator`.
 * Resolved like SPELL_AREAS_PATH, so it names the same file from src/indexer/ and
 * dist/indexer/, inside a checkout and inside an install.
 */
export const GENERATOR_LOCK_PATH = fileURLToPath(
  new URL('../../data/tibiawikisql-requirements.txt', import.meta.url),
);

/**
 * Floor for stored areas as a share of eligible scenes. Measured at 98.8% over the
 * full corpus, so this leaves real headroom while still failing loudly if a wiki or
 * generator change breaks extraction.
 */
const MIN_COVERAGE = 0.95;

/**
 * Ceiling on members whose opener the generator would not recognise, as a share of
 * all scenes. These leave BOTH sides of the coverage ratio, so a regression that
 * started misreading canonical members would hold coverage at ~98.8% while quietly
 * losing their areas - the one blind spot the counter itself cannot close.
 * Measured at 18 of 1,874 (1.0%); 2% is room to grow without hiding a regression.
 */
const MAX_UNPARSED_SHARE = 0.02;

/**
 * Per-type floor for image resolution. Measured over full populations: four types at
 * 100%, worst is spell at 209/211 = 99.05%. Per type rather than corpus-wide because
 * a corpus-wide rate hides a whole type: every charm failing is 0.6% of 13,799.
 */
const MIN_IMAGE_COVERAGE = 0.95;

/**
 * Spell area shapes are read from committed data, so a shortfall means the file is
 * missing, truncated, or its keys stopped matching index titles - never a wiki gap.
 * Measured: 24 served.
 */
const MIN_SPELL_SHAPES = 20;

/** Truncates loudly: a silently shortened list under-reports what was skipped. */
function listTitles(titles: readonly string[], limit = 10): string {
  return titles.length <= limit
    ? titles.join(', ')
    : `${titles.slice(0, limit).join(', ')} and ${titles.length - limit} more`;
}

/**
 * `error` is the spawn error code, set when the command could not start, such as `ENOENT`,
 * and when Node stopped it: `ENOBUFS` once its stderr passed spawnSync's 1 MiB maxBuffer.
 * `signal` is the signal that ended the command, set only when one did, and then `status`
 * is null. Node stops an over-buffered command with SIGTERM, so `ENOBUFS` comes with both.
 */
export type Runner = (
  cmd: string,
  args: string[],
) => { status: number | null; signal: NodeJS.Signals | null; stderr: string; error?: string };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
  return {
    status: r.status,
    signal: r.signal,
    stderr: r.stderr ?? '',
    error: (r.error as NodeJS.ErrnoException | undefined)?.code,
  };
};

/**
 * How a uv command failed, for the parenthetical in its error. Only a command that exited
 * has an exit status. One that could not start is named by its spawn error, and one a
 * signal ended by the signal. `ENOBUFS` is checked first, because Node reports it beside
 * the SIGTERM it stopped the command with, and the signal would hide the cause: stderr
 * passed the 1 MiB maxBuffer the default runner leaves in place.
 */
function describeFailure(command: string, { status, signal, error }: ReturnType<Runner>): string {
  if (error === 'ENOBUFS') return `\`${command}\` wrote more than 1 MiB to stderr and was stopped`;
  if (error !== undefined) return `\`${command}\` could not start: ${error}`;
  if (signal !== null) return `\`${command}\` was killed by ${signal}`;
  return `\`${command}\` exit ${status}`;
}

/**
 * Requirements in a lock `uv pip compile` wrote: each starts a line, with its `--hash`
 * options and `# via` notes indented beneath it. Nothing here checks a hash, because
 * `uv pip install --require-hashes` refuses an unhashed or mismatched entry itself.
 */
function countRequirements(lock: string): number {
  return lock.split('\n').filter((line) => /^[^\s#]/.test(line)).length;
}

/**
 * Runs the generator from a throwaway environment and has it write the index to `output`.
 *
 * The environment is a fresh directory under the OS temp directory, never beside the
 * target: the data repo builds into its checkout root. It is removed on every exit path,
 * as soon as the generator returns.
 */
function generate(run: Runner, output: string): void {
  // Read before uv runs, so a missing lock fails before uv creates anything.
  const requirements = countRequirements(readFileSync(GENERATOR_LOCK_PATH, 'utf8'));
  const env = mkdtempSync(join(tmpdir(), 'tibiawiki-mcp-generator-'));
  // A failed `uv venv` is an install failure too. The generator never runs from an
  // environment the lock did not fully install.
  const install = (command: string, args: string[]): void => {
    const result = run('uv', args);
    if (result.status !== 0) {
      throw new Error(
        `Could not install the generator environment (${describeFailure(command, result)}). ` +
          `Is \`uv\` installed? See https://docs.astral.sh/uv/\n${result.stderr}`,
      );
    }
  };
  try {
    // `--python <env>` hands uv the environment itself, so no platform's bin/ or Scripts\
    // layout is spelled out here.
    install('uv venv', ['venv', '--python', GENERATOR_PYTHON, env]);
    install('uv pip install', ['pip', 'install', '--python', env, '--require-hashes', '--no-build', '-r', GENERATOR_LOCK_PATH]);
    process.stderr.write(
      `Generator environment installed from ${basename(GENERATOR_LOCK_PATH)} ` +
        `with ${requirements} hashed requirements.\n`,
    );

    const generated = run('uv', [
      'run', '--no-project', '--python', env, 'tibiawikisql', 'generate', '--skip-images', '-o', output,
    ]);
    if (generated.status !== 0) {
      throw new Error(`Index generation failed (${describeFailure('uv run', generated)}).\n${generated.stderr}`);
    }
  } finally {
    rmSync(env, { recursive: true, force: true });
  }
}

/**
 * Generates the local index and installs it atomically.
 *
 * The generator runs through three uv commands. `uv venv` creates a throwaway environment,
 * `uv pip install --require-hashes` installs it from the shipped lock alone, and `uv run`
 * runs tibiawikisql from it. `uvx` is not used, because it cannot check a hash. A Docker
 * image exists but its entrypoint was never verified, and a guessed `docker run` line
 * would be a placeholder in disguise.
 */
export async function buildIndex(
  opts: {
    targetPath?: string;
    run?: Runner;
    enrich?: Enricher;
    api?: WikiApi;
    minCoverage?: number;
  } = {},
): Promise<string> {
  // Never the read resolution, which can name the packaged index inside node_modules.
  const target = opts.targetPath ?? cacheDbPath();
  const run = opts.run ?? defaultRunner;
  const enrichIndex = opts.enrich ?? enrich;
  const api = opts.api ?? createWikiApi();
  const minCoverage = opts.minCoverage ?? MIN_COVERAGE;

  mkdirSync(dirname(target), { recursive: true });
  // Unique per invocation so two concurrent runs cannot corrupt each other.
  const temp = join(dirname(target), `.tibiawiki.db.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const discard = () => rmSync(temp, { force: true });

  try {
    generate(run, temp);
  } catch (error) {
    discard();
    throw error;
  }
  if (!existsSync(temp)) {
    discard();
    throw new Error(`Generator reported success but produced no file at ${temp}.`);
  }

  // Enrichment must precede validation: it creates the mcp_* tables the probe
  // requires, so a validate-first order would reject the generator's own output.
  try {
    const stats = await enrichIndex(temp, api);
    process.stderr.write(`Enrichment:\n${formatStats(stats)}\n`);

    if (stats.missingPages > 0) {
      // Coverage is a ratio over pages that came back. Accepting a partial fetch
      // would let a truncated response report full coverage on a gutted index.
      throw new Error(
        `${stats.missingPages} indexed creature page(s) returned no content. Coverage ` +
          'cannot be judged on a partial fetch; refusing to install.',
      );
    }

    if (stats.scenes > 0 && stats.unparsedMember / stats.scenes > MAX_UNPARSED_SHARE) {
      throw new Error(
        `${stats.unparsedMember} of ${stats.scenes} scenes sit behind an unrecognised member ` +
          `opener (over the ${(100 * MAX_UNPARSED_SHARE).toFixed(0)}% ceiling). These leave both ` +
          'sides of the coverage ratio, so coverage cannot be trusted here; member parsing has ' +
          'likely regressed.',
      );
    }

    for (const { entityType } of IMAGE_TYPES) {
      const s = stats.images[entityType];
      // A per-type rate cannot catch a type that was never requested at all: there
      // would simply be no entry, and every present type would still read 100%.
      if (!s || s.subjects === 0) {
        throw new Error(
          `Image resolution reported no subjects for "${entityType}". Every image-bearing ` +
            'type must be requested; refusing to install.',
        );
      }
      if (s.invalid > 0) {
        throw new Error(
          `Image resolution for "${entityType}" returned ${s.invalid} unusable response(s). ` +
            'That is a broken integration rather than a wiki gap; refusing to install.',
        );
      }
      const rate = s.resolved / s.subjects;
      if (rate < MIN_IMAGE_COVERAGE) {
        throw new Error(
          `Image resolution for "${entityType}" is ${(100 * rate).toFixed(1)}%, below the ` +
            `${(100 * MIN_IMAGE_COVERAGE).toFixed(0)}% floor (${s.resolved} of ${s.subjects}). ` +
            'The naming convention has likely changed.',
        );
      }
    }

    // An unmatched key is reported loudly but does NOT fail the build. The keys are
    // validated against the index at authoring time - scripts/decode-spell-areas.ts
    // throws on any unmatched title - so a mismatch here means the wiki renamed a
    // page since. Failing would brick `tibiawiki-mcp build-index` for every user,
    // including a fresh install with no index at all, over one cosmetic derived
    // shape. The floor below still catches a wholesale mismatch.
    if (stats.spellShapes.unmatched > 0) {
      process.stderr.write(
        `warning: ${stats.spellShapes.unmatched} spell area key(s) matched no row in the ` +
          `index and were skipped: ${listTitles(stats.spellShapes.unmatchedTitles)}. ` +
          'The wiki has likely renamed a spell page; re-run `pnpm decode-spell-areas`.\n',
      );
    }
    if (stats.spellShapes.served < MIN_SPELL_SHAPES) {
      throw new Error(
        `Only ${stats.spellShapes.served} spell area shapes stored, below the floor of ` +
          `${MIN_SPELL_SHAPES}. data/spell-areas.json is missing or truncated; refusing to install.`,
      );
    }

    const eligible = eligibleScenes(stats);
    if (eligible <= 0) {
      // A NaN ratio compares false against any threshold, so an empty corpus would
      // otherwise pass the gate silently.
      throw new Error(
        'Enrichment found no eligible scenes at all. Either the wiki changed shape or ' +
          'extraction is broken; refusing to install an index with no area data.',
      );
    }
    const coverage = stats.stored / eligible;
    if (coverage < minCoverage) {
      throw new Error(
        `Area coverage ${(100 * coverage).toFixed(1)}% is below the ${(100 * minCoverage).toFixed(0)}% floor ` +
          `(${stats.stored} stored of ${eligible} eligible scenes). Extraction has likely regressed.`,
      );
    }
  } catch (error) {
    discard();
    throw new Error(`Enrichment failed for ${temp}: ${(error as Error).message}`);
  }

  // Exit zero plus a file on disk is not proof of a usable index. Validate the
  // schema, and close the handle before renaming so nothing holds the file open.
  try {
    openDb(temp).close();
  } catch (error) {
    discard();
    throw new Error(
      `Generator output at ${temp} is not a valid TibiaWiki index: ${(error as Error).message}`,
    );
  }

  try {
    renameSync(temp, target);
  } catch (error) {
    discard();
    throw new Error(`Could not install the index at ${target}: ${(error as Error).message}`);
  }
  return target;
}
