# Platform Auto-Import (FB + IG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saves made natively on Facebook/Instagram (from any device) flow into the app automatically: the desktop extension checks the user's saved pages daily (plus a manual "Check now"), the Core service ledger-dedups them, and new finds become imported cards through the existing capture pipeline. Spec: `docs/superpowers/specs/2026-07-17-platform-auto-import-design.md`.

**Architecture:** extension `chrome.alarms` daily scheduler → opens an inactive tab per enabled platform → injects a scraper content script (pure parser functions in `extension/lib/saved-parse-{fb,ig}.js`, dual browser/Node export for fixture tests) → POSTs the batch to `POST /api/auto-import` on the Core bridge → `core/autoimport.js` dedups against a kv platformKey ledger + existing library URLs, converts survivors into capture-mailbox entries tagged `source:"fb-auto"|"ig-auto"` → the renderer's existing `drainCaptures` turns them into imported cards with normal enrichment. Settings section (desktop-only) with master toggle (synced setting `autoImportOn`, **default OFF**), per-platform checkboxes, "Check now", per-platform status lines from kv `ia_autoimport_last_<platform>`.

**Tech Stack:** MV3 extension (vanilla JS), CommonJS core, plain Node assert tests.

## Global Constraints

- Auto-check ships **OFF by default** (`autoImportOn` falsy ⇒ the alarm handler no-ops); "Check now" works regardless.
- Deletions NEVER flow from platforms; a card deleted in the app must never re-import while its platformKey stays in the ledger. Un-save→re-save on the platform (key leaves the *scrape result*, then returns) re-imports only if the URL isn't in the library.
- Scrapers fail SOFT and NEVER deliver partial garbage: a login wall or a zero-entry parse on a loaded page reports a status, imports nothing.
- One check in flight max; one page visit per platform per run; scroll at most ~2 screens (~100 entries cap).
- All bridge input is untrusted: match `/api/captures`' pairing auth exactly; cap body 1MB, per-item field lengths (url 2048, title 512, image 65536 data-URL-or-URL, platformKey 128), max 200 items/batch.
- Signed-CDN images must go through the extension's existing `durableImage()` conversion before delivery.
- Suite green after every task; plain-Node fixture tests for parsers; no `pwa/**` changes (desktop-only feature — hide the Settings section on the PWA via the existing `window.IA_IDB` gate).
- Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; retry git on Dropbox lock errors.

---

### Task 1: FB + IG saved-page parsers (pure, fixture-tested)

**Files:** Create `extension/lib/saved-parse-fb.js`, `extension/lib/saved-parse-ig.js`, `tests/fixtures/fb-saved-sample.html`, `tests/fixtures/ig-saved-sample.html`, `tests/autoimport-fb-parse.test.js`, `tests/autoimport-ig-parse.test.js`.

**Interfaces (produces):** each module exports (dual pattern: `module.exports` + `self.IASavedParseFB`/`IASavedParseIG`):
- `parseSavedDoc(doc) -> { status: "ok"|"login-required"|"parse-failed", items: [{url, title, image, platformKey}] }`
  - `doc` is a Document (tests: parse the fixture via a minimal regex/DOM-lite walk — NO jsdom dependency; the parser must operate on `doc.querySelectorAll` when present OR on raw HTML string via its exported `parseSavedHtml(html)` twin, which is what tests exercise).
- FB recognition: anchors matching `facebook.com/(posts|reel|watch|photo|groups/.+/posts|permalink)` patterns inside the saved-items list region; `platformKey` = the post id parsed from the href; title = the entry's aria-label/heading text trimmed to 512.
- IG recognition: anchors matching `instagram.com/(p|reel)/<shortcode>` ; `platformKey` = shortcode.
- login-required detection: presence of login form markers (`name="login"`/`id="loginform"`/`action*="login"`) AND zero recognized entries.
- Fixtures: hand-built representative HTML (a saved-list container with 4-6 entries incl. one duplicate, junk anchors that must NOT match — profile links, hashtag links — and a login-page variant embedded as a second fixture block or file). Tests assert: extraction count, exact urls/keys, dedup within one parse, junk exclusion, login detection, `parse-failed` on a loaded page with zero entries + no login markers, caps (feed 300 anchors ⇒ ≤100 items).

TDD: fixtures + failing tests → implement → green → commit `feat(ext): FB/IG saved-page parsers (pure, fixture-tested)`.

---

### Task 2: Extension scheduler + delivery

**Files:** Modify `extension/background.js`, `extension/manifest.json` (add `alarms` permission; host perms for facebook.com/instagram.com if not present; register the two lib scripts as injectable), `extension/options.html/js` only if needed for nothing — config comes from the APP settings via the bridge. Create `tests/autoimport-ext-wiring.test.js` (source-scan, pattern of `bstumble-ext-bg.test.js`).

