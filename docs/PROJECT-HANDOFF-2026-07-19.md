# Interests App — Full Project Handoff & Code-Review Brief

*Written 2026-07-19 as a retiring-engineer handoff. Repo tip: `822c305`
(v1.12.30). 714 commits, 11 release tags, 123 test files. This document is
the single thing to read before touching the code.*

---

## 1. What this application is

An **AI-powered personal discovery feed** — "a smart Pinterest/Facebook feed
that learns your taste." The user sets an interest profile and importance
sliders; a chosen AI provider web-searches for real articles/projects/tools
matched to them and writes a short "why for you" per card. The user saves
keepers (teaches the feed) or dismisses (also teaches it). A **Stumble** tab
is StumbleUpon reborn (one serendipitous page at a time). Content the user
already saved natively on Facebook, Instagram, Pinterest, and Google is
pulled in automatically ("platform auto-import").

Single user. Privacy-first: API keys live locally and are sent only to the
user's chosen AI provider (plus, when Dropbox sync is on, into the user's own
Dropbox). No third-party backend of ours exists.

---

## 2. The three deployment surfaces (read this carefully — it explains the repo)

The same product ships **three ways**, which is the single most important
thing to understand about the codebase:

1. **Plain browser app** — `web/index.html` opened by double-click. ~5,500
   lines: ALL html + css + js in one file, on purpose, so it works with zero
   tooling. Talks to storage through `web/storage.js`.

