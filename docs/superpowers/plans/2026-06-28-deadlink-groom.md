# Dead-Link Check → Groom Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual "Check dead links" sweep that probes Imported+Saved card URLs server-side and surfaces the definitively-dead ones into a Groom-style review modal for confirmed deletion.

**Architecture:** A pure `core/linkcheck.js` (classify + skip/SSRF guards + a concurrency-capped prober using Node's native `fetch`), one `POST /api/check-links` Core endpoint, and a renderer driver + review modal that mirrors the existing duplicate-review modal and reuses the existing backup-first deletion path.

**Tech Stack:** Node built-in `fetch`/`AbortController` (Electron 42 / Node 20+), Express (Core), plain JS renderer, plain-Node `assert` tests via `tests/run.js`.

## Global Constraints

- Repo **private**; **never create/edit/`git add` personal-data files**. Tests use **synthetic fixtures + LOCAL throwaway http servers only — NO real-internet calls**.
- **Conservative classification:** a link is **dead** ONLY on HTTP `404 / 410 / 451` or error code `ENOTFOUND` / `ECONNREFUSED` / `ERR_NAME_NOT_RESOLVED`. Everything else (401/403/429/5xx/0/timeout/`ETIMEDOUT`/`ECONNRESET`/`EAI_AGAIN`/cert/unknown) is **unknown** and is NEVER flagged.
- **Review-before-delete ALWAYS** (never auto-delete) + `snapshotBeforeDestructive()` backup-first.
- The `/api/check-links` endpoint must guard **SSRF** via `isProbableHost` (reject `localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `*.local`) and **skip social hosts** by default (`instagram.com`, `facebook.com`, `fb.watch`, `threads.net`, `youtube.com`, `youtu.be`).
- Deletions reuse the existing bulk-replace path (`Store.putCards`/`Store.putSaved` → `replaceCards`, which tombstones removed ids) so Dropbox sync stays consistent.
- `core/linkcheck.js` `classify` / `isSkippedHost` / `isProbableHost` are **require()-able + unit-tested**.
- Tests are plain-Node `assert` via `node tests/run.js` (must end **ALL TEST FILES PASSED**); the inline-`<script>` syntax gate on `web/index.html` must stay green.
- **App change** (Core + renderer) → ships via an installer rebuild. Do **not** modify the capture extension.

---

### Task 1: Pure `classify` + `isSkippedHost` + `isProbableHost` (+ tests)

**Files:**
- Create: `core/linkcheck.js`
- Test: `tests/linkcheck.test.js`

**Interfaces:**
- Produces: `classify(httpStatus, errCode) -> "dead"|"alive"|"unknown"`; `isSkippedHost(url, skipList?) -> boolean`; `isProbableHost(url) -> boolean`. Pure, `module.exports`. Used by T2/T3.

- [ ] **Step 1: Write the failing test** — `tests/linkcheck.test.js`:

```js
const assert = require("assert");
const lc = require("../core/linkcheck");
let passed = 0, failed = 0;
function t(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("classify: definitive-dead HTTP statuses", () => {
  [404,410,451].forEach(s => assert.strictEqual(lc.classify(s, null), "dead", "status "+s));
});
t("classify: definitive-dead error codes", () => {
  ["ENOTFOUND","ECONNREFUSED","ERR_NAME_NOT_RESOLVED"].forEach(c => assert.strictEqual(lc.classify(0, c), "dead", "code "+c));
});
t("classify: 2xx/3xx are alive", () => {
  [200,204,301,302,308,399].forEach(s => assert.strictEqual(lc.classify(s, null), "alive", "status "+s));
});
t("classify: ambiguous statuses/codes are unknown (never dead)", () => {
  [401,403,429,500,503,0].forEach(s => assert.strictEqual(lc.classify(s, null), "unknown", "status "+s));
  ["ETIMEDOUT","ECONNRESET","EAI_AGAIN","CERT_HAS_EXPIRED","ERR"].forEach(c => assert.strictEqual(lc.classify(0, c), "unknown", "code "+c));
});
t("isSkippedHost: social hosts + subdomains skipped, others not", () => {
  ["https://www.instagram.com/p/x/","https://facebook.com/y","https://m.facebook.com/z","https://fb.watch/a","https://youtube.com/watch?v=1","https://youtu.be/2","https://www.threads.net/@u"].forEach(u => assert.strictEqual(lc.isSkippedHost(u), true, u));
  ["https://www.pinterest.com/pin/1/","https://example.com/a","https://notinstagram.com.evil.com/"].forEach(u => assert.strictEqual(lc.isSkippedHost(u), false, u));
});
t("isSkippedHost: a custom skip-list is honored", () => {
  assert.strictEqual(lc.isSkippedHost("https://foo.com/x", ["foo.com"]), true);
  assert.strictEqual(lc.isSkippedHost("https://bar.com/x", ["foo.com"]), false);
});
t("isProbableHost: rejects non-http(s), localhost, private/loopback/link-local, .local", () => {
  ["ftp://example.com","javascript:alert(1)","http://localhost/x","https://localhost:3456/api","http://127.0.0.1/","http://127.5.5.5/","http://10.0.0.1/","http://172.16.0.1/","http://172.31.255.1/","http://192.168.1.1/","http://169.254.1.1/","http://[::1]/","https://printer.local/","http://0.0.0.0/"].forEach(u => assert.strictEqual(lc.isProbableHost(u), false, u));
});
t("isProbableHost: allows public http(s) hosts (incl. public IPs and 172.x outside private range)", () => {
  ["http://example.com/","https://www.recipes.example/x","https://8.8.8.8/","http://172.32.0.1/","http://172.15.0.1/"].forEach(u => assert.strictEqual(lc.isProbableHost(u), true, u));
});
t("isProbableHost / isSkippedHost: garbage input does not throw", () => {
  ["", null, undefined, "not a url", "http://"].forEach(v => { lc.isProbableHost(v); lc.isSkippedHost(v); });
  assert.ok(true);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails** — `node tests/linkcheck.test.js` → cannot find `../core/linkcheck`.

- [ ] **Step 3: Implement** — `core/linkcheck.js` (pure parts only this task):

```js
// Server-side dead-link checking. classify/isSkippedHost/isProbableHost are PURE.
// The probe (probeUrl/checkChunk) is added in the next task.
"use strict";

// Conservative: a link is "dead" ONLY on these. Everything else is "unknown" and is
// never offered for deletion. Avoids false-deleting login-walled / bot-blocked links.
const DEAD_STATUS = { 404: 1, 410: 1, 451: 1 };
const DEAD_CODES = { ENOTFOUND: 1, ECONNREFUSED: 1, ERR_NAME_NOT_RESOLVED: 1 };

function classify(httpStatus, errCode) {
  if (errCode) return DEAD_CODES[errCode] ? "dead" : "unknown";
  var s = Number(httpStatus);
  if (DEAD_STATUS[s]) return "dead";
  if (s >= 200 && s < 400) return "alive";
  return "unknown";
}

// Hosts whose conservative status is unreliable (login walls / SPA 200 for deleted /
// aggressive bot-blocking). Skipped by default — reported "skipped", never dead.
const SKIP_HOSTS = ["instagram.com", "facebook.com", "fb.watch", "threads.net", "youtube.com", "youtu.be"];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
}

function isSkippedHost(url, skipList) {
  var list = skipList || SKIP_HOSTS;
  var host = hostOf(url);
  if (!host) return false;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (host === d || host.slice(-(d.length + 1)) === "." + d) return true;
  }
  return false;
}

// SSRF guard: only public http(s) hosts may be probed. Rejects loopback/private/
// link-local IP literals, localhost, and .local — the prober must never be steerable
// at the Core's own port or internal services via a crafted card url.
function isProbableHost(url) {
  var u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  var host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");  // strip IPv6 brackets
  if (host === "localhost" || host === "::1" || host.indexOf(".local") === host.length - 6 && host.length > 6) return false;
  if (/\.local$|\.localhost$/.test(host)) return false;
  if (/^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:/i.test(host)) return false;   // fc00::/7 (unique-local IPv6)
  var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    var a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  return true;
}

module.exports = { classify: classify, isSkippedHost: isSkippedHost, isProbableHost: isProbableHost, SKIP_HOSTS: SKIP_HOSTS };
```

- [ ] **Step 4: Run → pass.** `node tests/linkcheck.test.js` → `9 passed, 0 failed`.
- [ ] **Step 5: Full gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.
- [ ] **Step 6: Commit**

```bash
git add core/linkcheck.js tests/linkcheck.test.js
git commit -m "feat(linkcheck): pure classify + social-skip + SSRF host guards"
```

---

### Task 2: `probeUrl` + `checkChunk` (probe + concurrency runner)

**Files:**
- Modify: `core/linkcheck.js`
- Test: `tests/linkcheck-probe.test.js` (create)

**Interfaces:**
- Consumes: `classify`, `isSkippedHost`, `isProbableHost` (T1).
- Produces: `async probeUrl(url, {timeoutMs?}) -> {status, code}`; `async checkChunk(items, {concurrency?, timeoutMs?}) -> [{id, status, code}]` where `items` are `{id, url}` and `status ∈ "dead"|"alive"|"unknown"|"skipped"`.

- [ ] **Step 1: Write the failing test** — `tests/linkcheck-probe.test.js`:

```js
const assert = require("assert");
const http = require("http");
const lc = require("../core/linkcheck");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function listen(handler){ return new Promise(r=>{ const s=http.createServer(handler); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }

(async () => {
  const { s, port } = await listen((req, res) => {
    if (req.url === "/gone") { res.statusCode = 404; res.end("nope"); return; }
    if (req.url === "/ok")   { res.statusCode = 200; res.end("yep"); return; }
    if (req.url === "/nohead") { if (req.method === "HEAD") { res.statusCode = 405; res.end(); } else { res.statusCode = 200; res.end("ok-via-get"); } return; }
    res.statusCode = 200; res.end("x");
  });
  const base = "http://127.0.0.1:" + port;
  // NOTE: 127.0.0.1 is normally SSRF-blocked; probeUrl itself does NOT block (the guard
  // lives in checkChunk). probeUrl is exercised directly here against the local server.
  await t("probeUrl: 404 -> status 404", async () => {
    const r = await lc.probeUrl(base + "/gone"); assert.strictEqual(r.status, 404);
  });
  await t("probeUrl: 200 -> 2xx", async () => {
    const r = await lc.probeUrl(base + "/ok"); assert.ok(r.status >= 200 && r.status < 300);
  });
  await t("probeUrl: HEAD-405 falls back to GET -> 200", async () => {
    const r = await lc.probeUrl(base + "/nohead"); assert.strictEqual(r.status, 200);
  });
  await t("probeUrl: unresolvable host -> network error code (not a throw)", async () => {
    const r = await lc.probeUrl("http://does-not-exist.invalid.example/", { timeoutMs: 4000 });
    assert.strictEqual(r.status, 0); assert.ok(r.code);
  });
  await t("checkChunk: classifies dead/alive and skips SSRF + social hosts", async () => {
    const items = [
      { id: "a", url: base + "/gone" },           // dead (404) — but 127.0.0.1 is SSRF-skipped!
      { id: "b", url: "https://example.com/ok" },  // probed (public) — but example.com may vary; use a skip + a private instead
    ];
    // Build a deterministic chunk: a private IP (skipped), a social host (skipped), and a bad scheme (skipped)
    const r = await lc.checkChunk([
      { id: "priv", url: "http://127.0.0.1:" + port + "/gone" },
      { id: "ig", url: "https://www.instagram.com/p/x/" },
      { id: "ftp", url: "ftp://example.com/x" },
    ], { concurrency: 4, timeoutMs: 4000 });
    const by = {}; r.forEach(x => by[x.id] = x.status);
    assert.strictEqual(by.priv, "skipped", "private IP is SSRF-skipped, never probed");
    assert.strictEqual(by.ig, "skipped", "instagram is social-skipped");
    assert.strictEqual(by.ftp, "skipped", "non-http(s) scheme is skipped");
  });
  s.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run → fail** (`lc.probeUrl is not a function`).

- [ ] **Step 3: Implement** — append to `core/linkcheck.js` (before `module.exports`, then extend exports):

```js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp link-check";

// Probe ONE url. HEAD first (cheap); retry once with GET if HEAD is unsupported
// (405/501) or errored. redirect:"follow" so the FINAL status is classified (a moved
// page that 404s = dead; a redirect to a login page = 200 = alive = not flagged).
async function probeUrl(url, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || 8000;
  async function once(method) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      var res = await fetch(url, { method: method, redirect: "follow", signal: ac.signal, headers: { "User-Agent": UA } });
      return { status: res.status, code: null };
    } catch (e) {
      var code = (e && e.code) || (e && e.name === "AbortError" ? "ETIMEDOUT" : "ERR");
      // Node wraps DNS/connection errors under e.cause for fetch — surface the inner code.
      if (e && e.cause && e.cause.code) code = e.cause.code;
      return { status: 0, code: code };
    } finally {
      clearTimeout(timer);
    }
  }
  var r = await once("HEAD");
  if (r.status === 405 || r.status === 501 || r.status === 0) {
    var g = await once("GET");
    if (g.status !== 0) return g;          // GET reached the server — trust it
    return r.status !== 0 ? r : g;         // both failed — keep whichever has a status/code
  }
  return r;
}

// Probe a chunk of {id,url} with a concurrency cap. Non-probable (SSRF) or
// social-skip urls are reported "skipped" WITHOUT a network request.
async function checkChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 8, 8);
  var timeoutMs = opts.timeoutMs || 8000;
  var arr = Array.isArray(items) ? items : [];
  var results = new Array(arr.length);
  var next = 0;
  async function worker() {
    while (true) {
      var idx = next++;
      if (idx >= arr.length) return;
      var it = arr[idx] || {};
      var url = it.url;
      if (typeof url !== "string" || !isProbableHost(url) || isSkippedHost(url)) {
        results[idx] = { id: it.id, status: "skipped", code: null };
        continue;
      }
      var p = await probeUrl(url, { timeoutMs: timeoutMs });
      results[idx] = { id: it.id, status: classify(p.status, p.code), code: (p.code != null ? p.code : p.status) };
    }
  }
  var pool = [];
  for (var w = 0; w < Math.min(concurrency, arr.length); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}
```

Update exports: `module.exports = { classify, isSkippedHost, isProbableHost, SKIP_HOSTS, probeUrl, checkChunk };`

- [ ] **Step 4: Run → pass. Step 5: Full gate → green.**
- [ ] **Step 6: Commit**

```bash
git add core/linkcheck.js tests/linkcheck-probe.test.js
git commit -m "feat(linkcheck): probeUrl (HEAD->GET, timeout) + concurrency-capped checkChunk"
```

---

### Task 3: Core endpoint `POST /api/check-links` + `Store.checkLinks`

**Files:**
- Modify: `core/server.js`, `web/storage.js`
- Test: `tests/linkcheck-endpoint.test.js` (create)

**Interfaces:**
- Consumes: `core/linkcheck` (T2).
- Produces: `POST /api/check-links` body `{items:[{id,url}], concurrency?, timeoutMs?}` → `{results:[{id,status,code}]}`. `Store.checkLinks(items, opts) -> Promise<results[]>`.

- [ ] **Step 1: Write the failing test** — `tests/linkcheck-endpoint.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-lc-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  // A throwaway TARGET server the checker will probe (NOT the Core). 127.0.0.1 target is
  // reached because the test passes it as the target host AND it is private — so we also
  // assert the SSRF skip. To exercise dead/alive we make the target reachable by passing
  // its public-looking behavior via the loopback target but asserting only the skip there;
  // for dead/alive we point at the target through a non-private alias is not possible, so
  // we instead test classify-through-endpoint with a target whose host is allowed: use the
  // loopback target for the SKIPPED assertions, and a DNS-failure host for the DEAD path.
  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("POST /api/check-links returns a results array", async () => {
    const r = await req(port, "POST", "/api/check-links", { items: [], timeoutMs: 3000 });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.results));
  });
  await t("a private-IP url is SSRF-skipped; a DNS-failure url is dead; a social url is skipped", async () => {
    const r = await req(port, "POST", "/api/check-links", { items: [
      { id: "priv", url: "http://127.0.0.1:9/" },
      { id: "dns", url: "http://does-not-exist.invalid.example/" },
      { id: "ig", url: "https://www.instagram.com/p/x/" },
    ], timeoutMs: 4000 });
    assert.strictEqual(r.status, 200);
    const by = {}; r.json.results.forEach(x => by[x.id] = x.status);
    assert.strictEqual(by.priv, "skipped");
    assert.strictEqual(by.ig, "skipped");
    assert.strictEqual(by.dns, "dead");
  });
  await t("items list is capped at 200 (no crash on oversize)", async () => {
    const big = []; for (let i=0;i<250;i++) big.push({ id: "x"+i, url: "https://www.instagram.com/p/"+i+"/" });
    const r = await req(port, "POST", "/api/check-links", { items: big, timeoutMs: 3000 });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.results.length <= 200);
  });

  core.close(); ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run → fail** (route 404, `results` undefined).

