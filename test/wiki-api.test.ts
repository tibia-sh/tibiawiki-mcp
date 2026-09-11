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
