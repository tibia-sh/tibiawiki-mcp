# Changelog

## [0.11.1](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.11.0...v0.11.1) (2026-09-25)


### Bug Fixes

* keep three meanings in the trim ([b9d6b93](https://github.com/tibia-sh/tibiawiki-mcp/commit/b9d6b9362b59f17e82d59ea719740cee42ae4d2c))
* match search queries literally ([15ccc57](https://github.com/tibia-sh/tibiawiki-mcp/commit/15ccc57d0dd9b9e7323a89bd96cff8194eca0c0d))
* size the request cap from the loot limit ([ca9e56d](https://github.com/tibia-sh/tibiawiki-mcp/commit/ca9e56d486c7a6b6756695aa26dd56e6a14b60f4))
* trim the instructions and descriptions ([92d4834](https://github.com/tibia-sh/tibiawiki-mcp/commit/92d48341909cfbac9785682afc72bc5cca38ccbb))

## [0.11.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.10.1...v0.11.0) (2026-09-25)


### Features

* expose in-game names and item flags ([800c756](https://github.com/tibia-sh/tibiawiki-mcp/commit/800c75659258795ff1a70ed875fb562beec00de4))
* filter items by element and leech ([101870b](https://github.com/tibia-sh/tibiawiki-mcp/commit/101870b9ea3533ec8a0708646fd4e315c6e7a94c))
* find boat and carpet routes ([af16676](https://github.com/tibia-sh/tibiawiki-mcp/commit/af166760b51d7d470392c11bb87084d7d36f89e5))
* parse loot messages ([a9ff524](https://github.com/tibia-sh/tibiawiki-mcp/commit/a9ff5247ddcb951fb3fb594c89376fd0e02cfafa))
* resolve names the game prints ([40a03b1](https://github.com/tibia-sh/tibiawiki-mcp/commit/40a03b17f46d708781838bbd48882787ad649734))


### Bug Fixes

* cap the loot lists at 100 ([8a2699c](https://github.com/tibia-sh/tibiawiki-mcp/commit/8a2699c2809833289787b28ccdc014ef47d4a5db))
* keep loot results compact by default ([52c8bde](https://github.com/tibia-sh/tibiawiki-mcp/commit/52c8bde5c0534540e79cc649bffec61de3dd4d13))
* keep loot totals exact ([581be35](https://github.com/tibia-sh/tibiawiki-mcp/commit/581be35b2ac89aaead49121e26f3f0c8efc8ae59))
* retry an unmatched name as a plural ([c94a7dc](https://github.com/tibia-sh/tibiawiki-mcp/commit/c94a7dc3c005c1a261567e2ea1f4c27cd7b3d158))
* say a null article means none ([f386729](https://github.com/tibia-sh/tibiawiki-mcp/commit/f38672910eb21c2339ca7c0834a1d41dee463266))


### Performance Improvements

* index creature names in memory ([7be4769](https://github.com/tibia-sh/tibiawiki-mcp/commit/7be476925b82c3998b29996d33f724c6b614ffe5))
* index item names in memory ([87dff34](https://github.com/tibia-sh/tibiawiki-mcp/commit/87dff34f0a6bbf734e988b988f8b6752d4271a1f))
* stop the loot line match at one colon ([05235c0](https://github.com/tibia-sh/tibiawiki-mcp/commit/05235c01556f6a5e86a03f309bb02275dff6a574))

## [0.10.1](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.10.0...v0.10.1) (2026-09-25)


### Bug Fixes

* say Rashid's coordinates are null ([b73e58b](https://github.com/tibia-sh/tibiawiki-mcp/commit/b73e58b58f101ccdefe555cb6b401109186cc66e))
* tell the model what the zeros mean ([6fed2e5](https://github.com/tibia-sh/tibiawiki-mcp/commit/6fed2e585b29a7d15696d2c0a116793c0812e049))

## [0.10.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.9.0...v0.10.0) (2026-09-24)


### Features

* add city and position to buyers ([972c8ad](https://github.com/tibia-sh/tibiawiki-mcp/commit/972c8adc0c58fbbbc48dfcf478baba6106918ab1))
* estimate gold per kill ([eac9bb7](https://github.com/tibia-sh/tibiawiki-mcp/commit/eac9bb74108359b8d09bf4d41ca1ec95d19aa77a))
* expose how creatures behave ([c59ff1a](https://github.com/tibia-sh/tibiawiki-mcp/commit/c59ff1adb7bf8aa8ba82cd86273d5db1107c3713))
* expose item client IDs ([56a442c](https://github.com/tibia-sh/tibiawiki-mcp/commit/56a442c093c44a8293231129c73119564004f8b5))
* find where to sell a list of items ([95fa26d](https://github.com/tibia-sh/tibiawiki-mcp/commit/95fa26d168ed051d4924eac0e2572936df372900))


### Bug Fixes

* match creature locations literally ([0841d1b](https://github.com/tibia-sh/tibiawiki-mcp/commit/0841d1bbd7fe409f69fff45f6d567fc1cd0216d7))
* share creature field descriptions ([abc682f](https://github.com/tibia-sh/tibiawiki-mcp/commit/abc682f3841868be4c8f96f430d14639be11d9a8))

## [0.9.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.8.0...v0.9.0) (2026-09-24)


### Features

* filter items by mana drain and critical hits ([593c493](https://github.com/tibia-sh/tibiawiki-mcp/commit/593c493d69df7b02058f46277845aa4d807904f0))

## [0.8.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.7.0...v0.8.0) (2026-09-24)


### Features

* filter items by resistance and bonuses ([4c9cc47](https://github.com/tibia-sh/tibiawiki-mcp/commit/4c9cc47120c08d507c0543513f25bfebe20d2fb2))
* find quests and houses ([f685c23](https://github.com/tibia-sh/tibiawiki-mcp/commit/f685c23e759c3d45751bc4ca0a6070b1f388b4c2))
* find spells by vocation, level and group ([1171a1b](https://github.com/tibia-sh/tibiawiki-mcp/commit/1171a1bd259d614080f246c865862f3ae559931f))
* list every page of a type ([49a6805](https://github.com/tibia-sh/tibiawiki-mcp/commit/49a6805e5d9722a6ab53f8abb91ae2a3e561244e))
* show who buys an item and what NPCs trade ([7b4fcc3](https://github.com/tibia-sh/tibiawiki-mcp/commit/7b4fcc3cf37975775790c130630888e63cf69ada))


### Bug Fixes

* accept lowercase spell groups and types ([a44fcc4](https://github.com/tibia-sh/tibiawiki-mcp/commit/a44fcc42854dcd802069b100e3762df0ae7a0b6d))
* list each NPC seller once ([da33acd](https://github.com/tibia-sh/tibiawiki-mcp/commit/da33acd3f9e48c8882a2e9c95fa51d5bb164ca37))
* list each quest reward once ([08a9cf3](https://github.com/tibia-sh/tibiawiki-mcp/commit/08a9cf3aee1c5aadebe76f25ddcdc413df3d3799))
* order sellers fully ([96e522e](https://github.com/tibia-sh/tibiawiki-mcp/commit/96e522e60fb242dded7f17a7c44977a4bd40f324))
* reject negative finder numbers ([1eee764](https://github.com/tibia-sh/tibiawiki-mcp/commit/1eee7648240aed15d1c100a98d0b430e37165257))
* report resistances and skills as numbers ([75e2074](https://github.com/tibia-sh/tibiawiki-mcp/commit/75e207492e83b5423590cc72b00229573a5f8877))
* sort items by one value per stat ([6f1e670](https://github.com/tibia-sh/tibiawiki-mcp/commit/6f1e6705128917e03d82afbe9b4e955c3c10f26a))
* take hands in lowercase like other inputs ([4145a3c](https://github.com/tibia-sh/tibiawiki-mcp/commit/4145a3c1d3b11cf24cb4f3998987ff07af917b08))

## [0.7.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.6.3...v0.7.0) (2026-09-23)


### Features

* find game updates by text and date ([86a198d](https://github.com/tibia-sh/tibiawiki-mcp/commit/86a198d917e0d739d9e6b4ac5e5a82c432208a20))


### Bug Fixes

* harden tibia_find_updates' text matching ([9bbe75c](https://github.com/tibia-sh/tibiawiki-mcp/commit/9bbe75cb12b88ad62eb764b2e2b861b4e5e8228d))
* keep a match that ends a long line ([05777cf](https://github.com/tibia-sh/tibiawiki-mcp/commit/05777cf55e44998c654a372e354e77bf690cffdc))
* name the spell group cooldowns in seconds ([e6d1fc2](https://github.com/tibia-sh/tibiawiki-mcp/commit/e6d1fc21c5e9ac1ce31133dd9ff7896bc0da1863))
* refuse a cursor offset past a safe integer ([cb61a7b](https://github.com/tibia-sh/tibiawiki-mcp/commit/cb61a7bf13edc59a4010cbbc026bd4e174c9b913))
* return spell descriptions and requirements ([4b7953b](https://github.com/tibia-sh/tibiawiki-mcp/commit/4b7953b9158852b7ccfaf7dc6a7cd4b32e2bf5ef))

## [0.6.3](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.6.2...v0.6.3) (2026-09-19)


### Documentation

* say how to release without a fix or a feature ([d07b016](https://github.com/tibia-sh/tibiawiki-mcp/commit/d07b016f23664594641e9bb56ad9c8eca501ad59))

## [0.6.2](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.6.1...v0.6.2) (2026-09-16)


### Bug Fixes

* refuse a zone-scoped --host ([10de2b7](https://github.com/tibia-sh/tibiawiki-mcp/commit/10de2b794d810f9cdb032132feb3e78c5bbdce0b))

## [0.6.1](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.6.0...v0.6.1) (2026-09-16)


### Bug Fixes

* name a signal-killed or over-buffered uv in build-index errors ([faf2962](https://github.com/tibia-sh/tibiawiki-mcp/commit/faf29623c92a2445abae912d24efbeefa8dabac6))

## [0.6.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.5.0...v0.6.0) (2026-09-15)


### Features

* list the hosted endpoint in the MCP registry ([447cde9](https://github.com/tibia-sh/tibiawiki-mcp/commit/447cde9dc22e7a847d5e0fe4516adfafa528b339))

## [0.5.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.4.0...v0.5.0) (2026-09-15)


### Features

* add the serve --http command ([150a73f](https://github.com/tibia-sh/tibiawiki-mcp/commit/150a73fae688637f4929d94939f1fb51b2a9f9f7))
* add the streamable HTTP transport ([a9bde39](https://github.com/tibia-sh/tibiawiki-mcp/commit/a9bde3903c30d7981878cb66f65d1eb786a3fe25))


### Bug Fixes

* make the handshake accurate on any transport ([41865ae](https://github.com/tibia-sh/tibiawiki-mcp/commit/41865ae18c0badad12a2eae87b8b67ca231748d2))
* name the spawn error when uv cannot start ([7b1e8d1](https://github.com/tibia-sh/tibiawiki-mcp/commit/7b1e8d14dec03f6da5a6681c7430cf1d323a9869))

## [0.4.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.3.1...v0.4.0) (2026-09-14)


### Features

* add a plugin marketplace for Claude Code ([f37f4ef](https://github.com/tibia-sh/tibiawiki-mcp/commit/f37f4efbe31c13ec6be7f2ac08e8765bda462018))


### Bug Fixes

* print build-index failures without a stack trace ([6397967](https://github.com/tibia-sh/tibiawiki-mcp/commit/63979676bae4a6b3384b4dcf9ff1850c1d5c20d8))

## [0.3.1](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.3.0...v0.3.1) (2026-09-13)


### Bug Fixes

* hash-verify the generator's dependencies ([3f99709](https://github.com/tibia-sh/tibiawiki-mcp/commit/3f997096182af79542c6806f5d4f544c91fea824))

## [0.3.0](https://github.com/tibia-sh/tibiawiki-mcp/compare/v0.2.0...v0.3.0) (2026-09-13)


### Features

* add the index-digest command ([d80308e](https://github.com/tibia-sh/tibiawiki-mcp/commit/d80308ef4725fdc3e661c8d46abfc5a02c2afaeb))
* run the plugin from the published package ([d463e79](https://github.com/tibia-sh/tibiawiki-mcp/commit/d463e79fbaf09b4408c3c28a42cedce4a9374ee2))