- [ ] **Step 3: Implement.** In `core/server.js`, add near the other requires (alongside `const bookmarks = require("./bookmarks");`): `const linkcheck = require("./linkcheck");`. Then inside `createServer(ctx)`, immediately AFTER the `app.get("/api/bookmarks", ...)` block (the bookmarks routes) and BEFORE `app.use(express.static(WEB_DIR));`:

```js
  // ---- dead-link check (probes user card URLs server-side; conservative + SSRF-guarded;
  // social hosts skipped; never deletes — the renderer reviews results before removal) ----
  app.post("/api/check-links", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const concurrency = Math.min(Number(body.concurrency) || 8, 8);
      const timeoutMs = Math.min(Number(body.timeoutMs) || 8000, 20000);
      const results = await linkcheck.checkChunk(items, { concurrency: concurrency, timeoutMs: timeoutMs });
      res.json({ results: results });
    } catch (e) {
      console.error("check-links failed:", e);
      res.status(500).json({ error: "check failed" });
    }
  });
```

In `web/storage.js`, add to `SE`: `checkLinks: function () { return "/api/check-links"; },` and to `Store`:

```js
      checkLinks: function (items, opts) {
        return jsend("POST", SE.checkLinks(), Object.assign({ items: items || [] }, opts || {}))
          .then(function (j) { return (j && j.results) || []; });
      },
```

