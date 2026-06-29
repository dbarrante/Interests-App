# Link safety checks via Google Safe Browsing

**Date:** 2026-06-29
**Status:** Approved (design); Phase 1 ready for implementation plan
**Author:** Dave + Claude

## Problem

NordVPN Threat Protection blocks the Interests App's outbound traffic, so the user runs with
it off. Their normal browser still has Google Safe Browsing built in (so `shell.openExternal`
opens are protected), but two gaps remain:
1. The **in-app "reuse window" viewer** ([web/index.html:784](../../../web/index.html), main.js `ia:open-in-app`)
   is a bare Electron `BrowserWindow` with **no** Safe Browsing — opening a malicious link there is unprotected.
2. There is **no proactive way** to find out that a *saved* link has turned malicious/phishing.

PageRank is not a fit (it measures popularity, not safety, and its API is discontinued). The right
tool is a threat blocklist; the chosen source is **Google Safe Browsing** — the same list Chrome uses.

## Solution overview

A shared, server-side URL-safety checker (`core/safebrowse.js` + `POST /api/check-safety`) with two
thin consumers, built in two phases:

- **Phase 1 (this spec's build scope): Library scan** — a "Check link safety" sweep that flags saved
  links Google reports as dangerous, into a review modal, mirroring the existing dead-link sweep.
- **Phase 2 (documented here, built next as its own spec/plan): Open-time check** — before a link
  opens, check it; if flagged, show a Chrome-style block-with-override warning.

Running the check in the Core (not the renderer) avoids browser cross-origin issues and keeps the
Google API key in one place. Free tier (10,000 requests/day, 500 URLs/request) dwarfs the user's
library (~7,400 links ≈ 15 batched requests).

## Components

### Shared core: `core/safebrowse.js` (new)

Pure, independently testable functions plus one network call:

- `buildLookupBody(urls: string[], clientId?, clientVersion?) -> object` — pure. Builds the Safe
  Browsing v4 `threatMatches:find` request body: `threatTypes` =
  `["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE","POTENTIALLY_HARMFUL_APPLICATION"]`,
  `platformTypes:["ANY_PLATFORM"]`, `threatEntryTypes:["URL"]`, `threatEntries:[{url}, …]`.
- `parseLookupResponse(json) -> { [url]: threatType }` — pure. Maps each matched URL to its
  `threatType`; URLs with no match are absent (= safe). Tolerant of `{}`/missing `matches`.
- `checkUrls(urls: string[], apiKey: string, opts?) -> Promise<{url, threat}[]>` — batches urls into
  groups of ≤500, POSTs each to
  `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=<apiKey>` (fixed host — no SSRF
  surface), merges results; `threat` is the threat type string or `null` (safe). On a network/HTTP
  error for a batch, that batch's urls return `{threat:null, error:true}` (fail-open — never
  false-flag on an API failure). Timeout via `AbortController`.

### Shared core: endpoint `POST /api/check-safety` (in `core/server.js`)

- Body `{ items:[{id,url}] }`; items capped at 500.
- Reads the Safe Browsing key from config (see below). If no key set → `200 { error:"no_key", results:[] }`
  (renderer shows a "set your key in Settings" hint, never an exception).
- Returns `{ results:[{ id, threat }] }` where `threat` is the threat type or `null`.
- Read-only. Behind the existing Origin/CSP middleware (same as `/api/check-links`). `url` type-checked.

### Config: Safe Browsing key (`core/config.js`)

- Add `getSafeBrowsingKey()` / `setSafeBrowsingKey(key)` over the existing `loadConfig`/`saveConfig`
  (mirrors `getSyncConfig`/`setSyncConfig`). Key persists in `config.json` (loopback-only, like other
  settings). Never logged; never echoed in errors.
- `Store.getSafeBrowsingKey()` / `Store.setSafeBrowsingKey(key)` adapters + a `GET/POST /api/safebrowsing-key`
  route (or fold into existing config endpoints). Settings UI adds a password field "Google Safe
  Browsing API key" with a link to `https://developers.google.com/safe-browsing/v4/get-started`.

### Phase 1 renderer: library scan (`web/index.html`)

- A **🛡️ Check link safety** button beside the existing "🔗 Check dead links" button.
- `checkLinkSafety()` mirrors `checkDeadLinks()`: collects http(s) saved+imported links not recently
  safety-checked (per-item `sb = { at, verdict:"safe"|"unsafe", threat }` marker, fresh window e.g.
  7 days), batches to `Store.checkSafety(items)` in chunks, tap-to-stop (`_safetyStop`), records the
  `sb` marker on each card, and routes flagged (`threat != null`) links to a review modal.
- Review modal mirrors the (now scrollable, buttons-in-top-header) dead-link modal — reuses the
  shared `.dupe-box/.dupe-list/.dupe-row` CSS. Rows show the threat type ("⚠ Malware",
  "⚠ Phishing", …). Remove reuses the existing snapshot-first bulk-replace path
  (`snapshotBeforeDestructive()` → filter → `Store.putCards/putSaved`); default checkbox = checked.
- Bounded + stoppable; if no key configured, toast "Add your Google Safe Browsing key in Settings".

### Phase 2 (next spec): open-time check

- `openLink(url)` becomes async: consult a fresh cached `sb` marker or call `Store.checkSafety([url])`;
  if `threat != null`, show a **red warning interstitial** naming the threat with **Open anyway** /
  **Cancel**. If unconfigured / offline / error / safe → open normally (fail-open; the browser's own
  Safe Browsing remains the backstop for `shell.openExternal`). Applies to the in-app viewer too.
- Built after Phase 1 ships, as its own spec → plan → build.

## Data flow (Phase 1)

renderer `checkLinkSafety()` → `Store.checkSafety(chunk)` → `POST /api/check-safety` → Core
`safebrowse.checkUrls(urls, key)` → Google → `{results:[{id,threat}]}` → renderer marks `sb` on each
card, collects `threat != null` → review modal → user removes (backup-first) or keeps.

## Data-safety & security

- **Read-only detection.** Nothing auto-removed; user reviews every removal; removals reuse the
  existing snapshot-before-destructive path. The `sb` marker is additive (like `lc`).
- **Key handling:** stored in local `config.json` (loopback-only); never logged or returned in errors.
- **No SSRF surface:** the only outbound call is to the fixed `safebrowsing.googleapis.com` host.
- **Bounded & stoppable:** manual trigger; item cap 500/request; chunked; `_safetyStop`; quota is ample.
- **Privacy (accepted trade-off):** the URLs being checked are sent to Google (inherent to Safe
  Browsing), same trust model as the existing AI features. Nothing else leaves the machine.

## Testing (TDD)

- Pure: `buildLookupBody` (correct threatTypes/entries shape), `parseLookupResponse` (matches → map;
  `{}`/missing → empty; multiple threats).
- Endpoint `/api/check-safety` with a **stubbed `global.fetch`** (no real network): a flagged URL →
  threat returned; a clean URL → `null`; missing key → `{error:"no_key"}`; item cap.
- Renderer: a safety-sweep wiring test (button calls `Store.checkSafety`, review modal present) like
  `tests/deadlink-wiring.test.js`.
- Then run **data-safety-reviewer** + **electron-security-reviewer**; rebuild installer (version bump).

## Out of scope / deferred

- Phase 2 open-time check (next spec).
- URLhaus / VirusTotal / multi-source (Safe Browsing chosen as the single source).
- Safe Browsing Update API (local hashed database) — the simpler Lookup API is used; revisit only if
  per-URL privacy becomes a concern.
- Auto-removal of flagged links (always user-reviewed).
