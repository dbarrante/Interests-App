# Capture-failure Triage + Capture-all + Interests Consolidate + SB Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record why each capture failed, give a triage view that resolves failed cards by reason (Retry-fresh / Remove / Mark-done / Social→extension), uncap "Capture all" for both never-tried and failed, consolidate the two interests sections, and add cosmetic asterisks + a live "Active" status to the Safe Browsing key.

**Architecture:** Core capture (`capturemeta`) returns a failure `reason`; the renderer stamps `c.capReason` and a triage modal (mirroring the dead-link modal) groups failed cards by reason with per-action footer buttons. `startBatchCapture` gains uncapped looping, retry-clears-image (backup-first), and an optional explicit-id subset (for triage retry). A small `safebrowse.verifyKey` + `/api/safebrowsing-verify` powers the live SB status.

**Tech Stack:** Node CommonJS (`core/*`), Express; plain inline renderer JS. Tests stub `global.fetch` + `linkcheck._setLookup`; `tests/syntax-check.js`.

## Global Constraints

- Non-destructive: Retry-fresh clears only a card's *picture* (re-fetchable) backup-first; Remove uses the existing snapshot-first removal; Mark-done only flips a status field. Image set only when found; title/description only if blank/bare-domain. No card data lost.
- Bounded/stoppable: capture loop chunks of 25 + `_capStop`; verify is one bounded lookup. Backups via the existing `snapshotBeforeDestructive()` before any image clear / removal.
- SB key stays Core-only: the field mask is cosmetic; verify never returns or logs the key. `images.putImg` validates `id` via `safeImgId`.
- Drain-not-cancel for any body read (the v1.3.2 crash class). Tests use no real network.
- `process.exitCode`, never `process.exit()` in tests.

---

### Task 1: Capture-failure reason (Core) — `core/capturemeta.js` + `core/server.js`

**Files:**
- Modify: `core/capturemeta.js` (`captureMetaChunk` adds `reason`)
- Modify: `core/server.js` (`/api/capture-meta` passes `reason` through)
- Test: `tests/capturemeta-fetch.test.js` (extend); `tests/capture-meta-endpoint.test.js` (extend)

**Interfaces:**
- Produces: each `captureMetaChunk` result gains `reason` ∈ `"social"|"unreachable"|"no-image"|"image-failed"|""`; endpoint result gains `reason` (only when `hasImage` is false, else `""`).

- [ ] **Step 1: Extend the failing tests** — in `tests/capturemeta-fetch.test.js`, before the restore line, add:

```js
  await t("captureMetaChunk: reason = social / unreachable / no-image / image-failed", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "text/html" : null }, arrayBuffer: async () => new Uint8Array([9]).buffer }; // image fetch returns non-image -> image-failed
      if (/\/noimg/.test(u)) return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => "<title>No image here</title>" };
      if (/\/withimg/.test(u)) return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/x.png">' };
      return { ok:false, status:0, url:u, headers:{ get:()=>null }, text: async () => "" }; // unreachable
    };
    const out = await cm.captureMetaChunk([
      { id:"soc", url:"https://www.instagram.com/p/x/" },
      { id:"dead", url:"https://example.test/dead" },
      { id:"noimg", url:"https://example.test/noimg" },
      { id:"imgfail", url:"https://example.test/withimg" }
    ]);
    const by = {}; out.forEach(x=>by[x.id]=x);
    assert.strictEqual(by.soc.reason, "social");
    assert.strictEqual(by.dead.reason, "unreachable");
    assert.strictEqual(by.noimg.reason, "no-image");
    assert.strictEqual(by.imgfail.reason, "image-failed");
  });
```

In `tests/capture-meta-endpoint.test.js`, inside the existing "writes the image file" test (or a new one), also assert a no-image case returns a reason. Add this test before the close:

```js
  await t("endpoint returns reason when no image", async () => {
    global.fetch = async (url) => ({ ok:true, status:200, url:String(url), headers:{ get:()=>null }, text: async () => "<title>none</title>" });
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"n1", url:"https://example.test/none" }] });
    assert.strictEqual(r.json.results[0].hasImage, false);
    assert.strictEqual(r.json.results[0].reason, "no-image");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/capturemeta-fetch.test.js` (the reason assertions fail — `reason` is `undefined`).

