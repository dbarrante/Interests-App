# Image Display Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining gaps between here and "captured photos always display reliably" on PC, browser, and mobile — generalize durable-image conversion beyond Facebook/Instagram, add missing broken-image fallbacks, reject/detect corrupt image bytes server-side, and stop the mobile "Stop capture" button from hanging forever when no desktop extension is available to service it.

**Architecture:** Four independent fixes, each localized to where its gap was found (`extension/background.js`; `web/index.html` + `pwa/index.html`, kept identical; `core/images.js` + `core/server.js`). No shared new abstraction — each reuses a pattern already proven elsewhere in this codebase.

**Tech Stack:** Plain browser JS (extension + PWA/web), Node (`core/`), custom test runner (`node tests/run.js`).

## Global Constraints

- `web/index.html` and `pwa/index.html` are documented as byte-for-byte copies except for `<script>` tags — every edit to a shared function must be applied identically to both files.
- This codebase has no browser test harness for `extension/background.js` — tests extract function source via `fs.readFileSync` + a `grab()` helper and `eval()` it standalone (see `tests/durable-cdn-image.test.js`).
- `web/lib/capture-state.js` / `pwa/lib/capture-state.js` DO support `require()` directly (dual browser/Node export pattern) — `isBadImg()` is unchanged by this plan and needs no new tests.
- `pwa/sw.js`'s `SHELL_CACHE` constant must be bumped on any edit to `pwa/index.html` or any `pwa/*.js` file — read its live value fresh before bumping.
- `node tests/run.js` must print `ALL TEST FILES PASSED` before every commit in this plan.
- This plan builds on top of `f0d911a` (Instagram CDN durability) and `16a04ca` (junk-screenshot detection) — do not redo either.

---

### Task 1: Generalize `durableImage()` to every capture path (Approach A)

