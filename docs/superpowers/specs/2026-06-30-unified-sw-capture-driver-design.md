# Unified capture: background-worker driver for single + bulk, all platforms

**Date:** 2026-06-30
**Status:** Approved (design); proof validated; ready for implementation plan
**Author:** Dave + Claude

## Problem

Updating a card's image works reliably ONLY via the manual extension-popup "Clip" (open the page in
Chrome, click capture). Every automated path fails in the user's standalone desktop app:

- The capture **driver** historically lived in `extension/bridge.js`, a content script Chrome injects
  ONLY into a `localhost:3456` tab (`manifest.json` content_scripts). The desktop app is a BrowserWindow,
  not a Chrome tab, so `bridge.js` never runs — the app writes capture/batch requests to the Core
  mailboxes (`/api/capture-request`, `/api/batch-state`) and nothing drains them.
- The Core's server-side fetch (`/api/capture-meta`, used by "Capture missing"/"Retry all") cannot
  capture social hosts (FB/IG/YouTube are in SKIP_HOSTS) or login/hotlink-gated images — only a real
  logged-in browser screenshot can.

**Proof (validated 2026-06-30, extension v4.41):** a background-worker (`chrome.alarms`) poller that
claims `/api/capture-request` and runs the extension's `captureOneTab` (which opens its own tab, tracks
it by tab-id through redirects, captures, closes) successfully healed a live card
(evilmadscientist.com) with NO localhost tab open. The background worker CAN drive capture. (A first
attempt using `handleCaptureRequest` hung on a cross-domain redirect — `typepad.com` →
`networksolutions.com` — because it matched the tab by URL; `captureOneTab` matches by tab-id and is
redirect-safe.)

## Goal

Make a card's image update reliably for **single AND bulk**, on **every platform** (Facebook, imported
bookmarks, YouTube, Instagram, Pinterest), using the one proven mechanism: **open the page in Chrome →
the extension captures it → post back → heal the card.** Plus **logging** the user can read in-app.

Hard requirement (accepted by the user): **Chrome must be running with the extension installed and the
user logged into FB/IG.** The win: NO need to open the app as a Chrome tab — the background worker
drives everything whenever Chrome is open.

## Design

### A. Background worker becomes the sole capture driver (extension)
- `chrome.alarms` poller (30s floor; immediate poll on SW wake and after each capture so batches chain
  tightly) that, when **no `localhost` tab is present** (else defer to `bridge.js`):
  - **Single:** claim `/api/capture-request` → `captureOneTab(url, id, delay, render)` (already proven).
  - **Bulk:** read `/api/batch-state`; run its items through `captureOneTab` one at a time
    (concurrency 1, the configured delay), updating `/api/batch-progress` and advancing `next` in
    `/api/batch-state` after each item (re-read state each tick so an SW suspension resumes from `next`).
    This is the same loop `bridge.js` ran (`driveBatch`/`pump`), moved into the SW.
- **Retire `bridge.js` polling** (single driver, per the decision) — leave the file/other helpers but
  stop its `checkForRequest`/`driveBatch` interval so there is no double-driving. (Or guard it off.)
- `captureOneTab` already handles per-platform: FB → og-fetch then render-in-tab; non-FB → open tab +
  `captureVisibleTab` screenshot; YouTube → i.ytimg thumbnail; IG/Pinterest → render-in-tab + engine.
  No new per-platform code; this spec only changes the DRIVER, reusing the proven capture primitive.

### B. App routes single + bulk through the extension (web/index.html)
- **Single refresh (⟳ `impRefresh`) and card-open recapture:** keep writing the capture-request, but
  **stop the app from opening its own tab** (`window.open`) — the worker's `captureOneTab` opens and
  owns the tab (avoids the duplicate-tab the proof showed). Ensure refresh **clears + reliably
  overwrites** the image (force) so the user never has to delete it first.