- [ ] **Step 3: Implement** — in `core/capturemeta.js`, replace the worker's per-item body (the `try { … } catch {…}` block inside `worker()`) with:

```js
      try {
        var url = it.url;
        if (typeof url !== "string" || !linkcheck.isProbableHost(url) || linkcheck.isSkippedHost(url) || !(await linkcheck.safeToFetch(url, opts))) {
          var skipReason = (typeof url === "string" && linkcheck.isSkippedHost(url)) ? "social" : "unreachable";
          results[idx] = { id: it.id, skipped: true, imageDataUrl: "", title: "", description: "", reason: skipReason }; continue;
        }
        var page = await _fetchHtml(url, opts);
        var og = extractOg(page.html);
        var imageDataUrl = "";
        if (og.image) {
          var abs; try { abs = new URL(og.image, page.finalUrl).href; } catch (e) { abs = ""; }
          if (abs) imageDataUrl = await _fetchImageDataUrl(abs, opts);
        }
        var reason = "";
        if (!imageDataUrl) {
          if (!page.html) reason = "unreachable";
          else if (og.image) reason = "image-failed";
          else reason = "no-image";
        }
        results[idx] = { id: it.id, imageDataUrl: imageDataUrl, title: og.title, description: og.description, reason: reason };
      } catch (e) {
        results[idx] = { id: it.id, imageDataUrl: "", title: "", description: "", reason: "unreachable" };
      }
```

In `core/server.js`, change the `/api/capture-meta` result map's return to include `reason`:

```js
        return { id: r && r.id, hasImage: hasImage, title: (r && r.title) || "", description: (r && r.description) || "", reason: hasImage ? "" : ((r && r.reason) || "unreachable") };
```

- [ ] **Step 4: Run tests + full gate**

Run: `node tests/capturemeta-fetch.test.js`, `node tests/capture-meta-endpoint.test.js`, `node tests/run.js` (all pass).

- [ ] **Step 5: Commit**

```bash
git add core/capturemeta.js core/server.js tests/capturemeta-fetch.test.js tests/capture-meta-endpoint.test.js
git commit -m "feat(capturemeta): report failure reason (social/unreachable/no-image/image-failed)"
```

---

### Task 2: `startBatchCapture` — capReason, uncapped, retry-clears-image, id-subset — `web/index.html`

**Files:**
- Modify: `web/index.html` (replace `startBatchCapture`; update the Capture-missing button label)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `Store.captureMeta` (returns results incl. `reason`), `snapshotBeforeDestructive`, `Store.imgDel`, existing `imported`/`needsCapture`/`needsRetry`/`captureable`/`clipKey`/`newId`/`batchUI`/`domain`/`Store.putCards`/`renderImportedKeepFocus`/`curTab`/`toast`.
- Produces: `startBatchCapture(mode, onlyIds?)` — uncapped; `mode==="retry"` OR `onlyIds` clears each card's image first (backup-first) for a fresh capture; stamps `c.capReason`.

- [ ] **Step 1: Extend the failing test** — in `tests/capture-wiring.test.js`, add:

