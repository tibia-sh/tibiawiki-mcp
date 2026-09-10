import { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from './db.ts';
import { registerGet } from './tools/get.ts';
import { registerSearch } from './tools/search.ts';
import { registerFindCreatures } from './tools/find-creatures.ts';

/**
 * Licence obligations are met in the server's own metadata rather than a README
 * nobody reads: wiki text is CC BY-SA, and the underlying game content is CipSoft's.
 */
export const ATTRIBUTION =
  'Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. ' +
  'Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH.';

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

  return server;
}
