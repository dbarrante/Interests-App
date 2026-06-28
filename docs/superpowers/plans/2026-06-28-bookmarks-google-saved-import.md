# Browser Bookmarks + Google Saved Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two import sources — auto-read Chrome/Edge bookmarks (with a folder picker) and Google Saved Takeout CSVs — both feeding the existing dedup-into-Imported-cards flow.

**Architecture:** Bookmarks: a pure `parseChromeBookmarks` + fs profile-discovery in `core/bookmarks.js`, two read-only Core endpoints, and a folder-picker UI. Google Saved: a pure `parseGoogleSaved` wired into `parseImportText`. Both reach a shared `ingestImported(found)` extracted from `handleImport`.

**Tech Stack:** Node built-in fs + Express (Core service), plain JS renderer, plain-Node `assert` tests via `tests/run.js`.

## Global Constraints

- Repo **private**; **never create/edit/`git add` personal-data files** (the user's real bookmarks/Takeout); tests use **synthetic fixtures only**.
- **Read-only on every import source**; **safe dedup** via the shared `ingestImported` (never lose/overwrite existing cards).
- The bookmark Core endpoints read **ONLY** the fixed `Bookmarks` path for a **validated, discovered** profile — no client-supplied path, no traversal, no other file.
- `core/bookmarks.js` `parseChromeBookmarks` + `web/import-google-saved.js` `parseGoogleSaved` are **require()-able** + unit-tested.
- Tests are plain-Node `assert` via `node tests/run.js` (must end **ALL TEST FILES PASSED**); the inline-`<script>` syntax gate on `web/index.html` must stay green.
- **App change** (Core + renderer) → ships via an installer rebuild. Do **not** modify the capture extension.
- Chrome `date_added` = microseconds since 1601-01-01 UTC → ms via `Math.round(Number(date_added)/1000) - 11644473600000`, kept only if in `(9.46e11, 4.1e12)` (~2000-2100).

---

# Phase A — Browser bookmarks

### Task A1: Pure `parseChromeBookmarks` + tests

**Files:**
- Create: `core/bookmarks.js`
- Test: `tests/bookmarks.test.js`

**Interfaces:**
- Produces: `parseChromeBookmarks(json) -> [{ title, url, ts?, folder }]`. Pure, `module.exports`. Used by A2/A3.

- [ ] **Step 1: Write the failing test** — `tests/bookmarks.test.js`:

```js
const assert = require("assert");
const bm = require("../core/bookmarks");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

// Chrome date_added for 2023-11-14T22:13:20Z ≈ 13346776400000000 µs since 1601.
const TS_2023 = "13346776400000000";
const urlNode = (name, url, da) => ({ type: "url", name: name, url: url, date_added: da });
const folderNode = (name, children) => ({ type: "folder", name: name, children: children });
const TREE = (bar) => ({ roots: { bookmark_bar: { type: "folder", name: "Bookmarks bar", children: bar } } });

test("parses url nodes with title/url/folder and converts date_added", () => {
  const r = bm.parseChromeBookmarks(TREE([ urlNode("Recipe Site", "https://recipes.example.com/x", TS_2023) ]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "Recipe Site");
  assert.strictEqual(r[0].url, "https://recipes.example.com/x");
  assert.strictEqual(r[0].folder, "Bookmarks bar");
  assert.ok(r[0].ts > 9.46e11 && r[0].ts < 4.1e12, "ts in sane ms range");
  assert.ok(Math.abs(r[0].ts - Date.parse("2023-11-14T22:13:20Z")) < 2000, "ts ≈ the right date");
});
test("recurses into folders and builds the nested folder path", () => {
  const r = bm.parseChromeBookmarks(TREE([ folderNode("Recipes", [ urlNode("Bread", "https://b.example.com", TS_2023) ]) ]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].folder, "Bookmarks bar/Recipes");
});
test("skips non-http(s) nodes (chrome://, javascript:, file:)", () => {
  const r = bm.parseChromeBookmarks(TREE([
    urlNode("settings", "chrome://settings", TS_2023),
    urlNode("js", "javascript:void(0)", TS_2023),
    urlNode("file", "file:///c:/x", TS_2023),
    urlNode("ok", "https://ok.example.com", TS_2023),
  ]));
  assert.deepStrictEqual(r.map(i => i.title), ["ok"]);
});
test("omits ts when date_added is absent or out of range", () => {
  const r = bm.parseChromeBookmarks(TREE([ { type: "url", name: "n", url: "https://n.example.com" } ]));
  assert.strictEqual(r.length, 1);
  assert.ok(!("ts" in r[0]) || r[0].ts === undefined);
});
test("includes the 'other' and 'synced' roots", () => {
  const json = { roots: {
    other: { type: "folder", name: "Other bookmarks", children: [ urlNode("o", "https://o.example.com", TS_2023) ] },
    synced: { type: "folder", name: "Mobile bookmarks", children: [ urlNode("m", "https://m.example.com", TS_2023) ] },
  } };
  const r = bm.parseChromeBookmarks(json);
  assert.deepStrictEqual(r.map(i => i.folder).sort(), ["Mobile bookmarks", "Other bookmarks"]);
});
test("returns [] for null / garbage / non-bookmarks object (no throw)", () => {
  [null, undefined, {}, [], 5, "x", { foo: 1 }].forEach(v => assert.deepStrictEqual(bm.parseChromeBookmarks(v), []));
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails** — `node tests/bookmarks.test.js` → cannot find `../core/bookmarks`.

- [ ] **Step 3: Implement** — `core/bookmarks.js` (parser only this task):

```js
// Read Chrome/Edge bookmarks. parseChromeBookmarks is PURE; the fs helpers (A2)
// read ONLY the fixed Bookmarks file for a validated, discovered profile.
"use strict";
const ROOT_LABEL = { bookmark_bar: "Bookmarks bar", other: "Other bookmarks", synced: "Mobile bookmarks" };
const WEBKIT_EPOCH_MS = 11644473600000;  // ms between 1601-01-01 and 1970-01-01

function convertDateAdded(da) {
  if (da == null || da === "") return undefined;
  var ms = Math.round(Number(da) / 1000) - WEBKIT_EPOCH_MS;
  if (!isFinite(ms) || ms <= 9.46e11 || ms >= 4.1e12) return undefined;  // sane ~2000..2100
  return ms;
}
function walk(node, folderPath, out) {
  if (!node || typeof node !== "object") return;
  if (node.type === "url" && typeof node.url === "string" && /^https?:\/\//i.test(node.url)) {
    var item = { title: (typeof node.name === "string" && node.name) || node.url, url: node.url, folder: folderPath };
    var ts = convertDateAdded(node.date_added);
    if (ts !== undefined) item.ts = ts;
    out.push(item);
    return;
  }
  var children = node.children;
  if (Array.isArray(children)) {
    for (var i = 0; i < children.length; i++) walk(children[i], folderPath, out);
  }
}
function parseChromeBookmarks(json) {
  var out = [];
  var roots = json && json.roots;
  if (!roots || typeof roots !== "object") return out;
  for (var key in roots) {
    if (!Object.prototype.hasOwnProperty.call(roots, key)) continue;
    var root = roots[key];
    if (!root || typeof root !== "object") continue;
    var label = ROOT_LABEL[key] || (typeof root.name === "string" ? root.name : key);
    var kids = root.children;
    if (Array.isArray(kids)) for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child && child.type === "folder") walk(child, label + "/" + ((child.name) || "folder"), out);
      else walk(child, label, out);
    }
  }
  return out;
}
module.exports = { parseChromeBookmarks: parseChromeBookmarks };
```

- [ ] **Step 4: Run → pass.** `node tests/bookmarks.test.js` → `6 passed, 0 failed`.
- [ ] **Step 5: Full gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.
- [ ] **Step 6: Commit**

```bash
git add core/bookmarks.js tests/bookmarks.test.js
git commit -m "feat(bookmarks): pure parseChromeBookmarks (folders + date conversion)"
```

---

### Task A2: fs profile discovery + validated read

**Files:**
- Modify: `core/bookmarks.js`
- Test: `tests/bookmarks.test.js` (extend)

**Interfaces:**
- Produces: `listBrowserProfiles(basesOverride?) -> [{browser, profile, name, count}]`; `readProfileBookmarks(browser, profile, basesOverride?) -> [{title,url,ts?,folder}]` (throws `err.code==="BAD_PROFILE"` on invalid/unknown browser/profile). `basesOverride = { chrome: <dir>, edge: <dir> }` for tests.

- [ ] **Step 1: Write the failing test** (append before the final `console.log`):

```js
const os = require("os"), fs = require("fs"), path = require("path");
function seedProfile(base, profileDir, bookmarksObj, displayName) {
  const dir = path.join(base, profileDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Bookmarks"), JSON.stringify(bookmarksObj));
  if (displayName) {
    const ls = { profile: { info_cache: {} } };
    ls.profile.info_cache[profileDir] = { name: displayName };
    fs.writeFileSync(path.join(base, "Local State"), JSON.stringify(ls));
  }
}

test("listBrowserProfiles finds a seeded profile with count + display name", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ia-chrome-"));
  seedProfile(base, "Default", TREE([ urlNode("a", "https://a.example.com", TS_2023) ]), "Dave (work)");
  const list = bm.listBrowserProfiles({ chrome: base, edge: path.join(base, "nope") });
  const me = list.find(p => p.browser === "chrome" && p.profile === "Default");
  assert.ok(me, "Default profile discovered");
  assert.strictEqual(me.name, "Dave (work)");
  assert.strictEqual(me.count, 1);
});
test("readProfileBookmarks returns parsed items for a valid discovered profile", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ia-chrome-"));
  seedProfile(base, "Default", TREE([ urlNode("a", "https://a.example.com", TS_2023) ]));
  const r = bm.readProfileBookmarks("chrome", "Default", { chrome: base, edge: path.join(base, "nope") });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, "https://a.example.com");
});
test("readProfileBookmarks REJECTS a traversal/invalid profile and reads nothing", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ia-chrome-"));
  seedProfile(base, "Default", TREE([]));
  for (const bad of ["../evil", "a/b", "a\\b", "..", ""]) {
    assert.throws(() => bm.readProfileBookmarks("chrome", bad, { chrome: base, edge: base }), /BAD_PROFILE/, "rejects " + JSON.stringify(bad));
  }
  assert.throws(() => bm.readProfileBookmarks("firefox", "Default", { chrome: base, edge: base }), /BAD_PROFILE/);
});
```

- [ ] **Step 2: Run → fail** (`listBrowserProfiles is not a function`).

- [ ] **Step 3: Implement** — add to `core/bookmarks.js` (before `module.exports`, and update the exports):

```js
const fs = require("fs");
const path = require("path");

