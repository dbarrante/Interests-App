# Capture & Routing (v2 #1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make extension saves safe and reliable — a Save can never overwrite the wrong Imported card, YouTube videos save as a clean thumbnail, and saved pins reliably show a picture — with the routing decision extracted into a pure, unit-tested function.

**Architecture:** Extract the capture-routing *decision* from `drainCaptures` into a pure `routeCapture()` in a new dual browser/Node module `web/route-capture.js` (unit-tested). `drainCaptures` calls it, logs `[route]`, and executes. Plus two reliability fixes (YouTube thumbnail, pin image) in the extension and the render fallback.

**Tech Stack:** Vanilla JS (browser + Node), Electron app, plain-Node `assert` tests (no framework), Chrome MV3 extension.

## Global Constraints

- Repo root: `D:\Dropbox\Documents\Claude\Projects\Interests App`. Use absolute paths; `cd` there for Bash. Windows; retry git on Dropbox `.git` lock; CRLF warnings are expected.
- Tests are plain Node `assert` scripts run via `node tests/<name>.test.js`; `node tests/run.js` runs the inline-`<script>` syntax gate + every `*.test.js` and must stay green.
- `web/route-capture.js` is a **dual module** (browser global + `module.exports`), same pattern as `web/storage.js` / `extension/bridge-probe.js`, so Node tests can `require()` it.
- **Data-safety rule:** a clip (`cap.clip`) NEVER modifies an Imported card; a non-clip capture sets an image only on a confident, same-domain target and never overwrites an existing good image except on `cap.force`/`cap.recap`.
- Scope: bug-fixes + reliability only. NOT here: ⋯-menu, Pinterest Save-button, Dropbox sync, Instagram import, scheduled extraction.
- Commit after each task (end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).

---

### Task 1: Pure `routeCapture` router + unit tests

**Files:**
- Create: `web/route-capture.js`
- Create: `tests/route-capture.test.js`

**Interfaces:**
- Produces: `routeCapture(cap, ctx)` where `ctx = { imported:Array, lastOpened:{id,ts}|null, now:number, normalizeUrl:fn, domain:fn }` → `{ action: "dead"|"saved"|"card-image"|"unmatched"|"skip", target?:object, reason:string }`. Pure: no DOM, no Store, no side effects.

- [ ] **Step 1: Write the failing tests** — create `tests/route-capture.test.js`:

