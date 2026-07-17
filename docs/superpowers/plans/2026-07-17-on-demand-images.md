# On-Demand PWA Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA sync transfers JSON only; images fetch on first view from any peer's Dropbox folder and cache locally; the phone stops uploading images other devices already hold. Spec: `docs/superpowers/specs/2026-07-17-on-demand-images-design.md`.

**Architecture:** (1) a persistent image source map `_pwa_image_sources` built from the per-peer `imageIds`/`imageSizes` each cycle already fetches; (2) `IASync.ensureImage(id)` — idb hit → done; miss → `dbxDownloadBinary` from the mapped folder (token resolved internally by oauth.js; pass `null`), 4-way limited, coalesced; (3) `applyMergeToLocal` applies items directly with no download pool; (4) renderer's `attachCardImages` gates `img.src` behind `Store.ensureImage`; (5) `publishSnapshot`'s `toUpload` subtracts size-matching peer-held ids.

**Tech Stack:** Vanilla JS (browser IIFE), plain Node assert tests via `node tests/run.js`.

## Global Constraints

- Doubt bias everywhere: missing source-map entry ⇒ renderer placeholder (no throw); kv errors ⇒ behave as before the feature; size mismatch or unknown size ⇒ upload/download normally.
- `attachCardImages` and its helpers are NOT byte-parity-enforced between web/pwa, but keep the two copies structurally identical; only `syncNowClick` and `rehydrateAfterSync` are byte-identical (enforced by tests — do not diverge them).
- No changes to: merge semantics, snapshot format, desktop `core/sync.js`, tombstones, watermark/publish-skip semantics (except `imagesFailed` becoming structurally 0 on the PWA — the clean-gate keeps its condition unchanged).
- The Dropbox `images/` folders and existing idb images are never deleted by this feature.
- Suite green after every task (`node tests/run.js`); one SHELL_CACHE bump for the change set: v27 → v28 (Task 2).
- Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; retry git on Dropbox lock errors.

---

### Task 1: Source map + on-demand fetcher

**Files:**
- Modify: `pwa/sync-pwa.js` (source-map maintenance in `runSyncCycle`; new `ensureImage` + helpers; export on `window.IASync`)
- Modify: `pwa/storage-pwa.js` (delegate `ensureImage`)
- Modify: `web/storage.js` (always-true shim)
- Create: `tests/pwa-image-ondemand.test.js`

**Interfaces:**
- Produces: `window.IASync.ensureImage(id) -> Promise<boolean>` (true = image now in idb); `Store.ensureImage(id)` on BOTH storage layers (desktop shim resolves `true` — its images are service-backed). Idb kv key `_pwa_image_sources` = `{ [imageId]: { dir, size } }`.
- Consumes: `Dbx.dbxDownloadBinary(null, path)` (oauth.js resolves the token internally — v1.12.23 behavior), peer `imageIds`/`imageSizes` from `readFullPeerSnapshot` (v27), `sniffImageType`, `idb.get/put/kvGet/kvSet`.

- [ ] **Step 1: failing test** — create `tests/pwa-image-ondemand.test.js` (grab()-extraction pattern; copy the async-aware `grab` from `tests/pwa-oauth-authretry.test.js`):

