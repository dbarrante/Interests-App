# Design: App resilience — Scale & render (Pillar 2)

Date: 2026-06-22
App: Interests App (`index.html`, single-file vanilla web app; no backend). Card images in IndexedDB `ia_img`/`imgs` (data URLs keyed by card id), referenced as `it.img = "idb:<id>"`; `_imgCache` is an in-memory mirror. Saved/feed cards render via `cardHTML()`; Imported via `impCardHTML()`.

Pillar 2 of the resilience roadmap (Pillar 1 — data durability — shipped). Delivered in **two phases**, each shippable and verifiable on its own.

---

## Goal

1. **No render path can build a >512 MB HTML string** (the `RangeError: Invalid string length` that already hit the Imported grid and the backup). Imported is fixed; Saved/Feed/Stumble (`cardHTML`) still inline image data URLs — latent today (~18 saved items) but a ticking bomb.
2. **Stop holding ~630 MB of images in memory and reading them all on every boot.** `initImageStore` currently does `_imgCache = await idbAllImgs()` (all 4,303 images). Load images **on demand** instead, with a bounded cache.

Success: scrolling any grid loads images just-in-time; resident image memory stays bounded (not ~630 MB); boot no longer reads the whole image store; FB placeholder detection, backup/restore, and the edit dialog all still work.

---

## Current state (grounded)

- `cardHTML(item, mode)` (index.html:736) builds Feed/Saved/Stumble cards. It inlines `chain[0]` (from `imageChain(item)`, :712) as `<img src="…">`; `imgChains[id]=chain.slice(1)` powers the `onerror="nextImg(...)"` fallback. `chain[0]` may be a big `data:` URL (idb-resolved card image or an inline saved-clip image) or a tiny `http(s)` URL.
- `findItem(id)` (:793) = `feed.find … || saved.find …`.
- `attachCardImages()` (:2036) is **Imported-grid-only**: it observes `#view-imported .imp-grid img.th[data-imgid]` and sets `src` synchronously from `_imgCache`. `renderImported` calls it; `renderFeed`/`renderSaved`/`renderStumble` do **not**.
- `initImageStore` (:~594) does `_imgCache = await idbAllImgs()` (loads everything).
- `resolveImg(v)` is synchronous: `idb:` → `_imgCache[id]`, else `v`.
- `setCardImage`/`setSavedImage` write images (data URL → IDB + `_imgCache[id]`; http → inline `it.img`).
- `fbPlaceholderGroups(minCount)` groups FB cards by `imgFp(_imgCache[id])` — **requires every image in `_imgCache`**. `fbPlaceholderCount()` (toolbar "Fix N") calls it. `imgFp(d)` (length+head+tail) already exists.
- IDB helpers: `idbPutImg`, `idbDelImg`, `idbAllImgs`, `idbAllKeys` exist; **no single-image get** yet.
- Backup `writeFullBackupDir` uses `idbAllImgs()` transiently (occasional — fine to keep).

---

## Phase A — Crash-proof Saved/Feed/Stumble (ships + validated first)

Low-risk; mirrors the working Imported pattern.

