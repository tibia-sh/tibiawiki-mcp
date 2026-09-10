import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDb, resolveDbPath } from '../db.ts';

/** Pinned: the schema this server probes for is this generator's output. */
const GENERATOR = 'tibiawikisql==9.0.0';

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
  opts: { targetPath?: string; run?: Runner } = {},
): Promise<string> {
  const target = opts.targetPath ?? resolveDbPath();
  const run = opts.run ?? defaultRunner;

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
