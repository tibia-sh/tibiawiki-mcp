import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import type { TibiaDb } from './db.ts';
import {
  CONVINCE_COST_MEANING, FARE_MEANING, GOLD_PER_KILL_MEANING, IMAGE_MEANING, RASHID_PLACE_MEANING,
  RUNS_AT_MEANING, SUMMON_COST_MEANING,
} from './domain.ts';
import { registerGet, NAME as GET } from './tools/get.ts';
import { registerSearch, NAME as SEARCH } from './tools/search.ts';
import { registerFindCreatures, NAME as FIND_CREATURES } from './tools/find-creatures.ts';
import { registerFindItems, NAME as FIND_ITEMS } from './tools/find-items.ts';
import { registerFindSpells, NAME as FIND_SPELLS } from './tools/find-spells.ts';
import { registerFindQuests, NAME as FIND_QUESTS } from './tools/find-quests.ts';
import { registerFindHouses, NAME as FIND_HOUSES } from './tools/find-houses.ts';
import { registerHowToObtain, NAME as HOW_TO_OBTAIN } from './tools/how-to-obtain.ts';
import { registerFindUpdates, NAME as FIND_UPDATES } from './tools/find-updates.ts';
import { registerWhereToSell, NAME as WHERE_TO_SELL } from './tools/where-to-sell.ts';
import { registerParseLoot, NAME as PARSE_LOOT } from './tools/parse-loot.ts';
import { registerFindTravel, NAME as FIND_TRAVEL } from './tools/find-travel.ts';

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
 * to listen for tool list changes that never come. Frozen at both levels, since every
 * server built here is handed the same object.
 */
export const CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) });

/**
 * Licence obligations are met in the server's own metadata rather than a README
 * nobody reads: wiki text is CC BY-SA, and the underlying game content is CipSoft's.
 */
export const ATTRIBUTION =
  'Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. ' +
  'Tibia is made by CipSoft; game content and images are copyright CipSoft GmbH. ' +
  'Images are linked from TibiaWiki, not stored or redistributed. Each image\'s ' +
  'descriptionUrl is its licence and author page. For a spell\'s areaShape, that page is ' +
  'https://tibia.fandom.com/wiki/File: followed by sourceImage with spaces replaced by ' +
  'underscores. areaShape is DERIVED by decoding the wiki\'s animation and present for a ' +
  'minority of spells. It marks affected tiles only, does not distinguish the caster or ' +
  'target tile and is not caster-relative, so creature area glyphs do not apply. ' +
  'corroborated means a second image of the same spell agreed, and false does not mean ' +
  'unsupported.';

/**
 * What result fields mean, in the words of their output schemas: a host gives the model
 * these instructions, not the output schemas.
 */
const FIELD_MEANINGS =
  `What result fields mean. runsAt: ${RUNS_AT_MEANING} summonCost: ${SUMMON_COST_MEANING} ` +
  `convinceCost: ${CONVINCE_COST_MEANING} goldPerKill: ${GOLD_PER_KILL_MEANING} ` +
  `image: ${IMAGE_MEANING} ${RASHID_PLACE_MEANING} ${FARE_MEANING} `;

export const TOOL_NAMES = [
  GET, SEARCH, FIND_CREATURES, FIND_ITEMS, FIND_SPELLS, FIND_QUESTS, FIND_HOUSES, HOW_TO_OBTAIN,
  FIND_UPDATES, WHERE_TO_SELL, PARSE_LOOT, FIND_TRAVEL,
] as const;

export function createServer(handle: TibiaDb): McpServer {
  const { provenance } = handle;
  const server = new McpServer(
    SERVER_INFO,
    {
      capabilities: CAPABILITIES,
      instructions:
        'TibiaWiki knowledge base: a snapshot of the wiki generated ' +
        `${provenance.generatedAt} by tibiawiki-sql ${provenance.version}, not live game state. ` +
        'Damage modifiers are percentages where 100 is neutral and above 100 the creature takes ' +
        'extra damage from that element. ' +
        FIELD_MEANINGS + ATTRIBUTION,
    },
  );

  // Registered inside the factory, never on a shared outer instance: the factory
  // may be invoked per request.
  registerGet(server, handle);
  registerSearch(server, handle);
  registerFindCreatures(server, handle);
  registerFindItems(server, handle);
  registerFindSpells(server, handle);
  registerFindQuests(server, handle);
  registerFindHouses(server, handle);
  registerHowToObtain(server, handle);
  registerFindUpdates(server, handle);
  registerWhereToSell(server, handle);
  registerParseLoot(server, handle);
  registerFindTravel(server, handle);

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
