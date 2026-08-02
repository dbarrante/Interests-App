# Export Card Research to Notion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A button in the AI-research panel that exports a card's title, source link, generated article, and Q&A to a new Notion page, via a server-side relay in the bundled Core service (Notion's API has no CORS support).

**Architecture:** Mirrors this project's existing Google Safe Browsing key pattern end to end: a secret stored in `config.json` (never round-tripped back to the browser), status/set routes in `core/server.js`, the actual outbound third-party call made server-side with Node's `fetch`, and a PWA-side stub returning "not applicable" (the PWA has no Core service to call). One new pure-logic module (`core/notion.js`) builds the Notion API request body, independently testable from the HTTP plumbing — same split `core/safebrowse.js` already uses.

**Tech Stack:** CommonJS in `core/`; vanilla JS inline in `web/index.html`/`pwa/index.html`. Node's built-in `fetch` for the outbound Notion call (no new dependency — matches `core/safebrowse.js`).

## Global Constraints

- Electron/web build only. PWA gets the existing "Not applicable on iPad" stub shape (spec: `docs/superpowers/specs/2026-08-02-notion-export-design.md`).
- The Notion secret lives in `config.json` via `core/config.js`, NOT in `S`/`ia_settings` — it must never be swept into Dropbox settings-sync, and a GET status route must never echo the raw secret back to the browser (mirrors `getSafeBrowsingKey`/the `/api/safebrowsing-key` route's `hasKey`-only response).
- No re-export tracking, no database target, no OAuth, no bulk export — v1 scope only.
- Every function touched in `web/index.html` must be edited identically in `pwa/index.html` — byte-for-byte. Verify with a parity test extending `tests/tabs-parity.test.js`'s `FNS` list (or a new dedicated parity test file if that one doesn't fit) after every UI task.
- Tests are plain Node `assert` scripts (`node tests/<name>.test.js`); `node tests/run.js` runs the syntax gate + all `*.test.js`. HTTP routes are tested by mounting `createServer()` on port 0 with a real `http.request` helper (see `tests/safety-endpoint.test.js`), isolating `%APPDATA%` via `process.env.APPDATA = fs.mkdtempSync(...)` BEFORE requiring `core/config`/`core/server`. Outbound third-party calls are tested by stubbing `global.fetch` (see `tests/safebrowse-call.test.js`), never a real network call.
- If any `pwa/index.html` edit lands, bump `pwa/sw.js`'s `SHELL_CACHE` (check current value, increment).
- Commit trailer must be exactly `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Notion config storage + status routes

**Files:**
- Modify: `core/config.js` (add `getNotionConfig`/`setNotionConfig` after `setSafeBrowsingKey`, `core/config.js:242-246`; add both to `module.exports`).
- Modify: `core/server.js` (add `GET`/`POST /api/notion-config` near the existing `/api/safebrowsing-key` routes, `core/server.js:1087-1095`).
- Test: `tests/notion-config.test.js` (new, mirrors `tests/safebrowse-call.test.js`'s isolation style but for pure config get/set — no fetch involved here), `tests/notion-config-endpoint.test.js` (new, mirrors `tests/safety-endpoint.test.js`'s HTTP-route style).

**Interfaces:**
- Produces: `config.getNotionConfig()` → `{token, parentPageId}` (both strings, `""` if unset); `config.setNotionConfig(fields)` → void, where `fields` is `{token?, parentPageId?}` — **only the keys present are changed**; an omitted key leaves that stored value untouched (a present key with an empty-string value explicitly clears it). This partial-update shape exists because Task 5's Settings UI shows the token pre-masked once set (never re-displaying the real secret) — saving a form where the user only edited the parent-page field must not silently wipe the token, and the browser has no way to "send back" a value it was never given. Task 3 consumes `getNotionConfig()` to read the stored token when making the actual Notion call; Task 4's `Store.setNotionConfig` and Task 5's `saveNotionConfig` both build and pass a partial `fields` object.

- [ ] **Step 1: Write the failing tests**

Create `tests/notion-config.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-notioncfg-"));
const config = require("../core/config");
let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

