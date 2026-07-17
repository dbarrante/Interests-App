# On-demand images on the PWA — design

## Problem

The PWA syncs the entire image library up front: every merged card with an
`idb:` image queues a download during the sync cycle, and first-sync/catch-up
transfers thousands of images (~500MB) that must complete in iOS foreground
time. Live 2026-07-16/17: multi-hour "downloading images" sessions that pause
whenever the device locks or the user switches apps. The card DATA is ~4MB;
the images are ~98% of the transfer and most are never looked at on mobile.

Decision (user, 2026-07-17): flip the PWA to **on-demand images** — sync JSON
only; fetch each image the first time it's rendered; cache locally. Also
include the now-nearly-free **upload dedup** (skip uploading images any peer
folder already holds) because on-demand sourcing dissolves the constraint
that made it unsafe, and the phone's multi-thousand-image upload backlog is
the other half of the "hours" problem. Desktop behavior unchanged (local fs
copies are cheap).

## Design

### 1. Image source map (`pwa/sync-pwa.js`)

Each sync cycle already lists every peer's `images/` folder with sizes
(`readFullPeerSnapshot` → `imageIds` + `imageSizes`, added v27). Persist the
union to idb kv as `_pwa_image_sources`:

```
{ <imageId>: { dir: "/Interests App/sync/<deviceId>", size: <bytes> }, ... }
```

- Rebuilt each cycle from the peers actually read this cycle, MERGED over the
  stored map (skipped peers didn't change, so their stored entries stay
  valid; a peer read this cycle fully replaces its own prior entries —
  entries whose `dir` belongs to a re-read peer but which vanished from its
  listing are dropped).
- Own-device entries are included too (from `_pwa_published_imgids_<id>` +
  local sizes) so a second PWA device can fetch what this one published.

### 2. Sync applies items immediately; no image downloads in the cycle

`applyMergeToLocal`: the `needsImage` classification and the 4-worker
download pool are REMOVED for the PWA. Every upsert applies directly
(cards/saved written in the existing batched transactions). Consequences:
- `imagesFailed` is always 0 from downloads (the counter stays for the API
  shape and future use); the watermark clean-gate now hinges on
  `applyFailures`/`partialFailures` only — deferral-by-image no longer
  exists on the PWA, so items never lag their images.
- A huge catch-up cycle becomes: read snapshots → write rows → publish.
  Minutes, dominated by the ~4MB snapshot downloads.

### 3. On-demand fetcher (`pwa/storage-pwa.js` + `pwa/index.html`)

New `Store.ensureImage(id)`:
1. `idb.get("images", id)` — hit ⇒ return it (today's path).
2. Miss ⇒ look up `_pwa_image_sources[id]`; absent ⇒ return null (renderer
   keeps its existing placeholder/favicon fallback).
3. Fetch `dbxDownloadBinary(token, `${dir}/images/${id}.jpg`)` through the
   existing auth choke point; `idb.put("images", ...)` (sniffed type);
   return the row. 404/network ⇒ null (renderer fallback; retried next view).
4. **Concurrency-limited queue (4)** shared module-wide, so a fast scroll
   doesn't stampede Dropbox; duplicate in-flight requests for the same id
   coalesce on one promise.
5. Not connected to Dropbox ⇒ step 1 only (cached images still render
   offline; uncached show placeholders).

Renderer wiring: `attachCardImages` (and the reader-view image resolver)
currently read the images store directly on `idb:` refs; they switch to
`Store.ensureImage(id)`. Loading state = the existing placeholder until the
promise resolves; no new UI.

Desktop `web/storage.js` gets a no-op-compatible `ensureImage` (serves from
the Core service as today) so the renderer wiring stays byte-identical where
shared.

### 4. Upload dedup (`publishSnapshot`, `pwa/sync-pwa.js`)

`toUpload = localImageIds − ownFolder(cache) − heldByAnyPeer`, where
`heldByAnyPeer` = ids in `_pwa_image_sources` whose size matches the local
blob's size (size mismatch ⇒ upload — it's a genuinely different image).

Safety argument: a reader that needs image X for a card this device won
either (a) is a PWA — fetches from any holder via its own source map; or
(b) is a desktop — desktops hold the full library locally (`hasImg` passes)
or defer one cycle until Dropbox's own client syncs it; the origin device's
folder entry is what our source map saw, so the bytes exist remotely.
Genuinely new images (phone captures) are in no peer folder ⇒ uploaded
exactly as today. The device's OWN folder keeps its existing images —
nothing is deleted; dedup only avoids NEW redundant uploads.

### 5. What does NOT change

- Snapshot format, merge semantics, tombstones, watermarks, publish-skip —
  untouched (the source map rides on listings already fetched).
- Desktop sync (`core/sync.js`) — fully unchanged.
- Existing images already in a device's idb — stay; no eviction in v1
  (the cache only grows by what's actually viewed; a future LRU cap is
  explicitly deferred).
- The Dropbox `images/` folders — never pruned by this feature.

## Error handling

Every miss degrades to the renderer's existing placeholder path and retries
on the next render. AUTH_EXPIRED from an on-demand fetch surfaces through
the same classified error path (toast once via the existing machinery — the
fetcher swallows per-image errors, connection state is handled by sync).

## Testing

- `tests/pwa-image-sources.test.js` — source-scan + extraction: source map
  built by merging read-peers over stored entries; own entries included;
  `ensureImage` order (idb → map → download → cache), coalescing, cap of 4.
- `tests/pwa-sync-skip.test.js` update — applyMergeToLocal no longer
  downloads (needsImage/pool gone); clean-gate condition updated.
- Upload-dedup: assertions that `toUpload` subtracts size-matching
  peer-held ids; new-image (no source entry) still uploads.
- Renderer wiring: `attachCardImages` uses `Store.ensureImage`.
- Full suite green; SHELL_CACHE bump.

## Rollout

- PWA-only (auto-deploys). Old PWA versions keep bulk-downloading — fine.
- The iPhone's pending upload backlog shrinks to genuinely-unique images the
  moment this ships (its next publish diff subtracts peer-held ids).
