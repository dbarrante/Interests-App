# Link Safety (Safe Browsing) — Phase 1: Library Scan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Check link safety" sweep that flags saved links Google Safe Browsing reports as malware/phishing into a review modal, mirroring the existing dead-link sweep.

**Architecture:** A server-side `core/safebrowse.js` (pure request-builder/response-parser + a batched API call) behind a new `POST /api/check-safety` endpoint that reads a Google API key from `config.json`. The renderer adds a 🛡️ button + a `checkLinkSafety()` sweep that batches links to the Core and routes flagged ones into a review modal reusing the existing (scrollable, top-buttons) modal CSS and the existing snapshot-first removal path. A Settings field stores the key.

**Tech Stack:** Node.js (CommonJS), Express, Node global `fetch` (undici), plain inline browser JS. Tests: `tests/*.test.js` via `tests/run.js`; endpoint tests stub `global.fetch` (no real network).

## Global Constraints

- **No real network in tests.** Stub `global.fetch`. Use `process.exitCode`, never `process.exit()`.
- **Any test that touches `core/config` MUST set `process.env.APPDATA` to a fresh temp dir BEFORE requiring config/server/appctx** (see `tests/config.test.js`) — never write the real user config.
- **Read-only detection.** Nothing auto-removed; flagged links go to a review modal; removal reuses the existing `snapshotBeforeDestructive()` → bulk-replace path, unchanged.
- **The Safe Browsing API key is never logged and never returned in a response** — endpoints expose only a `hasKey` boolean, never the key value.
- **Only outbound host is the fixed `https://safebrowsing.googleapis.com`** (no SSRF surface). Endpoint behind the existing Origin/CSP middleware (same `app` as `/api/check-links`).
- **Bounded & stoppable:** manual trigger; item cap 500/request; renderer chunks + `_sbStop`; results cached per-card (`sb` marker) with a 7-day fresh window.
- **CommonJS** for `core/*.js` with `"use strict";`; match `core/linkcheck.js`/`core/contentcheck.js` style.

---

### Task 1: Safe Browsing request/response (pure) — `core/safebrowse.js`

**Files:**
- Create: `core/safebrowse.js`
- Test: `tests/safebrowse.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildLookupBody(urls: string[], clientId?, clientVersion?) -> object`
  - `parseLookupResponse(json) -> { [url:string]: threatType:string }`
  - `THREAT_TYPES: string[]`

- [ ] **Step 1: Write the failing test** — create `tests/safebrowse.test.js`:

```js
const assert = require("assert");
const sb = require("../core/safebrowse");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("buildLookupBody sets the 4 threat types + URL entries", () => {
  const b = sb.buildLookupBody(["http://a.test/", "http://b.test/"]);
  assert.deepStrictEqual(b.threatInfo.threatTypes, ["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE","POTENTIALLY_HARMFUL_APPLICATION"]);
  assert.deepStrictEqual(b.threatInfo.platformTypes, ["ANY_PLATFORM"]);
  assert.deepStrictEqual(b.threatInfo.threatEntryTypes, ["URL"]);
  assert.deepStrictEqual(b.threatInfo.threatEntries, [{url:"http://a.test/"},{url:"http://b.test/"}]);
  assert.ok(b.client && b.client.clientId);
});
t("buildLookupBody tolerates non-array", () => {
  assert.deepStrictEqual(sb.buildLookupBody(null).threatInfo.threatEntries, []);
});
t("parseLookupResponse maps matched url -> threatType", () => {
  const m = sb.parseLookupResponse({ matches:[
    { threatType:"MALWARE", threat:{url:"http://bad.test/"} },
    { threatType:"SOCIAL_ENGINEERING", threat:{url:"http://phish.test/"} }
  ]});
  assert.strictEqual(m["http://bad.test/"], "MALWARE");
  assert.strictEqual(m["http://phish.test/"], "SOCIAL_ENGINEERING");
});
t("parseLookupResponse on no matches -> {}", () => {
  assert.deepStrictEqual(sb.parseLookupResponse({}), {});
  assert.deepStrictEqual(sb.parseLookupResponse({matches:[]}), {});
  assert.deepStrictEqual(sb.parseLookupResponse(null), {});
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safebrowse.test.js`
Expected: FAIL — `Cannot find module '../core/safebrowse'`.

- [ ] **Step 3: Write minimal implementation** — create `core/safebrowse.js`:

```js
// Google Safe Browsing v4 lookup. PURE builder/parser + a batched API call (Task 2).
// Only outbound host is the fixed safebrowsing.googleapis.com (no SSRF surface).
"use strict";

var ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";
var THREAT_TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"];
var BATCH = 500;

function buildLookupBody(urls, clientId, clientVersion) {
  var list = Array.isArray(urls) ? urls : [];
  var entries = list.map(function (u) { return { url: String(u) }; });
  return {
    client: { clientId: clientId || "interests-app", clientVersion: clientVersion || "1.0" },
    threatInfo: {
      threatTypes: THREAT_TYPES,
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: entries
    }
  };
}

function parseLookupResponse(json) {
  var out = {};
  var matches = json && json.matches;
  if (Array.isArray(matches)) {
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      var u = m && m.threat && m.threat.url;
      if (u && !out[u]) out[u] = m.threatType || "THREAT";
    }
  }
  return out;
}

module.exports = { buildLookupBody: buildLookupBody, parseLookupResponse: parseLookupResponse, THREAT_TYPES: THREAT_TYPES, ENDPOINT: ENDPOINT, BATCH: BATCH };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/safebrowse.test.js`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/safebrowse.js tests/safebrowse.test.js
git commit -m "feat(safebrowse): pure Safe Browsing lookup body builder + response parser"
```

---

### Task 2: Batched API call — `core/safebrowse.js`

**Files:**
- Modify: `core/safebrowse.js` (add `checkUrls`)
- Test: `tests/safebrowse-call.test.js`

**Interfaces:**
- Consumes: `buildLookupBody`, `parseLookupResponse` (Task 1).
- Produces: `checkUrls(urls: string[], apiKey: string, opts?: {timeoutMs?}) -> Promise<{url, threat:string|null, error?:true}[]>` — batches urls into groups of ≤500; `threat` is the threat type or `null`; on a batch network/HTTP error the batch's urls return `{threat:null, error:true}` (fail-open — never false-flag on API failure).

- [ ] **Step 1: Write the failing test** — create `tests/safebrowse-call.test.js`:

```js
const assert = require("assert");
const sb = require("../core/safebrowse");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  const realFetch = global.fetch;

  await t("flags bad url, leaves clean url null", async () => {
    global.fetch = async () => ({ ok:true, json: async () => ({ matches:[{ threatType:"MALWARE", threat:{url:"http://bad.test/"} }] }) });
    const r = await sb.checkUrls(["http://bad.test/","http://good.test/"], "KEY");
    const by = {}; r.forEach(x => by[x.url] = x);
    assert.strictEqual(by["http://bad.test/"].threat, "MALWARE");
    assert.strictEqual(by["http://good.test/"].threat, null);
  });

  await t("HTTP error -> fail-open (threat null, error true)", async () => {
    global.fetch = async () => ({ ok:false, status:429, json: async () => ({}) });
    const r = await sb.checkUrls(["http://x.test/"], "KEY");
    assert.strictEqual(r[0].threat, null);
    assert.strictEqual(r[0].error, true);
  });

  await t("network throw -> fail-open", async () => {
    global.fetch = async () => { throw new Error("boom"); };
    const r = await sb.checkUrls(["http://y.test/"], "KEY");
    assert.strictEqual(r[0].threat, null);
    assert.strictEqual(r[0].error, true);
  });

  await t("batches >500 urls into multiple calls", async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok:true, json: async () => ({}) }; };
    const many = []; for (let i=0;i<1100;i++) many.push("http://u"+i+".test/");
    const r = await sb.checkUrls(many, "KEY");
    assert.strictEqual(r.length, 1100);
    assert.strictEqual(calls, 3, "1100/500 -> 3 batches, got "+calls);
  });

  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safebrowse-call.test.js`
Expected: FAIL — `sb.checkUrls is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `core/safebrowse.js`, add before `module.exports`:

```js
var UA = "Mozilla/5.0 InterestsApp SafeBrowse";

// Look up urls against Safe Browsing in batches of BATCH. Fail-open: a batch that errors
// returns its urls with threat:null + error:true (never a false "unsafe" on an API failure).
async function checkUrls(urls, apiKey, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var list = Array.isArray(urls) ? urls : [];

  async function lookup(slice) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      var res = await fetch(ENDPOINT + "?key=" + encodeURIComponent(apiKey), {
        method: "POST",
        signal: ac.signal,
        headers: { "Content-Type": "application/json", "User-Agent": UA, "Connection": "close" },
        body: JSON.stringify(buildLookupBody(slice))
      });
      if (!res.ok) return { map: {}, failed: true };
      return { map: parseLookupResponse(await res.json()), failed: false };
    } catch (e) {
      return { map: {}, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  var results = [];
  for (var i = 0; i < list.length; i += BATCH) {
    var slice = list.slice(i, i + BATCH);
    var r = await lookup(slice);
    for (var j = 0; j < slice.length; j++) {
      var u = slice[j];
      results.push({ url: u, threat: r.map[u] || null, error: r.failed ? true : undefined });
    }
  }
  return results;
}
```

Update the export to add `checkUrls`:

```js
module.exports = { buildLookupBody: buildLookupBody, parseLookupResponse: parseLookupResponse, THREAT_TYPES: THREAT_TYPES, ENDPOINT: ENDPOINT, BATCH: BATCH, checkUrls: checkUrls };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/safebrowse-call.test.js`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/safebrowse.js tests/safebrowse-call.test.js
git commit -m "feat(safebrowse): batched checkUrls with fail-open on API errors"
```

---

### Task 3: Config key storage — `core/config.js`

**Files:**
- Modify: `core/config.js` (add `getSafeBrowsingKey`/`setSafeBrowsingKey`; export both)
- Test: `tests/config-safebrowsing.test.js`

**Interfaces:**
- Consumes: existing `loadConfig`/`saveConfig`.
- Produces: `getSafeBrowsingKey() -> string` (""=unset); `setSafeBrowsingKey(key: string)`.

- [ ] **Step 1: Write the failing test** — create `tests/config-safebrowsing.test.js`:

```js
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
// Isolate %APPDATA% BEFORE requiring config (never touch the real user config).
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sbcfg-"));
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("default key is empty string", () => {
  assert.strictEqual(config.getSafeBrowsingKey(), "");
});
t("set then get round-trips (trimmed)", () => {
  config.setSafeBrowsingKey("  abc123  ");
  assert.strictEqual(config.getSafeBrowsingKey(), "abc123");
});
t("set does not clobber other config keys", () => {
  config.saveConfig(Object.assign({}, config.loadConfig(), { storePath: "X:/keep" }));
  config.setSafeBrowsingKey("def456");
  assert.strictEqual(config.loadConfig().storePath, "X:/keep");
  assert.strictEqual(config.getSafeBrowsingKey(), "def456");
});
t("clear with empty string", () => {
  config.setSafeBrowsingKey("");
  assert.strictEqual(config.getSafeBrowsingKey(), "");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/config-safebrowsing.test.js`
Expected: FAIL — `config.getSafeBrowsingKey is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `core/config.js`, add after `setSyncConfig` (before `module.exports`):

```js
function getSafeBrowsingKey() {
  const cfg = loadConfig();
  return typeof cfg.safeBrowsingKey === "string" ? cfg.safeBrowsingKey : "";
}

function setSafeBrowsingKey(key) {
  const cfg = loadConfig();
  cfg.safeBrowsingKey = typeof key === "string" ? key.trim() : "";
  saveConfig(cfg);
}
```

And add both to `module.exports` (after `setSyncConfig,`):

```js
  getSafeBrowsingKey,
  setSafeBrowsingKey,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/config-safebrowsing.test.js`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/config.js tests/config-safebrowsing.test.js
git commit -m "feat(config): get/set Safe Browsing API key in config.json"
```

---

### Task 4: Endpoints — `core/server.js`

**Files:**
- Modify: `core/server.js` (require `./safebrowse` and ensure `./config` is required; add 3 routes after `/api/check-content`, before `app.use(express.static(WEB_DIR))`)
- Test: `tests/safety-endpoint.test.js`

**Interfaces:**
- Consumes: `safebrowse.checkUrls` (Task 2), `config.getSafeBrowsingKey`/`setSafeBrowsingKey` (Task 3).
- Produces:
  - `POST /api/check-safety { items:[{id,url}] }` → `{ results:[{id, threat:string|null}] }`; if no key → `{ error:"no_key", results:[] }`. Items capped at 500.
  - `GET /api/safebrowsing-key` → `{ hasKey: boolean }` (never the key).
  - `POST /api/safebrowsing-key { key }` → `{ ok:true, hasKey: boolean }`.

- [ ] **Step 1: Write the failing test** — create `tests/safety-endpoint.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
// Isolate %APPDATA% BEFORE requiring config/server (key writes must not touch real config).
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sbend-"));
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-sb-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok:true, json: async () => ({ matches:[{ threatType:"MALWARE", threat:{url:"https://bad.test/"} }] }) });

  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("no key set -> {error:'no_key'}", async () => {
    config.setSafeBrowsingKey("");
    const r = await req(port, "POST", "/api/check-safety", { items:[{id:"a",url:"https://bad.test/"}] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.error, "no_key");
  });
  await t("POST key -> hasKey true; GET reflects; key never echoed", async () => {
    const set = await req(port, "POST", "/api/safebrowsing-key", { key:"SECRET" });
    assert.strictEqual(set.json.hasKey, true);
    assert.ok(!("key" in set.json), "must not echo the key");
    const get = await req(port, "GET", "/api/safebrowsing-key");
    assert.strictEqual(get.json.hasKey, true);
    assert.ok(!("key" in get.json), "GET must not return the key");
  });
  await t("with key set, flags bad url, leaves clean url null", async () => {
    const r = await req(port, "POST", "/api/check-safety", { items:[
      {id:"bad", url:"https://bad.test/"},
      {id:"ok",  url:"https://ok.test/"}
    ]});
    const by = {}; r.json.results.forEach(x => by[x.id]=x.threat);
    assert.strictEqual(by.bad, "MALWARE");
    assert.strictEqual(by.ok, null);
  });
  await t("items capped at 500", async () => {
    const big = []; for (let i=0;i<600;i++) big.push({ id:"x"+i, url:"https://x"+i+".test/" });
    const r = await req(port, "POST", "/api/check-safety", { items: big });
    assert.ok(r.json.results.length <= 500, "got "+r.json.results.length);
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safety-endpoint.test.js`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Write minimal implementation**

In `core/server.js`, near the top requires (where `const linkcheck = require("./linkcheck");` and `const contentcheck = require("./contentcheck");` are), add (and add the `config` require **only if it is not already present** in the file):

```js
const safebrowse = require("./safebrowse");
const config = require("./config");
```

Immediately after the `app.post("/api/check-content", …)` block closes and before `app.use(express.static(WEB_DIR));`, add:

```js
  // ---- link safety (Google Safe Browsing; server-side; key from config; read-only) ----
  app.post("/api/check-safety", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      const key = config.getSafeBrowsingKey();
      if (!key) { res.json({ error: "no_key", results: [] }); return; }
      const urls = items.map((it) => (it && typeof it.url === "string") ? it.url : "").filter(Boolean);
      const found = await safebrowse.checkUrls(urls, key, {});
      const byUrl = {}; found.forEach((f) => { byUrl[f.url] = f.threat; });
      const results = items.map((it) => ({ id: it && it.id, threat: (it && byUrl[it.url]) || null }));
      res.json({ results: results });
    } catch (e) {
      console.error("check-safety failed:", e);
      res.status(500).json({ error: "check failed" });
    }
  });

  app.get("/api/safebrowsing-key", (req, res) => {
    res.json({ hasKey: !!config.getSafeBrowsingKey() });
  });

  app.post("/api/safebrowsing-key", (req, res) => {
    const key = (req.body && typeof req.body.key === "string") ? req.body.key : "";
    config.setSafeBrowsingKey(key);
    res.json({ ok: true, hasKey: !!key });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/safety-endpoint.test.js`
Expected: PASS — `4 passed, 0 failed`.

- [ ] **Step 5: Full gate + commit**

Run: `node tests/run.js` (expect `ALL TEST FILES PASSED`)

```bash
git add core/server.js tests/safety-endpoint.test.js
git commit -m "feat(server): /api/check-safety + /api/safebrowsing-key endpoints"
```

---

### Task 5: Storage adapters — `web/storage.js`

**Files:**
- Modify: `web/storage.js` (add `SE.checkSafety`, `SE.safeBrowsingKey`; add `Store.checkSafety`, `Store.getSafeBrowsingKey`, `Store.setSafeBrowsingKey`)
- Test: `tests/storage-url.test.js` (add SE path assertions)

**Interfaces:**
- Produces:
  - `SE.checkSafety() -> "/api/check-safety"`, `SE.safeBrowsingKey() -> "/api/safebrowsing-key"`
  - `Store.checkSafety(items, opts) -> Promise<results[]>`
  - `Store.getSafeBrowsingKey() -> Promise<boolean>` (hasKey), `Store.setSafeBrowsingKey(key) -> Promise<{ok,hasKey}>`

- [ ] **Step 1: Write the failing test** — in `tests/storage-url.test.js`, add alongside the other `SE.*()` assertions (match the file's existing `t(...)` style):

```js
  t("safety endpoints", () => {
    assert.strictEqual(SE.checkSafety(), "/api/check-safety");
    assert.strictEqual(SE.safeBrowsingKey(), "/api/safebrowsing-key");
  });
```

(If that file's helper is async/`await t(...)`, match that form — read the file and mirror its neighbouring `SE` assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/storage-url.test.js`
Expected: FAIL — `SE.checkSafety is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `web/storage.js` `SE` object, after the `checkContent` line:

```js
    checkSafety: function () { return "/api/check-safety"; },
    safeBrowsingKey: function () { return "/api/safebrowsing-key"; },
```

In the `Store` object, after the `checkContent` adapter (add a comma after `checkContent`'s entry, then append):

```js
,
      checkSafety: function (items, opts) { return jsend("POST", SE.checkSafety(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); },
      getSafeBrowsingKey: function () { return jget(SE.safeBrowsingKey()).then(function (j) { return !!(j && j.hasKey); }); },
      setSafeBrowsingKey: function (key) { return jsend("POST", SE.safeBrowsingKey(), { key: key || "" }); }
```

- [ ] **Step 4: Run tests + syntax**

Run: `node tests/storage-url.test.js` then `node tests/syntax-check.js`
Expected: storage-url PASS; syntax-check `0 error(s)`.

- [ ] **Step 5: Commit**

```bash
git add web/storage.js tests/storage-url.test.js
git commit -m "feat(storage): checkSafety + get/set Safe Browsing key adapters"
```

---

### Task 6: Settings key field — `web/index.html`

**Files:**
- Modify: `web/index.html` (Settings view: add the key field markup + two handlers; call status loader when settings shows)
- Test: `tests/safety-wiring.test.js` (created here; extended in Task 7)

**Interfaces:**
- Consumes: `Store.getSafeBrowsingKey`, `Store.setSafeBrowsingKey` (Task 5), existing `toast`, `showTab`.
- Produces: `saveSafeBrowsingKey()`, `loadSafetyKeyStatus()`; DOM ids `sbKey`, `sbKeyStatus`.

- [ ] **Step 1: Write the failing test** — create `tests/safety-wiring.test.js`:

```js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("settings has a Safe Browsing key field", () => {
  assert.ok(html.indexOf('id="sbKey"') >= 0);
});
t("saves the key via Store", () => {
  assert.ok(html.indexOf("Store.setSafeBrowsingKey") >= 0);
  assert.ok(html.indexOf("Store.getSafeBrowsingKey") >= 0);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safety-wiring.test.js`
Expected: FAIL — `id="sbKey"` not found.

- [ ] **Step 3: Write minimal implementation**

3a. Read the **Settings tab** markup in `web/index.html` (search for the settings panel that holds the AI provider/API-key UI, near line 1129–1137). Add this block inside that Settings container (a sensible spot is right after the AI provider key area):

```html
<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
  <label style="font-weight:600">Google Safe Browsing API key <span id="sbKeyStatus" class="hint"></span></label>
  <div class="hint">Free malware/phishing check for your links. Get a key at <b>developers.google.com/safe-browsing/v4/get-started</b>. Leave blank to disable.</div>
  <div style="display:flex;gap:8px;margin-top:6px">
    <input type="password" id="sbKey" placeholder="Paste your Safe Browsing key…" style="flex:1">
    <button class="btn btn-primary" onclick="saveSafeBrowsingKey()">Save</button>
  </div>
</div>
```

3b. Add these two functions in the inline script (near the other settings helpers):

```js
async function loadSafetyKeyStatus(){
  try {
    const has = await Store.getSafeBrowsingKey();
    const el = document.getElementById("sbKeyStatus");
    if (el) el.textContent = has ? "— a key is set" : "— no key set";
  } catch(e){ /* Core unavailable; leave blank */ }
}
async function saveSafeBrowsingKey(){
  const inp = document.getElementById("sbKey");
  const v = inp ? inp.value.trim() : "";
  try { await Store.setSafeBrowsingKey(v); } catch(e){ toast("Couldn't save key", 4000); return; }
  if (inp) inp.value = "";
  toast(v ? "Safe Browsing key saved" : "Safe Browsing key cleared", 4000);
  loadSafetyKeyStatus();
}
```

3c. Ensure `loadSafetyKeyStatus()` runs when the Settings tab is shown. Find where the app reacts to showing settings (e.g. inside `showTab` when the target is `"settings"`, or the settings render function) and call `loadSafetyKeyStatus();` there. If no such hook exists, call it once during init where other startup calls run (it's idempotent and safe if the element isn't present yet).

- [ ] **Step 4: Run tests**

Run: `node tests/safety-wiring.test.js` then `node tests/syntax-check.js`
Expected: wiring `2 passed`; syntax-check `0 error(s)`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/safety-wiring.test.js
git commit -m "feat(ui): Settings field to store the Google Safe Browsing API key"
```

---

### Task 7: Library sweep + review modal — `web/index.html`

**Files:**
- Modify: `web/index.html` (add `#safetyModal` container; the 🛡️ button; the sweep + modal functions)
- Test: `tests/safety-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `Store.checkSafety`, `Store.getSafeBrowsingKey` (Task 5); existing `imported`, `saved`, `domain`, `esc`, `dupeThumb`, `attachCardImages`, `snapshotBeforeDestructive`, `Store.putCards/putSaved/imgDel/fpDel`, `_fpMap`, `writeSavesFile`, `updateCounts`, `renderImported`, `renderSaved`, `curTab`, `toast`, `showTab`.
- Produces: `checkLinkSafety()`, `openSafetyReview(list)`, `renderSafetyModal()`, `closeSafetyReview()`, `applySafetyRemoval()`, `safetyRowHTML(c)`, `_threatLabel(t)`; module vars `_sbStop`, `_safetyList`, `SB_FRESH_DAYS`, `_sbFresh`.

- [ ] **Step 1: Extend the failing test** — in `tests/safety-wiring.test.js`, add before the final `console.log`:

```js
t("loads the safety helper script entry points", () => {
  assert.ok(html.indexOf("function checkLinkSafety") >= 0);
  assert.ok(html.indexOf("Store.checkSafety") >= 0);
  assert.ok(html.indexOf('id="safetyModal"') >= 0);
});
t("has the Check link safety button", () => {
  assert.ok(html.indexOf("checkLinkSafety()") >= 0);
  assert.ok(html.indexOf("Check link safety") >= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safety-wiring.test.js`
Expected: FAIL — `function checkLinkSafety` not found.

- [ ] **Step 3: Write minimal implementation**

3a. Add the modal container next to the dead-links modal. Find `<div id="deadModal"><div class="dupe-box"><div id="deadBody"></div></div></div>` and add immediately after it:

```html
<div id="safetyModal"><div class="dupe-box"><div id="safetyBody"></div></div></div>
```

The modal CSS must apply to `#safetyModal` too. Find the selector list `#dupeModal,#deadModal{…}` and `#dupeModal.open,#deadModal.open{…}` (around line 184–185) and add `,#safetyModal` to each so it reads `#dupeModal,#deadModal,#safetyModal{…}` and `#dupeModal.open,#deadModal.open,#safetyModal.open{…}`.

3b. Add the 🛡️ button. Find the dead-links button (`onclick="checkDeadLinks()"`, ~line 2076) and add immediately after it:

```html
      <button class="btn btn-ghost" onclick="checkLinkSafety()" title="Check Imported + Saved links against Google Safe Browsing and review before removing">&#128737; Check link safety</button>
```

3c. Add the sweep + modal functions in the inline script (a good spot is right after the dead-link functions, near `applyDeadRemoval`):

```js
// ---- Link safety check (Google Safe Browsing) → review (mirrors the dead-link flow;
// removal reuses the same backup-first bulk-replace path; only Google-flagged links shown) ----
const SB_FRESH_DAYS = 7;          // re-runs skip links checked within this window
let _sbStop = false, _safetyList = [];
function _sbFresh(it){ return !!(it && it.sb && it.sb.at && (Date.now()-it.sb.at) < SB_FRESH_DAYS*864e5); }
function _threatLabel(t){
  return ({ MALWARE:"Malware", SOCIAL_ENGINEERING:"Phishing / social engineering", UNWANTED_SOFTWARE:"Unwanted software", POTENTIALLY_HARMFUL_APPLICATION:"Harmful app" })[t] || ("Flagged: " + (t || "unsafe"));
}
async function checkLinkSafety(){
  let hasKey = false;
  try { hasKey = await Store.getSafeBrowsingKey(); } catch(e){ hasKey = false; }
  if(!hasKey){ toast("Add your Google Safe Browsing API key in Settings first", 6000); showTab("settings"); return; }
  const cand = [];
  imported.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_sbFresh(it)) cand.push({scope:"imported", card:it}); });
  saved.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_sbFresh(it)) cand.push({scope:"saved", card:it}); });
  if(!cand.length){ toast("No links to check (all recently checked)", 4000); return; }
  _sbStop = false;
  const unsafe = []; let done = 0;
  for(let i=0; i<cand.length && !_sbStop; i+=200){
    const chunk = cand.slice(i, i+200);
    toast(`Checking link safety… ${done}/${cand.length} — tap to stop`, 60000, ()=>{ _sbStop = true; });
    let results = [];
    try{ results = await Store.checkSafety(chunk.map(c=>({ id:c.card.id, url:c.card.url }))); }
    catch(e){ console.warn("check-safety chunk failed", e); continue; }
    const byId = {}; results.forEach(r=>byId[r.id]=r);
    chunk.forEach(c=>{ const r=byId[c.card.id]; if(!r) return; const threat=r.threat||null; c.card.sb={ at:Date.now(), verdict: threat?"unsafe":"safe", threat:threat }; if(threat) unsafe.push(Object.assign({}, c, {threat})); });
    done += chunk.length;
  }
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile();
  if(unsafe.length) openSafetyReview(unsafe);
  else toast(_sbStop ? "Stopped — none flagged so far" : (done ? "No unsafe links found." : "Nothing to check"), 5000);
}
function safetyRowHTML(c){
  const it=c.card; const dom=domain(it.url)||""; const tag=c.scope==="saved"?"Saved":"Imported";
  return `<div class="dupe-row">
    ${dupeThumb(c)}
    <div class="meta"><div class="t">${esc(it.title||dom||"(untitled)")}</div>
      <div class="s">${esc(dom)} · <span class="dupe-badge">${tag}</span> · <span style="color:#e0556b">&#9888; ${esc(_threatLabel(c.threat))}</span></div></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-rm="${esc(c.scope+":"+it.id)}" checked style="width:auto"> remove</label>
  </div>`;
}
function renderSafetyModal(){
  document.getElementById("safetyBody").innerHTML = `
    <div class="dupe-head"><span>&#128737; Unsafe links — ${_safetyList.length} found</span>
      <span style="flex:1"></span>
      <button class="btn btn-ghost" onclick="closeSafetyReview()">Cancel</button>
      <button class="btn btn-primary" onclick="applySafetyRemoval()">Remove selected</button></div>
    <div class="dupe-list">
      <div class="s" style="opacity:.7;padding:2px 4px 8px">Links Google Safe Browsing flagged as dangerous. Uncheck any you want to keep, then click Remove selected.</div>
      ${_safetyList.map(safetyRowHTML).join("") || "<div class='s'>No unsafe links.</div>"}
    </div>`;
  attachCardImages();
}
function openSafetyReview(list){ _safetyList = list || []; if(!_safetyList.length){ toast("No unsafe links found", 4000); return; } renderSafetyModal(); document.getElementById("safetyModal").classList.add("open"); }
function closeSafetyReview(){ document.getElementById("safetyModal").classList.remove("open"); _safetyList = []; }
function applySafetyRemoval(){
  const checked = new Set(Array.prototype.map.call(document.querySelectorAll('#safetyBody input[data-rm]:checked'), el=>el.getAttribute("data-rm")));
  if(!checked.size){ closeSafetyReview(); toast("Nothing selected"); return; }
  snapshotBeforeDestructive();
  const rmImported = new Set(), rmSaved = new Set();
  checked.forEach(v=>{ const i=v.indexOf(":"); const scope=v.slice(0,i), id=v.slice(i+1); (scope==="saved"?rmSaved:rmImported).add(id); });
  const gone = imported.filter(c=>c&&rmImported.has(c.id)).concat(saved.filter(c=>c&&rmSaved.has(c.id)));
  gone.forEach(c=>{ const img=(typeof c.img==="string")?c.img:c.image; if(typeof img==="string" && img.indexOf("idb:")===0){ try{ Store.imgDel(c.id); }catch(e){} } if(_fpMap[c.id]){ delete _fpMap[c.id]; try{ Store.fpDel(c.id); }catch(e){} } });
  if(rmImported.size) imported = imported.filter(c=>!c||!rmImported.has(c.id));
  if(rmSaved.size) saved = saved.filter(c=>!c||!rmSaved.has(c.id));
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile(); updateCounts();
  closeSafetyReview();
  if(curTab==="imported") renderImported(); else if(curTab==="saved") renderSaved();
  toast(`Removed ${checked.size} unsafe link${checked.size===1?"":"s"}`, 5000);
}
```

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/safety-wiring.test.js` (expect `4 passed`)
Run: `node tests/syntax-check.js` (expect `0 error(s)`)
Run: `node tests/run.js` (expect `ALL TEST FILES PASSED`)

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/safety-wiring.test.js
git commit -m "feat(ui): Check link safety sweep + Safe Browsing review modal"
```

---

### Task 8: Reviews, version bump, installer rebuild

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Full gate**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 2: data-safety-reviewer subagent**

Dispatch the `data-safety-reviewer` against the feature diff (focus: read-only detection; the `sb` marker is additive; removal reuses the unchanged snapshot-first `applySafetyRemoval` pattern; nothing auto-deleted; no new personal-data write to the repo). Fix any findings; re-run `node tests/run.js`; commit.

- [ ] **Step 3: electron-security-reviewer subagent**

Dispatch the `electron-security-reviewer` against the feature diff (focus: the key is read server-side from config, never logged or echoed — endpoints expose only `hasKey`; `/api/check-safety` only ever contacts the fixed `safebrowsing.googleapis.com` host; endpoint behind the existing Origin/CSP middleware; request `url`/`key` inputs type-checked). Fix any findings; re-run `node tests/run.js`; commit.

- [ ] **Step 4: Version bump**

In `package.json`, change `"version": "1.2.1"` to `"version": "1.3.0"` (new feature → minor bump).

```bash
git add package.json
git commit -m "chore: bump version to 1.3.0 (link safety — Safe Browsing library scan)"
```

- [ ] **Step 5: Rebuild installer**

Run: `npm run dist`
Expected: `dist/Interests-App-Setup-1.3.0.exe` produced (exit 0; unsigned is normal).

- [ ] **Step 6: Summarize for Dave**

Report what shipped, the installer path, and how to use it: get a free Safe Browsing key → paste in Settings → 🛡️ Check link safety → review modal → remove/keep. Note the open-time check is Phase 2 (next). Do NOT offer merge/PR — build is on master.

---

## Self-Review

**Spec coverage:**
- `core/safebrowse.js` builder/parser → Task 1. ✓
- Batched `checkUrls` + fail-open → Task 2. ✓
- Config key get/set → Task 3. ✓
- `/api/check-safety` + key endpoints (hasKey only, never echo key) → Task 4. ✓
- Storage adapters → Task 5. ✓
- Settings key field → Task 6. ✓
- Library sweep + review modal (scrollable/top-buttons CSS reuse; snapshot-first removal; bounded/stoppable; `sb` cache) → Task 7. ✓
- Reviews + version bump + installer → Task 8. ✓
- Phase 2 (open-time) explicitly deferred (not in this plan). ✓

**Placeholder scan:** none — every code step has complete code; Task 6 step 3a/3c instruct locating the Settings container/show-hook (a real placement step, not a code gap) with the full markup/handlers provided.

**Type consistency:** `checkUrls` returns `{url,threat,error?}`; `/api/check-safety` returns `{results:[{id,threat}]}`; `Store.checkSafety` → results; `Store.getSafeBrowsingKey` → boolean; `Store.setSafeBrowsingKey` → `{ok,hasKey}`; `card.sb={at,verdict,threat}`; sweep collects `{scope,card,threat}`; `safetyRowHTML`/`applySafetyRemoval` read `c.card`/`c.threat`/`c.scope`. Names consistent across tasks (`checkLinkSafety`, `_sbStop`, `_safetyList`, `_sbFresh`, `_threatLabel`, `#safetyModal`, `#safetyBody`, `sbKey`, `sbKeyStatus`).