t("getNotionConfig returns empty strings when unset", () => {
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "");
  assert.strictEqual(c.parentPageId, "");
});
t("setNotionConfig persists both fields when both are present, trimmed", () => {
  config.setNotionConfig({ token: "  secret_abc123  ", parentPageId: "  page-id-xyz  " });
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "secret_abc123");
  assert.strictEqual(c.parentPageId, "page-id-xyz");
});
t("setNotionConfig with an omitted key leaves that stored value unchanged", () => {
  config.setNotionConfig({ token: "secret_1", parentPageId: "page_1" });
  config.setNotionConfig({ parentPageId: "page_2" });   // token key omitted entirely
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "secret_1", "omitted token must survive untouched");
  assert.strictEqual(c.parentPageId, "page_2");
});
t("setNotionConfig with a key present but empty string explicitly clears it", () => {
  config.setNotionConfig({ token: "secret_1", parentPageId: "page_1" });
  config.setNotionConfig({ token: "" });
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "", "present-and-empty must clear, not be ignored");
  assert.strictEqual(c.parentPageId, "page_1", "the other field is untouched");
});
t("setNotionConfig with a non-string value for a present key treats it as empty", () => {
  config.setNotionConfig({ token: "secret_1" });
  config.setNotionConfig({ token: null });
  assert.strictEqual(config.getNotionConfig().token, "");
});
t("setNotionConfig({}) or setNotionConfig() changes nothing", () => {
  config.setNotionConfig({ token: "secret_1", parentPageId: "page_1" });
  config.setNotionConfig({});
  config.setNotionConfig();
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "secret_1");
  assert.strictEqual(c.parentPageId, "page_1");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

Create `tests/notion-config-endpoint.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-notionend-"));
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-notionstore-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("GET with nothing set -> hasToken:false, hasParent:false", async () => {
    config.setNotionConfig({ token: "", parentPageId: "" });
    const r = await req(port, "GET", "/api/notion-config");
    assert.deepStrictEqual(r.json, { hasToken: false, hasParent: false });
  });
  await t("POST sets both, response never echoes the raw values", async () => {
    const r = await req(port, "POST", "/api/notion-config", { token: "secret_x", parentPageId: "page1" });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.hasToken, true);
    assert.strictEqual(r.json.hasParent, true);
    assert.ok(!("token" in r.json), "must not echo the token");
    assert.ok(!("parentPageId" in r.json), "must not echo the parent page id");
  });
  await t("GET after POST reflects hasToken/hasParent, still never echoes values", async () => {
    const r = await req(port, "GET", "/api/notion-config");
    assert.deepStrictEqual(r.json, { hasToken: true, hasParent: true });
  });
  await t("POST with only parentPageId in the body leaves the previously-set token untouched (key omitted, not cleared)", async () => {
    config.setNotionConfig({ token: "secret_z", parentPageId: "old-page" });
    const r = await req(port, "POST", "/api/notion-config", { parentPageId: "new-page" });
    assert.strictEqual(r.json.hasToken, true, "token key was never in the request body — must survive");
    assert.strictEqual(r.json.hasParent, true);
    assert.strictEqual(config.getNotionConfig().token, "secret_z", "the actual stored token must be unchanged");
    assert.strictEqual(config.getNotionConfig().parentPageId, "new-page");
  });
  await t("POST with token explicitly set to empty string clears it, even though the key is present", async () => {
    config.setNotionConfig({ token: "secret_zz", parentPageId: "p" });
    const r = await req(port, "POST", "/api/notion-config", { token: "" });
    assert.strictEqual(r.json.hasToken, false);
    assert.strictEqual(config.getNotionConfig().parentPageId, "p", "parentPageId key was omitted — must be untouched");
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run both test files to verify they fail**

Run: `node tests/notion-config.test.js` — expect FAIL (`getNotionConfig is not a function`).
Run: `node tests/notion-config-endpoint.test.js` — expect FAIL (404 on `/api/notion-config`).

- [ ] **Step 3: Implement `core/config.js`**

Immediately after `setSafeBrowsingKey` (`core/config.js:242-246`), add:

```js
function getNotionConfig() {
  const cfg = loadConfig();
  return {
    token: typeof cfg.notionToken === "string" ? cfg.notionToken : "",
    parentPageId: typeof cfg.notionParentPageId === "string" ? cfg.notionParentPageId : ""
  };
}

// Partial update: only keys PRESENT on `fields` are changed. A present key with
// a non-string/empty value clears that field; an OMITTED key leaves the
// currently-stored value untouched. This exists because the browser never
// re-receives the real token once set (Settings shows a mask) — a form save
// that only changed the parent page must not have any way to accidentally
// wipe the token, and "the browser resends what it was never given" isn't an
// option, so the contract has to be presence-based instead of value-based.
function setNotionConfig(fields) {
  const f = fields || {};
  const cfg = loadConfig();
  if (Object.prototype.hasOwnProperty.call(f, "token")) {
    cfg.notionToken = typeof f.token === "string" ? f.token.trim() : "";
  }
  if (Object.prototype.hasOwnProperty.call(f, "parentPageId")) {
    cfg.notionParentPageId = typeof f.parentPageId === "string" ? f.parentPageId.trim() : "";
  }
  saveConfig(cfg);
}
```

Add `getNotionConfig` and `setNotionConfig` to the `module.exports` object at the bottom of the file (alongside the existing `getSafeBrowsingKey`/`setSafeBrowsingKey`).

- [ ] **Step 4: Implement the `core/server.js` routes**

Immediately after the `/api/safebrowsing-key` POST route (`core/server.js:1091-1095`), add:

```js
app.get("/api/notion-config", (req, res) => {
  const c = config.getNotionConfig();
  res.json({ hasToken: !!c.token, hasParent: !!c.parentPageId });
});

app.post("/api/notion-config", (req, res) => {
  // Forward only the keys the client actually included — config.setNotionConfig
  // treats an omitted key as "leave unchanged" (see its own comment). Do NOT
  // default missing keys to "" here, that would defeat the whole point.
  const fields = {};
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, "token")) fields.token = req.body.token;
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, "parentPageId")) fields.parentPageId = req.body.parentPageId;
  config.setNotionConfig(fields);
  const c = config.getNotionConfig();
  res.json({ ok: true, hasToken: !!c.token, hasParent: !!c.parentPageId });
});
```

- [ ] **Step 5: Run both test files to verify they pass**

Run: `node tests/notion-config.test.js` and `node tests/notion-config-endpoint.test.js` — expect PASS, all cases.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js` — expect green.

