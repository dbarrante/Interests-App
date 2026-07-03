# Browser Stumble (StumbleUpon-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Left-clicking the Chrome extension icon opens one fresh, app-validated external page in a single reused browser tab, with an on-page overlay (👍 / 👎 / Save / Stumble again) whose ratings train the app's existing discovery AI, scoped by interests chosen on the extension's Options page.

**Architecture:** The extension never writes app data directly. It talks to the app's loopback Core (ports 3456–3465) through four small mailboxes — `/api/categories`, `/api/bstumble/request`, `/api/bstumble/results`, `/api/bstumble/feedback`. The app renderer (the only place the AI runs and app state is written) drains these on a 3-second timer, reusing the existing `buildPrompt → callAI → validateItems` pipeline and the existing `likes`/`hidden` learning signals. Strict live-page validation is untouched.

**Tech Stack:** Node `node:sqlite` + Express (Core, CommonJS), single-file `web/index.html` renderer, `web/storage.js` client adapter, Chrome MV3 extension (`extension/`). Tests are plain Node `assert` scripts run by `node tests/run.js`.

## Global Constraints

- Node's built-in `node:sqlite` only — no native modules, no new npm deps.
- Tests are plain Node `assert` scripts; never call `process.exit()` (use `process.exitCode`); stub all network. Final run must print `ALL TEST FILES PASSED`.
- `web/index.html` has no browser unit harness — verify inline-script changes with `node tests/syntax-check.js` plus source-assertion tests; it must always keep parsing.
- Core stays bound to `127.0.0.1`; new routes make **no outbound network calls**; middleware ordering in `core/server.js` is load-bearing — add routes in the existing mailbox block, not before the guards.
- Never rename the frozen wire fields: imported/library cards use `img`, saved cards use `image`.
- The extension never writes `cards`/`saved`/`likes`/`hidden`/`spool`/`shown` KV directly; all app-state writes happen in the renderer via `persistAll()`.
- Renderer drain logic must be gated on `_booted` before it writes anything.
- Preserve the untracked `.agents/`, `.codex/`, `AGENTS.md` files. Work on branch `feature/browser-stumble`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Browser-stumble KV keys (all new): `ia_bstumble_request`, `ia_bstumble_results`, `ia_bstumble_feedback`, `ia_bstumble_cats`.
- Extension version bump 4.48 → **4.49**; app `package.json` bump 1.11.2 → **1.12.0**.

---

## File Structure

**Core**
- `core/server.js` — add `/api/categories` + three `/api/bstumble/*` mailbox route groups inside the existing mailbox block (after the `jsonKvEndpoints(...)` calls at ~line 381).

**Client adapter**
- `web/storage.js` — add `SE` endpoint builders + `Store` methods the renderer uses to drain the mailboxes.

**Renderer**
- `web/index.html` — `buildPrompt(mode, interestKeys)` scoping; `stumbleForInterests()`; `pollBrowserStumble()` drain loop + `setInterval`; publish `CATS` to `ia_bstumble_cats` at boot.

**Extension**
- `extension/manifest.json` — remove `default_popup`, add `options_page`, bump version.
- `extension/background.js` — icon-click stumble loop, overlay injection, "Remove from Interests" context-menu item, message handlers.
- `extension/overlay.js` (new) — the injected on-page bar.
- `extension/options.html` / `extension/options.js` (new) — interests picker.
- `extension/popup.html` / `extension/popup.js` — left on disk, unreferenced (easy revert).

**Release**
- `package.json`, `docs/BACKLOG.md`.

---

## Task 1: Core mailboxes + categories endpoint

**Files:**
- Modify: `core/server.js` (insert after the `jsonKvEndpoints(app, "/api/batch-progress", ...)` line, ~line 381, before the `/api/import` route)
- Test: `tests/bstumble-mailbox.test.js` (create)

**Interfaces:**
- Consumes: `createServer(ctx)` from `core/server.js`; `openDb` from `core/db.js`; in-scope closures `readJsonKV(key)`, `dbm`, `ctx.db`.
- Produces (HTTP): `GET /api/categories → {categories:[]}`; `GET/POST /api/bstumble/request` (field `request`); `POST /api/bstumble/results {items}` (append, cap 20) + `GET` (returns `{results}` and clears); `POST /api/bstumble/feedback {vote}` (append, cap 50) + `GET` (returns `{feedback}` and clears).

- [ ] **Step 1: Write the failing test**

Create `tests/bstumble-mailbox.test.js`:

```js
// tests/bstumble-mailbox.test.js — browser-stumble Core mailboxes.
// Boots the real Express app on an ephemeral loopback port (same pattern as
// tests/mass-delete-guard.test.js) and drives the endpoints over HTTP.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb } = require("../core/db.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bstumble-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise(function (res) {
    const srv = http.createServer(app).listen(0, "127.0.0.1", function () {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}
function jget(base, route) { return fetch(base + route).then(r => r.json()); }
function jpost(base, route, body) {
  return fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
}

(async function () {
  const store = newStore();
  const db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: function () { return store; }, setStorePath: function () {}, reopen: function () { return openDb(ctx.storeDir); } };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("categories: empty by default, then reflects ia_bstumble_cats KV", async () => {
    let j = await jget(base, "/api/categories");
    assert.deepStrictEqual(j.categories, []);
    await jpost(base, "/api/kv/ia_bstumble_cats", { value: JSON.stringify([{ key: "work", name: "Work initiatives" }]) });
    j = await jget(base, "/api/categories");
    assert.strictEqual(j.categories[0].key, "work");
  });

  await run("request: set, read, clear", async () => {
    await jpost(base, "/api/bstumble/request", { request: { interests: ["work"], nonce: "n1" } });
    let j = await jget(base, "/api/bstumble/request");
    assert.strictEqual(j.request.nonce, "n1");
    await jpost(base, "/api/bstumble/request", { request: null });
    j = await jget(base, "/api/bstumble/request");
    assert.strictEqual(j.request, null);
  });

  await run("results: append then GET returns and clears", async () => {
    await jpost(base, "/api/bstumble/results", { items: [{ url: "https://a", title: "A" }] });
    await jpost(base, "/api/bstumble/results", { items: [{ url: "https://b", title: "B" }] });
    let j = await jget(base, "/api/bstumble/results");
    assert.strictEqual(j.results.length, 2);
    j = await jget(base, "/api/bstumble/results");
    assert.strictEqual(j.results.length, 0); // cleared on read
  });

  await run("results: caps at 20 newest", async () => {
    for (let i = 0; i < 25; i++) await jpost(base, "/api/bstumble/results", { items: [{ url: "https://x/" + i }] });
    const j = await jget(base, "/api/bstumble/results");
    assert.strictEqual(j.results.length, 20);
    assert.strictEqual(j.results[j.results.length - 1].url, "https://x/24");
  });

  await run("feedback: append then GET returns and clears", async () => {
    await jpost(base, "/api/bstumble/feedback", { vote: { url: "https://a", vote: 1 } });
    await jpost(base, "/api/bstumble/feedback", { vote: { url: "https://b", vote: -1 } });
    let j = await jget(base, "/api/bstumble/feedback");
    assert.strictEqual(j.feedback.length, 2);
    j = await jget(base, "/api/bstumble/feedback");
    assert.strictEqual(j.feedback.length, 0);
  });

  await run("results: bad body is rejected", async () => {
    const r = await fetch(base + "/api/bstumble/results", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: "nope" }) });
    assert.strictEqual(r.status, 400);
  });

  srv.close();
  console.log("bstumble-mailbox: " + pass + " passed, " + fail + " failed");
  if (fail) process.exitCode = 1;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/bstumble-mailbox.test.js`
Expected: FAIL — the `/api/categories` and `/api/bstumble/*` routes 404, so `j.categories`/`j.request` are undefined and assertions throw.

- [ ] **Step 3: Add the routes**

In `core/server.js`, immediately after the line `jsonKvEndpoints(app, "/api/batch-progress", "ia_batch_progress", "progress");` (~line 381), insert:

```js
  // --- Browser Stumble (StumbleUpon-style discovery in the browser) ---------
  // Loopback mailboxes bridging the extension and the renderer. The extension
  // never writes app data directly: it POSTs a request / drains results /
  // POSTs feedback here, and the renderer (the only place the AI runs and app
  // state is written) drains them on a timer. No outbound network here.
  function readJsonArr(key) { const v = readJsonKV(key); return Array.isArray(v) ? v : []; }

  // Categories for the extension's interest picker (renderer publishes CATS at boot).
  app.get("/api/categories", (req, res) => {
    res.json({ categories: readJsonArr("ia_bstumble_cats") });
  });

  // Request mailbox: extension asks for pages in {interests, nonce}; renderer drains.
  jsonKvEndpoints(app, "/api/bstumble/request", "ia_bstumble_request", "request");

  // Results queue: renderer appends verified pages; extension GET returns + clears.
  app.post("/api/bstumble/results", (req, res) => {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: "items array required" });
    let q = readJsonArr("ia_bstumble_results").concat(items);
    if (q.length > 20) q = q.slice(-20);
    dbm.setKV(ctx.db, "ia_bstumble_results", JSON.stringify(q));
    res.json({ ok: true, count: q.length });
  });
  app.get("/api/bstumble/results", (req, res) => {
    const q = readJsonArr("ia_bstumble_results");
    if (q.length) dbm.setKV(ctx.db, "ia_bstumble_results", JSON.stringify([]));
    res.json({ results: q });
  });

  // Feedback queue: extension appends 👍/👎 votes; renderer GET returns + clears.
  app.post("/api/bstumble/feedback", (req, res) => {
    const vote = req.body && req.body.vote;
    if (!vote || typeof vote !== "object") return res.status(400).json({ ok: false, error: "missing vote" });
    let q = readJsonArr("ia_bstumble_feedback").concat([vote]);
    if (q.length > 50) q = q.slice(-50);
    dbm.setKV(ctx.db, "ia_bstumble_feedback", JSON.stringify(q));
    res.json({ ok: true, count: q.length });
  });
  app.get("/api/bstumble/feedback", (req, res) => {
    const q = readJsonArr("ia_bstumble_feedback");
    if (q.length) dbm.setKV(ctx.db, "ia_bstumble_feedback", JSON.stringify([]));
    res.json({ feedback: q });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/bstumble-mailbox.test.js`