```js
t("startBatchCapture stamps capReason and supports retry-clear + id subset", () => {
  const i = html.indexOf("async function startBatchCapture");
  const body = html.slice(i, i + 2500);
  assert.ok(body.indexOf("capReason") >= 0, "should stamp c.capReason");
  assert.ok(body.indexOf("onlyIds") >= 0, "should accept an explicit id subset");
  assert.ok(body.indexOf("Store.imgDel") >= 0, "retry should clear the existing image");
  assert.ok(body.indexOf("BATCH_CAP") < 0 || body.indexOf("slice(0, BATCH_CAP)") < 0, "loop should be uncapped (no BATCH_CAP slice)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `should stamp c.capReason`.

- [ ] **Step 3: Replace `startBatchCapture`** with:

```js
let _capStop = false;
async function startBatchCapture(mode, onlyIds){
  if(batchUI.active){ toast("A capture run is already going"); return; }
  let cand;
  if(onlyIds && onlyIds.length){
    const set=new Set(onlyIds); cand=imported.filter(c=>c && set.has(c.id) && /^https?:\/\//i.test(c.url||""));
  } else {
    cand = imported.filter(mode==="retry" ? needsRetry : needsCapture);
  }
  if(!cand.length){ toast(mode==="retry" ? "No failed cards to retry" : "No new cards to capture"); return; }
  const seen=new Set();
  const uniq=cand.filter(i=>{ if(!i.id) i.id=newId(); const k=clipKey(i.url); if(seen.has(k)) return false; seen.add(k); return true; });
  const items = uniq.map(i=>({id:i.id, url:i.url}));
  const isRetry = mode==="retry" || !!(onlyIds && onlyIds.length);
  const byId={}; imported.forEach(c=>{ if(c&&c.id) byId[c.id]=c; });
  // Retry / triage re-capture starts FRESH: clear the existing (bad) picture, backup-first.
  if(isRetry){
    snapshotBeforeDestructive();
    items.forEach(it=>{ const c=byId[it.id]; if(!c) return; const img=(typeof c.img==="string")?c.img:c.image; if(typeof img==="string" && img.indexOf("idb:")===0){ try{ Store.imgDel(c.id); }catch(e){} } c.img=""; });
  }
  // Mark dispatched cards attempted now (incl. clearing a stale "fail" to "pending"), so they don't loop.
  const dispatched=new Set(items.map(it=>clipKey(it.url)));
  const at=Date.now();
  imported.forEach(c=>{ if(c.url && dispatched.has(clipKey(c.url)) && captureable(c)){ c.lastUpdate=at; if(!c.lastResult || c.lastResult==="fail") c.lastResult="pending"; } });
  Store.putCards(imported);
  _capStop=false; batchUI={active:true, done:0, total:items.length};
  let got=0;
  try{
    for(let i=0; i<items.length && !_capStop; i+=25){
      const chunk=items.slice(i, i+25);
      toast(`Capturing… ${batchUI.done}/${items.length} — tap to stop`, 60000, ()=>{ _capStop=true; });
      let results=[];
      try{ results = await Store.captureMeta(chunk); }
      catch(e){ console.warn("capture-meta chunk failed", e); continue; }
      results.forEach(r=>{
        const c=r&&byId[r.id]; if(!c) return;
        if(r.hasImage){ c.img="idb:"+c.id; c.capReason=""; got++; }
        else { c.capReason = r.reason || "unreachable"; }
        const dom=domain(c.url)||"";
        if(r.title && (!c.title || c.title===dom)) c.title=r.title;
        if(r.description && !c.description) c.description=r.description;
        c.lastUpdate=Date.now(); c.lastResult = r.hasImage ? "ok" : "fail";
      });
      batchUI.done = Math.min(items.length, i+chunk.length);
      Store.putCards(imported);
      if(curTab==="imported") renderImportedKeepFocus();
    }
  } finally {
    batchUI={active:false, done:0, total:0};
    Store.putCards(imported);
    if(curTab==="imported") renderImportedKeepFocus();
    toast(_capStop ? `Stopped — ${got} picture${got===1?"":"s"} added` : `Capture done — ${got} picture${got===1?"":"s"} added`, 5000);
  }
}
```

- [ ] **Step 3b: Uncap the Capture-missing button label** — find:

```js
        if(miss) out+=`<button class="btn btn-ghost" id="batchBtn" onclick="startBatchCapture()" title="Open, screenshot &amp; close each not-yet-tried card with no picture (needs the extension)">&#128247; Capture missing ${miss>BATCH_CAP?("("+BATCH_CAP+" of "+miss+")"):("("+miss+")")}</button>`;
```
replace with:
```js
        if(miss) out+=`<button class="btn btn-ghost" id="batchBtn" onclick="startBatchCapture()" title="Fetch a preview image + info for every not-yet-tried card with no picture (in the app, no extension needed)">&#128247; Capture missing (${miss})</button>`;
```

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/capture-wiring.test.js` (expect pass), `node tests/syntax-check.js`, `node tests/run.js`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): capture stamps reason, uncapped, retry clears image for a fresh capture"
```

---

### Task 3: Failed-capture triage modal — `web/index.html`

**Files:**
- Modify: `web/index.html` (add `#failModal` container; add triage functions; wire `viewFailures` to open it; CSS selector include)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `imported`, `needsRetry`, `domain`, `esc`, `dupeThumb`, `attachCardImages`, `snapshotBeforeDestructive`, `Store.putCards`/`imgDel`/`fpDel`, `_fpMap`, `updateCounts`, `renderImported`, `curTab`, `toast`, `startBatchCapture` (Task 2).
- Produces: `openFailReview()`, `renderFailModal()`, `_failLabel(reason)`, `failRowHTML(c)`, `closeFailReview()`, `failSelectGroup(reason)`, `retryFailFresh()`, `removeFailSelected()`, `markFailDone()`.