function defaultBases() {
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  return { chrome: path.join(la, "Google", "Chrome", "User Data"), edge: path.join(la, "Microsoft", "Edge", "User Data") };
}
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
const PROFILE_RE = /^[A-Za-z0-9 ._-]+$/;

function listBrowserProfiles(basesOverride) {
  const bases = basesOverride || defaultBases();
  const out = [];
  ["chrome", "edge"].forEach(function (browser) {
    const base = bases[browser];
    if (!base) return;
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return; }  // missing base -> skip
    const ls = readJsonSafe(path.join(base, "Local State"));
    const nameCache = (ls && ls.profile && ls.profile.info_cache) || {};
    entries.forEach(function (ent) {
      if (!ent.isDirectory()) return;
      const profile = ent.name;
      const bookmarksPath = path.join(base, profile, "Bookmarks");
      let count = 0;
      try {
        if (!fs.statSync(bookmarksPath).isFile()) return;
        count = parseChromeBookmarks(readJsonSafe(bookmarksPath)).length;
      } catch (e) { return; }  // no Bookmarks file in this dir
      const name = (nameCache[profile] && nameCache[profile].name) || profile;
      out.push({ browser: browser, profile: profile, name: name, count: count });
    });
  });
  return out;
}
function badProfile(msg) { const e = new Error(msg || "BAD_PROFILE"); e.code = "BAD_PROFILE"; return e; }
function readProfileBookmarks(browser, profile, basesOverride) {
  if (browser !== "chrome" && browser !== "edge") throw badProfile("BAD_PROFILE: browser");
  if (typeof profile !== "string" || !PROFILE_RE.test(profile)) throw badProfile("BAD_PROFILE: profile");
  const ok = listBrowserProfiles(basesOverride).some(function (p) { return p.browser === browser && p.profile === profile; });
  if (!ok) throw badProfile("BAD_PROFILE: unknown");
  const bases = basesOverride || defaultBases();
  const bookmarksPath = path.join(bases[browser], profile, "Bookmarks");
  return parseChromeBookmarks(readJsonSafe(bookmarksPath));
}
```

Update exports: `module.exports = { parseChromeBookmarks, listBrowserProfiles, readProfileBookmarks };`

- [ ] **Step 4: Run → pass. Step 5: Full gate → green.**
- [ ] **Step 6: Commit**

```bash
git add core/bookmarks.js tests/bookmarks.test.js
git commit -m "feat(bookmarks): validated profile discovery + read (no traversal)"
```

---

### Task A3: Core endpoints + storage.js methods

**Files:**
- Modify: `core/server.js`, `web/storage.js`
- Test: `tests/bookmarks-endpoints.test.js` (create)

**Interfaces:**
- Consumes: `core/bookmarks` (A2).
- Produces: `GET /api/bookmark-sources` → `{sources}`; `GET /api/bookmarks?browser=&profile=` → `{bookmarks}` | 400 | 404. `Store.bookmarkSources()`, `Store.bookmarks(browser, profile)`.

- [ ] **Step 1: Write the failing test** — `tests/bookmarks-endpoints.test.js` (mirrors `tests/sync-endpoints.test.js`):

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function test(n, fn) { return fn().then(() => { passed++; }).catch(e => { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); }); }
function tmpStore() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bmep-")); fs.mkdirSync(path.join(d, "images"), { recursive: true }); return d; }
function listen(app) { return new Promise(r => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port })); }); }
function get(port, p) { return new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() })); }); r.on("error", reject); r.end(); }); }

(async () => {
  const ctx = buildContext(tmpStore());
  const { s, port } = await listen(createServer(ctx));
  await test("GET /api/bookmark-sources returns a sources array", async () => {
    const r = await get(port, "/api/bookmark-sources");
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.sources));
  });
  await test("GET /api/bookmarks with a bogus browser -> 400", async () => {
    const r = await get(port, "/api/bookmarks?browser=bogus&profile=Default");
    assert.strictEqual(r.status, 400);
  });
  s.close(); ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run → fail** (routes 404, not 400).

- [ ] **Step 3: Implement.** In `core/server.js`, add at the top alongside the other requires: `const bookmarks = require("./bookmarks");`. Then inside `createServer(ctx)`, after the `// ---- data location ----` block and before `app.use(express.static(WEB_DIR));`:

```js
  // ---- browser bookmarks (read-only; reads ONLY the fixed Bookmarks file for a
  // validated, discovered Chrome/Edge profile — never a client-supplied path) ----
  app.get("/api/bookmark-sources", (req, res) => {
    try { res.json({ sources: bookmarks.listBrowserProfiles() }); }
    catch (e) { console.error("bookmark-sources failed:", e); res.status(500).json({ error: "failed" }); }
  });
  app.get("/api/bookmarks", (req, res) => {
    const browser = req.query.browser, profile = req.query.profile;
    try {
      res.json({ bookmarks: bookmarks.readProfileBookmarks(browser, profile) });
    } catch (e) {
      if (e && e.code === "BAD_PROFILE") return res.status(400).json({ error: "invalid browser/profile" });
      console.error("bookmarks read failed:", e);
      res.status(404).json({ error: "could not read bookmarks" });
    }
  });
```

In `web/storage.js`, add SE builders (in the `SE` object): `bookmarkSources: function(){ return "/api/bookmark-sources"; }, bookmarks: function(browser, profile){ return "/api/bookmarks?browser=" + encodeURIComponent(browser) + "&profile=" + encodeURIComponent(profile); },` and Store methods (in `Store`): `bookmarkSources: function(){ return jget(SE.bookmarkSources()).then(function(j){ return (j && j.sources) || []; }); }, bookmarks: function(browser, profile){ return jget(SE.bookmarks(browser, profile)).then(function(j){ return (j && j.bookmarks) || []; }); },`.

