# Hashtag Library Scan + Manual Point-to-Point Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ship two independent library-cleanup/capture features: (1) a one-click
"Hashtags → Tags" library scan, and (2) a manual, user-drawn point-to-point
screenshot capture, usable both from an existing card in the app and standalone
from the extension on any page.

**Architecture:** Part 1 reuses existing hashtag-extraction code and the
existing Library Health batch-tab pattern. Part 2 adds a new on-demand-injected
extension content script (a drag-to-select overlay) driven by two trigger
points — a new app capture-request flag and a new extension context-menu item
— both converging on the extension's existing crop-screenshot primitive and
the existing (currently unused) `routeCapture` "no match → new Saved card"
rule.

**Tech Stack:** vanilla JS throughout (no new dependencies). Extension: MV3
service worker + on-demand `chrome.scripting.executeScript` content-script
injection (already used elsewhere in this file — no manifest changes needed).
App: `web/index.html` mirrored byte-for-byte into `pwa/index.html`.

**Spec:** `docs/superpowers/specs/2026-08-05-hashtag-scan-and-manual-capture-design.md`

## Global Constraints

- No new npm dependencies, no manifest permission changes (`<all_urls>` +
  `scripting` are already granted).
- Every `web/index.html` change must be mirrored byte-identically into
  `pwa/index.html`, and `pwa/sw.js`'s `SHELL_CACHE` bumped in the same task
  that touches either file (per project convention — an unbumped cache leaves
  installed PWAs silently stale).
- `web/index.html` and `pwa/index.html` must keep parsing — run
  `node tests/syntax-check.js` after any edit to either.
- Run `node tests/run.js` after every task; all tests must stay green.
- Manual point-to-point capture never modifies an Imported card except via
  the two explicit, user-initiated actions in this plan — no batch/automatic
  logic is added or changed anywhere else.

---

### Task 1: Hashtags → Tags library scan

**Files:**
- Modify: `web/index.html`
- Modify: `pwa/index.html` (byte-identical mirror)
- Modify: `pwa/sw.js` (`SHELL_CACHE` bump)
- Test: `tests/hashtag-library-scan.test.js`

**Interfaces:**
- Produces: `captureOutgoingHashtags(card, exclude)` now **returns** the
  array of tags it actually added (`[]` for a no-op), instead of returning
  `undefined`. Every existing call site (`impRefresh`, `impEditSave`,
  `cardEditSave`, `applyGeneratedTitle`, `applyTitleSuggestions`,
  `enrichOnOpen`) calls it as a bare statement today and does not use the
  return value — confirmed by reading all 6 call sites, so this is a safe,
  backward-compatible signature change.
- Produces: `runHashtagLibraryScan()` — the button's click handler.

- [ ] **Step 1: Give `captureOutgoingHashtags` a return value**

In `web/index.html`, find:
```js
function captureOutgoingHashtags(card, exclude){
  if(!card || !card.title) return;
  mergeCleanTags(card, extractHashtags(card.title).tags, exclude);
}
```
Replace with:
```js
function captureOutgoingHashtags(card, exclude){
  if(!card || !card.title) return [];
  return mergeCleanTags(card, extractHashtags(card.title).tags, exclude);
}
```
Apply the identical change in `pwa/index.html` (same function, same text).

- [ ] **Step 2: Add the new Library Health tab**

In `web/index.html`, find:
```js
const HEALTH_TABS = [
  { id:"dupes",  label:"Duplicates" },
  { id:"dead",   label:"Dead & unsafe" },
  { id:"failed", label:"Failed captures" },
  { id:"nolink", label:"No link" },
  { id:"titles", label:"Title issues" },
  { id:"airefresh", label:"AI refresh" },
];
```
Replace with:
```js
const HEALTH_TABS = [
  { id:"dupes",  label:"Duplicates" },
  { id:"dead",   label:"Dead & unsafe" },
  { id:"failed", label:"Failed captures" },
  { id:"nolink", label:"No link" },
  { id:"titles", label:"Title issues" },
  { id:"airefresh", label:"AI refresh" },
  { id:"hashtags", label:"Hashtags → Tags" },
];
```
Apply the identical change in `pwa/index.html`.

- [ ] **Step 3: Wire the new tab into the `renderHealth()` dispatcher**

