import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './harness.ts';

type FindOut = {
  results: Array<{
    title: string; hitpoints: number | null; experience: number | null;
    bestiaryClass: string | null; modifiers: Record<string, number | null>;
  }>;
  totalMatches: number;
  nextCursor?: string;
};

test('finds creatures weak to an element above an experience floor', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { weak_to: ['fire'], experience_min: 100 },
  });
  const data = res.structuredContent as FindOut;
  // Assert non-emptiness FIRST: a universal assertion over an empty array passes
  // vacuously, which is exactly how this test was broken before the fixture was fixed.
  assert.ok(data.results.length >= 2, `expected >=2 matches, got ${data.results.length}`);
  for (const r of data.results) {
    assert.ok(r.modifiers.fire! > 100, `${r.title} fire=${r.modifiers.fire} should exceed 100`);
    assert.ok(r.experience! >= 100, `${r.title} exp=${r.experience}`);
  }
  await h.close();
});

test('Dragon is excluded from a fire-weakness search because it is fire-immune', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { weak_to: ['fire'], limit: 100 },
  });
  const titles = (res.structuredContent as FindOut).results.map((r) => r.title);
  assert.ok(titles.length > 0, 'guard: the set must be non-empty for this to mean anything');
  assert.ok(!titles.includes('Dragon'), 'Dragon has modifier_fire = 0 and must not match');
  await h.close();
});

test('resistant_to is the inverse of weak_to', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { resistant_to: ['fire'], limit: 100 },
  });
  const data = res.structuredContent as FindOut;
  assert.ok(data.results.length > 0);
  for (const r of data.results) assert.ok(r.modifiers.fire! < 100, `${r.title}`);
  await h.close();
});

test('paginates with an opaque cursor and stops at the last page', async () => {
  const h = await connect();
  const first = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { weak_to: ['fire'], limit: 1 },
  });
  const d1 = first.structuredContent as FindOut;
  assert.equal(d1.results.length, 1);
  assert.ok(d1.nextCursor, 'expected a nextCursor with >1 total match');
  const second = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { weak_to: ['fire'], limit: 1, cursor: d1.nextCursor },
  });
  const d2 = second.structuredContent as FindOut;
  assert.notEqual(d1.results[0]!.title, d2.results[0]!.title);
  const last = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { weak_to: ['fire'], limit: 100 },
  });
  assert.equal((last.structuredContent as FindOut).nextCursor, undefined, 'final page has no cursor');
  await h.close();
});

test('non-active creatures are excluded by default', async () => {
  const h = await connect();
  const off = await h.client.callTool({ name: 'tibia_find_creatures', arguments: { limit: 100 } });
  const on = await h.client.callTool({
    name: 'tibia_find_creatures', arguments: { limit: 100, include_inactive: true },
  });
  assert.ok(
    (on.structuredContent as FindOut).totalMatches > (off.structuredContent as FindOut).totalMatches,
  );
  await h.close();
});

test('filters combine, and totalMatches reflects the filter not the page', async () => {
  const h = await connect();
  const res = await h.client.callTool({
    name: 'tibia_find_creatures',
    arguments: { hitpoints_min: 100, hitpoints_max: 100000, sort: 'hitpoints', limit: 2 },
  });
  const data = res.structuredContent as FindOut;
  assert.equal(data.results.length, 2);
  assert.ok(data.totalMatches > 2, 'totalMatches must count all matches, not the page');
  assert.ok(data.results[0]!.hitpoints! >= data.results[1]!.hitpoints!, 'sorted descending');
  await h.close();
});