- [ ] **Step 7: Commit**

```bash
git add core/config.js core/server.js tests/notion-config.test.js tests/notion-config-endpoint.test.js
git commit -m "$(cat <<'EOF'
Add Notion config storage + status routes

Mirrors the existing Google Safe Browsing key pattern: token/parent
page id stored in config.json (never in ia_settings, never echoed
back to the browser), GET/POST /api/notion-config for status/set.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Notion block-building (pure logic)

**Files:**
- Create: `core/notion.js`.
- Test: `tests/notion-blocks.test.js` (new).

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildPageBody(parentPageId, payload)` where `payload = {title, url, article: {text, sources} | null, qa: [{question, answer, sources}]}` → the full JSON body for Notion's `POST /v1/pages`. Task 3 consumes this directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/notion-blocks.test.js`:

```js
const assert = require("assert");
const { buildPageBody, splitIntoRichText } = require("../core/notion");
let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

t("splitIntoRichText returns one segment for short text", () => {
  const segs = splitIntoRichText("hello world");
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].text.content, "hello world");
});
t("splitIntoRichText hard-splits text over 2000 chars into multiple segments, none over 2000", () => {
  const long = "a".repeat(4500);
  const segs = splitIntoRichText(long);
  assert.ok(segs.length >= 3, "expected at least 3 segments, got " + segs.length);
  segs.forEach(s => assert.ok(s.text.content.length <= 2000, "segment exceeds 2000 chars"));
  assert.strictEqual(segs.map(s => s.text.content).join(""), long, "segments must reassemble to the original text losslessly");
});

t("buildPageBody sets the parent and title correctly", () => {
  const body = buildPageBody("parent-123", { title: "My Card", url: "https://example.com", article: null, qa: [] });
  assert.deepStrictEqual(body.parent, { page_id: "parent-123" });
  assert.strictEqual(body.properties.title.title[0].text.content, "My Card");
});
t("buildPageBody includes a link to the source url near the top", () => {
  const body = buildPageBody("p", { title: "T", url: "https://example.com/page", article: null, qa: [] });
  const first = body.children[0];
  assert.strictEqual(first.type, "paragraph");
  assert.ok(JSON.stringify(first).includes("https://example.com/page"));
});
t("buildPageBody omits the source-link block when url is empty", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: null, qa: [] });
  assert.ok(!body.children.some(b => b.type === "paragraph" && JSON.stringify(b).includes("http")));
});
t("buildPageBody renders the article as one paragraph block per paragraph", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: { text: "Para one.\n\nPara two.\n\nPara three.", sources: [] }, qa: [] });
  const paragraphBlocks = body.children.filter(b => b.type === "paragraph");
  assert.ok(paragraphBlocks.length >= 3, "expected at least 3 paragraph blocks, got " + paragraphBlocks.length);
});
t("buildPageBody includes a bulleted source list under the article when sources exist", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: { text: "Body.", sources: ["https://a.test/", "https://b.test/"] }, qa: [] });
  const bullets = body.children.filter(b => b.type === "bulleted_list_item");
  assert.strictEqual(bullets.length, 2);
});
t("buildPageBody omits the article's source list when there are no sources", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: { text: "Body.", sources: [] }, qa: [] });
  assert.strictEqual(body.children.filter(b => b.type === "bulleted_list_item").length, 0);
});
t("buildPageBody renders each Q&A pair as a heading_3 (question) + paragraph (answer)", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: null, qa: [
    { question: "Q1?", answer: "A1.", sources: [] },
    { question: "Q2?", answer: "A2.", sources: [] }
  ] });
  const headings = body.children.filter(b => b.type === "heading_3");
  assert.strictEqual(headings.length, 2);
  assert.ok(JSON.stringify(headings[0]).includes("Q1?"));
  assert.ok(JSON.stringify(headings[1]).includes("Q2?"));
});
t("buildPageBody includes a bulleted source list under each Q&A pair that has sources", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: null, qa: [
    { question: "Q1?", answer: "A1.", sources: ["https://c.test/"] }
  ] });
  assert.strictEqual(body.children.filter(b => b.type === "bulleted_list_item").length, 1);
});
t("buildPageBody with neither article nor qa still produces a valid body (title + optional source link only)", () => {
  const body = buildPageBody("p", { title: "Bare card", url: "https://x.test", article: null, qa: [] });
  assert.strictEqual(body.properties.title.title[0].text.content, "Bare card");
  assert.ok(body.children.length >= 1);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node tests/notion-blocks.test.js`
Expected: FAIL — `Cannot find module '../core/notion'`.

- [ ] **Step 3: Implement `core/notion.js`**

