import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from '@tibia.sh/tibiawiki-data';
import { MCP_SCHEMA_VERSION } from '../src/db.ts';

/**
 * The data package's major version is the schema version of the index it ships. That
 * makes the dependency range the thing that stops npm pairing this server with an
 * index it cannot read, so both halves of the pairing are pinned here.
 */

type Pkg = { dependencies: Record<string, string> };
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Pkg;

/**
 * Computed from the constant, never written as the literal. A schema bump that left
 * this range behind would let npm install an older index into a server that rejects it,
 * and every user would meet a SchemaError at startup instead of whoever bumped the
 * schema meeting this failure.
 */
test('the data dependency range is the schema version this server reads', () => {
  assert.equal(pkg.dependencies['@tibia.sh/tibiawiki-data'], `^${MCP_SCHEMA_VERSION}`);
});

test('the installed data package carries the schema version this server reads', () => {
  assert.equal(SCHEMA_VERSION, MCP_SCHEMA_VERSION,
    `the installed data package is schema ${SCHEMA_VERSION}, but this server reads ${MCP_SCHEMA_VERSION}`);
});
