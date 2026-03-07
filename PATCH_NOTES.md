# Patch notes (source + dist)

This folder includes:
- `src/` (pre-compiled React/TS source) with:
  - Backend config UI for local memU server runtime
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


## memu14only.worldinfo.skipnull (2026-02-15)
- Writes memU category summaries into SillyTavern World Info as separate lorebooks (one per category).
- Skips categories whose summary is null/empty.
- Stops relying on memU → Summarize field sync (avoids persistent weird output).

## memu14only.fix17.seraphina-orphan-cursor (2026-02-16)
- Fix: Seraphina (first-time ingest) could get stuck when the backend reports "Unknown taskId"; we now attempt retrieve anyway.
- Fix: prevent "orphan cursor" (cursor advanced before retrieve) by not persisting the cursor at memorize start; cursor is saved only after successful retrieve.
- Recovery: if a local cursor exists but no memU state is saved for the chat, we auto-clear the cursor so the chat can ingest normally.

## memu14only.fix19.cursor-collapse (2026-02-16)
- Fix: status polling could temporarily mark a digest as FAILURE and **shrink** `summaryRange` to `[from, from]`. If the backend then returned "Unknown taskId" and we retrieved anyway, we would persist `to=from` to the local cursor.
  - Symptom: on chat re-open, the extension thinks 5 messages are "new" and re-runs memorize/retrieve even when nothing changed.
- Change: never mutate/shrink the processed range based on transient status probes; keep the original `[from, to]` range.

## memu14only.fix20.worldinfo-ui-only (2026-02-16)
- Change: memU-generated lorebook entries are now **disabled (not injected)** by default.
  - Reason: memU already injects its retrieved summary via `addSummaryToPrompt()`. Injecting the same content again via World Info wastes tokens and clutters prompt logs.
  - You can still manually enable a lorebook entry if you want World Info injection.

## memu14only.fix23.hook-retry-retrieve-backoff (2026-02-24)
- Fix: install background hooks with a short retry loop (handles ST builds where `eventSource` is initialized late).
- Fix: when `/retrieveDefaultCategories` is failing repeatedly, stop poller spam by backing off after 2 failures for that taskId.