2. **Electron desktop app** — `main.js` boots an **Electron shell** + a
   bundled **Node/Express "Core service" on `localhost:3456`** (`core/`) with
   **SQLite** (Node's built-in `node:sqlite`, no native module) for
   cards/saved/kv/fp + image files on disk. The Electron window loads
   `web/index.html` from the Core service; `web/storage.js` swaps its
   localStorage/IndexedDB calls for HTTP calls to the Core REST API. This is
   the primary, most-capable surface. It bundles the Chrome extension's
   delivery path and the whole `core/` backend.

3. **PWA (iPad/iPhone/web)** — `pwa/index.html` (~5,600 lines), a **near-clone
   of `web/index.html`**, deployed to GitHub Pages, syncing through the user's
   Dropbox. No local server there — it uses IndexedDB (`pwa/idb.js`) and
   Dropbox directly (`pwa/oauth.js`, `pwa/sync-pwa.js`).

**web/ and pwa/ are deliberate mirrors.** Many `.js` files exist in both
(`route-capture.js`, `ai.js`, `lib/capture-state.js`, `lib/import-parsers.js`,
`lib/urlkey.js`, `import-*.js`, `profile-analyze.js`) and MUST stay
byte-identical or behavior-identical. Tests enforce this parity (e.g.
`pill-style-parity.test.js`, and every `autoimport-*-wiring` test runs its
assertions over BOTH `web` and `pwa` sources). **When you change one, change
the other**, or a parity test fails.

The desktop shell CANNOT see `pwa/` at all (electron-builder `files` config
bundles `web/`, not `pwa/`). The PWA is served only from GitHub Pages.

---

## 3. Directory map

```
main.js / preload.js         Electron shell + IPC bridge
core/                        The localhost Core service (CommonJS, Node-require'able)
  server.js       (811)      Express app: ALL REST routes (createServer(ctx) factory, no listen)
  db.js           (505)      node:sqlite schema + card/saved/kv/fp/tombstone ops, SCHEMA_VERSION
  sync.js         (353)      Dropbox snapshot read/merge/apply (LWW), image copy, watermarks
  syncworker.js /  synctimers.js   sync runs OFF the main thread (worker façade) + timers
  merge.js        (150)      pure merge helpers (settings LWW, content signature) — mirrored to pwa/merge.js
  autoimport.js   (254)      FB/IG/Pinterest/Google saved-import: validate/cap/ledger/queue
  backup.js       (325)      Dropbox backups: runBackup, rotate(keep>=3), restore, moveStore
  config.js       (262)      %APPDATA% config.json pointer, store-safety guards, lastcounts sidecar
  images.js       (136)      image files on disk (data/images/<id>.jpg); DB stores a POINTER only
  capturemeta / contentcheck / linkcheck / safebrowse / guardedfetch / news / bookmarks / importer
  appctx.js / undici-guard.js
web/                         Browser + Electron-window UI
  index.html      (5501)     EVERYTHING (html/css/js) — single file
  storage.js      (207)      the storage adapter: HTTP (desktop) vs local (browser)
  ai.js           (198)      the ONE AI provider dispatcher (IA_AI): Anthropic/OpenAI/Gemini/Groq/Local + creditsMessage
  route-capture.js (61)      PURE decision fn: what does an incoming capture become? (linchpin — see §6)
  lib/            capture-state.js, import-parsers.js, urlkey.js (pure, Node-testable, mirrored to pwa/lib)
pwa/                         PWA clone (see §2) + Dropbox: oauth.js, sync-pwa.js, storage-pwa.js, idb.js, sw.js
extension/                   MV3 Chrome capture + auto-import scraper
  background.js   (1571)     service worker: capture delivery, browser-stumble, auto-import scheduler
  capture-core.js / capture-configs.js / content.js / overlay.js
  lib/saved-parse-{fb,ig,pin,gs}.js   PURE saved-page parsers (raw HTML -> items) — see §7
  manifest.json
tests/                       123 plain-node-assert files; run.js runs the syntax gate + all *.test.js
docs/superpowers/specs/      44 design docs (one per feature)
docs/superpowers/plans/      45 implementation plans (bite-sized TDD steps)
docs/BACKLOG.md              running feature log, newest on top — the best change-history narrative
.claude/agents/              data-safety-reviewer, electron-security-reviewer (subagent review gates)
.claude/skills/project-conventions   house rules (also summarized in §9)
CLAUDE.md                    project instructions loaded into every AI session
```

---

## 4. Storage & data model

- **Cards** (feed/imported items) and **Saved** items are the two record
  types, plus a **kv** table (all app settings/state under `ia_*` keys) and
  **fp** (fingerprints for dedup) and **tombstones** (deletion records for
  sync).
- **Browser/PWA:** localStorage `ia_*` keys + IndexedDB (`ia_fs` handle in
  browser; full store in PWA `idb.js`).
- **Desktop:** SQLite at `<store>/interests.db`; **images are files on disk**
  at `<store>/images/<id>.jpg` — the DB stores a POINTER (`idb:<id>`), NEVER
  the bytes. (Inlining thousands of base64 images into one JS string hit the
  ~512 MB string limit and crashed render + backup before. Do not do it.)
- **Store location:** desktop default `<install>/data`, relocatable in
  Settings; the pointer lives in `%APPDATA%/Interests App/config.json` so it
  survives reinstalls. Backups go to `<Dropbox>/Interests App/backups/`.

---

## 5. Sync (Dropbox) — the highest-risk subsystem

Cross-device sync is via the **user's own Dropbox** (`/Interests App/sync/`),
last-writer-wins on `updatedAt` per row, tombstones for deletes. Key facts a
reviewer MUST hold:

- Sync runs **off the main thread** (worker façade `syncworker.js`) — a
  synchronous merge on the main process froze every Electron window (fixed
  v1.12.25). One cycle at a time.
- **Peer-skip / publish-skip optimization** (v1.12.23): `meta.json`
  (written LAST, the torn-write completion marker) + a cheap content
  signature skip unchanged peers/publishes. Watermarks advance ONLY after a
  fully clean cycle, so any deferral re-reads next cycle.
- **asOf staleness-preserve reconcile** (data-safety HIGH invariant):
  `replaceCards`/`replaceSaved` RETURN rows they kept via the asOf branch; PUT
  responses carry `preserved`; the renderer folds them back into live state
  BEFORE advancing `_asOf`. Without this, a background/worker merge racing a
  renderer persist deletes a just-merged row. **Never advance `_asOf` without
  reconciling preserved rows.**
- **API keys sync** as plaintext inside the user's own Dropbox (user decision
  2026-07-16). The desktop `updateToken` (GitHub update credential) NEVER
  syncs — stripped on publish, preserved locally on apply.
- **Forward-compat:** `SCHEMA_VERSION` gate — a peer above our version is
  skipped, not mis-merged. Additive fields at the same version are safe.

---

## 6. Capture routing — the linchpin

Anything that becomes a card flows through `route-capture.js`'s pure
`routeCapture(cap, state)` → an action string. **Precedence is load-bearing:**
a `source` ending in `-auto` (platform auto-import) routes `import-auto`
BEFORE any clip/card-match/active-card branch, so an auto-import can never
false-stamp an open or matching card's image instead of becoming its own
Imported card. Auto-imports become **Imported**, never **Saved**. This is
covered by `route-capture.test.js` with explicit precedence cases; keep them
green.

---

## 7. Platform auto-import (the big recent feature — v1.12.26 → v1.12.30)

Saves the user made natively on **Facebook, Instagram, Pinterest, Google** are
pulled into the Imported tab without a manual export. Architecture:

- **Extension (`extension/background.js`)** runs a `chrome.alarms` alarm on a
  configurable interval (Settings "Check every": 1 day default → hourly) plus
  a 30s mailbox poll for the app's "Check now". Per run it opens each enabled
  platform's saved page in ONE inactive tab, injects the matching pure parser,
  scrolls (growth-based polling), parses, closes the tab, delivers.
