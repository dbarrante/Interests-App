# Electron-native "Capture missing" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Capture missing" work in the Electron app with no extension — the Core fetches each picture-less card's page, extracts its preview image + title/description, downloads the image to the card's image file, and the button drives this directly.

**Architecture:** New self-contained `core/capturemeta.js` (pure `extractOg` + network `captureMetaChunk`, SSRF-guarded, its own drain-not-cancel reader so it never reintroduces the undici teardown crash) behind a new `POST /api/capture-meta` endpoint that writes images via the existing `images.putImg`. The renderer's `startBatchCapture` calls it in batches instead of the Chrome bridge. Social hosts skipped; extension path untouched.

**Tech Stack:** Node CommonJS (`core/*`), Express, Node global `fetch` (undici); plain inline renderer JS. Tests stub `global.fetch` + `linkcheck._setLookup` (no real network).

## Global Constraints

- No real network in tests — stub `global.fetch`; stub DNS via `require("../core/linkcheck")._setLookup(async()=>[{address:"93.184.216.34",family:4}])` (see `tests/contentcheck-probe.test.js`). Use `process.exitCode`, never `process.exit()`.
- **Drain, never cancel** a response body (a cancelled undici body crashes the main process — the v1.3.2 fix). `capturemeta` reads bodies by draining to a size cap.
- SSRF: every page GET and image GET goes through `linkcheck.safeToFetch` (+ `isProbableHost`), re-validated on each redirect hop; social hosts skipped via `linkcheck.isSkippedHost`. Image GET additionally requires `content-type: image/*` and a size cap (~3MB); page body cap ~256KB.
- Additive/non-destructive: image set only when found; title/description filled only if blank or the bare domain; cards marked attempted; no deletes; no other settings touched.
- Bounded: endpoint item cap 100; renderer chunks of 25; concurrency ≤ 6; request timeout clamp ≤ 20000ms; manual + stoppable.
- No changes to the capture extension. The existing extension batch path (`batch-state`/`drainCaptures`) and `startFbCapture` stay as-is.

---

### Task 1: `extractOg` (pure) — `core/capturemeta.js`

**Files:**
- Create: `core/capturemeta.js`
- Test: `tests/capturemeta.test.js`

**Interfaces produced:**
- `extractOg(html) -> { image, title, description }` (pure; `""` for anything missing).

- [ ] **Step 1: Write the failing test** — create `tests/capturemeta.test.js`:

```js
const assert = require("assert");
const cm = require("../core/capturemeta");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("extractOg pulls og:image/og:title/og:description", () => {
  const r = cm.extractOg('<meta property="og:image" content="https://x.com/a.jpg"><meta property="og:title" content="Hi"><meta property="og:description" content="desc">');
  assert.strictEqual(r.image, "https://x.com/a.jpg");
  assert.strictEqual(r.title, "Hi");
  assert.strictEqual(r.description, "desc");
});
t("extractOg tolerates reversed attribute order (content before property)", () => {
  const r = cm.extractOg('<meta content="https://x.com/b.png" property="og:image">');
  assert.strictEqual(r.image, "https://x.com/b.png");
});
t("extractOg falls back: twitter:image, then link image_src", () => {
  assert.strictEqual(cm.extractOg('<meta name="twitter:image" content="https://x/t.jpg">').image, "https://x/t.jpg");
  assert.strictEqual(cm.extractOg('<link rel="image_src" href="https://x/l.jpg">').image, "https://x/l.jpg");
});
t("extractOg title falls back to <title>; description to meta name=description", () => {
  const r = cm.extractOg('<title>  Page Title </title><meta name="description" content="d2">');
  assert.strictEqual(r.title, "Page Title");
  assert.strictEqual(r.description, "d2");
});
t("extractOg empty when nothing present", () => {
  assert.deepStrictEqual(cm.extractOg("<html><body>nothing</body></html>"), { image:"", title:"", description:"" });
  assert.deepStrictEqual(cm.extractOg(null), { image:"", title:"", description:"" });
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capturemeta.test.js`
Expected: FAIL — `Cannot find module '../core/capturemeta'`.

