# Recapture: arm the heal target from the grid + route enrich through the Core

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

After v1.5.4, the recapture heal still didn't work from the user's actual workflow. Console evidence:
`[route] https://www.instagram.com/reels/... -> saved (clip -> Saved library (never modifies Imported))`
— the clip routed to Saved because `_recapTarget` was **not armed**. v1.5.4 arms it only in `openFailOne`
(the failures-modal title click); the user recaptures from the **main grid** instead — clicking a card
(`impOpen`) or the ⟳ "Refresh image — recapture this page" button (`impRefresh`). Both set
`ia_last_opened` but neither arms `_recapTarget`, so the manual extension Clip is never recognized as a
heal.

Separately, opening a card throws CORS errors: `enrichOnOpen` fetches `https://api.allorigins.win/get?...`
from the renderer (origin `http://127.0.0.1:3456`), which is CORS-blocked (`No 'Access-Control-Allow-Origin'`
/ 404 / AbortError). The enrichment never works and the console fills with errors.

## Scope (two app-only fixes in `web/index.html`)

A. **Arm `_recapTarget` from the grid recapture actions** — so the manual Clip heals the card.
B. **Route `enrichOnOpen` through the Core** instead of the CORS-blocked proxy.

## A. Arm the heal target from the grid

Mirror what `openFailOne` already does (`_recapTarget = {id, ts: Date.now()}`):

- **`impRefresh(idx)`** (the ⟳ "recapture this page" button): arm `_recapTarget` for `it.id` right where
  it already sets `ia_last_opened`.
- **`impOpen(idx)`** (clicking a card): arm `_recapTarget` for `it.id` **only when `doCapture` is true**
  (the card needs/refreshes an image — an implicit recapture intent). Do NOT arm when opening a card that
  already has a good image.

Both reuse the existing v1.5.4 machinery: `routeCapture` honors `_recapTarget` (one-shot, 15-min window),
`drainCaptures` heals the card (`viaRecap`) and disarms on success. No router change needed.

## B. Enrich via the Core (no CORS)

In `enrichOnOpen`, replace the renderer-side `api.allorigins.win` fetch + `ogParse` block with a call to
the app's own Core, which fetches og server-side (SSRF-guarded) and is same-origin (no CORS):

- Call `Store.captureMeta([{ id: it.id, url: it.url }])` → returns `[{ id, hasImage, title, description, reason }]`
  (the endpoint stores any fetched image server-side as `images/<id>.jpg` and sets `hasImage:true`).
- Apply, preserving the existing conditions:
  - if `m.title` is long enough and the current title is generic → `it.title = m.title.slice(0,250)`;
  - if `m.description` is long enough and the current desc is empty/"Saved from"/"From your" →
    `it.desc = m.description.slice(0,220)`;
  - if `m.hasImage` and `isBadImg(it.img)` → `setCardImage(it, "idb:" + it.id)` (the Core stored it).
- Keep the existing downstream fallbacks unchanged (`fetchMicrolink`, the thum.io/mshots `<img>` chain —
  those use `<img>` loads, not `fetch`, so they are not CORS-blocked; only the allorigins `fetch` was).
- The Core skips social hosts (Instagram/Facebook), so for an IG card `captureMeta` simply returns
  `hasImage:false` with no title/desc and makes **no** outbound request — silencing the CORS errors with
  no wasted work; the extension Clip remains the way IG cards get healed.

## Components

- `web/index.html`: `impRefresh` (+1 line arm), `impOpen` (+1 conditional arm), `enrichOnOpen` (replace
  the allorigins block with a `Store.captureMeta` call).
- `tests/capture-wiring.test.js`: extend.

## Testing (text-assert wiring + gate)

- `impRefresh` arms `_recapTarget`; `impOpen` arms `_recapTarget` (guarded by `doCapture`).
- `enrichOnOpen` no longer references `api.allorigins.win` and calls `Store.captureMeta`.
- `tests/syntax-check.js` + full `node tests/run.js` green.

## Data-safety & security

- App-only; no Core endpoint change (reuses existing `/api/capture-meta`), no extension change.
- The arm additions reuse v1.5.4's heal apply path (no new delete path; image clears stay backup-first).
- Routing enrich through the Core REMOVES a renderer→third-party `fetch` (allorigins) and replaces it with
  the same-origin, SSRF-guarded Core endpoint — a net security improvement (no card URL sent to a 3rd-party
  proxy from the renderer).
- Run the **data-safety-reviewer** (touches how a capture/enrich mutates an imported card).

## Out of scope / deferred

- Replacing the `fetchMicrolink` / thum.io / mshots fallbacks (not CORS-erroring; separate).
- The general "any clip heals the active same-domain card" routing change (not needed — explicit arming
  from the grid actions covers the workflow).
