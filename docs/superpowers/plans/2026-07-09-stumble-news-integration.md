# Stumble News Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring interest-matched news stories into Stumble — intermixed into the normal deck (default on) and as a dedicated news-only mode via a 📰 sidebar toggle — sourced free from Google News RSS.

**Architecture:** A new dependency-free Core module `core/news.js` fetches + parses Google News RSS per interest; a loopback `GET /api/news` route exposes it; the renderer adds a 📰 News sidebar toggle (news-only, filtered by the user's specific interests), a default-on "Mix fresh news into Stumble" setting, and routes the existing spool/deal machinery to the free news path when in news mode. News reuses the existing card, 👎-blocklist, 5-day-seen, and Save flows but skips the AI-style title-mismatch validation.

**Tech Stack:** Node (`core/`, CommonJS, no native deps), Express (Core routes), single-file renderer (`web/index.html`) tested via source-assertions, plain `node:assert` test scripts run by `tests/run.js`.

## Global Constraints

- **No new runtime dependencies** — `core/news.js` parses RSS with string/regex only (the repo avoids native/XML deps).
- **All outbound fetches go through Core** (`core/guardedfetch.js`), never the renderer (browser CORS blocks feed fetches).
- **Tests must not touch the real network or DNS** — inject/stub the fetch; never call a live feed.
- **Never commit personal data, backups, exports, or the `data/` store.** Preserve the untracked `.agents/`, `.codex/`, `AGENTS.md`, `_loopstate/` files (stage explicit paths, never `git add -A`).
- **Loopback + Origin/Host guards** already wrap every Core route via middleware — the new route inherits them; do not weaken them.
- **Frozen wire fields:** do not rename existing card/saved image fields. News items are transient (spool only), shaped as `{id,title,url,source,category,benefit,image,isNews,ts}`.
- **Release:** bumping `package.json` version on `master` triggers CI to build + publish the installer. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File structure

- **Create** `core/news.js` — `parseNewsRss(xml)` (pure) + `fetchNews(interests, opts)` (injectable fetch).
- **Modify** `core/server.js` — add `GET /api/news`; `require("./news")`.
- **Modify** `web/storage.js` — add `SE.news(interests)` + `Store.news(interests)`.
- **Modify** `web/index.html` — state + boot load, `interestList`, `relTime`, `newsBatch`, `interleaveNews`, `usableSpool` news-safety, `stumbleFetch` branch (Task 5); `stCatSideHTML` News pill + `stNewsSideHTML` + `stWrap` dispatch + `toggleNewsOnly`/`setNewsInterest` + `stCardHTML` badge + `.news-badge` CSS + Settings toggle + news empty-state (Task 6).
- **Create** `tests/news-parse.test.js`, `tests/news-fetch.test.js`, `tests/news-route.test.js`, `tests/storage-se-news.test.js`, `tests/stumble-news-data.test.js`, `tests/stumble-news-ui.test.js`.

---

## Task 1: `core/news.js` — `parseNewsRss` (pure parser)

**Files:**
- Create: `core/news.js`
- Test: `tests/news-parse.test.js`

**Interfaces:**
- Produces: `parseNewsRss(xml: string) → Array<{ title:string, url:string, source:string, ts:number }>` — `ts` is epoch ms (0 if unparseable). Strips a trailing " - <source>" from the title. Decodes CDATA + HTML entities.

- [ ] **Step 1: Write the failing test**

Create `tests/news-parse.test.js`:

```javascript
// tests/news-parse.test.js — parseNewsRss extracts headline/link/publisher/date from
// Google News RSS, decodes entities/CDATA, and strips the trailing " - Publisher".
const assert = require("assert");
const { parseNewsRss } = require("../core/news.js");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

const XML = `<?xml version="1.0"?><rss><channel>
<item>
  <title>Bees &amp; the art of hive design - The Verge</title>
  <link>https://news.google.com/rss/articles/ABC123</link>
  <pubDate>Wed, 08 Jul 2026 12:00:00 GMT</pubDate>
  <source url="https://www.theverge.com">The Verge</source>
</item>
<item>
  <title><![CDATA[A new lathe for tiny workshops]]></title>
  <link>https://news.google.com/rss/articles/DEF456</link>
  <pubDate>Tue, 07 Jul 2026 09:30:00 GMT</pubDate>
  <source url="https://example.com">Maker Mag</source>
</item>
<item>
  <title>Missing link item</title>
</item>
</channel></rss>`;

const items = parseNewsRss(XML);
ok("parses the two well-formed items (skips the linkless one)", items.length === 2);
ok("decodes entities in the title", items[0].title.indexOf("&") === -1 && items[0].title.indexOf("Bees & the art") === 0);
ok("strips the trailing ' - Publisher'", items[0].title === "Bees & the art of hive design");
ok("keeps the link", items[0].url === "https://news.google.com/rss/articles/ABC123");
ok("captures the publisher", items[0].source === "The Verge");
ok("parses pubDate to epoch ms", items[0].ts === Date.parse("Wed, 08 Jul 2026 12:00:00 GMT"));
ok("handles CDATA titles", items[1].title === "A new lathe for tiny workshops");
ok("bad/empty xml → []", parseNewsRss("") .length === 0 && parseNewsRss(null).length === 0);

console.log("news-parse: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/news-parse.test.js`
Expected: FAIL — `Cannot find module '../core/news.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `core/news.js`:

```javascript
// core/news.js — free news source for Stumble. Fetches + parses Google News RSS per
// interest keyword. Dependency-free (string/regex parse; the repo avoids XML/native deps).
// Outbound fetches go through core/guardedfetch (timeouts, drain-don't-cancel). The fetch is
// injectable so tests never hit the real network.
"use strict";

var ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, function (m) { return ENTITIES[m]; })
    .trim();
}
function pick(seg, tag) {
  var m = seg.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? decodeEntities(m[1]) : "";
}
function pickSource(seg) {
  var m = seg.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  return m ? decodeEntities(m[1]) : "";
}