- [ ] **Step 3: Write minimal implementation** — create `core/capturemeta.js`:

```js
// Server-side "capture missing": fetch a card's page, extract its preview image + title/
// description (extractOg, pure), and download the image (captureMetaChunk, Task 2). Self-
// contained SSRF-guarded fetch with a DRAIN-not-cancel reader (cancelling an undici body
// crashes the main process — see the v1.3.2 fix).
"use strict";

var linkcheck = require("./linkcheck");

function _meta(html, prop) {
  var p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var m = new RegExp('<meta[^>]+(?:property|name)\\s*=\\s*["\']' + p + '["\'][^>]*content\\s*=\\s*["\']([^"\']*)["\']', "i").exec(html);
  if (m) return m[1];
  m = new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']*)["\'][^>]*(?:property|name)\\s*=\\s*["\']' + p + '["\']', "i").exec(html);
  return m ? m[1] : "";
}

function extractOg(html) {
  var h = String(html || "");
  var image = _meta(h, "og:image") || _meta(h, "og:image:url") || _meta(h, "twitter:image") || _meta(h, "twitter:image:src");
  if (!image) { var li = /<link[^>]+rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(h); if (li) image = li[1]; }
  var title = _meta(h, "og:title");
  if (!title) { var tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h); if (tt) title = tt[1].replace(/\s+/g, " ").trim(); }
  var description = _meta(h, "og:description") || _meta(h, "description");
  return { image: String(image || "").trim(), title: String(title || "").trim(), description: String(description || "").trim() };
}

module.exports = { extractOg: extractOg };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/capturemeta.test.js`
Expected: PASS — `5 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/capturemeta.js tests/capturemeta.test.js
git commit -m "feat(capturemeta): pure og:image/title/description extractor"
```

---

### Task 2: `captureMetaChunk` (network) — `core/capturemeta.js`

**Files:**
- Modify: `core/capturemeta.js` (add the guarded fetch + chunk runner)
- Test: `tests/capturemeta-fetch.test.js`

**Interfaces:**
- Consumes: `linkcheck.safeToFetch`/`isProbableHost`/`isSkippedHost`, `extractOg` (Task 1).
- Produces: `captureMetaChunk(items: {id,url}[], opts?) -> Promise<[{ id, imageDataUrl, title, description, skipped? }]>` — per item: social/SSRF → `{id, skipped:true, imageDataUrl:"", title:"", description:""}`; else fetch page, extract og, and if an image URL is found+`image/*`+within size, return it as a base64 `data:` URL in `imageDataUrl` (else `""`). Never throws.

- [ ] **Step 1: Write the failing test** — create `tests/capturemeta-fetch.test.js`:

```js
const assert = require("assert");
const cm = require("../core/capturemeta");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  require("../core/linkcheck")._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const realFetch = global.fetch;

  await t("captureMetaChunk: page with og:image -> data URL + title; clean image content-type", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/png" : null }, arrayBuffer: async () => new Uint8Array([1,2,3]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/p.png"><title>Hi</title>' };
    };
    const out = await cm.captureMetaChunk([{ id:"c1", url:"https://example.test/page" }]);
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].imageDataUrl.indexOf("data:image/png;base64,") === 0, "expected png data url, got "+out[0].imageDataUrl.slice(0,30));
    assert.strictEqual(out[0].title, "Hi");
  });

  await t("captureMetaChunk: no og:image -> empty imageDataUrl", async () => {
    global.fetch = async (url) => ({ ok:true, status:200, url:String(url), headers:{ get:()=>null }, text: async () => "<title>No image</title>" });
    const out = await cm.captureMetaChunk([{ id:"c2", url:"https://example.test/none" }]);
    assert.strictEqual(out[0].imageDataUrl, "");
    assert.strictEqual(out[0].title, "No image");
  });

  await t("captureMetaChunk: image url with non-image content-type -> empty", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.bad/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "text/html" : null }, arrayBuffer: async () => new Uint8Array([9]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/x.bad">' };
    };
    const out = await cm.captureMetaChunk([{ id:"c3", url:"https://example.test/p" }]);
    assert.strictEqual(out[0].imageDataUrl, "");
  });

  await t("captureMetaChunk: social + private hosts skipped without fetching", async () => {
    let called = false;
    global.fetch = async () => { called = true; return { ok:true, status:200, headers:{get:()=>null}, text: async()=>"" }; };
    const out = await cm.captureMetaChunk([
      { id:"ig", url:"https://www.instagram.com/p/x/" },
      { id:"priv", url:"http://127.0.0.1:9/" }
    ]);
    const by = {}; out.forEach(x=>by[x.id]=x);
    assert.strictEqual(by.ig.skipped, true);
    assert.strictEqual(by.priv.skipped, true);
    assert.strictEqual(called, false, "must not fetch social/SSRF hosts");
  });

  global.fetch = realFetch;
  require("../core/linkcheck")._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capturemeta-fetch.test.js`
