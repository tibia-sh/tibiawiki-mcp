import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The runtime never contacts the network. Every answer comes from the index on disk, and only
 * src/indexer/, which builds that index, fetches anything. Only src/http.ts may import node:http, and
 * only to create the listener that serves inbound requests. Each .ts file under src/ outside
 * src/indexer/ is read as text, comments and strings included, so a comment that trips a rule is
 * reworded, never exempted.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/** The one file that may import node:http. */
const LISTENER = 'src/http.ts';

/** The outbound network APIs no runtime file may name, and a call to fetch on any object. */
const NETWORK_APIS = [
  /(?<![\w$.])fetch\b/g,
  /globalThis\.fetch/g,
  /\bfetch\s*\(/g,
  /\bWebSocket\b/g,
  /\bEventSource\b/g,
  /\bXMLHttpRequest\b/g,
  /\bhttp\.request\b/g,
  /\bhttp\.get\b/g,
];

/**
 * The network modules whose names are not ordinary words, and getBuiltinModule, which loads any builtin
 * by name. Each fails as text anywhere, so a string handed to createRequire or getBuiltinModule fails as
 * much as an import does.
 */
const NETWORK_TEXT = /node:https|node:http2|node:net|node:tls|node:dgram|undici|axios|node-fetch|getBuiltinModule/g;

/**
 * A reference to one of `modules`, or to a path inside one, in quotes or backticks: an import or
 * re-export `from` it, a side-effect `import` of it, or a `require()` or dynamic `import()` of it. A
 * match ends at the closing quote, on the line that names the module.
 */
const referenceTo = (modules: string[]): RegExp =>
  new RegExp(`\\b(?:from|import|require\\s*\\(|import\\s*\\()\\s*(['"\`])(?:${modules.join('|')})(?:/[^'"\`]*)?\\1`, 'g');

/**
 * The builtins https, http2, net, tls and dgram by their bare names, and the ws package. These fail only
 * as an import, a require or a dynamic import(), not as text anywhere, because each is also an ordinary
 * word, such as https in a URL.
 */
const NETWORK_MODULE = referenceTo(['https', 'http2', 'net', 'tls', 'dgram', 'ws']);

/**
 * node:http as text anywhere, except where it begins node:https or node:http2, which NETWORK_TEXT covers.
 * Every node:http outside the imports src/http.ts may hold then fails one of the two tests.
 */
const HTTP_TEXT = /node:http(?![s2])/g;

/** node:http by its bare name, which fails only as a module reference, for the same reason as NETWORK_MODULE. */
const HTTP_MODULE = referenceTo(['http']);

/**
 * The two statements src/http.ts may import node:http with, their braces captured: a named import and
 * an `import type { ... }`. Each must start its line, so an import written in a comment inside another
 * statement cannot take over that statement's `from 'node:http'`.
 */
const NAMED_HTTP_IMPORT = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*(['"])node:http\2/gm;
const TYPE_HTTP_IMPORT = /^[ \t]*import\s+type\s*\{([^}]*)\}\s*from\s*(['"])node:http\2/gm;

/** One import specifier: a name, with or without a `type` mark and an alias. */
const SPECIFIER = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?$/;

/**
 * The specifiers between an import's braces, or undefined when one is anything but a name. Braces that
 * run over a comment into the next statement hold more than names, so such a match allows nothing.
 */
const specifiersIn = (braces: string): string[] | undefined => {
  const specifiers = braces.split(',').map((specifier) => specifier.trim()).filter((specifier) => specifier !== '');
  return specifiers.every((specifier) => SPECIFIER.test(specifier)) ? specifiers : undefined;
};

/**
 * `text` with each import of node:http that src/http.ts may hold turned into spaces. Line breaks stay,
 * so whatever is left keeps its line.
 */
const withoutListenerImports = (text: string): string => {
  const blank = (statement: string): string => statement.replace(/[^\n]/g, ' ');
  return text
    .replace(NAMED_HTTP_IMPORT, (statement: string, braces: string) => {
      // createServer as written is the one value binding. request, get and Agent are the outbound client,
      // and an alias could name one of them createServer.
      const values = specifiersIn(braces)?.filter((specifier) => !/^type\s/.test(specifier));
      return values?.length === 1 && values[0] === 'createServer' ? blank(statement) : statement;
    })
    .replace(TYPE_HTTP_IMPORT, (statement: string, braces: string) =>
      specifiersIn(braces) === undefined ? statement : blank(statement),
    );
};

/** Every .ts file under src/ outside src/indexer/, as its path from the repository root and its text. */
const sources = (): Array<{ path: string; text: string }> => {
  const paths = readdirSync(`${root}src`, { recursive: true, encoding: 'utf8' })
    .map((name) => `src/${name}`)
    .filter((path) => path.endsWith('.ts') && !path.startsWith('src/indexer/'))
    .sort();
  assert.ok(paths.length > 0, 'no .ts file found under src/ outside src/indexer/, so this check proves nothing');
  return paths.map((path) => ({ path, text: readFileSync(`${root}${path}`, 'utf8') }));
};

/**
 * Each line of a file that a match of `patterns` ends on, once and in order, as `path:line: text`. The
 * patterns run over `scanned`, `text` itself unless the caller blanked parts of it, and the line shown
 * is always the file's own.
 */
const hits = (path: string, text: string, patterns: RegExp[], scanned = text): string[] => {
  const ends = patterns.flatMap((pattern) => [...scanned.matchAll(pattern)].map((match) => match.index + match[0].length));
  const numbers = [...new Set(ends.map((end) => scanned.slice(0, end).split('\n').length))].sort((a, b) => a - b);
  const lines = text.split('\n');
  return numbers.map((number) => `${path}:${number}: ${lines[number - 1]!.trim()}`);
};

test('nothing outside src/indexer/ names an outbound network API or imports a network module', () => {
  const found = sources().flatMap(({ path, text }) => hits(path, text, [...NETWORK_APIS, NETWORK_TEXT, NETWORK_MODULE]));
  assert.deepEqual(found, [], `outbound network access outside src/indexer/:\n${found.join('\n')}`);
});

test('only src/http.ts imports node:http, and only its createServer and types', () => {
  // A default or namespace import, a require or a dynamic import() hands over request, get and Agent too,
  // and so does a node:http string handed to createRequire or getBuiltinModule.
  const found = sources().flatMap(({ path, text }) =>
    hits(path, text, [HTTP_TEXT, HTTP_MODULE], path === LISTENER ? withoutListenerImports(text) : text),
  );
  assert.deepEqual(found, [], `node:http outside the imports ${LISTENER} may hold:\n${found.join('\n')}`);
});
