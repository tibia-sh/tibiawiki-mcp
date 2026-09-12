import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWikiApi, type Fetcher } from '../src/indexer/wiki-api.ts';

type Call = { url: string; headers: Record<string, string> };

/** Records every request so tests can assert the injected fetcher is the only path. */
function recorder(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let i = 0;
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return next();
  };
  return { calls, fetcher, get count() { return i; } };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status, headers });

const pages = (titles: string[]) => ({
  query: {
    pages: Object.fromEntries(
      titles.map((t, n) => [String(n), { title: t, revisions: [{ slots: { main: { '*': `wt:${t}` } } }] }]),
    ),
  },
});

const sleeps: number[] = [];
const clock = { sleep: async (ms: number) => { sleeps.push(ms); } };

test('batches titles at the anonymous limit of 50 per request', async () => {
  const titles = Array.from({ length: 120 }, (_, n) => `P${n}`);
  const r = recorder([json(pages(['x']))]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  await api.pageWikitext(titles);

  assert.equal(r.count, 3, '120 titles must split into 3 requests, not 2 or 4');
  // Assert the split boundary, not just the count: an off-by-one batcher still
  // makes 3 requests while dropping or duplicating a title.
  const last = decodeURIComponent(r.calls[2]!.url);
  assert.ok(last.includes('P100'), 'third batch starts at P100');
  assert.ok(last.includes('P119'), 'third batch ends at P119');
  assert.ok(!last.includes('P99'), 'third batch must not re-send P99');
});

test('every requested title is asked for exactly once', async () => {
  const titles = Array.from({ length: 120 }, (_, n) => `P${n}`);
  const r = recorder([json(pages(['x']))]);
  await createWikiApi({ fetcher: r.fetcher, clock }).pageWikitext(titles);

  // Partitioning into 3 requests is not the same as preserving all 120 titles: an
  // off-by-one batcher drops or duplicates one and still makes 3 requests.
  const asked = r.calls.flatMap((c) => {
    const raw = new URL(c.url).searchParams.get('titles') ?? '';
    return raw.split('|').filter(Boolean);
  });
  assert.equal(asked.length, 120);
  assert.deepEqual([...new Set(asked)].sort(), [...titles].sort());
});

test('follows continue until it is absent', async () => {
  const r = recorder([
    json({ ...pages(['A']), continue: { rvcontinue: 'tok' } }),
    json(pages(['B'])),
  ]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  const out = await api.pageWikitext(['A', 'B']);

  assert.equal(r.count, 2);
  assert.ok(decodeURIComponent(r.calls[1]!.url).includes('tok'));
  assert.deepEqual(out.map((p) => p.title).sort(), ['A', 'B']);
});

test('Retry-After: 2 waits two thousand milliseconds, then retries', async () => {
  sleeps.length = 0;
  const r = recorder([
    json({}, 429, { 'Retry-After': '2' }),
    json(pages(['A'])),
  ]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  await api.pageWikitext(['A']);

  assert.equal(r.count, 2);
  assert.deepEqual(sleeps, [2000], 'Retry-After is seconds; sleep takes milliseconds');
});

test('an API-level error arrives as HTTP 200 and is never retried', async () => {
  const r = recorder([json({ error: { code: 'badvalue', info: 'Bad title' } })]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });

  await assert.rejects(
    () => api.pageWikitext(['A']),
    (e: Error) => e.message.includes('badvalue') && e.message.includes('Bad title'),
  );
  assert.equal(r.count, 1, 'an API error is permanent; retrying it wastes the budget');
});

test('500 is permanent while 503 is retried', async () => {
  const hard = recorder([json({}, 500)]);
  await assert.rejects(() => createWikiApi({ fetcher: hard.fetcher, clock }).pageWikitext(['A']));
  assert.equal(hard.count, 1, '500 must not be retried');

  const soft = recorder([json({}, 503), json(pages(['A']))]);
  await createWikiApi({ fetcher: soft.fetcher, clock }).pageWikitext(['A']);
  assert.equal(soft.count, 2, '503 must be retried');
});

test('a persistent transport failure names the URL', async () => {
  const r = recorder([() => { throw new Error('ECONNRESET'); }]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  // A rejected fetch has no status, so the message carries the URL and cause.
  await assert.rejects(
    () => api.pageWikitext(['A']),
    (e: Error) => e.message.includes('api.php') && e.message.includes('ECONNRESET'),
  );
  assert.ok(r.count > 1, 'transport failures are retried before giving up');
});

test('every request identifies the client and a contact', async () => {
  const r = recorder([json({ ...pages(['A']), continue: { rvcontinue: 't' } }), json(pages(['B']))]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  await api.pageWikitext(['A']);

  assert.equal(r.count, 2);
  for (const call of r.calls) {
    const ua = call.headers['User-Agent'] ?? '';
    assert.match(ua, /tibiawiki-mcp/, 'names the product');
    assert.match(ua, /https?:\/\/|@/, 'carries a contact');
  }
});

/**
 * The test above is deliberately loose, and stays that way: its subject is a property
 * that must hold for whatever UA a caller injects through `opts.userAgent`, so pinning
 * this project's own identity inside it would break that seam. The cost is that the
 * *default* UA's contact URL was covered by nothing, and it duly rotted through an
 * owner change. A 404 there is worse than no URL at all, because the only reason to
 * put one in a bot's UA is to give a wiki admin somewhere to complain.
 */
test('the default User-Agent names a repository that exists', async () => {
  const r = recorder([json(pages(['A']))]);
  await createWikiApi({ fetcher: r.fetcher, clock }).pageWikitext(['A']);
  const ua = r.calls[0]!.headers['User-Agent'] ?? '';
  assert.ok(
    ua.includes('https://github.com/tibia-sh/tibiawiki-mcp'),
    `the default UA does not name the current repository: ${ua}`,
  );
});

const imagePages = (found: string[], missing: string[] = []) => ({
  query: {
    pages: Object.fromEntries([
      ...found.map((t, n) => [String(n), {
        title: t, pageid: 100 + n,
        imageinfo: [{
          url: `https://static.wikia.nocookie.net/tibia/images/a/ab/${t.slice(5)}/revision/latest?cb=1`,
          descriptionurl: `https://tibia.fandom.com/wiki/${t}`,
          width: 64, height: 64, mime: 'image/gif',
        }],
      }]),
      // MediaWiki marks a nonexistent file explicitly, with a negative pageid.
      ...missing.map((t, n) => [String(-1 - n), { title: t, missing: '', ns: 6 }]),
    ]),
  },
});

test('imageInfo batches at fifty and asks for every file exactly once', async () => {
  const files = Array.from({ length: 120 }, (_, n) => `File:P${n}.gif`);
  const calls: Call[] = [];
  const echo: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const asked = (new URL(url).searchParams.get('titles') ?? '').split('|').filter(Boolean);
    return new Response(JSON.stringify(imagePages(asked)), { status: 200 });
  };
  const r = { calls, fetcher: echo, get count() { return calls.length; } };
  await createWikiApi({ fetcher: r.fetcher, clock }).imageInfo(files);

  assert.equal(r.count, 3);
  const asked = r.calls.flatMap((c) => (new URL(c.url).searchParams.get('titles') ?? '').split('|').filter(Boolean));
  assert.equal(asked.length, 120);
  assert.deepEqual([...new Set(asked)].sort(), [...files].sort());
});

test('imageInfo undoes normalisation so the caller can map back to its subject', async () => {
  // Verified live: the API rewrites File:Steel_Helmet.gif -> File:Steel Helmet.gif.
  const r = recorder([() => new Response(JSON.stringify({
    query: {
      normalized: [{ from: 'File:Steel_Helmet.gif', to: 'File:Steel Helmet.gif' }],
      ...imagePages(['File:Steel Helmet.gif']).query,
    },
  }), { status: 200 })]);
  const out = await createWikiApi({ fetcher: r.fetcher, clock }).imageInfo(['File:Steel_Helmet.gif']);

  assert.equal(out.length, 1);
  assert.equal(out[0]!.requestedTitle, 'File:Steel_Helmet.gif', 'must echo what the caller asked for');
  assert.equal(out[0]!.title, 'File:Steel Helmet.gif');
});

test('imageInfo maps a reordered response to the right request', async () => {
  const r = recorder([json(imagePages(['File:B.gif', 'File:A.gif']))]);
  const out = await createWikiApi({ fetcher: r.fetcher, clock }).imageInfo(['File:A.gif', 'File:B.gif']);
  const byReq = new Map(out.map((o) => [o.requestedTitle, o]));
  for (const name of ['A', 'B']) {
    const hit = byReq.get(`File:${name}.gif`);
    assert.ok(hit, `File:${name}.gif should have an outcome`);
    assert.ok(hit.found, `File:${name}.gif should have resolved`);
    assert.ok(hit.url.includes(`${name}.gif`), 'each request must get its OWN url back');
  }
});

test('imageInfo answers both requests when two titles collapse onto one page', async () => {
  // Defensive: 0 cross-table title collisions today. The API normalises
  // File:Steel_Helmet.gif onto File:Steel Helmet.gif, so a reverse to->from map
  // loses one request and reports it as a truncated response.
  const r = recorder([() => new Response(JSON.stringify({
    query: {
      normalized: [{ from: 'File:Steel_Helmet.gif', to: 'File:Steel Helmet.gif' }],
      ...imagePages(['File:Steel Helmet.gif']).query,
    },
  }), { status: 200 })]);
  const out = await createWikiApi({ fetcher: r.fetcher, clock })
    .imageInfo(['File:Steel_Helmet.gif', 'File:Steel Helmet.gif']);

  assert.equal(out.length, 2, 'both requested strings must get an outcome');
  assert.deepEqual(
    out.map((o) => o.requestedTitle).sort(),
    ['File:Steel Helmet.gif', 'File:Steel_Helmet.gif'],
  );
  assert.ok(out.every((o) => o.found), 'both resolve to the same page');
});

test('imageInfo reports an API-confirmed missing file as found: false', async () => {
  const r = recorder([json(imagePages(['File:A.gif'], ['File:Gone.gif']))]);
  const out = await createWikiApi({ fetcher: r.fetcher, clock }).imageInfo(['File:A.gif', 'File:Gone.gif']);
  const gone = out.find((o) => o.requestedTitle === 'File:Gone.gif');
  assert.ok(gone);
  assert.equal(gone.found, false, 'a wiki gap, distinguishable from a broken response');
  assert.ok(!('url' in gone));
});

test('imageInfo throws when a requested file is absent from the response entirely', async () => {
  // A truncated batch. Folding this into `missing` would let one lost page out of
  // fifty read as 98% coverage and sail through the per-type floor.
  const r = recorder([json(imagePages(['File:A.gif']))]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  await assert.rejects(
    () => api.imageInfo(['File:A.gif', 'File:Vanished.gif']),
    (e: Error) => e.message.includes('File:Vanished.gif'),
  );
});

test('imageInfo carries the description url the API returns for free', async () => {
  const r = recorder([json(imagePages(['File:Dragon.gif']))]);
  const [only] = await createWikiApi({ fetcher: r.fetcher, clock }).imageInfo(['File:Dragon.gif']);
  assert.ok(only?.found);
  assert.equal(only.descriptionUrl, 'https://tibia.fandom.com/wiki/File:Dragon.gif');
});

test('moduleSource returns raw wikitext for a module page', async () => {
  const r = recorder([json(pages(['Module:SceneBuilder/data']))]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  assert.equal(await api.moduleSource('Module:SceneBuilder/data'), 'wt:Module:SceneBuilder/data');
});

test('categoryMembers pages through the whole category', async () => {
  const members = (names: string[]) => ({ query: { categorymembers: names.map((title) => ({ title })) } });
  const r = recorder([
    json({ ...members(['A', 'B']), continue: { cmcontinue: 'c1' } }),
    json(members(['C'])),
  ]);
  const api = createWikiApi({ fetcher: r.fetcher, clock });
  assert.deepEqual(await api.categoryMembers('Category:Creatures'), ['A', 'B', 'C']);
});