Expected: FAIL — `cm.captureMetaChunk is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `core/capturemeta.js`, add before `module.exports`:

```js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp capture";
var MAX_HOPS = 5;

// Drain a response body to a byte cap WITHOUT cancelling (cancel crashes undici on socket
// end — v1.3.2). Streams via res.body when present; falls back to arrayBuffer/text (test stubs).
async function _drainToBuffer(res, maxBytes) {
  if (res && res.body && typeof res.body.getReader === "function") {
    var reader = res.body.getReader(); var chunks = [], kept = 0;
    while (true) {
      var step = await reader.read(); if (step.done) break;
      if (kept < maxBytes && step.value) {
        var c = Buffer.from(step.value); var room = maxBytes - kept;
        if (c.length > room) c = c.subarray(0, room);
        chunks.push(c); kept += c.length;
      }
    }
    return Buffer.concat(chunks);
  }
  if (res && typeof res.arrayBuffer === "function") { var b = Buffer.from(await res.arrayBuffer()); return b.length > maxBytes ? b.subarray(0, maxBytes) : b; }
  if (res && typeof res.text === "function") { var b2 = Buffer.from(String((await res.text()) || ""), "utf8"); return b2.length > maxBytes ? b2.subarray(0, maxBytes) : b2; }
  return Buffer.alloc(0);
}

async function _fetchHtml(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxBytes || 256 * 1024;
  if (!(await linkcheck.safeToFetch(url, opts))) return { finalUrl: url, html: "" };
  async function once(target) {
    var ac = new AbortController(); var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      var res = await fetch(target, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
      var loc = (res.headers && typeof res.headers.get === "function") ? res.headers.get("location") : null;
      var html = ""; try { html = (await _drainToBuffer(res, maxBytes)).toString("utf8"); } catch (e) { html = ""; }
      return { status: res.status, location: loc, html: html, finalUrl: (res.url || target) };
    } catch (e) { return { status: 0, location: null, html: "", finalUrl: target }; }
    finally { clearTimeout(timer); }
  }
  var current = url;
  for (var hop = 0; hop < MAX_HOPS; hop++) {
    var r = await once(current);
    if (!(r.status >= 300 && r.status < 400 && r.location)) return { finalUrl: current, html: r.html };
    var next; try { next = new URL(r.location, current).href; } catch (e) { return { finalUrl: current, html: "" }; }
    if (!(await linkcheck.safeToFetch(next, opts))) return { finalUrl: current, html: "" };
    current = next;
  }
  return { finalUrl: current, html: "" };
}

