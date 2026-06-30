# Display the found preview-image URL when the server download is blocked

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

Many failed cards show reason **"Preview image wouldn't download" (`image-failed`)**: the Core's capture
*found* the page's `og:image` address but could not **download** it server-side (hotlink/referer
protection, image host blocking the node fetch). Today the Core discards the address and marks the card
failed. But the app's own browser engine can usually load that same address in an `<img>` tag. So the
picture is recoverable without the extension, tabs, or any Chrome dependency.

(Context: the bulk-extension-recapture approach was abandoned — the extension's batch driver
(`bridge.js`) doesn't run in the user's setup. This Core-side fix is the reliable path for the largest
fixable group.)

## Fix

When the server-side image download fails but a valid `http(s)` preview-image URL was found, **return
that URL** so the app stores it on the card and displays it directly via `<img>`.

This rides the existing capture path, so **"Retry all" and "Capture missing" (and enrich-on-open)
automatically start fixing these cards** — no new button, no extension.

## Components

### `core/capturemeta.js` — return the URL fallback
In `captureMetaChunk`, the absolute og URL (`abs`) is already computed before the download attempt.
Add it to the per-item result as `imageUrl` **only when** the download produced no data URL AND `abs`
is `http(s)`:

```js
var imageUrl = (!imageDataUrl && /^https?:\/\//i.test(abs)) ? abs : "";
results[idx] = { id: it.id, imageDataUrl: imageDataUrl, imageUrl: imageUrl, title: og.title, description: og.description, reason: reason };
```
(`abs` must be declared in the function scope so it's available after the download attempt. `reason`
stays `image-failed` from the Core's perspective; the server/app treat `imageUrl` as success.)

### `core/server.js` — pass it through
In `POST /api/capture-meta`'s result map, include `imageUrl` (http(s), only when not `hasImage`) and
clear `reason` when there's any image (downloaded OR url):

```js
const imageUrl = (!hasImage && r && /^https?:\/\//i.test(r.imageUrl || "")) ? r.imageUrl : "";
return { id: r && r.id, hasImage: hasImage, imageUrl: imageUrl, title: (r&&r.title)||"", description: (r&&r.description)||"", reason: (hasImage || imageUrl) ? "" : ((r && r.reason) || "unreachable") };
```

### `web/index.html` — apply it as a successful capture
Both capture-meta result handlers treat `imageUrl` like a (URL-based) success:
- **`startBatchCapture`** result loop: after the `hasImage` branch, add an `else if(r.imageUrl)` branch
  that sets the card's image to the URL (via `setCardImage(c, r.imageUrl)` so any stale `idb:` blob is
  cleaned up), clears `capReason`, counts it as got, and sets `lastResult="ok"` (so `r.hasImage ||
  r.imageUrl` ⇒ ok).
- **`enrichOnOpen`** (the `Store.captureMeta` block): after `if(m.hasImage && isBadImg(it.img))`, add
  `else if(m.imageUrl && isBadImg(it.img)) setCardImage(it, m.imageUrl)`.

(The app already displays `http(s)` card images directly via `<img>`; `setCardImage` stores a non-`data:`
src as the URL itself.)

## Error handling / limits

- **Non-destructive:** only fills an image where the card had none; prefers the durable downloaded copy
  first and uses the URL only as a fallback. If the URL later fails to load in `<img>`, the card shows a
  broken image — same as the current failed state — and is re-runnable.
- **http(s) only** (never `data:`/`javascript:`); guarded at both the Core and server layers.
- **Does NOT help:** Instagram (`social` — the Core skips it, so no `abs`), `no-image` cards (no og at
  all), or `unreachable`/dead links. Those keep their current behavior.
- **Stale-URL risk:** most normal-site og images are stable; signed/expiring CDN URLs (rare for these
  non-social cards) could rot, but it's re-runnable and non-destructive.

## Security / privacy

- `<img src=ogUrl>` is normal browser behavior for a page the user saved — it's a client-side image
  load, **not** a server-side fetch, so no new SSRF surface. The Core already SSRF-guards its own
  fetches; the returned `abs` came from a guarded page fetch.
- No card URL is sent anywhere new; the image URL is loaded by the app's renderer exactly as any saved
  card image is.

## Testing

- `core/capturemeta.js`: a page with an `og:image` whose download fails (stub `fetch`: HTML ok, image
  fetch non-image/empty) returns `reason:"image-failed"` AND `imageUrl` = the absolute og URL; a page
  with no og:image returns `imageUrl:""`, `reason:"no-image"`; a successful download returns
  `imageDataUrl` and `imageUrl:""`.
- `core/server.js` `/api/capture-meta`: a result with `imageUrl` and no `hasImage` returns
  `{ hasImage:false, imageUrl:<url>, reason:"" }`.
- `web/index.html` wiring: `startBatchCapture` and `enrichOnOpen` apply `imageUrl` (set card image +
  ok) — text-assert.
- `tests/syntax-check.js` + full `node tests/run.js` green.

## Data-safety review

Run the **data-safety-reviewer** (touches how a capture result mutates a card + the Core image path) —
though it's purely additive (fills an image, never deletes).

## Out of scope / deferred

- Screenshot-service fallback (thum.io/mshots) for `no-image` cards — deferred (chose og-URL only).
- The bulk-extension-recapture driver — abandoned (the extension batch driver doesn't run in this setup).
- Instagram bulk capture — needs the extension; not addressed here.