// Parse Google News RSS into [{title,url,source,ts}]. Pure; no network.
function parseNewsRss(xml) {
  if (!xml || typeof xml !== "string") return [];
  var out = [];
  var blocks = xml.split(/<item[\s>]/i).slice(1);
  for (var i = 0; i < blocks.length; i++) {
    var seg = blocks[i].split(/<\/item>/i)[0];
    var title = pick(seg, "title");
    var url = pick(seg, "link");
    if (!title || !url) continue;
    var source = pickSource(seg);
    var pub = pick(seg, "pubDate");
    var ts = pub ? Date.parse(pub) : NaN;
    if (source && title.length > source.length + 3 && title.slice(-(source.length + 3)) === " - " + source) {
      title = title.slice(0, -(source.length + 3));
    }
    out.push({ title: title, url: url, source: source, ts: isNaN(ts) ? 0 : ts });
  }
  return out;
}

module.exports = { parseNewsRss: parseNewsRss, decodeEntities: decodeEntities };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/news-parse.test.js`
Expected: PASS — `news-parse: 8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/news.js tests/news-parse.test.js
git commit -m "feat: core/news.js parseNewsRss (Google News RSS parser)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `core/news.js` — `fetchNews` (fetch, tag, dedupe, sort, cap)

**Files:**
- Modify: `core/news.js`
- Test: `tests/news-fetch.test.js`

**Interfaces:**
- Consumes: `parseNewsRss` (Task 1).
- Produces: `fetchNews(interests: string[], opts?) → Promise<Array<{ title, url, source, ts, interest }>>`. `opts`: `{ perInterest=10, limit=40, whenDays=7, concurrency=4, fetchImpl }`. `fetchImpl(url) → Promise<string>` returns the RSS body text; default wraps `guardedfetch.fetchOnceGuarded`. Merges all interests, dedupes by url (then lowercased title), sorts newest-first, caps to `limit`. One feed failing yields no items for that interest but never rejects.

- [ ] **Step 1: Write the failing test**

Create `tests/news-fetch.test.js`:

```javascript
// tests/news-fetch.test.js — fetchNews tags by interest, dedupes, sorts newest-first,
// caps, and survives a single failing feed. Fetch is injected (no real network).
const assert = require("assert");
const { fetchNews } = require("../core/news.js");

let pass = 0, fail = 0;
function t(name, p) { return p.then((c) => { if (c) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }).catch((e) => { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }); }

function feed(items) {
  return "<rss><channel>" + items.map((it) =>
    "<item><title>" + it.t + "</title><link>" + it.u + "</link><pubDate>" + it.d +
    "</pubDate><source url='http://x'>" + it.s + "</source></item>").join("") + "</channel></rss>";
}

(async () => {
  // fetchImpl keyed on the interest embedded in the query string.
  const fetchImpl = async (url) => {
    if (/woodworking/.test(url)) return feed([
      { t: "Lathe news", u: "https://a.com/1", d: "Wed, 08 Jul 2026 12:00:00 GMT", s: "A" },
      { t: "Shared story", u: "https://dup.com/x", d: "Wed, 08 Jul 2026 10:00:00 GMT", s: "A" }]);
    if (/synths/.test(url)) return feed([
      { t: "New synth", u: "https://b.com/2", d: "Wed, 08 Jul 2026 15:00:00 GMT", s: "B" },
      { t: "Shared story", u: "https://dup.com/x", d: "Wed, 08 Jul 2026 10:00:00 GMT", s: "A" }]);
    throw new Error("feed down");   // the "broken" interest
  };

  await t("tags each item with its interest", fetchNews(["woodworking"], { fetchImpl }).then((r) =>
    r.length === 2 && r.every((i) => i.interest === "woodworking")));

  await t("merges interests, dedupes shared url, sorts newest-first", fetchNews(["woodworking", "synths"], { fetchImpl }).then((r) => {
    const urls = r.map((i) => i.url);
    const uniq = new Set(urls).size === urls.length;
    const sorted = r[0].url === "https://b.com/2";   // 15:00 newest
    const dedup = urls.filter((u) => u === "https://dup.com/x").length === 1;
    return uniq && sorted && dedup;
  }));

  await t("a failing feed doesn't break the batch", fetchNews(["broken", "synths"], { fetchImpl }).then((r) =>
    r.length === 2 && r.some((i) => i.url === "https://b.com/2")));

  await t("respects the total limit", fetchNews(["woodworking", "synths"], { fetchImpl, limit: 1 }).then((r) => r.length === 1));

  await t("empty interests → []", fetchNews([], { fetchImpl }).then((r) => r.length === 0));

  console.log("news-fetch: " + pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/news-fetch.test.js`