Expected: PASS — `bstumble-mailbox: 6 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/server.js tests/bstumble-mailbox.test.js
git commit -m "feat(core): browser-stumble mailboxes + /api/categories

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Client adapter — SE builders + Store drain methods

**Files:**
- Modify: `web/storage.js` (add to the `SE` object ~line 41, and to the `Store` object)
- Test: `tests/storage-url.test.js` (append assertions)

**Interfaces:**
- Consumes: `SE`, `jget`, `jsend` from `web/storage.js`.
- Produces: `SE.categories()`, `SE.bstumbleRequest()`, `SE.bstumbleResults()`, `SE.bstumbleFeedback()`; `Store.getBrowserStumbleRequest()→Promise<request|null>`, `Store.clearBrowserStumbleRequest()→Promise<void>`, `Store.deliverBrowserStumbleResults(items)→Promise<void>`, `Store.drainBrowserStumbleFeedback()→Promise<vote[]>`.

- [ ] **Step 1: Write the failing test**

Open `tests/storage-url.test.js`, and add these assertions before the final pass/fail summary print (match the file's existing `assert` style; adapt variable names to that file — it already `require`s `web/storage.js` and reads `SE`):

```js
// browser-stumble endpoint builders
assert.strictEqual(SE.categories(), "/api/categories");
assert.strictEqual(SE.bstumbleRequest(), "/api/bstumble/request");
assert.strictEqual(SE.bstumbleResults(), "/api/bstumble/results");
assert.strictEqual(SE.bstumbleFeedback(), "/api/bstumble/feedback");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/storage-url.test.js`
Expected: FAIL — `SE.categories is not a function`.

- [ ] **Step 3: Add SE builders and Store methods**

In `web/storage.js`, add to the `SE` object (after `captureMeta: ...` at line 41 — add a comma after the previous entry):

```js
    ,categories: function () { return "/api/categories"; }
    ,bstumbleRequest: function () { return "/api/bstumble/request"; }
    ,bstumbleResults: function () { return "/api/bstumble/results"; }
    ,bstumbleFeedback: function () { return "/api/bstumble/feedback"; }
```

Then inside the `Store` object (anywhere among the other methods, e.g. after the `kvSet` method), add:

```js
      // --- browser stumble (renderer drains these; the extension owns the other side) ---
      getBrowserStumbleRequest: function () { return jget(SE.bstumbleRequest()).then(function (j) { return (j && j.request) || null; }); },
      clearBrowserStumbleRequest: function () { return jsend("POST", SE.bstumbleRequest(), { request: null }).then(function () {}); },
      deliverBrowserStumbleResults: function (items) { return jsend("POST", SE.bstumbleResults(), { items: items || [] }).then(function () {}); },
      drainBrowserStumbleFeedback: function () { return jget(SE.bstumbleFeedback()).then(function (j) { return (j && j.feedback) || []; }); },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/storage-url.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/storage.js tests/storage-url.test.js
git commit -m "feat(client): Store drain methods for browser-stumble mailboxes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Renderer — interest scoping in buildPrompt

