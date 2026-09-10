# Test fixture

`tibiawiki-fixture.db` is a trimmed SQLite database used by the test suite. It is
committed so tests are deterministic and never touch the network.

## Contents

It is not a random sample. Each retained row exists to make a specific test meaningful:

- **Dragon** (`modifier_fire` 0) — the fire-immune case that must be *excluded* from a
  fire-weakness search. Guards against inverting the comparison.
- **Tarantula** (115) and **Scarab** (118) — genuinely fire-weak, so the headline query
  returns a non-empty set. Without them the test would pass vacuously on an empty array.
- **Steel Helmet** and its 22 droppers — the vendor case (580 gold on the sell side,
  293 on the buy side, which is the direction bug the tests guard), and the source of
  the null-chance drop rows that make nulls-last ordering testable.
- **Magic Longsword** — genuinely unobtainable, so "no source" returns empty lists and
  a note rather than an error.
- **Mud** — the only cross-type title collision in the entire corpus, and therefore the
  only way to exercise the ambiguous-name branch.
- **Gold Coin** — the currency join target for vendor prices.
- One non-`active` creature, so the status filter has something to exclude.

Tables no tool queries are emptied but kept, so the schema stays identical to a real
index. That is what keeps the file under 1 MB.

## Reproducing it

```bash
tibiawiki-mcp build-index                 # ~3 min; data/tibiawiki.db is gitignored
node scripts/make-fixture.mjs data/tibiawiki.db test/fixtures/tibiawiki-fixture.db
```

A fresh contributor must build the full index first — it is not in the repository.

## Attribution

This fixture is redistributed wiki content: data from TibiaWiki
(https://tibia.fandom.com), licensed CC BY-SA. Tibia is made by CipSoft; game content
and images are copyright CipSoft GmbH. No images are included.
