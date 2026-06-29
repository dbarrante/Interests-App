# Electron-native "Capture missing" via Core page-fetch

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

"Capture missing" does nothing in the Electron app. Root cause (confirmed): the batch is
*driven* by the Chrome extension's `bridge.js` — a **content script** that only runs on a Chrome
tab at `http://localhost:*` / `http://127.0.0.1:*` (extension manifest). The Electron window is not
a Chrome tab, so the extension's content scripts don't run in it. `startBatchCapture` only *queues*
the batch (sets `batch-state` / a capture-request); with no Chrome tab open at `localhost:3456`,
nothing drives the loop → no tabs open, no images arrive. The user runs only the Electron app, so
the feature is effectively dead there. (Social right-click/native-Save capture uses a different
path — the extension running on the social page — and is unaffected.)

## Solution overview

Give the Electron app its **own** way to fill a picture-less card, with no extension/Chrome tab: the
**Core** fetches each card's page (reusing the soft-dead SSRF-guarded fetch), extracts the page's
preview image + title/description, **downloads the preview image to the card's image file** (durable,
not a rotting remote URL), and returns the info. The renderer's "Capture missing" button calls this
directly. Social/login hosts are skipped (server-side fetch can't see them — they stay on the
extension path). The existing extension batch path is left untouched.

## Behavior

- **📷 Capture missing** (`startBatchCapture`) keeps its candidate selection (`needsCapture` /
  `needsRetry`, dedup by `clipKey`, `BATCH_CAP` cap, and the "mark attempted now" stamping so a
  card is never retried forever). It then drives the work via the **Core** (batched `Store.captureMeta`
  calls) instead of setting `batch-state` for the extension. Progress toast + tap-to-stop.
- For each returned card: set `card.img = "idb:"+id` if an image was found+stored; fill
  `card.title`/`card.description` **only if blank or just the bare domain** (never overwrite a real
  title); set `lastUpdate`/`lastResult` (`ok` if image, else `fail`) — attempted cards don't loop.
- **Social hosts** (instagram/facebook/pinterest/youtube-watch-walled/threads — the existing
  `isSkippedHost` set) are skipped by the Core path and marked attempted (so they don't retry every
  run); they remain the extension's job. **Facebook capture (`startFbCapture`) is unchanged.**
- **No extension changes.**

## Components

### NEW `core/capturemeta.js`

- `extractOg(html) -> { image, title, description }` — **pure**. Parses `og:image` (and fallbacks
  `twitter:image`, `<link rel="image_src">`), `og:title` (fallback `<title>`), `og:description`
  (fallback `<meta name="description">`). Tolerant of attribute order (`property`/`content` either
  way). Returns `""` for anything missing.
- `captureMetaChunk(items, opts) -> Promise<[{ id, imageDataUrl, title, description, skipped? }]>` —
  for each `{id,url}`: if `!isProbableHost(url) || isSkippedHost(url) || !(await safeToFetch(url))`
  → `{id, skipped:true}` (no fetch). Else GET the page (manual redirects re-validated by
  `safeToFetch` per hop; body capped ~256KB), `extractOg`, resolve `image` to absolute against the
  final URL. If an image URL is found, GET it (SSRF-guarded; **content-type must be `image/*`**;
  size cap ~3MB) and return it as a base64 `data:` URL in `imageDataUrl` (else `""`). Never throws;
  per-item failures yield `{id, imageDataUrl:"", title, description}`. Concurrency ≤ 6. NO filesystem
  — image storage is the endpoint's job (keeps this module network-only + testable with a stubbed
  `global.fetch`).

### NEW endpoint `POST /api/capture-meta` (in `core/server.js`)

- Body `{ items:[{id,url}] }`, items capped at 100. Calls `captureMetaChunk`. For each result with a
  non-empty `imageDataUrl`, writes the card's image via `images.putImg(storeDir, id, imageDataUrl)`
  (`storeDir` from ctx — same call the `PUT /api/img` route uses; `id` already validated by
  `safeImgId` inside `putImg`). Returns `{ results:[{ id, hasImage, title, description }] }` — the
  data URL is **not** returned (the image now lives in the store). Read/writes only the image store.

### `web/storage.js` — `Store.captureMeta(items, opts) -> Promise<results[]>`

Mirrors `Store.checkContent` (`POST /api/capture-meta`).

### `web/index.html` — repoint `startBatchCapture`

Replace the extension `setBatchState` dispatch with a batched `Store.captureMeta` loop (chunks of
~25, honoring a stop flag like the dead-link sweep), applying results to cards per the Behavior
rules, then persist (`Store.putCards`). Keep the existing candidate selection + attempt-stamping.
`drainCaptures` and the extension batch path are left as-is.

## Data-safety & security

- **Additive, non-destructive:** only fills picture-less cards (image when found; title/description
  only if blank). Marks attempt stamps (pre-existing behavior). No card/image deletes; no other
  settings touched. Writing `images/<id>.jpg` for a card that had none is the capture path's normal,
  intended write.
- **SSRF (two surfaces):** both the page GET and the image-download GET go through
  `linkcheck.safeToFetch` + `isProbableHost` (per redirect hop), exactly like the soft-dead probe.
  The image download additionally requires a `image/*` content-type and a size cap.
- **Bounded:** item cap 100/request; renderer chunks of ~25; concurrency ≤ 6; body/image size caps;
  request timeout (reuse the soft-dead clamp); manual + stoppable.
- Reviews: **electron-security** (new external page + image fetch surface) and **data-safety**
  (image-store write) before ship.

## Testing (TDD)

- Pure `extractOg`: og:image / twitter:image / link image_src fallbacks; attribute-order variants;
  og:title vs `<title>`; missing → `""`.
- `captureMetaChunk` with stubbed `global.fetch`: image found → data URL; no og:image → `""`;
  non-`image/*` content-type → `""`; social host → `{skipped:true}` (no fetch); SSRF host → skipped.
  (No real network; reuse `linkcheck._setLookup` to stub DNS like `contentcheck-probe.test.js`.)
- Endpoint `/api/capture-meta` with stubbed fetch + tmp store: writes an image file when found;
  returns `{id,hasImage,title,description}`; item cap 100; no key/network leak.
- Renderer wiring test: `startBatchCapture` references `Store.captureMeta`.
- `tests/syntax-check.js` + full gate; installer bump.

## Out of scope / deferred

- Social/login-walled capture (FB/IG/Pinterest) — stays on the extension path; the Core skips those.
- Screenshot rendering fallback for pages with no preview image (could be a later enhancement;
  YAGNI for now — most web/bookmark cards have an og:image).
- The toggle-off-built-in-viewer item (separate, still queued).
