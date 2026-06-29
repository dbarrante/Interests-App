# AI-assisted Dead-Link Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect "soft-dead" links (pages that return 200 OK but whose content is gone) by adding a free server-side content-heuristic tier plus an optional paid AI-confirmation tier, feeding results into the existing dead-link review modal.

**Architecture:** Three tiers, cheap→paid. Tier 1 (existing HTTP check) is unchanged. Tier 2 is a new server-side module (`core/contentcheck.js`) that fetches the real page and flags suspects with free heuristics. Tier 3 reuses the browser's existing AI layer (user's own key) to confirm only the flagged suspects, then routes confirmed-dead links to the existing `openDeadReview` modal. A free Wayback link is shown on AI-confirmed rows for recovery.

**Tech Stack:** Node.js (CommonJS), Express, Node's global `fetch` (undici), plain browser JS (UMD-style modules like `web/route-capture.js`). Test harness: `tests/*.test.js` run by `tests/run.js` (auto-discovered); endpoint tests stub `global.fetch` (no real network).

## Global Constraints

- **No real network in tests.** Stub `global.fetch` (see `tests/linkcheck-endpoint.test.js`). Avoids the Windows undici teardown crash and keeps tests deterministic.
- **Use `process.exitCode`, never `process.exit()`** in test files (Windows undici crash).
- **Read-only detection.** Nothing in this feature deletes or writes to the store. Removal stays in the existing `applyDeadRemoval` (backup-first) path, untouched.
- **SSRF guard on every fetched URL and every redirect hop** — reuse `linkcheck.isProbableHost`. Social hosts skipped via `linkcheck.isSkippedHost`.
- **Bounded & stoppable:** item cap 200/request (mirror `/api/check-links`); concurrency ≤ 8; request timeout default 8000ms, clamp ≤ 20000ms; response-body size cap 256 KB; AI calls ceilinged at `AI_DEAD_CAP = 200` per sweep with a user-visible "skipped N" message (no silent truncation); manual trigger only; honor the existing `_deadStop` stop flag.
- **API key never reaches the Core.** The AI call stays in the browser, reusing the existing `{anthropic:callAnthropic,…}[S.provider]` dispatch.
- **UMD module pattern** for new `web/*.js`: `(function(root){ … if (typeof module!=="undefined" && module.exports) module.exports = {…}; if (root) root.X = X; })(typeof self!=="undefined"?self:this);`
- **CommonJS** for `core/*.js` with `"use strict";` and `module.exports = {…}` (match `core/linkcheck.js`).

---

### Task 1: Content heuristics (pure) — `core/contentcheck.js`

The pure, network-free core: extract a page's title/text and classify whether it looks dead.