- [ ] **Step 1: Extend the failing test** — in `tests/capture-wiring.test.js`, add:

```js
t("failed-capture triage modal exists and groups by reason with actions", () => {
  assert.ok(html.indexOf('id="failModal"') >= 0, "fail triage modal present");
  assert.ok(html.indexOf("function openFailReview") >= 0);
  assert.ok(html.indexOf("c.capReason") >= 0 || html.indexOf(".capReason") >= 0, "triage reads capReason");
  assert.ok(html.indexOf("function retryFailFresh") >= 0 && html.indexOf("function removeFailSelected") >= 0 && html.indexOf("function markFailDone") >= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `fail triage modal present`.

- [ ] **Step 3a: Modal container + CSS** — find `<div id="safetyModal"><div class="dupe-box"><div id="safetyBody"></div></div></div>` and add immediately after:

```html
<div id="failModal"><div class="dupe-box"><div id="failBody"></div></div></div>
```

Find the modal CSS selector lines and add `,#failModal` / `,#failModal.open` (the lines currently reading `#dupeModal,#deadModal,#safetyModal{…}` and `#dupeModal.open,#deadModal.open,#safetyModal.open{…}`).

- [ ] **Step 3b: Triage functions** — add near `viewFailures` (replace the one-line `function viewFailures(){...}` with the block below + the new functions):