```js
// core/notion.js — pure Notion API request-body builder. No I/O here (see
// createPage in this same file for the actual outbound call, added in Task 3) —
// kept separate so the block-shaping logic is testable without a network mock,
// same split core/safebrowse.js uses for its lookup-body builder vs its fetch call.
"use strict";

const RICH_TEXT_LIMIT = 2000;

// Notion's rich_text array holds multiple {type:"text", text:{content}} segments
// per block, each capped at 2000 chars — this hard-splits a long string into
// segments without ever cutting a segment mid-way through by anything other than
// length (no attempt at word-boundary splitting; a mid-word split is harmless in
// a Notion block, and word-boundary logic isn't worth the edge cases for v1).
function splitIntoRichText(text) {
  const s = String(text || "");
  const segments = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_LIMIT) {
    segments.push({ type: "text", text: { content: s.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return segments.length ? segments : [{ type: "text", text: { content: "" } }];
}

function paragraphBlock(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: splitIntoRichText(text) } };
}

function heading3Block(text) {
  return { object: "block", type: "heading_3", heading_3: { rich_text: splitIntoRichText(text) } };
}

function bulletBlock(url) {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: url, link: { url: url } } }] } };
}

function sourceListBlocks(sources) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  return list.map(bulletBlock);
}

// payload = { title, url, article: {text, sources} | null, qa: [{question, answer, sources}] }
function buildPageBody(parentPageId, payload) {
  const p = payload || {};
  const children = [];
  if (p.url) children.push(paragraphBlock("Source: " + p.url));
  if (p.article && p.article.text) {
    const paragraphs = p.article.text.split(/\n\s*\n/).filter(x => x.trim());
    paragraphs.forEach(para => children.push(paragraphBlock(para)));
    children.push(...sourceListBlocks(p.article.sources));
  }
  (p.qa || []).forEach(entry => {
    children.push(heading3Block(entry.question || ""));
    const answerParagraphs = String(entry.answer || "").split(/\n\s*\n/).filter(x => x.trim());
    (answerParagraphs.length ? answerParagraphs : [""]).forEach(para => children.push(paragraphBlock(para)));
    children.push(...sourceListBlocks(entry.sources));
  });
  return {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: p.title || "Untitled" } }] } },
    children: children
  };
}

module.exports = { buildPageBody, splitIntoRichText };
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `node tests/notion-blocks.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js` — expect green.

- [ ] **Step 6: Commit**

```bash
git add core/notion.js tests/notion-blocks.test.js
git commit -m "$(cat <<'EOF'
Add pure Notion page-body builder

buildPageBody(parentPageId, payload) turns a card's title/url/article/
qa into a Notion API request body — paragraph splitting, a 2000-char
rich-text hard-split, and per-section source bullet lists. No I/O;
the outbound POST /v1/pages call is Task 3.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The export route

**Files:**
- Modify: `core/notion.js` (add `createPage`).
- Modify: `core/server.js` (add `POST /api/notion/export`).
- Test: `tests/notion-create-page.test.js` (new, mirrors `tests/safebrowse-call.test.js`'s `global.fetch` stubbing), `tests/notion-export-endpoint.test.js` (new, mirrors `tests/safety-endpoint.test.js`).

**Interfaces:**
- Consumes: `config.getNotionConfig()` (Task 1), `buildPageBody` (Task 2).
- Produces: `notion.createPage(token, parentPageId, payload)` → `{ok:true, pageUrl}` or `{ok:false, error}`. Task 4's `Store.exportToNotion` consumes the route this task adds, not `createPage` directly (that only runs server-side).

- [ ] **Step 1: Write the failing tests**

Create `tests/notion-create-page.test.js`:

```js
const assert = require("assert");
const notion = require("../core/notion");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  const realFetch = global.fetch;

  await t("success: posts to /v1/pages with the right headers, returns {ok:true, pageUrl}", async () => {
    let capturedUrl, capturedOpts;
    global.fetch = async (url, opts) => {
      capturedUrl = url; capturedOpts = opts;
      return { ok: true, json: async () => ({ url: "https://notion.so/abc123" }) };
    };
    const r = await notion.createPage("secret_x", "parent-1", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pageUrl, "https://notion.so/abc123");
    assert.strictEqual(capturedUrl, "https://api.notion.com/v1/pages");
    assert.strictEqual(capturedOpts.headers["Authorization"], "Bearer secret_x");
    assert.ok(capturedOpts.headers["Notion-Version"], "must send a Notion-Version header");
    const body = JSON.parse(capturedOpts.body);
    assert.deepStrictEqual(body.parent, { page_id: "parent-1" });
  });

  await t("Notion 4xx -> {ok:false, error} carrying Notion's own message, not a raw exception", async () => {
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ message: "path failed validation" }) });
    const r = await notion.createPage("secret_x", "bad-parent", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /path failed validation/);
  });

  await t("network throw -> {ok:false, error}, never throws", async () => {
    global.fetch = async () => { throw new Error("network down"); };
    const r = await notion.createPage("secret_x", "p", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

Create `tests/notion-export-endpoint.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-notionexp-"));
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-notionexpstore-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const realFetch = global.fetch;
  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("no token configured -> {ok:false, error:'no_token'}, no fetch attempted", async () => {
    config.setNotionConfig({ token: "", parentPageId: "page-1" });
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "no_token");
    assert.strictEqual(fetchCalled, false);
  });

  await t("no parent page configured -> {ok:false, error:'no_parent'}, no fetch attempted", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "" });
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "no_parent");
    assert.strictEqual(fetchCalled, false);
  });

  await t("configured + successful Notion call -> {ok:true, pageUrl}", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    global.fetch = async () => ({ ok: true, json: async () => ({ url: "https://notion.so/xyz" }) });
    const r = await req(port, "POST", "/api/notion/export", { title: "Card Title", url: "https://source.test", article: { text: "Body.", sources: [] }, qa: [] });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.pageUrl, "https://notion.so/xyz");
  });

  await t("configured + Notion call fails -> {ok:false, error} relayed, HTTP 200 (not a 500 — this is a normal, expected outcome)", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ message: "bad request" }) });
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, false);
    assert.match(r.json.error, /bad request/);
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run both test files to verify they fail**

