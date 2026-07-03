# Interests App — Backlog / To-Do

A running list of requested features and deferred items. Each entry has enough context to pick up cold
(brainstorm → spec → plan → build when started). Newest requests at the top.

## v1.9.0 tightening release (2026-07-03)

Phase 3 duplication-collapse and module-extraction pass across core, web, and extension, plus a
13-item deferred-minors sweep.

- [x] **T1** `core/guardedfetch.js` — three SSRF-fetch copies unified; undici drain workaround
  single-sourced.
- [x] **T2** core smalls — shared stable-stringify via `merge.js`, `jsonKvEndpoints` helper, JSON
  error middleware, read-only `getSyncConfig` + `ensureSyncConfig` at boot, `window.app` alias
  removed, `copyById` typo fixed.
- [x] **T3** `web/ai.js` — one AI dispatcher + `parseJsonArray` replace ~25 copies.
- [x] **T4** `web/lib/urlkey.js` — four URL canonicalizers unified, fuzz-verified.
- [x] **T5** `web/lib/import-parsers.js` + `capture-state.js` — parsers, 8 predicates,
  `ingestImported` pure/impure split; same-batch dedupe crash fixed post-review.
- [x] **T6** `dispatchCaptureBatch` spine — three extension-batch dispatchers unified; og-fetch path
  deliberately kept separate.
- [x] **T7** 13-item deferred-minors sweep — Esc unification, poller `flushQueue`, `saveConfig` tmp
  cleanup, stumble cap, `parseItems` ids, etc.

**Sanctioned behavior changes (four):** error bodies no longer leak stack traces; duplicate-scan
groups YouTube shorts like clip-dedupe; CSV titles with doubled quotes import correctly; unified
no-key message at most AI sites.

### Deferred (from v1.9.0 final review)

- [ ] `urlkey` garbage-input coercion test.
- [ ] `import-parsers` unconfigured-decode hard-assert.
- [ ] `kvSet`-move error-path note.
- [ ] Out-of-band-config-corruption `deviceId` edge in pure `getSyncConfig`.

**Also deferred:** `.img`/`.image` field unification to Phase 4 (iPhone schema work); web
views/state split is the next increment of the F-plan.

## v1.8.0 consolidation release (2026-07-02)

Phase 2 of the full-review pass in `docs/full-review-2026-07-02.md` (sections D1-D5, E): GUI
consolidation on the web side and simplification on the extension side. The app gets smaller —
fewer buttons, fewer permissions, less code.

- [x] **D1** — "Get pictures & info" capture panel replaces six capture/enrich buttons (Enrich,
  Capture missing, Capture Facebook, Auto-capture all, Auto-capture in tabs, Select-mode Fetch
  info). One panel shows per-bucket counts (never-tried, Facebook-needs-extension, failed/retry,
  missing descriptions); one Start button drains per-bucket sequentially with jittered pauses,
  capped at ~500 FB posts per Start; one Stop button aborts the whole sequence, not just the
  current stage.
