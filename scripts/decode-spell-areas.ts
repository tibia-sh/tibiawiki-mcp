import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { classify, extractWebpFrames, readPng, type Frame } from './spell-decode.ts';
import { normaliseMask, type Mask } from '../src/area.ts';

/**
 * Maintainer-run, macOS only. Decodes the wiki's spell-area animations and writes
 * data/spell-areas.json, which the build then reads without any network or decoding.
 *
 *   pnpm decode-spell-areas <path-to-index.db>
 *
 * The index path is an argument because every spell key is validated against it and
 * data/tibiawiki.db is gitignored, so no default can be assumed.
 */

const UA = 'tibiawiki-mcp/1.0 (contact@qacenter.io)';
const API = 'https://tibia.fandom.com/api.php';
const REFERER = 'https://tibia.fandom.com/';
const TILE = 32;
const MIN_SERVED = 20;
const DECODER_VERSION = 1;
const OPTIONS = { tileSize: TILE, tolerance: 40, relativeThreshold: 0.25 };

type Sized = { width: number; height: number; url: string; revision: string };

async function api(params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json' })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const err = body['error'] as { code?: string; info?: string } | undefined;
  if (err) throw new Error(`MediaWiki ${err.code}: ${err.info}`);
  return body;
}

const batched = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Spell pages' own [[File:…]] references are the authoritative candidate inventory. */
async function inventory(titles: readonly string[]): Promise<Map<string, string[]>> {
  const refs = new Map<string, string[]>();
  for (const batch of batched(titles, 50)) {
    const body = await api({
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
      titles: batch.join('|'),
    });
    const pages = (body['query'] as { pages?: Record<string, Record<string, unknown>> }).pages ?? {};
    for (const page of Object.values(pages)) {
      const rev = page['revisions'] as Array<Record<string, unknown>> | undefined;
      const text = ((rev?.[0]?.['slots'] as Record<string, Record<string, unknown>>)?.['main']?.['*']) as string | undefined;
      if (!text) continue;
      const found = [...text.matchAll(/\[\[File:([^\]|]+?\.gif)/gi)].map((m) => m[1]!.trim());
      if (found.length) refs.set(String(page['title']), [...new Set(found)]);
    }
  }
  return refs;
}

async function sizes(files: readonly string[]): Promise<Map<string, Sized>> {
  const out = new Map<string, Sized>();
  for (const batch of batched(files, 50)) {
    const body = await api({
      action: 'query', prop: 'imageinfo', iiprop: 'url|size|mime',
      titles: batch.map((f) => `File:${f}`).join('|'),
    });
    const query = body['query'] as {
      pages?: Record<string, Record<string, unknown>>;
      normalized?: Array<{ from: string; to: string }>;
    };
    const back = new Map((query.normalized ?? []).map((n) => [n.to, n.from]));
    for (const page of Object.values(query.pages ?? {})) {
      const info = (page['imageinfo'] as Array<Record<string, unknown>> | undefined)?.[0];
      if (!info) continue;
      const title = String(page['title']);
      const name = (back.get(title) ?? title).replace(/^File:/, '');
      const url = String(info['url']);
      out.set(name, {
        width: Number(info['width']), height: Number(info['height']), url,
        revision: /[?&]cb=(\d+)/.exec(url)?.[1] ?? '',
      });
    }
  }
  return out;
}

/** Converts one still WebP to PNG via macOS sips, then reads its pixels. */
function toFrame(dir: string, n: number, payload: Uint8Array, x: number, y: number): Frame {
  const webp = join(dir, `f${n}.webp`);
  const png = join(dir, `f${n}.png`);
  writeFileSync(webp, payload);
  execFileSync('sips', ['-s', 'format', 'png', webp, '--out', png], { stdio: 'ignore' });
  const { width, height, pixels } = readPng(readFileSync(png));
  return { x, y, width, height, pixels };
}

async function decodeImage(name: string, sized: Sized): Promise<Mask> {
  const res = await fetch(sized.url, { headers: { 'User-Agent': UA, Referer: REFERER } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} (a Referer is required)`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const frames = extractWebpFrames(bytes);
  if (frames.length < 2) throw new Error(`${name}: ${frames.length} frame(s); need a plate and a delta`);
  const dir = mkdtempSync(join(tmpdir(), 'spellarea-'));
  try {
    const all = frames.map((f, i) => toFrame(dir, i, f.payload, f.x, f.y));
    return classify(all[0]!, all.slice(1), OPTIONS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const indexPath = process.argv[2];
if (!indexPath) throw new Error('usage: pnpm decode-spell-areas <path-to-index.db>');

const db = new DatabaseSync(indexPath, { readOnly: true });
const spellTitles = db.prepare('select title from spell').all().map((r) => String(r['title']));
const canonical = new Map(spellTitles.map((t) => [t.toLowerCase(), t]));

const refs = await inventory(spellTitles);
const sized = await sizes([...new Set([...refs.values()].flat())]);

// Area candidates: tile-aligned, larger than one tile, and not an outfit preview.
const isCandidate = (f: string): boolean => {
  const s = sized.get(f);
  return !!s && s.width % TILE === 0 && s.height % TILE === 0
    && (s.width > TILE || s.height > TILE) && !f.includes('(Outfit)');
};
const candidates = new Map(
  [...refs].map(([spell, files]) => [spell, files.filter(isCandidate)] as const).filter(([, f]) => f.length > 0),
);
const allFiles = [...new Set([...candidates.values()].flat())].sort();

// Completeness is a precondition. If a known candidate cannot be decoded we fail,
// rather than treating the surviving image of a pair as unanimous - losing a
// dissenting candidate would silently turn an excluded spell into a served one.
const masks = new Map<string, Mask>();
for (const file of allFiles) {
  masks.set(file, normaliseMask(await decodeImage(file, sized.get(file)!)));
  process.stderr.write(`  decoded ${file}\n`);
}

const spells: Record<string, unknown> = {};
const excluded: Record<string, unknown> = {};
const shapeUsers = new Map<string, string[]>();
for (const [file, m] of masks) {
  const key = JSON.stringify(m.cells) + `|${m.width}`;
  shapeUsers.set(key, [...(shapeUsers.get(key) ?? []), file]);
}

let corroborated = 0, familyCorroborated = 0, uncorroborated = 0;
for (const [spell, files] of [...candidates].sort()) {
  const title = canonical.get(spell.toLowerCase());
  if (!title) throw new Error(`Spell "${spell}" has no row in ${indexPath}; keys must be index titles.`);
  const shapes = new Set(files.map((f) => JSON.stringify(masks.get(f)!.cells) + `|${masks.get(f)!.width}`));
  const source = (f: string) => ({ image: f, url: sized.get(f)!.url, revision: sized.get(f)!.revision });

  if (shapes.size !== 1) {
    excluded[title] = {
      reason: 'images disagree',
      sources: files.map((f) => ({ ...source(f), shape: `${masks.get(f)!.width}x${masks.get(f)!.height}` })),
    };
    continue;
  }
  const mask = masks.get(files[0]!)!;
  const isCorroborated = files.length > 1;
  if (isCorroborated) corroborated += 1;
  else if ((shapeUsers.get([...shapes][0]!) ?? []).length > 1) familyCorroborated += 1;
  else uncorroborated += 1;

  spells[title] = {
    width: mask.width, height: mask.height, cells: mask.cells,
    affectedTiles: mask.cells.filter((c) => c === 1).length,
    corroborated: isCorroborated,
    sources: files.map(source),
  };
}

const served = Object.keys(spells).length;
if (served < MIN_SERVED) {
  throw new Error(`Only ${served} spells decoded, below the floor of ${MIN_SERVED}; refusing to write.`);
}

const out = {
  generatedAt: new Date().toISOString(),
  decoderVersion: DECODER_VERSION,
  options: OPTIONS,
  spells,
  excluded,
  stats: {
    images: allFiles.length,
    associations: [...candidates.values()].reduce((n, f) => n + f.length, 0),
    spells: candidates.size,
    served,
    excluded: Object.keys(excluded).length,
    corroborated, familyCorroborated, uncorroborated,
  },
};
const target = fileURLToPath(new URL('../data/spell-areas.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out.stats, null, 2));