Run: `node tests/notion-create-page.test.js` — expect FAIL (`notion.createPage is not a function`).
Run: `node tests/notion-export-endpoint.test.js` — expect FAIL (404 on `/api/notion/export`).

- [ ] **Step 3: Add `createPage` to `core/notion.js`**

Append to `core/notion.js` (before `module.exports`):

```js
const NOTION_VERSION = "2022-06-28";

// Actual outbound call — separated from buildPageBody so the shaping logic
// (Task 2) stays testable without a network mock. Never throws: any failure
// (HTTP error or network exception) resolves {ok:false, error}, matching this
// project's fail-soft convention for third-party calls (see core/safebrowse.js).
async function createPage(token, parentPageId, payload) {
  const body = buildPageBody(parentPageId, payload);
  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (json && json.message) || ("Notion API error " + res.status) };
    return { ok: true, pageUrl: json.url || "" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
```

Update `module.exports` at the bottom of `core/notion.js` to also export `createPage`.

- [ ] **Step 4: Add the export route to `core/server.js`**

Add near the `/api/notion-config` routes from Task 1:

```js
app.post("/api/notion/export", async (req, res) => {
  const c = config.getNotionConfig();
  if (!c.token) { res.json({ ok: false, error: "no_token" }); return; }
  if (!c.parentPageId) { res.json({ ok: false, error: "no_parent" }); return; }
  const payload = {
    title: (req.body && req.body.title) || "",
    url: (req.body && req.body.url) || "",
    article: (req.body && req.body.article) || null,
    qa: (req.body && Array.isArray(req.body.qa)) ? req.body.qa : []
  };
  const result = await notion.createPage(c.token, c.parentPageId, payload);
  res.json(result);
});
```

Add `const notion = require("./notion");` alongside this file's other `core/` requires near the top.

- [ ] **Step 5: Run both test files to verify they pass**

Run: `node tests/notion-create-page.test.js` and `node tests/notion-export-endpoint.test.js` — expect PASS, all cases.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js` — expect green.

- [ ] **Step 7: Commit**

```bash
git add core/notion.js core/server.js tests/notion-create-page.test.js tests/notion-export-endpoint.test.js
git commit -m "$(cat <<'EOF'
Add the Notion export route

POST /api/notion/export reads the stored token/parent page id
(config.json, never the browser), calls Notion's API server-side,
and relays {ok, pageUrl|error} — never a raw exception, never a 500
for an ordinary Notion-side rejection.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Browser-side Store adapters

**Files:**
- Modify: `web/storage.js` (add 3 `SE` endpoint builders + 3 `Store` methods).
- Modify: `pwa/storage-pwa.js` (add 3 matching stubs).
- Test: `tests/notion-store-adapter.test.js` (new).

