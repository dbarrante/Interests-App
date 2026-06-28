# Instagram Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user import their Instagram "Download your information" saved posts into the Imported tab as taste-signal cards, via the existing import pipeline.

**Architecture:** A small pure `parseInstagramSaved(json)` module (require()-able like `web/route-capture.js`) slotted into the existing `parseImportText` in `web/index.html`, before the generic harvester. The ZIP unpacking, dedup, Imported-tab, and capture-enrichment machinery are all reused unchanged.

**Tech Stack:** Plain JS in the Electron renderer (`web/`); tests are plain-Node `assert` via `tests/run.js`.

## Global Constraints

- Repo stays **private**; **never create/edit/`git add` personal-data files** — the user's real Instagram export especially. Tests use **synthetic fixtures only**.
- **Read-only on the import source**; **safe dedup** into the library (the existing `handleImport` dedup enriches + appends, never deletes/overwrites).
- `web/import-instagram.js` must be **require()-able** (browser global + `module.exports`, the `web/route-capture.js` idiom).
- Tests are plain-Node `assert` via `node tests/run.js` (must end **ALL TEST FILES PASSED**); the inline-`<script>` syntax gate (`tests/syntax-check.js`) on `web/index.html` must stay green.
- **App/renderer change** (NOT the extension) → ships via an installer rebuild + reinstall. Do **not** modify the capture extension, `core/`, or `main.js`.
- Instagram timestamps are Unix **seconds**; the downstream `clean()`→`normTs()` converts seconds→ms, so the parser passes the raw `timestamp` through untouched.

---

### Task 1: Pure `parseInstagramSaved` parser + unit tests

**Files:**
- Create: `web/import-instagram.js`
- Test: `tests/import-instagram.test.js`

**Interfaces:**
- Produces: `parseInstagramSaved(json) -> [{ title, url, ts }]`. Returns `[]` for any non-saved shape (liked, null, garbage). Attached to the global (`root.parseInstagramSaved`) in the browser and `module.exports` in Node. Task 2 calls `parseInstagramSaved(p)` from `parseImportText`.

- [ ] **Step 1: Write the failing test** — create `tests/import-instagram.test.js`:

```js
const assert = require("assert");
const { parseInstagramSaved } = require("../web/import-instagram");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

const SAVED = (entries) => ({ saved_saved_media: entries });
const entry = (username, href, ts, key) => ({ title: username, string_map_data: { [key || "Saved on"]: { href: href, timestamp: ts } } });

test("parses a saved entry -> title/url/ts", () => {
  const r = parseInstagramSaved(SAVED([entry("natgeo", "https://www.instagram.com/p/ABC123/", 1700000000)]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "natgeo");
  assert.strictEqual(r[0].url, "https://www.instagram.com/p/ABC123/");
  assert.strictEqual(r[0].ts, 1700000000);
});
test("multiple entries; one without an instagram href is skipped", () => {
  const r = parseInstagramSaved(SAVED([
    entry("a", "https://www.instagram.com/p/A/", 1),
    entry("b", "https://example.com/x", 2),            // not instagram -> skip
    entry("c", "https://instagram.com/p/C/", 3),
  ]));
  assert.deepStrictEqual(r.map(i => i.title), ["a", "c"]);
});
test("a likes_media_likes object is NOT parsed -> []", () => {
  assert.deepStrictEqual(parseInstagramSaved({ likes_media_likes: [entry("x", "https://instagram.com/p/X/", 1)] }), []);
});
test("null / undefined / {} / [] / non-IG values -> [] (no throw)", () => {
  [null, undefined, {}, [], 5, "x", { foo: 1 }].forEach(v => assert.deepStrictEqual(parseInstagramSaved(v), []));
});
test("a localized string_map_data key with an href is still parsed", () => {
  const r = parseInstagramSaved(SAVED([entry("user", "https://www.instagram.com/p/L/", 9, "Enregistré le")]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, "https://www.instagram.com/p/L/");
});
test("a unicode-escaped username passes through without crashing", () => {
  const r = parseInstagramSaved(SAVED([entry("café_lover", "https://www.instagram.com/p/U/", 7)]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "café_lover");
});
test("an entry missing string_map_data (or null) is skipped, not fatal", () => {
  const r = parseInstagramSaved(SAVED([{ title: "x" }, null, entry("ok", "https://instagram.com/p/O/", 1)]));
  assert.deepStrictEqual(r.map(i => i.title), ["ok"]);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node tests/import-instagram.test.js`