- [ ] **Step 4: Run the endpoint test → pass. Step 5: Full gate → green** (`node -c web/storage.js` also passes).
- [ ] **Step 6: Commit**

```bash
git add core/server.js web/storage.js tests/bookmarks-endpoints.test.js
git commit -m "feat(bookmarks): /api/bookmark-sources + /api/bookmarks endpoints + Store methods"
```

---

### Task A4: Renderer — shared `ingestImported` + bookmark folder-picker UI

**Files:**
- Modify: `web/index.html`

Verified by the inline-`<script>` syntax gate (`node tests/run.js`) + manual smoke; no headless DOM test.

**Context — current `handleImport` (`web/index.html` ~1776-1824):** it builds `found`/`ids`, resolves YouTube ids, then runs a dedup block (`byTitle`/`byUrl` maps, junk filter, enrich/push, `imported.slice(-10000)`, `Store.putCards`, `writeSavesFile`, `renderImportStatus`, the added/updated toast) and clears the file input.

- [ ] **Step 1: Extract `ingestImported`.** Replace the dedup tail of `handleImport` so it reads:

```js
  if(ids.length){
    toast("Looking up "+Math.min(ids.length,60)+" YouTube video titles…");
    try{ found=found.concat(await resolveYT(ids)); }catch(e){ console.warn(e); }
  }
  ingestImported(found);
  ev.target.value="";
}
// Dedup `found` items into `imported` cards (shared by file-import + bookmark-import).
// Enriches existing (image/desc/url/sdate), appends new, never deletes. Returns {added,updated}.
function ingestImported(found){
  const byTitle = new Map(imported.map((it,i)=>[it.title.toLowerCase(), i]));
  const byUrl = new Map(imported.filter(it=>it.url).map((it,i)=>[it.url, i]));
  const junk = /^(like|comment|share|save|home|menu|profile|settings|see more|watch|reels?|marketplace|groups?|notifications?)$/i;
  let added=0, updated=0;
  const seenThis = new Set();
  found.forEach(i=>{
    if(!i || !i.title) return;
    const k=i.title.toLowerCase();
    if(junk.test(k) || /^https?:\/\//i.test(i.title)) return;
    if(seenThis.has(k)) return;
    seenThis.add(k);
    const existIdx = byTitle.has(k) ? byTitle.get(k) : (i.url && byUrl.has(i.url) ? byUrl.get(i.url) : -1);
    if(existIdx>=0){
      const ex=imported[existIdx]; let changed=false;
      if(i.img && !ex.img){ ex.img=i.img; changed=true; }
      if(i.desc && (!ex.desc || ex.desc.startsWith("Saved from") || ex.desc.startsWith("From your"))){ ex.desc=i.desc; changed=true; }
      if(i.url && !ex.url){ ex.url=i.url; changed=true; }
      const sd=normTs(i.sdate); if(sd && ex.sdate!==sd){ ex.sdate=sd; changed=true; }
      if(changed) updated++;
    } else {
      imported.push(i); added++;
      byTitle.set(k, imported.length-1);
      if(i.url) byUrl.set(i.url, imported.length-1);
    }
  });
  imported = imported.slice(-10000);
  Store.putCards(imported); writeSavesFile(); renderImportStatus();
  const parts=[];
  if(added) parts.push(added+" new items imported");
  if(updated) parts.push(updated+" existing items enriched");
  toast(parts.length ? parts.join(", ") : "No new data found", 5000);
  return {added, updated};
}
```

