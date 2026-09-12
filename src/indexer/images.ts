import type { EntityType } from '../domain.ts';
import type { WikiApi } from './wiki-api.ts';

/**
 * Resolves an entity's image to a URL and pixel size. Build-time only.
 *
 * The wiki names an entity's image after the entity, but the extension depends on
 * the type, and getting that wrong fails silently: charms resolve 0 of 24 under
 * `.gif` and 24 of 24 under `.png`, so a single-extension rule returns null for
 * every charm while every counter still balances.
 */

const CDN_HOST = 'static.wikia.nocookie.net';
const WIKI_HOST = 'tibia.fandom.com';

/** Per-type, measured over full populations on 2026-09-12. */
const EXTENSIONS: Partial<Record<EntityType, 'gif' | 'png'>> = {
  creature: 'gif', item: 'gif', npc: 'gif', spell: 'gif', mount: 'gif',
  imbuement: 'png', charm: 'png',
};

export type Subject = { entityType: EntityType; articleId: number; title: string };

export type ImageRef = Subject & {
  /** Without the `File:` prefix; used as the resource_link's required `name`. */
  fileName: string;
  url: string;
  descriptionUrl: string;
  width: number;
  height: number;
  mimeType: string;
};

export type TypeStats = {
  /** Input subjects of this type. Pinned to the inputs, never derived from outcomes. */
  subjects: number;
  resolved: number;
  /** The API answered and the file does not exist. A wiki gap; expected. */
  missing: number;
  /** A response arrived but is unusable. A broken integration; fails the build. */
  invalid: number;
  /** A title this code refuses to request. */
  skipped: number;
};

/**
 * Throws rather than defaulting. A default is how the charm failure would have
 * reached production: every charm would have been asked for as `.gif`, resolved
 * nothing, and been counted as an ordinary wiki gap.
 */
export function imageExtension(entityType: EntityType): 'gif' | 'png' {
  const ext = Object.hasOwn(EXTENSIONS, entityType) ? EXTENSIONS[entityType] : undefined;
  if (!ext) throw new Error(`No image extension is defined for entity type "${entityType}".`);
  return ext;
}

function httpsHost(value: string, host: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === host;
  } catch {
    return false;
  }
}

const positiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;

export async function resolveImages(
  subjects: readonly Subject[],
  api: WikiApi,
): Promise<{ refs: ImageRef[]; stats: Partial<Record<EntityType, TypeStats>> }> {
  const stats: Partial<Record<EntityType, TypeStats>> = {};
  const bump = (type: EntityType): TypeStats => {
    stats[type] ??= { subjects: 0, resolved: 0, missing: 0, invalid: 0, skipped: 0 };
    return stats[type]!;
  };

  // Requested file -> the subjects asking for it. A map rather than a list because
  // the API collapses duplicate requests onto one page, and two subjects sharing a
  // file must both receive it. (Defensive: 0 cross-table title collisions today.)
  const wanted = new Map<string, Subject[]>();
  for (const subject of subjects) {
    const s = bump(subject.entityType);
    s.subjects += 1;
    // The client joins titles on '|', so one containing a pipe becomes two requests.
    if (subject.title.includes('|')) {
      s.skipped += 1;
      continue;
    }
    const file = `File:${subject.title}.${imageExtension(subject.entityType)}`;
    const list = wanted.get(file) ?? [];
    list.push(subject);
    wanted.set(file, list);
  }

  const refs: ImageRef[] = [];
  const outcomes = await api.imageInfo([...wanted.keys()]);

  for (const outcome of outcomes) {
    const asking = wanted.get(outcome.requestedTitle) ?? [];
    for (const subject of asking) {
      const s = bump(subject.entityType);
      if (!outcome.found) {
        s.missing += 1;
        continue;
      }
      // Both URLs are stored and surfaced to the user as links, so both are checked
      // here rather than only in a test.
      const usable = outcome.mime.startsWith('image/')
        && positiveInt(outcome.width) && positiveInt(outcome.height)
        && httpsHost(outcome.url, CDN_HOST)
        && httpsHost(outcome.descriptionUrl, WIKI_HOST);
      if (!usable) {
        s.invalid += 1;
        continue;
      }
      refs.push({
        ...subject,
        fileName: outcome.requestedTitle.replace(/^File:/, ''),
        url: outcome.url,
        descriptionUrl: outcome.descriptionUrl,
        width: outcome.width,
        height: outcome.height,
        mimeType: outcome.mime,
      });
      s.resolved += 1;
    }
  }

  return { refs, stats };
}