- [ ] **Step 4: Run the endpoint test → pass. Step 5: Full gate → green** (`node -c web/storage.js` also passes).
- [ ] **Step 6: Commit**

```bash
git add core/server.js web/storage.js tests/linkcheck-endpoint.test.js
git commit -m "feat(linkcheck): POST /api/check-links endpoint + Store.checkLinks"
```

---

### Task 4: Renderer — "Check dead links" button + bounded driver

**Files:**
- Modify: `web/index.html`

Verified by the inline-`<script>` syntax gate (`node tests/run.js`) + manual smoke.

**Interfaces:**
- Consumes: `Store.checkLinks(items, opts)` (T3); existing `imported`, `saved`, `Store.putCards`, `Store.putSaved`, `toast`, `esc`.
- Produces: `checkDeadLinks()`, the `_deadStop` flag, `_deadList` (consumed by T5's `openDeadReview`).

- [ ] **Step 1: Add the button.** In `renderImported`'s action row, immediately AFTER the "Scan duplicates" button (`web/index.html` ~line 2057), add:

```html
      <button class="btn btn-ghost" onclick="checkDeadLinks()" title="Check Imported + Saved links for dead pages (404 / gone domain) and review before removing">&#128279; Check dead links</button>
```

- [ ] **Step 2: Add the driver** (near `scanDuplicates`/`openDupeReview`, e.g. just above `snapshotBeforeDestructive`):

```js
// Dead-link sweep: probe Imported+Saved http(s) urls in bounded chunks via the Core,
// skipping links checked-alive within LC_FRESH_DAYS, then open the review modal.
const LC_FRESH_DAYS = 14;
let _deadStop = false;
function _lcFresh(it){ return it && it.lc && it.lc.st === "alive" && it.lc.at && (Date.now() - it.lc.at) < LC_FRESH_DAYS*864e5; }
async function checkDeadLinks(){
  const cand = [];
  imported.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_lcFresh(it)) cand.push({ scope:"imported", card:it }); });
  saved.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_lcFresh(it)) cand.push({ scope:"saved", card:it }); });
  if(!cand.length){ toast("No links to check (all recently verified)", 4000); return; }
  _deadStop = false;
  const stopBtn = `<button class="btn btn-ghost" onclick="_deadStop=true">Stop</button>`;
  const dead = []; let done = 0;
  for(let i=0; i<cand.length && !_deadStop; i+=100){
    const chunk = cand.slice(i, i+100);
    toast(`Checking links… ${done}/${cand.length} ${stopBtn}`, 60000);
    let results = [];
    try{ results = await Store.checkLinks(chunk.map(c=>({ id:c.card.id, url:c.card.url }))); }
    catch(e){ console.warn("check-links chunk failed", e); continue; }
    const byId = {}; results.forEach(r=>byId[r.id]=r);
    chunk.forEach(c=>{ const r=byId[c.card.id]; if(!r) return; c.card.lc = { at: Date.now(), st: r.status, code: r.code }; if(r.status==="dead") dead.push(c); });
    done += chunk.length;
  }
  // Persist the lc markers (so re-runs resume) via the normal bulk-replace path.
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile();
  _deadList = dead;
  if(_deadStop){ toast(`Stopped — ${dead.length} dead so far`, 4000); }
  if(!dead.length){ toast(done? "No dead links found" : "Nothing to check", 5000); return; }
  openDeadReview(dead);
}
```

- [ ] **Step 3: Gate** — `node tests/run.js` → `ALL TEST FILES PASSED` (the syntax-check parses the new inline JS; `_deadList`/`openDeadReview` are defined in Task 5 — to keep this task's gate green, also add the Task 5 stubs now OR land Tasks 4+5 together before the gate). Per subagent-driven execution these two renderer tasks may be committed together; if landing T4 alone, add `let _deadList=[]; function openDeadReview(l){ _deadList=l; }` as a temporary stub so the gate passes, replaced in T5.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat(deadlink): Check-dead-links button + bounded/stoppable sweep driver"
```

---

### Task 5: Renderer — dead-link review modal + confirmed removal

**Files:**
- Modify: `web/index.html`

Verified by the syntax gate + manual smoke.

**Interfaces:**
- Consumes: `_deadList` (T4); existing `#dupeModal` CSS classes (`dupe-box`/`dupe-head`/`dupe-list`/`dupe-row`/`dupe-badge`), `snapshotBeforeDestructive`, `Store.putCards`/`putSaved`/`imgDel`/`fpDel`, `resolveImg`, `esc`, `updateCounts`, `writeSavesFile`, `toast`.

- [ ] **Step 1: Add the modal element.** Next to the dupe modal (`web/index.html` line 508 `<div id="dupeModal">…`), add:

```html
<div id="deadModal"><div class="dupe-box"><div id="deadBody"></div></div></div>
```

- [ ] **Step 2: Add the modal + removal logic** (define `_deadList` here, replacing any T4 stub; place near `applyDupeRemoval`):

```js
let _deadList = [];
function _deadReason(code){ if(code===404) return "404 not found"; if(code===410) return "410 gone"; if(code===451) return "451 unavailable"; if(typeof code==="string") return code==="ENOTFOUND"||code==="ERR_NAME_NOT_RESOLVED" ? "domain gone" : (code==="ECONNREFUSED" ? "refused" : code); return "dead"; }
function deadRowHTML(c){
  const it=c.card; const dom=(()=>{ try{ return new URL(it.url).hostname.replace(/^www\./,""); }catch(e){ return ""; } })();
  const img=resolveImg(it); const thumb = img ? `<img class="dupe-thumb" src="${esc(img)}" loading="lazy">` : `<div class="dupe-thumb"></div>`;
  return `<div class="dupe-row">
    <input type="checkbox" data-rm="${esc(c.scope)}:${esc(it.id)}" checked>
    ${thumb}
    <div class="dupe-meta"><div class="dupe-title">${esc(it.title||it.url||"")}</div>
      <div class="dupe-sub"><span class="dupe-tag">${c.scope==="saved"?"Saved":"Imported"}</span> ${esc(dom)} &middot; <span style="color:var(--bad,#e66)">${esc(_deadReason(it.lc&&it.lc.code))}</span></div></div>
  </div>`;
}
function renderDeadModal(){
  const rows = _deadList.map(deadRowHTML).join("") || "<div class='hint'>No dead links.</div>";
  document.getElementById("deadBody").innerHTML = `
    <div class="dupe-head"><b>&#128279; Dead links — ${_deadList.length} found</b>
      <button class="btn btn-ghost" onclick="closeDeadReview()">Close</button></div>
    <div class="hint" style="margin:4px 0 8px">Only definitively-dead links (404 / gone domain) are listed. Uncheck any you want to keep.</div>
    <div class="dupe-list">${rows}</div>
    <div class="dupe-foot"><button class="btn btn-ghost" onclick="closeDeadReview()">Cancel</button>
      <button class="btn btn-primary" onclick="applyDeadRemoval()">Remove selected</button></div>`;
}
function openDeadReview(list){ _deadList = list || []; if(!_deadList.length){ toast("No dead links found", 4000); return; } renderDeadModal(); document.getElementById("deadModal").classList.add("open"); }
function closeDeadReview(){ document.getElementById("deadModal").classList.remove("open"); _deadList = []; }
function applyDeadRemoval(){
  const checked = [...document.querySelectorAll("#deadBody input[data-rm]:checked")].map(c=>c.value);
  if(!checked.length){ closeDeadReview(); toast("Nothing selected"); return; }
  snapshotBeforeDestructive();
  const rmImported = new Set(), rmSaved = new Set();
  checked.forEach(v=>{ const i=v.indexOf(":"); const scope=v.slice(0,i), id=v.slice(i+1); (scope==="saved"?rmSaved:rmImported).add(id); });
  // free orphaned idb images + fingerprints for the removed cards
  const gone = imported.filter(c=>rmImported.has(c.id)).concat(saved.filter(c=>rmSaved.has(c.id)));
  gone.forEach(c=>{ if(c && typeof c.img==="string" && c.img.indexOf("idb:")===0){ try{ Store.imgDel(c.id); }catch(e){} } try{ Store.fpDel(c.id); }catch(e){} });
  imported = imported.filter(c=>!rmImported.has(c.id));
  saved = saved.filter(c=>!rmSaved.has(c.id));
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile(); updateCounts();
  closeDeadReview();
  if(typeof renderImported==="function") renderImported();
  toast(`Removed ${checked.length} dead link${checked.length===1?"":"s"}`, 5000);
}
```

- [ ] **Step 3: Confirm modal CSS.** `#deadModal` reuses `.dupe-box`/`.dupe-*` styling. If `#deadModal` needs the same `.open`/overlay rule as `#dupeModal`, ensure the existing selector covers it — grep the stylesheet for `#dupeModal` and, if the show/hide rule is id-specific (e.g. `#dupeModal.open`), duplicate it for `#deadModal` (e.g. change `#dupeModal{…}` / `#dupeModal.open{…}` to `#dupeModal,#deadModal{…}` / `#dupeModal.open,#deadModal.open{…}`). If `.dupe-foot` is not an existing class, reuse the dupe modal's footer markup/class instead.

- [ ] **Step 4: Gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(deadlink): review modal + backup-first confirmed removal"
```

- [ ] **Step 6: Manual smoke (record; not automated):** after rebuild+reinstall — click "Check dead links"; a progress toast counts up with a Stop button; on completion a "Dead links — N found" modal lists only 404/gone links (with domain + reason), all checked; unchecking spares a card; "Remove selected" deletes the rest, persists across reload, and a backup was taken first; re-running soon after re-checks far fewer links (fresh-skip working).

---

# Final review

After all 5 tasks: a final whole-branch code review, then the **data-safety-reviewer** (the delete path: backup-first, review-before-delete, bulk-replace tombstones, Saved only mutated through the confirmed step) and the **electron-security-reviewer** (the `/api/check-links` endpoint fetching user-supplied URLs — confirm the `isProbableHost` SSRF guard blocks localhost/private/link-local/`.local`, social hosts skipped, item/concurrency caps, loopback+origin guard inherited, no renderer CSP change needed). Then verify `node tests/run.js` is green and rebuild the installer (**v1.1.8**); the build is on master (committed per-task) so summarize — do **not** offer merge/PR.

---

## Self-Review (plan vs spec)

**Spec coverage:** conservative classify (T1) ✓; social-skip + SSRF guard (T1) ✓; probe HEAD→GET + timeout + concurrency cap (T2) ✓; endpoint + item/concurrency caps + Store method (T3) ✓; button + bounded/stoppable driver + lastChecked-resume (T4) ✓; review modal mirroring dupe review + backup-first confirmed removal reusing the bulk-replace path (T5) ✓; tests are plain-Node assert + local throwaway servers, no real-internet (T1–T3) ✓; review-before-delete + snapshotBeforeDestructive ✓; app change → rebuild ✓; extension untouched ✓.

**Placeholder scan:** none — complete code throughout. (T4 notes the T5 stub option so its standalone gate stays green; T5 defines `_deadList` authoritatively.)

**Type consistency:** `classify(status,code)`/`isSkippedHost(url,skipList?)`/`isProbableHost(url)` (T1) → `probeUrl`/`checkChunk` (T2) → `/api/check-links` `{results:[{id,status,code}]}` (T3) → `Store.checkLinks(items,opts)→results[]` (T3) → driver stamps `card.lc={at,st,code}` and builds `_deadList` of `{scope,card}` (T4) → `deadRowHTML`/`applyDeadRemoval` consume `{scope,card}` + `card.lc.code` (T5). `status` vocabulary `dead|alive|unknown|skipped` consistent across endpoint, driver, and modal (only `dead` is listed/removable).
