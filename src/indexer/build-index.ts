import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDb, resolveDbPath } from '../db.ts';
import { createWikiApi, type WikiApi } from './wiki-api.ts';
import { enrich, eligibleScenes, formatStats, type Enricher } from './enrich.ts';

/** Pinned: the schema this server probes for is this generator's output. */
const GENERATOR = 'tibiawikisql==9.0.0';

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

export type Runner = (
  cmd: string,
  args: string[],
) => { status: number | null; stderr: string };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
  return { status: r.status, stderr: r.stderr ?? '' };
};

/**
 * Generates the local index and installs it atomically.
 *
 * Only the `uvx` path is implemented. A Docker image exists but its entrypoint was
 * never verified, and a guessed `docker run` line would be a placeholder in disguise.
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
  const target = opts.targetPath ?? resolveDbPath();
  const run = opts.run ?? defaultRunner;
  const enrichIndex = opts.enrich ?? enrich;
  const api = opts.api ?? createWikiApi();
  const minCoverage = opts.minCoverage ?? MIN_COVERAGE;

  mkdirSync(dirname(target), { recursive: true });
  // Unique per invocation so two concurrent runs cannot corrupt each other.
  const temp = join(dirname(target), `.tibiawiki.db.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const discard = () => rmSync(temp, { force: true });

  const args = ['--from', GENERATOR, 'tibiawikisql', 'generate', '--skip-images', '-o', temp];
  const { status, stderr } = run('uvx', args);

  if (status !== 0) {
    discard();
    throw new Error(
      `Index generation failed (exit ${status}). Is \`uv\` installed? ` +
        `See https://docs.astral.sh/uv/\n${stderr}`,
    );
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