In `web/index.html`, find the `renderHealth()` function (search
`function renderHealth(){`). It dispatches to a per-tab render function based
on `_healthTab`, mirroring the existing `airefresh` branch (search
`if(_healthTab==="airefresh")` for the exact existing pattern — there are two
occurrences: one in `renderHealth()`'s own dispatch table, one inside
`runAiRefreshBatch()`'s own re-render-after-finish call). Add a matching
branch for `"hashtags"` calling a new `renderHealthHashtags(list)` function,
in both places using the same structure as the existing `airefresh` branch.

- [ ] **Step 4: Implement the tab's render + scan functions**

Add these two new functions in `web/index.html`, placed directly after
`runAiRefreshBatch()` (which ends with the line
`if(_healthTab==="airefresh"){ const list=document.getElementById("healthList"); if(list) renderHealthAiRefresh(list); }`):

```js
// ---- Hashtags → Tags tab (Library Health) ----
let _hashtagScanRunning = false;
function renderHealthHashtags(list){
  const total = imported.length + saved.length;
  list.innerHTML = `
    <div class="s" style="opacity:.75;padding:2px 4px 14px">Scans every card's title for #hashtags and adds them as tags. Titles are never changed. No AI key needed — this is a local, free operation.</div>
    <div class="s" style="opacity:.75;padding:0 4px 10px">${total} card${total===1?"":"s"} in the library.</div>
    <button class="btn btn-primary" id="hashtagScanBtn" ${(!total||_hashtagScanRunning)?"disabled":""} onclick="runHashtagLibraryScan()">Scan library</button>`;
}
async function runHashtagLibraryScan(){
  if(_hashtagScanRunning) return;
  const all = imported.concat(saved);
  if(!all.length){ toast("Library is empty — nothing to scan"); return; }
  _hashtagScanRunning = true;
  const btn = document.getElementById("hashtagScanBtn");
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Scanning…'; }
  let tagged = 0, done = 0;
  try{
    for(let i=0; i<all.length; i+=400){
      const chunk = all.slice(i, i+400);
      chunk.forEach(card=>{
        const added = captureOutgoingHashtags(card);
        if(added && added.length) tagged++;
      });
      done += chunk.length;
      Store.putCards(imported); Store.putSaved(saved); persistAll();
      toast(`Hashtag scan: ${done}/${all.length}…`);
    }
    toast(`Hashtag scan done — added tags to ${tagged} of ${all.length} card${all.length===1?"":"s"}`);
  }catch(e){
    console.error(e);
    toast("Hashtag scan failed: "+e.message, 7000);
  } finally {
    _hashtagScanRunning = false;
  }
  if(curTab==="saved") renderSaved();
  renderImportedKeepFocus();
  if(_healthTab==="hashtags"){ const list=document.getElementById("healthList"); if(list) renderHealthHashtags(list); }
}
```
Apply the identical two functions, and the identical `HEALTH_TABS`/dispatch
changes from Steps 2-3, in `pwa/index.html`.

- [ ] **Step 4: Bump the PWA shell cache**

In `pwa/sw.js`, find the `SHELL_CACHE` constant (a string like
`"interests-pwa-shell-v106"`) and increment its version number by 1.

- [ ] **Step 5: Run the syntax gate**

Run: `node tests/syntax-check.js`
Expected: no errors for `web/index.html` or `pwa/index.html`.

- [ ] **Step 6: Write the tests**

Create `tests/hashtag-library-scan.test.js`. This repo's `web/index.html`
tests extract functions from the file via a shared `extractFn`-style helper —
follow the exact pattern used by the existing AI-refresh-batch test file
(find it by searching the `tests/` directory for
`runAiRefreshBatch`) for how to extract `captureOutgoingHashtags`,
`mergeCleanTags`, `extractHashtags`, `canonicalTag`, `tagBadPattern`,
`AI_TAB_TAG`, and `runHashtagLibraryScan` as free functions with stubbed
globals (`imported`, `saved`, `Store`, `toast`, `persistAll`,
`renderImportedKeepFocus`, `renderSaved`, `curTab`, `_healthTab`,
`document.getElementById` stub returning `null`), mirroring both `web/` and
`pwa/` copies with a byte-parity assertion (this repo's established
convention — search any existing test file for
`byte-identical between web/index.html and pwa/index.html` for the parity-
assertion pattern to copy).

Required test cases:
```js
// captureOutgoingHashtags now returns the added-tags array
t("captureOutgoingHashtags returns the tags it added, [] for a no-op", () => {
  const card = { title: "Great sunset #photography #travel", tags: [] };
  const added = captureOutgoingHashtags(card);
  assert.deepStrictEqual(added.sort(), ["photography","travel"].sort());
  assert.deepStrictEqual(captureOutgoingHashtags(card), []);   // already tagged -> no-op, returns []
});
t("captureOutgoingHashtags never modifies the title", () => {
  const card = { title: "Great sunset #photography", tags: [] };
  captureOutgoingHashtags(card);
  assert.strictEqual(card.title, "Great sunset #photography");
});

// runHashtagLibraryScan
t("runHashtagLibraryScan processes both imported and saved", async () => {
  imported.length = 0; saved.length = 0;
  imported.push({ title: "one #a", tags: [] });
  saved.push({ title: "two #b", tags: [] });
  await runHashtagLibraryScan();
  assert.ok(imported[0].tags.includes("a"));
  assert.ok(saved[0].tags.includes("b"));
});
t("runHashtagLibraryScan chunks in groups of 400 (a >400-card library still completes in one call)", async () => {
  imported.length = 0; saved.length = 0;
  for(let i=0;i<450;i++) imported.push({ title: `card ${i} #tag${i%5}`, tags: [] });
  await runHashtagLibraryScan();
  assert.ok(imported.every(c=>c.tags.length>0));
});
t("runHashtagLibraryScan is a no-op-safe re-run (already-tagged cards don't duplicate tags)", async () => {
  imported.length = 0; saved.length = 0;
  imported.push({ title: "x #dup", tags: [] });
  await runHashtagLibraryScan();
  await runHashtagLibraryScan();
  assert.deepStrictEqual(imported[0].tags, ["dup"]);
});
```
Mirror every case for the `pwa/` extraction too (matching this repo's
established `web:`/`pwa:` dual-test-name convention).

- [ ] **Step 7: Run the tests**

Run: `node tests/hashtag-library-scan.test.js`
Expected: all cases pass, `web:` and `pwa:` variants both green.

- [ ] **Step 8: Run the full suite and commit**

Run: `node tests/run.js` — expect `ALL TEST FILES PASSED`.
```bash
git add web/index.html pwa/index.html pwa/sw.js tests/hashtag-library-scan.test.js
git commit -m "feat: add Hashtags -> Tags library scan to Library Health

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Extension — region-select overlay content script