```js
// tests/pwa-image-ondemand.test.js — on-demand images: source map upkeep,
// idb-first fetcher with coalescing + 4-way cap, and both Store layers
// exposing ensureImage. Spec: docs/superpowers/specs/2026-07-17-on-demand-images-design.md
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "sync-pwa.js"), "utf8");

function grab(source, name) {
  let idx = source.indexOf("async function " + name + "(");
  if (idx < 0) idx = source.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); } }

t("runSyncCycle maintains _pwa_image_sources: read peers replace their own entries over the stored map", () => {
  const body = grab(src, "runSyncCycle");
  assert.ok(/_pwa_image_sources/.test(body), "must persist the source map");
  assert.ok(/p\.imageSizes/.test(body), "must consume per-peer sizes");
  // read-peer entries replace that peer's prior entries; other dirs' entries survive
  assert.ok(/\.dir !== p\.dir|dir: p\.dir/.test(body), "entries must be keyed to the owning peer dir");
});

t("ensureImage: idb hit short-circuits; miss consults the map then downloads, caches, coalesces", () => {
  const body = grab(src, "ensureImage");
  const idbIdx = body.indexOf('idb.get("images"');
  const mapIdx = body.indexOf("_pwa_image_sources");
  const dlIdx = body.indexOf("dbxDownloadBinary");
  assert.ok(idbIdx >= 0 && mapIdx > idbIdx && dlIdx > mapIdx, "order must be idb -> map -> download");
  assert.ok(/dbxDownloadBinary\(null,/.test(body), "token resolved internally — pass null");
  assert.ok(/idb\.put\("images"/.test(body), "downloaded bytes must be cached");
  assert.ok(/sniffImageType/.test(body), "must sniff the real type");
  assert.ok(/_imgInFlight/.test(src), "duplicate requests for one id must coalesce on one promise");
  assert.ok(/_IMG_FETCH_LIMIT = 4|_imgFetchActive/.test(src), "downloads must be concurrency-capped");
});

t("ensureImage never throws to the renderer: all failure paths resolve false", () => {
  const body = grab(src, "ensureImage");
  assert.ok(!/throw /.test(body), "no throws — a missing image is a placeholder, not an error");
  assert.ok(/return false|resolve\(false\)|=> false/.test(body), "failures resolve false");
});

t("both Store layers expose ensureImage (desktop = always-true shim)", () => {
  const pwaStore = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");
  assert.ok(/ensureImage\(id\)/.test(pwaStore) && /IASync\.ensureImage/.test(pwaStore), "pwa Store must delegate to IASync");
  const webStore = fs.readFileSync(path.join(__dirname, "..", "web", "storage.js"), "utf8");
  assert.ok(/ensureImage/.test(webStore), "web Store needs the shim so shared renderer code can call it unconditionally");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2:** run it — expect FAILs (nothing exists).

- [ ] **Step 3: implement.**

In `pwa/sync-pwa.js`, add after `applyMergeToLocal` (module scope):

```js
  // ---- on-demand images (spec 2026-07-17) ----
  // Sync no longer downloads images; the renderer fetches each image on first
  // view via ensureImage(). _pwa_image_sources maps every image id to a peer
  // folder + size, refreshed each cycle from the listings readFullPeerSnapshot
  // already makes. Missing entry ⇒ renderer placeholder (doubt bias).
  const _IMG_FETCH_LIMIT = 4;
  let _imgFetchActive = 0;
  const _imgFetchQueue = [];
  const _imgInFlight = {}; // id -> Promise<boolean>: coalesce duplicate requests

  function _imgSlot() {
    if (_imgFetchActive < _IMG_FETCH_LIMIT) { _imgFetchActive++; return Promise.resolve(); }
    return new Promise((r) => _imgFetchQueue.push(r));
  }
  function _imgRelease() {
    const next = _imgFetchQueue.shift();
    if (next) next(); else _imgFetchActive--;
  }

  async function ensureImage(id) {
    if (!safeImgId(id)) return false;
    if (_imgInFlight[id]) return _imgInFlight[id];
    const p = (async () => {
      try {
        const row = await idb.get("images", id);
        if (row && row.blob) return true;
        const sources = (await idb.kvGet("_pwa_image_sources")) || {};
        const srcInfo = sources[id];
        if (!srcInfo || !srcInfo.dir) return false;
        await _imgSlot();
        try {
          const bytes = await Dbx.dbxDownloadBinary(null, `${srcInfo.dir}/images/${id}.jpg`);
          await idb.put("images", { id, blob: new Blob([bytes]), type: sniffImageType(bytes) });
          return true;
        } finally {
          _imgRelease();
        }
      } catch (e) {
        return false; // 404/offline/auth — placeholder now, retried on a later view
      }
    })();
    _imgInFlight[id] = p;
    p.finally(() => { delete _imgInFlight[id]; });
    return p;
  }
```

Export: extend the bottom line to `window.IASync = { ensureDeviceIdentity, setDeviceLabel, runSyncCycle, ensureImage };`

In `runSyncCycle`, right after the watermark-advance block, maintain the map:

```js
      // Refresh the on-demand image source map: each read peer's entries fully
      // replace its own prior entries; skipped peers' stored entries stay valid
      // (their folders provably didn't change). kv errors ⇒ keep the old map.
      if (peers.length) {
        try {
          const sources = (await idb.kvGet("_pwa_image_sources")) || {};
          for (const p of peers) {
            for (const iid of Object.keys(sources)) {
              if (sources[iid] && sources[iid].dir === p.dir) delete sources[iid];
            }
            const sizes = p.imageSizes || {};
            for (const iid of (p.imageIds || [])) {
              if (safeImgId(iid)) sources[iid] = { dir: p.dir, size: sizes[iid] };
            }
          }
          await idb.kvSet("_pwa_image_sources", sources);
        } catch (e) { console.warn("sync: image source map refresh failed:", e && e.message); }
      }
```

In `pwa/storage-pwa.js`, next to `imgHas`:

```js
    // On-demand image fetch (spec 2026-07-17): resolves true when the image is
    // in idb (already or after fetching from a peer's Dropbox folder).
    ensureImage(id) { return window.IASync && window.IASync.ensureImage ? window.IASync.ensureImage(id) : Promise.resolve(false); },
```

In `web/storage.js`, next to its `imgUrl` (both SE-backed spots — add once on the Store object that the renderer uses):

```js
      // Desktop images are service-backed and always present locally — the
      // shared renderer calls ensureImage unconditionally (spec 2026-07-17).
      ensureImage: function () { return Promise.resolve(true); },
