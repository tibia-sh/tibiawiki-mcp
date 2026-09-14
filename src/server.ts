import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from './db.ts';
import { registerGet, NAME as GET } from './tools/get.ts';
import { registerSearch, NAME as SEARCH } from './tools/search.ts';
import { registerFindCreatures, NAME as FIND_CREATURES } from './tools/find-creatures.ts';
import { registerFindItems, NAME as FIND_ITEMS } from './tools/find-items.ts';
import { registerHowToObtain, NAME as HOW_TO_OBTAIN } from './tools/how-to-obtain.ts';

/**
 * What both servers report in the MCP handshake. The version is package.json's, read at
 * runtime rather than copied here, so the protocol always reports the version npm
 * published. package.json sits one level above both src/ and dist/, and npm packs it
 * into every tarball.
 */
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const SERVER_INFO = { name: 'tibiawiki-mcp', version: packageJson.version };

/**
 * Both servers register their whole tool set when they are built and never change it.
 * The SDK advertises tools.listChanged as true unless it is set, which invites a client
 * to listen for tool list changes that never come.
 */
const CAPABILITIES = { tools: { listChanged: false } };

/**
 * Licence obligations are met in the server's own metadata rather than a README
 * nobody reads: wiki text is CC BY-SA, and the underlying game content is CipSoft's.
 */
export const ATTRIBUTION =
  'Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. ' +
  'Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH. ' +
    'Images are linked from TibiaWiki, not stored or redistributed by this server; '+
    'each image carries a descriptionUrl, the wiki page holding its licence and author. ' +
    'A spell may carry areaShape: the tiles it covers, DERIVED by decoding the wiki\'s ' +
    'own animation rather than read from tile data, and present for a minority of spells. ' +
    'It marks affected tiles only - it does not distinguish the caster or target tile, and ' +
    'is not caster-relative, so the glyph vocabulary of a creature ability area does not ' +
    'apply to it. The wiki page carrying that image\'s licence and author is ' +
    'https://tibia.fandom.com/wiki/File: followed by sourceImage with spaces ' +
    'replaced by underscores. ' +
    'corroborated means a second image of the same spell agreed; false does ' +
    'not mean unsupported, since most uncorroborated shapes match other spells\' images.';

export const TOOL_NAMES = [GET, SEARCH, FIND_CREATURES, FIND_ITEMS, HOW_TO_OBTAIN] as const;

export function createServer(handle: TibiaDb): McpServer {
  const { provenance } = handle;
  const server = new McpServer(
    SERVER_INFO,
    {
      capabilities: CAPABILITIES,
      instructions:
        'TibiaWiki knowledge base: a snapshot of the wiki generated ' +
        `${provenance.generatedAt} by tibiawiki-sql ${provenance.version}. It reflects the wiki ` +
        'as of that time, not live game or server state. Damage modifiers are percentages where ' +
        '100 is neutral: above 100 the creature takes extra damage from that element. ' +
        ATTRIBUTION,
    },
  );

  // Registered inside the factory, never on a shared outer instance: the factory
  // may be invoked per request.
  registerGet(server, handle);
  registerSearch(server, handle);
  registerFindCreatures(server, handle);
  registerFindItems(server, handle);
  registerHowToObtain(server, handle);

  return server;
}

/**
 * Served when the index is missing or unusable.
 *
 * Exiting on a bad index makes the failure invisible: an MCP host reports only
 * "Connection closed" and the actionable message dies on stderr. The protocol is
 * the error channel, so the server starts anyway, advertises the same tool surface,
 * and answers every call with the reason and the fix.
 */
export function createUnavailableServer(reason: string): McpServer {
  const server = new McpServer(
    SERVER_INFO,
    {
      capabilities: CAPABILITIES,
      instructions:
        `TibiaWiki index unavailable, so no query can be answered yet. ${reason} ` +
        'Once the index exists, restart this server.',
    },
  );

  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description:
          `UNAVAILABLE: the local TibiaWiki index is missing or unusable, so ${name} ` +
          'cannot answer anything until it is built.',
        inputSchema: z.object({}).loose(),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => ({
        isError: true,
        content: [{
          type: 'text',
          text:
            `${name} is unavailable: ${reason} ` +
            'Build the index with `tibiawiki-mcp build-index`, then restart this MCP server. ' +
            'If the unusable index is an old one you built, deleting it works too: unless ' +
            'TIBIAWIKI_MCP_DB is set, the server then falls back to the packaged index. ' +
            'Tell the user this rather than retrying.',
        }],
      }),
    );
  }
  return server;
}
