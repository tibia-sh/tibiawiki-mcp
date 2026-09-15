#!/usr/bin/env node
/**
 * Consumer smoke check: install the package the way a user would, and drive it.
 *
 *   pnpm smoke ./tibia.sh-tibiawiki-mcp-0.2.0.tgz   a local `npm pack` tarball, pre-publish
 *   pnpm smoke @tibia.sh/tibiawiki-mcp@0.2.0        the published artifact, post-publish
 *
 * Installs the package under test into a throwaway directory, spawns the INSTALLED
 * binary over real stdio twice, and drives it with a real MCP client:
 *
 *   - with no index it can read, a tool call errors and names build-index;
 *   - with only its packaged index to read, a real query answers from that index.
 *
 * Then it starts the INSTALLED binary as an HTTP server, `serve --http` on 127.0.0.1 and
 * an ephemeral port, set up like the packaged-index run. It takes the URL from the
 * server's startup line and connects client 2.0.0 twice, once with default options and
 * once with versionNegotiation in auto mode. Each client's tibia_search must answer from
 * the packaged index, checked as in the packaged-index run, and no response may carry an
 * mcp-session-id header. SIGTERM must then end the server with exit code 0 within 15 s.
 *
 * Why each choice, since every one of them is a trap this check hit during review:
 *
 *   - It spawns `node_modules/.bin/tibiawiki-mcp`, not `dist/index.js`. The installed
 *     layout is the thing being tested; a path into the source tree proves nothing
 *     about the tarball.
 *   - No run lets the machine's own index decide the outcome. With TIBIAWIKI_MCP_DB
 *     unset, resolveDbPath prefers a built index at
 *     ${XDG_CACHE_HOME:-$HOME/.cache}/tibiawiki-mcp/tibiawiki.db over the packaged one,
 *     so any machine that has ever built an index would answer from it - or fail on it,
 *     when it is stale - while proving nothing about the package. A clean npm cache is
 *     not a clean XDG cache. So the missing-index run sets TIBIAWIKI_MCP_DB to a path
 *     that does NOT exist, and the packaged-index run unsets it and points XDG_CACHE_HOME
 *     at an empty directory.
 *   - The packaged-index run checks the answer's indexGeneratedAt against the
 *     generate_time of the index in the installed @tibia.sh/tibiawiki-data, read through
 *     that package's DB_PATH. An answer whose indexGeneratedAt differs from that
 *     generate_time fails.
 *   - It CALLS a tool, not just tools/list. The unavailable-index server still
 *     advertises the full tool surface, so listing alone cannot establish the error
 *     behaviour. test/unavailable.test.ts calls tools for exactly this reason.
 *   - It installs @modelcontextprotocol/client explicitly: it is a devDependency of the
 *     server, so it is NOT available transitively from the installed package.
 *   - It strips the lowercase npm_* keys from the child environment. A package manager
 *     or npx running a script can export its own config that way, and npm rejects some
 *     of it outright (EALLOWSCRIPTS) while silently applying the rest to an install meant
 *     to look like a stranger's.
 *     Case is load-bearing: npm reads NPM_CONFIG_* too, and those are the operator's own
 *     registry, proxy and CA settings, which a real consumer would have as well.
 *   - Every scratch path any run needs lives inside the one scratch directory, which
 *     is removed on pass, on fail, and after a Ctrl-C. A Ctrl-C signals the whole process
 *     group, which kills the running step, so the check fails and cleans up like any
 *     other failure. A signal sent to this process alone interrupts nothing: every step
 *     blocks in execFileSync, so the handlers below never run, and the check carries on
 *     to its normal end.
 *   - The HTTP probe stops its server on every path, whether the run passes, a check
 *     fails, the startup line never comes or the probe throws. It sends SIGTERM, then
 *     SIGKILL if the server is still running 15 s later. The stdio runs need no such
 *     step. A stdio server exits once its stdin closes, and its stdin closes when the
 *     probe ends for any reason. An HTTP server keeps listening when its client closes,
 *     and when its probe dies. The step timeout sends SIGTERM to the probe alone, so the
 *     probe handles that signal by stopping the server before it exits. When you press
 *     Ctrl-C, the server gets SIGINT from the process group as well, because the probe
 *     does not spawn it detached, and it shuts down as it does on SIGTERM.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOL_NAMES = [
  'tibia_find_creatures', 'tibia_find_items', 'tibia_get',
  'tibia_how_to_obtain', 'tibia_search',
];
const TIMEOUT_MS = 120_000;

const spec = process.argv[2];
if (!spec) {
  process.stderr.write('usage: node scripts/smoke.mjs <tarball-path|package@version>\n');
  process.exit(2);
}
// A local tarball must be resolved before we chdir into the scratch directory.
const target = spec.endsWith('.tgz') ? resolve(spec) : spec;

const dir = mkdtempSync(join(tmpdir(), 'twmcp-smoke-'));
let failed = false;

const clean = () => rmSync(dir, { recursive: true, force: true });
// Without these, SIGINT or SIGTERM would end this process on the spot and leave the
// scratch install behind. With them the signal waits for the step running in
// execFileSync, so neither body ever runs. A Ctrl-C has killed that step as well, so it
// fails, and the finally block below removes the directory.
for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143 })) {
  process.on(signal, () => {
    clean();
    process.exit(code);
  });
}

// A consumer's shell carries none of this repo's package-manager config.
const CONSUMER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')),
);

/** @type {(cmd: string, args: string[]) => string} */
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: dir, env: CONSUMER_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * npm's stderr is the only useful diagnostic for a failed install; `message` alone says
 * just "exited 1". The probe's reasons stream straight through, so its message is enough.
 */