```js
function viewFailures(){ openFailReview(); }
function _failLabel(reason){
  return ({ social:"Login-walled — open & Save from your browser", unreachable:"Couldn't reach — may be dead", "no-image":"No preview image on the page", "image-failed":"Preview image wouldn't download" })[reason] || "Couldn't capture";
}
let _failModalList = [];
function openFailReview(){
  _failModalList = imported.filter(needsRetry);
  if(!_failModalList.length){ toast("No failed captures"); return; }
  renderFailModal();
  document.getElementById("failModal").classList.add("open");
}
function closeFailReview(){ document.getElementById("failModal").classList.remove("open"); _failModalList=[]; }
function failRowHTML(c){
  const dom=domain(c.url)||""; const reason=c.capReason||"unreachable";
  return `<div class="dupe-row" data-reason="${esc(reason)}">
    ${dupeThumb({scope:"imported", card:c})}
    <div class="meta"><div class="t">${esc(c.title||dom||"(untitled)")}</div>
      <div class="s">${esc(dom)} · <span style="color:#e0556b">${esc(_failLabel(reason))}</span></div></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-id="${esc(c.id)}" style="width:auto"> select</label>
  </div>`;
}
function renderFailModal(){
  const order=["unreachable","image-failed","no-image","social"];
  const groups={}; _failModalList.forEach(c=>{ const r=c.capReason||"unreachable"; (groups[r]=groups[r]||[]).push(c); });
  let body="";
  order.concat(Object.keys(groups).filter(r=>order.indexOf(r)<0)).forEach(r=>{
    const g=groups[r]; if(!g||!g.length) return;
    body += `<div class="s" style="opacity:.8;margin:10px 4px 4px;font-weight:600">${esc(_failLabel(r))} (${g.length}) · <a href="#" onclick="failSelectGroup('${esc(r)}');return false">select these</a></div>`;
    body += g.map(failRowHTML).join("");
  });
  document.getElementById("failBody").innerHTML = `
    <div class="dupe-head"><span>&#128260; Failed captures — ${_failModalList.length}</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onclick="closeFailReview()">Close</button></div>
    <div class="dupe-list">
      <div class="s" style="opacity:.7;padding:2px 4px 8px">Select cards, then choose a fix. <b>Retry (fresh)</b> clears the old picture and re-captures; <b>Remove</b> deletes (backup-first); <b>Mark done</b> stops a card showing as failed (e.g. no preview image). Login-walled cards need the extension.</div>
      ${body || "<div class='s'>No failed captures.</div>"}
    </div>
    <div class="dupe-foot">
      <button class="btn btn-primary" onclick="retryFailFresh()">&#128260; Retry (fresh)</button>
      <button class="btn btn-ghost" onclick="markFailDone()">&#10003; Mark done</button>
      <button class="btn btn-ghost" onclick="removeFailSelected()" style="color:#e0556b">&#128465; Remove</button>
    </div>`;
  attachCardImages();
}
function failSelectGroup(reason){
  Array.prototype.forEach.call(document.querySelectorAll('#failBody .dupe-row[data-reason="'+reason+'"] input[data-id]'), el=>{ el.checked=true; });
}
function _failCheckedIds(){
  return Array.prototype.map.call(document.querySelectorAll('#failBody input[data-id]:checked'), el=>el.getAttribute("data-id"));
}
function retryFailFresh(){
  const ids=_failCheckedIds(); if(!ids.length){ toast("Select some cards first"); return; }
  closeFailReview();
  startBatchCapture(null, ids);   // onlyIds path clears the old image + re-captures fresh
}
function markFailDone(){
  const ids=new Set(_failCheckedIds()); if(!ids.size){ toast("Select some cards first"); return; }
  imported.forEach(c=>{ if(c&&ids.has(c.id)){ c.lastResult="ok"; c.lastUpdate=Date.now(); } });
  Store.putCards(imported); updateCounts();
  closeFailReview(); if(curTab==="imported") renderImported();
  toast(`Marked ${ids.size} done`, 4000);
}
function removeFailSelected(){
  const ids=new Set(_failCheckedIds()); if(!ids.size){ toast("Select some cards first"); return; }
  snapshotBeforeDestructive();
  const gone=imported.filter(c=>c&&ids.has(c.id));
  gone.forEach(c=>{ const img=(typeof c.img==="string")?c.img:c.image; if(typeof img==="string" && img.indexOf("idb:")===0){ try{ Store.imgDel(c.id); }catch(e){} } if(_fpMap[c.id]){ delete _fpMap[c.id]; try{ Store.fpDel(c.id); }catch(e){} } });
  imported = imported.filter(c=>!c||!ids.has(c.id));
  Store.putCards(imported); updateCounts();
  closeFailReview(); if(curTab==="imported") renderImported();
  toast(`Removed ${ids.size} card${ids.size===1?"":"s"}`, 5000);
}
```

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/capture-wiring.test.js`, `node tests/syntax-check.js`, `node tests/run.js`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): failed-capture triage — group by reason, retry-fresh / remove / mark-done"
```

---

### Task 4: Consolidate the two interests sections — `web/index.html`

**Files:**
- Modify: `web/index.html` (move the "Discover new interests" block into the "Your interests" section)
- Test: `tests/profile-wiring.test.js` (extend)

- [ ] **Step 1: Extend the failing test** — in `tests/profile-wiring.test.js`, add:

```js
t("interests + discover are one consolidated section", () => {
  // The Discover heading must be gone; its tool lives under the interests section now.
  assert.ok(html.indexOf("Discover new interests</h3>") < 0, "separate Discover <h3> removed");
  assert.ok(html.indexOf('id="discInput"') >= 0 && html.indexOf('id="analyzeLibBtn"') >= 0, "both tools still present");
  assert.ok(html.indexOf("Your interests</h3>") >= 0, "single 'Your interests' heading");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/profile-wiring.test.js`