- **Pure parsers `extension/lib/saved-parse-{fb,ig,pin,gs}.js`** — raw HTML
  string in, `{status, items:[{url,title,image,platformKey}]}` out. `status ∈
  ok | login-required | parse-failed`. **Scrapers fail SOFT**: a login wall or
  zero-entry parse reports a status and imports NOTHING — never partial
  garbage. `parseSavedDoc(doc)` just serializes `outerHTML` and delegates to
  `parseSavedHtml` so the DOM path and string path can't drift.
- **Core (`core/autoimport.js`)** validates/caps the untrusted batch (body
  ≤1MB, per-field caps), dedups against a **permanent per-platform
  `platformKey` ledger** (kv `ia_autoimport_seen_{fb,ig,pin,gs}`, capped 5000)
  AND same-URL-in-library, then appends survivors to the SAME
  `ia_capture_queue` the manual capture path feeds, tagged `source:
  "<p>-auto"`. **A ledgered key is permanent — deleting a card in the app
  blocks that post from re-importing forever, even if still saved on the
  platform.**
- **Delivery images:** ONLY genuine signed-CDN URLs (`isExpiringCdnImage`:
  scontent/cdninstagram/fbcdn) are credential-fetched and converted to durable
  thumbnails; every other `<img src>` is passed raw (a saved page is
  multi-author — credential-fetching an arbitrary URL would be an
  SSRF/tracking beacon). This is security-review finding F1; do not weaken it.