- [x] **D2** — "Library health" modal replaces six janitor tools (Scan duplicates, Check links,
  Groom link-less, failed-captures dropdown, Couldn't-capture toggle, Fix placeholders) with one
  tabbed modal (Duplicates | Dead & unsafe | Failed captures | No link) sharing one `removeCards`
  helper (idb + fingerprint cleanup, `persistCards`, user-reviewed `{confirm:true}`, undo toast).
- [x] **D3** — Backup & restore consolidated into one section: status line, Back up now, auto-backup
  schedule, restore list, Import legacy backup. Removed the Notion/Jarvis bridge stub section and
  the browser-quota/persistence rows (meaningless since the SQLite move). Fixed: `ia_theme`
  legacy-restore routing, partial-restore toast wording, restore's `plan.skipped` count now shown.
- [x] **D4** — "Suggest interest categories" and "Analyze my library" merged into one "Build my
  profile" flow (optional free-text + library analysis, same chip/about-draft output). Taxonomy
  labels clarified in Settings copy (categories = feed sections, tags = imported organization,
  interests = profile). `persistCards` 409-regex unified with the global net matcher; net toast
  copy now write-verb-only so failed GETs don't toast "Saving failed"; dead `ogParse` removed.
- [x] **D5** — extension: the legacy bridge-driving layer (`bridge.js`, `bridge-probe.js`, localhost
  content-script injection, defer-to-app-tab branches) is deleted; the service-worker poller
  (`pollCaptureRequest`/`pollBatchState`) is now the only capture driver. Passive dead-link
  auto-removal (the `chrome.webRequest` 404/410 listener) is retired and the `webRequest`
  permission dropped — dead links are found only by the app's review-based "Check links" sweep now.
  Instagram 429/rate-limit pages are now recognized by the blocked-page detector instead of being
  captured as a card image. Capture-claim persistence for single captures is now handled by the SW
  poller, surviving service-worker suspension.
- [x] **E** — dead code sweeps on both sides: extension (`manualCapture` handler, orphaned `.cap`
  CSS, `clipFacebookPost` alias, `deliverDead` wrapper, duplicated `lockedCaptureVisible` copies,
  doubled `onInstalled`/`onStartup` registrations, extracted `buildClipInfo`, stale capture-configs
  doc comment, `*.tmp.*` stray files) and web (`collectBackupMeta`, `downloadJSON`, `markBackupDone`,
  `restoreFromDir`, `initImageStore`, `BACKUP_SKIP`, `viewFailures` wrapper, `_refreshTabs`/
  `closeRefreshTab` no-ops).
- [x] **Repo hygiene** — deleted stray `package.json.tmp.*` and `tests/*.tmp.*` files; moved root-level
  `facebook-import.json`, `facebook-saves.txt`, `pinterest-import.json`, `youtube-import.json` into
  `_recovery/root-import-files/`.

**Retired in v1.8.0:** passive dead-link auto-removal (now only via the app's review-based Check
links sweep); the unbounded auto-capture loop (now a bounded drain-per-Start, capped ~500 FB posts);
the manual "Fix placeholders" button (placeholder fixing now runs automatically before FB capture
runs); browser-tab single-capture latency may now be up to ~30s (governed by the SW alarm cadence,
since the bridge's faster-but-racier path is gone).

### Deferred (from v1.8.0 final review)

- [ ] `pollCaptureRequest` re-entrancy guard for concurrent claims.
- [ ] `flushQueue` in `iaPollAll` for faster offline-queue delivery.
- [ ] Stale bridge comment in `background.js` ~line 759 (leftover reference to the deleted bridge
  layer).
- [ ] Triple-Esc-listener unification (web side).
- [ ] Web-side `backupCountsMatch` orphan (dead code left over from the D3 backup consolidation).
- [ ] `enrichImported`'s `#enrichBtn` guarded ref (button no longer exists post-D1; the guard should
  be removed with it).
- [ ] Double-delivery-after-suspension comment (extension SW).

## v1.7.0 stability release (2026-07-02)

Fixes from the full-review pass in `docs/full-review-2026-07-02.md` (four parallel review agents:
Core service, Web UI, Extension, Data-model/Sync-for-iPhone). All Phase-1 findings fixed and tested.

- [x] **A1** — legacy file-restore wrote to dead `localStorage` instead of the Core service; restore
  silently restored nothing but images.
- [x] **A2** — boot race: the capture-drain interval could fire before `bootData()` finished loading,
  triggering a full-replace `putSaved([one clip])` that could wipe the entire Saved library.
- [x] **A3** — `ctx.db`/`ctx.storeDir` went stale after a Restore or store Move because routes kept
  destructured locals instead of reading through `ctx`.
- [x] **A4** — extension `content.js`'s metadata IIFE was missing a `return`, making og:image/title/
  description extraction and the blocked-page/CAPTCHA detector dead code for every capture.
- [x] **A5** — full-array `PUT /api/cards` tombstoned any row missing from the payload; added an `asOf`
  guard and a mass-delete 409 so a stale renderer array can't wipe synced rows.
- [x] **B1** — restore mid-swap failure now reopens `ctx.db` on failure instead of leaving it closed.
- [x] **B2** — un-awaited `shell.openExternal()` rejections no longer crash-quit the app.
- [x] **B3** — sync enable/disable now takes effect without an app restart.
- [x] **B4** — Settings "clear" link fixed to actually clear imported data (was a dead localStorage key).
- [x] **B5** — persistence failures (`putCards`/`putSaved`/`kvSet`) are now surfaced via a toast instead
  of being silently fire-and-forget.
- [x] **B6** — "Fetch info" no longer calls the dead `allorigins` proxy.
- [x] **B7** — a stale/foreign `filterCat` after restore or sync no longer crashes the Feed/Saved render.
- [x] **B8** — "Select all shown" now uses the same filter predicate as the visible list, instead of
  drifting from it.
- [x] **B9/B10** — bridge batch driver no longer resurrects a cancelled ("Stop") batch, and bridge
  injection is narrowed off unrelated localhost ports.
- [x] **B11** — offline capture queue no longer silently drops captures on quota failure.
- [x] **B12** — pending single-capture requests survive service-worker suspension instead of being lost.
- [x] **B13** — capture/dedupe/dead-report matching now preserves query strings instead of collapsing
  distinct URLs together.
- [x] **M1/M3/M4/L1** — `savedToRow` id-less `idb:` item fix; atomic `config.json` write; tombstone
  `deletedAt` passed through end-to-end instead of re-stamped; per-row corrupt-JSON resilience in
  `db.js`; `c.description`/`.desc` display typo fixed.

### Deferred to backlog (from v1.7.0 reviews)

- [ ] `ia_theme` legacy-restore routing — same class as A1, lower stakes; not yet migrated off legacy
  storage.
- [ ] Partial-restore toast wording — clarify what was/wasn't restored when a restore partially fails.
- [ ] `plan.skipped` surfacing — sync merge plan's skipped items aren't shown anywhere.
- [ ] `ogParse` dead-code removal — leftover parsing path superseded by the A4 fix.
- [ ] `saveConfig` tmp-orphan on rename-throw — atomic write can leave a stray tmp file if rename throws.
- [ ] Ctrl+Shift+B pre-boot gate — guard the shortcut before boot/data load completes.
- [ ] `persistCards`/net 409-regex unification — the new A5 409 handling and existing net-error regexes
  should share one matcher.
- [ ] Global net toast copy on GET failures — align wording with the new persistence-failure toasts (B5).
- [ ] Bridge `saveState` GET→POST race + `reportDead` `normalizeUrl` asymmetry — both superseded by
  Phase 2 D5 bridge-driving removal; no standalone fix planned.
- [ ] Server-generated `asOf` (Phase 4) — client-supplied `asOf` is a stopgap until the server stamps it.
- [ ] `syncDirty` cleared-before-publish note — a narrow ordering edge case flagged during A5/B3 work;
  revisit once Phase 4 delta endpoints land.

## Requested 2026-06-30 (Dave)

- [x] **(1) BUG — feed showed nothing but 404s. FIXED v1.6.3 (commit pending rebuild).** Root cause:
  `validateItems` checked each AI-suggested URL through `api.allorigins.win` (now HTTP 500 / CORS-blocked
  from the app) and FAILED OPEN (returned "alive" on any proxy error) → zero filtering → every dead
  AI-hallucinated URL was shown. Fix: `validateItems` now uses the app's own `Store.checkLinks`
  (`/api/check-links`: server-side, SSRF-guarded, conservative) and drops ONLY confirmed-dead links
  (404/410/451/DNS); social hosts return `skipped`, unknown/alive are kept (live pages never hidden).
  Verified the Core probe live (example.com→alive, fake→404 dead, yt/ig/fb→skipped). `tests/feed-validate.test.js`.
- [ ] **(2) ENHANCEMENT — feed AI-recommends from interests & previous saves (the larger upgrade, NOT yet built).**
  The feed should **use AI to propose the most likely pages the user will want**, grounded in their
  **interests** (`S.interests` / `S.about`, populated by Analyze-my-library) **and previous saves** (Saved +
  Imported history). The feed already builds an AI prompt from `S.about`+`S.interests` (`buildPrompt` in
  `web/index.html`) and passes recent saves/likes/clicks; the upgrade is to weight prior saves more heavily
  and improve relevance/ranking. Brainstorm: have the AI suggest topics/queries → resolve to REAL pages
  (or suggest only from a live source) → still live-check before render (done in part 1) → rank by
  interest/saves overlap; consider caching validated suggestions so the feed isn't empty while checking.
  NOTE: hard-404 filtering is done (part 1); soft-404 (200-but-gone) detection in the feed could fold in
  the existing `/api/check-content` tier if needed.

- [ ] **Single-card "reader" view (full-page, one article at a time).** A page-sized view that shows ONE
  card at a time with **advance / retreat arrows** to move through the set, plus a **Remove card** button
  in the view. For focused reading/triage of one item at a time (vs. the grid). Open questions for
  brainstorm: which set does it page through (current filter/search result, or all Imported?); keyboard
  arrows too; what "remove" does (same backup-first delete as elsewhere); where the entry point lives.

- [ ] **"Open app in a browser session" button.** A button that opens the app in a real browser tab
  (the Core already serves the UI at `http://localhost:3456`). Note: when the app is open as a
  `localhost` Chrome tab, the extension's `bridge.js` content script runs there and can also drive
  capture — so this doubles as an alternate capture path. Brainstorm: open via `shell.openExternal`
  to the loopback URL; confirm the served UI works the same in a browser vs. the Electron window.

- [ ] **YouTube "Save" → auto-add the video to the app (integrate or confirm).** When you click **Save**
  on a YouTube video (add to a playlist / Watch Later), it should capture that video into the app
  automatically. **Likely already built** — the extension has a YouTube `saveTrigger` + `yt-save-trigger.js`
  (playlist-save, shipped ~v4.37): adding a video to any playlist fires a capture → Saved library.
  Action: **confirm it still works end-to-end** (reload ext, refresh a YouTube tab, Save a video to a
  playlist → check it lands in Saved with the real thumbnail); fix/extend if it doesn't.

## YouTube channel cards — decision needed

- [ ] **What to do with the 451 imported YouTube *channel* cards** (from a `youtube` subscriptions import;
  they open the creator's page, not a video). Options: (1) leave them (a followed channel is a valid
  interest signal); (2) give them a nicer picture (channel avatar/art via og:image instead of the current
  page screenshot); (3) replace with real videos by re-importing a video-bearing source (YouTube/Takeout
  watch-history / liked / playlists); (4) remove them. Real videos will also flow in going forward via the
  YouTube "Save" integration above.

## Deferred capture/UX niceties (offered, not yet built)

- [ ] **In-app Capture Log panel** (spec `2026-06-30-unified-sw-capture-driver-design.md`, Phase 3–4): a
  Settings view that tails the worker's capture trail (POST/GET `/api/log` ring buffer + SW mirroring),
  so capture issues are visible without DevTools / live queue grabbing.
- [ ] **Stuck-spinner timeout**: a per-card refresh that never lands should flip to "failed" after a
  timeout instead of spinning forever.
- [ ] **force on the localhost `bridge.js` batch path**: `bridge.js dispatch` doesn't pass `force`, so a
  Recapture run driven from a localhost browser tab won't overwrite good images (MINOR; the standalone
  app's SW driver already passes force).

## Older deferred (from earlier phases — see memory `interests-app-formal-app-phase.md`)

- [ ] **Notion connector**: token in Settings → Core fetches pages/databases → feed the profile analysis
  via the existing `extraSources` seam in `web/profile-analyze.js`.
- [ ] **Dropbox sync follow-ons (#5)**: settings-sync + content-addressed image pool (pays off once
  actively multi-device syncing).
- [ ] **Bounded scheduled extraction (#6)**: hands-off periodic capture from social saved lists
  (ToS/rate-limit caveats; must stay bounded + stoppable).
