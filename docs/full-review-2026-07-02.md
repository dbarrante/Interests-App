# Full Code + Design Review — Interests App & Extension
**Date:** 2026-07-02 · **App:** v1.6.3 · **Extension:** v4.45
**Method:** four parallel review agents (Core service, Web UI, Extension, Data-model/Sync-for-iPhone), findings verified against source with file:line references.

---

## A. CRITICAL BUGS (fix before anything else)

| # | Where | Bug | Effect |
|---|-------|-----|--------|
| A1 | `web/index.html:985-1031` | Settings "Restore from a file" writes restored cards/saved/settings to **localStorage**, which the app stopped reading after the Core-service migration. Only images go through `Store.imgPut`. | A file restore reports success but restores nothing except images. Silent data-recovery failure. |
| A2 | `web/index.html:4380-4383` | Boot race: `setInterval(drainCaptures, 3000)` starts before `bootData()` finishes loading `saved`/`imported`. A capture queued while the app was closed can trigger `persistAll()` → `Store.putSaved([one clip])` — a full-replace PUT. | **Can wipe the entire Saved library** (and, with tombstones, propagate the wipe via Dropbox sync to other devices). |
| A3 | `core/server.js:74` | `const { db, storeDir } = ctx;` destructured once at startup; `backup.restore()` and `backup.moveStore()` rebind `ctx.db`/`ctx.storeDir`, but the routes keep the stale locals. | After a Restore, every data route uses a **closed DB handle** (500s until app restart). After a store Move, new images are silently written to the **abandoned folder** — storage split with no error. |
| A4 | `extension/content.js:56-66` | The metadata IIFE ends with a bare `data;` instead of `return data;` — the injected script's completion value is `undefined` (verified empirically in V8). | og:image/title/description extraction and the entire blocked-page/CAPTCHA detector are **dead code** for every capture. One-line fix, highest value in the whole review. |
| A5 | `core/server.js:94-99` → `core/db.js:186` | Full-array `PUT /api/cards` diffs against the DB and **tombstones anything missing from the payload**. A renderer holding a stale array (while background sync merged in a peer's new card) deletes-and-tombstones that card on its next save — and sync propagates the "deletion" everywhere. | Cross-device data loss today; **fatal landmine for the iPhone app** if it ever writes through this API. |

## B. HIGH-SEVERITY STABILITY BUGS

### Core service
- **B1** `core/backup.js:215-226` — restore mid-swap failure (locked/online-only file, disk full) leaves `ctx.db` closed and never reaches `ctx.reopen()`. Wrap the swap; reopen on failure.
- **B2** `main.js:143,156,207` + `core/undici-guard.js:39-41` — un-awaited `shell.openExternal()` rejections hit the global unhandled-rejection handler, which shows an error dialog and **quits the app**. Add `.catch(()=>{})`; consider log-and-continue for non-Error rejections generally.
- **B3** `main.js:50-54,107-122` — sync timers only read config at launch. Enabling sync needs a restart; worse, **disabling sync doesn't stop the timers** — the app keeps writing to Dropbox until restart. Timers should re-check `config.getSyncConfig().enabled` each tick.

### Web UI
- **B4** `web/index.html:1969` — Settings "clear" link writes dead kv key `ia_imported`; never calls `Store.putCards([])`. Broken control (luckily — it has no confirm).
- **B5** `web/index.html:3091,3114` — `if(!Store.putCards(...))` can never be true (Promise is always truthy); nearly all `putCards/putSaved/kvSet` calls are fire-and-forget with no `.catch`. This is the same failure class as the past "imports never persisted" incident. Add one awaited `persistCards()` helper that toasts on rejection.
- **B6** `web/index.html:2817` — "Fetch info" still calls the dead allorigins proxy (removed everywhere else). Port to `Store.captureMeta` or delete the button.
- **B7** `web/index.html:703-707` — `CATS.find(...).name` throws when the persisted `filterCat` refers to a deleted/foreign category (possible after restore or Dropbox sync) → Feed/Saved renders blank. One-line guard.
- **B8** `web/index.html:2790-2798` — `selectShown` duplicates the `renderImported` filter but omits 4 predicates (`impUnreviewed`, `impFailed`, `impFbMiss`, `impBatchIds`) → "Select all shown" selects cards that aren't shown; a following bulk Recapture/Open hits far more than the user saw. Extract one shared `impFilterPredicate()`.

### Extension
- **B9** `extension/bridge.js:136-139,161-178` — the bridge batch driver never re-reads batch-state (ignores Stop) and rewrites `active:true` after every item, **resurrecting a cancelled batch**. The SW driver was explicitly fixed for this (`background.js:437-439`); bridge wasn't.
- **B10** `extension/manifest.json:13` — bridge.js injects into **every** localhost/127.0.0.1 tab on any port. Unrelated dev servers get a live batch driver; two tabs = double-driving (non-atomic claim → duplicate captures); and the SW defers whenever *any* localhost tab exists — even one without a live bridge, in which case **nothing drives captures at all**. Narrow to ports 3456-3465 (or remove bridge driving, see D).
- **B11** `extension/background.js:4,136` — offline queue holds full screenshot data-URLs, `chrome.storage.local` is ~10 MB, no `unlimitedStorage`; quota failure is swallowed by an empty catch → **captures silently vanish**. Add `unlimitedStorage` or queue without image payloads.
- **B12** `extension/background.js:6-7,695-700` — single-capture `pendingRequest` is in-memory and the 60s wait uses `setTimeout`; SW suspension after the request was already claimed from the app's mailbox loses the capture silently. Persist to `chrome.storage.session` (the batch path already has the right alarm+cursor pattern).
- **B13** `extension/background.js:26-31` used at `:131,687,734,762` — `normalizeUrl` strips query strings, so `youtube.com/watch?v=A` == `?v=B`: wrong-tab capture matches, queue dedupe deleting the wrong item, dead-report removing the wrong card. This is the exact class the repo's own FB retrospective warns about ("use clipKey, not normalizeUrl"); the fix landed app-side but not in these four background.js sites.

## C. MEDIUM/LOW BUGS (short list; see agent notes)

**Core**
- `db.js:227` `savedToRow` uses raw `item.id` for `img_file` (can be `undefined.jpg`) — the exact bug `cardToRow` was fixed for (`db.js:104-107`). Hoist `ensureId` above the img check.
- `backup.js:106-112,155` — same-day re-backup after deleting images never prunes files → verify count mismatch → "unverified" and rotation blocked until the next day.
- `config.js:28-31` — `config.json` (which holds the store pointer) is written non-atomically; a crash mid-write = app forgets where the library is and opens an empty store. Reuse sync's `_writeAtomic`.
- `sync.js:170` + `db.js:195-201` — merge-applied deletes re-stamp tombstones with `Date.now()`, so deletions look newer at every hop and can swallow a legitimate re-add. Pass the plan's `deletedAt` through.
- `db.js:54,126,251` — one corrupt `data` JSON row makes `GET /api/cards` throw for the whole library. Per-row try/catch.
- `server.js:205-208` — `GET /api/captures` clears the queue before delivery is confirmed; a renderer crash mid-response loses captures (and two clients would steal each other's).
- Error handling: routes without try/catch leak stack traces in 500 bodies; mixed `{ok:false}` / `{error}` shapes. Add one Express error middleware + one shape (matters for the phone client).

**Web**
- `index.html:3330` — batch capture stores `c.description`, UI reads `.desc`; fetched descriptions never display. One-line fix.
- `index.html:650` + inline `onclick` at 2529-2533 etc. — `esc()` doesn't escape quotes; an apostrophe in a tag breaks the handler. Long-term fix is data-attributes + event delegation.
- `index.html:2952+` — per-card actions use array indices while timers splice the array; clicks can hit the wrong card. Use card ids.
- `index.html:4102-4110` — dead-capture removal orphans image files; undo holds only the last card.
- Low: `stumbleSave` missing likes cap; `parseItems` id collisions; `openLink` doesn't skip `javascript:`; `splitCsv` mishandles doubled quotes (correct version already exists in `import-google-saved.js:6-16`); `ingestImported` silently truncates at 10,000.

**Extension**
- Bridge `pullCaptures` snapshot-then-clearAll wipes captures queued during flush; two uncoordinated flushers race.
- Batch loop counts a `"busy"` render outcome as done — card silently skipped; closed-tab `tabs.get` throw leaves card pending with no attempt mark.
- SW-suspension leaks capture tabs (`batchTabs` in-memory only).
- `force` flag dropped on the bridge path — "Recapture (overwrite)" via a localhost tab silently doesn't overwrite; IG pacing/429 backoff exist only in the SW driver.
- `FB_CAP_VERSION = "4.34"` vs manifest 4.45 — the diagnostic stamp the retrospective calls essential now lies.

## D. GUI / FEATURE CONSOLIDATION

**D1 — Capture/enrich: 6+ entry points → 1 panel (HIGH).**
"Capture missing", "Capture Facebook", "Auto-capture all", "Auto-capture in tabs", Select→Recapture, Select→Fetch info(broken), per-card ⟳, "Enrich", capture-on-open. To the user these are all "get pictures & info for my cards."
→ One **"📷 Get pictures & info"** button opening a panel with per-bucket counts (never tried / Facebook / failed / placeholders / missing descriptions) and one Start that runs the right pipeline per bucket sequentially. Keep per-card ⟳ and Select→Recapture as manual overrides. Delete "Fetch info".

**D2 — Library health: 6 janitor tools → 1 modal (HIGH).**
"Fix placeholders", failures dropdown, "Couldn't capture" filter, "Groom link-less", "Scan duplicates", "Check links" — three of these describe overlapping card sets with different mechanics.
→ One **"🩺 Library health"** button → single tabbed review modal (Duplicates | Dead & unsafe | Failed captures | No link), reusing the three already-near-identical modal skeletons. Placeholder-fixing becomes silent maintenance inside the capture pipeline (it already auto-runs in `startFbCapture`).

**D3 — Backup & restore: collapse surfaces (MEDIUM).**
Four buttons call the same `doBackup`/`connectFolder` (Back up now, Ctrl+Shift+B, Notion-section "Connect app folder", durability-panel "Connect folder"). The durability panel still reports browser-storage quota (irrelevant since SQLite). The file-input restore is broken (A1). The "Notion & Jarvis bridge" section is a no-op (`writeSavesFile` is an empty stub called from ~25 sites).
→ One Backup section: status line, Back up now, auto-backup schedule, restore list, "Import legacy backup…". Delete Notion/Jarvis section, browser-quota rows, file-input restore.

**D4 — AI profile tools: 3 → 1 (MEDIUM).** "Suggest interest categories" + "Analyze my library" + "Suggest categories" confuse three taxonomies (interests / categories / tags). Merge the first two into one "Build my profile" flow; rename to clarify categories = feed sections, tags = imported organization.

**D5 — Extension vs app: pick one owner per job (HIGH).**
- **Dead-link detection exists 3×**: extension auto-*removal* (no review, passive browsing, needs `webRequest` + all-urls listener) vs Core `linkcheck` (conservative, SSRF-guarded, review modal) vs `contentcheck`. → Drop the extension's auto-removal (or downgrade to "flag for Groom"); **remove the `webRequest` permission**.
- **og:image capture exists 2×**: Core `capturemeta` vs extension. Extension is only genuinely needed where cookies/rendering matter (FB/IG, screenshots); route generic bookmark og-capture to the app.
- **Two batch drivers**: the SW driver (v4.40+) is force-aware, Stop-safe, 429-paced; bridge.js's driver is worse on every axis (B9, B10). → Strip bridge.js to a ping; let the SW drive in both modes. Deletes an entire class of races.

**D6 — Misc UX (from the design pass).**
- Stale trust copy: "Everything is stored locally in your browser" (`index.html:337`) is false since the Core migration — say "on this computer in the app's data folder."
- Inconsistent save model: most settings autosave, some need "Save settings" (which also navigates to Feed). Make everything autosave.
- Esc/close inconsistencies across the four modals; three different Close-button placements.
- Destructive-action asymmetry: card ✕ deletes instantly with no confirm/undo, while other paths confirm or have undo. Adopt a universal undo-toast.
- Hidden power features (paste-to-card, 1×1-only tag editing, Ctrl+Shift+B) are documented only in tooltips.

## E. CODE TIGHTENING

**Core**
- Extract `core/guardedfetch.js`: the SSRF-guarded fetch (AbortController+timeout, per-hop `safeToFetch` redirect loop, drain-don't-cancel capped reader) is implemented 3× (`linkcheck`, `contentcheck`, `capturemeta`) — the undici-crash workaround exists twice. Also 3 hand-rolled worker pools and 3 UA strings.
- `_stable` stringify duplicated in `db.js:48-52` and `merge.js:7-11` — these MUST stay in lockstep (content signatures) — single source.
- One `jsonKvEndpoints()` helper for the 3 copy-pasted GET/POST kv route pairs; JSON error middleware; dedupe imports in server.js; rename side-effecting getter `getSyncConfig` → `ensureSyncConfig`; fix `copyByeId` typo; consolidate `window.ia`/`window.app` to one preload name.

**Web (biggest wins)**
- `callAI(prompt)` — the provider dispatch object is copy-pasted **10×**; the no-key guard ~9× in 4 phrasings.
- `parseJsonArray(text)` — the ```json-strip + bracket-slice + parse block is copy-pasted 6×.
- One parameterized `dispatchCaptureBatch(cards, {cap, flags})` — 4 near-identical batch dispatchers (~150 lines, already drifting).
- One `canonicalUrl(url, {keepId})` — 4 URL canonicalizers; duplicate-scan and clip-dedupe currently disagree about YouTube shorts.
- One `removeCards(ids, scope)` — the "if idb → imgDel + fpDel" cleanup loop exists 4×.
- Dead code to delete: `collectBackupMeta`, `downloadJSON`, `markBackupDone`, `restoreFromDir`, `_refreshTabs`/`closeRefreshTab`, `writeSavesFile` + its ~25 call sites, `initImageStore`, `BACKUP_SKIP`, `viewFailures`.
- Unify the `.img` (imported) vs `.image` (saved) field split — root cause of conditional noise in 5+ places; do it before the iPhone app freezes the schema.

**Extension**
- Delete dead: `manualCapture` handler + orphaned popup CSS, `clipFacebookPost` alias, bridge `postCapture`/`IA_BRIDGE`, `deliverDead` wrapper.
- One port probe (SW can `importScripts("bridge-probe.js")`) instead of 3 implementations.
- Extract `buildClipInfo(post)` from the near-duplicate blocks in capture-core.js; unify the two `lockedCaptureVisible` copies (keep the 8s timeout); consolidate the doubled `onInstalled`/`onStartup` listeners.
- Delete 20 stale `*.tmp.*` files in `extension/` (they ship if the folder is zipped/loaded unpacked).

**Repo hygiene**
- Delete `package.json.tmp.11972.*`, `package.json.tmp.24376.*`, `tests/storage-url.test.js.tmp.*`; move root-level one-off import files (`facebook-import.json`, `facebook-saves.txt`, `pinterest-import.json`, `youtube-import.json`) out of the repo root or into `_recovery/`.

## F. ARCHITECTURE — the single-file web UI

`web/index.html` is 4,399 lines, ~200 top-level functions, ~40 mutable globals, HTML-string rendering with inline onclick. Most Section-B web bugs are direct products of this shape (duplicated predicates drift, globals mutate under timers, quoting bugs in template literals).

The template to follow already exists in-repo: the six sibling modules (`storage.js`, `route-capture.js`, etc.) are pure, dual browser/Node, unit-tested. Recommended incremental split (plain `<script src>` tags, no bundler):
1. `web/lib/` pure modules — canonicalizers, dupe-scan, import parsers, prompt builders, capture-state predicates. **This is exactly the logic the iPhone app needs.**
2. `web/ai.js` — providers + `callAI` + `parseJsonArray`.
3. `web/capture.js` — drainCaptures, unified batch dispatcher, fb-auto loop.
4. `web/views/*.js` — feed/imported/settings/modals with data-attributes + event delegation.
5. Tiny `state.js` owning `imported/saved/S` with an awaited, error-toasting `mutate(fn)`.

## G. IPHONE SYNC READINESS

**Good news:** the persistence layer is genuinely sync-ready — stable SHA1-fallback ids, content-diffed per-record `updatedAt`, real delete tombstones, torn-write-rejecting snapshot protocol, and a pure I/O-free `merge.js` (76 lines) that ports cleanly. Unusually solid primitives for a hobby project.

**Gaps that must close before a phone writes data:**
1. **A5** — replace/guard full-array PUT; give clients `GET /api/cards?since=` + `GET /api/tombstones?since=` and make PATCH/DELETE the mobile write path (the DB already has everything needed).
2. **Transport** — the Dropbox sync depends on a synced *folder*, which doesn't exist on iOS. Recommended: **Option A — the phone becomes another sync peer via the Dropbox HTTP API** (`files/list_folder`/`download`/`upload` against `/Interests App/sync/<phoneId>/`), reusing the exact snapshot/meta-last protocol and porting `merge.js` (use `tests/merge.test.js` cases as Swift fixture tests). Zero new infrastructure; desktop unchanged. Mitigate cellular cost with Wi-Fi-only publish + gzip (~10×). Rejected: LAN-only sync (stale whenever away from home; requires real auth/TLS work), CloudKit (Windows desktop bridge = building a second sync engine).
3. **Auth** — loopback-only, zero-auth today; the Origin check passes any native client and any localhost page, and there's no Host check (DNS-rebinding readable today). Minimum: bearer/pairing token + Host allowlist before anything binds beyond loopback.
4. **Images** — base64-in-JSON upload, always-`image/jpeg` download, no enumeration endpoint (`listImageIds` exists but is unexposed), no thumbnails. Add binary GET/PUT with real content types, `GET /api/images` (ids+sizes), thumbnail generation.
5. **Settings** — `kv` excluded from sync entirely (backlog #5); machine-local keys (capture queue, store paths) must be separated from user settings before kv can sync.
6. **Clocks** — all conflict resolution is wall-clock LWW; a skewed phone clock silently wins/loses edits. At minimum clamp/flag future timestamps; fix the tombstone re-stamping bug (Section C, sync.js:170).
7. `pruneTombstones` exists but is never called — decide retention policy deliberately (forever is the safe default for an occasionally-offline phone).

## H. DATA-SAFETY NOTES (backup/restore)

- Same-day backups overwrite each other (`backup.js:96-106`) — a bad merge at 9am and 5pm leaves no pre-9am same-day state. Consider timestamped safety backups for the pre-merge path.
- Backup `meta.json` written non-atomically (fails safe — wasted backup, not loss).
- `restore` deletes live `images/` before overlaying (`backup.js:225`, non-atomic) — recoverable via safety snapshot; never expose restore to a remote client.
- Deferred idb upserts during sync re-defer forever if a peer's image never arrives — no surfaced status.

## I. TEST GAPS

Coverage is genuinely good (58 test files) — gaps map exactly to the shipped bugs:
1. Post-restore/post-move **HTTP** data-route requests (tests assert on `ctx.db` directly — why A3 shipped).
2. Restore failure mid-swap → service still serves.
3. `main.js` lifecycle (sync timers, runtime enable/disable) — extract to a testable module with injected config/clock.
4. `savedToRow` with id-less `idb:` item; same-day shrinking backup; tombstone timestamp propagation through `applyMerge`; corrupt `data` row; error-shape consistency.
5. Web UI has essentially no tests for index.html logic — the F-section extraction makes it testable.
6. Extension: a return-value test on content.js would have caught A4.

## J. RECOMMENDED PHASED PLAN

**Phase 1 — Stability (do first; small, surgical diffs + tests)**
A1–A5, B1–B13, plus the one-line mediums (`c.description`→`.desc`, `applyFilter` guard, `savedToRow` id, atomic `saveConfig`, tombstone `deletedAt` pass-through). Ship as v1.7.0.

**Phase 2 — Consolidation & deletion**
D1 (capture panel), D2 (Library health modal), D3 (backup section), D5 (extension: remove bridge driving + auto-dead-removal + webRequest permission), delete all dead code (E), repo hygiene. Ship as v1.8.0 — the app gets *smaller*.

**Phase 3 — Tightening & structure**
`guardedfetch.js`, `callAI`/`parseJsonArray`, `dispatchCaptureBatch`, `canonicalUrl`, `removeCards`, then the incremental index.html split (F), `.img`/`.image` unification.

**Phase 4 — iPhone-sync prep (desktop side, before any iOS code)**
Delta endpoints + tombstones-over-HTTP; retire full-array PUT from the renderer; pairing-token auth + Host check; image manifest + thumbnails + binary transfer; settings/kv separation; clock-skew guards. Then the iOS app starts as "another Dropbox sync peer."
