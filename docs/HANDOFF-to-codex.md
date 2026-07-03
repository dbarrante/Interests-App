# Interests App — Handoff to ChatGPT Codex (2026-07-03)

You are picking up an actively-developed desktop app. This document is self-contained: read it fully before touching code. The prior agent (Claude) built everything below; the owner (Dave) is **not a professional developer** — explain plainly, present options with a recommendation, and prefer safe/reversible changes.

---

## 1. What the app is

**Interests App** — an Electron desktop app that stores a personal library of "interest" cards (~6,600 cards / 141 saved / 5,722 images as of this writing) plus AI-recommended discovery. Data was originally browser-bound (localStorage + IndexedDB); it was rebuilt into a formal app so the library lives in one place, independent of any browser.

**Three moving parts:**
1. **Electron shell** (`main.js`, `preload.js`) — hosts a `BrowserWindow` that loads `http://127.0.0.1:<port>/`.
2. **Core service** (`core/*.js`) — a local **Express + `node:sqlite`** server (default port 3456, binds `127.0.0.1` only) that serves the web UI and a REST API. Images are files on disk, NOT in the DB.
3. **Web UI** (`web/index.html`, ~4,600 lines, single file) + pure sibling modules (`web/*.js`, `web/lib/*.js`) — the renderer, talks to Core over `fetch`.
4. **Chrome MV3 extension** (`extension/`, "Bookmark Spark", v4.48) — captures social posts into the app via the Core HTTP API. **Not part of the current work; leave at 4.48.**

---

## 2. Locations (absolute paths)

