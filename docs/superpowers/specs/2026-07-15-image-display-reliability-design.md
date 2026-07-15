# Image display reliability (all platforms) — design

## Problem

A live investigation this session (desktop app + iPad PWA both "missing
pictures") and a concurrent session's own investigation (see
`HANDOFF.md` at commit `ced6884`) both converged on the same root cause
class: **captured images that are stored as raw external URLs instead of
durable local copies eventually rot** (the source URL expires, 404s, or the
signature times out), with nothing in the pipeline to catch it. The
concurrent session already fixed the specific case that bit first —
Facebook/Instagram signed CDN URLs (`f0d911a`) — by converting them to
`data:`/`idb:` images at capture time, and separately found and fixed an
unrelated bug where a real screenshot could BE a misleading "content
unavailable" error page (`16a04ca`, perceptual-hash detection). Neither of
those closes the general case.

A survey of the current codebase (this session) found four remaining,
independent gaps standing between here and "captured photos always display
reliably":

1. **Capture-time**: the durable-conversion helper (`durableImage()` /
   `isExpiringCdnImage()` in `extension/background.js`) only recognizes
   Facebook/Instagram CDN hostnames. Any image picked up via the generic
   capture path (`captureTab`, used for Pinterest, YouTube, and every other
   site) from a different signed/expiring CDN — or any CDN that starts
   expiring URLs in the future — is still stored raw, unprotected. This is
   the same bug class as the Instagram fix, just not generalized.
2. **Display-time**: two rendering paths — the edit-card modal's image
   preview and the duplicate-review modal's thumbnail — have no
   broken-image fallback at all, unlike every other card/reader view in the
   app (which already falls back favicon → generic icon on `onerror`).
3. **Server-side**: `core/images.js`'s `putImg`/`getImg` do existence-only
   checking. A missing file is a bare 404 with no retry signal; a
   corrupted/truncated/0-byte file already on disk is served as `200 OK`
   with no integrity check, indistinguishable from a real image to the
   client.
4. **Mobile-specific**: bulk recapture (`recaptureViaWorker`, "Retry all")
   depends entirely on a desktop Chrome extension polling
   `127.0.0.1:345x`. On a standalone mobile PWA session with no paired
   desktop, these requests go nowhere — and the busy/"Stop capture" UI has
   no timeout, so it can spin indefinitely with zero feedback.

## Scope

Display-time resilience and capture-time hardening for the general case
(not Meta-CDN-specific — that's already fixed). Explicitly **not** in
scope: building phone-native capture capability for the PWA (fetching and
parsing arbitrary pages without a browser extension) — a much larger,
separate feature; for mobile, this plan only makes the existing
extension-dependent recapture flow fail visibly and promptly instead of
hanging, not add a working alternative.

## Architecture

Four independent fixes, each localized to where its gap was found — no
shared new abstraction needed; each reuses a pattern already proven
elsewhere in this codebase.

## Components

### 1. Capture-time: generalize `durableImage()` (Approach A: default-to-durable)

Current shape (`extension/background.js`):
```js
async function durableImage(url) {
  if (!isExpiringCdnImage(url)) return url;
  const data = await fetchAsDataUrl(url);
  return data || url;
}
```
Change to always attempt conversion (matching how `captureFbPost`/
`captureFbByOg` already behave unconditionally), rather than gating on a
hostname blocklist:
```js
async function durableImage(url) {
  if (!url || url.indexOf("data:") === 0) return url; // already durable, or nothing to do
  const data = await fetchAsDataUrl(url);
  return data || url;
}
```
`isExpiringCdnImage()` itself is unchanged and stays in use — `isBadImg()`
still calls it as a defense-in-depth safety net for the case where the
fetch itself failed and a raw signed URL got stored as the fallback.

`captureTab` already routes `meta.ogImage`/`meta.contentImage` through
`durableImage()` (this is what the Instagram fix wired up) — that callsite
needs no further change and inherits the broader protection automatically.
`clipCurrentPage` does NOT currently route `meta.ogImage`/`meta.contentImage`
through `durableImage()` (only its separate right-clicked-image case has an
inline fbcdn/scontent/cdninstagram check) — wire those two fields through
`durableImage()` there too, closing that path's gap the same way.

### 2. Display-time: add the missing `onerror` fallback

`web/index.html` + `pwa/index.html` (kept in sync, per repo convention):
add the existing `fvFallback`-style onerror chain (broken image → Google
favicon → generic `<div class="ic">` icon — the same three-step fallback
already used in `impCardHTML`/`readerImgHTML`) to:
- `editImgPreview`'s `<img>` (filled by `edRenderPrev()`)
- `dupeThumb()`'s http(s)-URL branch (the `idb:` branch just above it
  already has this)

### 3. Server-side: reject/detect corrupt image bytes