**Files:**
- Create: `extension/region-select.js`
- Test: `tests/region-select-overlay.test.js`

**Interfaces:**
- Consumes (from the background script, added in Task 3): three message
  actions it sends and expects responses to —
  - `chrome.runtime.sendMessage({action:"regionSelectCrop", rect:{x,y,w,h}}, cb)`
    → background responds `{ok:true, dataUrl}` or `{ok:false, error}`.
  - `chrome.runtime.sendMessage({action:"regionSelectFinalize"}, cb)` →
    background responds `{ok:true}` (or `{ok:false}` if there's no
    in-progress session to finalize).
  - `chrome.runtime.sendMessage({action:"regionSelectCancel"}, cb)` →
    background responds `{ok:true}`.
- Produces: a self-contained script safe to inject via
  `chrome.scripting.executeScript({target:{tabId}, files:["region-select.js"]})`
  on any page, with no dependency on `capture-core.js`/`capture-configs.js`.

- [ ] **Step 1: Write `extension/region-select.js`**

```js
"use strict";
// Manual point-to-point capture overlay: drag a rectangle, preview the
// crop, then either deliver it (background.js owns the actual screenshot —
// content scripts cannot call chrome.tabs.captureVisibleTab) or cancel.
// Injected on demand via chrome.scripting.executeScript by background.js,
// either from the extension's "Point-to-point capture" context-menu item
// (standalone, any page) or from the app-triggered manual-recapture flow
// (pollCaptureRequest's req.manual branch). Self-contained — no dependency
// on capture-core.js/capture-configs.js.
(function () {
  if (window.__iaRegionSelectActive) return;   // a second injection on an already-active tab is a no-op
  window.__iaRegionSelectActive = true;

  const overlay = document.createElement("div");
  overlay.id = "__ia_region_select_overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.35);";
  document.documentElement.appendChild(overlay);

  const box = document.createElement("div");
  box.style.cssText = "position:fixed;border:2px solid #4da3ff;background:rgba(255,255,255,.08);display:none;pointer-events:none;";
  overlay.appendChild(box);

  let startX = 0, startY = 0, dragging = false;

  function cleanup() {
    window.__iaRegionSelectActive = false;
    try { overlay.remove(); } catch (e) {}
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function rectFromDrag(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  function showMessage(text) {
    let m = document.getElementById("__ia_region_select_msg");
    if (!m) {
      m = document.createElement("div");
      m.id = "__ia_region_select_msg";
      m.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:8px 16px;border-radius:8px;font:600 13px system-ui,sans-serif;z-index:2147483647;";
      overlay.appendChild(m);
    }
    m.textContent = text;
  }

  function showPreview(dataUrl) {
    const panel = document.createElement("div");
    panel.id = "__ia_region_select_preview";
    panel.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:12px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:2147483647;text-align:center;font-family:system-ui,sans-serif;";
    panel.innerHTML =
      '<img src="' + dataUrl + '" style="max-width:60vw;max-height:60vh;display:block;border-radius:4px;margin-bottom:10px">' +
      '<div style="display:flex;gap:10px;justify-content:center">' +
      '<button id="__ia_use_this" style="padding:8px 18px;border-radius:6px;border:none;background:#2f7ff2;color:#fff;font-weight:600;cursor:pointer">Use this</button>' +
      '<button id="__ia_redo" style="padding:8px 18px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer">Redo</button>' +
      "</div>";
    overlay.appendChild(panel);
    panel.querySelector("#__ia_use_this").addEventListener("click", () => {
      panel.remove();
      showMessage("Saving…");
      chrome.runtime.sendMessage({ action: "regionSelectFinalize" }, () => { cleanup(); });
    });
    panel.querySelector("#__ia_redo").addEventListener("click", () => {
      panel.remove();
      const m = document.getElementById("__ia_region_select_msg");
      if (m) m.remove();
    });
  }

  function onMouseDown(e) {
    if (e.button !== 0 || document.getElementById("__ia_region_select_preview")) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    box.style.display = "block";
    box.style.left = startX + "px"; box.style.top = startY + "px";
    box.style.width = "0px"; box.style.height = "0px";
  }
  function onMouseMove(e) {
    if (!dragging) return;
    const r = rectFromDrag(startX, startY, e.clientX, e.clientY);
    box.style.left = r.x + "px"; box.style.top = r.y + "px";
    box.style.width = r.w + "px"; box.style.height = r.h + "px";
  }
  function onMouseUp(e) {
    if (!dragging) return;
    dragging = false;
    const r = rectFromDrag(startX, startY, e.clientX, e.clientY);
    if (r.w < 8 || r.h < 8) { box.style.display = "none"; return; }   // too small to be deliberate — let them redraw
    box.style.display = "none";
    overlay.style.background = "transparent";   // hide the dimming before the real screenshot so it isn't captured
    chrome.runtime.sendMessage({ action: "regionSelectCrop", rect: r }, (resp) => {
      overlay.style.background = "rgba(0,0,0,.35)";
      if (!resp || !resp.ok) { showMessage("Couldn't capture that — try drawing again, or press Escape to cancel."); return; }
      showPreview(resp.dataUrl);
    });
  }
  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    chrome.runtime.sendMessage({ action: "regionSelectCancel" }, () => { cleanup(); });
  }

  overlay.addEventListener("mousedown", onMouseDown);
  overlay.addEventListener("mousemove", onMouseMove);
  overlay.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown, true);
})();
```