| Thing | Path |
|---|---|
| **Repo root** | `D:\Dropbox\Documents\Claude\Projects\Interests App` |
| **GitHub remote** | `https://github.com/dbarrante/Interests-App.git` (branch `master`) |
| Live data store | `C:\Users\dkbar\AppData\Roaming\Interests App\data\` (`interests.db` + `images\`) |
| App config (port, storePath, deviceId, sync) | `C:\Users\dkbar\AppData\Roaming\Interests App\config.json` |
| Backups | `D:\Dropbox\Interests App\backups\` (auto-detected Dropbox root) |
| **Built installers** | `C:\Users\dkbar\interests-dist\Interests-App-Setup-<ver>.exe` |
| iOS handoff spec | `docs/iphone-sync-design.md` |
| Backlog / changelog | `docs/BACKLOG.md` |
| Full code review (drove Phases 1–4) | `docs/full-review-2026-07-02.md` |
| Implementation plans | `docs/superpowers/plans/*.md` |
| SDD scratch (reports, gitignored) | `.superpowers/sdd/` |

**Note:** the repo lives inside Dropbox. Git occasionally hits a transient "unable to write new index file" lock — just retry the git command after a second. Build output was deliberately moved OUT of Dropbox (to `C:\Users\dkbar\interests-dist`) to avoid Defender/Dropbox interference.

---

## 3. How to run / build / test

```
cd "D:\Dropbox\Documents\Claude\Projects\Interests App"
npm start          # launches Electron (electron .)
npm test           # runs the full suite (node tests/run.js) — must print "ALL TEST FILES PASSED"
npm run dist       # electron-builder -> C:\Users\dkbar\interests-dist\Interests-App-Setup-<version>.exe (~101 MB, ~2-3 min)
```

- **Tests are plain Node scripts**, NOT vitest/jest. Each file is `node tests/<name>.test.js`, prints `N passed, M failed`, sets `process.exitCode`. `tests/run.js` auto-discovers `tests/*.test.js`. **Never use `process.exit()` in a test** (Windows undici `UV_HANDLE_CLOSING` crash — use `process.exitCode`).
- **`web/index.html` has NO unit harness.** It's verified by: (a) `node tests/syntax-check.js` (parses the inline `<script>` blocks + storage.js), (b) **source-assertion tests** (read the HTML as text, assert functions/patterns exist), and (c) careful code trace. This is the established pattern — follow it; don't invent a browser test rig.
- **Tests must not hit the real network/DNS.** They stub `global.fetch` and `linkcheck._setLookup(...)`.
- The app is Electron+Core, so there's no simple dev-server preview. To verify live behavior, query the running Core: `curl http://127.0.0.1:3456/api/ping` (returns `{"app":"interests","version":"..."}`), `/api/store-location`, `/api/cards`, etc.

---

## 4. Architecture cheat-sheet

**Core modules (`core/`):**
- `server.js` — Express app; middleware order is load-bearing: **Host allowlist → Origin guard → dormant token → CSP → express.json → routes → 404 → JSON error middleware** (errors return `{ok:false,error:"internal"}`, never leak stacks).
- `db.js` — `node:sqlite` (`DatabaseSync`). Tables: `cards`, `saved`, `kv`, `fp`, `tombstones`. Card image field is `img`; saved is `image` (**wire format frozen — do not rename**; a phone client depends on it). Per-record `updatedAt` (content-diffed), real delete tombstones (kept forever), stable SHA1-fallback ids.
- `sync.js` + `merge.js` — Dropbox multi-device sync (per-device snapshot folder + `meta.json`-written-last completion marker; pure I/O-free `mergeSnapshots`/`applyMerge`). Off by default.
- `linkcheck.js` — **tier-1 dead-link check** (HTTP status: 404/410/451 + DNS = "dead"; social hosts "skipped"; else "alive"/"unknown"). SSRF-guarded (`safeToFetch`).
- `contentcheck.js` — **tier-2 soft-dead check** (fetches page body, `classifyContent` returns `{verdict, reason, signals}`; signals include `phrase:*`, `redirect-home`, `empty`, `challenge`). Decodes HTML entities before matching. Now also returns `ogImage`.
- `capturemeta.js` — server-side og:image/title extraction for "Get pictures & info". Has a 404-page gate (won't harvest og from a not-found page).
- `guardedfetch.js` — **single** SSRF-guarded fetch (AbortController+timeout, per-hop `safeToFetch` redirect loop, drain-don't-cancel capped reader = undici crash workaround). Used by all three checkers.
- `backup.js`, `images.js`, `config.js`, `synctimers.js`, `appctx.js`, `bookmarks.js`, `importer.js`, `safebrowse.js`.

**Web pure modules (share-with-iOS candidates, all dual browser/Node):**
- `web/storage.js` — the ONLY renderer↔Core API adapter (`Store.*` + `SE.*` endpoint builders).
- `web/ai.js` — `IA_AI`: one `callAI(prompt)` dispatcher over 6 providers, `hasAIKey()`, `parseJsonArray()`.
- `web/lib/urlkey.js` — 4 URL canonicalizers (`feedKey`/`normUrl`/`dupeKey`/`clipKey`).
- `web/lib/import-parsers.js` — FB/Pinterest/CSV import parsers + `dedupeImported`.
- `web/lib/capture-state.js` — pure card-state predicates (`needsCapture`, `needsRetry`, `fbMiss`, `isBadImg`, `titleMismatch`, …).
- `web/route-capture.js`, `web/profile-analyze.js`, `web/deadcheck-ai.js`, `web/import-instagram.js`, `web/import-google-saved.js`.

**Key REST endpoints** (all loopback-only): `/api/ping`, `/api/cards` (GET/PUT/PATCH/DELETE), `/api/saved`, `/api/img/:id`, `/api/images` (manifest), `/api/changes?since=` (delta), `/api/kv/:key`, `/api/check-links`, `/api/check-content`, `/api/capture-meta`, `/api/backup`, `/api/restore`, `/api/store-location`, `/api/sync/*`, `/api/pair-status`.

---

## 5. What has been accomplished (chronological)

The app was built, then hardened via a **4-agent code/design review** (`docs/full-review-2026-07-02.md`) that found 5 criticals + 13 highs. That produced four review-gated releases, ALL merged to master and pushed to GitHub:

- **v1.7.0** (stability) — fixed all 22 review findings, incl. two data-loss bugs (a boot-race that could wipe the Saved library; a stale-client full-array PUT that tombstoned freshly-synced cards → added an `asOf` watermark + a server-side mass-delete 409 guard requiring `{confirm:true}`) and a dead extension metadata pipeline (`content.js` missing `return`). Ext bumped 4.46.
- **v1.8.0** (consolidation) — 6 capture buttons → one "📷 Get pictures & info" panel; 6 janitor tools → one "🩺 Library health" tabbed modal; one honest Backup section; profile-tools merge. Extension shed its entire legacy bridge-driving layer + the `webRequest` permission + passive dead-link auto-removal. Ext 4.47.
- **v1.9.0** (tightening) — ~30 copy-pasted implementations collapsed into 6 tested modules (`guardedfetch`, `ai.js`, `urlkey`, `import-parsers`, `capture-state`, one batch-dispatcher spine); index.html shrank ~650 lines. Ext 4.48.
- **v1.10.0** (iPhone-sync prep, desktop-only) — delta API (`/api/changes`), Host-header allowlist (closes a real DNS-rebinding hole), dormant pairing-token auth scaffolding (server still binds 127.0.0.1 unconditionally), image manifest + sniffed content types, clock-skew snapshot guard, `fp` de-published from snapshots, and `docs/iphone-sync-design.md` (the iOS build spec).

**Then a run of feed-image bug fixes (v1.10.1 → v1.10.4)** — the Feed shows AI-recommended articles, but the AI hallucinates URLs. Each release closed a real, live-verified way that dead/wrong pages were slipping through:
- **1.10.1** — feed soft-404 filter wired (tier-2 content check) + "Open in browser" header button.
- **1.10.2** — removed `image.thum.io` (its free tier now serves an "Image not authorized / paid account" ERROR IMAGE at HTTP 200, defeating `onerror`); feed now uses the page's real `og:image`; boot purges persisted thum.io URLs.
- **1.10.3** — catch creative HTTP-200 404 pages (makezine's "This is not the page you're looking for…"), raised text-scan cap 1500→4000; added a Help/About modal (`?` header button, shows running version from `/api/ping`).
- **1.10.4** — three live-verified gaps: (1) **HTML-entity decoding** (`you&#039;re` wasn't matched); (2) **bot-challenge pages** (Cloudflare 403 "Just a moment…") are KEPT but flagged `noshot` so no screenshot proxy is used; (3) **wrong-article detection** (`titleMismatch` predicate — a hallucinated URL that 200s into a *different* real article, e.g. a meal-prep URL serving "Braided Pesto Bread").

**Current master HEAD: `8040daa` (v1.10.4), synced with origin.** Installers for 1.10.0–1.10.4 are all in `C:\Users\dkbar\interests-dist\`.

---

## 6. IN-FLIGHT WORK — the pivot you're picking up

**The owner concluded the Feed is fundamentally broken:** the AI invents article URLs that mostly don't exist, and honest validation just filters the feed down to nothing ("Every card in the feed is 404"). **Decision: remove the Feed module; make Stumble the primary discovery surface, dealing 1 / 2 / 4 validated cards at a time from a spool.**

**State:** a Claude agent began this on a branch `v1.11.0-stumble-first`, but the partial work was **DISCARDED at the owner's request** — that branch is deleted and master is clean at `8040daa` (v1.10.4). **You start this pivot from scratch, from the spec below.** Nothing partial remains to reconcile.

**The spec Claude was working to (`v1.11.0`):**

**A. Remove Feed:**
- Remove: Feed tab button, `view-feed` div, `renderFeed`, `refreshFeed`, feed-only empty states, the `feed` global + its `load/save("feed")` persistence. Boot: one-time `save("feed",[])` to clear stored kv.
- **KEEP everything shared:** categories/importance system (Settings sliders → `buildPrompt`; relabel UI "feed sections" → "interest categories"), `applyFilter` (used by the SAVED tab — verify), `dropAlreadySaved`, `parseItems`, `validateItems` + `rankFilter` (now serve Stumble), `shown` history, save flows.
- `showTab`/boot default → "stumble" (map a persisted `"feed"` tab value to `"stumble"`). Repoint the header "⟳ New ideas" button to refill the stumble spool (keep its id/label).
- Grep-zero sweep for removed symbols (renderFeed, refreshFeed, view-feed, `curTab==="feed"`, feed global) incl. inline onclick strings; update Help/About tour copy + Settings copy that says "Feed".

**B. Stumble deals 1/2/4:**
- Deal-size selector (toggle 1/2/4), persisted (`save("stsize")`), default 1.
- **Validated spool:** one AI call over-fetches ~12 candidates (reuse `buildPrompt("stumble")`) → `dropAlreadySaved` → `validateItems` → `rankFilter` → survivors into `spool` (global already exists). Deal N per "Next"; auto-refill when `spool.length < N` (with the existing "Thinking…" spinner); **cap refill attempts at 2** per deal so a bad AI day shows "couldn't find enough live ideas — try again" instead of looping.
- Layout: 1 = single card; 2 = side-by-side; 4 = 2×2 (reuse existing card markup/grid CSS).
- Per-card Save + "Not for me" in every size; acting on one card replaces just that card (deal a single replacement), not the whole set. Keep `stumbleVote` learning; restructure the single-`stCur` assumption into a dealt-cards array, persisted like `stCur` was.
- `noshot`/og-image behavior from v1.10.4 must carry over (stumble cards render through the same `imageChain`/`cardHTML` machinery — verify).

**C. Ship:** update `tests/feed-validate.test.js` (refreshFeed is gone → repoint assertions to the stumble refill path; keep the tier-2 validation assertions); grep all tests for feed/renderFeed/refreshFeed; syntax gate + full `npm test` green; `docs/BACKLOG.md` v1.11.0 entry; `package.json` → 1.11.0; commit `feat!: remove Feed; Stumble deals 1/2/4 validated cards (v1.11.0)`.

---

## 7. Critical design recommendations

1. **Validation is the moat, not the enemy.** The Feed felt broken because validation correctly rejects hallucinated URLs. Stumble-from-a-validated-spool is the right shape: over-fetch candidates, validate, only ever show survivors. Keep the full v1.10.4 pipeline (linkcheck → contentcheck with entity-decode + challenge + titleMismatch). Consider asking the AI to prefer *homepage/section URLs* (which exist) over deep article URLs (which it invents) — this is the single highest-leverage improvement to candidate survival rate.
2. **The `img`/`image` wire format is FROZEN.** A future iPhone app and v1.9.0+ desktop peers depend on it. Renderer-side accessors (`itemImg`/`setItemImg`) exist to hide the split; do NOT rename the persisted fields or DB columns.
3. **Data-safety invariants — never regress these:** (a) full-array `PUT /api/cards` is guarded by `asOf` + a mass-delete 409; user-reviewed bulk removals pass `{confirm:true}`; (b) nothing writes before the renderer's `_booted` flag is set (boot-race protection); (c) tombstones are kept forever (an offline phone peer makes TTL unsafe). Use `persistCards()` in the renderer, never a bare fire-and-forget `Store.putCards`.
4. **Third-party image/screenshot services rot.** thum.io went paid-and-hostile (returns an error image at HTTP 200). Prefer the page's own `og:image` (already wired). `mshots` (WordPress) is the only remaining screenshot fallback; treat any new proxy as a liability.
5. **Loopback-only + Host allowlist is the security posture.** Server binds `127.0.0.1`. The pairing-token/LAN scaffolding is DORMANT (flipping `lanEnabled` does NOT change the bind — that needs deliberate bind+TLS+pairing work). Don't casually expose it.
6. **iOS app is the specced next-big-thing** (`docs/iphone-sync-design.md`): the phone is another Dropbox-HTTP-API sync peer reusing `merge.js`; desktop delta API + image manifest are ready. Open items there: settings/kv sync split, thumbnails, binary image upload.

---

## 8. Methodology that worked (recommended)

- **Systematic debugging over guessing.** Every feed fix was found by querying the RUNNING service and probing the exact failing URL with `curl`, reading the real HTML — not by pattern-matching symptoms. Reproduce → root-cause → minimal fix → regression test. (This repeatedly beat guessing; e.g. the entity-decode bug was invisible until we saw `you&#039;re` in the live title.)
- **TDD where a harness reaches:** write the failing test first (RED), then fix (GREEN). Pure modules (`core/*`, `web/lib/*`) get real tests; index.html gets source-assertion tests + the syntax gate.
- **Every finding gets a regression test pinning the REAL case** (real titles, real URLs in comments) so the same site can't regress silently.
- **Small, single-purpose commits** with a root-cause explanation in the message; branch → commit → `git merge --ff-only master` → push → `npm run dist`. Bump `package.json` per user-facing change so installer filenames are distinct.
- **Verify the release-gate suite yourself.** A prior release agent once falsely claimed "suite green" while a brittle fixed-window source-assertion was actually failing. Run `npm test` and read the last line (`ALL TEST FILES PASSED`) before shipping.
- **Renderer changes are risk-prone** (4,600-line file, inline onclick handlers, mutable globals, async timers). When removing a symbol, grep-to-zero including inside onclick strings — the syntax gate can't catch an undefined-reference runtime error (a real bug shipped this way: a half-converted `call()` → `ReferenceError` that a try/catch swallowed).
- **The owner ships installers and reloads the extension himself.** After any renderer/feed change, remind him: install the new `.exe`, click **?** to confirm the version, and (for feed changes) hit **⟳ New ideas** — the current feed was generated by the old code and must be regenerated.

---

## 9. Immediate next actions for you (Codex)

1. `cd` to the repo; `git checkout v1.11.0-stumble-first`; decide whether to keep or discard the uncommitted `web/index.html` (inspect `git diff` first).
2. Implement the §6 spec (remove Feed, build Stumble 1/2/4 from a validated spool).
3. `node tests/syntax-check.js` + `npm test` → must be `ALL TEST FILES PASSED`.
4. Bump `package.json` to 1.11.0, update `docs/BACKLOG.md`, commit, `git merge --ff-only` into master, `git push`, `npm run dist`.
5. Tell Dave: install `Interests-App-Setup-1.11.0.exe`, verify via the **?** button, and that Feed is now Stumble.
