/**
 * Minimal MediaWiki client, used only at build time.
 *
 * Every network call in this server lives under `src/indexer/`; CI greps for that
 * boundary. `fetcher` and `clock` are injected so the whole suite runs offline and
 * backoff is exercised without real waiting.
 */

const API = 'https://tibia.fandom.com/api.php';
const BATCH = 50; // the anonymous `titles` limit; 500 needs apihighlimits
const RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const RETRYABLE = new Set([429, 502, 503, 504]);

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export type Clock = { sleep(ms: number): Promise<void> };

/**
 * One outcome per requested file, so a caller can tell a wiki gap from a broken
 * response. MediaWiki marks a nonexistent file explicitly - the page comes back with
 * a `missing` key and a negative pageid - and discarding that evidence is what makes
 * the two indistinguishable.
 */
export type ImageInfoOutcome =
  | {
      requestedTitle: string; title: string; found: true;
      url: string; descriptionUrl: string; width: number; height: number; mime: string;
    }
  | { requestedTitle: string; title: string; found: false };

export type WikiApi = {
  pageWikitext(titles: string[]): Promise<Array<{ title: string; wikitext: string }>>;
  moduleSource(title: string): Promise<string>;
  categoryMembers(category: string): Promise<string[]>;
  imageInfo(files: string[]): Promise<ImageInfoOutcome[]>;
};

export type WikiApiOptions = {
  fetcher?: Fetcher;
  clock?: Clock;
  userAgent?: string;
  timeoutMs?: number;
};

const DEFAULT_UA =
  'tibiawiki-mcp/1.0 (build-time index generator; https://github.com/jakubmucha/tibiawiki-mcp)';

type Json = Record<string, unknown>;

export function createWikiApi(opts: WikiApiOptions = {}): WikiApi {
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const clock: Clock = opts.clock ?? { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function request(params: Record<string, string>): Promise<Json> {
    const url = `${API}?${new URLSearchParams({ ...params, format: 'json' }).toString()}`;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      // One sleep per attempt, decided by the previous failure: a server that sent
      // Retry-After has told us how long to wait, so backoff must not be added on top.
      const backoff = BASE_BACKOFF_MS * 2 ** Math.max(attempt - 1, 0);

      let response: Response;
      try {
        response = await fetcher(url, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // A rejected fetch carries no status, so the message names the URL instead.
        lastError = new Error(`Request to ${url} failed: ${(error as Error).message}`);
        if (attempt < RETRIES) await clock.sleep(backoff);
        continue;
      }

      if (!response.ok) {
        if (!RETRYABLE.has(response.status)) {
          throw new Error(`Request to ${url} failed with HTTP ${response.status}.`);
        }
        // Retry-After is expressed in seconds; sleep takes milliseconds.
        const after = Number(response.headers.get('Retry-After'));
        const wait = Number.isFinite(after) && after > 0 ? after * 1000 : backoff;
        lastError = new Error(`Request to ${url} failed with HTTP ${response.status}.`);
        if (attempt < RETRIES) await clock.sleep(wait);
        continue;
      }

      const body = (await response.json()) as Json;
      // MediaWiki reports API-level failures as HTTP 200 with an `error` object.
      // Those are permanent: retrying a bad title only wastes the budget.
      const error = body['error'] as { code?: string; info?: string } | undefined;
      if (error) {
        throw new Error(`MediaWiki error ${error.code ?? '?'}: ${error.info ?? 'no detail'}`);
      }
      return body;
    }
    throw lastError ?? new Error(`Request to ${url} failed.`);
  }

  /** Runs a query to exhaustion, merging every `continue` token back into the params. */
  async function* paginate(params: Record<string, string>): AsyncGenerator<Json> {
    let cont: Record<string, string> = {};
    for (;;) {
      const body = await request({ ...params, ...cont });
      yield body;
      const next = body['continue'] as Record<string, string> | undefined;
      if (!next) return;
      cont = next;
    }
  }

  async function wikitextOf(titles: string[]): Promise<Array<{ title: string; wikitext: string }>> {
    const out: Array<{ title: string; wikitext: string }> = [];
    for await (const body of paginate({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: titles.join('|'),
    })) {
      const query = body['query'] as { pages?: Record<string, Json> } | undefined;
      for (const page of Object.values(query?.pages ?? {})) {
        const revisions = page['revisions'] as Array<Json> | undefined;
        const content = revisions?.[0]?.['slots'] as Json | undefined;
        const text = (content?.['main'] as Json | undefined)?.['*'];
        if (typeof text === 'string') out.push({ title: String(page['title']), wikitext: text });
      }
    }
    return out;
  }

  return {
    async pageWikitext(titles) {
      const out: Array<{ title: string; wikitext: string }> = [];
      for (let i = 0; i < titles.length; i += BATCH) {
        out.push(...(await wikitextOf(titles.slice(i, i + BATCH))));
      }
      return out;
    },

    async moduleSource(title) {
      const [page] = await wikitextOf([title]);
      if (!page) throw new Error(`Module page ${title} returned no content.`);
      return page.wikitext;
    },

    async imageInfo(files) {
      const out: ImageInfoOutcome[] = [];
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        // `normalized` maps the caller's string to the API's title. Without undoing
        // it there is no way back from a response to the subject that asked for it:
        // the API normalises, reorders, and collapses distinct requests onto one page.
        const byTitle = new Map<string, Json>();
        // `from -> to`, so a request can be resolved forwards to its page. The
        // reverse direction loses information: when two requested titles normalise
        // onto one page, only one `from` survives and the other looks unanswered.
        const normalisedTo = new Map<string, string>();
        for await (const body of paginate({
          action: 'query',
          prop: 'imageinfo',
          iiprop: 'url|size|mime',
          titles: batch.join('|'),
        })) {
          const query = body['query'] as
            | { pages?: Record<string, Json>; normalized?: Array<{ from: string; to: string }> }
            | undefined;
          for (const n of query?.normalized ?? []) normalisedTo.set(n.from, n.to);
          for (const page of Object.values(query?.pages ?? {})) byTitle.set(String(page['title']), page);
        }

        const absent: string[] = [];
        for (const requestedTitle of batch) {
          const title = normalisedTo.get(requestedTitle) ?? requestedTitle;
          const page = byTitle.get(title);
          if (!page) {
            absent.push(requestedTitle);
            continue;
          }
          const info = (page['imageinfo'] as Array<Json> | undefined)?.[0];
          if (!info) {
            out.push({ requestedTitle, title, found: false });
            continue;
          }
          out.push({
            requestedTitle, title, found: true,
            url: String(info['url']),
            descriptionUrl: String(info['descriptionurl'] ?? ''),
            width: Number(info['width']),
            height: Number(info['height']),
            mime: String(info['mime']),
          });
        }

        // A file the API neither described nor marked missing means a truncated or
        // malformed response. Folding that into "missing" would let one lost page
        // out of fifty read as 98% coverage and pass the per-type floor.
        if (absent.length > 0) {
          throw new Error(
            `imageinfo returned neither data nor a missing marker for ${absent.length} ` +
              `requested file(s): ${absent.slice(0, 5).join(', ')}. The response was truncated.`,
          );
        }
      }
      return out;
    },

    async categoryMembers(category) {
      const out: string[] = [];
      for await (const body of paginate({
        action: 'query',
        list: 'categorymembers',
        cmtitle: category,
        cmlimit: '500',
        cmnamespace: '0',
      })) {
        const query = body['query'] as { categorymembers?: Array<{ title: string }> } | undefined;
        for (const m of query?.categorymembers ?? []) out.push(m.title);
      }
      return out;
    },
  };
}