```

- [ ] **Step 4:** `node tests/pwa-image-ondemand.test.js && node tests/pwa-sync-skip.test.js && node tests/syntax-check.js` — PASS.
- [ ] **Step 5:** commit `feat(pwa): on-demand image source map + ensureImage fetcher`.

---

### Task 2: Sync stops downloading images; renderer gates src on ensureImage

**Files:**
- Modify: `pwa/sync-pwa.js` (`applyMergeToLocal` — remove the download classification/pool)
- Modify: `pwa/index.html` + `web/index.html` (`attachCardImages`'s `load` helper — keep the two copies structurally identical)
- Modify: `pwa/sw.js` (SHELL_CACHE v27 → v28)
- Modify tests: `tests/pwa-sync-skip.test.js` (size-reuse assertions replaced — see step directions), plus any test asserting the old download pool.

**Interfaces:** `applyMergeToLocal(plan, accessToken, onProgress)` — the 4th `imageSizeByKey` param is REMOVED again (Task 3 uses the source map instead); return keeps `imagesFailed` (now always 0) for shape stability.

- [ ] **Step 1:** update `tests/pwa-sync-skip.test.js`: REPLACE the "image downloads are skipped when local bytes match the peer's size" test with:

```js
t("applyMergeToLocal applies items directly — no download pool (on-demand images, spec 2026-07-17)", () => {
  const apply = grab(src, "applyMergeToLocal");
  assert.ok(!/dbxDownloadBinary/.test(apply), "the in-cycle image download pool must be gone");
  assert.ok(!/needsImage/.test(apply), "no deferred-image classification — items apply immediately");
  assert.ok(/imagesFailed:\s*0|imagesFailed = 0/.test(apply), "imagesFailed stays in the return shape as 0");
});
```

- [ ] **Step 2:** run — fails against current code.
- [ ] **Step 3: implement.** In `applyMergeToLocal`: delete the `needsImage` array, the size-lookup, the `imageWorker` pool and `IMAGE_DOWNLOAD_CONCURRENCY` usage there (the constant stays — Task 1's fetcher and publish still reference a 4-cap); every safe-id upsert goes straight to `readyCards`/`readySaved`. `imagesFailed`/`imagesReused` collapse to `0` in the return; drop the `imageSizeByKey` param and its `runSyncCycle` call-site threading (Task 3 reuses the persisted map instead). Keep `imageCopiesDone` out of `changed` (it's 0).

In BOTH `pwa/index.html` and `web/index.html`, replace the two `im.src=Store.imgUrl(...)` call sites inside `attachCardImages`'s `load` with a gate:

```js
    const setSrc = (im, id) => { Store.ensureImage(id).then(()=>{ im.src = Store.imgUrl(id); }); };
```
— defined at the top of `attachCardImages`, used as `setSrc(im, idbId)` and `setSrc(im, String(s).slice(4))`. (Desktop's shim resolves immediately; the PWA fetches on miss and the existing `onerror` placeholder chain covers a still-missing image.)

`pwa/sw.js`: SHELL_CACHE v27 → v28.

- [ ] **Step 4:** `node tests/run.js` — ALL PASS (adapt any other test asserting the old pool, citing the spec; never weaken unrelated assertions).
- [ ] **Step 5:** commit `feat(pwa): sync applies items instantly; images fetch on first view`.

---

### Task 3: Upload dedup

**Files:**
- Modify: `pwa/sync-pwa.js` (`publishSnapshot` — `toUpload` subtraction)
- Modify: `tests/pwa-sync-skip.test.js` (new assertions)

- [ ] **Step 1:** add failing assertions to `tests/pwa-sync-skip.test.js`:

```js
t("publish skips uploading images any peer folder already holds at the same size (upload dedup)", () => {
  const body = grab(src, "publishSnapshot");
  assert.ok(/_pwa_image_sources/.test(body), "must consult the source map");
  assert.ok(/heldByPeer|peerHeld/.test(body), "must subtract peer-held ids from toUpload");
  assert.ok(/\.size === /.test(body), "peer-held only counts on a size match — a different-size image still uploads");
});
```

- [ ] **Step 2:** run — fails.
- [ ] **Step 3: implement** in `publishSnapshot`, where `toUpload` is computed:

```js
    // Upload dedup (spec 2026-07-17): an image already present in ANY peer's
    // folder (same size) doesn't need a second copy in ours — on-demand
    // readers fetch from any holder, and desktops already hold the bytes
    // locally. Unknown size or no entry ⇒ upload (doubt bias). Own-folder
    // entries continue to short-circuit via alreadyPublished as before.
    let peerSources = {};
    try { peerSources = (await idb.kvGet("_pwa_image_sources")) || {}; } catch (e) { peerSources = {}; }
    const peerHeld = async (id) => {
      const s = peerSources[id];
      if (!s || typeof s.size !== "number") return false;
      const row = await idb.get("images", id);
      return !!(row && row.blob && row.blob.size === s.size);
    };
    const candidates = [...localImageIds].filter((id) => !alreadyPublished.has(id));
    const toUpload = [];
    for (const id of candidates) { if (!(await peerHeld(id))) toUpload.push(id); }
```

- [ ] **Step 4:** `node tests/run.js` — ALL PASS.
- [ ] **Step 5:** commit `feat(pwa): publish skips images any peer already holds — kills redundant upload backlogs`, then push (PWA auto-deploys; verify deployed SHELL_CACHE v28). Desktop `web/` changes ride the next installer release (bundled with the auto-import feature).