- [ ] **Step 2: Write the tests**

Create `tests/region-select-overlay.test.js`, plain source-assertion style
(same convention as `tests/ext-sw-driver.test.js` and this session's
`tests/fb-capture-hang-fix.test.js` — read the file as a string, assert
structural properties, since there is no `chrome.*` mock harness in this
repo to actually execute a content script):

```js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "region-select.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

t("guards against double injection on an already-active tab", () => {
  assert.ok(/if \(window\.__iaRegionSelectActive\) return;/.test(src));
});
t("sends regionSelectCrop with a {x,y,w,h} rect on mouseup, and hides the dim before capturing", () => {
  assert.ok(/action: "regionSelectCrop", rect: r/.test(src));
  assert.ok(/overlay\.style\.background = "transparent";/.test(src), "the overlay's dimming must be hidden before the screenshot so it isn't captured in the crop");
});
t("ignores a too-small drag instead of treating it as a deliberate selection", () => {
  assert.ok(/r\.w < 8 \|\| r\.h < 8/.test(src));
});
t("shows a preview with Use this / Redo before finalizing", () => {
  assert.ok(/__ia_use_this/.test(src) && /__ia_redo/.test(src));
  assert.ok(/Use this/.test(src) && />Redo</.test(src));
});
t("Use this sends regionSelectFinalize; Redo does not (stays local, re-arms for another drag)", () => {
  const useThisIdx = src.indexOf('"__ia_use_this"');
  const redoIdx = src.indexOf('"__ia_redo"');
  assert.ok(useThisIdx >= 0 && redoIdx >= 0);
  const useThisHandler = src.slice(useThisIdx, redoIdx);
  assert.ok(/action: "regionSelectFinalize"/.test(useThisHandler));
});
t("Escape sends regionSelectCancel and cleans up", () => {
  assert.ok(/e\.key !== "Escape"/.test(src));
  assert.ok(/action: "regionSelectCancel"/.test(src));
});
t("cleanup resets the re-entrancy flag and removes the overlay", () => {
  const start = src.indexOf("function cleanup() {");
  const body = src.slice(start, start + 200);
  assert.ok(/window\.__iaRegionSelectActive = false;/.test(body));
  assert.ok(/overlay\.remove\(\);/.test(body));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 3: Run the test**

Run: `node tests/region-select-overlay.test.js`
Expected: all cases pass.

- [ ] **Step 4: Commit**

```bash
git add extension/region-select.js tests/region-select-overlay.test.js
git commit -m "feat: add the manual point-to-point capture overlay content script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Extension — background wiring for the region-select session

**Files:**
- Modify: `extension/background.js`
- Test: `tests/manual-capture-wiring.test.js`

**Interfaces:**
- Consumes: the 3 message actions from Task 2
  (`regionSelectCrop`/`regionSelectFinalize`/`regionSelectCancel`), and the
  existing `cropScreenshot(tab, rect)` (background.js:481) and `deliverToApp`
  (background.js:275) functions — both already implemented, unchanged here.
- Produces: `manualCaptureSessions` (a `tabId -> {id, url, dataUrl}` map) and
  `startManualCapture(req)` (opens a tab, injects the overlay, tracks the
  session) — both consumed by Task 4's two trigger points.

- [ ] **Step 1: Add the session map and message handlers**

In `extension/background.js`, find the existing
`chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {` that
already handles `"clipSocialPost"` and `"getStatus"` (search for
`msg.action === "clipSocialPost"` to locate it — this is the single shared
onMessage listener; add to it rather than registering a second listener).
Immediately before that `chrome.runtime.onMessage.addListener(...)` line,
add:

```js
// ---- Manual point-to-point capture: session tracking ----
// tabId -> { id, url, dataUrl }. id:"" means a standalone (extension-only,
// no existing card) session — routeCapture's existing id/url-match logic
// decides whether that lands on an existing Imported card or a new Saved
// entry (see routeCapture's "manual capture, no card -> Saved" rule).
let manualCaptureSessions = {};
```