async function _fetchImageDataUrl(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxImageBytes || 3 * 1024 * 1024;
  if (!(await linkcheck.safeToFetch(url, opts))) return "";
  var ac = new AbortController(); var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
  try {
    var res = await fetch(url, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
    if (!(res.status >= 200 && res.status < 300)) return "";
    var ct = (res.headers && typeof res.headers.get === "function") ? String(res.headers.get("content-type") || "") : "";
    if (!/^image\//i.test(ct)) return "";
    var buf = await _drainToBuffer(res, maxBytes);
    if (!buf.length) return "";
    return "data:" + ct.split(";")[0].trim() + ";base64," + buf.toString("base64");
  } catch (e) { return ""; }
  finally { clearTimeout(timer); }
}

async function captureMetaChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 6, 6);
  var arr = Array.isArray(items) ? items : [];
  var results = new Array(arr.length);
  var next = 0;
  async function worker() {
    while (true) {
      var idx = next++; if (idx >= arr.length) return;
      var it = arr[idx] || {};
      var url = it.url;
      if (typeof url !== "string" || !linkcheck.isProbableHost(url) || linkcheck.isSkippedHost(url) || !(await linkcheck.safeToFetch(url, opts))) {
        results[idx] = { id: it.id, skipped: true, imageDataUrl: "", title: "", description: "" }; continue;
      }
      var page = await _fetchHtml(url, opts);
      var og = extractOg(page.html);
      var imageDataUrl = "";
      if (og.image) {
        var abs; try { abs = new URL(og.image, page.finalUrl).href; } catch (e) { abs = ""; }
        if (abs) imageDataUrl = await _fetchImageDataUrl(abs, opts);
      }
      results[idx] = { id: it.id, imageDataUrl: imageDataUrl, title: og.title, description: og.description };
    }
  }
  var pool = []; for (var w = 0; w < Math.min(concurrency, arr.length); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}
```

Update the export to add `captureMetaChunk` (keep `extractOg`):

```js
module.exports = { extractOg: extractOg, captureMetaChunk: captureMetaChunk };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/capturemeta-fetch.test.js`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Full gate**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 6: Commit**

```bash
git add core/capturemeta.js tests/capturemeta-fetch.test.js
git commit -m "feat(capturemeta): SSRF-guarded page+image fetch (drain-not-cancel) + chunk runner"
```

---

### Task 3: Endpoint + storage adapter

**Files:**
- Modify: `core/server.js` (require `./capturemeta`; add `POST /api/capture-meta` after `/api/check-content`, before `app.use(express.static(WEB_DIR))`)
- Modify: `web/storage.js` (`SE.captureMeta` + `Store.captureMeta`)
- Test: `tests/capture-meta-endpoint.test.js`; add an `SE` assertion to `tests/storage-url.test.js`

**Interfaces:**
- Consumes: `capturemeta.captureMetaChunk` (Task 2); existing `images.putImg(storeDir, id, dataUrl)`.
- Produces: `POST /api/capture-meta { items:[{id,url}] }` → `{ results:[{ id, hasImage, title, description }] }` (writes the image file when found; never returns the data URL). `Store.captureMeta(items, opts) -> Promise<results[]>`.

- [ ] **Step 1: Write the failing test** — create `tests/capture-meta-endpoint.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const images = require("../core/images");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-cap-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  require("../core/linkcheck")._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/png" : null }, arrayBuffer: async () => new Uint8Array([137,80,78,71]).buffer };
    return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/p.png"><title>Hi</title>' };
  };
  const store = tmpStore();
  const ctx = buildContext(store);
  const { s: core, port } = await listen(createServer(ctx));

  await t("POST /api/capture-meta writes the image file + returns hasImage/title", async () => {
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"c1", url:"https://example.test/page" }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.results[0].hasImage, true);
    assert.strictEqual(r.json.results[0].title, "Hi");
    assert.ok(images.getImg(store, "c1"), "image file should have been written for c1");
    assert.ok(!("imageDataUrl" in r.json.results[0]), "must not return the data url");
  });
  await t("items capped at 100", async () => {
    const big = []; for(let i=0;i<150;i++) big.push({ id:"x"+i, url:"https://www.instagram.com/p/"+i+"/" });
    const r = await req(port, "POST", "/api/capture-meta", { items: big });
    assert.ok(r.json.results.length <= 100, "got "+r.json.results.length);
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  require("../core/linkcheck")._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

Also add to `tests/storage-url.test.js` (alongside the other `SE.*()` assertions, matching its harness style):

```js
  t("capture-meta endpoint", () => {
    assert.strictEqual(SE.captureMeta(), "/api/capture-meta");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/capture-meta-endpoint.test.js` (FAIL — route 404) and `node tests/storage-url.test.js` (FAIL — `SE.captureMeta is not a function`).

- [ ] **Step 3a: Endpoint** — in `core/server.js`, add near the other requires:

```js
const capturemeta = require("./capturemeta");
```

Immediately after the `app.post("/api/check-content", …)` block and before `app.use(express.static(WEB_DIR));`, add (uses the same `storeDir` the existing `/api/img` routes use):

```js
  // ---- Electron-native "Capture missing": fetch each card's page server-side, extract its
  // preview image + title/description, store the image. Social/SSRF skipped. Read/writes images only.
  app.post("/api/capture-meta", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
      const found = await capturemeta.captureMetaChunk(items, {});
      const results = found.map((r) => {
        let hasImage = false;
        if (r && r.imageDataUrl) {
          try { images.putImg(storeDir, r.id, r.imageDataUrl); hasImage = true; }
          catch (e) { console.error("capture-meta putImg failed:", e && e.message); }
        }
        return { id: r && r.id, hasImage: hasImage, title: (r && r.title) || "", description: (r && r.description) || "" };
      });
      res.json({ results: results });
    } catch (e) {
      console.error("capture-meta failed:", e);
      res.status(500).json({ error: "capture failed" });
    }
  });
```

(If `storeDir` is not the in-scope name used by the `/api/img/:id` routes, use whatever local that route uses — read the file to confirm.)

- [ ] **Step 3b: Storage adapter** — in `web/storage.js`, in `SE` (after `checkContent`):

```js
    captureMeta: function () { return "/api/capture-meta"; },
```

In `Store` (append after the last adapter, adding a comma to the prior entry):

```js
,
      captureMeta: function (items, opts) { return jsend("POST", SE.captureMeta(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); }
```

- [ ] **Step 4: Run tests + full gate**

Run: `node tests/capture-meta-endpoint.test.js` (expect `2 passed`), `node tests/storage-url.test.js`, `node tests/syntax-check.js`, `node tests/run.js` (`ALL TEST FILES PASSED`).

- [ ] **Step 5: Commit**

```bash
git add core/server.js web/storage.js tests/capture-meta-endpoint.test.js tests/storage-url.test.js
git commit -m "feat(server): POST /api/capture-meta (page->image+info) + Store.captureMeta"
```

---

### Task 4: Repoint "Capture missing" — `web/index.html`

**Files:**
- Modify: `web/index.html` (replace `startBatchCapture`)
- Test: `tests/capture-wiring.test.js`

**Interfaces:**
- Consumes: `Store.captureMeta` (Task 3); existing `imported`, `needsCapture`/`needsRetry`, `captureable`, `clipKey`, `newId`, `BATCH_CAP`, `batchUI`, `domain`, `Store.putCards`, `renderImportedKeepFocus`, `curTab`, `toast`.

- [ ] **Step 1: Write the failing test** — create `tests/capture-wiring.test.js`:

```js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("startBatchCapture drives capture via the Core (Store.captureMeta)", () => {
  const i = html.indexOf("async function startBatchCapture");
  const j = html.indexOf("function safetyRowHTML"); // a later anchor; bound the search window
  const body = html.slice(i, j > i ? j : i + 4000);
  assert.ok(i >= 0, "startBatchCapture present");
  assert.ok(body.indexOf("Store.captureMeta") >= 0, "should call Store.captureMeta");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `should call Store.captureMeta`.

- [ ] **Step 3: Replace `startBatchCapture`**

Find the EXACT current function (from `async function startBatchCapture(mode){` through its closing `}` at the `renderImportedKeepFocus();` line) and replace the whole function with:

```js
let _capStop = false;
async function startBatchCapture(mode){
  if(batchUI.active){ toast("A capture run is already going"); return; }
  const need = imported.filter(mode==="retry" ? needsRetry : needsCapture);
  if(!need.length){ toast(mode==="retry" ? "No failed cards to retry" : "No new cards to capture"); return; }
  const seen=new Set();
  const uniq=need.filter(i=>{ const k=clipKey(i.url); if(seen.has(k)) return false; seen.add(k); return true; });
  const items = uniq.slice(0, BATCH_CAP).map(i=>{ if(!i.id) i.id=newId(); return {id:i.id, url:i.url}; });
  // Mark every dispatched page (and duplicates) attempted now, so a card never loops even if a result is lost.
  const dispatched=new Set(items.map(it=>clipKey(it.url)));
  const at=Date.now();
  imported.forEach(c=>{ if(c.url && dispatched.has(clipKey(c.url)) && captureable(c)){ c.lastUpdate=at; if(!c.lastResult) c.lastResult="pending"; } });
  Store.putCards(imported);
  _capStop=false; batchUI={active:true, done:0, total:items.length};
  const byId={}; imported.forEach(c=>{ if(c&&c.id) byId[c.id]=c; });
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
        if(r.hasImage){ c.img="idb:"+c.id; got++; }
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

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/capture-wiring.test.js` (expect `1 passed`)
Run: `node tests/syntax-check.js` (expect `0 error(s)`)
Run: `node tests/run.js` (expect `ALL TEST FILES PASSED`)

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): Capture missing drives the Core capture-meta path (works in Electron, no extension)"
```

---

### Task 5: Reviews, version bump, installer

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Full gate**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 2: electron-security-reviewer subagent**

Dispatch against the feature diff (focus: both the page GET and the image GET are SSRF-guarded via `linkcheck.safeToFetch` on the initial URL and every redirect hop; image requires `image/*` content-type + size cap; bodies are drained, never cancelled [no undici crash]; item cap 100; the endpoint inherits the existing Origin/CSP middleware; no secret/IPC surface added). Fix findings; re-run `node tests/run.js`; commit.

- [ ] **Step 3: data-safety-reviewer subagent**

Dispatch against the feature diff (focus: writes only `images/<id>.jpg` for picture-less cards via the existing `images.putImg`; non-destructive — image only when found, title/description only if blank; cards marked attempted; no deletes; `Store.putCards` is the only store write, same canonical path). Fix findings; re-run `node tests/run.js`; commit.

- [ ] **Step 4: Version bump** — `package.json` `"1.4.0"` → `"1.4.1"`.

```bash
git add package.json
git commit -m "chore: bump version to 1.4.1 (Electron-native Capture missing)"
```

- [ ] **Step 5: Rebuild installer**

Run: `npm run dist`
Expected: `dist/Interests-App-Setup-1.4.1.exe` (exit 0; unsigned normal).

- [ ] **Step 6: Summarize for Dave** — what shipped, installer path, that Capture missing now works in the Electron app for web/bookmark cards (social still needs the extension), and the queued "toggle off built-in viewer" item is next. Do NOT offer merge/PR.

---

## Self-Review

**Spec coverage:**
- Core fetch page → og:image + title/description → Tasks 1 (`extractOg`) + 2 (`captureMetaChunk`). ✓
- Download preview image to the card's image file (durable) → Task 2 (`_fetchImageDataUrl`) + Task 3 (`images.putImg`). ✓
- Endpoint `/api/capture-meta` (cap 100, returns hasImage/title/description, not the data URL) + `Store.captureMeta` → Task 3. ✓
- Renderer repoint: button drives the Core, image-if-found, title/desc-if-blank, mark attempted, bounded + stoppable → Task 4. ✓
- Social/SSRF skipped; extension path + `startFbCapture` untouched → Task 2 (skip) + Task 4 (only `startBatchCapture` changed). ✓
- Two SSRF surfaces + size/content-type caps + drain-not-cancel → Tasks 1-2 (constraints) + Task 5 (electron-security). ✓
- Additive image-store write → Task 3 + Task 5 (data-safety). ✓
- Pure og-extractor + stubbed-fetch tests (no real network) → Tasks 1-3 tests. ✓
- Version bump + installer → Task 5. ✓

**Placeholder scan:** none — complete code/anchors everywhere. (Task 3 notes "confirm `storeDir` name" — a read-and-verify instruction, with the exact call shown.)

**Type consistency:** `captureMetaChunk` → `[{id, imageDataUrl, title, description, skipped?}]`; endpoint consumes `imageDataUrl` (writes via `images.putImg(storeDir,id,dataUrl)`) and returns `{id,hasImage,title,description}`; `Store.captureMeta` → results; `startBatchCapture` reads `r.hasImage`/`r.title`/`r.description` and sets `c.img="idb:"+id`. `extractOg` → `{image,title,description}`. Names consistent across tasks.