**Files:**
- Modify: `web/index.html` (`buildPrompt`, line ~1276)
- Test: `tests/bstumble-prompt.test.js` (create — source assertion, per the repo's index.html testing convention)

**Interfaces:**
- Consumes: existing `buildPrompt(mode)`.
- Produces: `buildPrompt(mode, interestKeys)` — when `interestKeys` is a non-empty array, `active` categories are filtered to those keys (falling back to all if the filter empties). All existing single-arg callers are unaffected.

- [ ] **Step 1: Write the failing test**

Create `tests/bstumble-prompt.test.js`:

```js
// tests/bstumble-prompt.test.js — source assertion that buildPrompt scopes to
// interestKeys. web/index.html has no browser harness (see tests/README.md), so
// we assert on the source the way tests/capture-wiring.test.js does.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("buildPrompt takes interestKeys", /function buildPrompt\(mode,\s*interestKeys\)/.test(src));
ok("buildPrompt filters active categories by interestKeys",
   /interestKeys[\s\S]{0,200}?filter\([\s\S]{0,80}?\.has\(/.test(src));

console.log("bstumble-prompt: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/bstumble-prompt.test.js`
Expected: FAIL — signature is still `function buildPrompt(mode)`.

- [ ] **Step 3: Edit buildPrompt**

In `web/index.html`, change the signature line `function buildPrompt(mode){` to:

```js
function buildPrompt(mode, interestKeys){
```

Then find the line `const active = CATS.filter(c=>S.weights[c.key]>0);` and replace it with:

```js
  let active = CATS.filter(c=>S.weights[c.key]>0);
  if(interestKeys && interestKeys.length){ const set=new Set(interestKeys); const picked=active.filter(c=>set.has(c.key)); if(picked.length) active=picked; }
```

(`active` was `const`; it is now `let` because the interest filter may reassign it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/bstumble-prompt.test.js`
Expected: PASS.
Run: `node tests/syntax-check.js`
Expected: PASS — inline scripts still parse.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/bstumble-prompt.test.js
git commit -m "feat(renderer): buildPrompt scopes to interestKeys

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Renderer — drain loop, learning feedback, publish CATS

**Files:**
- Modify: `web/index.html` (add functions + `setInterval`; publish CATS at boot)
- Test: `tests/bstumble-wiring.test.js` (create — source assertions + relies on `tests/syntax-check.js`)

**Interfaces:**
- Consumes: `Store.getBrowserStumbleRequest/clearBrowserStumbleRequest/deliverBrowserStumbleResults/drainBrowserStumbleFeedback` (Task 2); `Store.kvSet`; `buildPrompt(mode, interestKeys)` (Task 3); existing `callAI`, `parseItems`, `dropAlreadySaved`, `validateItems`, `rankFilter`, `persistAll`, `IA_AI.hasAIKey`; globals `likes`, `hidden`, `shown`, `CATS`, `_booted`.
- Produces: `pollBrowserStumble()` on a 3s interval; `stumbleForInterests(interestKeys)→Promise<item[]>`; `ia_bstumble_cats` published at boot.

- [ ] **Step 1: Write the failing test**

Create `tests/bstumble-wiring.test.js`:

```js
// tests/bstumble-wiring.test.js — source assertions for the renderer drain loop.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("pollBrowserStumble defined", /function pollBrowserStumble\(/.test(src));
ok("drain loop on a timer", /setInterval\(\s*pollBrowserStumble\s*,\s*\d+\s*\)/.test(src));
ok("drain loop gated on _booted", /pollBrowserStumble[\s\S]{0,120}?_booted/.test(src));
ok("thumbs-up maps to likes", /v\.vote\s*>\s*0[\s\S]{0,60}?likes\.push/.test(src));
ok("thumbs-down maps to hidden", /v\.vote\s*<\s*0[\s\S]{0,80}?hidden\.push/.test(src));
ok("rated pages are suppressed via shown", /shown\.push\(v\.url\)/.test(src));
ok("stumbleForInterests scopes the prompt", /buildPrompt\(\s*["']stumble["']\s*,\s*interestKeys\s*\)/.test(src));
ok("publishes categories", /ia_bstumble_cats/.test(src));

console.log("bstumble-wiring: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/bstumble-wiring.test.js`
Expected: FAIL — none of the functions exist yet.

- [ ] **Step 3: Add the drain loop and helper**

In `web/index.html`, immediately **after** the existing line `setInterval(drainCaptures, 3000);` (~line 4427), insert:

```js
/* ===== Browser Stumble: drain the extension's mailboxes ===== */
// One AI fetch per pending request; votes feed the same likes/hidden signals
// buildPrompt already reads, so the next stumble weights them. Renderer-owned
// writes only (persistAll is asOf-safe); the extension never writes app data.
async function stumbleForInterests(interestKeys){
  if(!IA_AI.hasAIKey()) return [];
  try{
    const items = await rankFilter(await validateItems(dropAlreadySaved(parseItems(await callAI(buildPrompt("stumble", interestKeys),{webSearch:true})))));
    items.forEach(i=>{ i.id="bs_"+i.id; shown.push(i.url); });
    if(shown.length>200) shown=shown.slice(-200);
    persistAll();
    return items.map(i=>({ url:i.url, title:i.title, category:i.category, image:i.image, liveCheckedAt:i.liveCheckedAt }));
  }catch(e){ console.warn("browser stumble failed:", e && e.message); return []; }
}
let _bstumbleBusy = false;
async function pollBrowserStumble(){
  if(!_booted || _bstumbleBusy) return;
  _bstumbleBusy = true;
  try{
    // 1) feedback → learning signals
    let fb = [];
    try{ fb = (await Store.drainBrowserStumbleFeedback()) || []; }catch(e){}
    if(fb.length){
      fb.forEach(v=>{
        if(!v || !v.url) return;
        const entry = { title: v.title || v.url, category: v.category || "", ts: Date.now() };
        if(v.vote > 0) likes.push(entry);
        else if(v.vote < 0) hidden.push(entry);
        shown.push(v.url);   // never re-serve a page the user already rated
      });
      if(shown.length>200) shown=shown.slice(-200);
      persistAll();
    }
    // 2) request → interest-scoped discovery → results
    let req = null;
    try{ req = await Store.getBrowserStumbleRequest(); }catch(e){}
    if(req && req.nonce){
      await Store.clearBrowserStumbleRequest();
      const items = await stumbleForInterests(Array.isArray(req.interests) ? req.interests : []);
      if(items.length){ try{ await Store.deliverBrowserStumbleResults(items); }catch(e){} }
    }
  } finally { _bstumbleBusy = false; }
}
setInterval(pollBrowserStumble, 3000);
```

- [ ] **Step 4: Publish CATS at boot**

In `web/index.html`, find the `rebuildCats()` function (~line 584). At the end of that function body (just before its closing `}`), add:

```js
  try{ if(typeof Store!=="undefined" && Store.kvSet) Store.kvSet("ia_bstumble_cats", CATS.map(c=>({key:c.key, name:c.name}))); }catch(e){}
```

This republishes the category list (built-in + custom) to Core every time categories change, so the extension's Options page always sees the current set.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/bstumble-wiring.test.js`
Expected: PASS — `bstumble-wiring: 8 passed, 0 failed`.
Run: `node tests/syntax-check.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/index.html tests/bstumble-wiring.test.js
git commit -m "feat(renderer): browser-stumble drain loop + learning feedback + publish categories

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Extension manifest — icon-click stumble, options page, version

**Files:**
- Modify: `extension/manifest.json`
- Test: `tests/bstumble-ext-manifest.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: a manifest with no `action.default_popup` (so `chrome.action.onClicked` fires), `options_page: "options.html"`, and `version: "4.49"`.

- [ ] **Step 1: Write the failing test**

Create `tests/bstumble-ext-manifest.test.js`:

```js
// tests/bstumble-ext-manifest.test.js — manifest wiring for browser stumble.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("version bumped to 4.49", m.version === "4.49");
ok("no default_popup (icon click fires onClicked)", !(m.action && m.action.default_popup));
ok("options_page set", m.options_page === "options.html");
ok("still has scripting + tabs + notifications perms", ["scripting","tabs","notifications"].every(p => m.permissions.includes(p)));

console.log("bstumble-ext-manifest: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/bstumble-ext-manifest.test.js`
Expected: FAIL — version is `4.48`, `default_popup` still present, no `options_page`.

- [ ] **Step 3: Edit the manifest**

In `extension/manifest.json`: change `"version": "4.48"` to `"version": "4.49"`. Add a top-level `"options_page": "options.html",` (e.g. right after the `"description"` line). In the `"action"` object, **delete** the `"default_popup": "popup.html",` line (keep `default_title` and `default_icon`).

Resulting `action` block:

```json
  "action": {
    "default_title": "Stumble",
    "default_icon": {
      "16": "icon16.png",
      "32": "icon32.png",
      "48": "icon48.png",
      "128": "icon128.png"
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/bstumble-ext-manifest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json tests/bstumble-ext-manifest.test.js
git commit -m "feat(ext): icon-click stumble + options page (manifest 4.49)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Extension overlay content script

**Files:**
- Create: `extension/overlay.js`
- Test: `tests/bstumble-overlay.test.js` (create — parse + source assertions, mirrors `tests/ext-content-return.test.js`)

**Interfaces:**
- Consumes (at runtime, injected into the stumbled page): `chrome.runtime.sendMessage`.
- Produces: an idempotent floating bar with four controls that send `{action:"bstumbleVote", vote:1|-1}`, `{action:"bstumbleSave"}`, `{action:"bstumbleNext"}` to the service worker.

- [ ] **Step 1: Write the failing test**

Create `tests/bstumble-overlay.test.js`:

```js
// tests/bstumble-overlay.test.js — the injected overlay parses and wires its buttons.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "overlay.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("parses as valid JS", (() => { try { new vm.Script(src); return true; } catch (e) { return false; } })());
ok("idempotent guard (won't double-inject)", /ia-bstumble-bar|__iaBstumbleInjected/.test(src));
ok("sends thumbs-up vote", /action:\s*["']bstumbleVote["'][\s\S]{0,40}?vote:\s*1/.test(src));
ok("sends thumbs-down vote", /vote:\s*-1/.test(src));
ok("sends save action", /action:\s*["']bstumbleSave["']/.test(src));
ok("sends next action", /action:\s*["']bstumbleNext["']/.test(src));

console.log("bstumble-overlay: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/bstumble-overlay.test.js`
Expected: FAIL — `extension/overlay.js` does not exist (readFileSync throws).

- [ ] **Step 3: Create the overlay**

Create `extension/overlay.js`:

```js
// extension/overlay.js — the StumbleUpon-style bar injected onto each stumbled
// page by the service worker (chrome.scripting.executeScript). Idempotent: a
// re-injection on the reused tab replaces the old bar. Buttons message the SW,
// which records the vote/save and advances the same tab.
(function () {
  if (window.__iaBstumbleInjected) { try { document.getElementById("ia-bstumble-bar").remove(); } catch (e) {} }
  window.__iaBstumbleInjected = true;

  var send = function (msg) { try { chrome.runtime.sendMessage(msg); } catch (e) {} };
  var flash = function (label) { status.textContent = label; };

  var bar = document.createElement("div");
  bar.id = "ia-bstumble-bar";
  bar.style.cssText = [
    "position:fixed", "left:50%", "bottom:18px", "transform:translateX(-50%)",
    "z-index:2147483647", "display:flex", "gap:8px", "align-items:center",
    "background:rgba(26,24,21,.96)", "color:#f6f5f3", "padding:8px 12px",
    "border-radius:12px", "box-shadow:0 6px 24px rgba(0,0,0,.4)",
    "font:600 13px/1 system-ui,sans-serif", "pointer-events:auto"
  ].join(";");

  function mkBtn(label, title, bg, onClick) {
    var b = document.createElement("button");
    b.textContent = label; b.title = title;
    b.style.cssText = "border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit;background:" + bg + ";color:#fff";
    b.addEventListener("click", onClick);
    return b;
  }

  var status = document.createElement("span");
  status.style.cssText = "min-width:70px;text-align:center;color:#cbe8dc";
  status.textContent = "Stumble";

  bar.appendChild(mkBtn("👍", "Like — more like this", "#0d9488", function () { send({ action: "bstumbleVote", vote: 1 }); flash("Liked →"); }));
  bar.appendChild(mkBtn("👎", "Not for me — fewer like this", "#7c2d2d", function () { send({ action: "bstumbleVote", vote: -1 }); flash("Skipped →"); }));
  bar.appendChild(mkBtn("★ Save", "Save to Interests", "#b45309", function () { send({ action: "bstumbleSave" }); flash("Saved ✓"); }));
  bar.appendChild(mkBtn("Stumble ⟳", "Next page", "#334155", function () { send({ action: "bstumbleNext" }); flash("Finding…"); }));
  var x = mkBtn("✕", "Hide this bar", "transparent", function () { bar.remove(); });
  x.style.color = "#9a958d";
  bar.appendChild(status);
  bar.appendChild(x);

  (document.body || document.documentElement).appendChild(bar);
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/bstumble-overlay.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/overlay.js tests/bstumble-overlay.test.js
git commit -m "feat(ext): on-page stumble overlay (thumbs/save/next)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Extension background — stumble loop, overlay injection, Remove menu

**Files:**
- Modify: `extension/background.js`
- Test: `tests/bstumble-ext-bg.test.js` (create — parse + source assertions)

**Interfaces:**
- Consumes: existing `findAppPort()`, `clipCurrentPage(tab)`, `deliverToApp()`, `ensureContextMenu()`, the `chrome.contextMenus.onClicked` and `chrome.runtime.onMessage` listeners; Core routes from Task 1.
- Produces: an `chrome.action.onClicked` handler running the stumble loop with same-tab reuse; overlay injection on navigation-complete for the stumble tab; a `"removeFromInterests"` context-menu item; `onMessage` handling of `bstumbleVote`/`bstumbleSave`/`bstumbleNext`.

- [ ] **Step 1: Write the failing test**

Create `tests/bstumble-ext-bg.test.js`:

```js
// tests/bstumble-ext-bg.test.js — background wiring for browser stumble (source assertions).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("parses as valid JS", (() => { try { new vm.Script(src); return true; } catch (e) { return false; } })());
ok("handles icon click", /chrome\.action\.onClicked\.addListener/.test(src));
ok("posts a stumble request", /\/api\/bstumble\/request/.test(src));
ok("drains results", /\/api\/bstumble\/results/.test(src));
ok("posts feedback", /\/api\/bstumble\/feedback/.test(src));
ok("injects the overlay", /overlay\.js/.test(src));
ok("reuses the stumble tab", /bstumbleTabId|_stumbleTabId/.test(src));
ok("adds Remove-from-Interests menu item", /removeFromInterests/.test(src));
ok("handles overlay messages", /bstumbleVote[\s\S]{0,400}?bstumbleNext|bstumbleNext[\s\S]{0,400}?bstumbleVote/.test(src));

console.log("bstumble-ext-bg: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/bstumble-ext-bg.test.js`
Expected: FAIL — none of the browser-stumble wiring exists.

- [ ] **Step 3: Add the stumble driver**

In `extension/background.js`, add near the top (after the `IA_PORT_RANGE`/`findAppPort` section) this block:

```js
// ===== Browser Stumble (StumbleUpon-style) ==================================
// Left-click the icon → open one fresh, app-validated page in a single reused
// tab, with an on-page overlay. Pages come only from the app's validated
// pipeline (via the /api/bstumble/* mailboxes); the extension never validates.
const BSTUMBLE_BUFFER_KEY = "ia_bstumble_buffer";   // session-local queue of pages to open
const BSTUMBLE_TAB_KEY = "ia_bstumble_tabid";       // the reused tab's id

async function bstumbleGetSelectedInterests() {
  try { const s = await chrome.storage.local.get("ia_bstumble_interests"); return Array.isArray(s.ia_bstumble_interests) ? s.ia_bstumble_interests : []; }
  catch (e) { return []; }
}
async function bstumbleReadBuffer() {
  try { const s = await chrome.storage.session.get(BSTUMBLE_BUFFER_KEY); return Array.isArray(s[BSTUMBLE_BUFFER_KEY]) ? s[BSTUMBLE_BUFFER_KEY] : []; }
  catch (e) { return []; }
}
async function bstumbleWriteBuffer(buf) { try { await chrome.storage.session.set({ [BSTUMBLE_BUFFER_KEY]: buf }); } catch (e) {} }

// Ask the app to top up the results queue for the chosen interests (fire-and-forget).
async function bstumbleRequestRefill(port) {
  const interests = await bstumbleGetSelectedInterests();
  const nonce = "n" + Date.now() + "_" + Math.round(performance.now());
  try { await fetch("http://127.0.0.1:" + port + "/api/bstumble/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: { interests, nonce } }) }); } catch (e) {}
}
// Pull whatever the app has delivered into our local buffer.
async function bstumbleDrainResults(port) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/api/bstumble/results");
    if (r && r.ok) { const j = await r.json(); if (Array.isArray(j.results) && j.results.length) { const buf = (await bstumbleReadBuffer()).concat(j.results); await bstumbleWriteBuffer(buf); } }
  } catch (e) {}
}
// Open the page in the reused stumble tab (create if it's gone), then inject the overlay.
async function bstumbleOpen(url) {
  let tabId = null;
  try { const s = await chrome.storage.session.get(BSTUMBLE_TAB_KEY); tabId = s[BSTUMBLE_TAB_KEY]; } catch (e) {}
  let tab = null;
  if (tabId != null) { try { tab = await chrome.tabs.get(tabId); } catch (e) { tab = null; } }
  if (tab) { try { await chrome.tabs.update(tabId, { url, active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) { tab = null; } }
  if (!tab) { try { tab = await chrome.tabs.create({ url, active: true }); tabId = tab.id; await chrome.storage.session.set({ [BSTUMBLE_TAB_KEY]: tabId }); } catch (e) { return; } }
  bstumbleInjectOverlayWhenReady(tabId);
}
function bstumbleInjectOverlayWhenReady(tabId) {
  function onUpd(tid, info) {
    if (tid !== tabId || info.status !== "complete") return;
    try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
    chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] }).catch(() => {});
  }
  try { chrome.tabs.onUpdated.addListener(onUpd); } catch (e) {}
  setTimeout(() => { try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {} }, 30000);
}
// The core action: open the next page, keeping the buffer topped up.
async function bstumbleGo() {
  const port = await findAppPort();
  if (port == null) { notify("bstumble-" + Date.now(), "Stumble", "Open the Interests app to Stumble."); return; }
  let buf = await bstumbleReadBuffer();
  if (!buf.length) { await bstumbleDrainResults(port); buf = await bstumbleReadBuffer(); }
  await bstumbleRequestRefill(port);   // top up for next time
  if (!buf.length) { notify("bstumble-" + Date.now(), "Stumble", "Finding you something… click again in a moment."); return; }
  const next = buf.shift();
  await bstumbleWriteBuffer(buf);
  if (next && next.url) await bstumbleOpen(next.url);
  if (buf.length < 2) await bstumbleRequestRefill(port);   // keep at least a couple ready
}
chrome.action.onClicked.addListener(() => { bstumbleGo().catch(() => {}); });

// Record a 👍/👎 vote from the overlay (app drains /api/bstumble/feedback and learns).
async function bstumbleSendVote(vote) {
  const port = await findAppPort();
  if (port == null) return;
  let url = "", title = "";
  try { const s = await chrome.storage.session.get(BSTUMBLE_TAB_KEY); const t = s[BSTUMBLE_TAB_KEY] != null ? await chrome.tabs.get(s[BSTUMBLE_TAB_KEY]) : null; if (t) { url = t.url || ""; title = t.title || ""; } } catch (e) {}
  if (!url) return;
  try { await fetch("http://127.0.0.1:" + port + "/api/bstumble/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vote: { url, title, vote } }) }); } catch (e) {}
}
```

- [ ] **Step 4: Add the overlay message handler**

In `extension/background.js`, inside the existing `chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => { ... })` block, add these branches (before the closing `});`):

```js
  if (msg.action === "bstumbleVote") { bstumbleSendVote(msg.vote).then(() => bstumbleGo()).catch(() => {}); return false; }
  if (msg.action === "bstumbleNext") { bstumbleGo().catch(() => {}); return false; }
  if (msg.action === "bstumbleSave") {
    (async () => {
      try { const s = await chrome.storage.session.get(BSTUMBLE_TAB_KEY); const tab = s[BSTUMBLE_TAB_KEY] != null ? await chrome.tabs.get(s[BSTUMBLE_TAB_KEY]) : null; if (tab) await clipCurrentPage(tab); } catch (e) {}
    })();
    return false;
  }
```

- [ ] **Step 5: Add the "Remove from Interests" context-menu item**

In `extension/background.js`, in `ensureContextMenu()`, after the existing `chrome.contextMenus.create({ id: "saveToInterests", ... })` call (inside the same `removeAll` callback), add a second create:

```js
        chrome.contextMenus.create({
          id: "removeFromInterests",
          title: "Remove from Interests",
          contexts: ["page", "link"],
        }, () => { void chrome.runtime.lastError; });
```

Then in the `chrome.contextMenus.onClicked.addListener((info, tab) => { ... })` handler, at the very top of the function body add:

```js
  if (info.menuItemId === "removeFromInterests") {
    (async () => {
      try {
        const url = info.linkUrl || info.pageUrl || (tab && tab.url) || "";
        await deliverToApp({ url, id: "", dead: true, removeActive: true, error: "removed by user", ts: Date.now() });
        await setStatus("Removed card from Interests", true);
      } catch (e) {}
    })();
    return;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node tests/bstumble-ext-bg.test.js`
Expected: PASS — `bstumble-ext-bg: 9 passed, 0 failed`.

- [ ] **Step 7: Commit**

```bash
git add extension/background.js tests/bstumble-ext-bg.test.js
git commit -m "feat(ext): background stumble loop, overlay injection, Remove menu

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Extension options page — interests picker

**Files:**
- Create: `extension/options.html`, `extension/options.js`
- Test: `tests/bstumble-options.test.js` (create — parse + source assertions)

**Interfaces:**
- Consumes: `GET /api/categories` (Task 1); `chrome.storage.local` key `ia_bstumble_interests` (read by Task 7's `bstumbleGetSelectedInterests`); the extension already talks to `127.0.0.1:3456–3465` via a port scan — reuse the same range here.
- Produces: a checkbox list of categories whose checked keys are saved to `chrome.storage.local.ia_bstumble_interests`.

- [ ] **Step 1: Write the failing test**

Create `tests/bstumble-options.test.js`:

```js
// tests/bstumble-options.test.js — the options page parses and wires interests.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const js = fs.readFileSync(path.join(__dirname, "..", "extension", "options.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "extension", "options.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("options.js parses", (() => { try { new vm.Script(js); return true; } catch (e) { return false; } })());
ok("html loads options.js", /options\.js/.test(html));
ok("fetches categories", /\/api\/categories/.test(js));
ok("scans the app port range", /345[6-9]|346[0-5]|3456/.test(js));
ok("saves selected interests", /ia_bstumble_interests/.test(js));

console.log("bstumble-options: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/bstumble-options.test.js`
Expected: FAIL — the option files do not exist.

- [ ] **Step 3: Create options.html**

Create `extension/options.html`:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;padding:0 16px;background:#1f1d1a;color:#f6f5f3}
h2{font-size:17px;margin:0 0 4px}
p.sub{color:#9a958d;font-size:12px;margin:0 0 16px}
label{display:flex;align-items:center;gap:8px;padding:7px 0;font-size:14px;cursor:pointer}
.status{font-size:12px;color:#4ade80;min-height:16px;margin-top:12px}
.err{color:#f87171}
button{margin-top:8px;background:#0d9488;color:#fff;border:none;border-radius:8px;padding:9px 14px;font:600 13px/1 system-ui;cursor:pointer}
</style>
</head>
<body>
<h2>Stumble interests</h2>
<p class="sub">Pick the topics you want to stumble. Leave all unchecked to stumble everything. These sync from your Interests app's categories.</p>
<div id="list">Loading…</div>
<button id="saveBtn">Save interests</button>
<div class="status" id="status"></div>
<script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create options.js**

Create `extension/options.js`:

```js
// extension/options.js — interests picker. Reads categories from the running
// Interests app (loopback port scan, same range as background.js) and saves the
// selected category keys to chrome.storage.local for the stumble loop to send.
var PORTS = [3456, 3457, 3458, 3459, 3460, 3461, 3462, 3463, 3464, 3465];
var list = document.getElementById("list");
var status = document.getElementById("status");

async function findPort() {
  for (var i = 0; i < PORTS.length; i++) {
    try {
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 500);
      var r = await fetch("http://127.0.0.1:" + PORTS[i] + "/api/ping", { signal: ctl.signal });
      clearTimeout(tm);
      if (r && r.ok) { var j = await r.json(); if (j && j.app === "interests") return PORTS[i]; }
    } catch (e) {}
  }
  return null;
}

async function load() {
  var port = await findPort();
  if (port == null) { list.innerHTML = '<span class="err">Open the Interests app, then reopen this page.</span>'; return; }
  var cats = [];
  try { var r = await fetch("http://127.0.0.1:" + port + "/api/categories"); var j = await r.json(); cats = j.categories || []; } catch (e) {}
  var sel = [];
  try { var s = await chrome.storage.local.get("ia_bstumble_interests"); sel = s.ia_bstumble_interests || []; } catch (e) {}
  if (!cats.length) { list.innerHTML = '<span class="err">No categories found yet.</span>'; return; }
  list.innerHTML = "";
  cats.forEach(function (c) {
    var lab = document.createElement("label");
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = c.key; cb.checked = sel.indexOf(c.key) >= 0;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(c.name));
    list.appendChild(lab);
  });
}

document.getElementById("saveBtn").addEventListener("click", async function () {
  var keys = [].slice.call(list.querySelectorAll("input[type=checkbox]")).filter(function (cb) { return cb.checked; }).map(function (cb) { return cb.value; });
  try { await chrome.storage.local.set({ ia_bstumble_interests: keys }); status.className = "status"; status.textContent = "Saved " + keys.length + " interest(s)."; }
  catch (e) { status.className = "status err"; status.textContent = "Could not save."; }
});

load();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/bstumble-options.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/options.html extension/options.js tests/bstumble-options.test.js
git commit -m "feat(ext): interests picker options page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Full suite, version bump, changelog, manual verification

**Files:**
- Modify: `package.json` (version), `docs/BACKLOG.md`

- [ ] **Step 1: Run the whole suite**

Run: `node tests/run.js`
Expected: the run ends with `ALL TEST FILES PASSED`. If any file fails, fix it before continuing (do not proceed on red).

- [ ] **Step 2: Bump the app version**

In `package.json`, change `"version": "1.11.2"` to `"version": "1.12.0"`.

- [ ] **Step 3: Update the changelog**

In `docs/BACKLOG.md`, add an entry near the top:

```markdown
## v1.12.0 — Browser Stumble (StumbleUpon-style)
- Left-click the extension icon (ext 4.49) to stumble one fresh, app-validated page in a single reused browser tab.
- On-page overlay: 👍 / 👎 / ★ Save / Stumble ⟳. 👍→liked, 👎→not-for-me feed the app's discovery AI; Save clips to Interests.
- Interests picker on the extension Options page (synced from the app's categories) scopes discovery.
- New Core mailboxes (`/api/categories`, `/api/bstumble/request|results|feedback`) drained by the renderer; extension never writes app data directly. Strict live-page validation unchanged.
- Extension left-click no longer opens the old popup; Clip stays on right-click "Save to Interests", new right-click "Remove from Interests".
```

- [ ] **Step 4: Commit**

```bash
git add package.json docs/BACKLOG.md
git commit -m "chore(release): v1.12.0 / ext 4.49 — Browser Stumble

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual verification (with Dave)**

1. In Chrome, `chrome://extensions` → load/reload the unpacked `extension/` folder → confirm version **4.49**.
2. Right-click the icon → **Options** → check a couple of interests → **Save interests**. (Requires the app running.)
3. Start the app (`npm start`). Wait a few seconds (the renderer drains the first request and validates a batch).
4. Left-click the icon → a real external page opens in a new tab with the overlay bar.
5. Click **👍** and **👎** on a few pages — each advances in the **same tab**.
6. Click **★ Save** → confirm a new card appears in the app's Saved.
7. In the app, open Stumble and confirm new recommendations reflect the 👍/👎 (liked topics show up more; dismissed less).
8. Confirm the old popup no longer appears on left-click, and right-click still shows **Save to Interests** + **Remove from Interests**.

- [ ] **Step 6: Release (after Dave confirms the manual pass)**

```bash
git checkout master && git merge --ff-only feature/browser-stumble && git push
npm run dist
```

Then tell Dave the installer path (`C:\Users\dkbar\interests-dist\Interests-App-Setup-1.12.0.exe`), and to install it, verify the version via **?**, and reload the extension in Chrome.

---

## Self-Review (completed)

- **Spec coverage:** loop/overlay (Tasks 6–7), same-tab reuse (Task 7 `bstumbleOpen`), fresh-only (renderer only ever delivers validated `stumbleForInterests` output — Task 4), interests picker on Options page (Task 8), full-learning feedback→likes/hidden (Task 4), interest-scoped prompt (Task 3), Core mailboxes + categories (Task 1), client methods (Task 2), popup removed / Remove menu added (Tasks 5, 7), release (Task 9). All spec sections map to a task.
- **Placeholder scan:** none — every code step contains complete code.
- **Type consistency:** mailbox field names (`request`/`results`/`feedback`/`items`/`vote`) and KV keys (`ia_bstumble_*`) are identical across Core (Task 1), client (Task 2), renderer (Task 4), and extension (Tasks 7–8); `buildPrompt(mode, interestKeys)` signature matches its Task-4 caller; overlay message actions (`bstumbleVote`/`bstumbleSave`/`bstumbleNext`) match the Task-7 handler.
