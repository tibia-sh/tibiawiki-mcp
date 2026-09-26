import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, SCHEMA_VERSION } from '@tibia.sh/tibiawiki-data';
import { MCP_SCHEMA_VERSION, MIN_DATA_VERSION } from '../src/db.ts';

/**
 * The data package's major version is the schema version of the index it ships, and
 * MIN_DATA_VERSION is the first release whose index has every column the probe requires.
 * That makes the dependency range the thing that stops npm pairing this server with an
 * index it cannot read, so both halves of the pairing are pinned here.
 */

type Pkg = { version: string; dependencies: Record<string, string> };
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Pkg;

/** A plain x.y.z version as three numbers, so 3.10.0 sorts above 3.9.0. */
function parts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, `${version} is not a plain x.y.z version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Computed from the constant, never written as the literal. A floor that left this
 * range behind would let npm install an older index into a server that rejects it, and
 * every user would meet a SchemaError at startup instead of whoever raised the floor
 * meeting this failure.
 */
test('the data dependency range is the data floor this server reads', () => {
  assert.equal(pkg.dependencies['@tibia.sh/tibiawiki-data'], `^${MIN_DATA_VERSION}`);
});

test('the data floor is a release of the schema this server reads', () => {
  assert.equal(parts(MIN_DATA_VERSION)[0], MCP_SCHEMA_VERSION);
});

/**
 * The package exports only its index and entry point, not its package.json, so the
 * manifest is read from beside the index it ships.
 */
test('the installed data package is at least the data floor', () => {
  const installed = (JSON.parse(
    readFileSync(join(dirname(DB_PATH), 'package.json'), 'utf8'),
  ) as Pkg).version;
  const [have, need] = [parts(installed), parts(MIN_DATA_VERSION)];
  const order = have[0] - need[0] || have[1] - need[1] || have[2] - need[2];
  assert.ok(order >= 0, `the installed data package is ${installed}, below ${MIN_DATA_VERSION}`);
});

test('the installed data package carries the schema version this server reads', () => {
  assert.equal(SCHEMA_VERSION, MCP_SCHEMA_VERSION,
    `the installed data package is schema ${SCHEMA_VERSION}, but this server reads ${MCP_SCHEMA_VERSION}`);
});