1. **`cardHTML` emits a placeholder for big images.** Compute `first = chain[0]`. If `first` is a big `data:` URL **or** the item's stored image is an `idb:` ref, emit `<img data-imgsrc="<id>" loading="lazy" data-grad/data-fav/data-dom onerror="nextImg(...)" onload="mshotsRetry(...)">` (no `src`). Otherwise keep `<img src="<first>" …>` inline (tiny http thumbs + the proxy fallback chain stay exactly as today).
2. **Generalize `attachCardImages()`** to observe both selectors across the whole document: `img[data-imgid]` (Imported, resolve from the card cache) and `img[data-imgsrc]` (cardHTML; resolve the item's image: `const it=findItem(id); let s=it&&it.image; if(s && s.indexOf("idb:")===0) s=<resolved>; if(s) im.src=s;`). Keep the IntersectionObserver + 800px rootMargin. In Phase A the resolve is synchronous from `_imgCache` (still preloaded); Phase B swaps in the async getter.
3. **Call `attachCardImages()`** at the end of `renderFeed` and `renderSaved` (after `innerHTML`), as `renderImported` already does. (`renderStumble` renders a **single** card, so it can't overflow the string limit — it's not a crash risk and is out of scope for Phase A; it still benefits in Phase B by going through the same on-demand loader if it shares `cardHTML`.)
4. **Audit**: confirm the only multi-card `.map(...).join("")`/`innerHTML` paths that can inline big data URLs are the Feed, Saved, and Imported grids; document the result in the plan.

**Phase A is independently shippable** — after it, no render path inlines big data URLs.

---

## Phase B — Memory diet (on-demand image loading)

Risk is concentrated here (synchronous → async image resolution + decoupling placeholder detection), so it lands after Phase A is verified.

### B1. On-demand image cache
- **New `idbGetImg(id)`** — async, reads one image from `ia_img`/`imgs`.
- **Bounded cache.** Keep `_imgCache` as a plain object (so existing `_imgCache[id]` reads keep working) plus an insertion-order key list `_imgCacheKeys`. New `cachePut(id, data)` adds and, when `_imgCacheKeys.length > IMG_CACHE_MAX` (≈600), evicts the oldest (`delete _imgCache[old]`). All image writers (`setCardImage`, `setSavedImage`, the on-demand loader) go through `cachePut`.
- **`initImageStore` no longer preloads.** Drop `_imgCache = await idbAllImgs()`. Still load image **keys** (`idbAllKeys()`) for the existing relink + favicon-sweep logic (unchanged — those already use `imgKeys`, not the values). `_imgCache` starts empty/bounded.
- **`attachCardImages` loads on demand**: on intersect, if the `<img>` has no `src`, `await idbGetImg(id)` (for an `idb:` source) → `cachePut` → set `src`. Inline `data:`/`http` sources (saved clips stored inline) are used directly without IDB. Only what scrolls into view is decoded/held.

### B2. Decouple placeholder detection from the cache
- **Persistent fingerprint map.** A small separate IndexedDB DB `ia_fp` (store `fp`, `id → fp`), mirrored in memory as `_fpMap` (≈430 KB), loaded on boot. Helpers `fpPut/fpDel/fpAll`.
- `setCardImage` (data branch) computes `imgFp(src)` → `_fpMap[id]=fp` + `fpPut`. The clear branch deletes `_fpMap[id]` + `fpDel`.
- **`fbPlaceholderGroups` groups FB cards by `_fpMap[it.id]`** (skip cards with no fp) — no image loads. `fbPlaceholderCount` stays cheap.
- **One-time migration** (`localStorage ia_fp_migrated` flag): on boot, if there are `idb:` images lacking an `_fpMap` entry, load-all **once** (with the Phase-1 progress overlay: "Optimizing image index — one time…"), compute + `fpPut` each fp, set the flag. Never loads-all again. (`drainCaptures`' existing `_phFps` reject set is unaffected.)

### B3. Caller adjustments
- **`impCardHTML`**: emit a `data-imgid` placeholder for any `idb:` card **directly** (don't depend on `impThumb` returning a cached value). For non-idb sources keep the current `impThumb` logic (http/YouTube/mshots/favicon). (`impThumb` returning `""`/null for an un-cached idb ref must NOT fall through to a favicon.)
- **`impEdit`**: the edit-dialog image preview becomes async — `await idbGetImg(id)` when opening (instead of sync `resolveImg`).
- **`resolveImg`** stays synchronous (cache-or-`""`); it's now a best-effort cache read, and the lazy-attach path is the source of truth for display.
- **Backup/restore unchanged** — `writeFullBackupDir`/restore use transient `idbAllImgs`/`idbPutImg`; not the bounded cache.

---

## Data / stores / constants

- New IDB DB `ia_fp` (store `fp`, `id→fp`); in-memory `_fpMap`.
- `localStorage ia_fp_migrated` — one-time migration flag.
- `IMG_CACHE_MAX` (≈600) + `_imgCacheKeys` (eviction order).
- New `idbGetImg(id)`; `cachePut(id,data)` wraps `_imgCache` writes.
- Reused as-is: `idbAllKeys` (boot relink/sweep), `idbAllImgs` (backup/migration only), `imgFp`, the IntersectionObserver in `attachCardImages`.

---

## Edge cases & error handling

- **Off-screen / never-scrolled cards**: `<img>` with no `src` renders as an empty sized box until near the viewport (intended lazy behavior; 800px margin loads ahead of view).
- **`idbGetImg` miss** (image evicted/gone): `onerror`/favicon fallback for cardHTML; Imported shows its existing favicon fallback. No crash.
- **Migration interrupted** (tab closed mid-backfill): the flag isn't set → it retries next boot (idempotent `fpPut`).
- **Non-Chromium / IndexedDB unavailable**: `idbGetImg` returns ""; cards show favicons; no crash (matches today's degraded behavior).
- **Re-scroll after eviction**: image reloads from IDB (~150 KB, fast) — accepted trade-off for bounded memory.
- **`fbPlaceholderGroups` pre-migration**: returns nothing until `_fpMap` is populated (migration runs on first boot) — acceptable; placeholder ops are user-initiated.

---

## Testing

- **Node unit tests** (existing `tests/` harness): the bounded-cache eviction logic — extract a pure `evictKeys(keys, max)` (or `cachePut` core) and test add/evict/cap; `imgFp` already covered. Run `node tests/syntax-check.js` (0 errors) + `node tests/durability.test.js`.
- **Manual (Phase A):** load Saved/Feed → images appear; create many image-bearing saved clips (or simulate) → no `RangeError`; scroll → lazy-load works.
- **Manual (Phase B):** cold boot → DevTools Memory shows resident image memory bounded (not ~630 MB) and no all-images read; scroll Imported/Saved → images load just-in-time; "Fix N placeholders" still detects spinner groups; edit dialog shows the card image; backup + restore still round-trip; the one-time migration runs once (overlay) and not again.

---

## Non-goals / roadmap

- No change to capture, dedup, or the backup format (Pillar 1).
- Incremental/perceptual image work is out of scope.
- Remaining pillars after this: 3 broader capture/dedup tests, 4 diagnostics panel + transient-load retry + surfacing swallowed errors.