Then, inside that same `chrome.runtime.onMessage.addListener` callback, add
these three branches. Place them right after the existing
`if (msg.action === "clipSocialPost" && msg.data) { ... return true; }`
block (before the `if (msg.action === "getStatus")` block):

```js
  if (msg.action === "regionSelectCrop" && msg.rect) {
    (async () => {
      const tab = sender.tab;
      if (!tab) { sendResponse({ ok: false, error: "no tab" }); return; }
      try {
        const dataUrl = await cropScreenshot(tab, msg.rect);
        if (!dataUrl) { sendResponse({ ok: false, error: "capture failed" }); return; }
        const session = manualCaptureSessions[tab.id];
        if (session) session.dataUrl = dataUrl;
        sendResponse({ ok: true, dataUrl });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.action === "regionSelectFinalize") {
    (async () => {
      const tab = sender.tab;
      const session = tab && manualCaptureSessions[tab.id];
      if (!session || !session.dataUrl) { sendResponse({ ok: false, error: "no capture to finalize" }); return; }
      delete manualCaptureSessions[tab.id];
      await deliverToApp({ url: session.url, id: session.id || "", screenshot: session.dataUrl, force: true, ts: Date.now() });
      await setStatus("Manual capture saved ✓", true);
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "regionSelectCancel") {
    (async () => {
      const tab = sender.tab;
      const session = tab && manualCaptureSessions[tab.id];
      if (session) {
        delete manualCaptureSessions[tab.id];
        // App-triggered (session.id set): tell the app the attempt produced
        // nothing, so the card's "pending" state clears instead of showing
        // pending forever. Standalone (no id): nothing to clear, no-op.
        if (session.id) await deliverToApp({ url: session.url, id: session.id, attempt: true, ok: false, ts: Date.now() });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
```

- [ ] **Step 2: Add `startManualCapture`**

Add this function directly after `captureFbPost` (search for the line
`async function captureFbPost(tab, cardUrl, delayMs, cardId, suppressFail) {`
and its closing `}` a few dozen lines later — place the new function right
after it):

```js
// App-triggered manual point-to-point capture: opens its OWN foreground tab
// (same pattern as captureOneTab's non-FB path) rather than trying to locate
// whatever tab the app's own openLink() may have opened — the app's manual-
// recapture button does NOT call openLink itself for this reason (see
// web/index.html's impManualCapture). No timeout: unlike every other capture
// path, this one is paced by a human deciding what to select, not a page
// finishing rendering — restorePendingRequest's B12 persistence is
// deliberately NOT used here (it assumes a short, bounded capture and would
// wrongly treat a still-in-progress manual selection as abandoned).
async function startManualCapture(req) {
  await setStatus("Waiting for you to select an image…", true);
  let tab;
  try { tab = await chrome.tabs.create({ url: req.url, active: true }); }
  catch (e) { await deliverToApp({ url: req.url, id: req.id || "", attempt: true, ok: false, ts: Date.now() }); return; }
  try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (e) {}
  await waitTabComplete(tab.id, 30000);
  manualCaptureSessions[tab.id] = { id: req.id || "", url: req.url };
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["region-select.js"] }); }
  catch (e) {
    delete manualCaptureSessions[tab.id];
    log("startManualCapture: overlay injection failed: " + e.message);
    await deliverToApp({ url: req.url, id: req.id || "", attempt: true, ok: false, ts: Date.now() });
  }
}
```

- [ ] **Step 3: Write the tests**

Create `tests/manual-capture-wiring.test.js`, plain source-assertion style:

```js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

t("manualCaptureSessions map is declared", () => {
  assert.ok(/let manualCaptureSessions = \{\};/.test(bg));
});
t("regionSelectCrop reuses the existing cropScreenshot primitive, keyed by sender.tab", () => {
  const i = bg.indexOf('msg.action === "regionSelectCrop"');
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 700);
  assert.ok(/await cropScreenshot\(tab, msg\.rect\)/.test(body));
  assert.ok(/const tab = sender\.tab;/.test(body));
});
t("regionSelectFinalize delivers with force:true and the session's id (empty string for standalone)", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 700);
  assert.ok(/deliverToApp\(\{ url: session\.url, id: session\.id \|\| "", screenshot: session\.dataUrl, force: true/.test(body),
    "must NOT set clip:true -- that would always route to a new Saved item and never match an existing Imported card by id/url");
  assert.ok(!/clip:\s*true/.test(body), "regionSelectFinalize's delivery must never set clip:true");
});
t("regionSelectCancel only notifies the app for an app-triggered session (has an id), not a standalone one", () => {
  const i = bg.indexOf('msg.action === "regionSelectCancel"');
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 700);
  assert.ok(/if \(session\.id\) await deliverToApp/.test(body));
});
t("startManualCapture opens its own tab (does not try to find an existing one) and has no timeout on the overlay wait", () => {
  const i = bg.indexOf("async function startManualCapture(req) {");
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 1200);
  assert.ok(/chrome\.tabs\.create\(\{ url: req\.url, active: true \}\)/.test(body));
  assert.ok(!/setTimeout.*regionSelect/i.test(body), "must not impose a timeout on the human-paced selection step");
});
t("startManualCapture tracks the session BEFORE injecting the overlay (no race where a fast user beats the session write)", () => {
  const i = bg.indexOf("async function startManualCapture(req) {");
  const body = bg.slice(i, i + 1200);
  const sessionIdx = body.indexOf("manualCaptureSessions[tab.id] =");
  const injectIdx = body.indexOf("chrome.scripting.executeScript");
  assert.ok(sessionIdx >= 0 && injectIdx >= 0 && sessionIdx < injectIdx);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 4: Run the tests + syntax check**

Run: `node --check extension/background.js` (expect no output = valid syntax)
Run: `node tests/manual-capture-wiring.test.js`
Expected: all cases pass.

- [ ] **Step 5: Run the full suite and commit**

Run: `node tests/run.js` — expect `ALL TEST FILES PASSED`.
```bash
git add extension/background.js tests/manual-capture-wiring.test.js
git commit -m "feat: background wiring for the manual point-to-point capture session

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Extension — the two trigger points