```js
const assert = require("assert");
const { routeCapture } = require("../web/route-capture");

// Simple stand-in helpers (same shape as the app's).
const normalizeUrl = (u) => (u || "").split("#")[0].replace(/\/+$/, "").toLowerCase();
const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
const base = (extra) => Object.assign({ imported: [], lastOpened: null, now: 1000000, normalizeUrl, domain }, extra || {});

let pass = 0, fail = 0;
function t(n, f) { try { f(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }

t("clip -> saved even when its url matches an imported card", () => {
  const imported = [{ id: "a", url: "https://www.pinterest.com/pin/1/" }];
  const r = routeCapture({ clip: true, url: "https://www.pinterest.com/pin/1/" }, base({ imported }));
  assert.strictEqual(r.action, "saved");
});
t("dead -> dead", () => assert.strictEqual(routeCapture({ dead: true, url: "x" }, base()).action, "dead"));
t("no url -> skip", () => assert.strictEqual(routeCapture({}, base()).action, "skip"));
t("non-clip id match -> card-image(target)", () => {
  const imported = [{ id: "a", url: "u1" }];
  const r = routeCapture({ id: "a", url: "u2" }, base({ imported }));
  assert.strictEqual(r.action, "card-image"); assert.strictEqual(r.target.id, "a");
});
t("non-clip exact url -> card-image", () => {
  const imported = [{ id: "a", url: "https://x.com/p" }];
  assert.strictEqual(routeCapture({ url: "https://x.com/p" }, base({ imported })).action, "card-image");
});
t("non-clip normalized url -> card-image", () => {
  const imported = [{ id: "a", url: "https://x.com/p/" }];
  assert.strictEqual(routeCapture({ url: "https://x.com/p" }, base({ imported })).action, "card-image");
});
t("non-clip same-domain recent active card -> card-image", () => {
  const imported = [{ id: "a", url: "https://x.com/home" }];
  const r = routeCapture({ url: "https://x.com/other" }, base({ imported, lastOpened: { id: "a", ts: 999000 } }));
  assert.strictEqual(r.action, "card-image"); assert.strictEqual(r.target.id, "a");
});
t("BUG GUARD: different-domain active card -> unmatched (never the wrong card)", () => {
  const imported = [{ id: "sg", url: "https://www.pinterest.com/pin/728/" }];
  const r = routeCapture({ url: "https://www.youtube.com/watch?v=z" }, base({ imported, lastOpened: { id: "sg", ts: 999000 } }));
  assert.strictEqual(r.action, "unmatched");
});
t("empty domain on both sides -> unmatched (no '' === '' match)", () => {
  const imported = [{ id: "a", url: "not a url" }];
  const r = routeCapture({ url: "also not a url" }, base({ imported, lastOpened: { id: "a", ts: 999000 } }));
  assert.strictEqual(r.action, "unmatched");
});
t("stale active card -> unmatched", () => {
  const imported = [{ id: "a", url: "https://x.com/h" }];
  const r = routeCapture({ url: "https://x.com/o" }, base({ imported, lastOpened: { id: "a", ts: 0 } }));
  assert.strictEqual(r.action, "unmatched");
});
t("force manual capture, no card -> saved", () => {
  assert.strictEqual(routeCapture({ force: true, url: "https://x.com/p" }, base()).action, "saved");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it — verify it fails.** Run: `cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/route-capture.test.js`. Expected: FAIL — `Cannot find module '../web/route-capture'`.

- [ ] **Step 3: Implement `web/route-capture.js`:**

```js
// Pure capture-routing decision (dual browser/Node, like web/storage.js).
// Given a capture and current state, decide what to do — NO side effects.
// Data-safety: a clip never modifies an Imported card; a non-clip image
// capture only matches a confident, same-domain target.
(function (root) {
  "use strict";
  function find(arr, fn) { for (var i = 0; i < arr.length; i++) { if (fn(arr[i])) return arr[i]; } return null; }

  function routeCapture(cap, ctx) {
    ctx = ctx || {};
    var imported = ctx.imported || [];
    var lastOpened = ctx.lastOpened || null;
    var now = ctx.now || 0;
    var normalizeUrl = ctx.normalizeUrl || function (u) { return u || ""; };
    var domain = ctx.domain || function () { return ""; };

    if (!cap || !cap.url) return { action: "skip", reason: "no url" };
    if (cap.dead) return { action: "dead", reason: "extension reported dead/removed" };
    if (cap.clip) return { action: "saved", reason: "clip -> Saved library (never modifies Imported)" };

    // Non-clip = an image fetched FOR an imported card (batch/auto-capture).
    var target = cap.id ? find(imported, function (it) { return it.id === cap.id; }) : null;
    if (!target) target = find(imported, function (it) { return it.url === cap.url; });
    if (!target) target = find(imported, function (it) { return it.url && normalizeUrl(it.url) === normalizeUrl(cap.url); });
    if (target) return { action: "card-image", target: target, reason: "matched imported card by id/url" };

    var ACTIVE_WINDOW = 30 * 60 * 1000;
    if (lastOpened && lastOpened.id && now - (lastOpened.ts || 0) < ACTIVE_WINDOW) {
      var c = find(imported, function (it) { return it.id === lastOpened.id; });
      if (c && c.url && cap.url) {
        var dc = domain(c.url), dcap = domain(cap.url);
        if (dc && dcap && dc === dcap) return { action: "card-image", target: c, reason: "active card (same domain)" };
      }
    }
    if (cap.force && !cap.id && !cap.blocked) return { action: "saved", reason: "manual capture, no card -> Saved" };
    return { action: "unmatched", reason: "no confident match" };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { routeCapture: routeCapture };
  if (root) root.routeCapture = routeCapture;
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run it — verify it passes.** Run: `node tests/route-capture.test.js`. Expected: PASS — `11 passed, 0 failed`.

- [ ] **Step 5: Full gate.** Run: `node tests/run.js`. Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 6: Commit.**
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add web/route-capture.js tests/route-capture.test.js && git commit -m "feat(capture): pure testable routeCapture router (clips never modify Imported)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire `drainCaptures` to `routeCapture` (remove clip fill-imported branch)

**Files:**
- Modify: `web/index.html` — add `<script src="route-capture.js"></script>` near the other module includes (`storage.js`); rewrite the per-capture decision in `drainCaptures` (~3496-3563) to call `routeCapture`; remove the clip "fill imported card" branch.

**Interfaces:**
- Consumes: `routeCapture(cap, ctx)` (Task 1); existing `addClip(cap)`, `setCardImage(item, src)`, `normalizeUrl`, `domain`, `clipKey`, `isBadImg`, `Store.kvGet`, the dead-removal block, and the `changed/persisted/unmatched/remaining` accounting already in `drainCaptures`.

- [ ] **Step 1: Add the script include.** In `web/index.html`, find the existing `<script src="storage.js"></script>` and add directly after it:
```html
<script src="route-capture.js"></script>
```
(If `storage.js` is loaded differently, place `route-capture.js` immediately before the main inline `<script>` so `routeCapture` is defined before `drainCaptures` runs.)

- [ ] **Step 2: Replace the per-capture decision in `drainCaptures`.** Inside the `for (const cap of queue) { ... }` loop, replace the existing `if(cap.dead){...}`, `if(cap.clip){...}`, and the non-clip `match` resolution (the block from the `if(!cap.url){continue;}` line through where it computes `match`/`viaActive`) with a single decision + dispatch. The new top of the loop body:

```js
    if(!cap.url){ continue; }
    const decision = routeCapture(cap, { imported, lastOpened, now, normalizeUrl, domain });
    console.log("[route] " + cap.url + " -> " + decision.action + " (" + decision.reason + ")");

    if(decision.action === "dead"){
      // remove the matching (or last-opened) card — existing dead-removal logic
      let di = cap.id ? imported.findIndex(it=>it.id===cap.id) : -1;
      if(di<0 && cap.url) di = imported.findIndex(it=>it.url===cap.url);
      if(di<0 && cap.url) di = imported.findIndex(it=>it.url && normalizeUrl(it.url)===normalizeUrl(cap.url));
      if(di<0 && cap.removeActive){ let lo=null; try{ lo=await Store.kvGet("ia_last_opened"); }catch(e){} if(lo&&lo.id) di=imported.findIndex(it=>it.id===lo.id); }
      if(di>=0){ const removed=imported.splice(di,1)[0]; _deadUndo=removed; removedDead++; changed=true;
        console.warn("[drainCaptures] removed unreachable card: "+(removed.title||cap.url)+" ("+(cap.error||"")+")"); }
      continue;
    }

    if(decision.action === "saved"){
      try{ addClip(cap); }catch(e){ console.error("[clip] addClip failed", e); }
      continue;
    }

    if(decision.action === "unmatched" || decision.action === "skip"){
      unmatched++;
      continue;
    }

    // decision.action === "card-image": set the picture on the CONFIDENT target only.
    const match = decision.target;
    // `best` = the capture's chosen image, derived EXACTLY as the current non-clip
    // path already does (the existing expression in drainCaptures — typically the
    // data-URL screenshot, else cap.ogImage/cap.contentImage). Reuse that exact code;
    // do NOT invent a new helper. If it was computed inside the block you replaced,
    // move that one line up so `best` is defined here.
    if(best && (cap.force || cap.recap || isBadImg(match.img))){
      setCardImage(match, best); changed=true;
      if(/facebook\.com|fb\.watch/i.test(match.url||"")) _fbSessCaptured++;
    }
    if(cap.desc && (cap.force || !match.desc)){ match.desc=cap.desc; changed=true; }
    if(cap.title && (cap.force || /^saved\b|^from your\b/i.test(match.title||""))){ match.title=cap.title; changed=true; }
    match.captured=now; if(match.blocked) delete match.blocked; match.lastUpdate=now; match.lastResult="ok"; persisted=true; matched++;
    // fill TRUE duplicates sharing this post id (existing behavior)
    if(best && match.url){ const nu=clipKey(match.url);
      imported.forEach(o=>{ if(o!==match && o.url && clipKey(o.url)===nu && (isBadImg(o.img||"")||cap.recap) && !o.blocked){ setCardImage(o,best); if(cap.desc&&!o.desc)o.desc=cap.desc; o.captured=now; o.lastUpdate=now; o.lastResult="ok"; changed=true; } }); }
    closeRefreshTab(match.id);
    continue;
```

> Implementer note: keep the existing tail of `drainCaptures` (the `remaining` re-enqueue, the `if(changed||persisted){ await Store.putCards(imported); ... updateCounts(); }`, and the `if(changed){ render... }` block) unchanged. `best`/`bestCaptureImage` and `closeRefreshTab` refer to whatever the current function uses to pick the image and close the refresh tab — preserve those exact calls; do not invent new helpers. The point of this task is ONLY: route via `routeCapture`, log `[route]`, send clips to `addClip`, and set images solely on `decision.target`. The old `if(cap.clip){ ...find imp... fill ... }` branch must be gone.

- [ ] **Step 3: Verify the syntax gate.** Run: `cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js`. Expected: syntax-check reports `web/index.html` + `web/route-capture.js` parse with 0 errors; `ALL TEST FILES PASSED`.

- [ ] **Step 4: Sanity-grep that the old branch is gone.** Run: `grep -n "filled imported card from save" web/index.html`. Expected: no output (the old log line/branch removed).

- [ ] **Step 5: Commit.**
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add web/index.html && git commit -m "fix(capture): route captures via routeCapture; clips never fill an Imported card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: YouTube watch-page saves use the clean thumbnail (Fix 3)

**Files:**
- Modify: `extension/background.js` — in the context-menu `onClicked` handler and/or `clipCurrentPage`, set `noShot` for YouTube watch/shorts URLs so the page's og:image (the video thumbnail) is used instead of a full-page screenshot.

**Interfaces:**
- Consumes: existing `clipCurrentPage(tab, opts)` (honors `opts.noShot`) and the popup `clipPage` action that calls it.

- [ ] **Step 1: Add a YouTube check in `clipCurrentPage`.** Near the top of `clipCurrentPage(tab, opts = {})` (after the browser-page guard), add:
```js
  // YouTube hijacks right-click on the player and a full-page screenshot is noisy;
  // a watch/shorts page's og:image IS the clean video thumbnail — prefer it.
  const _u = opts.url || (tab && tab.url) || "";
  if (!opts.image && /(^|\.)youtube\.com\/(watch|shorts\/)/i.test(_u)) {
    opts = Object.assign({}, opts, { noShot: true });
  }
```

- [ ] **Step 2: Verify it parses.** Run: `cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node --check extension/background.js`. Expected: no output (exit 0).

- [ ] **Step 3: Commit.**
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add extension/background.js && git commit -m "fix(ext): YouTube watch/shorts save uses the og:image thumbnail (no page screenshot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Saved-pin image reliability (Fix 4)

**Files:**
- Modify: `web/index.html` — `imageChain` (~657-667): skip the screenshot proxies for Pinterest (they 403), so an image-less pin goes straight to the placeholder instead of a broken-image flash. (The right-click `srcUrl` fix already gives new pin saves a real `i.pinimg.com` image as `chain[0]`; this removes the noisy fallback for the ones that don't.)

**Interfaces:**
- Consumes: existing `imageChain(item)`, `nextImg`, the placeholder render in `nextImg`.

- [ ] **Step 1: Skip proxies for Pinterest in `imageChain`.** Change the proxy guard (currently skips FB/IG) to also skip Pinterest:
```js
  if(item.url && !/facebook\.com|fb\.watch|instagram\.com|pinterest\.(com|ca|co\.uk|com\.au)/i.test(item.url)){
    c.push(`https://s0.wp.com/mshots/v1/${encodeURIComponent(item.url)}?w=640`);
    c.push(`https://image.thum.io/get/width/640/crop/700/${item.url}`);
  }
```
So an image-less Pinterest card resolves to the clean placeholder (no `thum.io 403`, no broken image). Pins saved with a real image (`item.image` set) still show it as `chain[0]`.

- [ ] **Step 2: Verify the gate.** Run: `cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js`. Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 3: Commit.**
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add web/index.html && git commit -m "fix(render): skip screenshot proxies for Pinterest (avoid thum.io 403 / broken image)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Verify — gate + manual smoke checklist

**Files:** none (verification only).

- [ ] **Step 1: Full automated gate.** Run: `cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js`. Expected: `route-capture.test.js` 11/11, syntax gate 0 errors, `ALL TEST FILES PASSED`.

- [ ] **Step 2: Reload the extension** in Chrome (`chrome://extensions` → Interests Capture → ↻).

- [ ] **Step 3: Manual smoke (user-driven), with the app open + Console (Ctrl+Shift+I):**
  - Save a **YouTube** video via the popup "📎 Clip this page to Interests" → it appears in **Saved** with a **clean thumbnail**; console shows `[route] … -> saved`.
  - **Right-click a Pinterest pin → "Save to Interests"** → appears in Saved with its picture; console `[route] … -> saved`; no `thum.io 403`.
  - Confirm a save **never** alters an Imported card (no `filled imported card` behavior; `[route]` shows `saved`, not `card-image`, for clips).
  - Batch "auto-capture in tabs" on an Imported card still attaches its image (`[route] … -> card-image`).

- [ ] **Step 4 (handoff):** report results; this completes v2 sub-project #1. The remaining v2 sub-projects (Dropbox sync, Instagram import, scheduled extraction, ⋯-menu, Pinterest Save-button) are separate design→plan→build passes.
