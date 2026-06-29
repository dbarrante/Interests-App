# Recapture: Arm Heal Target from the Grid + Enrich via Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the recapture heal work from the main grid (clicking a card or the ⟳ "recapture this page" button arms the heal target so the next extension Clip fixes that card), and stop the `enrichOnOpen` CORS errors by routing enrichment through the app's own Core instead of a blocked third-party proxy.

**Architecture:** Two app-only edits in `web/index.html`. (A) `impRefresh` and `impOpen` arm the existing v1.5.4 `_recapTarget` (one-shot, 15-min) the same way `openFailOne` does. (B) `enrichOnOpen` replaces its renderer→`api.allorigins.win` fetch with a same-origin `Store.captureMeta` call (the Core fetches og server-side, SSRF-guarded, and returns `{title, description, hasImage}`).

**Tech Stack:** Vanilla JS single-file renderer; plain-`node` text-assert wiring tests.

## Global Constraints

- App-only: NO Core endpoint change (reuse existing `POST /api/capture-meta`), NO extension change.
- Arming reuses v1.5.4 machinery unchanged: `routeCapture` honors `_recapTarget`; `drainCaptures` heals (`viaRecap`) and disarms one-shot on success. Do NOT modify `route-capture.js` or the `drainCaptures` apply path.
- `impOpen` arms `_recapTarget` ONLY when `doCapture` is true (don't arm on opening an already-good card).
- `enrichOnOpen` must no longer reference `api.allorigins.win`; the Facebook skip and the downstream `fetchMicrolink` + thum.io/mshots `<img>` fallbacks stay as-is.
- `Store.captureMeta(items)` returns `[{ id, hasImage, title, description, reason }]`; when `hasImage`, the Core has stored the image as `images/<id>.jpg`, so the renderer sets `it.img = "idb:" + it.id`.
- Keep `node tests/run.js` green; commit after each task.

---

### Task 1: Arm `_recapTarget` from the grid recapture actions

**Files:**
- Modify: `web/index.html` — `impOpen` (~line 3153) and `impRefresh` (~line 3178)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: the existing module var `_recapTarget` (declared ~line 2355) and v1.5.4 heal path. No new exports.

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js`:

```js
t("grid recapture arms the heal target: impRefresh always, impOpen only when doCapture", () => {
  const ri = html.indexOf("function impRefresh(");
  const rb = html.slice(ri, ri + 1000);
  assert.ok(rb.indexOf("_recapTarget") >= 0, "impRefresh arms _recapTarget");
  const oi = html.indexOf("function impOpen(");
  const ob = html.slice(oi, oi + 1300);
  assert.ok(ob.indexOf("_recapTarget") >= 0, "impOpen arms _recapTarget");
  assert.ok(ob.replace(/\s/g, "").indexOf("if(doCapture)_recapTarget") >= 0, "impOpen arms only when doCapture");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `impRefresh arms _recapTarget`.

- [ ] **Step 3a: Arm in `impOpen`.** Find this line (~3153):

```js
  if(doCapture){ it.lastUpdate=Date.now(); if(it.lastResult!=="ok") it.lastResult="pending"; Store.putCards(imported); }
```

Add immediately after it:

```js
  if(doCapture) _recapTarget = {id:it.id, ts:Date.now()};   // deliberate recapture-on-open: the next extension Clip heals THIS card
```

- [ ] **Step 3b: Arm in `impRefresh`.** Find this line (~3178):

```js
  Store.kvSet("ia_last_opened", {id:it.id, ts:Date.now()});
```

(within the `impRefresh` function — confirm by reading the surrounding lines; `impRefresh` also calls `Store.setCaptureRequest(...)` just below). Add immediately after that `kvSet` line:

```js
  _recapTarget = {id:it.id, ts:Date.now()};   // ⟳ recapture: the next extension Clip heals THIS card
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "fix(ui): grid recapture (card click + ⟳ button) arms the heal target"
```

---

### Task 2: Route `enrichOnOpen` through the Core (no CORS proxy)

**Files:**
- Modify: `web/index.html` — `enrichOnOpen` (~lines 3206–3219, the `!isFb` allorigins block)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `Store.captureMeta([{id, url}]) -> Promise<[{id, hasImage, title, description, reason}]>` (existing, `web/storage.js:138`); existing `genericTitle`, `isBadImg`, `setCardImage`.

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js`:

```js
t("enrichOnOpen enriches via the Core (no CORS proxy): uses Store.captureMeta, no allorigins", () => {
  const ei = html.indexOf("async function enrichOnOpen(");
  const eb = html.slice(ei, ei + 2200);
  assert.ok(eb.indexOf("Store.captureMeta(") >= 0, "enrichOnOpen calls the Core capture-meta");
  assert.ok(eb.indexOf("allorigins.win") < 0, "no api.allorigins.win proxy fetch remains");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `enrichOnOpen calls the Core capture-meta` (it still uses allorigins).

- [ ] **Step 3: Replace the allorigins block.** In `enrichOnOpen`, find this exact block:

```js
    if(!isFb){
      const ctl=new AbortController(); const tm=setTimeout(()=>ctl.abort(), 10000);
      const r=await fetch("https://api.allorigins.win/get?url="+encodeURIComponent(it.url), {signal:ctl.signal});
      clearTimeout(tm);
      if(r.ok){
        const d=await r.json();
        if(d.contents && typeof d.contents==="string"){
          const og=ogParse(d.contents.slice(0,60000));
          if(og.title && og.title.length>10 && genericTitle(it.title)){ it.title=og.title.slice(0,250); changed=true; }
          if(og.desc && og.desc.length>15 && (!it.desc || it.desc.startsWith("Saved from") || it.desc.startsWith("From your"))){ it.desc=og.desc.slice(0,220); changed=true; }
          if(og.img && /^https?:/.test(og.img) && !it.img){ it.img=og.img; changed=true; }
        }
      }
    }
```

Replace it with:

```js
    if(!isFb){
      // Enrich via the app's own Core (same-origin, SSRF-guarded) instead of a renderer->3rd-party
      // proxy fetch. The old api.allorigins.win call was CORS-blocked from http://127.0.0.1 and only
      // spammed the console. The Core fetches og server-side, stores any image as images/<id>.jpg,
      // and returns {title, description, hasImage}. Social hosts (IG/FB) are skipped server-side, so
      // for those this makes NO outbound request and returns hasImage:false.
      try{
        const res = await Store.captureMeta([{id:it.id, url:it.url}]);
        const m = res && res[0];
        if(m){
          if(m.title && m.title.length>10 && genericTitle(it.title)){ it.title=m.title.slice(0,250); changed=true; }
          if(m.description && m.description.length>15 && (!it.desc || it.desc.startsWith("Saved from") || it.desc.startsWith("From your"))){ it.desc=m.description.slice(0,220); changed=true; }
          if(m.hasImage && isBadImg(it.img)){ setCardImage(it, "idb:"+it.id); changed=true; }
        }
      }catch(e){}
    }
```

(Net: the `AbortController`/`fetch(allorigins)`/`ogParse` path is gone; `ogParse` may now be unused by this function but remains used elsewhere — do not remove it.)

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "fix(ui): enrichOnOpen uses the Core (no CORS) instead of api.allorigins.win"
```

---

## Notes for the executor

- After both tasks pass, run the **data-safety-reviewer** on the branch (the change affects how an enrich/capture mutates an imported card; it reuses the existing capture-meta + heal paths and adds no delete path). The **electron-security-reviewer** is not needed (no endpoint/IPC/extension change; the change REMOVES a renderer→third-party fetch). Then bump `package.json` 1.5.4 → 1.5.5 and rebuild the installer (`npm run dist`) — the app must be fully CLOSED first (it locks `dist\win-unpacked`).