**Files:**
- Modify: `extension/background.js:293-297` (`durableImage`), `:494-495` (`clipCurrentPage`'s `ogImage`/`contentImage` fields)
- Test: `tests/durable-cdn-image.test.js` (extend/update existing assertions)

**Interfaces:**
- Produces: `durableImage(url)` (signature unchanged) now attempts conversion for ANY non-empty, non-`data:` URL — not just ones matching `isExpiringCdnImage()`. `isExpiringCdnImage()` itself is unchanged (still used by `isBadImg()` as a safety net).

- [ ] **Step 1: Write the failing test**

In `tests/durable-cdn-image.test.js`, replace the existing test named `"durableImage falls back to fetchAsDataUrl and keeps the raw URL only if that fetch fails"` (the last `t(...)` block before `console.log(passed + " passed, " + failed + " failed");`) with:

```js
t("durableImage no longer gates on isExpiringCdnImage — Approach A: attempt conversion for any external URL", () => {
  const body = grab(bg, "durableImage");
  assert.ok(body.indexOf("isExpiringCdnImage(url)") === -1,
    "must no longer gate on isExpiringCdnImage — that gate was the whole gap (Pinterest/YouTube/generic CDNs were never protected, only Facebook/Instagram)");
  assert.ok(body.indexOf("fetchAsDataUrl(url)") >= 0, "must still convert via the existing CORS-bypassing fetchAsDataUrl helper");
  assert.ok(/return data \|\| url/.test(body), "must still keep the raw URL as a last resort if the durable fetch fails (never worse than before)");
});

t("durableImage early-outs for an already-durable data: URL or an empty string (no wasted fetch)", () => {
  const body = grab(bg, "durableImage");
  assert.ok(/if\s*\(!url \|\| url\.indexOf\("data:"\) === 0\)\s*return url;/.test(body),
    "must early-out before attempting a fetch for a url that's already durable or empty");
});

t("durableImage actually converts a non-Meta CDN URL now (e.g. Pinterest) — this is the real fix, proven by execution not just source text", () => {
  let calledWith = null;
  async function fetchAsDataUrl(u) { calledWith = u; return "data:image/jpeg;base64,AAAA"; }
  const durableImage = eval("(" + grab(bg, "durableImage") + ")");
  return durableImage("https://i.pinimg.com/564x/ab/cd/ef.jpg").then((result) => {
    assert.strictEqual(calledWith, "https://i.pinimg.com/564x/ab/cd/ef.jpg", "must have attempted the fetch — before this fix, isExpiringCdnImage(pinimg url) is false, so the fetch was skipped entirely");
    assert.strictEqual(result, "data:image/jpeg;base64,AAAA");
  });
});

t("clipCurrentPage converts ogImage/contentImage through durableImage too (previously only captureTab did — clipCurrentPage's right-clicked-image case was protected, but its scraped og:image/contentImage were not)", () => {
  const body = grab(bg, "clipCurrentPage");
  assert.ok(/ogImage:\s*blocked \? "" : await durableImage\(meta\.ogImage \|\| ""\)/.test(body),
    "clipCurrentPage's payload.ogImage must be converted via durableImage before delivery");
  assert.ok(/contentImage:\s*blocked \? "" : await durableImage\(meta\.contentImage \|\| ""\)/.test(body),
    "clipCurrentPage's payload.contentImage must be converted via durableImage before delivery");
});
```

Leave every other existing test in the file unchanged (the four `isExpiringCdnImage`-specific tests and the `captureTab` ogImage/contentImage test all still hold — `isExpiringCdnImage` itself isn't being modified this task).

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/durable-cdn-image.test.js`
Expected: the 4 new/replaced tests FAIL (`durableImage` still gates on `isExpiringCdnImage`; `clipCurrentPage`'s `ogImage`/`contentImage` are still raw, unconverted).

- [ ] **Step 3: Write minimal implementation**

In `extension/background.js`, replace `durableImage` (lines 293-297) with:

```js
async function durableImage(url) {
  if (!url || url.indexOf("data:") === 0) return url; // already durable, or nothing to do
  const data = await fetchAsDataUrl(url);
  return data || url;
}
```

In `clipCurrentPage`, replace the `ogImage`/`contentImage` fields in the `payload` object literal (lines 494-495):

```js
    ogImage: blocked ? "" : await durableImage(meta.ogImage || ""),
    contentImage: blocked ? "" : await durableImage(meta.contentImage || ""),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/durable-cdn-image.test.js`
Expected: all tests pass — read the printed `passed`/`failed` counts and confirm `0 failed`.

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add extension/background.js tests/durable-cdn-image.test.js
git commit -m "fix(ext): durableImage() protects every capture path, not just Facebook/Instagram CDNs (Approach A: default-to-durable)"
```

---

### Task 2: `editImgPreview` — add the missing broken-image fallback

**Files:**
- Modify: `web/index.html:3299-3303` (`edRenderPrev`)
- Modify: `pwa/index.html` (identical function — re-read fresh to confirm current line numbers before editing, per this plan's Global Constraints)
- Test: `tests/ux-loop06.test.js` (extend)

**Interfaces:**
- Produces: `edRenderPrev()` (signature unchanged) now sets `p.onerror` before assigning `p.src`. Deliberately does NOT use the `outerHTML`-swap-to-`<div>` pattern `impCardHTML`/`dupeThumb` use (see rationale in Step 3) — `edRenderPrev()` is called repeatedly on the SAME element across the modal's lifetime (every time the user changes the image), and a `<div>` swap would permanently destroy the `<img>` element `document.getElementById("editImgPreview")` needs to find on the next call.

- [ ] **Step 1: Write the failing test**

Add to `tests/ux-loop06.test.js`, after the existing UX-6 block (before the final `console.log("ux-loop06: "...)` line — if Task 7 of the sync-reliability plan already moved that line, add these new assertions immediately before it):

```js
// UX-7 (2026-07-15 image-reliability plan): editImgPreview had no onerror
// fallback at all — a broken/expired image URL pasted or already stored on
// a card showed a bare broken-image icon in the edit modal. Every other
// card/reader rendering path already falls back favicon -> generic icon;
// this is the one gap. edRenderPrev() sets onerror fresh each call (not an
// outerHTML div-swap like impCardHTML uses) because it's re-invoked on the
// SAME <img> element every time the user changes the image within one
// modal session — a div-swap would permanently break that.
ok("UX-7: edRenderPrev sets onerror before assigning src", /p\.onerror\s*=\s*dom/.test(src));
ok("UX-7: edRenderPrev falls back through a favicon then a neutral placeholder, never a bare broken icon", /s2\/favicons\?domain=/.test(src) && /data:image\/svg\+xml/.test(src));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ux-loop06.test.js`
Expected: both new UX-7 assertions FAIL (current `edRenderPrev` has no `onerror` at all).

- [ ] **Step 3: Write minimal implementation**

In `web/index.html`, replace `edRenderPrev` (lines 3299-3303):

```js
function edRenderPrev(){
  const p=document.getElementById("editImgPreview"); if(!p) return;
  p.onerror=null;
  if(_editImg){
    // A neutral gray rectangle, not the outerHTML div-swap impCardHTML/dupeThumb
    // use — this element is re-rendered in place every time the user changes
    // the image within the same modal session, so it must stay an <img> with
    // an assignable .src for the NEXT edRenderPrev() call to find.
    const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='54'%3E%3Crect width='100%25' height='100%25' fill='%23e8e4de'/%3E%3C/svg%3E";
    const it = imported[_editIdx];
    const dom = it && it.url ? domain(it.url) : "";
    p.onerror = dom
      ? function(){ this.onerror=function(){ this.onerror=null; this.src=placeholder; }; this.src="https://www.google.com/s2/favicons?domain="+encodeURIComponent(dom)+"&sz=64"; }
      : function(){ this.onerror=null; this.src=placeholder; };
    p.src=_editImg;
  }
  else { p.src=""; }
}
```

Re-read `pwa/index.html`'s current `edRenderPrev` location fresh (do not assume it matches `web/index.html`'s line numbers):

Run: `grep -n "^function edRenderPrev" pwa/index.html`

Then replace it with the identical function shown above.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ux-loop06.test.js`
Expected: both UX-7 assertions pass.

Confirm `pwa/index.html`'s `edRenderPrev` is identical to `web/index.html`'s:

```bash
node -e '
const fs = require("fs");
function grab(src, name) {
  const idx = src.indexOf("function " + name + "(");
  const open = src.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < src.length; i++) { const ch = src[i]; if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(idx, i);
}
const pwa = grab(fs.readFileSync("pwa/index.html", "utf8"), "edRenderPrev");
const web = grab(fs.readFileSync("web/index.html", "utf8"), "edRenderPrev");
console.log(pwa === web ? "IDENTICAL" : "MISMATCH:\n--pwa--\n" + pwa + "\n--web--\n" + web);
'
```
Expected: `IDENTICAL`

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/ux-loop06.test.js
git commit -m "fix(web,pwa): edit-card image preview falls back to favicon/placeholder instead of showing a broken-image icon"
```

---

### Task 3: `dupeThumb()` — add the missing broken-image fallback

**Files:**
- Modify: `web/index.html:4538` (`dupeThumb`'s http(s)-URL branch)
- Modify: `pwa/index.html` (identical function — re-read fresh before editing)
- Test: `tests/ux-loop06.test.js` (extend)

**Interfaces:**
- Produces: `dupeThumb(mem)` (signature unchanged) — its http(s)-URL branch now includes the same `onerror="this.outerHTML='<div class=ph></div>'"` its own `idb:`-URL branch (immediately above it) already has.

- [ ] **Step 1: Write the failing test**

Add to `tests/ux-loop06.test.js`, after the UX-7 block:

```js
// UX-7 cont'd: dupeThumb's http(s)-URL branch had no onerror at all, unlike
// the idb: branch right above it in the same function.
ok("UX-7: dupeThumb's http(s) branch has the same onerror fallback as its idb: branch", /<img src="\$\{esc\(src\)\}" loading="lazy" onerror="this\.outerHTML='<div class=ph><\/div>'">/.test(src));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ux-loop06.test.js`
Expected: the new assertion FAILs (current `dupeThumb`'s http(s) branch has no `onerror`).

- [ ] **Step 3: Write minimal implementation**

In `web/index.html`, in `dupeThumb` (around line 4538), change:

```js
  if (src && !isBadImg(src)) return `<img src="${esc(src)}" loading="lazy">`;
```

to:

```js
  if (src && !isBadImg(src)) return `<img src="${esc(src)}" loading="lazy" onerror="this.outerHTML='<div class=ph></div>'">`;
```

Re-read `pwa/index.html`'s current `dupeThumb` location fresh:

Run: `grep -n "^function dupeThumb" pwa/index.html`

Then apply the identical one-line change there.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ux-loop06.test.js`
Expected: the new assertion passes.

Confirm both files match (same technique as Task 2, swap `edRenderPrev` for `dupeThumb` in the `grab()` calls):

```bash
node -e '
const fs = require("fs");
function grab(src, name) {
  const idx = src.indexOf("function " + name + "(");
  const open = src.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < src.length; i++) { const ch = src[i]; if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(idx, i);
}
const pwa = grab(fs.readFileSync("pwa/index.html", "utf8"), "dupeThumb");
const web = grab(fs.readFileSync("web/index.html", "utf8"), "dupeThumb");
console.log(pwa === web ? "IDENTICAL" : "MISMATCH:\n--pwa--\n" + pwa + "\n--web--\n" + web);
'
```
Expected: `IDENTICAL`

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/ux-loop06.test.js
git commit -m "fix(web,pwa): duplicate-review thumbnail falls back gracefully instead of showing a broken-image icon"
```

---

### Task 4: `core/images.js` — reject/detect corrupt image bytes

**Files:**
- Modify: `core/images.js:43-54` (`putImg`, `getImg`)
- Modify: `core/server.js:294-303` (`PUT /api/img/:id` route — extend the existing catch to handle the new throw)
- Test: `tests/images.test.js` (extend)

**Interfaces:**
- Produces: `putImg(storeDir, id, dataUrl)` now throws an `Error` with `.code = "EMPTY_IMAGE"` if the decoded payload is 0 bytes (previously wrote it silently). `getImg(storeDir, id)` now returns `null` for a 0-byte file on disk (previously returned an empty `Buffer`), so `GET /api/img/:id`'s existing `if (!buf)` 404 check catches it — no server-route change needed for `getImg`'s fix.

- [ ] **Step 1: Write the failing test**

Add to `tests/images.test.js`, after the existing `"delImg removes the file..."` test (before the `"imageCount and listImageIds..."` test):

```js
t("putImg throws EMPTY_IMAGE on an empty decoded payload instead of writing a corrupt 0-byte file", () => {
  const dir = tmpStore();
  assert.throws(() => images.putImg(dir, "abc", "data:image/jpeg;base64,"), (e) => e.code === "EMPTY_IMAGE");
  assert.strictEqual(fs.existsSync(path.join(dir, "images", "abc.jpg")), false, "no file must be written on rejection");
});

t("getImg treats a 0-byte file on disk as missing (returns null, not an empty Buffer)", () => {
  const dir = tmpStore();
  // Simulate pre-existing corruption by writing directly, bypassing putImg's new guard.
  fs.writeFileSync(images.imgPath(dir, "corrupt"), Buffer.alloc(0));
  assert.strictEqual(images.getImg(dir, "corrupt"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/images.test.js`
Expected: both new tests FAIL (`putImg` currently writes the empty payload without throwing; `getImg` currently returns an empty `Buffer`, not `null`, for a 0-byte file).

- [ ] **Step 3: Write minimal implementation**

In `core/images.js`, replace `putImg` and `getImg` (lines 43-54):

```js
function putImg(storeDir, id, dataUrl) {
  const p = imgPath(storeDir, id);   // validates id first; throws on a bad id
  const bytes = decodeDataUrl(dataUrl);
  if (bytes.length === 0) {
    const err = new Error("decoded image payload is empty — refusing to write a corrupt file");
    err.code = "EMPTY_IMAGE";
    throw err;
  }
  fs.mkdirSync(imagesDir(storeDir), { recursive: true });
  fs.writeFileSync(p, bytes);
  return id + ".jpg";
}

function getImg(storeDir, id) {
  const p = imgPath(storeDir, id);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  if (buf.length === 0) return null; // corrupt/truncated-to-nothing — treat the same as missing
  return buf;
}
```

In `core/server.js`, the existing `PUT /api/img/:id` route (lines 294-303) already has an `isInvalidImgId(e)` check pattern to extend:

```js
  app.put("/api/img/:id", (req, res) => {
    ctx.syncDirty = true;
    try {
      const file = images.putImg(ctx.storeDir, req.params.id, String(req.body && req.body.data || ""));
      res.json({ ok: true, file });
    } catch (e) {
      if (isInvalidImgId(e)) return res.status(400).json({ ok: false, error: "invalid image id" });
      if (e && e.code === "EMPTY_IMAGE") return res.status(400).json({ ok: false, error: "empty image data" });
      throw e;
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/images.test.js`
Expected: all tests pass — confirm `0 failed` in the printed summary.

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add core/images.js core/server.js tests/images.test.js
git commit -m "fix(core): reject/detect 0-byte corrupt images instead of silently writing or serving them as valid"
```

---

### Task 5: Mobile — stop `pollBatchProgress` from hanging forever

**Files:**
- Modify: `web/index.html:3825-3843` (`pollBatchProgress`, plus a new module-level variable near `let batchUI = {active:false, done:0, total:0};` at line 3624)
- Modify: `pwa/index.html` (identical — re-read fresh before editing)
- Test: `tests/ux-loop06.test.js` (extend)

**Interfaces:**
- Produces: `pollBatchProgress()` (signature unchanged) now resets `batchUI.active` and toasts a clear message after ~20s of no progress record ever appearing, instead of leaving the "■ Stop capture" button/spinner stuck forever. Fixed for BOTH failure shapes: the local server responds but never reports progress (`p` stays `null`, desktop-only scenario) AND the fetch itself throws (standalone mobile PWA with no local server reachable at all — confirmed live: `/api/batch-progress` doesn't exist on GitHub Pages, so this is the path that actually fires on mobile, not the `if(!p)` one this gap was originally framed around).

- [ ] **Step 1: Write the failing test**

Add to `tests/ux-loop06.test.js`, after the UX-7 block:

```js
// UX-7 cont'd (mobile stuck-UI): pollBatchProgress's fetch throws on the
// actual deployed PWA (no /api/batch-progress route exists on GitHub
// Pages) — confirmed by tracing the real request path, not assumed. The
// old catch(e){ return; } meant that path NEVER reached any stuck-check, so
// the fix has to live in a shape both the catch path and the "p stays
// null" path funnel through.
ok("UX-7: pollBatchProgress's catch no longer early-returns (falls through to the shared stuck-check instead)", !/catch\(e\)\{ return; \}/.test(src));
ok("UX-7: pollBatchProgress resets batchUI and toasts after ~20s of no progress ever appearing", /_batchStuckSince/.test(src) && /Recapture needs the desktop app running with the extension/.test(src));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ux-loop06.test.js`
Expected: both new assertions FAIL.

- [ ] **Step 3: Write minimal implementation**

In `web/index.html`, add a new module-level variable immediately after the existing `let batchUI = {active:false, done:0, total:0};` (line 3624):

```js
let batchUI = {active:false, done:0, total:0};
let _batchStuckSince = 0; // pollBatchProgress: first poll where batchUI.active is true but no progress record has ever appeared (no extension/desktop servicing this batch)
```

Replace `pollBatchProgress` in full (lines 3825-3843):

```js
async function pollBatchProgress(){
  if(Date.now() < _batchIgnoreUntil) return;          // just stopped — don't flip back to Stop
  let p = null;
  try{ const j = await fetch("/api/batch-progress").then(r=>r.json()); p = j && j.progress; }
  catch(e){ /* no local server reachable at all (e.g. standalone mobile PWA) — fall through to the stuck-check below instead of returning early */ }
  if(!p){
    // Covers BOTH "the server responded but nothing is running/claimed yet"
    // and "the fetch itself failed" — only force a reset if we're actually
    // waiting on a batch we started (batchUI.active), never during normal
    // idle polling (most polls, all the time, on every platform).
    if(batchUI.active){
      if(!_batchStuckSince) _batchStuckSince = Date.now();
      else if(Date.now() - _batchStuckSince > 20000){
        _batchStuckSince = 0;
        try{ Store.setBatchState({active:false, cancel:true}); }catch(e){}
        batchUI={active:false, done:0, total:0};
        toast("Recapture needs the desktop app running with the extension");
        if(curTab==="imported") renderImported();
      }
    } else {
      _batchStuckSince = 0;
    }
    return;
  }
  _batchStuckSince = 0;
  // stale progress (driver/tab gone) — treat as finished so the button never sticks
  if(p.active && p.ts && (Date.now()-p.ts > 90000)){ p.active=false; }
  const was=batchUI.active;
  batchUI={active:!!p.active, done:p.done||0, total:p.total||0};
  const btn=document.getElementById("batchBtn");
  if(btn) btn.textContent = batchUI.active
    ? ("■ Stop capture ("+batchUI.done+"/"+batchUI.total+")")
    : ("📷 Get pictures & info ("+_getpicTotal()+")");   // renderImported rebuilds the real button just below
  if(was && !batchUI.active){
    try{ Store.setBatchProgress(null); }catch(e){}
    toast("Capture run finished — "+batchUI.done+"/"+batchUI.total+" processed");
    if(fbAuto) scheduleFbAutoNext();   // auto mode: pause, then run the next batch
    if(curTab==="imported") renderImported();
  }
}
```

Re-read `pwa/index.html`'s current `pollBatchProgress` and `let batchUI = ...` locations fresh:

Run: `grep -n "async function pollBatchProgress\|let batchUI = {active:false" pwa/index.html`

Then apply the identical two changes there.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ux-loop06.test.js`
Expected: both new assertions pass.

Confirm both files' `pollBatchProgress` match:

```bash
node -e '
const fs = require("fs");
function grab(src, name) {
  const idx = src.indexOf("async function " + name + "(");
  const open = src.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < src.length; i++) { const ch = src[i]; if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(idx, i);
}
const pwa = grab(fs.readFileSync("pwa/index.html", "utf8"), "pollBatchProgress");
const web = grab(fs.readFileSync("web/index.html", "utf8"), "pollBatchProgress");
console.log(pwa === web ? "IDENTICAL" : "MISMATCH:\n--pwa--\n" + pwa + "\n--web--\n" + web);
'
```
Expected: `IDENTICAL`

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/ux-loop06.test.js
git commit -m "fix(web,pwa): recapture's Stop-capture button no longer hangs forever with no extension/desktop available"
```

---

### Task 6: Bump `SHELL_CACHE`, full-suite verification, wrap-up

**Files:**
- Modify: `pwa/sw.js` (`SHELL_CACHE` constant)

- [ ] **Step 1: Read the live SHELL_CACHE value**

Run: `grep -n "const SHELL_CACHE" pwa/sw.js`
Expected: prints the current version string — read whatever number is actually there; do not assume it matches any number mentioned earlier in this plan or in the sync-reliability plan (both plans, and other work, may have bumped it since either was written).

- [ ] **Step 2: Bump it by exactly one**

Edit `pwa/sw.js`: increment the version number read in Step 1 by one (Tasks 2, 3, and 5 all touched `pwa/index.html`, which falls under the app-shell cache; Task 1 and Task 4 did not touch any `pwa/` file, but the bump is still needed for the `pwa/index.html` edits).

- [ ] **Step 3: Run the full test suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 4: Commit**

```bash
git add pwa/sw.js
git commit -m "chore(pwa): bump SHELL_CACHE for the image-reliability plan's changes"
```

- [ ] **Step 5: Push and confirm the PWA deploy**

```bash
git push origin master
```

Then confirm the GitHub Pages deploy succeeded:

Run: `gh run list --workflow=deploy-pwa.yml --limit 1`
Expected: the most recent run shows `completed` / `success` for this plan's final commit.

## Manual verification (human only — cannot be automated by a subagent)

1. **Extension reload**: `chrome://extensions` → reload the unpacked extension (Task 1's fix only applies to captures made AFTER the reload — the desktop app's Core/web side needs no reinstall, `core/`/`web/` changes take effect on next launch).
2. **Non-Meta CDN capture**: capture a Pinterest pin or YouTube video via the generic capture path (not the native Save-button path), confirm the card's image is stored as `idb:<id>` (durable), not a raw `pinimg.com`/`ytimg.com` URL — check via the card's "Edit" modal, the image field should show no raw URL if it converted successfully.
3. **Broken-image fallbacks**: open the edit modal on a card with a since-broken image URL (or manually break one via the URL field), confirm it falls back to a favicon or neutral placeholder, never a bare broken-image icon. Same check in the Library-health duplicates-review modal.
4. **Corrupt-image handling**: with the desktop app running, manually truncate a file in the store's `images/` folder to 0 bytes, reload the app, confirm that card falls back gracefully (favicon/icon) instead of showing a broken image or crashing.
5. **Mobile stuck-UI**: on a mobile PWA session with no paired desktop/extension running, trigger a bulk recapture ("Retry all" or similar), confirm the "■ Stop capture" button resets itself with the "Recapture needs the desktop app running with the extension" toast within ~20-25 seconds instead of spinning forever.