**Interfaces:**
- Consumes: the routes from Tasks 1 and 3.
- Produces: `Store.getNotionStatus()` → `Promise<{hasToken, hasParent}>`; `Store.setNotionConfig(fields)` → `Promise<{ok, hasToken, hasParent}>`, where `fields` is `{token?, parentPageId?}` (same partial-update contract as Task 1's `config.setNotionConfig` — pass only the keys actually changing); `Store.exportToNotion(payload)` → `Promise<{ok, pageUrl|error|reason}>`. Task 5 (Settings UI) and Task 6 (export button) both call these — not `fetch`/`SE` directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/notion-store-adapter.test.js` — this project's convention for testing `Store`'s `fetch`-based methods without a real server is to stub `global.fetch` and `require("../web/storage.js")` fresh per test (check an existing test of a simple `Store` method, e.g. one exercising `Store.getSafeBrowsingKey`/`Store.setSafeBrowsingKey`, for the exact `require`-fresh-module + stub-fetch pattern this repo uses — mirror it exactly rather than inventing a new harness). Cover:
- `Store.getNotionStatus()` calls `GET /api/notion-config` and returns the parsed `{hasToken, hasParent}`.
- `Store.setNotionConfig(fields)` calls `POST /api/notion-config` with `fields` passed straight through as the request body — do not add or default any keys `fields` doesn't already have (that would defeat Task 1's omitted-key-means-unchanged contract). Cover both `Store.setNotionConfig({parentPageId:"p"})` (body has only `parentPageId`) and `Store.setNotionConfig({token:"t", parentPageId:"p"})` (body has both) as separate test cases, asserting the exact JSON body sent, not just that the call succeeded.
- `Store.exportToNotion(payload)` calls `POST /api/notion/export` with `payload` as the body and returns the parsed response.
- Each method rejects/handles a non-2xx response the same way this file's existing `jget`/`jsend`-based methods do (don't invent new error handling — reuse `jget`/`jsend`).

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node tests/notion-store-adapter.test.js` — expect FAIL (`Store.getNotionStatus is not a function`).

- [ ] **Step 3: Implement `web/storage.js`**

Add to the `SE` object (`web/storage.js:9-53`), alongside `safeBrowsingKey`/`safebrowsingVerify`:

```js
,notionConfig: function () { return "/api/notion-config"; }
,notionExport: function () { return "/api/notion/export"; }
```

Add to the `Store` object, alongside `getSafeBrowsingKey`/`setSafeBrowsingKey`/`verifySafeBrowsing` (`web/storage.js:202-204`):

```js
getNotionStatus: function () { return jget(SE.notionConfig()); },
setNotionConfig: function (fields) { return jsend("POST", SE.notionConfig(), fields || {}); },
exportToNotion: function (payload) { return jsend("POST", SE.notionExport(), payload); },
```

- [ ] **Step 4: Implement `pwa/storage-pwa.js`**

Add alongside the existing `getSafeBrowsingKey`/`setSafeBrowsingKey`/`verifySafeBrowsing` stubs (`pwa/storage-pwa.js:260-262`):

```js
getNotionStatus: () => Promise.resolve({ hasToken: false, hasParent: false }),
setNotionConfig: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — Notion export needs the desktop app's local service." }),
exportToNotion: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — Notion export needs the desktop app's local service." }),
```

- [ ] **Step 5: Run the test file to verify it passes**

Run: `node tests/notion-store-adapter.test.js` — expect PASS, all cases.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js` — expect green.

- [ ] **Step 7: Commit**

```bash
git add web/storage.js pwa/storage-pwa.js tests/notion-store-adapter.test.js
git commit -m "$(cat <<'EOF'
Add Store.getNotionStatus/setNotionConfig/exportToNotion

web/storage.js talks to the Core routes from Tasks 1+3; the PWA build
gets the standard "Not applicable on iPad" stub shape, matching
Safe Browsing's existing precedent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Settings UI

**Files:**
- Modify: `web/index.html` (new Settings section near the Safe Browsing key block, `web/index.html:658-665`; new `loadNotionStatus`/`saveNotionConfig` functions near `loadSafetyKeyStatus`/`saveSafeBrowsingKey`, `web/index.html:2188-2212`).
- Modify: `pwa/index.html` at the mirrored locations.
- Test: extend the parity test covering Settings functions (find and extend whichever existing test file already checks Settings-area functions for web/pwa byte-identity — if none fits cleanly, add a new small parity test file for just the two new functions).

**Interfaces:**
- Consumes: `Store.getNotionStatus`, `Store.setNotionConfig` (Task 4).
- Produces: `loadNotionStatus()`, `saveNotionConfig()` — called from `renderSettings()`'s init and the new section's Save button.

- [ ] **Step 1: Write the failing tests**

Add tests (in the file you chose in this task's Files section) asserting, for both `web` and `pwa` sources:
- A `#notionToken` input and `#notionParentPage` input exist in the static shell (regex on the raw source, matching this project's convention for static-markup assertions — see `tests/tabs-bulk-add.test.js`'s `"a #savedBulkBar container exists in the static shell"` test for the exact style).
- `saveNotionConfig`, with the token field left at `NOTION_MASK` and the parent-page field changed, calls `Store.setNotionConfig` with a `fields` object that has `parentPageId` but does NOT have a `token` key at all (`assert.ok(!("token" in fields))` — not just "falsy," genuinely absent, since presence-vs-absence is the whole contract).
- `saveNotionConfig`, with the token field changed to a real value, calls `Store.setNotionConfig` with a `fields` object that HAS both `token` and `parentPageId` keys.
- `loadNotionStatus` and `saveNotionConfig` are byte-identical between `web/index.html` and `pwa/index.html`.

- [ ] **Step 2: Run the test file to verify it fails**

Expected: FAIL — the new functions/markup don't exist yet.

- [ ] **Step 3: Implement `web/index.html`**

Add a new block after the Safe Browsing key block (`web/index.html:658-665`), same structural pattern:

```html
<div id="notionExportBlock" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
  <label style="font-weight:600">Notion export <span id="notionStatus" class="hint"></span></label>
  <div class="hint">Export a card's research to Notion as a new page — <a href="#" onclick="showGuide('notionkey');return false"><b>step-by-step instructions</b></a>. Desktop app only.</div>
  <div style="display:flex;gap:8px;margin-top:6px">
    <input type="password" id="notionToken" placeholder="Paste your Notion integration secret…" style="flex:1">
  </div>
  <div style="display:flex;gap:8px;margin-top:6px">
    <input type="text" id="notionParentPage" placeholder="Parent page ID (from the page's Notion URL)…" style="flex:1">
    <button class="btn btn-primary" onclick="saveNotionConfig()">Save</button>
  </div>
</div>
```

