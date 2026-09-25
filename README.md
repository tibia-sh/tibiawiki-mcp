# tibiawiki-mcp

An MCP server for [TibiaWiki](https://tibia.fandom.com). It lets an AI assistant answer the
questions the wiki itself cannot:

- *Which creatures are weak to fire and give over 500 experience?*
- *What drops a Dragon Shield, and how likely is it?*
- *Where do I buy a Steel Helmet, and for how much?*

Every answer comes from a SQLite snapshot of the wiki that installs with the server. Queries
return in milliseconds and work offline. The server makes no network calls.

## Use it

### Hosted, nothing to install

Add `https://mcp.tibia.sh/wiki` to your MCP client as a remote server. It needs no account and no
key. In claude.ai, add it as a custom connector.

It allows about 300 messages a minute per IP address and writes no request logs. The landing page at
`https://mcp.tibia.sh` shows the versions it runs.
[`tibia-sh/mcp.tibia.sh`](https://github.com/tibia-sh/mcp.tibia.sh) has the details.

### Claude Code

Install it as a plugin, from your terminal. You get the server and a skill that teaches the agent
the traps in the data, like damage modifiers where 100 is neutral:

```bash
claude plugin marketplace add tibia-sh/tibiawiki-mcp
claude plugin install tibiawiki-mcp@tibiawiki-mcp
```

### Any other MCP client

Add this to your client's MCP configuration, for example `claude_desktop_config.json` for Claude
Desktop or `.cursor/mcp.json` for Cursor. It needs `Node 22.13` or later:

```json
{
  "mcpServers": {
    "tibiawiki": { "command": "npx", "args": ["-y", "@tibia.sh/tibiawiki-mcp"] }
  }
}
```

The first start downloads the package and its 18 MB index. After that it works offline.

## Tools

You ask questions, and your assistant calls these:

| Tool | Answers |
|---|---|
| `tibia_search` | "Is there a page called roughly X?" or "List every mount." Items also match by the name or plural the game prints, like "vial of lifefluid" |
| `tibia_get` | "Tell me everything about X." X is a wiki title, and can be a creature, item, NPC, quest or spell. An item says its client ID, the name and plural the game prints, whether it stacks, can be picked up or is immobile, and which NPCs buy it, for how much and where. A creature says its name as the game prints it, how it behaves, like when it flees, and its gold per kill. An NPC says what it buys and sells |
| `tibia_find_creatures` | "Which creatures match these stats?" Also by behaviour, like seeing invisible or being pushable, and ranked by gold per kill |
| `tibia_find_items` | "Which items match these stats?" Also by resistance, skill bonus, imbuement slots, weight, hands, client ID, weapon element, life or mana leech, and whether it stacks or can be picked up |
| `tibia_find_spells` | "Which healing spells can a level 30 druid cast?" |
| `tibia_find_quests` | "Which quests can a level 20 character do, and what do they give?" |
| `tibia_find_houses` | "What is the cheapest house in Thais with two beds?" |
| `tibia_how_to_obtain` | "Where do I get X?" Drops, vendors and quest rewards in one call. X can be the wiki title or the name the game prints |
| `tibia_find_updates` | "What changed for knights in 2026?" Game updates by text and release date |
| `tibia_where_to_sell` | "Where do I sell all this loot?" The NPC paying the most for each item, grouped by city. It takes the names the game prints too, like "gold coins", and lists a name several items share with those items |
| `tibia_parse_loot` | "What is this loot worth?" Paste loot messages as the game prints them and get each item's count and NPC value in gold, with client IDs per line on request |
| `tibia_find_travel` | "Which boat goes to Svargrond, and for how much?" Boat and carpet routes to a place or from a city, with fares. Each row is one leg, not a planned journey |

The server tells your assistant how to read the data, for example that a damage modifier of 100
is neutral. [What the skill adds](https://github.com/tibia-sh/tibiawiki-mcp/blob/main/docs/USAGE.md#what-the-skill-adds)
lists the traps.

## How fresh the data is

The index is a snapshot. Every answer says when it was taken, as `indexGeneratedAt`. It ships as
its own package, [`@tibia.sh/tibiawiki-data`](https://github.com/tibia-sh/tibiawiki-data), rebuilt
on Tuesdays and Fridays and released when the wiki changed. A fresh install gets the newest one.
The hosted server follows each release by itself.

## Take the whole index

The tools answer questions. If you are building a loot filter, a hunt planner or a bot's data
layer and want every row, install the index itself:

```bash
npm install @tibia.sh/tibiawiki-data
```

It exports `DB_PATH`, the absolute path to `index.db`, and `SCHEMA_VERSION`. Open the file
read-only with any SQLite client. In Node 22.13 or later, `node:sqlite` does it:

```js
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from '@tibia.sh/tibiawiki-data'

const db = new DatabaseSync(DB_PATH, { readOnly: true })
```

Its [README](https://github.com/tibia-sh/tibiawiki-data#readme) says what the tables hold and
how the versions work. The data stays CC BY-SA, so credit TibiaWiki when you ship it.

## Why it exists

TibiaWiki runs on Fandom without Cargo, Semantic MediaWiki or CirrusSearch, so there is
no way to query it by attribute. Every structured value is trapped inside Infobox
wikitext, and the built-in search returns *Dragon Necklace* for `fire resistant dragon`.
The public REST API over the same wiki exposes exactly one query parameter. Building a
local index is the only way to ask a real question.

## More

- [docs/USAGE.md](https://github.com/tibia-sh/tibiawiki-mcp/blob/main/docs/USAGE.md) => the plugin in detail, serving over HTTP yourself, building your own index
- [docs/MAINTAINING.md](https://github.com/tibia-sh/tibiawiki-mcp/blob/main/docs/MAINTAINING.md) => working on the server and releasing it

## Attribution

Data from TibiaWiki (https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by
CipSoft; game content and images are copyright CipSoft GmbH.

The index is generated by [tibiawiki-sql](https://github.com/Galarzaa90/tibiawiki-sql)
(Apache-2.0). Images are deliberately never fetched or stored.

This project's own code is MIT licensed, see `LICENSE`. That covers the code only. The
data it serves is CC BY-SA and not ours to relicense.