- **Bulk ("Retry all" / "Capture selected" / a unified "Recapture all (N)"):** route failed cards
  through the extension batch (`Store.setBatchState`) so EVERY platform captures via `captureOneTab`,
  instead of the Core (which is FB/IG-blind). Keep the cheap Core path only where it strictly helps
  (e.g. a non-social card with a fetchable og:image) as a fast pre-pass, then hand the rest to the
  worker. Capped, stoppable, resumable, session-only (mirror the existing FB-batch controls).

### C. Logging the user can read (app + core + extension)
- Tagged log lines at every boundary: app queue write → Core enqueue → SW pickup ("claimed <id>" /
  "no localhost tab → SW driving" / "deferring to bridge") → tab open → capture done (screenshot/og/
  engine, or "unavailable/spinner") → delivery (`/api/captures`) → `drainCaptures` heal ("matched
  card <id> via id|url" / "unmatched → re-enqueued").
- **In-app Capture Log panel** (Settings → Capture Log): the app logs its own boundaries directly; the
  SW MIRRORS its boundary logs to the Core via a new `POST /api/log` (ring buffer), and the panel tails
  the buffer (`GET /api/log`). One pane of glass, no DevTools needed.
- Accurate per-capture status in the extension popup (replace the stale "Timed out" leftover).

## Components / files
- `extension/background.js`: alarms poller for capture-request + batch-state → `captureOneTab`; SW-side
  batch progress/state writes; mirror logs to `POST /api/log`; accurate popup status.
- `extension/bridge.js`: stop the polling intervals (retire as driver).
- `extension/manifest.json`: `alarms` already added (v4.40); bump version.
- `web/index.html`: stop the app opening its own refresh tab; reliable overwrite-on-refresh; route bulk
  through `setBatchState`; Settings → Capture Log panel.
- `web/storage.js`: `Store.getLog()` (GET /api/log) for the panel.
- `core/server.js`: `POST /api/log` (append to a bounded ring buffer) + `GET /api/log`; log at the
  Core boundaries.

## Error handling / limits
- Requires Chrome open + logged into FB/IG (unavoidable; documented in the panel/UI).
- 30s alarm floor → first single capture may wait up to ~30s; batches chain immediately after the first.
- FB/IG render opens focused tabs (concurrency 1) — intrusive during a big batch; best run when away.
- Dead/redirected bookmarks (e.g. Typepad) capture their parking page or are flagged unavailable — a
  content limit, not a mechanism failure.
- Non-destructive: captures only fill/replace a card image via the existing heal path; no new delete.

## Testing
- Extension: unit-test the pure bits where feasible (the localhost-tab guard predicate; the batch
  advance logic as a pure function). The end-to-end capture is validated by manual test (already proven
  for single; confirm bulk + each platform).
- App: text-assert wiring (refresh no longer calls window.open; bulk routes via setBatchState; Capture
  Log panel reads getLog).
- Core: `POST /api/log` appends + bounds; `GET /api/log` returns recent lines (node test).
- Full `node tests/run.js` green. Data-safety review (capture→card mutation, log endpoint). Electron-
  security review (new /api/log endpoint; ensure no secrets logged; 127.0.0.1-only).

## Phasing (build order — each independently testable)
1. **SW single-capture driver** — DONE (proof, v4.41): poller → captureOneTab for capture-request.
2. **App single-refresh cleanup** — stop the duplicate window.open; reliable overwrite; accurate status.
3. **Logging spine** — `POST/GET /api/log` + SW mirroring + boundary logs.
4. **In-app Capture Log panel** — Settings view tailing the log.
5. **SW batch driver** — poll batch-state → captureOneTab loop + progress; retire bridge.js polling.
6. **App bulk routing** — route "Retry all"/"Capture selected"/unified "Recapture all" through setBatchState.
7. Reviews (data-safety + electron-security) → bump → rebuild.

## Out of scope / deferred
- Sub-30s single-capture latency (would need a non-alarms always-on mechanism).
- Capturing dead/redirected bookmarks' original content (the content is gone).