Expected: FAIL — `separate Discover <h3> removed`.

- [ ] **Step 3a: Rename the interests heading** — find `<h3>Your interest profile</h3>` and replace with `<h3>Your interests</h3>`.

- [ ] **Step 3b: Remove the standalone Discover section and re-home its body.** Find this EXACT block (the whole Discover `.sec`):

```html
      <div class="sec">
        <h3>Discover new interests</h3>
        <textarea id="discInput" placeholder="e.g. I've been curious about welding, smart irrigation, maybe restoring an old arcade cabinet…"></textarea>
        <button class="btn btn-ghost" id="discBtn" onclick="discoverInterests()" style="margin-top:10px">&#10024; Suggest interest categories</button>
        <div id="discResults" class="tagwrap"></div>
        <button id="discAdd" class="btn btn-primary" style="display:none;margin-top:12px" onclick="addDiscovered()">Add selected to my profile</button>
      </div>
```
(If the placeholder/whitespace differs slightly, match the actual current text — read the file.) Delete it from its current location.

Then, in the "Your interests" section, find the line `        <button class="btn btn-ghost" id="analyzeLibBtn" onclick="analyzeLibrary()"` and, immediately BEFORE the `<div style="margin-top:12px">` that wraps that Analyze button, insert the Discover tool re-homed under a sub-label:

```html
        <label style="margin-top:14px;display:block">Or describe what you're into — get suggestions</label>
        <textarea id="discInput" placeholder="e.g. I've been curious about welding, smart irrigation, maybe restoring an old arcade cabinet…"></textarea>
        <button class="btn btn-ghost" id="discBtn" onclick="discoverInterests()" style="margin-top:10px">&#10024; Suggest interest categories</button>
        <div id="discResults" class="tagwrap"></div>
        <button id="discAdd" class="btn btn-primary" style="display:none;margin-top:12px" onclick="addDiscovered()">Add selected to my profile</button>
```

(Net effect: one "Your interests" section containing About you + interests list + the Analyze-my-library tool + the Discover-from-musing tool. No JS changes — `discoverInterests`/`addDiscovered`/`analyzeLibrary` are untouched.)

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/profile-wiring.test.js`, `node tests/syntax-check.js`, `node tests/run.js`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/profile-wiring.test.js
git commit -m "feat(ui): consolidate interest profile + discover into one 'Your interests' section"
```

---

### Task 5: Safe Browsing — cosmetic asterisks + live "Active" status

**Files:**
- Modify: `core/capturemeta.js` is NOT used; use `core/safebrowse.js` (add `verifyKey`); `core/server.js` (`GET /api/safebrowsing-verify`); `web/storage.js` (`SE.safebrowsingVerify` + `Store.verifySafeBrowsing`); `web/index.html` (`loadSafetyKeyStatus` + `saveSafeBrowsingKey`)
- Test: `tests/safebrowse-call.test.js` (extend for `verifyKey`); `tests/safety-endpoint.test.js` (extend for `/api/safebrowsing-verify`); `tests/safety-wiring.test.js` (extend)

**Interfaces:**
- Produces: `safebrowse.verifyKey(apiKey, opts?) -> Promise<{ ok:boolean, status:"active"|"invalid"|"error" }>`; `GET /api/safebrowsing-verify -> { state:"active"|"invalid"|"none"|"error" }`; `Store.verifySafeBrowsing() -> Promise<{state}>`; `SE.safebrowsingVerify() -> "/api/safebrowsing-verify"`.

- [ ] **Step 1: Write the failing tests**

In `tests/safebrowse-call.test.js`, add:

```js
  await t("verifyKey: 200 -> active, 4xx -> invalid, throw -> error", async () => {
    global.fetch = async () => ({ ok:true, status:200, json: async () => ({}) });
    assert.deepStrictEqual(await sb.verifyKey("K"), { ok:true, status:"active" });
    global.fetch = async () => ({ ok:false, status:400, json: async () => ({}) });
    assert.deepStrictEqual(await sb.verifyKey("K"), { ok:false, status:"invalid" });
    global.fetch = async () => { throw new Error("net"); };
    assert.deepStrictEqual(await sb.verifyKey("K"), { ok:false, status:"error" });
  });
```

In `tests/safety-endpoint.test.js`, add (the file already isolates APPDATA + stubs fetch):

```js
  await t("GET /api/safebrowsing-verify: none when no key, active when key + 200", async () => {
    config.setSafeBrowsingKey("");
    let r = await req(port, "GET", "/api/safebrowsing-verify");
    assert.strictEqual(r.json.state, "none");
    config.setSafeBrowsingKey("KEY");
    r = await req(port, "GET", "/api/safebrowsing-verify");
    assert.strictEqual(r.json.state, "active");   // stubbed fetch returns ok:true
  });
```

In `tests/safety-wiring.test.js`, add:

```js
t("Settings shows a live Safe Browsing status + cosmetic key mask", () => {
  assert.ok(html.indexOf("Store.verifySafeBrowsing") >= 0);
  assert.ok(html.indexOf("SB_MASK") >= 0, "uses a cosmetic mask constant");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run the three test files; each new assertion fails (`verifyKey`/route/`SB_MASK` missing).

- [ ] **Step 3a: `verifyKey`** — in `core/safebrowse.js`, add before `module.exports` and include it in the export:

```js
// One benign-URL lookup to check the key is accepted by Google. Distinguishes a working key
// (200) from a rejected one (4xx) from a transient network failure (throw). Never returns/logs the key.
async function verifyKey(apiKey, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var ac = new AbortController(); var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
  try {
    var res = await fetch(ENDPOINT + "?key=" + encodeURIComponent(apiKey), {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", "Connection": "close" },
      body: JSON.stringify(buildLookupBody(["https://example.com/"]))
    });
    if (res.ok) return { ok: true, status: "active" };
    if (res.status >= 400 && res.status < 500) return { ok: false, status: "invalid" };
    return { ok: false, status: "error" };
  } catch (e) { return { ok: false, status: "error" }; }
  finally { clearTimeout(timer); }
}
```
Export: add `verifyKey: verifyKey` to `module.exports`.

- [ ] **Step 3b: Endpoint** — in `core/server.js`, after the existing `GET /api/safebrowsing-key` route, add:

```js
  app.get("/api/safebrowsing-verify", async (req, res) => {
    try {
      const key = config.getSafeBrowsingKey();
      if (!key) { res.json({ state: "none" }); return; }
      const v = await safebrowse.verifyKey(key, {});
      res.json({ state: v.status });
    } catch (e) {
      console.error("safebrowsing-verify failed:", e);
      res.json({ state: "error" });
    }
  });
```

- [ ] **Step 3c: Storage adapter** — in `web/storage.js`, `SE` (after `safeBrowsingKey`):

```js
    safebrowsingVerify: function () { return "/api/safebrowsing-verify"; },
```
In `Store` (append, comma-separated):

```js
,
      verifySafeBrowsing: function () { return jget(SE.safebrowsingVerify()).then(function (j) { return (j && j.state) || "error"; }); }