/** @type {(error: unknown) => string} */
const detail = (error) => {
  if (!(error instanceof Error)) return String(error);
  const { stderr } = /** @type {Error & { stderr?: string | null }} */ (error);
  return stderr || error.message;
};

try {
  process.stderr.write(`scratch: ${dir}\ninstalling ${target}\n`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true }, null, 2));
  run('npm', ['install', '--no-audit', '--no-fund', target, '@modelcontextprotocol/client@2.0.0']);

  // Driven from files inside the scratch dir so their imports resolve against the
  // installed node_modules rather than this script's location. Both probes import what
  // they share from shared.mjs.
  writeFileSync(join(dir, 'shared.mjs'), `
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// The scratch directory. Every path below stays inside it, so its removal covers them.
export const cwd = process.cwd();

/** The installed binary, which every run spawns. */
export const bin = join(cwd, 'node_modules', '.bin', 'tibiawiki-mcp');

export const textOf = (res) => (res.content ?? []).map((part) => part.text ?? '').join(' ');

/** No override and an empty cache of its own, so the packaged index is all there is. */
export function packagedEnv() {
  const env = { ...process.env, XDG_CACHE_HOME: mkdtempSync(join(cwd, 'empty-cache-')) };
  delete env.TIBIAWIKI_MCP_DB;
  return env;
}

/**
 * The index in the data package the installed server depends on, resolved from the
 * server's own directory, as the server's locator resolves it. Returns its DB_PATH and
 * its generate_time.
 */
export async function packagedIndex() {
  const fromServer = createRequire(join(cwd, 'node_modules', '@tibia.sh', 'tibiawiki-mcp', 'package.json'));
  const { DB_PATH } = await import(pathToFileURL(fromServer.resolve('@tibia.sh/tibiawiki-data')).href);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare("select value from database_info where key = 'generate_time'").get();
  db.close();
  return { DB_PATH, generateTime: row.value };
}
`);

  writeFileSync(join(dir, 'probe-stdio.mjs'), `
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { bin, cwd, packagedEnv, packagedIndex, textOf } from './shared.mjs';

/** Spawns the installed binary with env, runs body against it, and always disconnects. */
async function withServer(env, body) {
  const transport = new StdioClientTransport({
    command: bin,
    args: ['serve'],
    env,
    cwd,
  });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

// Missing index: a path that is never created.
await withServer({ ...process.env, TIBIAWIKI_MCP_DB: join(cwd, 'no-index', 'nope.db') }, async (client) => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ${JSON.stringify([...TOOL_NAMES].sort())}, 'tool surface');
  console.log('  initialize + tools/list: ' + names.length + ' tools');

  // The assertion that listing cannot make.
  const res = await client.callTool({ name: 'tibia_get', arguments: {} });
  assert.equal(res.isError, true, 'a tool call against a missing index must error');
  assert.match(textOf(res), /build-index/, 'the error must name the fix');
  console.log('  missing index: the tool call errors and names build-index');
});

// Packaged index: no override and an empty cache, so the packaged index is all there is.
await withServer(packagedEnv(), async (client) => {
  const res = await client.callTool({
    name: 'tibia_get', arguments: { name: 'Dragon', type: 'creature' },
  });
  assert.notEqual(res.isError, true, 'the packaged index must answer a real query: ' + textOf(res));
  const dragon = res.structuredContent;
  assert.equal(dragon.title, 'Dragon', 'the query must return real data');

  const { DB_PATH, generateTime } = await packagedIndex();
  assert.equal(dragon.source.indexGeneratedAt, generateTime,
    'the answer came from an index other than ' + DB_PATH);
  console.log('  packaged index: tibia_get answers from ' + DB_PATH);
});
`);

  writeFileSync(join(dir, 'probe-http.mjs'), `
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { bin, cwd, packagedEnv, packagedIndex, textOf } from './shared.mjs';

/** How long the server may take to write its startup line: half of the step's budget. */
const STARTUP_MS = ${TIMEOUT_MS / 2};
/** How long the server may take to exit after SIGTERM, before it gets SIGKILL. */
const STOP_MS = 15_000;

const { DB_PATH, generateTime } = await packagedIndex();

// Registered before the spawn, in the same tick, so no SIGTERM can end this probe while
// the server is running. The step timeout sends SIGTERM to this probe alone, and the
// server would outlive it.
process.on('SIGTERM', async () => {
  await stop();
  process.stderr.write('HTTP run: the probe got SIGTERM, so it stopped the server before exiting\\n', () => {
    process.exit(143);
  });
});

// Not detached, so a Ctrl-C reaches the server through the process group.
const server = spawn(bin, ['serve', '--http', '--host', '127.0.0.1', '--port', '0'], {
  cwd, env: packagedEnv(), stdio: ['ignore', 'ignore', 'pipe'],
});
// Collected for as long as the server runs, so a failure can show it and the pipe never fills.
let stderr = '';
server.stderr.setEncoding('utf8');
server.stderr.on('data', (chunk) => {
  stderr += chunk;
});
// A spawn that fails emits error and then close, and close ends the wait for the startup line.
server.on('error', (error) => {
  stderr += error.message + '\\n';
});
/** How the server ended, once its stderr has closed too. */
const exited = new Promise((resolve) => {
  server.once('close', (code, signal) => resolve({ code, signal }));
});

let stopping;
/**
 * Stops the server the same way on every path: SIGTERM, then SIGKILL if it is still running
 * STOP_MS later. Resolves with how it ended, whether it was still running when the stop
 * began, and whether it took SIGKILL.
 */
const stop = () => (stopping ??= (async () => {
  const running = server.exitCode === null && server.signalCode === null;
  if (running) server.kill('SIGTERM');
  const exit = await Promise.race([exited, delay(STOP_MS, undefined, { ref: false })]);
  if (exit) return { ...exit, running, killed: false };
  server.kill('SIGKILL');
  return { ...(await exited), running, killed: true };
})());

/** Passes promise through, and names the check in its error when it rejects. */
const named = (check, promise) => promise.catch((error) => {
  throw new Error(check + ' failed: ' + error.message, { cause: error });
});

try {
  // The URL is the text between "listening on " and ", index generated".
  const listening = await Promise.race([
    new Promise((resolve) => {
      server.stderr.on('data', () => {
        const match = /^tibiawiki-mcp listening on (.+?), index generated /m.exec(stderr);
        if (match) resolve(match[1]);
      });
    }),
    exited.then(({ code, signal }) => {
      throw new Error('HTTP run: the server exited with ' + (signal ?? 'code ' + code) +
        ' before its startup line. Server stderr:\\n' + stderr);
    }),
    delay(STARTUP_MS, undefined, { ref: false }).then(() => {
      throw new Error('HTTP run: no startup line within ' + STARTUP_MS / 1000 + ' s. Server stderr:\\n' + stderr);
    }),
  ]);
  const url = URL.parse(listening);
  assert.ok(url, 'HTTP run: the startup line must name a URL, got ' + listening);
  console.log('  HTTP run: listening on ' + url);

  for (const [label, options] of [
    ['default options', {}],
    ['versionNegotiation auto', { versionNegotiation: { mode: 'auto' } }],
  ]) {
    const prefix = 'HTTP run, ' + label + ': ';
    // The mcp-session-id header of every response the client receives.
    const sessionIds = [];
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        sessionIds.push(response.headers.get('mcp-session-id'));
        return response;
      },
    });
    const client = new Client({ name: 'smoke', version: '1.0.0' }, options);
    let res;
    let version;
    try {
      await named(prefix + 'connect', client.connect(transport));
      // Read before close(), which forgets it.
      version = client.getNegotiatedProtocolVersion();
      res = await named(prefix + 'tibia_search', client.callTool({
        name: 'tibia_search', arguments: { query: 'Dragon', limit: 1 },
      }));
    } finally {
      await client.close();
    }
    assert.notEqual(res.isError, true, prefix + 'tibia_search must answer: ' + textOf(res));
    assert.equal(res.structuredContent?.indexGeneratedAt, generateTime,
      prefix + 'the answer came from an index other than ' + DB_PATH);
    assert.ok(sessionIds.length > 0, prefix + 'no HTTP response was observed, so the header check proves nothing');
    assert.deepEqual(sessionIds.filter((id) => id !== null), [], prefix + 'a response carried mcp-session-id');
    console.log('  ' + prefix + 'tibia_search answers from ' + DB_PATH + ' on ' + version + ', no mcp-session-id');
  }

  // A server that ended before this point never got SIGTERM, so running must be true.
  const exit = await stop();
  assert.deepEqual(exit, { code: 0, signal: null, running: true, killed: false },
    'HTTP run: SIGTERM must end the running server with exit code 0 within ' + STOP_MS / 1000 + ' s. Server stderr:\\n' + stderr);
  console.log('  HTTP run: SIGTERM ends the server with exit code 0');
} finally {
  await stop();
}
`);

  // Streamed rather than captured, so the first run's lines stay visible when the second fails.
  // Each probe is a step of its own with the whole budget, so the HTTP run takes no time
  // from the stdio runs.
  for (const probe of ['probe-stdio.mjs', 'probe-http.mjs']) {
    execFileSync(process.execPath, [probe], {
      cwd: dir, env: CONSUMER_ENV, timeout: TIMEOUT_MS, stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  process.stdout.write(`\nPASS  ${target}\n`);
} catch (error) {
  failed = true;
  process.stderr.write(`\nFAIL  ${target}\n${detail(error)}\n`);
} finally {
  // Cleanup on pass or fail. A Ctrl-C kills the running step, so it ends up here too.
  clean();
}
process.exit(failed ? 1 : 0);
