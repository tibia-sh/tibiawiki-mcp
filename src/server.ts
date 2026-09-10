import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from './db.ts';
import { registerGet, NAME as GET } from './tools/get.ts';
import { registerSearch, NAME as SEARCH } from './tools/search.ts';
import { registerFindCreatures, NAME as FIND_CREATURES } from './tools/find-creatures.ts';
import { registerFindItems, NAME as FIND_ITEMS } from './tools/find-items.ts';
import { registerHowToObtain, NAME as HOW_TO_OBTAIN } from './tools/how-to-obtain.ts';

/**
 * Licence obligations are met in the server's own metadata rather than a README
 * nobody reads: wiki text is CC BY-SA, and the underlying game content is CipSoft's.
 */
export const ATTRIBUTION =
  'Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. ' +
  'Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH.';

export const TOOL_NAMES = [GET, SEARCH, FIND_CREATURES, FIND_ITEMS, HOW_TO_OBTAIN] as const;

export function createServer(handle: TibiaDb): McpServer {
  const { provenance } = handle;
  const server = new McpServer(
    { name: 'tibiawiki-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Offline TibiaWiki knowledge base. This is a local snapshot of the wiki, generated ' +
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
    { name: 'tibiawiki-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {} },
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
            'Build the index with `tibiawiki-mcp build-index` (about three minutes), then ' +
            'restart this MCP server. Tell the user this rather than retrying.',
        }],
      }),
    );
  }
  return server;
}
