# Scale & Render (Resilience Pillar 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No render path can build a >512 MB HTML string (crash-proof Saved/Feed like Imported already is), and stop holding/loading all ~630 MB of images in memory (load on demand with a bounded cache), without breaking FB placeholder detection, the edit dialog, or backup/restore.

**Architecture:** Two phases. **Phase A** extends the working Imported lazy-image pattern (`<img>` placeholder + post-render `attachCardImages` via IntersectionObserver) to `cardHTML` (Feed/Saved). **Phase B** swaps the synchronous preloaded `_imgCache` for an on-demand bounded LRU (`idbGetImg` + `cachePut`/`lruPush`), drops the all-images boot read, and decouples FB placeholder detection to a persistent `id→fp` map (`ia_fp` IndexedDB) backfilled once. Phase A ships and is verified before Phase B.

**Tech Stack:** Vanilla JS (single-file `index.html`), IndexedDB, IntersectionObserver; Node (no deps) for the test harness.

**Spec:** `docs/superpowers/specs/2026-06-22-app-resilience-scale-render-design.md`

**Conventions:**
- All app code is inline in `index.html`; no build step. After ANY edit run `node tests/syntax-check.js` — must print `0 error(s)`.
- Pure, Node-testable helpers must be **top-level** functions with the closing `}` at column 0 (the `tests/_extract.js` regex requires it).
- Commit after each task. Branch first (don't implement on `master`).

---

## Task 0: Branch

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git checkout -b resilience-scale-render
git rev-parse --abbrev-ref HEAD
```
Expected: `resilience-scale-render`

---

## Task A1: Generalize `attachCardImages` to all grids

**Files:** Modify `index.html` (`attachCardImages`, ~line 2032).

- [ ] **Step 1: Replace `attachCardImages` with a version handling both placeholder types**

Find `function attachCardImages(){ … }` and replace its body with:

```js
function attachCardImages(){
  try{
    const imgs = document.querySelectorAll("img[data-imgid],img[data-imgsrc]");
    if(!imgs.length){ if(_imgObserver){ _imgObserver.disconnect(); _imgObserver=null; } return; }
    if(_imgObserver) _imgObserver.disconnect();
    const load = im=>{
      if(im.getAttribute("src")) return;
      const idbId = im.getAttribute("data-imgid");      // Imported card: image keyed by card id
      if(idbId){ const d=_imgCache[idbId]; if(d) im.src=d; return; }
      const sid = im.getAttribute("data-imgsrc");        // Feed/Saved card: resolve the item's image
      if(sid){ const it=findItem(sid); let s=it&&it.image; if(s && String(s).indexOf("idb:")===0) s=_imgCache[String(s).slice(4)]||""; if(s) im.src=s; else nextImg(im, sid); }
    };
    if(!("IntersectionObserver" in window)){ imgs.forEach(load); return; }
    _imgObserver=new IntersectionObserver((entries,obs)=>{ for(const e of entries){ if(e.isIntersecting){ load(e.target); obs.unobserve(e.target); } } },{root:null,rootMargin:"800px 0px"});
    imgs.forEach(im=>_imgObserver.observe(im));
  }catch(e){ console.warn("attachCardImages failed",e); }
}
```

- [ ] **Step 2: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `2 script block(s), 0 error(s)`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(render): attachCardImages serves all grids (data-imgid + data-imgsrc)"
```

---

## Task A2: `cardHTML` emits placeholders; renderers attach (Phase A complete)

**Files:** Modify `index.html` (`cardHTML` ~736; `renderFeed` ~770; `renderSaved` ~788).

- [ ] **Step 1: Replace the `<img>` emit in `cardHTML`**

In `cardHTML`, replace this block:
```js
      ${first?`<img src="${esc(first)}" loading="lazy" data-grad="${grad}" data-fav="${esc(fav)}" data-dom="${esc(dom)}"
                onerror="nextImg(this,'${id}')" onload="mshotsRetry(this)">`
             :`<div class="ph" style="background:linear-gradient(135deg,${grad})">${fav?`<img src="${esc(fav)}">`:""}${esc(dom||"idea")}</div>`}
```
with (note: a new `bigImg`/`imgAttrs`/`imgTag` computed just above the `return`, then used in the template):
```js
      ${imgTag}
```
And immediately **before** `return \`<div class="card"…`, add:
```js
  // Big image data URLs (idb-resolved card images or inline saved-clip images) must
  // NOT be inlined into the joined grid HTML — thousands overflow JS's ~512 MB string
  // limit (RangeError, same bug fixed in Imported). Emit a placeholder; attachCardImages
  // fills src after render (IntersectionObserver). Tiny http(s) thumbs stay inline.
  const bigImg = item.image && (String(item.image).indexOf("idb:")===0 || String(item.image).indexOf("data:")===0);
  const imgAttrs = `loading="lazy" data-grad="${grad}" data-fav="${esc(fav)}" data-dom="${esc(dom)}" onerror="nextImg(this,'${id}')" onload="mshotsRetry(this)"`;
  const imgTag = bigImg
    ? `<img data-imgsrc="${id}" ${imgAttrs}>`
    : (first ? `<img src="${esc(first)}" ${imgAttrs}>` : `<div class="ph" style="background:linear-gradient(135deg,${grad})">${fav?`<img src="${esc(fav)}">`:""}${esc(dom||"idea")}</div>`);
```

- [ ] **Step 2: Call `attachCardImages` after the Feed grid renders**

In `renderFeed`, change:
```js
  grid.innerHTML = list.map(i=>cardHTML(i,"feed")).join("");
```
to:
```js
  grid.innerHTML = list.map(i=>cardHTML(i,"feed")).join("");
  attachCardImages();
```

- [ ] **Step 3: Call `attachCardImages` after the Saved grid renders**

In `renderSaved`, change:
```js
  g.innerHTML = list.map(i=>cardHTML(i,"saved")).join("");
```
to:
```js
  g.innerHTML = list.map(i=>cardHTML(i,"saved")).join("");
  attachCardImages();
```

- [ ] **Step 4: Audit for other big-string joins**

Run: `node -e "const h=require('fs').readFileSync('index.html','utf8'); for(const m of h.matchAll(/(\w+)\.map\([^)]*=>[^)]*\)\.join\(\"\"\)/g)) console.log(m[1]);"`
Confirm the only matches that build cards are the Feed/Saved/Imported grids (Stumble is a single card). Note the result in the commit message. (`renderStumble` renders one card — not a string-overflow risk.)

- [ ] **Step 5: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `0 error(s)`

- [ ] **Step 6: Manual verification (Phase A)**

In Chrome at `localhost:3456`: open **Saved** and **Feed** → cards show images (lazy-fill as you scroll). Hard-reload → no console `RangeError`. (Saved is small today; the fix is structural.)

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(render): crash-proof Saved/Feed grids via data-imgsrc placeholders (Phase A complete)"
```

---

## Task B1: Bounded LRU cache (pure `lruPush` + `cachePut`)

**Files:** Modify `index.html` (near `_imgCache`, ~562; `setCardImage` ~580; `setSavedImage` ~3777). Modify `tests/durability.test.js`.

- [ ] **Step 1: Write the failing test for `lruPush`**

In `tests/durability.test.js`, change the `loadFns` line to also load `lruPush`:
```js
const { pickBackupsToDelete, backupCountsMatch, lruPush } = loadFns(["pickBackupsToDelete", "backupCountsMatch", "lruPush"]);
```
And add before the final `console.log`:
```js
t("lruPush appends new id, trims to max (oldest dropped)", () => {
  assert.deepStrictEqual(lruPush(["a","b","c"], "d", 3), ["b","c","d"]);
});
t("lruPush moves an existing id to the end", () => {
  assert.deepStrictEqual(lruPush(["a","b","c"], "b", 3), ["a","c","b"]);
});
t("lruPush under max keeps all", () => {
  assert.deepStrictEqual(lruPush(["a","b"], "c", 5), ["a","b","c"]);
});
t("lruPush max 0 → empty", () => {
  assert.deepStrictEqual(lruPush(["a"], "b", 0), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/durability.test.js`
Expected: throws `function not found in index.html: lruPush` — red.

- [ ] **Step 3: Add `lruPush`, `IMG_CACHE_MAX`, `_imgCacheKeys`, `cachePut`**

Replace the line `let _imgDB=null, _imgCache={};` with:
```js
let _imgDB=null, _imgCache={};
const IMG_CACHE_MAX = 600;        // bound the in-memory image mirror (was: all ~630 MB)
let _imgCacheKeys = [];           // cache ids in LRU order (oldest first)
// Pure: return the new key order after touching `id` (move-to-end), trimmed to `max`.
function lruPush(keys, id, max){
  const out = (keys || []).filter(function(k){ return k !== id; });
  out.push(id);
  return out.length > max ? out.slice(out.length - max) : out;
}
// Put an image in the bounded cache, evicting whatever fell out of the LRU window.
function cachePut(id, data){
  if(id == null) return;
  _imgCache[id] = data;
  const next = lruPush(_imgCacheKeys, id, IMG_CACHE_MAX);
  if(next.length < _imgCacheKeys.length + 1){
    const keep = {}; for(const k of next) keep[k] = 1;
    for(const k of _imgCacheKeys){ if(!keep[k]) delete _imgCache[k]; }
  }
  _imgCacheKeys = next;
}
```

- [ ] **Step 4: Route `setCardImage` writes through `cachePut`**

In `setCardImage`, change:
```js
  if(src && src.indexOf("data:")===0){
    _imgCache[it.id]=src;
    it.img="idb:"+it.id;
    idbPutImg(it.id, src);   // persisted async; cache makes render immediate
  } else {
```
to:
```js
  if(src && src.indexOf("data:")===0){
    cachePut(it.id, src);
    it.img="idb:"+it.id;
    idbPutImg(it.id, src);   // persisted async; cache makes render immediate
  } else {
```

- [ ] **Step 5: Route `setSavedImage` writes through `cachePut`**

In `setSavedImage`, change:
```js
  if(src && src.indexOf("data:")===0){ _imgCache[item.id]=src; item.image="idb:"+item.id; idbPutImg(item.id, src); }
```
to:
```js
  if(src && src.indexOf("data:")===0){ cachePut(item.id, src); item.image="idb:"+item.id; idbPutImg(item.id, src); }
```

- [ ] **Step 6: Run unit tests + syntax gate**

Run: `node tests/durability.test.js`
Expected: `12 passed, 0 failed`
Run: `node tests/syntax-check.js`
Expected: `0 error(s)`

- [ ] **Step 7: Commit**

```bash
git add index.html tests/durability.test.js
git commit -m "feat(img): bounded LRU image cache (lruPush pure+tested, cachePut)"
```

---

## Task B2: `idbGetImg` + persistent fingerprint store (`ia_fp`)

**Files:** Modify `index.html` (after `idbAllKeys`, ~577).

- [ ] **Step 1: Add `idbGetImg` and the `ia_fp` helpers**

Immediately after the `idbAllKeys` function (line ~577), add:
```js
// fetch ONE image by id (on-demand; replaces loading the whole store into memory)
async function idbGetImg(id){ try{ const db=await imgDB(); return await new Promise((res)=>{ const rq=db.transaction("imgs","readonly").objectStore("imgs").get(id); rq.onsuccess=()=>res(rq.result||""); rq.onerror=()=>res(""); }); }catch(e){ return ""; } }
// Tiny separate DB mapping card id -> image fingerprint, so FB placeholder detection
// (fbPlaceholderGroups) never needs the image bytes in memory. Mirrored in _fpMap.
let _fpDB=null, _fpMap={};
function fpDB(){ return new Promise((res,rej)=>{ if(_fpDB) return res(_fpDB); let rq; try{ rq=indexedDB.open("ia_fp",1); }catch(e){ return rej(e); } rq.onupgradeneeded=()=>{ if(!rq.result.objectStoreNames.contains("fp")) rq.result.createObjectStore("fp"); }; rq.onsuccess=()=>{ _fpDB=rq.result; res(_fpDB); }; rq.onerror=()=>rej(rq.error); }); }
async function fpPut(id, fp){ try{ const db=await fpDB(); await new Promise((res,rej)=>{ const tx=db.transaction("fp","readwrite"); tx.objectStore("fp").put(fp,id); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); }); }catch(e){} }
async function fpDel(id){ try{ const db=await fpDB(); await new Promise((res)=>{ const tx=db.transaction("fp","readwrite"); tx.objectStore("fp").delete(id); tx.oncomplete=res; tx.onerror=res; }); }catch(e){} }
async function fpAll(){ try{ const db=await fpDB(); return await new Promise((res)=>{ const out={}; const cur=db.transaction("fp","readonly").objectStore("fp").openCursor(); cur.onsuccess=e=>{ const c=e.target.result; if(c){ out[c.key]=c.value; c.continue(); } else res(out); }; cur.onerror=()=>res(out); }); }catch(e){ return {}; } }
```

- [ ] **Step 2: Record/clear the fingerprint in `setCardImage`**

In `setCardImage` (now using `cachePut`), make the two branches maintain `_fpMap`:
```js
function setCardImage(it, src){
  if(src && src.indexOf("data:")===0){
    cachePut(it.id, src);
    it.img="idb:"+it.id;
    idbPutImg(it.id, src);   // persisted async; cache makes render immediate
    const fp = imgFp(src); _fpMap[it.id]=fp; fpPut(it.id, fp);   // for placeholder detection without loading bytes
  } else {
    it.img=src||"";
    if(_imgCache[it.id]){ delete _imgCache[it.id]; idbDelImg(it.id); }
    if(_fpMap[it.id]){ delete _fpMap[it.id]; fpDel(it.id); }
  }
}
```

- [ ] **Step 3: Syntax gate + commit**

Run: `node tests/syntax-check.js` → `0 error(s)`
```bash
git add index.html
git commit -m "feat(img): idbGetImg + ia_fp fingerprint store; setCardImage records fp"
```

---

## Task B3: `fbPlaceholderGroups` groups by `_fpMap` (no image bytes)

**Files:** Modify `index.html` (`fbPlaceholderGroups`, ~1866).

- [ ] **Step 1: Replace the cache-read grouping with the fp-map grouping**

Replace:
```js
  for(const it of imported){
    if(!it || !it.id || !/facebook\.com|fb\.watch/i.test(it.url||"")) continue;
    const v=(it.img||"")+""; if(v.indexOf("idb:")!==0) continue;
    const data=_imgCache[v.slice(4)]; if(!data) continue;
    const key=imgFp(data);
    (byImg[key]=byImg[key]||[]).push(it);
  }
```
with:
```js
  for(const it of imported){
    if(!it || !it.id || !/facebook\.com|fb\.watch/i.test(it.url||"")) continue;
    if((it.img||"").indexOf("idb:")!==0) continue;
    const key=_fpMap[it.id]; if(!key) continue;   // fingerprint stored at capture time / migration — no image load
    (byImg[key]=byImg[key]||[]).push(it);
  }
```

- [ ] **Step 2: Syntax gate + commit**

Run: `node tests/syntax-check.js` → `0 error(s)`
```bash
git add index.html
git commit -m "feat(img): fbPlaceholderGroups uses _fpMap instead of in-memory images"
```

---

## Task B4: Stop the all-images boot read; load `_fpMap`; one-time fp migration

**Files:** Modify `index.html` (`initImageStore`, ~594).

- [ ] **Step 1: Drop the preload; load `_fpMap`; run the one-time migration**

In `initImageStore`, replace:
```js
  _imgCache = await idbAllImgs();
  const imgKeys = new Set(await idbAllKeys());             // image ids that exist in IndexedDB (cheap, reliable)
  const cacheLoaded = imgKeys.size > 0;                    // blobs exist in the store?
```
with:
```js
  // Do NOT load all images into memory — they're fetched on demand (idbGetImg) into
  // the bounded LRU cache. Only the cheap key list is needed for relink/sweep below.
  const imgKeys = new Set(await idbAllKeys());             // image ids that exist in IndexedDB (cheap, reliable)
  const cacheLoaded = imgKeys.size > 0;                    // blobs exist in the store?
  _fpMap = await fpAll();                                  // small id->fingerprint map for placeholder detection
  // ONE-TIME migration: backfill fingerprints for images that predate _fpMap. Loads
  // all images once (with the progress overlay), then never again.
  try{
    if(cacheLoaded && !localStorage.getItem("ia_fp_migrated")){
      let need=false; for(const it of imported){ if((it.img||"").indexOf("idb:")===0 && !_fpMap[it.id]){ need=true; break; } }
      if(need){
        if(typeof showBusyOverlay==="function") showBusyOverlay("Optimizing image index (one time)…");
        const all = await idbAllImgs();
        for(const id of Object.keys(all)){ if(!_fpMap[id]){ const fp=imgFp(all[id]); _fpMap[id]=fp; await fpPut(id, fp); } }
        if(typeof hideBusyOverlay==="function") hideBusyOverlay();
      }
      localStorage.setItem("ia_fp_migrated","1");
    }
  }catch(e){ console.warn("fp migration failed", e); if(typeof hideBusyOverlay==="function") hideBusyOverlay(); }
```

- [ ] **Step 2: Syntax gate**

Run: `node tests/syntax-check.js` → `0 error(s)`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(img): drop all-images boot read; load _fpMap; one-time fp migration"
```

---

## Task B5: On-demand image loading in `attachCardImages` + `impCardHTML`

**Files:** Modify `index.html` (`attachCardImages` ~2032; `impCardHTML` ~2641).

- [ ] **Step 1: Make `attachCardImages`'s loader async (fetch on demand)**

Replace the `const load = im=>{ … };` inside `attachCardImages` with:
```js
    const load = async im=>{
      if(im.getAttribute("src")) return;
      const idbId = im.getAttribute("data-imgid");        // Imported card: keyed by card id
      if(idbId){ let d=_imgCache[idbId]; if(!d){ d=await idbGetImg(idbId); if(d) cachePut(idbId,d); } if(d) im.src=d; return; }
      const sid = im.getAttribute("data-imgsrc");          // Feed/Saved card: resolve the item's image
      if(sid){ const it=findItem(sid); let s=it&&it.image; if(s && String(s).indexOf("idb:")===0){ const k=String(s).slice(4); s=_imgCache[k]; if(!s){ s=await idbGetImg(k); if(s) cachePut(k,s); } } if(s) im.src=s; else nextImg(im, sid); }
    };
```

- [ ] **Step 2: `impCardHTML` emits the idb placeholder independent of the cache**

In `impCardHTML`, change:
```js
  const isIdbImg = thumb && it.img && String(it.img).indexOf("idb:")===0;
```
to:
```js
  const isIdbImg = it.img && String(it.img).indexOf("idb:")===0;   // emit placeholder for any idb card (image is fetched on demand, may not be cached yet)
```

- [ ] **Step 3: Syntax gate**

Run: `node tests/syntax-check.js` → `0 error(s)`

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(img): attachCardImages fetches on demand; impCardHTML placeholder for any idb card"
```

---

## Task B6: Edit-dialog image preview loads on demand

**Files:** Modify `index.html` (`impEdit`, ~2668).

- [ ] **Step 1: Make the edit preview async**

In `impEdit`, change:
```js
  _editImg = resolveImg(it.img);
```
to:
```js
  _editImg = resolveImg(it.img);
  if(!_editImg && it.img && String(it.img).indexOf("idb:")===0){
    idbGetImg(String(it.img).slice(4)).then(function(d){ if(d){ _editImg=d; const el=document.getElementById("editImgPreview"); if(el) el.src=d; } });
  }
```

- [ ] **Step 2: Verify the preview img has id `editImgPreview`**

Run: `node -e "const h=require('fs').readFileSync('index.html','utf8'); console.log(/editImgPreview/.test(h) ? 'id present' : 'ADD id=\"editImgPreview\" to the edit dialog preview <img>');"`
If it prints "ADD …", locate the edit dialog's preview `<img>` (search for `_editImg` usage in the edit-dialog HTML) and add `id="editImgPreview"` to that `<img>` so the async load can target it.

- [ ] **Step 3: Syntax gate + commit**

Run: `node tests/syntax-check.js` → `0 error(s)`
```bash
git add index.html
git commit -m "feat(img): edit-dialog preview loads image on demand"
```

---

## Task B7: Full verification pass (Phase B)

**Files:** none (verification + final commit if any tweaks).

- [ ] **Step 1: Automated gates**

Run: `node tests/syntax-check.js` → `0 error(s)`
Run: `node tests/durability.test.js` → `12 passed, 0 failed`

- [ ] **Step 2: Manual pass (Chrome, localhost:3456, hard-reload)**

Verify and note each:
1. **First boot after update:** the "Optimizing image index (one time)…" overlay appears once, then never again on later reloads (`localStorage.ia_fp_migrated === "1"`).
2. **Memory:** DevTools → Memory / Performance — resident image memory is bounded (not ~630 MB); boot does not read the whole image store.
3. **Imported + Saved:** scroll → images load just-in-time; cards already on screen show images.
4. **Placeholder detection:** the "🧺 Fix N placeholders" count still appears and clearing still works (it now reads `_fpMap`).
5. **Edit dialog:** open a card with an idb image → the preview shows the image.
6. **Backup + restore:** Back up now → folder backup verifies; Restore latest → images round-trip (these use transient `idbAllImgs`/`idbPutImg`, unaffected).
7. **Console:** no `RangeError`, no uncaught errors on boot or while scrolling.

- [ ] **Step 3: Commit any fixes from the manual pass**

```bash
git add index.html
git commit -m "fix(img): address Phase B manual-test findings"   # only if changes were needed
```

---

## Self-review notes (author)

- **Spec coverage:** Phase A → Tasks A1–A2 (cardHTML emit, generalized attach, render calls, audit). Phase B B1 (bounded cache) → Task B1; B1 idbGetImg → B2; B2 fp decouple → B2+B3; B2 migration + no preload → B4; B3 caller adjustments → B5 (attach async + impCardHTML) + B6 (impEdit) + resolveImg unchanged. Testing → B1 unit test + A2/B7 manual. All spec sections mapped.
- **Type/name consistency:** `attachCardImages`, `data-imgid`/`data-imgsrc`, `findItem`, `cachePut`/`lruPush`/`IMG_CACHE_MAX`/`_imgCacheKeys`, `idbGetImg`, `fpDB`/`fpPut`/`fpDel`/`fpAll`/`_fpMap`, `imgFp`, `ia_fp_migrated`, `showBusyOverlay`/`hideBusyOverlay` (defined in the durability work) — consistent across tasks.
- **Ordering:** `lruPush`/`cachePut` (B1) exist before `cachePut` is used in B2/B5; `idbGetImg`/`_fpMap` (B2) before B3/B4/B5 use them; `showBusyOverlay` already exists (durability). Phase A is fully independent of Phase B and ships first.
- **No placeholders:** every code step is complete; the only conditional is B6 Step 2 (verify/add an `id` attribute), which gives the exact action.