`core/images.js`:
- `putImg(storeDir, id, dataUrl)`: after `decodeDataUrl`, throw if the
  decoded buffer is empty (0 bytes) — today it writes whatever
  `decodeDataUrl` produces with no validation. The `PUT /api/img/:id` route
  (`core/server.js`) already has a catch block for `putImg` throwing
  (currently only handles `INVALID_IMG_ID`); extend it to return `400` for
  this new failure too, instead of a silently-corrupt file landing on disk.
- `getImg(storeDir, id)`: treat a 0-byte file the same as a missing one —
  return `null` instead of an empty `Buffer`. This makes `GET /api/img/:id`
  naturally 404 (existing `if (!buf)` check), which the client's existing
  `onerror` fallback chain (component 2 above, plus the paths that already
  have it) already handles — no new client-side logic needed for this case.
- No fallback-refetch-on-GET: a missing/corrupt image is surfaced as
  "missing" (404) and left to the app's existing explicit recapture
  mechanism to fix, not implicitly refetched as a side effect of a view
  request. This matches the app's existing architecture (recapture is a
  deliberate, tracked, worker-driven action) rather than adding a new
  implicit-fetch code path with its own failure modes.

### 4. Mobile: stop the stuck "Stop capture" UI

`web/index.html` + `pwa/index.html`, `pollBatchProgress`: today, if no
progress record ever appears (`p` stays `null` — the extension never
started polling, e.g. no paired desktop), the function's `if(!p) return`
means the busy UI never resolves. Add a deadline: if `pollBatchProgress` has
been polling for >20s with `p` still `null` at every check, stop, reset
`batchUI.active`, and toast "Recapture needs the desktop app running with
the extension" instead of leaving the button/spinner stuck forever. The
existing 90s staleness check (`Date.now()-p.ts > 90000`) is unchanged —
this only adds the "never even started" case, which that check doesn't
cover today.

## Data flow

Capture (component 1): `content.js` scrapes `og:image`/right-clicked image
→ `captureTab`/`clipCurrentPage` → `durableImage(url)` (now
unconditional) → `fetchAsDataUrl` (extension's elevated cross-origin fetch
permission) → data URL delivered to the app, OR raw URL as last resort if
that fetch failed → `isBadImg()` still flags a raw signed-CDN URL that
slipped through, feeding the existing retry/"Failed captures" tooling
unchanged.

Serving (component 3): `GET /api/img/:id` → `images.getImg` → 0-byte or
missing → `null` → route's existing `if (!buf) res.status(404)` → client's
`onerror` chain (component 2) → favicon → icon. No new server-to-client
contract; the fix is entirely about `getImg`/`putImg` no longer treating
"corrupt" as "fine."

## Error handling

Every fix in this plan makes an existing silent failure loud in a way the
app already knows how to handle (existing retry tooling, existing
`onerror` chain, existing toast pattern) — no new failure-handling UI
concepts are introduced.

## Explicitly out of scope

- Phone-native capture for the PWA (see Scope).
- The Meta-CDN-specific fixes already shipped (`f0d911a`, `16a04ca`) —
  this plan builds on top of them, doesn't redo them.
- Any change to the extension-polling recapture transport itself (still
  `127.0.0.1:345x` polling) — component 4 only makes its failure mode
  visible, doesn't replace the transport.
- A refetch-on-GET fallback for missing images (see component 3's
  reasoning).

## Testing

- `tests/durable-cdn-image.test.js`: `isExpiringCdnImage()`'s own tests
  (it still exists, unchanged, still used by `isBadImg()`) stay valid as-is
  — including the case proving it returns `false` for `ytimg.com`. What
  changes is the `durableImage()` test: today it asserts `durableImage`'s
  source contains `isExpiringCdnImage(url)` as a gate; after this fix it no
  longer does (the gate becomes an already-`data:`/empty-string early-out
  instead). Update that assertion, and add a new one proving `durableImage`
  now attempts `fetchAsDataUrl` for a non-Meta CDN URL (e.g. `ytimg.com`,
  `pinimg.com`) too — i.e. `isExpiringCdnImage` returning `false` no longer
  means `durableImage` skips conversion. Also add a `clipCurrentPage` case
  mirroring the existing `captureTab` ogImage/contentImage-through-
  `durableImage` assertion.
- New assertions in `tests/ux-loop06.test.js` (source-regex pattern against
  `web/index.html`, matching the UX-5 precedent from this session's
  card-sizing fix): `editImgPreview` and `dupeThumb`'s http(s) branch both
  wire up the onerror fallback.
- New cases in `tests/images.test.js` (`core/images.js`, plain Node,
  existing pattern): `putImg` throws on an empty decoded payload;
  `getImg` returns `null` for a 0-byte file on disk (write one directly via
  `fs.writeFileSync`, bypassing `putImg`, to simulate pre-existing
  corruption).
- New assertions in `tests/ux-loop06.test.js` (or a new small test file) for
  `pollBatchProgress`'s no-progress-ever-appeared timeout — source-regex
  against `web/index.html`, same convention.
- `node tests/run.js` must stay clean throughout.
