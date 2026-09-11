/**
 * Extracts creature ability -> area-pattern references from page wikitext.
 *
 * The generator (`tibiawikisql`) parses the same member templates into
 * `creature_ability` rows but discards the `scene=` argument, which is the only
 * thing that names the tile pattern. This module recovers it and joins the two.
 *
 * Measured over the full corpus (1,874 scenes): 1,749 join uniquely, 0 ambiguous.
 * See docs/superpowers/spikes/2026-09-11-ability-scene-join.md.
 */

/** Kinds the generator turns into rows. Anything else has no row to join to. */
const KINDS = new Set(['Ability', 'Melee', 'Healing', 'Summon']);
/** Kinds the generator drops. Their scenes must be discarded, never remapped. */
const DROPPED = new Set(['Haste', 'Debuff', 'Outfit']);

const MEMBER_OPENER = /\{\{(\s*)([A-Za-z][A-Za-z ]*?)(\s*)\|/g;
const SCENE = /scene\s*=\s*\{\{\s*Scene\b/;

export type AbilityRow = { name: string; effect: string | null; element: string | null };

export type SceneRef = {
  /** The MATCHED ROW's identity, never the extracted text - see matchRow(). */
  abilityName: string;
  abilityEffect: string;
  abilityElement: string;
  patternKey: string;
  effectOnCaster: boolean;
};

export type ExtractStats = {
  scenes: number;
  joined: number;
  ambiguous: number;
  noRow: number;
  discardedKind: number;
  discardedNoSpell: number;
  discardedRotate: number;
  unparsedMember: number;
};

const emptyStats = (): ExtractStats => ({
  scenes: 0, joined: 0, ambiguous: 0, noRow: 0,
  discardedKind: 0, discardedNoSpell: 0, discardedRotate: 0, unparsedMember: 0,
});

/**
 * Splits on `|` at depth zero. Both `[[ ]]` and `{{ }}` carry their own pipes, and
 * the reference is a template nested inside a template, so counting links alone
 * shreds every scene-carrying member.
 */
function splitDepth0(body: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < body.length; ) {
    const two = body.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth += 1; buf += two; i += 2; continue; }
    if (two === ']]' || two === '}}') { depth -= 1; buf += two; i += 2; continue; }
    if (body[i] === '|' && depth === 0) { parts.push(buf); buf = ''; i += 1; continue; }
    buf += body[i];
    i += 1;
  }
  parts.push(buf);
  return parts;
}

/** Collapses wiki links to display text and decodes the entities the wiki emits. */
function collapse(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&#45;/g, '-')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Finds each member template and its body, matching brace pairs rather than regex. */
function* members(wikitext: string): Generator<{ kind: string; body: string; canonical: boolean }> {
  for (const m of wikitext.matchAll(MEMBER_OPENER)) {
    const [, lead, rawName, trail] = m;
    const name = rawName!;
    if (!KINDS.has(name.trim()) && !DROPPED.has(name.trim())) continue;
    // The generator matches template names exactly: it emits no row for
    // `{{Ability |` or `{{healing|`. Verified against all 10 live occurrences.
    const canonical = !lead && !trail && (KINDS.has(name) || DROPPED.has(name));

    let i = m.index + m[0].length - 1;
    let depth = 1;
    const start = i;
    while (i < wikitext.length && depth > 0) {
      const two = wikitext.slice(i, i + 2);
      if (two === '{{') { depth += 1; i += 2; continue; }
      if (two === '}}') { depth -= 1; i += 2; continue; }
      i += 1;
    }
    yield { kind: name.trim(), body: wikitext.slice(start, i - 2), canonical };
  }
}

type Args = { positional: string[]; named: Record<string, string> };

function parseArgs(body: string): Args {
  const parts = splitDepth0(body);
  // A member body begins with `|`, so the split leaves an empty leading part.
  // Keeping it shifts every positional argument by one and scores 0% joined.
  if (parts.length > 0 && parts[0]!.trim() === '') parts.shift();

  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const part of parts) {
    const m = /^\s*([A-Za-z_0-9]+)\s*=([\s\S]*)$/.exec(part);
    if (m) named[m[1]!] = m[2]!;
    else positional.push(part);
  }
  return { positional, named };
}

/** `undefined` means the argument was absent; `''` means it was supplied but empty. */
function arg(args: Args, name: string, index?: number): string | undefined {
  if (Object.hasOwn(args.named, name)) return collapse(args.named[name]!);
  if (index !== undefined && args.positional.length > index) return collapse(args.positional[index]!);
  return undefined;
}

type Extracted = { name: string; effect?: string; element?: string };

/** Each kind produces its triple differently; a generic parser scores 0%, not less. */
function perKind(kind: string, args: Args): Extracted {
  switch (kind) {
    case 'Melee':
      return {
        name: arg(args, 'name') || 'Melee',
        effect: arg(args, 'damage', 0),
        element: arg(args, 'element') || 'physical',
      };
    case 'Healing':
      return {
        name: arg(args, 'name') || 'Self-Healing',
        effect: arg(args, 'range', 0),
        element: 'healing',
      };
    case 'Summon':
      return { name: arg(args, 'name', 0) ?? '', effect: arg(args, 'amount', 1), element: 'summon' };
    default:
      return { name: arg(args, 'name', 0) ?? '', effect: arg(args, 'damage', 1), element: arg(args, 'element') };
  }
}

const norm = (v: string | null): string => v ?? '';

type MatchResult =
  | { kind: 'one'; row: AbilityRow }
  | { kind: 'none' }
  | { kind: 'many' };

/**
 * Matches in tiers, accepting only a tier that yields exactly one row. A tier may
 * drop a component only if the wikitext did not supply it: falling back past an
 * explicit `element=` can uniquely select a row that contradicts it.
 */
function matchRow(rows: readonly AbilityRow[], want: Extracted): MatchResult {
  // An absent damage argument means '?', which is what the generator stores.
  const effect = want.effect ?? '?';
  const element = want.element;

  const tiers: Array<(r: AbilityRow) => boolean> = [
    (r) => r.name === want.name && norm(r.effect) === effect && norm(r.element) === (element ?? ''),
  ];
  // Only drop what was not supplied.
  if (element === undefined) {
    tiers.push((r) => r.name === want.name && norm(r.effect) === effect);
  }
  if (element === undefined && want.effect === undefined) {
    tiers.push((r) => r.name === want.name);
  }
  // An absent damage argument also matches a row that recorded it as empty.
  if (want.effect === undefined) {
    tiers.push((r) => r.name === want.name && norm(r.effect) === '' && norm(r.element) === (element ?? ''));
  }

  let sawMany = false;
  for (const tier of tiers) {
    const hits = rows.filter(tier);
    if (hits.length === 1) return { kind: 'one', row: hits[0]! };
    if (hits.length > 1) sawMany = true;
  }
  return sawMany ? { kind: 'many' } : { kind: 'none' };
}

export function extractSceneRefs(
  wikitext: string,
  abilityRows: readonly AbilityRow[],
): { refs: SceneRef[]; stats: ExtractStats } {
  const refs: SceneRef[] = [];
  const stats = emptyStats();

  for (const { kind, body, canonical } of members(wikitext)) {
    if (!SCENE.test(body)) continue;
    stats.scenes += 1;

    if (!canonical) { stats.unparsedMember += 1; continue; }
    if (DROPPED.has(kind)) { stats.discardedKind += 1; continue; }

    const args = parseArgs(body);
    const sceneBody = args.named['scene'] ?? '';
    if (/rotate90\s*=\s*yes/.test(sceneBody)) { stats.discardedRotate += 1; continue; }
    const spell = /spell\s*=\s*([^|}\n]+)/.exec(sceneBody);
    if (!spell) { stats.discardedNoSpell += 1; continue; }

    const want = perKind(kind, args);
    const result = matchRow(abilityRows, want);
    if (result.kind === 'many') { stats.ambiguous += 1; continue; }
    if (result.kind === 'none') { stats.noRow += 1; continue; }

    // The matched row's identity, not the extracted text: a fallback tier matches
    // precisely when the dropped component differs, so storing what was extracted
    // would make 39.7% of real rows unretrievable by the runtime's exact join.
    refs.push({
      abilityName: result.row.name,
      abilityEffect: norm(result.row.effect),
      abilityElement: norm(result.row.element),
      patternKey: spell[1]!.trim(),
      effectOnCaster: /effect_on_caster\s*=\s*yes/.test(sceneBody),
    });
    stats.joined += 1;
  }

  return { refs, stats };
}
