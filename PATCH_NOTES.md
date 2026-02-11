# Patch notes (source + dist)

This folder includes:
- `src/` (pre-compiled React/TS source) with:
  - Backend Mode (cloud/local) UI
  - Config round-trip to the server plugin (`/api/plugins/memu/config`)
  - Profile mapping UI + per-step overrides
  - **Advanced overrides checkbox auto-enables** on refresh when overrides exist
- `webpack.config.mjs` changed so `@silly-tavern/*` imports compile to **absolute** `/scripts/...` paths.
  - This removes the need for manual `../../../../../` path hacks in built `dist/index.js`.
- `dist/index.js` (prebuilt) so users do **not** need `npm install`.

## Build (dev only)
If you want to rebuild `dist/` yourself (requires a working Node toolchain + network for deps):

1. `npm ci`
2. `npm run build`

For distribution, it’s best to commit `dist/` so users can just drop the extension folder into `SillyTavern/data/<user>/extensions/`.


## local24.summarycursorfix (2026-02-09)
- Fix summary cursor logic: next `from` = lastTo+1, preserve cursor on failures, clearer logging.
