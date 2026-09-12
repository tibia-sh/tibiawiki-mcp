import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Pkg = {
  name: string;
  version: string;
  mcpName: string;
  repository: { type: string; url: string };
  publishConfig: { access: string };
  scripts: Record<string, string>;
};
type Server = {
  name: string;
  version: string;
  repository: { url: string; source: string };
  packages: Array<{ identifier: string; version: string }>;
};
type Plugin = { repository: string; version: string };

const read = <T>(rel: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as T;

const pkg = read<Pkg>('../package.json');
const server = read<Server>('../server.json');
const plugin = read<Plugin>('../.claude-plugin/plugin.json');

/**
 * Every assertion here pins a setting whose failure mode is silent until publish
 * time, when the mistake is no longer correctable: a published npm name can be
 * deprecated but never renamed, and a version number can never be reused.
 */

test('the package publishes under the tibia.sh scope, publicly', () => {
  assert.equal(pkg.name, '@tibia.sh/tibiawiki-mcp');
  // A scoped package defaults to *restricted*, so a first publish without this
  // fails outright on a free account rather than publishing something private.
  assert.equal(pkg.publishConfig.access, 'public');
});

/**
 * Exact equality, not `includes`: npm matches `repository.url` against the source
 * repo case-sensitively when it generates provenance, and an `ssh://` form would
 * satisfy a substring check while failing at publish time.
 */
test('repository.url is the exact form provenance requires', () => {
  assert.equal(pkg.repository.url, 'git+https://github.com/tibia-sh/tibiawiki-mcp.git');
});

/**
 * `prepublishOnly` does not fire for a tarball publish - npm gates the hook on a
 * *directory* spec - so this is not the bootstrap publish's guard. It guards every
 * later directory publish, which is what the release workflow will run; that
 * workflow therefore has to put pnpm on PATH before publishing.
 */
test('a directory publish runs the suite first', () => {
  assert.equal(pkg.scripts['prepublishOnly'], 'pnpm test');
});

/**
 * The MCP registry validates namespace ownership by reading `mcpName` from the
 * *live published* npm version, so a 0.1.0 carrying the wrong namespace can never
 * be registered under the intended name. The literal is asserted as well as the
 * cross-file equality: two files both left at `io.github.jakubmucha/...` would
 * satisfy equality and still be wrong.
 */
test('the MCP namespace is the DNS one, in both files', () => {
  assert.equal(pkg.mcpName, 'sh.tibia/tibiawiki-mcp');
  assert.equal(server.name, pkg.mcpName);
});

test('server.json points at the package that is actually published', () => {
  // The defect this move fixes. A namespace-only assertion would leave the
  // unscoped `tibiawiki-mcp` identifier in place and still pass.
  assert.equal(server.packages[0]!.identifier, pkg.name);
  assert.equal(server.repository.url, 'https://github.com/tibia-sh/tibiawiki-mcp');
  // server.json carries the version twice, and the MCP registry reads packages[0].
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0]!.version, pkg.version);
});

test('the plugin manifest points at the new org', () => {
  assert.equal(plugin.repository, 'https://github.com/tibia-sh/tibiawiki-mcp');
});

test('the plugin manifest carries the package version', () => {
  assert.equal(plugin.version, pkg.version);
});