**Behavior (produces):**
- `chrome.alarms.create("ia-autoimport", { periodInMinutes: 1440, delayInMinutes: 30 })` registered on install/startup; handler ALSO triggered by a bridge poll: background polls `GET /api/auto-import/request` (piggyback on the existing capture-request polling loop — see `background.js` line ~547) so the app's "Check now" button works.
- Handler flow: `GET /api/auto-import/config` → `{on, platforms:{fb,ig}, lastRun}`; if alarm-triggered and `!on` ⇒ no-op. In-flight guard (module flag). Per enabled platform sequentially: `chrome.tabs.create({url, active:false})` → wait for complete → `chrome.scripting.executeScript` injecting the lib + a collector that scrolls twice (1s apart) then runs `parseSavedDoc(document)` → close tab → if `status!=="ok"` POST the status; else convert each item's image via the existing `durableImage()` → `POST /api/auto-import` `{platform, status, items, checkedAt}`.
- Wiring test asserts: alarm registration, in-flight guard, per-platform sequential loop, tab closed in a `finally`, durableImage applied, statuses posted on login-required/parse-failed, config gate for alarm-path only.

Commit `feat(ext): daily auto-import scheduler + saved-page delivery`.

---

### Task 3: Core endpoint + ledger + renderer drain compatibility

**Files:** Create `core/autoimport.js`, `tests/autoimport-core.test.js`, `tests/autoimport-endpoint.test.js`. Modify `core/server.js` (mount routes; same auth middleware as `/api/captures`).

**Interfaces (produces):**
- `core/autoimport.js` exports `processBatch(ctx, batch) -> {added, duplicates, status}`:
  - validates/caps every field (lengths above; reject non-array items, >200 items, unknown platform);
  - ledger: kv `ia_autoimport_seen_<platform>` = JSON object `{platformKey: firstSeenMs}` (cap 5000 keys, prune oldest);
  - skip item if platformKey in ledger OR normalized URL already exists in cards/saved (reuse the existing URL-normalization used by the importer/dedup — find it in `web/`? No: core-side normalize = lowercase host, strip hash + tracking params `utm_*, fbclid, igsh` — implement `normalizeUrl` in autoimport.js with unit tests);
  - survivors → append to the SAME capture mailbox `/api/captures` feeds from, shaped like extension captures with `source: "<platform>-auto"` so the renderer's `drainCaptures` ingests them unchanged (read `core/server.js`'s capture-store shape first and match it exactly);
  - always: ledger-add every seen platformKey (including duplicates), write kv `ia_autoimport_last_<platform>` = `{at, found, added, duplicates, status}`.
- Routes: `POST /api/auto-import` (extension→core, auth’d, 1MB cap) → processBatch; `GET /api/auto-import/config` (extension polls; reads settings kv `ia_settings`.autoImportOn/autoImportFb/autoImportIg — parse the stored JSON, default off/true/true); `POST /api/auto-import/request` (renderer "Check now" sets a request flag kv) + `GET /api/auto-import/request` (extension polls + clears — mirror the capture-request mailbox pattern); `GET /api/auto-import/status` (renderer reads the `ia_autoimport_last_*` records).
- Endpoint test: mounted `createServer()` on port 0 — auth rejection, oversized body 413/400, happy path adds to capture mailbox, ledger blocks the second POST, deleted-card URL (present as tombstoned/absent card but key in ledger) does NOT re-import, status records written.

Commit `feat(core): auto-import endpoint, platformKey ledger, capture-mailbox delivery`.

---

### Task 4: Settings UI + docs + release

**Files:** Modify `web/index.html` (Settings section + Check now + status rendering + the `autoImportOn/autoImportFb/autoImportIg` settings defaults), `pwa/index.html` (same markup, hidden via the existing `window.IA_IDB` desktop-only hide list — add the new section id), `docs/BACKLOG.md` entry. Create `tests/autoimport-ui-wiring.test.js` (source-scan: section exists, toggle writes settings via `save("settings",S)`, Check now POSTs the request, status line renders `ia_autoimport_last_*`, PWA hides the section). SHELL_CACHE bump (v28 → v29 — pwa/index.html changes).

Then: full suite; data-safety-reviewer over the diff (ledger semantics + untrusted input focus); electron-security-reviewer over extension+server diff (new bridge surface!); fix findings; version bump 1.12.23 → 1.12.24; push; verify release build + Pages deploy. Manual step for the user: reload the extension, run "Check now" with DevTools open on the FB/IG tabs, and we tune the parsers against the real pages (fixtures are best-effort until then — expect one live-tuning round).