Add `notionkey` to the `showGuide` content object (find where `sbkey`'s guide text lives, `web/index.html:2611-2617`, and add a sibling entry with short instructions: create an integration at `notion.so/my-integrations`, copy its secret, open the target Notion page, use its `···` menu → Connections → connect the integration, then copy the page ID from that page's URL).

Add near `loadSafetyKeyStatus`/`saveSafeBrowsingKey` (`web/index.html:2188-2212`):

```js
const NOTION_MASK = "••••••••••••••••••••••••";
async function loadNotionStatus(){
  let status = { hasToken:false, hasParent:false };
  try { status = await Store.getNotionStatus(); } catch(e){ const el0=document.getElementById("notionStatus"); if(el0) el0.textContent=""; return; }
  const tokInp = document.getElementById("notionToken");
  if (tokInp && status.hasToken && !tokInp.value) tokInp.value = NOTION_MASK;
  const el = document.getElementById("notionStatus");
  if (el) el.textContent = status.hasToken && status.hasParent ? "— configured" : status.hasToken ? "— missing parent page" : status.hasParent ? "— missing secret" : "— not set";
}
// Builds the request as ONLY the fields actually changing — Store.setNotionConfig
// (Task 4) forwards this straight to POST /api/notion-config, whose contract
// (Task 1) is "an omitted key leaves that stored value unchanged." The token
// input is never populated with the real secret (only NOTION_MASK once one is
// set), so "field left as the mask" must mean "not included in this request" —
// there is no other way to express "leave it alone" without re-sending a value
// the browser was never given in the first place.
async function saveNotionConfig(){
  const tokInp = document.getElementById("notionToken");
  const pageInp = document.getElementById("notionParentPage");
  const tok = tokInp ? tokInp.value.trim() : "";
  const page = pageInp ? pageInp.value.trim() : "";
  const fields = { parentPageId: page };
  if (tok !== NOTION_MASK) fields.token = tok;   // omit entirely when unmodified
  let res;
  try { res = await Store.setNotionConfig(fields); } catch(e){ toast("Couldn't save Notion settings", 4000); return; }
  if (res && res.ok===false){ toast(res.reason || "Couldn't save Notion settings", 4000); return; }
  if (tokInp && "token" in fields) tokInp.value = "";
  toast("Notion settings saved", 4000);
  loadNotionStatus();
}
```

- [ ] **Step 4: Mirror Step 3 into `pwa/index.html`**

Apply the identical HTML block, guide text, and JS functions at `pwa/index.html`'s mirrored locations.

- [ ] **Step 5: Run the test file to verify it passes**