**Per-platform live facts (why the parsers look the way they do):**
- **FB:** each saved card = ~3 anchors to the same post (thumbnail/excerpt/
  byline) in anonymous divs, NO `<li>`; group cards use
  `/groups/<g>/permalink/<id>/` for the thumb+excerpt but `/posts/` for the
  byline; the notification bell's dropdown is in the DOM — `notif_id`/
  `notif_t`/`ref=notif` links are REJECTED (they imported "Unread X
  commented…" as saves).
- **IG:** API-FIRST — reads the complete paginated `/api/v1/feed/saved/posts/`
  from page context (DOM scrape is fallback); `instagram.com/saved/` is the
  PROFILE of a real account named @saved, so the scrape discovers the viewer's
  username and opens `/<username>/saved/all-posts/`.
- **Pinterest:** `/pin/<digits>` merge on numeric id; scrape `/me/pins/` with
  TWO home-feed guards (recommendation shelves must never import as saves).
- **Google:** scrape the flat `interests/saved/list/allsaves` (the bare
  `/save` is the collections overview, zero items); unwrap `google/url?q=`
  redirect wrappers to the external target; platformKey = normalized target
  URL (no stable id exists; over-length keys hashed).

---

## 8. AI providers

Five backends behind ONE dispatcher (`web/ai.js` `IA_AI`): Anthropic Claude,
OpenAI, Google Gemini (free tier, has web search), Groq (fast, no web search),
Local/Custom (OpenAI-compatible: Ollama/OpenRouter). Each returns raw text
parsed identically. `IA_AI.creditsMessage(err)` classifies out-of-credit
failures per provider for a specific user message. Keys stored locally, sent
only to the chosen provider.

---

## 9. Conventions & hard rules (the "house style")

**Zero tooling.** No bundler, no npm build, no framework. `web/index.html`
opens by double-click. Backend `core/` is CommonJS, directly `require()`-able.

**Tests are plain Node `assert` scripts** (no framework). `node tests/run.js`
runs a syntax gate (every inline `<script>` must parse) + all `tests/*.test.js`
as child processes. HTTP is tested by mounting `createServer()` on port 0 with
global `fetch`; pure logic by requiring the module. Parser tuning is
**capture-first**: parsers are written against real captured HTML in
`_livecapture/` (gitignored), validated by LIVE-replay tests that
`try{readFileSync}catch{return}` so they skip on machines without the capture.

**DATA-SAFETY HARD RULES (this project has lost data before):**
- Never lose user data. Backups verify counts before rotating (keep ≥3);
  destructive ops (dedup, groom, restore, store-move) snapshot first; the
  importer is READ-ONLY on its source; store-move keeps the old copy until the
  new verifies.
- **Never commit personal data.** Gitignored & hook-blocked: `saves.json`,
  `*-import.json`, `*.zip`, `interests-backup-*`, `_recovery/`, `data/`,
  `_livecapture/`. NEVER transcribe strings out of a capture into a committed
  test fixture — invent them (`.example` hosts). (This was a real near-miss,
  2026-07-19, caught pre-push by review.)
- Images are files; the DB stores a pointer. Never inline base64 en masse.

**Other conventions:**
- Any edit to an already-cached PWA file (`pwa/index.html`, any pwa `.js`, the
  manifest) REQUIRES bumping `SHELL_CACHE` in `pwa/sw.js`, or installed PWAs
  silently serve stale code.
- The installed Electron desktop app does NOT auto-update from `git pull` — it
  needs a version bump → CI release → reinstall (electron-updater handles the
  in-app path from v1.12.17+, but the FIRST install of any build is manual).
- Release = bump `package.json` version → push to master → GitHub Actions
  (`.github/workflows/release.yml`) builds the Windows installer + `latest.yml`;
  `deploy-pwa.yml` deploys `pwa/**` to Pages.
- Repo lives in a Dropbox folder: intermittent `.git` lock errors on commit
  are expected — retry. CRLF/LF warnings are expected and harmless (the pwa
  files are CRLF; the mirror scripts must account for it).
- Keep the GitHub repo private.

**Review gates:** after store/backup/import/restore changes, run the
**data-safety-reviewer** agent; after Electron/server/IPC/extension-bridge
changes, run the **electron-security-reviewer** agent.

---

## 10. Scars (incidents worth knowing before you trust your instincts)

- **2026-07-16 fleet data event:** killed test runs (no APPDATA isolation)
  poisoned the REAL `%APPDATA%/config.json`, pointing `storePath`/`backupDir`
  at `%TEMP%` fixtures; a later restart booted on a 2-card store and a PWA
  full-array persist re-stamped ~6,600 rows. Fixes: tests self-isolate
  APPDATA; a boot store-safety guard (temp-store / collapsed-counts →
  BLOCKING "Quit" dialog, never auto-heal); backupDir temp-poison rejection;
  PWA stamp-preserve. Forensics in `docs/superpowers/2026-07-17-incident-
  root-cause.md`.
- **The @saved trap:** `instagram.com/saved/` scraped a stranger's profile.
  Lesson generalized into landed-page guards on every scraper.
- **Sandbox-blind guard near-miss (2026-07-19):** the temp-path rejection
  guard, added for the incident above, redirected a *sandboxed test's* backup
  writes INTO the real Dropbox backups folder. Any core guard that rejects
  temp paths must first check `isTempPath(appDataDir())` and honor temp values
  when the app itself is sandboxed.
- **Fixture data leak (2026-07-19):** real Google-save strings were
  transcribed into a committed test; caught pre-push by review, purged via
  soft-reset. Hence the "never transcribe captures" rule above.

---

## 11. How to get oriented fast

1. Read `CLAUDE.md`, then `docs/BACKLOG.md` top-to-bottom (newest first) — it's
   the narrative of every feature and why.
2. `node tests/run.js` — should print `ALL TEST FILES PASSED`. This is the
   ground truth that the tree is healthy.
3. To understand any feature, find its spec in `docs/superpowers/specs/` and
   plan in `docs/superpowers/plans/` (dated filenames).
4. Start the desktop app: `npm start` (or `Start Interests App.bat`). The Core
   service comes up on `:3456`; `curl localhost:3456/api/ping` reports the
   running version.
5. The extension loads unpacked from `extension/` (`chrome://extensions` →
   Load unpacked). It talks to the Core service over `127.0.0.1:3456`.

---

## 12. Known-open / next candidates (from BACKLOG + this session)

- Stumble "out of credits" was shipped; broader provider-error classification
  could deepen.
- Sync-hardening leftovers from the 07-17 incident doc (mostly done; the
  phantom `updatedAt` re-stamp root-cause is documented-accepted).
- Auto-import: per-check tile windows are removed for IG (API) but FB still
  scrapes the DOM (~13 tiles/check); an FB API-first path is the natural
  follow-on if the user's save rate outpaces it.
- `AGENTS.md` at repo root is STALE (predates the Electron architecture) — a
  cleanup candidate; `.agents/`, `.codex/`, `_loopstate/` are untracked
  scratch.

---

## 13. Code-review focus areas (where bugs would hurt most)

1. **Anything touching sync/merge/asOf** — a wrong stamp or a skipped reconcile
   deletes data fleet-wide. Highest scrutiny.
2. **`core/autoimport.js` + the parsers** — untrusted, multi-author HTML;
   verify fail-soft, the SSRF image gate, ledger permanence, and that no
   recommendation/notification content can enter as a save.
3. **`route-capture.js` precedence** — a regression here misfiles captures.
4. **Backup/restore/store-move** — must snapshot before destroying, verify
   before rotating, never point at temp.
5. **web/pwa parity** — a fix applied to one surface but not the other is a
   silent divergence; parity tests catch style but not all logic.