Expected: FAIL — `fetchNews is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `core/news.js` (before `module.exports`), and add `fetchNews` to the exports:

```javascript
var gf = require("./guardedfetch");

function feedUrl(interest, whenDays) {
  var q = encodeURIComponent(interest + " when:" + whenDays + "d");
  return "https://news.google.com/rss/search?q=" + q + "&hl=en-US&gl=US&ceid=US:en";
}

// Default transport: one guarded GET, body → utf8 string. Fixed host (news.google.com), so
// no SSRF host-check needed; guardedfetch supplies timeout + drain-don't-cancel.
async function defaultFetchImpl(url) {
  var r = await gf.fetchOnceGuarded(url, { ua: gf.UA_LINKCHECK, timeoutMs: 8000, maxBytes: 512 * 1024 });
  if (!r || r.status === 0 || r.error) throw (r && r.error) || new Error("fetch failed");
  return r.buffer ? r.buffer.toString("utf8") : "";
}

// Fetch news for each interest, tag, merge, dedupe (url then lowercased title), sort
// newest-first, cap. One failing feed contributes nothing but never rejects the batch.
async function fetchNews(interests, opts) {
  opts = opts || {};
  var list = (Array.isArray(interests) ? interests : []).map(function (s) { return String(s || "").trim(); }).filter(Boolean);
  if (!list.length) return [];
  var perInterest = opts.perInterest || 10;
  var limit = opts.limit || 40;
  var whenDays = opts.whenDays || 7;
  var concurrency = opts.concurrency || 4;
  var fetchImpl = opts.fetchImpl || defaultFetchImpl;

  var perFeed = await gf.runPool(list, concurrency, async function (interest) {
    try {
      var xml = await fetchImpl(feedUrl(interest, whenDays));
      var items = parseNewsRss(xml).slice(0, perInterest);
      items.forEach(function (it) { it.interest = interest; });
      return items;
    } catch (e) { return []; }   // one feed down ≠ whole batch down
  });

  var merged = [];
  var seenUrl = Object.create(null), seenTitle = Object.create(null);
  perFeed.forEach(function (items) {
    (items || []).forEach(function (it) {
      var uk = String(it.url || "");
      var tk = String(it.title || "").toLowerCase();
      if (!uk || seenUrl[uk] || seenTitle[tk]) return;
      seenUrl[uk] = 1; seenTitle[tk] = 1;
      merged.push(it);
    });
  });
  merged.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  return merged.slice(0, limit);
}
```

Update the exports line to:

```javascript
module.exports = { parseNewsRss: parseNewsRss, decodeEntities: decodeEntities, fetchNews: fetchNews };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/news-fetch.test.js`
Expected: PASS — `news-fetch: 5 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/news.js tests/news-fetch.test.js
git commit -m "feat: core/news.js fetchNews (tag/dedupe/sort/cap, injectable fetch)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `GET /api/news` route

**Files:**
- Modify: `core/server.js` (add `require("./news")` near the other requires ~line 20; add the route alongside the other `app.get`/`app.post` API routes, e.g. after `/api/check-safety` ~line 657)
- Test: `tests/news-route.test.js`

**Interfaces:**
- Consumes: `fetchNews` (Task 2) via a stubbed `global.fetch` (RSS body through `text()`).
- Produces: `GET /api/news?interests=a,b&limit=n` → `{ ok:true, now:<ms>, items:[...] }`. Caps interests to 8 and `limit` to 60. Errors → 500 `{ ok:false, error }` (no stack leak).

- [ ] **Step 1: Write the failing test**

Create `tests/news-route.test.js`:

```javascript
// tests/news-route.test.js — GET /api/news returns {ok,now,items}; caps interest count;
// error path is safe. global.fetch is stubbed to return RSS (no real network).
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");

let pass = 0, fail = 0;
function t(n, fn) { return fn().then(() => { pass++; console.log("  ok  " + n); }).catch((e) => { fail++; console.log("  FAIL " + n + " — " + (e && e.message)); }); }
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-news-")); fs.mkdirSync(path.join(d, "images"), { recursive: true }); return d; }
function listen(app) { return new Promise((r) => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port })); }); }
function get(port, p) { return new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() })); }); r.on("error", reject); r.end(); }); }

(async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    status: 200, url: String(url), headers: { get: () => null },
    text: async () => "<rss><channel><item><title>Hi - Src</title><link>https://n.example/1</link><pubDate>Wed, 08 Jul 2026 12:00:00 GMT</pubDate><source url='http://x'>Src</source></item></channel></rss>"
  });

  const ctx = buildContext(tmp());
  const { s: core, port } = await listen(createServer(ctx));

  await t("returns {ok,now,items}", async () => {
    const r = await get(port, "/api/news?interests=woodworking");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.ok(typeof r.json.now === "number");
    assert.ok(Array.isArray(r.json.items) && r.json.items.length >= 1);
    assert.strictEqual(r.json.items[0].title, "Hi");
  });
  await t("no interests → ok with empty items", async () => {
    const r = await get(port, "/api/news?interests=");
    assert.strictEqual(r.json.ok, true);
    assert.deepStrictEqual(r.json.items, []);
  });
  await t("caps interests at 8", async () => {
    const many = Array.from({ length: 20 }, (_, i) => "t" + i).join(",");
    const r = await get(port, "/api/news?interests=" + many);
    assert.strictEqual(r.json.ok, true);   // must not error on a long list
  });

  await new Promise((r) => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log("news-route: " + pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/news-route.test.js`
Expected: FAIL — the route 404s, so `r.json.ok` is undefined / status 404.

- [ ] **Step 3: Write minimal implementation**

In `core/server.js`, add near the other requires (after `const capturemeta = require("./capturemeta");`):

```javascript
const news = require("./news");
```

Add the route after the `/api/check-safety` handler (~line 657, inside `createServer`, alongside the other routes):

```javascript
  // ---- free interest-matched news for Stumble (Google News RSS via core/news; no key) ----
  app.get("/api/news", async (req, res) => {
    try {
      const raw = String(req.query.interests || "");
      const interests = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 40, 60));
      if (!interests.length) { res.json({ ok: true, now: Date.now(), items: [] }); return; }
      const items = await news.fetchNews(interests, { limit });
      res.json({ ok: true, now: Date.now(), items: items });
    } catch (e) {
      console.error("news failed:", e);
      res.status(500).json({ ok: false, error: "news failed" });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/news-route.test.js`
Expected: PASS — `news-route: 3 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/server.js tests/news-route.test.js
git commit -m "feat: GET /api/news route (interest-matched free news)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `Store.news` + `SE.news` (renderer's Core adapter)

**Files:**
- Modify: `web/storage.js` (add `SE.news` in the `SE` map ~line 42-45; add `Store.news` in the `Store` object, e.g. next to `checkContent` ~line 150)
- Test: `tests/storage-se-news.test.js`

**Interfaces:**
- Produces: `SE.news(interests: string[]) → "/api/news?interests=<encoded csv>"`. `Store.news(interests) → Promise<items[]>` (browser-only; resolves `j.items`).

- [ ] **Step 1: Write the failing test**

Create `tests/storage-se-news.test.js`:

```javascript
// tests/storage-se-news.test.js — SE.news builds the encoded /api/news URL. (Store itself
// only attaches in a browser with fetch; here we require the module purely for SE, which it
// exports via CommonJS: module.exports = { SE }.)
const assert = require("assert");
const { SE } = require("../web/storage.js");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("SE.news exists", SE && typeof SE.news === "function");
ok("joins + encodes interests", SE.news(["woodworking", "modular synths"]) === "/api/news?interests=woodworking%2Cmodular%20synths");
ok("empty list → bare param", SE.news([]) === "/api/news?interests=");