Expected: PASS, all cases, both `web` and `pwa`.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js` — expect green, including Task 1's updated endpoint test.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/
git commit -m "$(cat <<'EOF'
Add Notion settings UI

Token + parent-page-id inputs, modeled on the existing Safe Browsing
key section. saveNotionConfig omits the token key entirely when the
field is left at its mask, relying on Task 1's partial-update
contract so an unmodified token is never at risk of being wiped.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Export button in the research panel

**Files:**
- Modify: `web/index.html` (`researchPanelHTML`, `web/index.html:3815-3876`; new `exportCardToNotion` function nearby).
- Modify: `pwa/index.html` at the mirrored location.
- Test: extend whichever test file already covers `researchPanelHTML`/the AI-research button row for web/pwa parity (search for existing tests referencing `researchPanelHTML`, `copyArticleText`, or `askQuestion` to find it) with new cases for the export button and handler.

**Interfaces:**
- Consumes: `Store.exportToNotion`, `Store.getNotionStatus` (Task 4).
- Produces: `exportCardToNotion(scope, id)` — the button's click handler.

- [ ] **Step 1: Write the failing tests**

Cover, for both `web` and `pwa`:
- `researchPanelHTML` renders an "Export to Notion" button when `it.research.article` exists.
- `researchPanelHTML` renders the button when there's no article but `it.research.qa.length > 0`.
- `researchPanelHTML` does NOT render the button when neither an article nor any Q&A exists.
- `exportCardToNotion` gates on `Store.getNotionStatus()`: if not `hasToken`/`hasParent`, toasts an explanatory message and does NOT call `Store.exportToNotion` (mirror the `hasResearchProvider()`/`hasAIKey()` early-return gating shape in `generateArticle`, `web/index.html:3772-3773`, including the "Not applicable" case surfaced via `res.reason` when running under the PWA stub — reuse the SAME toast pattern this app already uses elsewhere for a `{ok:false, reason}` PWA stub response, e.g. `moveDataLocation`'s handling, don't invent new phrasing).
- `exportCardToNotion` builds its payload from `it.research` correctly: `{title: it.title, url: it.url, article: it.research.article || null, qa: it.research.qa || []}`.
- On success, toasts a message that includes the returned `pageUrl` (or opens it — your call on exact UX, but the toast must be verifiable in a test either way; if you make it clickable-to-open, use the app's existing `toast(msg, ms, onclick)` third-argument pattern, `web/index.html:1014`, rather than a raw `window.open` inside the handler).
- `researchPanelHTML` and `exportCardToNotion` are byte-identical between `web/index.html` and `pwa/index.html`.

- [ ] **Step 2: Run the test file to verify it fails**

Expected: FAIL — button/function don't exist yet.

- [ ] **Step 3: Implement `web/index.html`**

Add a `canExport` check near the top of `researchPanelHTML` (`web/index.html:3815-3822`, right after the existing `art` computation):

```js
const canExport = !!art || !!((it.research && it.research.qa) || []).length;
```

Add an export row to the returned template (`web/index.html:3867-3876`), after `qaList` and before the closing `</div>`:

```js
${canExport ? `<div style="margin-top:10px"><button class="btn-ghost" onclick="exportCardToNotion('${scope}','${it.id}')">Export to Notion</button></div>` : ""}
```

Add `exportCardToNotion` near `askQuestion`/`generateArticle`:

```js
async function exportCardToNotion(scope, id){
  const it = _researchCard(scope, id); if(!it) return;
  let status;
  try { status = await Store.getNotionStatus(); } catch(e){ toast("Couldn't reach Notion export — try again", 4000); return; }
  if(!status || (!status.hasToken && !status.hasParent)){ toast("Add your Notion integration in Settings first", 5000); return; }
  if(!status.hasToken){ toast("Add your Notion integration secret in Settings first", 5000); return; }
  if(!status.hasParent){ toast("Set a target Notion page in Settings first", 5000); return; }
  const payload = { title: it.title, url: it.url||"", article: (it.research&&it.research.article)||null, qa: (it.research&&it.research.qa)||[] };
  toast("Exporting to Notion…", 3000);
  let res;
  try { res = await Store.exportToNotion(payload); } catch(e){ toast("Export failed — try again", 4000); return; }
  if(!res || res.ok===false){ toast((res&&(res.reason||res.error))||"Export failed", 6000); return; }
  toast("Exported to Notion — click to open", 6000, ()=>window.open(res.pageUrl,"_blank","noopener"));
}
```

(`_researchCard(scope,id)` already exists, `web/index.html:3701-3703`, resolving a saved/imported item by id.)

- [ ] **Step 4: Mirror Step 3 into `pwa/index.html`**

Apply the identical edits at the mirrored location.

- [ ] **Step 5: Run the test file to verify it passes**

Expected: PASS, all cases, both `web` and `pwa`.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js` — expect green.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/
git commit -m "$(cat <<'EOF'
Add the Export-to-Notion button to the research panel

Shown whenever a card has an article or at least one Q&A entry.
Gates on Store.getNotionStatus() with the same toast-and-return
pattern generateArticle/askQuestion already use for missing AI
provider config, including the PWA "not applicable" case.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final regression + manual verification

**Files:**
- Modify (conditionally): `pwa/sw.js` (`SHELL_CACHE` bump).
- No new source files.

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing new — verification only.

- [ ] **Step 1: Run the full test suite**

Run: `node tests/syntax-check.js && node tests/run.js` — expect green across every `*.test.js` file, not just the ones this plan added.

- [ ] **Step 2: Bump `pwa/sw.js`'s `SHELL_CACHE`**

Read the current value and increment by 1 — `pwa/index.html` was touched in Tasks 4-6.

- [ ] **Step 3: Manual verification (needs a real Notion workspace — cannot be automated)**

Document this checklist as your final report; this task cannot execute it without live credentials:

1. Create a Notion internal integration at `notion.so/my-integrations`, copy its secret.
2. Create (or pick) a Notion page, connect it to the integration via its `···` menu → Connections, copy its page ID from the URL.
3. In the app's Settings, paste both into the new Notion section, Save — confirm the status line reads "configured."
4. Open a card in the reserved AI tab that has both a generated article and at least one Q&A entry. Confirm the "Export to Notion" button is visible.
5. Click it. Confirm the toast sequence (exporting → success-with-link), and that clicking the success toast opens the new Notion page.
6. In Notion, confirm: the page title matches the card's title; the source link is present near the top; the article reads as legible paragraphs (not one giant block, not visibly truncated at 2000 chars if the article was long); each Q&A pair shows as a heading + answer; source links under the article/each answer are present and clickable.
7. Try exporting a card with ONLY Q&A (no article) — confirm the button still appears and the export works with no article section.
8. Clear the parent-page-id field only (leave the token) and Save — confirm the status line correctly reflects "missing parent page," and that the previously-saved token was NOT wiped (re-check by attempting an export with a valid page id filled back in — it should still work without re-pasting the secret).
9. In a PWA build (or by directly testing `pwa/storage-pwa.js`'s stubs), confirm the Settings section and button behave per the "Not applicable" messaging rather than erroring.

- [ ] **Step 4: Commit (only if Step 2 changed `pwa/sw.js`)**

```bash
git add pwa/sw.js
git commit -m "$(cat <<'EOF'
Bump SHELL_CACHE for the Notion-export feature's pwa/index.html edits

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
