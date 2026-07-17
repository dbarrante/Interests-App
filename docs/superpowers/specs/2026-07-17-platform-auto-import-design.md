# Platform auto-import (Facebook + Instagram saves) — design

## Problem

Saves made natively on a platform — e.g. tapping "Save" on Facebook from any
device — never reach the app unless the user runs a manual data-export
import. Decision (user, 2026-07-17): the app should automatically pick these
up. Scope: **Facebook + Instagram**, via the desktop Chrome **extension**
using the user's own logged-in session (no platform exposes saved items via
API), **daily** auto-check **plus** a manual "Check now" — with a Settings
switch to turn the automatic check off.

## Constraints & realities

- Runs only where the extension runs: the user's desktop Chrome, browser
  open, logged into facebook.com / instagram.com. Saves made on ANY device
  appear in the account's saved list, so one desktop checker covers the
  fleet; the sync mesh distributes imports to phone/iPad.
- Scraping the saved pages is inherently brittle to DOM changes — reuse the
  resilience patterns and selectors machinery of the existing FB capture
  content scripts, and fail SOFT: a parse failure reports "check failed"
  (visible in Settings), never partial garbage imports.
- Personal-account automation is the user's informed choice; throttle to
  human-like cadence (one page visit per platform per day; no pagination
  crawling beyond the first ~100 entries per check).

## Design

### 1. Extension side (`extension/`)

- **Scheduler:** `chrome.alarms` daily alarm (+ jitter) in
  `background.js`. On fire (and on manual trigger): for each enabled
  platform, open an inactive pinned tab to the saved-items page
  (`facebook.com/saved/`, `instagram.com/<self>/saved/all-posts/`), inject
  the scraper content script, collect entries, close the tab. One platform
  at a time.
- **Scrapers:** `extension/saved-scrape-fb.js` + `saved-scrape-ig.js`
  content scripts. Extract per entry: `url`, `title`, best-effort image, and
  a stable platform key (post id from the URL). Scroll-load at most ~2
  screens (cap ~100 entries/check — a daily diff only needs the newest).
  Images go through the existing `durableImage()` conversion (signed-CDN
  URLs must be converted before delivery — same rule as capture).
- **Delivery:** POST the batch to the Core service over the existing
  localhost bridge as a new mailbox: `POST /api/auto-import` with
  `{platform, items:[{url,title,image,platformKey}], checkedAt}`. The
  extension is fire-and-forget; the service owns dedup.
- **Session-absent handling:** a login wall/redirect detected by the scraper
  reports `{status:"login-required"}` — surfaced in Settings, never retried
  more than the daily cadence.

### 2. Core service side (`core/`)

- New `core/autoimport.js`: dedups incoming items against (a) existing
  cards/saved by normalized URL (the importer's existing URL-normalization),
  (b) a `kv` ledger `ia_autoimport_seen_<platform>` of platformKeys already
  processed (so un-saving then re-saving on the platform re-imports, but a
  still-saved old item never re-imports after the user deletes its card —
  **deleting a card in the app must stay deleted**).
- New items become imported cards through the existing import machinery
  (tagged `source: "fb-auto"` / `"ig-auto"`, normal capture-enrichment
  queue picks up images/screenshots like any import).
- Result record to kv: `ia_autoimport_last` = `{platform, at, found, added,
  status}` per platform, for the Settings status line.
- Endpoint guarded like the other extension-bridge endpoints (same pairing
  auth), body size-capped, per-item field length-capped (untrusted input —
  same hygiene as the browser-stumble mailbox).

### 3. Settings UI (`web/index.html`, mirrored non-functional on PWA)

New "Auto-import from platforms" section (desktop-only, hidden on PWA like
other extension-dependent sections):
- Master toggle **"Check my platform saves automatically (daily)"** —
  setting `autoImportOn` (synced like other settings; only devices with the
  extension act on it). Per-platform checkboxes (FB / IG).
- **"Check now"** button → pokes the extension via the existing
  extension mailbox; results toast + status lines.
- Status per platform: "Last check: <time> — <n> new imports" / "failed:
  <reason>" / "login required — open facebook.com and sign in".

### 4. What does NOT change

- No platform credentials are ever stored — the extension rides the
  browser's own session.
- Existing manual export-file importers stay (they remain the bulk-history
  path; auto-import only catches the daily trickle).
- No deletions ever flow FROM the platform (un-saving on Facebook does not
  remove the card in the app).

## Error handling

Every failure mode lands in `ia_autoimport_last` and the Settings status
line: login-required, parse-failed (zero entries where the page loaded),
bridge-unreachable. A parse yielding 0 entries when the ledger expects
entries is reported as suspect, not treated as "nothing new". The daily
alarm never stacks (one in-flight check max).

## Testing

- Scraper parsers: fixture-driven plain-Node tests on saved-page HTML
  fixtures (`tests/autoimport-fb-parse.test.js`, `-ig-`), same style as the
  news/import parsers.
- `core/autoimport.js`: dedup ledger semantics (URL-known, key-known,
  deleted-card stays deleted), size caps, result records — real temp-store
  tests.
- Endpoint: mounted-server test (`createServer()` on port 0) with pairing
  auth, oversized-body rejection.
- Extension wiring: source-scan tests for alarm registration, one-at-a-time
  gating, login-wall soft-fail (pattern of existing bstumble-ext tests).
- Manual: live check against the user's real FB/IG saved pages (the only
  true parser validation), behind the "Check now" button first.

## Rollout

Desktop release (extension + core + web Settings) — extension reloads from
the repo; core/web need the next installer. Ship auto-check **off by
default** for one release; the user flips it on after "Check now" proves the
parsers against their real pages.