**Files:**
- Create: `core/contentcheck.js`
- Test: `tests/contentcheck.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `extractTitle(html: string) -> string`
  - `extractText(html: string, maxChars?: number) -> string` (default maxChars 1500)
  - `DEAD_PHRASES: string[]` (lowercase)
  - `classifyContent({ originalUrl, finalUrl, status, title, text }) -> { verdict: "suspect"|"likely-alive", reason: string, signals: string[] }`

- [ ] **Step 1: Write the failing test**

Create `tests/contentcheck.test.js`:

```js
const assert = require("assert");
const cc = require("../core/contentcheck");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("extractTitle pulls <title> and trims", () => {
  assert.strictEqual(cc.extractTitle("<html><head><title>  Hello World </title></head>"), "Hello World");
});
t("extractTitle returns '' when absent", () => {
  assert.strictEqual(cc.extractTitle("<html><body>no title</body></html>"), "");
});
t("extractText strips tags+scripts and collapses whitespace", () => {
  const html = "<style>.x{}</style><script>var a=1;</script><p>Hello   <b>there</b></p>";
  assert.strictEqual(cc.extractText(html), "Hello there");
});
t("extractText truncates to maxChars", () => {
  assert.strictEqual(cc.extractText("<p>"+"a".repeat(100)+"</p>", 10).length, 10);
});
t("classifyContent: dead phrase in title -> suspect", () => {
  const r = cc.classifyContent({ originalUrl:"https://x.com/p/1", finalUrl:"https://x.com/p/1", status:200, title:"Page Not Found", text:"whatever content here is fine" });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.some(s => s.indexOf("phrase:") === 0));
});
t("classifyContent: deep path redirected to homepage -> suspect", () => {
  const r = cc.classifyContent({ originalUrl:"https://shop.com/item/12345", finalUrl:"https://shop.com/", status:200, title:"Shop Home", text:"Welcome to our store, browse categories and deals all day long." });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.indexOf("redirect-home") >= 0);
});
t("classifyContent: near-empty body -> suspect", () => {
  const r = cc.classifyContent({ originalUrl:"https://x.com/a", finalUrl:"https://x.com/a", status:200, title:"", text:"  " });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.indexOf("empty") >= 0);
});
t("classifyContent: normal page -> likely-alive", () => {
  const r = cc.classifyContent({ originalUrl:"https://blog.com/post/good", finalUrl:"https://blog.com/post/good", status:200, title:"How to bake bread", text:"A long and useful article about baking sourdough bread at home with tips." });
  assert.strictEqual(r.verdict, "likely-alive");
  assert.strictEqual(r.signals.length, 0);
});
t("classifyContent: homepage->homepage is NOT redirect-home (no deep path)", () => {
  const r = cc.classifyContent({ originalUrl:"https://x.com/", finalUrl:"https://x.com/", status:200, title:"Home", text:"Welcome to the homepage with plenty of normal looking content here." });
  assert.strictEqual(r.signals.indexOf("redirect-home"), -1);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/contentcheck.test.js`
Expected: FAIL — `Cannot find module '../core/contentcheck'`.

- [ ] **Step 3: Write minimal implementation**

Create `core/contentcheck.js`:

```js
// Server-side content analysis for "soft-dead" links (pages that return 200 OK but
// whose content is gone). PURE helpers (extract*/classifyContent) + a guarded probe
// (added in Task 2). Conservative: classifyContent only ever returns "suspect" or
// "likely-alive" — the AI tier (browser) makes the final dead/alive call.
"use strict";

function extractTitle(html) {
  var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function extractText(html, maxChars) {
  var max = maxChars || 1500;
  var s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Lowercase substrings that strongly indicate a removed/missing page. English v1.
var DEAD_PHRASES = [
  "page not found", "page can't be found", "page can’t be found",
  "404 not found", "error 404", "not found",
  "no longer available", "no longer exists", "isn't available", "isn’t available",
  "is not available", "content unavailable", "this content isn't available",
  "doesn't exist", "doesn’t exist", "does not exist",
  "has been removed", "been deleted", "this listing has ended",
  "item is no longer", "product is no longer", "sorry, this page",
  "the page you requested", "domain is for sale", "buy this domain"
];

function pathOf(url) {
  try { return new URL(url).pathname || "/"; } catch (e) { return ""; }
}

function classifyContent(info) {
  info = info || {};
  var title = String(info.title || "");
  var text = String(info.text || "");
  var hay = (title + " " + text).toLowerCase();
  var signals = [];

  for (var i = 0; i < DEAD_PHRASES.length; i++) {
    if (hay.indexOf(DEAD_PHRASES[i]) >= 0) { signals.push("phrase:" + DEAD_PHRASES[i]); break; }
  }

  // Redirected from a real (deep) path to the site homepage.
  if (info.finalUrl) {
    var op = pathOf(info.originalUrl), fp = pathOf(info.finalUrl);
    if (op && op.replace(/\/+$/, "").length > 0 && (fp === "/" || fp === "")) signals.push("redirect-home");
  }

  // Almost no readable text.
  if (text.trim().length < 40) signals.push("empty");

  var reasonMap = { "redirect-home": "redirected to homepage", "empty": "page is nearly empty" };
  var reason = "looks alive";
  if (signals.length) {
    var first = signals[0];
    if (first.indexOf("phrase:") === 0) reason = 'page text says "' + first.slice(7) + '"';
    else reason = reasonMap[first] || "looks removed";
  }
  return { verdict: signals.length ? "suspect" : "likely-alive", reason: reason, signals: signals };
}

module.exports = { extractTitle: extractTitle, extractText: extractText, DEAD_PHRASES: DEAD_PHRASES, classifyContent: classifyContent };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/contentcheck.test.js`
Expected: PASS — `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/contentcheck.js tests/contentcheck.test.js
git commit -m "feat(contentcheck): pure title/text extraction + soft-dead heuristics"
```

---

### Task 2: Content probe (network) — `core/contentcheck.js`

Add the guarded fetch and the chunk runner. Tested against a stubbed `global.fetch`.

**Files:**
- Modify: `core/contentcheck.js` (add `fetchContent`, `checkContentChunk`; require `./linkcheck`)
- Test: `tests/contentcheck-probe.test.js`

**Interfaces:**
- Consumes: `linkcheck.isProbableHost`, `linkcheck.isSkippedHost`, and `classifyContent` (Task 1).
- Produces:
  - `fetchContent(url: string, opts?: {timeoutMs?, maxBytes?}) -> Promise<{ finalUrl, status, title, snippet }>`
  - `checkContentChunk(items: {id,url}[], opts?) -> Promise<{ id, finalUrl, status, title, snippet, verdict, reason }[]>` (skipped/unprobeable items return `{ id, verdict:"skipped", status:"skipped" }`)

- [ ] **Step 1: Write the failing test**

Create `tests/contentcheck-probe.test.js`:

```js
const assert = require("assert");
const cc = require("../core/contentcheck");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  const realFetch = global.fetch;
  // Synthetic responses: /dead -> a "page not found" body; /ok -> a real article; no redirects.
  global.fetch = async (url) => {
    const u = String(url);
    const body = /\/dead/.test(u)
      ? "<html><head><title>Page Not Found</title></head><body>404</body></html>"
      : "<html><head><title>Good Article</title></head><body><p>"+"lots of real content ".repeat(10)+"</p></body></html>";
    return {
      status: 200,
      url: u,
      headers: { get: () => null },
      text: async () => body
    };
  };

  await t("fetchContent returns title+snippet for a 200 page", async () => {
    const r = await cc.fetchContent("https://example.test/ok");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.title, "Good Article");
    assert.ok(r.snippet.indexOf("real content") >= 0);
  });

  await t("checkContentChunk classifies dead vs alive and skips social/SSRF", async () => {
    const out = await cc.checkContentChunk([
      { id: "dead",  url: "https://example.test/dead" },
      { id: "ok",    url: "https://example.test/ok" },
      { id: "ig",    url: "https://www.instagram.com/p/x/" },  // social -> skipped, no fetch
      { id: "priv",  url: "http://127.0.0.1:9/" }              // SSRF -> skipped, no fetch
    ]);
    const by = {}; out.forEach(x => by[x.id] = x);
    assert.strictEqual(by.dead.verdict, "suspect");
    assert.strictEqual(by.ok.verdict, "likely-alive");
    assert.strictEqual(by.ig.verdict, "skipped");
    assert.strictEqual(by.priv.verdict, "skipped");
  });

  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/contentcheck-probe.test.js`
Expected: FAIL — `cc.fetchContent is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `core/contentcheck.js`, add near the top after `"use strict";`:

```js
var linkcheck = require("./linkcheck");
```

And add before `module.exports`:

```js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp link-check";
var MAX_HOPS = 5;

// GET a page's content with the SSRF guard applied to every hop. Redirects followed
// manually so each next host is re-validated (a public url that 30x->internal is NOT
// followed). Body read is capped at maxBytes. Never throws — returns best-effort info.
async function fetchContent(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxBytes || 256 * 1024;

  async function getOnce(target) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      var res = await fetch(target, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
      var loc = (res.headers && typeof res.headers.get === "function") ? res.headers.get("location") : null;
      var body = "";
      try {
        var full = await res.text();
        body = (typeof full === "string" && full.length > maxBytes) ? full.slice(0, maxBytes) : (full || "");
      } catch (e) { body = ""; }
      return { status: res.status, location: loc, body: body, finalUrl: (res.url || target) };
    } catch (e) {
      return { status: 0, location: null, body: "", finalUrl: target };
    } finally {
      clearTimeout(timer);
    }
  }

  var current = url;
  for (var hop = 0; hop < MAX_HOPS; hop++) {
    var r = await getOnce(current);
    var isRedirect = r.status >= 300 && r.status < 400 && r.location;
    if (!isRedirect) {
      return { finalUrl: current, status: r.status, title: extractTitle(r.body), snippet: extractText(r.body) };
    }
    var nextUrl;
    try { nextUrl = new URL(r.location, current).href; } catch (e) { return { finalUrl: current, status: r.status, title: "", snippet: "" }; }
    if (!linkcheck.isProbableHost(nextUrl)) return { finalUrl: current, status: r.status, title: "", snippet: "" };
    current = nextUrl;
  }
  return { finalUrl: current, status: 0, title: "", snippet: "" };
}

// Probe a chunk of {id,url} with a concurrency cap. Social/SSRF/non-probable urls are
// reported {verdict:"skipped"} WITHOUT any network request.
async function checkContentChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 8, 8);
  var arr = Array.isArray(items) ? items : [];
  var results = new Array(arr.length);
  var next = 0;
  async function worker() {
    while (true) {
      var idx = next++;
      if (idx >= arr.length) return;
      var it = arr[idx] || {};
      var url = it.url;
      if (typeof url !== "string" || !linkcheck.isProbableHost(url) || linkcheck.isSkippedHost(url)) {
        results[idx] = { id: it.id, status: "skipped", verdict: "skipped", reason: "skipped", finalUrl: url || "", title: "", snippet: "" };
        continue;
      }
      var c = await fetchContent(url, opts);
      var cls = classifyContent({ originalUrl: url, finalUrl: c.finalUrl, status: c.status, title: c.title, text: c.snippet });
      results[idx] = { id: it.id, finalUrl: c.finalUrl, status: c.status, title: c.title, snippet: c.snippet, verdict: cls.verdict, reason: cls.reason };
    }
  }
  var pool = [];
  for (var w = 0; w < Math.min(concurrency, arr.length); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}
```

Update the export line to include the new functions:

```js
module.exports = { extractTitle: extractTitle, extractText: extractText, DEAD_PHRASES: DEAD_PHRASES, classifyContent: classifyContent, fetchContent: fetchContent, checkContentChunk: checkContentChunk };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/contentcheck-probe.test.js`
Expected: PASS — `2 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/contentcheck.js tests/contentcheck-probe.test.js
git commit -m "feat(contentcheck): SSRF-guarded content probe + chunk runner"
```

---

### Task 3: Endpoint `POST /api/check-content` — `core/server.js`

**Files:**
- Modify: `core/server.js` (require `./contentcheck`; add route after the `/api/check-links` route, ~line 420)
- Test: `tests/contentcheck-endpoint.test.js`

**Interfaces:**
- Consumes: `contentcheck.checkContentChunk` (Task 2).
- Produces: `POST /api/check-content` with body `{ items:[{id,url}], timeoutMs? }` → `{ results: [...] }`. Items capped at 200.

- [ ] **Step 1: Write the failing test**

Create `tests/contentcheck-endpoint.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-cc-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    status: 200, url: String(url), headers: { get: () => null },
    text: async () => /\/dead/.test(String(url))
      ? "<title>No longer available</title>"
      : "<title>Real</title><p>"+"plenty of content ".repeat(10)+"</p>"
  });

  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("POST /api/check-content returns a results array", async () => {
    const r = await req(port, "POST", "/api/check-content", { items: [] });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.results));
  });
  await t("classifies dead vs alive; skips social", async () => {
    const r = await req(port, "POST", "/api/check-content", { items: [
      { id:"dead", url:"https://example.test/dead" },
      { id:"ok",   url:"https://example.test/ok" },
      { id:"ig",   url:"https://www.instagram.com/p/x/" }
    ], timeoutMs: 2000 });
    const by = {}; r.json.results.forEach(x => by[x.id]=x);
    assert.strictEqual(by.dead.verdict, "suspect");
    assert.strictEqual(by.ok.verdict, "likely-alive");
    assert.strictEqual(by.ig.verdict, "skipped");
  });
  await t("items capped at 200", async () => {
    const big = []; for(let i=0;i<250;i++) big.push({ id:"x"+i, url:"https://www.instagram.com/p/"+i+"/" });
    const r = await req(port, "POST", "/api/check-content", { items: big });
    assert.ok(r.json.results.length <= 200, "got "+r.json.results.length);
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/contentcheck-endpoint.test.js`
Expected: FAIL — `/api/check-content` returns 404 (unmatched API route).

- [ ] **Step 3: Write minimal implementation**

In `core/server.js`, near the other requires (top, where `const linkcheck = require("./linkcheck");` is, ~line 17), add:

```js
const contentcheck = require("./contentcheck");
```

Immediately after the `app.post("/api/check-links", …)` block closes (~line 420, before `app.use(express.static(WEB_DIR));`), add:

```js
  // ---- content-aware "soft-dead" check (fetches the real page, runs free heuristics;
  // social/SSRF skipped; never deletes — renderer's AI tier confirms, then user reviews) ----
  app.post("/api/check-content", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 8000, 20000));
      const results = await contentcheck.checkContentChunk(items, { concurrency: 8, timeoutMs: timeoutMs });
      res.json({ results: results });
    } catch (e) {
      console.error("check-content failed:", e);
      res.status(500).json({ error: "check failed" });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/contentcheck-endpoint.test.js`
Expected: PASS — `3 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/server.js tests/contentcheck-endpoint.test.js
git commit -m "feat(server): POST /api/check-content endpoint (soft-dead tier 2)"
```

---

### Task 4: Browser AI helpers (pure) — `web/deadcheck-ai.js`

Prompt builder, tolerant verdict parser, and Wayback URL — all pure, dual browser/Node.

**Files:**
- Create: `web/deadcheck-ai.js`
- Test: `tests/deadcheck-ai.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (on `module.exports` and on the browser global):
  - `buildDeadCheckPrompt({ title, snippet, url }) -> string`
  - `parseDeadVerdict(text: string) -> { dead: boolean, reason: string }`
  - `waybackUrl(url: string) -> string`

- [ ] **Step 1: Write the failing test**

Create `tests/deadcheck-ai.test.js`:

```js
const assert = require("assert");
const d = require("../web/deadcheck-ai");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("buildDeadCheckPrompt includes url/title/snippet and asks for JSON", () => {
  const p = d.buildDeadCheckPrompt({ title:"Page Not Found", snippet:"404", url:"https://x.com/p/1" });
  assert.ok(p.indexOf("https://x.com/p/1") >= 0);
  assert.ok(p.indexOf("Page Not Found") >= 0);
  assert.ok(/json/i.test(p) && p.indexOf('"dead"') >= 0);
});
t("parseDeadVerdict reads plain JSON", () => {
  assert.deepStrictEqual(d.parseDeadVerdict('{"dead":true,"reason":"removed"}'), { dead:true, reason:"removed" });
});
t("parseDeadVerdict reads fenced JSON with prose around it", () => {
  const txt = "Sure!\n```json\n{ \"dead\": false, \"reason\": \"live article\" }\n```\nHope that helps.";
  assert.deepStrictEqual(d.parseDeadVerdict(txt), { dead:false, reason:"live article" });
});
t("parseDeadVerdict on garbage -> safe default {dead:false}", () => {
  const r = d.parseDeadVerdict("I have no idea, sorry.");
  assert.strictEqual(r.dead, false);
});
t("parseDeadVerdict coerces non-boolean dead to false", () => {
  assert.strictEqual(d.parseDeadVerdict('{"dead":"yes"}').dead, false);
});
t("waybackUrl builds the latest-snapshot redirect url", () => {
  assert.strictEqual(d.waybackUrl("https://x.com/p/1"), "https://web.archive.org/web/2/https://x.com/p/1");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/deadcheck-ai.test.js`
Expected: FAIL — `Cannot find module '../web/deadcheck-ai'`.

- [ ] **Step 3: Write minimal implementation**

Create `web/deadcheck-ai.js`:

```js
// Pure helpers for the AI soft-dead confirmation tier (dual browser/Node, like
// web/route-capture.js). The AI call itself reuses index.html's provider dispatch;
// these only build the prompt, parse the reply, and build a recovery link.
(function (root) {
  "use strict";

  function buildDeadCheckPrompt(info) {
    info = info || {};
    var title = String(info.title || "").slice(0, 300);
    var snippet = String(info.snippet || "").slice(0, 1500);
    return [
      "You are checking whether a saved web link is DEAD (the original content is gone:",
      "removed, deleted, a 404/error page, a parked/for-sale domain, or a redirect to a generic homepage).",
      "A page that still shows its real content is ALIVE, even if it asks for login or shows ads.",
      "",
      "URL: " + String(info.url || ""),
      "Page title: " + title,
      "Page text (start): " + snippet,
      "",
      'Respond with ONLY a JSON object, no prose: {"dead": true or false, "reason": "<short reason>"}'
    ].join("\n");
  }

  function parseDeadVerdict(text) {
    var s = String(text || "");
    var m = s.match(/\{[\s\S]*\}/);   // first {...} block (handles code fences / prose)
    if (m) {
      try {
        var o = JSON.parse(m[0]);
        return { dead: o.dead === true, reason: typeof o.reason === "string" ? o.reason : "" };
      } catch (e) { /* fall through */ }
    }
    return { dead: false, reason: "" };
  }

  function waybackUrl(url) {
    return "https://web.archive.org/web/2/" + String(url || "");
  }

  var api = { buildDeadCheckPrompt: buildDeadCheckPrompt, parseDeadVerdict: parseDeadVerdict, waybackUrl: waybackUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.buildDeadCheckPrompt = buildDeadCheckPrompt; root.parseDeadVerdict = parseDeadVerdict; root.waybackUrl = waybackUrl; }
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/deadcheck-ai.test.js`
Expected: PASS — `6 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add web/deadcheck-ai.js tests/deadcheck-ai.test.js
git commit -m "feat(web): pure AI dead-check prompt/parse + wayback url helpers"
```

---

### Task 5: Storage adapter — `web/storage.js`

Expose the new endpoint through the existing `SE`/`Store` layer.

**Files:**
- Modify: `web/storage.js` (add `SE.checkContent` ~line 34; add `Store.checkContent` ~line 127)
- Test: `tests/storage-url.test.js` (add assertions to the existing file)

**Interfaces:**
- Consumes: existing `jsend` and `SE` infrastructure.
- Produces:
  - `SE.checkContent() -> "/api/check-content"`
  - `Store.checkContent(items, opts) -> Promise<results[]>`

- [ ] **Step 1: Write the failing test**

In `tests/storage-url.test.js`, add a case alongside the existing endpoint assertions (find the test that checks `SE.checkLinks` / the "backup/restore/store/import endpoints" block and add):

```js
  await t("check-content endpoint", async () => {
    assert.strictEqual(SE.checkContent(), "/api/check-content");
  });
```

(If `SE.checkLinks` is not yet asserted in this file, place the new assertion in the same block that asserts the other `SE.*()` paths. Use the existing `t(...)`/`assert` helpers already in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/storage-url.test.js`
Expected: FAIL — `SE.checkContent is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `web/storage.js`, after the `checkLinks` line in the `SE` object (~line 34):

```js
    checkContent: function () { return "/api/check-content"; },
```

And after the `checkLinks` line in the `Store` object (~line 127):

```js
      ,checkContent: function (items, opts) { return jsend("POST", SE.checkContent(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); }
```

(Note: `checkLinks` is currently the last property in each object literal with no trailing comma. Add a comma after the `checkLinks` entry, then append `checkContent`. Verify the object literal stays valid — run the syntax gate in Step 4.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/storage-url.test.js` then `node tests/syntax-check.js`
Expected: both PASS (`syntax-check` reports `0 error(s)`).

- [ ] **Step 5: Commit**

```bash
git add web/storage.js tests/storage-url.test.js
git commit -m "feat(storage): Store.checkContent adapter for /api/check-content"
```

---

### Task 6: Wire the UI — `web/index.html`

Load the helper, extend `checkDeadLinks()` with the content+AI tiers (bounded, stoppable, consent-gated), and show the AI reason + Wayback link in the review modal.

**Files:**
- Modify: `web/index.html` (add `<script>` ~line 303; extend `checkDeadLinks` ~line 3642; add `confirmSoftDead`; extend `deadRowHTML` ~line 3669)
- Test: `tests/deadlink-wiring.test.js` (text-assertion gate, like `tests/settings-wiring.test.js`)

**Interfaces:**
- Consumes: `Store.checkContent` (Task 5); `buildDeadCheckPrompt`, `parseDeadVerdict`, `waybackUrl` (Task 4); existing `{anthropic:callAnthropic,…}[S.provider]` dispatch, `_deadStop`, `openDeadReview`, `toast`, `S`, `PROVIDERS`.
- Produces: extended `checkDeadLinks()`; new `confirmSoftDead(suspects)`; `AI_DEAD_CAP` constant; dead-list items may now carry `{ soft:true, softReason, finalUrl }`.

- [ ] **Step 1: Write the failing test**

Create `tests/deadlink-wiring.test.js`:

```js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("loads the deadcheck-ai helper script", () => {
  assert.ok(html.indexOf('src="deadcheck-ai.js"') >= 0);
});
t("checkDeadLinks calls the content tier", () => {
  assert.ok(html.indexOf("Store.checkContent") >= 0);
});
t("uses the AI helpers for the confirmation tier", () => {
  assert.ok(html.indexOf("buildDeadCheckPrompt") >= 0);
  assert.ok(html.indexOf("parseDeadVerdict") >= 0);
});
t("caps paid AI calls", () => {
  assert.ok(/AI_DEAD_CAP\s*=\s*\d+/.test(html));
});
t("offers a wayback recovery link on AI-confirmed rows", () => {
  assert.ok(html.indexOf("waybackUrl(") >= 0);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/deadlink-wiring.test.js`
Expected: FAIL — `loads the deadcheck-ai helper script` (and others) fail.

- [ ] **Step 3a: Load the helper script**

In `web/index.html`, immediately after the existing `<script src="route-capture.js"></script>` (line 303), add:

```html
<script src="deadcheck-ai.js"></script>
```

- [ ] **Step 3b: Add the AI confirmation helper**

In `web/index.html`, immediately before `function checkDeadLinks(){` (~line 3642), insert:

```js
const AI_DEAD_CAP = 200;   // hard ceiling on paid AI calls per sweep (bounded; never silent)
// Tier 3: ask the user's configured AI to confirm each heuristic-suspect link is dead.
// Bounded (AI_DEAD_CAP), stoppable (_deadStop), and only spends after explicit consent.
async function confirmSoftDead(suspects){
  if(!suspects.length) return [];
  const provider = S.provider;
  if(!S.keys[provider] && provider!=="local"){
    toast("Add your "+PROVIDERS[provider].keyName+" in Settings to confirm soft-dead links", 6000);
    return [];
  }
  const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, openrouter:callOpenRouter, local:callLocal}[provider];
  const confirmed = []; let used = 0;
  for(const s of suspects){
    if(_deadStop || used >= AI_DEAD_CAP) break;
    used++;
    toast(`Confirming with AI… ${used}/${Math.min(suspects.length, AI_DEAD_CAP)} — tap to stop`, 60000, ()=>{ _deadStop = true; });
    try{
      const v = parseDeadVerdict(await call(buildDeadCheckPrompt({ title:s.title, snippet:s.snippet, url:s.card.url })));
      if(v.dead) confirmed.push(Object.assign({}, s, { soft:true, softReason:v.reason||s.reason }));
    }catch(e){ console.warn("AI dead-check failed", e); }
  }
  if(suspects.length > AI_DEAD_CAP) toast(`Confirmed the first ${AI_DEAD_CAP}; ${suspects.length-AI_DEAD_CAP} suspects skipped (cap).`, 8000);
  return confirmed;
}
```

- [ ] **Step 3c: Extend `checkDeadLinks` with the content + AI tiers**

In `checkDeadLinks()`, the existing loop fills `dead` from hard-dead results and records `c.card.lc`. Locate the block right after the loop (the line `// Persist the lc markers …` then `Store.putCards(imported); Store.putSaved(saved); writeSavesFile();` then `if(dead.length) openDeadReview(dead);`). Replace from just before that persist comment down to (and including) the `if(dead.length) openDeadReview(dead); else toast(...)` line with:

```js
  // Tier 2: content heuristics for links that came back alive/unknown (non-social only —
  // social was already reported "skipped" by the server probe). Collect suspects.
  const aliveCands = [];
  // Re-derive from the lc markers we just set: alive/unknown + http(s) + a real url.
  cand.forEach(c=>{ const st=c.card.lc && c.card.lc.st; if((st==="alive"||st==="unknown") && /^https?:\/\//i.test(c.card.url||"")) aliveCands.push(c); });
  const suspects = [];
  for(let i=0; i<aliveCands.length && !_deadStop; i+=100){
    const chunk = aliveCands.slice(i, i+100);
    toast(`Reading pages… ${i}/${aliveCands.length} — tap to stop`, 60000, ()=>{ _deadStop = true; });
    let cres = [];
    try{ cres = await Store.checkContent(chunk.map(c=>({ id:c.card.id, url:c.card.url }))); }
    catch(e){ console.warn("check-content chunk failed", e); continue; }
    const byId = {}; cres.forEach(r=>byId[r.id]=r);
    chunk.forEach(c=>{ const r=byId[c.card.id]; if(r && r.verdict==="suspect") suspects.push({ scope:c.scope, card:c.card, title:r.title, snippet:r.snippet, finalUrl:r.finalUrl, reason:r.reason }); });
  }

  // Tier 3: AI confirmation (consent-gated, bounded). Confirmed-dead join the review list.
  if(suspects.length && !_deadStop){
    const ok = confirm(`Checked ${cand.length} link(s). ${suspects.length} look possibly dead.\n\nAsk your AI (${PROVIDERS[S.provider].label}) to confirm them? This uses your API key.`);
    if(ok){
      const confirmedSoft = await confirmSoftDead(suspects);
      confirmedSoft.forEach(s=>dead.push(s));
    }
  }

  // Persist the lc markers (so re-runs resume) via the normal bulk-replace path.
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile();
  if(dead.length) openDeadReview(dead);
  else toast(_deadStop ? "Stopped — none dead so far" : (done ? "No dead links found." : "Nothing to check"), 5000);
```

- [ ] **Step 3d: Show the AI reason + Wayback link in the modal**

In `deadRowHTML(c)` (~line 3669), replace the reason `<span>` so soft-dead rows show the AI reason and a recovery link. Change the `.s` line from:

```js
      <div class="s">${esc(dom)} · <span class="dupe-badge">${tag}</span> · <span style="color:#e0556b">${esc(_deadReason(it.lc&&it.lc.code))}</span></div></div>
```

to:

```js
      <div class="s">${esc(dom)} · <span class="dupe-badge">${tag}</span> · <span style="color:#e0556b">${c.soft ? esc("AI: "+(c.softReason||"content removed")) : esc(_deadReason(it.lc&&it.lc.code))}</span>${c.soft?` · <a href="${esc(waybackUrl(it.url))}" target="_blank" rel="noopener">archived copy</a>`:""}</div></div>
```

- [ ] **Step 4: Run the wiring test + full gate**

Run: `node tests/deadlink-wiring.test.js` then `node tests/run.js`
Expected: wiring test PASS (`5 passed`); `node tests/run.js` ends with `ALL TEST FILES PASSED`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/deadlink-wiring.test.js
git commit -m "feat(ui): soft-dead content+AI tiers in dead-link sweep, with wayback recovery"
```

---

### Task 7: Security/data-safety review, version bump, installer rebuild

**Files:**
- Modify: `package.json` (version bump)
- (Reviews may produce small follow-up edits in `core/contentcheck.js` / `core/server.js`.)

- [ ] **Step 1: Run the full gate**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 2: Run the data-safety-reviewer subagent**

Dispatch the `data-safety-reviewer` subagent against the diff (focus: confirm read-only — no store writes/deletes added; removal path unchanged; nothing auto-deleted; AI receives only title/snippet/url). Address any findings, re-run `node tests/run.js`, commit fixes.

- [ ] **Step 3: Run the electron-security-reviewer subagent**

Dispatch the `electron-security-reviewer` subagent against the diff (focus: SSRF on the new content GET incl. redirect hops; response size/timeout caps; the API key never leaves the browser / never sent to the Core; no new IPC surface). Address any findings, re-run `node tests/run.js`, commit fixes.

- [ ] **Step 4: Bump the version**

In `package.json`, change `"version": "1.1.9"` to `"version": "1.2.0"` (new feature → minor bump).

```bash
git add package.json
git commit -m "chore: bump version to 1.2.0 (AI soft-dead link detection)"
```

- [ ] **Step 5: Rebuild the installer**

Run: `npm run dist`
Expected: `dist/Interests-App-Setup-1.2.0.exe` is produced (exit 0; signing skipped is normal).

- [ ] **Step 6: Summarize for Dave**

Report what shipped, the installer path, and how to try the feature (Groom → Check dead links → content tier runs → AI consent prompt → review modal with reasons + archived-copy links). Do NOT offer merge/PR — the build is on master.

---

## Self-Review

**Spec coverage:**
- Tier 1 (HTTP) unchanged → Task 6 keeps the existing loop. ✓
- Tier 2 (content heuristics, server) → Tasks 1–3. ✓
- Tier 3 (AI verdict, suspects only) → Tasks 4, 6. ✓
- Wayback recovery (extra A) → Tasks 4 (`waybackUrl`), 6 (modal link). ✓
- Bounded/stoppable/consent/cap → Task 6 (`AI_DEAD_CAP`, `_deadStop`, `confirm()`, "skipped N" toast). ✓
- SSRF / size / timeout caps → Tasks 2–3. ✓
- Key never reaches Core (AI call in browser) → Task 6 dispatch. ✓
- Read-only, review-modal routing → Task 6 (reuses `openDeadReview`/`applyDeadRemoval`). ✓
- Tests with injected fetch → Tasks 2, 3. ✓
- Reviewers before ship → Task 7. ✓
- "Keep anyway" deferred; social out of scope → not implemented (correct). ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `checkContentChunk`/`/api/check-content`/`Store.checkContent` all return `{results:[{id,finalUrl,status,title,snippet,verdict,reason}]}`; suspects in Task 6 carry `{scope,card,title,snippet,finalUrl,reason}` and gain `{soft,softReason}`; `deadRowHTML` reads `c.soft`/`c.softReason`/`it.url`. `buildDeadCheckPrompt`/`parseDeadVerdict`/`waybackUrl` names match across Tasks 4 and 6. Consistent.