**Files:**
- Modify: `extension/background.js`
- Test: `tests/manual-capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `startManualCapture(req)` and `manualCaptureSessions` from Task 3.
- Consumes: the app's new `manual:true` capture-request flag, set in Task 5.

- [ ] **Step 1: Add the standalone context-menu item**

In `extension/background.js`, find `ensureContextMenu()` (search
`async function ensureContextMenu() {`). Inside the
`chrome.contextMenus.removeAll(() => { ... })` callback, immediately after
the existing `chrome.contextMenus.create({ id: "removeFromInterests", ...` block
and BEFORE the status-label item (`id: CTX_STATUS_ID`, which must stay last
so it renders at the bottom of the menu), add:

```js
      chrome.contextMenus.create({
        id: "pointToPointCapture",
        title: "Point-to-point capture",
        contexts: ["action", "page"],
      }, () => { void chrome.runtime.lastError; });
```

Then find `chrome.contextMenus.onClicked.addListener((info, tab) => {`
(search for that exact text) and add a new branch at the very top, before
the existing `if (info.menuItemId === "removeFromInterests")` check:

```js
  if (info.menuItemId === "pointToPointCapture") {
    (async () => {
      if (!tab || !tab.id) return;
      manualCaptureSessions[tab.id] = { id: "", url: tab.url || "" };   // no id = standalone; routeCapture decides match-vs-new-Saved
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["region-select.js"] }); }
      catch (e) { delete manualCaptureSessions[tab.id]; log("pointToPointCapture injection failed: " + e.message); }
    })();
    return;
  }
```

- [ ] **Step 2: Add the app-triggered branch to `pollCaptureRequest`**

In `extension/background.js`, find `async function pollCaptureRequest() {`
and locate this section (immediately after the request is claimed and
before the existing B12 persistence call):

```js
  log("SW poller claimed capture request: " + req.url + (req.render ? " (render)" : "") + (req.force ? " (force/overwrite)" : ""));
```

Add a new branch right after that log line, before the existing
`pendingCaptureBusy = true;` line:

```js
  if (req.manual) {
    // Manual point-to-point capture: human-paced, no timeout, and deliberately
    // NOT persisted via B12 (persistPending/restorePendingRequest assume a
    // short, bounded capture and would wrongly treat an in-progress manual
    // selection as abandoned after PENDING_MAX_AGE_MS). startManualCapture
    // delivers its own outcome (via the region-select message handlers in
    // Task 3) whenever the user finishes or cancels.
    await startManualCapture(req);
    return;
  }
```

- [ ] **Step 3: Extend the tests**

Add to `tests/manual-capture-wiring.test.js`:

```js
t("ensureContextMenu creates a pointToPointCapture item before the status label (so it isn't the last item)", () => {
  const start = bg.indexOf("async function ensureContextMenu() {");
  const end = bg.indexOf("ensureContextMenu();", start);
  const body = bg.slice(start, end);
  const itemIdx = body.indexOf('id: "pointToPointCapture"');
  const statusIdx = body.indexOf("id: CTX_STATUS_ID");
  assert.ok(itemIdx >= 0 && statusIdx >= 0 && itemIdx < statusIdx,
    "pointToPointCapture must be created before the status label, which must stay last");
});
t("the context-menu click handler starts a standalone session (no id) and injects the overlay", () => {
  const start = bg.indexOf("chrome.contextMenus.onClicked.addListener((info, tab) => {");
  const body = bg.slice(start, start + 600);
  assert.ok(/info\.menuItemId === "pointToPointCapture"/.test(body));
  assert.ok(/manualCaptureSessions\[tab\.id\] = \{ id: "", url: tab\.url \|\| "" \};/.test(body));
});
t("pollCaptureRequest's req.manual branch skips the automatic pipeline (captureOneTab/persistPending) entirely", () => {
  const start = bg.indexOf("async function pollCaptureRequest() {");
  const end = bg.indexOf("\nasync function pollBatchState", start);
  const body = bg.slice(start, end);
  const manualIdx = body.indexOf("if (req.manual) {");
  assert.ok(manualIdx >= 0, "req.manual branch not found");
  assert.ok(manualIdx < body.indexOf("pendingCaptureBusy = true;"),
    "the manual branch must return BEFORE the automatic pipeline's persistPending/captureOneTab machinery runs");
  const manualBranch = body.slice(manualIdx, body.indexOf("return;", manualIdx) + 7);
  assert.ok(/await startManualCapture\(req\);/.test(manualBranch));
});
```

- [ ] **Step 4: Run the tests + full suite, then commit**

Run: `node --check extension/background.js`
Run: `node tests/manual-capture-wiring.test.js`
Run: `node tests/run.js` — expect `ALL TEST FILES PASSED`.
```bash
git add extension/background.js tests/manual-capture-wiring.test.js
git commit -m "feat: wire up the manual point-to-point capture trigger points

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: App — card-face manual-capture icon

**Files:**
- Modify: `web/index.html`
- Modify: `pwa/index.html` (byte-identical mirror)
- Modify: `pwa/sw.js` (`SHELL_CACHE` bump — fold into this task's commit if
  Task 1 hasn't already bumped it in this branch; otherwise this task's own
  edit still needs its own bump on top of Task 1's, since each already-cached
  file edit needs one)
- Test: `tests/manual-capture-app-trigger.test.js`

**Interfaces:**
- Produces: `impManualCapture(idx)`, the new icon's click handler.
- Consumes: `Store.setCaptureRequest` (existing), `anchorImpOnCard` (existing).

- [ ] **Step 1: Add the card-face icon**

In `web/index.html`, find the card template's button row (search for
`class="imp-refresh${` — this is the existing "↻ Refresh image" button).
The full line looks like this:

```js
    ${selMode?`<div class="pickov" onclick="togglePick(${idx})">${selPicks.has(idx)?'<span class="pk">&#10003;</span>':""}</div>`:`${it.url?`<button class="imp-refresh${(it.lastResult==='pending' && _refreshPins.has(it.id))?' spin':''}" title="Refresh image — recapture this page" onclick="event.stopPropagation();impRefresh(${idx})">&#8635;</button>`:""}<button class="imp-reader" title="Open reader view" onclick="event.stopPropagation();openReader(${idx})">&#128214;</button><button class="imp-title" title="Suggest a new title for this card (AI)" onclick="event.stopPropagation();impRefreshTitle(${idx})">Aa</button>${it.origTitle!==undefined?`<button class="imp-revert" title="Revert to the original title: ${esc(it.origTitle).replace(/"/g,"&quot;")}" onclick="event.stopPropagation();impRevertTitle(${idx})">&#8617;</button>`:""}<button class="imp-edit" title="Edit card" onclick="event.stopPropagation();impEdit(${idx})">&#9998;</button>`}
```

Insert a new `imp-manualcap` button immediately after the `imp-refresh`
button's closing `</button>` (inside the same `it.url?` ternary, so it only
renders for cards that have a link — a manual capture needs a URL to open,
same requirement as refresh):

```js
    ${selMode?`<div class="pickov" onclick="togglePick(${idx})">${selPicks.has(idx)?'<span class="pk">&#10003;</span>':""}</div>`:`${it.url?`<button class="imp-refresh${(it.lastResult==='pending' && _refreshPins.has(it.id))?' spin':''}" title="Refresh image — recapture this page" onclick="event.stopPropagation();impRefresh(${idx})">&#8635;</button><button class="imp-manualcap" title="Manually capture this card's image (draw a box on the page)" onclick="event.stopPropagation();impManualCapture(${idx})">&#9635;</button>`:""}<button class="imp-reader" title="Open reader view" onclick="event.stopPropagation();openReader(${idx})">&#128214;</button><button class="imp-title" title="Suggest a new title for this card (AI)" onclick="event.stopPropagation();impRefreshTitle(${idx})">Aa</button>${it.origTitle!==undefined?`<button class="imp-revert" title="Revert to the original title: ${esc(it.origTitle).replace(/"/g,"&quot;")}" onclick="event.stopPropagation();impRevertTitle(${idx})">&#8617;</button>`:""}<button class="imp-edit" title="Edit card" onclick="event.stopPropagation();impEdit(${idx})">&#9998;</button>`}
```

`imp-manualcap` has no dedicated CSS rule yet — find the existing
`.imp-refresh` CSS rule (search the `<style>` block for `.imp-refresh{`) and
add a `.imp-manualcap{}` rule copying its declarations verbatim (same
positioning/sizing as the other card-face icon buttons), so the new button
matches the existing row's look without needing new layout work.

- [ ] **Step 2: Implement `impManualCapture`**

Add this function directly after `impRefresh(idx)`:

```js
// Manual point-to-point capture for an existing card: arms a "manual"
// capture request and lets the extension take it from there (it opens its
// OWN tab — see extension/background.js's startManualCapture — so this
// deliberately does NOT call openLink itself, unlike impOpen/impRefresh).
function impManualCapture(idx){
  const it=imported[idx]; if(!it||!it.url) return;
  if(!it.id){ it.id=newId(); Store.putCards(imported); }
  anchorImpOnCard(it);
  it.lastUpdate=Date.now(); if(it.lastResult!=="ok") it.lastResult="pending";
  Store.putCards(imported);
  Store.setCaptureRequest({url:it.url, id:it.id, manual:true});
  toast("Opening the article — draw a box around the image you want, then Use this");
}
```

Apply the identical icon markup and `impManualCapture` function to
`pwa/index.html`.

- [ ] **Step 3: Bump the PWA shell cache**

In `pwa/sw.js`, increment `SHELL_CACHE`'s version number by 1 (on top of
Task 1's bump, if that task already ran in this branch — every edit to an
already-cached file needs its own increment).

- [ ] **Step 4: Run the syntax gate**

Run: `node tests/syntax-check.js`

- [ ] **Step 5: Write the tests**

Create `tests/manual-capture-app-trigger.test.js`, following this repo's
`extractFn` convention (same as Task 1's test file) for pulling
`impManualCapture` out of `web/index.html` and `pwa/index.html` with stubbed
globals (`imported`, `Store` with a spy `setCaptureRequest`, `anchorImpOnCard`,
`toast`, `newId`):

```js
t("impManualCapture arms a manual:true request with the card's id, and does NOT call openLink", () => {
  imported.length = 0;
  imported.push({ id:"c1", url:"https://example.com/a" });
  const calls = [];
  Store.setCaptureRequest = (req) => calls.push(req);
  let openLinkCalled = false;
  global.openLink = () => { openLinkCalled = true; };   // must stay unused by this function
  impManualCapture(0);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], { url:"https://example.com/a", id:"c1", manual:true });
  assert.strictEqual(openLinkCalled, false);
});
t("impManualCapture assigns a new id to an id-less card before arming the request", () => {
  imported.length = 0;
  imported.push({ url:"https://example.com/b" });
  const calls = [];
  Store.setCaptureRequest = (req) => calls.push(req);
  impManualCapture(0);
  assert.ok(imported[0].id);
  assert.strictEqual(calls[0].id, imported[0].id);
});
t("impManualCapture no-ops on a card with no url", () => {
  imported.length = 0;
  imported.push({ id:"c2" });
  const calls = [];
  Store.setCaptureRequest = (req) => calls.push(req);
  impManualCapture(0);
  assert.strictEqual(calls.length, 0);
});
```
Mirror every case for the `pwa/` extraction too.

- [ ] **Step 6: Run the tests + full suite, then commit**

Run: `node tests/manual-capture-app-trigger.test.js`
Run: `node tests/run.js` — expect `ALL TEST FILES PASSED`.
```bash
git add web/index.html pwa/index.html pwa/sw.js tests/manual-capture-app-trigger.test.js
git commit -m "feat: add the card-face manual point-to-point capture icon

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `routeCapture` regression tests for the new payload shapes

**Files:**
- Test: `tests/route-capture.test.js` (extend the existing file)

**Interfaces:**
- Consumes: `routeCapture` (`web/route-capture.js`, mirrored in
  `pwa/route-capture.js`) — no source changes in this task, only tests. Its
  existing `cap.force && !cap.id && !cap.blocked → { action: "saved" }` rule
  and its existing id/url-match `card-image` rule already implement
  everything this feature needs.

- [ ] **Step 1: Add the regression tests**

Open `tests/route-capture.test.js` and add (matching its existing style —
read the file first to match its exact `require`/helper pattern):

```js
t("manual point-to-point capture with an id routes to card-image, same as any other id-matched non-clip capture", () => {
  const imported = [{ id:"c1", url:"https://example.com/a" }];
  const cap = { url:"https://example.com/a", id:"c1", screenshot:"data:image/jpeg;base64,xx", force:true, ts:Date.now() };
  const decision = routeCapture(cap, { imported, now: Date.now() });
  assert.strictEqual(decision.action, "card-image");
  assert.strictEqual(decision.target.id, "c1");
});
t("manual point-to-point capture with no id and no existing match creates a new Saved item (previously-unreachable branch)", () => {
  const imported = [{ id:"c1", url:"https://example.com/other" }];
  const cap = { url:"https://example.com/brand-new", id:"", screenshot:"data:image/jpeg;base64,xx", force:true, ts:Date.now() };
  const decision = routeCapture(cap, { imported, now: Date.now() });
  assert.strictEqual(decision.action, "saved");
  assert.strictEqual(decision.reason, "manual capture, no card → Saved");
});
t("manual point-to-point capture with no id but a URL match on an existing Imported card updates that card, not Saved", () => {
  const imported = [{ id:"c1", url:"https://example.com/existing" }];
  const cap = { url:"https://example.com/existing", id:"", screenshot:"data:image/jpeg;base64,xx", force:true, ts:Date.now() };
  const decision = routeCapture(cap, { imported, now: Date.now() });
  assert.strictEqual(decision.action, "card-image");
  assert.strictEqual(decision.target.id, "c1");
});
```

- [ ] **Step 2: Run the tests + full suite, then commit**

Run: `node tests/route-capture.test.js`
Run: `node tests/run.js` — expect `ALL TEST FILES PASSED`.
```bash
git add tests/route-capture.test.js
git commit -m "test: lock in routeCapture behavior for manual point-to-point captures

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