(This is the existing block verbatim plus a `if(!i || !i.title) return;` guard and the `{added,updated}` return — `handleImport`'s behavior is unchanged.)

- [ ] **Step 2: Add the button.** In the Import-your-saves section (next to the `#impFile` input, `web/index.html` ~406), add:

```html
        <div style="margin-top:10px"><button class="btn btn-ghost" onclick="importBookmarks()">&#128209; Import browser bookmarks</button>
          <span class="hint" id="bmStatus" style="margin-left:8px"></span></div>
```

- [ ] **Step 3: Add the handlers** (near `handleImport`):

```js
// Auto-import Chrome/Edge bookmarks: pick a profile, then tick folders.
async function importBookmarks(){
  let sources=[];
  try{ sources=await Store.bookmarkSources(); }catch(e){ toast("Couldn't reach the app service"); return; }
  if(!sources.length){ toast("No Chrome/Edge bookmarks found on this machine", 5000); return; }
  const rows = sources.map((s,i)=>`<button class="btn btn-ghost" style="display:block;width:100%;text-align:left;margin:4px 0" onclick="_bmPick(${i})">${esc(s.browser==="edge"?"Edge":"Chrome")} &middot; ${esc(s.name)} <span class="hint">(${s.count} bookmarks)</span></button>`).join("");
  window._bmSources = sources;
  document.getElementById("modalBody").innerHTML = `<h2>Import browser bookmarks</h2><div class="hint" style="margin-bottom:10px">Pick a browser profile:</div>${rows}`;
  document.getElementById("modal").classList.add("open");
}
async function _bmPick(idx){
  const s = window._bmSources[idx];
  document.getElementById("modalBody").innerHTML = `<h2>${esc(s.name)}</h2><div class="hint">Loading bookmarks…</div>`;
  let bms=[];
  try{ bms=await Store.bookmarks(s.browser, s.profile); }catch(e){ document.getElementById("modalBody").innerHTML="<h2>Couldn't read bookmarks</h2>"; return; }
  window._bmAll = bms;
  const counts={}; bms.forEach(b=>{ counts[b.folder]=(counts[b.folder]||0)+1; });
  const folders = Object.keys(counts).sort();
  const rows = folders.map(f=>`<label style="display:block;margin:3px 0"><input type="checkbox" class="_bmf" value="${esc(f)}" checked style="width:auto"> ${esc(f)} <span class="hint">(${counts[f]})</span></label>`).join("") || "<div class='hint'>No bookmarks in this profile.</div>";
  document.getElementById("modalBody").innerHTML = `<h2>${esc(s.name)} — pick folders</h2><div style="max-height:340px;overflow:auto;margin:8px 0">${rows}</div>
    <button class="btn btn-primary" onclick="_bmImport()">Import selected folders</button>`;
}
function _bmImport(){
  const picked = new Set([...document.querySelectorAll("._bmf:checked")].map(c=>c.value));
  // Run each bookmark through clean() (exactly like file imports) so ts->sdate,
  // ts=now, and title-slicing are consistent; then tag the source.
  const found = (window._bmAll||[]).filter(b=>picked.has(b.folder)).map(b=>
    Object.assign(clean({ title: b.title, url: b.url, ts: b.ts, desc: "Bookmark · " + (b.folder||"") }), { src: "bookmark" })
  );
  document.getElementById("modal").classList.remove("open");
  if(!found.length){ toast("No folders selected"); return; }
  ingestImported(found);
  const el=document.getElementById("bmStatus"); if(el) el.textContent = "Imported "+found.length+" bookmark(s).";
}
```

(Uses the existing `#modal`/`#modalBody`/`esc()`/`btn` classes and the existing `clean()` — so a bookmark's `date_added` (passed as `ts`) becomes the card's `sdate`, and the item shape matches every other import.)

- [ ] **Step 4: `srcHint`** — add `if(/bookmark/.test(name)) return "bookmark";` (harmless; the auto-read path sets `src:"bookmark"` directly).

- [ ] **Step 5: Gate** — `node tests/run.js` → `ALL TEST FILES PASSED` (syntax-check parses the new inline JS).

- [ ] **Step 6: Commit**

```bash
git add web/index.html
git commit -m "feat(bookmarks): shared ingestImported + browser-bookmark folder-picker UI"
```

- [ ] **Step 7: Manual smoke (record; not automated):** after rebuild+reinstall — the button lists your Chrome/Edge profiles with counts; picking one shows folders with counts (all checked); importing a folder adds its bookmarks to the Imported tab with `Bookmark · <folder>` descriptions; re-importing the same folder does not duplicate; unchecking a folder excludes it.

---

# Phase B — Google Saved

### Task B1: Pure `parseGoogleSaved` + tests

**Files:**
- Create: `web/import-google-saved.js`
- Test: `tests/import-google-saved.test.js`

**Interfaces:**
- Produces: `parseGoogleSaved(text) -> [{title, url, desc}]` (require()-able; `[]` for non-Google-Saved CSV incl. YouTube exports). Used by B2.

- [ ] **Step 1: Write the failing test** — `tests/import-google-saved.test.js`:

```js
const assert = require("assert");
const { parseGoogleSaved } = require("../web/import-google-saved");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

test("parses a Title,Note,URL Google Saved CSV with Note -> desc", () => {
  const csv = "Title,Note,URL\nGreat Recipe,Try this weekend,https://r.example.com/x\n";
  const r = parseGoogleSaved(csv);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "Great Recipe");
  assert.strictEqual(r[0].url, "https://r.example.com/x");
  assert.strictEqual(r[0].desc, "Try this weekend");
});
test("a YouTube subscriptions header (Channel*) -> [] (so parseCSV handles it)", () => {
  const csv = "Channel Id,Channel Url,Channel Title\nUC123,https://youtube.com/c/x,Some Channel\n";
  assert.deepStrictEqual(parseGoogleSaved(csv), []);
});
test("a quoted field containing a comma is parsed correctly", () => {
  const csv = 'Title,Note,URL\n"Cookies, Cakes & Pies","best, ever",https://b.example.com\n';
  const r = parseGoogleSaved(csv);
  assert.strictEqual(r[0].title, "Cookies, Cakes & Pies");
  assert.strictEqual(r[0].desc, "best, ever");
});
test("skips rows with no http url; empty/garbage -> []", () => {
  assert.deepStrictEqual(parseGoogleSaved("Title,URL\nNo Link,not-a-url\n"), []);
  ["", "no commas here", "\n\n", null, undefined].forEach(v => assert.deepStrictEqual(parseGoogleSaved(v), []));
});
test("works with no Note column (desc empty)", () => {
  const r = parseGoogleSaved("Title,URL\nThing,https://t.example.com\n");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].desc, "");
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run → fail** (module missing).

- [ ] **Step 3: Implement** — `web/import-google-saved.js`:

```js
// Parse a Google Takeout "Saved" CSV (Title/Note/URL) into import items. Pure,
// dual browser/Node like web/route-capture.js. Returns [] for anything that isn't
// a Google-Saved CSV (incl. YouTube Takeout CSVs, which have Channel*/Video Id cols).
(function (root) {
  "use strict";
  function splitCsvLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } continue; }
      if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function parseGoogleSaved(text) {
    var out = [];
    if (typeof text !== "string" || text.indexOf(",") < 0) return out;
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return out;
    var head = splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase(); });
    if (head.some(function (h) { return h.indexOf("video id") >= 0 || h.indexOf("channel") >= 0; })) return out;  // YouTube -> let parseCSV handle
    function findIdx(pred) { for (var i = 0; i < head.length; i++) if (pred(head[i])) return i; return -1; }
    var titleIdx = findIdx(function (h) { return h === "title" || (h.indexOf("title") >= 0); });
    var urlIdx = findIdx(function (h) { return h === "url" || (h.indexOf("url") >= 0); });
    var noteIdx = findIdx(function (h) { return h.indexOf("note") >= 0; });
    if (titleIdx < 0 || urlIdx < 0) return out;
    for (var r = 1; r < lines.length; r++) {
      var cols = splitCsvLine(lines[r]);
      var title = cols[titleIdx] || "", url = cols[urlIdx] || "";
      if (!title || !/^https?:\/\//i.test(url)) continue;
      out.push({ title: title, url: url, desc: (noteIdx >= 0 ? (cols[noteIdx] || "") : "") });
    }
    return out;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { parseGoogleSaved: parseGoogleSaved };
  if (root) root.parseGoogleSaved = parseGoogleSaved;
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run → pass (5 passed). Step 5: Full gate → green.**
- [ ] **Step 6: Commit**

```bash
git add web/import-google-saved.js tests/import-google-saved.test.js
git commit -m "feat(import): pure parseGoogleSaved for Google Takeout Saved CSV (+ tests)"
```

---

### Task B2: Wire Google Saved into the pipeline

**Files:**
- Modify: `web/index.html`

Verified by the syntax gate + manual smoke.

- [ ] **Step 1: Load the script.** Next to `<script src="import-instagram.js"></script>`, add `<script src="import-google-saved.js"></script>`.

- [ ] **Step 2: Wire into `parseImportText`'s CSV branch.** Current:

```js
  if(/\.csv$/i.test(name||"")) {
    const r=parseCSV(text);
    return {items:r.items.map(clean), ids:r.ids};
  }
```

Change to try Google Saved first:

```js
  if(/\.csv$/i.test(name||"")) {
    const g=(typeof parseGoogleSaved==="function") ? parseGoogleSaved(text) : [];
    if(g.length) return {items: g.map(i=>Object.assign(clean(i),{src:"google"})), ids:[]};
    const r=parseCSV(text);
    return {items:r.items.map(clean), ids:r.ids};
  }
```

- [ ] **Step 3: Fix `parseZip`'s source clobber** (`web/index.html` ~1771). Current `if(h) r.items.forEach(i=>i.src=h);` → only set when not already content-detected:

```js
      if(h) r.items.forEach(i=>{ if(!i.src) i.src=h; });
```

- [ ] **Step 4: `srcHint`** — after the existing `instagram` line and before the `youtube` line, add a Google-Saved fallback that won't collide:

```js
  if(/\bsaved\b/.test(name) && !/instagram|youtube|facebook|pinterest/.test(name)) return "google";
```

- [ ] **Step 5: GUIDES + pill + heading.** Add to the `GUIDES` object (after the `youtube` entry):

```js
  ,google: `<h2>Export your Google Saved</h2><ol>
    <li>Go to <b>takeout.google.com</b> and sign in</li>
    <li><b>Deselect all</b>, then check only <b>Saved</b></li>
    <li><b>Next step</b> &rarr; Export once &rarr; <b>Create export</b></li>
    <li>Download the ZIP (emailed link, expires in ~7 days) and drop it here — or unzip and drop the <b>Saved/*.csv</b> files</li></ol>
    <p>Each saved link's title, note, and URL become a taste signal. (Google Bookmarks is retired; this is google.com/save.)</p>`
```

Add the pill in the "How to export:" row (after the Facebook/Instagram/Pinterest/YouTube pills): `<button class="catpill" onclick="showGuide('google')">Google</button>`. Update the section heading to `Import your saves (Facebook · Instagram · Pinterest · YouTube · Google)`.

- [ ] **Step 6: Gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.
- [ ] **Step 7: Commit**

```bash
git add web/index.html
git commit -m "feat(import): wire Google Saved CSV into the pipeline + guide/pill; conditional zip src tag"
```

- [ ] **Step 8: Manual smoke (record):** drop a Google Takeout **Saved** CSV (or the Takeout ZIP) → Imported count rises; cards show the **Title**, the **URL**, and the **Note** as description; the Imported source filter shows **Google**; a YouTube Takeout export still imports as before (channels/videos), not mis-parsed.

---

# Final review

After all 6 tasks: a final whole-branch code review, then the **data-safety-reviewer** (import/library writes via `ingestImported`) and the **electron-security-reviewer** (the new Core endpoints reading browser-profile files — confirm: only the fixed `Bookmarks` path, validated/discovered profile, no traversal, loopback+origin-guarded). Then verify `node tests/run.js` is green and rebuild the installer; the build is on master (committed per-task) so summarize — do **not** offer merge/PR.

---

## Self-Review (plan vs spec)

**Spec coverage:** pure `parseChromeBookmarks` + folders + date conversion (A1) ✓; validated profile discovery/read, no traversal (A2) ✓; two read-only Core endpoints + Store methods (A3) ✓; folder-picker UI + shared `ingestImported` (A4) ✓; pure `parseGoogleSaved`, YouTube-CSV exclusion (B1) ✓; CSV-branch wiring + `parseZip` src-clobber fix + srcHint + guide/pill/heading (B2) ✓; read-only sources + safe dedup + synthetic fixtures + security review ✓; app change → rebuild ✓.

**Placeholder scan:** none — complete code throughout. (A4 Step 3 includes the explicit `sdate: b.ts` correction so the bookmark date maps to the field `ingestImported` reads.)

**Type consistency:** `parseChromeBookmarks(json)->[{title,url,ts?,folder}]` (A1) consumed by `listBrowserProfiles`/`readProfileBookmarks` (A2), exposed via `/api/bookmarks` (A3) and `Store.bookmarks` → `_bmAll` items mapped to `{title,url,sdate,src,desc}` for `ingestImported` (A4); `parseGoogleSaved(text)->[{title,url,desc}]` (B1) called in `parseImportText` (B2) and run through `clean()` (which reads title/url/desc). `BAD_PROFILE` error code (A2) → 400 mapping (A3) matches.