```

- [ ] **Step 3d: Renderer** — replace `loadSafetyKeyStatus` and `saveSafeBrowsingKey` with:

```js
const SB_MASK = "••••••••••••••••••••••••";
async function loadSafetyKeyStatus(){
  let has = false;
  try { has = await Store.getSafeBrowsingKey(); } catch(e){ const el0=document.getElementById("sbKeyStatus"); if(el0) el0.textContent=""; return; }
  const inp = document.getElementById("sbKey");
  if (inp && has && !inp.value) inp.value = SB_MASK;        // cosmetic: show a key is present
  const el = document.getElementById("sbKeyStatus");
  if (el) el.textContent = has ? "— checking…" : "— not set";
  if (!has) return;
  try {
    const state = await Store.verifySafeBrowsing();
    if (el) el.textContent = state==="active" ? "— ✅ Active" : state==="invalid" ? "— ⚠ Invalid key" : "— a key is set";
  } catch(e){ if (el) el.textContent = "— a key is set"; }
}
async function saveSafeBrowsingKey(){
  const inp = document.getElementById("sbKey");
  const v = inp ? inp.value.trim() : "";
  if (v === SB_MASK) { toast("Key unchanged"); return; }    // mask untouched = no change
  try { await Store.setSafeBrowsingKey(v); } catch(e){ toast("Couldn't save key", 4000); return; }
  if (inp) inp.value = "";
  toast(v ? "Safe Browsing key saved" : "Safe Browsing key cleared", 4000);
  loadSafetyKeyStatus();
}
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/safebrowse-call.test.js`, `node tests/safety-endpoint.test.js`, `node tests/safety-wiring.test.js`, `node tests/syntax-check.js`, `node tests/run.js`.

- [ ] **Step 5: Commit**

```bash
git add core/safebrowse.js core/server.js web/storage.js web/index.html tests/safebrowse-call.test.js tests/safety-endpoint.test.js tests/safety-wiring.test.js
git commit -m "feat(ui): Safe Browsing key — cosmetic mask + live Active/Invalid status"
```

---

### Task 6: Reviews, version bump, installer

- [ ] **Step 1: Full gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.

- [ ] **Step 2: data-safety-reviewer** against the feature diff (focus: Retry-fresh clears only a picture backup-first; Remove uses snapshot-first; Mark-done only flips `lastResult`; capture-all still attempt-stamps; no card-data loss). Fix findings; re-run gate; commit.

- [ ] **Step 3: electron-security-reviewer** against the feature diff (focus: `/api/safebrowsing-verify` never returns/logs the key, one bounded lookup; the cosmetic mask never sends a fake key as real — `v===SB_MASK` short-circuits; no new SSRF/IPC surface; capture-meta reason adds no data leak). Fix findings; re-run gate; commit.

- [ ] **Step 4: Version bump** — `package.json` `"1.4.1"` → `"1.5.0"` (feature set → minor).

```bash
git add package.json
git commit -m "chore: bump version to 1.5.0 (capture triage, capture-all, interests consolidate, SB status)"
```

- [ ] **Step 5: Rebuild installer** — `npm run dist` → `dist/Interests-App-Setup-1.5.0.exe`.

- [ ] **Step 6: Summarize for Dave** — what shipped, installer path, how to use the triage (🔄 N failed → View failures → select + Retry-fresh/Remove/Mark-done), capture-all, the consolidated interests section, and the SB Active status. Note the still-queued items (toggle built-in viewer; Notion connector). Do NOT offer merge/PR.

---

## Self-Review

**Spec coverage:**
- A. Failure reasons → Task 1 (capturemeta + endpoint). ✓
- B. Triage by reason + Retry-fresh(clears image)/Remove/Mark-done/Social-note → Task 2 (retry-clears-image + capReason + id-subset) + Task 3 (triage modal). ✓
- C. Capture all (uncapped, both never-tried + failed) → Task 2 (no BATCH_CAP slice; "Retry all" already calls startBatchCapture('retry')). ✓
- D. Consolidate interests → Task 4. ✓
- E. SB asterisks + live status → Task 5. ✓
- Data-safety + electron-security + bump → Task 6. ✓

**Placeholder scan:** none — full code/anchors. (Task 4 notes "match actual current text if whitespace differs" — a read-and-verify instruction, with the block shown.)

**Type consistency:** capture result `reason` flows capturemeta → endpoint (`{id,hasImage,title,description,reason}`) → `Store.captureMeta` → `startBatchCapture` sets `c.capReason` → triage reads `c.capReason`/`_failLabel`. `startBatchCapture(mode, onlyIds)` called by `retryFailFresh(null, ids)` and toolbar (`startBatchCapture()`/`('retry')`). `verifyKey`→`{ok,status}`; endpoint→`{state}`; `Store.verifySafeBrowsing`→state string; `SB_MASK` shared in the two SB handlers. Consistent.
