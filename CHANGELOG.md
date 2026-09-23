# Changelog

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