console.log("storage-se-news: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

Note: `web/storage.js` exports `SE` for Node tests via `module.exports = { SE: SE }` (confirmed at the file footer) — so `const { SE } = require("../web/storage.js")` is correct. `Store` is browser-only (attached to `root` only when `fetch` exists) and is intentionally not visible to the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/storage-se-news.test.js`
Expected: FAIL — `SE.news is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `web/storage.js`, add to the `SE` endpoint map (after `,bstumbleFeedback: ...`):

```javascript
    ,news: function (interests) { return "/api/news?interests=" + encodeURIComponent((interests || []).join(",")); }
```

And in the `Store` object (next to `checkContent`):

```javascript
      news: function (interests) { return jget(SE.news(interests)).then(function (j) { return (j && j.items) || []; }); },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/storage-se-news.test.js`
Expected: PASS — `storage-se-news: 3 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add web/storage.js tests/storage-se-news.test.js
git commit -m "feat: Store.news / SE.news adapter for GET /api/news

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Renderer data/fetch layer (news state, batch, intermix, spool routing)

**Files:**
- Modify: `web/index.html`
- Test: `tests/stumble-news-data.test.js`

**Interfaces:**
- Consumes: `Store.news` (Task 4), existing `dropAlreadySaved`, `feedKey`, `domain`, `isFreshDiscoveryItem`, `applyFilter`, `save`, `load`, `interestList`.
- Produces (referenced by Task 6): globals `stNewsOnly` (bool), `filterInterest` (string), `S.newsMix` (bool); functions `interestList()`, `relTime(ts)`, `newsBatch(limit?)`, `interleaveNews(discovery, news)`. `stumbleFetch` routes to news when `stNewsOnly`, and intermixes when `S.newsMix` in discovery. News spool items carry `isNews:true`.

- [ ] **Step 1: Write the failing test**

Create `tests/stumble-news-data.test.js`:

```javascript
// tests/stumble-news-data.test.js — renderer news data layer wired (source asserts).
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("newsMix defaults on", /newsMix:\s*true/.test(src));
ok("stNewsOnly + filterInterest state declared", /let\s+stNewsOnly\s*=\s*false/.test(src) && /filterInterest\s*=\s*""/.test(src));
ok("boot loads persisted news state", /stNewsOnly\s*=\s*await load\("stnewsonly"/.test(src) && /filterInterest\s*=\s*await load\("finterest"/.test(src));
ok("interestList parses S.interests", /function interestList\(\)[\s\S]{0,160}?S\.interests[\s\S]{0,80}?split\(","\)/.test(src));
ok("relTime helper exists", /function relTime\(ts\)/.test(src));
ok("newsBatch calls Store.news + dropAlreadySaved + tags isNews", /function newsBatch\([\s\S]{0,400}?Store\.news\([\s\S]{0,200}?isNews:\s*true[\s\S]{0,120}?dropAlreadySaved/.test(src) || /function newsBatch\([\s\S]{0,600}?Store\.news\([\s\S]{0,400}?dropAlreadySaved[\s\S]{0,200}?isNews:\s*true/.test(src));
ok("stumbleFetch branches on stNewsOnly to newsBatch", /stumbleFetch[\s\S]{0,400}?stNewsOnly\s*\?[\s\S]{0,60}?newsBatch|stNewsOnly\s*\)\s*\{[\s\S]{0,80}?newsBatch/.test(src));
ok("discovery intermixes when S.newsMix", /S\.newsMix[\s\S]{0,120}?interleaveNews/.test(src));
ok("usableSpool keeps news past the discovery TTL", /function usableSpool\(\)[\s\S]{0,200}?isNews[\s\S]{0,80}?isFreshDiscoveryItem/.test(src));
ok("usableSpool skips category filter in news-only mode", /function usableSpool\(\)[\s\S]{0,260}?stNewsOnly\s*\?[\s\S]{0,60}?isNews/.test(src));

console.log("stumble-news-data: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/stumble-news-data.test.js`
Expected: FAIL (several) — the functions/state don't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `web/index.html`:

**(a)** In `DEFAULTS` (after `oprKey:""` / `updateToken:""` lines), add:

```javascript
  newsMix:true,   // blend fresh interest-news into the normal Stumble deck
```

**(b)** Near the Stumble state declarations (where `stDeal=[], stSize=1` are declared, ~line 670), add:

```javascript
let stNewsOnly=false, filterInterest="";   // 📰 News-only mode + active interest ("" = All)
```

**(c)** In `bootData()` where other Stumble state is loaded (near `stSize = await load(...)` / `filterCat` load), add:

```javascript
  stNewsOnly = await load("stnewsonly", false);
  filterInterest = await load("finterest", "");
```

**(d)** Add these helpers near the other Stumble helpers (e.g. just above `stumbleFetch`):

```javascript
// The user's specific interests (comma-separated free text) → the news filter "tags".
function interestList(){
  return (S.interests||"").split(",").map(s=>s.trim()).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i);
}
function relTime(ts){
  const s=Math.max(0,(Date.now()-(+ts||0))/1000);
  if(s<3600) return Math.max(1,Math.floor(s/60))+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
}
// Fetch interest-news (free, no AI/key), shape into Stumble items, filter vs saved/disliked/seen.
async function newsBatch(limit){
  const ints = stNewsOnly ? (filterInterest ? [filterInterest] : interestList()) : interestList();
  if(!ints.length) return [];
  let raw = [];
  try{ raw = await Store.news(ints); }catch(e){ console.warn("news fetch failed:", e); return []; }
  const shaped = (raw||[]).map(n=>{
    const src = String(n.source||domain(n.url)||"news");
    return { id:"nw_"+(feedKey(n.url)||Math.random().toString(36).slice(2)),
      title:String(n.title||""), url:String(n.url||""), source:src,
      category:String(n.interest||""), benefit:"From "+src+" · "+relTime(n.ts),
      image:null, isNews:true, ts:+n.ts||0 };
  }).filter(n=>n.url && n.title);
  let out = dropAlreadySaved(shaped);
  if(limit) out = out.slice(0, limit);
  return out;
}
// Blend news into a discovery list at ~1-in-4 (one news card after every 3 discovery cards).
function interleaveNews(discovery, news){
  if(!news || !news.length) return discovery;
  const out=[]; let ni=0;
  for(let i=0;i<discovery.length;i++){
    out.push(discovery[i]);
    if((i+1)%3===0 && ni<news.length) out.push(news[ni++]);
  }
  while(ni<news.length) out.push(news[ni++]);
  return out;
}
```

**(e)** Replace `stumbleFetch` (currently ~lines 1657-1673) with:

```javascript
async function stumbleFetch(){
  if(stLoading) return 0;
  stLoading = true; renderStumble();
  try{
    let items;
    if(stNewsOnly){
      items = await newsBatch();   // free news path — no AI call, no key required
    } else {
      if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); showTab("settings"); return 0; }
      items = await rankFilter(await validateItems(dropAlreadySaved(parseItems(await callAI(buildPrompt("stumble"),{webSearch:true})))));
      items.forEach(i=>{ i.id="st_"+i.id; shown.push(i.url); });
      if(shown.length>200) shown=shown.slice(-200);
      if(S.newsMix){ items = interleaveNews(items, await newsBatch(3)); }   // ~1-in-4 fresh news
    }
    usableSpool();
    const dealtUrls = new Set(stDeal.map(d=>d && d.url));
    const fresh = items.filter(i=>!spool.some(p=>p.url===i.url) && !dealtUrls.has(i.url));
    spool = spool.concat(fresh);
    persistAll();
    return fresh.length;
  }catch(e){ console.error(e); toast("Hmm: "+e.message, 6000); return 0; }
  finally{ stLoading=false; renderStumble(); }
}
```

**(f)** Replace `usableSpool` (currently ~lines 1676-1680) with:

```javascript
function usableSpool(){
  const now=Date.now();
  // News items are transient and have no AI live-check window — keep them; discovery items
  // still expire after ST_LIVE_TTL. In news-only mode ignore the category filter (news is
  // filtered by interest at fetch time, not by CATS).
  spool=spool.filter(i=> i.isNews || isFreshDiscoveryItem(i,now,ST_LIVE_TTL));
  return stNewsOnly ? spool.filter(i=>i.isNews) : applyFilter(spool);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/syntax-check.js && node tests/stumble-news-data.test.js`
Expected: syntax OK; `stumble-news-data: 10 passed, 0 failed`. (If a regex is stricter than the code, adjust the assertion to match the shipped code — the behavior is what matters.)

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/stumble-news-data.test.js
git commit -m "feat: Stumble news data layer (news-only + intermix routing)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Renderer UI layer (sidebar toggle, handlers, card badge, Settings)

**Files:**
- Modify: `web/index.html`
- Test: `tests/stumble-news-ui.test.js`

**Interfaces:**
- Consumes: Task 5 globals/functions (`stNewsOnly`, `filterInterest`, `interestList`, `newsBatch`, `S.newsMix`), existing `stWrap`, `stCatSideHTML`, `renderCatBar`, `renderStumble`, `stumbleNext`, `save`, `esc`, `stCardHTML`, `renderSettings`.
- Produces: `stNewsSideHTML()`, `toggleNewsOnly()`, `setNewsInterest(k)`; a 📰 News toggle pill in both sidebars; `.news-badge` on news cards; a "Mix fresh news into Stumble" Settings toggle; a news empty-state nudge.

- [ ] **Step 1: Write the failing test**

Create `tests/stumble-news-ui.test.js`:

```javascript
// tests/stumble-news-ui.test.js — Stumble news UI wired (source asserts).
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("News toggle pill in the discovery sidebar", /function stCatSideHTML\(\)[\s\S]{0,400}?toggleNewsOnly\(\)[\s\S]{0,40}?News/.test(src));
ok("stNewsSideHTML lists interests as .tg pills", /function stNewsSideHTML\(\)[\s\S]{0,400}?interestList\(\)[\s\S]{0,160}?setNewsInterest/.test(src));
ok("stWrap dispatches to the news sidebar in news-only mode", /function stWrap\([\s\S]{0,200}?stNewsOnly\s*\?[\s\S]{0,40}?stNewsSideHTML\(\)[\s\S]{0,40}?stCatSideHTML\(\)/.test(src));
ok("toggleNewsOnly flips + persists + refetches", /function toggleNewsOnly\(\)[\s\S]{0,200}?save\("stnewsonly"[\s\S]{0,120}?stumbleNext\(\)/.test(src));
ok("setNewsInterest sets + persists + refetches", /function setNewsInterest\(k\)[\s\S]{0,200}?save\("finterest"[\s\S]{0,120}?stumbleNext\(\)/.test(src));
ok("stCardHTML shows a news badge", /it\.isNews\s*\?[\s\S]{0,80}?news-badge/.test(src));
ok(".news-badge CSS exists", /\.news-badge\{/.test(src));
ok("Settings has a Mix-news toggle wired to S.newsMix", /id="newsMixToggle"/.test(src) && /S\.newsMix\s*=\s*e\.target\.checked/.test(src));
ok("news empty-state nudge when no interests", /stNewsOnly[\s\S]{0,80}?interestList\(\)\.length[\s\S]{0,200}?[Ii]nterests/.test(src));

console.log("stumble-news-ui: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/stumble-news-ui.test.js`
Expected: FAIL (several).

- [ ] **Step 3: Write minimal implementation**

In `web/index.html`:

**(a)** Prepend the News toggle pill to the discovery sidebar. In `stCatSideHTML()`, change the returned aside so the first pill (after the header) is the toggle. Current header line is `<div class="tag-side-h">Categories</div>`; insert the toggle right after it:

```javascript
function stCatSideHTML(){
  const pills = [{key:"",name:"All"}].concat(CATS);
  return `<aside class="tag-side">
    <div class="tag-side-h">Categories</div>
    <span class="tg${stNewsOnly?" on":""}" onclick="toggleNewsOnly()">&#128240; News</span>
    ${pills.map(c=>`<span class="tg${filterCat===c.key?" on":""}" onclick="setFilter('${c.key}')">${esc(c.name)}</span>`).join("")}
  </aside>`;
}
```

**(b)** Add the news-only sidebar right after `stCatSideHTML`:

```javascript
// News-only sidebar: the 📰 toggle (active) + "All" + the user's specific interests as tags.
function stNewsSideHTML(){
  const ints = interestList();
  const pills = `<span class="tg${filterInterest===""?" on":""}" onclick="setNewsInterest('')">All</span>`
    + ints.map(t=>`<span class="tg${filterInterest===t?" on":""}" onclick="setNewsInterest(${JSON.stringify(t)})">${esc(t)}</span>`).join("");
  return `<aside class="tag-side">
    <div class="tag-side-h">News</div>
    <span class="tg on" onclick="toggleNewsOnly()">&#128240; News</span>
    ${pills}
  </aside>`;
}
```

Note: `onclick="setNewsInterest(${JSON.stringify(t)})"` safely quotes/escapes the interest string inside the HTML attribute.

**(c)** Update `stWrap` to dispatch on mode. Change its sidebar expression from `${stCatSideHTML()}` to:

```javascript
function stWrap(inner){
  return stSidebarOn()
    ? `<div class="imp-body">${stNewsOnly?stNewsSideHTML():stCatSideHTML()}<div class="st-main">${inner}</div></div>`
    : inner;
}
```

**(d)** Add the handlers near `setFilter` (or beside the new sidebar functions):

```javascript
function toggleNewsOnly(){
  stNewsOnly = !stNewsOnly; save("stnewsonly", stNewsOnly);
  spool = []; stDeal = [];          // switch content source cleanly
  renderCatBar(); renderStumble();
  stumbleNext();
}
function setNewsInterest(k){
  filterInterest = k; save("finterest", k);
  spool = []; stDeal = [];          // interest changed → refill from the new query
  renderStumble();
  stumbleNext();
}
```

**(e)** Add the news badge to `stCardHTML`. Inside the `.st-body` block, right after the category chip `<span class="chip" ...>...</span>` line, add:

```javascript
        ${it.isNews?`<span class="news-badge">&#128240; News</span>`:""}
```

**(f)** Add the badge CSS near the other stumble card styles (e.g. after `.st-title{...}`):

```css
.news-badge{display:inline-block;margin-left:6px;font-size:10px;font-weight:700;color:#fff;background:#c2410c;border-radius:999px;padding:1px 7px;vertical-align:middle}
```

**(g)** Add the Settings toggle. In the **App updates** section area / near the other Stumble-related toggles in Settings (e.g. beside the "Categories in a left sidebar" toggle), add:

```html
        <label style="display:flex;align-items:center;gap:9px;font-size:14px;cursor:pointer;margin-top:8px">
          <input type="checkbox" id="newsMixToggle" style="width:auto"> Mix fresh news into Stumble
        </label>
        <div class="hint" style="margin:4px 0 0">Blends interest-matched news into your normal Stumble deck (free). Turn off for discovery pages only. The &#128240; News pill in Stumble always gives news-only.</div>
```

And wire it in `renderSettings()` (next to the other toggle wiring like `catSideToggle`):

```javascript
  if(document.getElementById("newsMixToggle")){
    document.getElementById("newsMixToggle").checked = !!S.newsMix;
    document.getElementById("newsMixToggle").onchange = e=>{ S.newsMix = e.target.checked; save("settings", S); toast(S.newsMix?"News will be mixed into Stumble":"News mixing off"); };
  }
```

**(h)** Add the news empty-state nudge in `renderStumble`. At the top of `renderStumble()`, before the existing empty/deal branches, add:

```javascript
  if(stNewsOnly && !interestList().length){
    document.getElementById("view-stumble").innerHTML = stWrap(`<div class="stumble"><div class="empty"><h2>No interests yet</h2><p>Add a few interests in <a href="#" onclick="showTab('settings');return false">Settings</a> (your profile) and News mode will fill with stories matched to them.</p></div></div>`);
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/syntax-check.js && node tests/stumble-news-ui.test.js && node tests/pill-style-parity.test.js`
Expected: syntax OK; `stumble-news-ui: 9 passed, 0 failed`; pill-style-parity still passes (the News pill is additive; `stCatSideHTML` still a `.tag-side` aside; `stWrap` still references `stCatSideHTML`). If pill-style-parity's `stWrap → imp-body + stCatSideHTML` proximity assertion fails due to the added ternary, widen that one regex's gap in `tests/pill-style-parity.test.js` (behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/stumble-news-ui.test.js tests/pill-style-parity.test.js
git commit -m "feat: Stumble News UI (sidebar toggle, interest pills, badge, settings)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Live verification, full suite, version bump & release

**Files:**
- Modify: `package.json` (version bump), `docs/BACKLOG.md` (feature entry)
- Verify: full suite + a throwaway-Core Playwright smoke of the News toggle

**Interfaces:** none (integration/release).

- [ ] **Step 1: Run the full suite**

Run: `node tests/run.js`
Expected: ends with `ALL TEST FILES PASSED` (includes the 6 new test files).

- [ ] **Step 2: Live smoke via the throwaway Core instance (no live data touched)**

The News fetch needs the real Google feed, which the offline test instance won't reach — so verify the **UI wiring** (toggle switches the sidebar to interests, empty-state/nudge, badge markup) rather than live fetch. Boot the instance and drive it:

Run: `PORT=3992 node _loopstate/LOOP-06/boot-test-instance.js` (background), then a short Playwright script (Python, `PYTHONIOENCODING=utf-8`) that loads `http://127.0.0.1:3992/`, `showTab('stumble')`, clicks the "📰 News" sidebar pill, and asserts:
  - the sidebar header switches to "News" and lists interest pills (from the seeded `ia_settings.interests`),
  - `document.querySelector('#view-stumble aside.tag-side')` contains a `.tg.on` News pill,
  - toggling back restores the "Categories" sidebar.
Capture a screenshot to the scratchpad for the report. Kill the instance (`taskkill /F /PID <listener on 3992>`) when done.

Expected: sidebar swaps between Categories and interest pills; no console errors.

- [ ] **Step 3: Version bump + backlog entry**

Bump `package.json` `version` (next patch, e.g. `1.12.19`). Add a `docs/BACKLOG.md` entry at the top summarizing the feature (news source, the two modes, the free/no-AI-cost note, files, tests).

- [ ] **Step 4: Full suite once more, then commit + push**

Run: `node tests/run.js` → `ALL TEST FILES PASSED`.

```bash
git add package.json docs/BACKLOG.md
git commit -m "release: Stumble news integration (intermix + news-only), vX.Y.Z

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin master
```

Verify the remote head advanced (`git ls-remote origin refs/heads/master`), which triggers CI to build the release.

- [ ] **Step 5: Update memory**

Append a concise dated entry to the project memory file and bump the version marker in `MEMORY.md`.

---

## Self-review notes

- **Spec coverage:** free Google News RSS engine (Tasks 1-2) ✓; loopback route (Task 3) ✓; Store adapter (Task 4) ✓; 📰 News sidebar toggle + interest pills (Task 6) ✓; default-on intermix (Tasks 5-6) ✓; reuse card/disliked/seen/save + skip title-mismatch validation (Task 5: news never enters `validateItems`, still passes `dropAlreadySaved`) ✓; no-network tests (Tasks 1-4 inject/stub) ✓; empty-interests + feed-down states (Tasks 5-6) ✓; cost note (no AI in news path) ✓.
- **Type consistency:** news items are `{id,title,url,source,category,benefit,image,isNews,ts}` throughout; `fetchNews` items are `{title,url,source,ts,interest}` (the renderer maps `interest`→`category`); `Store.news(interests)`/`SE.news(interests)` and the route `?interests=` param all agree.
- **Contained risk:** the Google-News-redirect-link caveat is isolated in `core/news.js` (swap to Bing News RSS or resolve final URL if links prove flaky) with no contract change — per the spec's open-implementation note.