Expected: FAIL — cannot find module `../web/import-instagram`.

- [ ] **Step 3: Implement** — create `web/import-instagram.js`:

```js
// Parse an Instagram "Download your information" SAVED-posts export into import items.
// Pure (no DOM/I/O), dual browser/Node like web/route-capture.js. Returns [] for any
// non-saved shape (liked, null, garbage) so it's safe to try on every JSON file.
(function (root) {
  "use strict";
  function parseInstagramSaved(json) {
    var out = [];
    var arr = json && json.saved_saved_media;
    if (!Array.isArray(arr)) return out;
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e || typeof e !== "object") continue;
      var smap = e.string_map_data || {};
      // Prefer the "Saved on" key; IG localizes it, so fall back to the first
      // string_map_data value that carries an href.
      var node = smap["Saved on"];
      if (!node || !node.href) {
        node = null;
        for (var k in smap) { if (Object.prototype.hasOwnProperty.call(smap, k) && smap[k] && smap[k].href) { node = smap[k]; break; } }
      }
      var href = node && node.href;
      if (typeof href !== "string" || !/instagram\.com/i.test(href)) continue;
      var item = { title: (typeof e.title === "string" && e.title) ? e.title : "Instagram post", url: href };
      var ts = node && node.timestamp;            // Unix seconds; normalized downstream by clean()/normTs()
      if (ts != null) item.ts = ts;
      out.push(item);
    }
    return out;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { parseInstagramSaved: parseInstagramSaved };
  if (root) root.parseInstagramSaved = parseInstagramSaved;
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node tests/import-instagram.test.js`
Expected: `7 passed, 0 failed`.

- [ ] **Step 5: Run the full gate**

Run: `node tests/run.js`
Expected: ends `ALL TEST FILES PASSED`.

- [ ] **Step 6: Commit**

```bash
git add web/import-instagram.js tests/import-instagram.test.js
git commit -m "feat(import): pure parseInstagramSaved for Instagram saved-posts export (+ unit tests)"
```

---

### Task 2: Wire Instagram into the import pipeline (`web/index.html`)

**Files:**
- Modify: `web/index.html` (load the script at line ~303; `parseImportText` JSON branch ~1706-1712; `srcHint` ~2090-2096; Settings label ~399)

**Interfaces:**
- Consumes: `parseInstagramSaved` (Task 1), available as a global once the script loads.

Verified by the inline-`<script>` syntax gate (`node tests/run.js`) + a manual smoke; there is no headless DOM test for the renderer wiring (consistent with how FB/Pinterest import wiring is verified).

- [ ] **Step 1: Load the parser script.** In `web/index.html`, the current loads are:

```html
<script src="storage.js"></script>
<script src="route-capture.js"></script>
```

Add `import-instagram.js` right after `route-capture.js`:

```html
<script src="storage.js"></script>
<script src="route-capture.js"></script>
<script src="import-instagram.js"></script>
```

- [ ] **Step 2: Call the parser in `parseImportText`.** The current JSON branch is:

```js
  if(t.startsWith("{")||t.startsWith("[")){
    try{
      const p=JSON.parse(t);
      const fb=parseFacebookJSON(p);
      if(fb.length) return {items: fb.map(i=>Object.assign(clean(i),{src:"facebook"})), ids:[]};
      harvest(p, out);
    }catch(e){}
  } else if(/<html|<!doctype|<a[ >]/i.test(t)){
```

Insert the Instagram attempt after the Facebook one and before `harvest`:

```js
  if(t.startsWith("{")||t.startsWith("[")){
    try{
      const p=JSON.parse(t);
      const fb=parseFacebookJSON(p);
      if(fb.length) return {items: fb.map(i=>Object.assign(clean(i),{src:"facebook"})), ids:[]};
      const ig=(typeof parseInstagramSaved==="function") ? parseInstagramSaved(p) : [];
      if(ig.length) return {items: ig.map(i=>Object.assign(clean(i),{src:"instagram"})), ids:[]};
      harvest(p, out);
    }catch(e){}
  } else if(/<html|<!doctype|<a[ >]/i.test(t)){
```

- [ ] **Step 3: Tag Instagram in `srcHint`.** The current function is:

```js
function srcHint(name){
  name=(name||"").toLowerCase();
  if(/youtube|takeout|watch-history|subscription|liked/.test(name)) return "youtube";
  if(/pinterest|\bpins?\b|board/.test(name)) return "pinterest";
  if(/facebook|saved_items|saves|fb/.test(name)) return "facebook";
  return null;
}
```

Add an Instagram check FIRST (so an `instagram`/`saved_posts` path isn't mis-tagged by a later rule):

```js
function srcHint(name){
  name=(name||"").toLowerCase();
  if(/instagram|saved_posts/.test(name)) return "instagram";
  if(/youtube|takeout|watch-history|subscription|liked/.test(name)) return "youtube";
  if(/pinterest|\bpins?\b|board/.test(name)) return "pinterest";
  if(/facebook|saved_items|saves|fb/.test(name)) return "facebook";
  return null;
}
```

- [ ] **Step 4: Update the Settings section copy.** The current heading (web/index.html ~399) reads `Import your saves (Facebook · Pinterest · YouTube)`. Change the platform list to include Instagram:

```html
<h3>Import your saves (Facebook · Instagram · Pinterest · YouTube)</h3>
```

(If a nearby `.hint` line also enumerates the platforms, update it the same way; copy only — no logic.)

- [ ] **Step 5: Run the gate**

Run: `node tests/run.js`
Expected: ends `ALL TEST FILES PASSED` — the `syntax-check.js` step parses the inline `<script>` in `web/index.html`; a stray brace would fail it.

- [ ] **Step 6: Commit**

```bash
git add web/index.html
git commit -m "feat(import): wire Instagram saved-posts into the import pipeline + Settings copy"
```

- [ ] **Step 7: Manual smoke (record results; not automated)**

After the next installer rebuild + reinstall, in Settings → "Import your saves": drop a synthetic `saved_posts.json` (a `{ "saved_saved_media": [ { "title": "natgeo", "string_map_data": { "Saved on": { "href": "https://www.instagram.com/p/ABC/", "timestamp": 1700000000 } } } ] }`) — or the real export ZIP. Verify: the Imported count rises; the new card's title is the **account name**, its URL is the `/p/<code>` link, and its saved-date reflects the export timestamp; the Imported-tab **source filter shows Instagram**; dropping the same file twice does **not** duplicate (dedup by url/title).

---

## Self-Review (plan vs spec)

**Spec coverage:** saved-posts-only parser (Task 1, `saved_saved_media` gate; `likes_media_likes` test → `[]`) ✓; Imported-cards-not-Saved-clips (Task 2 routes through `parseImportText`/`handleImport` → `imported`, unchanged) ✓; pure require()-able module (Task 1, dual wrapper) ✓; wiring before harvest (Task 2 Step 2) ✓; `srcHint` instagram (Step 3) ✓; section copy (Step 4) ✓; localized "Saved on" key fallback (parser + test 5) ✓; unicode username (test 6) ✓; read-only on source + safe dedup (reuses `handleImport`, untouched) ✓; synthetic fixtures only ✓; timestamp seconds→ms via downstream `clean()`/`normTs()` (noted, parser passes raw) ✓; syntax gate stays green (Step 5) ✓.

**Placeholder scan:** none — all code complete.

**Type consistency:** `parseInstagramSaved(json) -> [{title,url,ts}]` defined in Task 1 is called as `parseInstagramSaved(p)` in Task 2 Step 2; the items are passed to the existing `clean()` (which reads `title`/`url`/`ts`/`img`/`desc`) → consistent with the FB/Pinterest items' shape; `src:"instagram"` matches the `srcHint` value and the existing source-filter convention.
