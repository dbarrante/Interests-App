# AI batch retag/retitle + hashtag-to-tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, resumable "process the next 200 stale cards" AI retag/retitle tool to Library Health, and make every AI-generated title convert any embedded `#hashtag` into a tag.

**Architecture:** Pure hashtag-extraction logic lives in the existing dual browser/Node `title-ai.js` module (mirrored in `web/` and `pwa/`); everything else is new/refactored functions inside the two `index.html` files (also mirrored). A new per-card `aiRefreshedAt` timestamp (same shape as the existing `.lc.at`/`.sb.at` freshness fields) drives a stale-first candidate query with no separate cursor — the batch button just re-runs the query each click. Retagging reuses a new shared `aiTagChunk()` core factored out of the existing `autoTag()`; retitling reuses `generateUniqueTitle()` unchanged.

**Tech Stack:** Vanilla JS, no build step. Tests are plain Node `assert` scripts run via `node tests/run.js`, using the project's `tests/_extract.js` `extractFn()` helper to pull real functions out of the HTML files and run them in a `new Function(...)` sandbox with minimal hand-built stubs (no jsdom dependency anywhere in this repo).

## Global Constraints

- Every function touched or added in `web/index.html` must be applied **byte-identically** to the matching function in `pwa/index.html` — this is a manual discipline in this codebase (not fully automated for `index.html`; `tests/surface-parity.test.js` only checks that certain named functions exist in both files, via the `indexContracts` list in `tests/surface-parity-manifest.js`). Task 9 adds every new top-level function name introduced by this plan to that list, and every task's steps include a diff-based verification that the web/pwa bodies match exactly.
- `web/title-ai.js` and `pwa/title-ai.js` are already a **required exact byte-pair** in `tests/surface-parity-manifest.js`'s `exactPairs` — any change to one must be copied verbatim to the other, or `node tests/run.js` fails on `surface-parity.test.js`.
- No new dependencies, no build step. Every new test file is a plain Node script (`const assert = require("assert")`) following the existing `t(name, fn)` runner pattern used throughout `tests/`.
- `imported` cards store category in `.cat`, `saved` cards in `.category`; `imported` cards store description in `.desc`, `saved` cards in `.benefit`. Any new code that reads/writes category or description on a card from a mixed `imported.concat(saved)` list must handle both field names (this project has shipped real bugs from missing this twice this session — see `docs/superpowers/specs/2026-08-02-ai-batch-refresh-design.md`).
- Tags are always **merged**, never replacing existing tags, everywhere this plan writes tags (hashtag extraction, batch retag).
- Titles are always capped at 250 characters on write (`.slice(0,250)`), matching every existing title-write site in this file.
- Run `node tests/run.js` after every task's own test file passes in isolation — it runs the syntax gate plus every `*.test.js` file and must stay green (mind the known flake documented in this session's memory: an occasional `SOME TEST FILES FAILED` with no locatable `FAIL` line anywhere in the output is a known, unattributed test-runner flake — re-run once before treating it as a real regression).

---

### Task 1: `extractHashtags` pure helper in `title-ai.js`

**Files:**
- Modify: `web/title-ai.js`, `pwa/title-ai.js` (identical edit, both copies)
- Test: `tests/title-ai.test.js` (append to the existing file)

**Interfaces:**
- Produces: `extractHashtags(rawTitle) -> { title: string, tags: string[] }` — pulls every `#word` token (word = `\w+`, i.e. letters/digits/underscore) out of `rawTitle`, returns the title with those tokens removed (and any resulting run of 2+ spaces collapsed to one, then trimmed) plus the lowercased, deduped list of tokens (no cleaning/canonicalization — that's the caller's job in Task 2, since it needs `index.html`'s `canonicalTag`/`tagBadPattern`, which this module cannot depend on). Exported the same way the file's four existing functions are: added to the `api` object passed to `module.exports`, and assigned onto `root` for browser use.

- [ ] **Step 1: Write the failing tests**

Append to the end of `tests/title-ai.test.js`, before the final `console.log(...)`/`process.exitCode` lines (so they still run as part of the same file):

```js
// ---- extractHashtags ----
t("extractHashtags: no hashtags -> title unchanged, no tags", () => {
  const r = t2.extractHashtags("A Guide to Backyard Pizza Ovens");
  assert.strictEqual(r.title, "A Guide to Backyard Pizza Ovens");
  assert.deepStrictEqual(r.tags, []);
});
t("extractHashtags: strips multiple hashtags and collapses the resulting gaps", () => {
  const r = t2.extractHashtags("Backyard Pizza Oven #diy #pizza Build");
  assert.strictEqual(r.title, "Backyard Pizza Oven Build");
  assert.deepStrictEqual(r.tags, ["diy", "pizza"]);
});
t("extractHashtags: lowercases and dedupes tags (case-insensitive)", () => {
  const r = t2.extractHashtags("#DIY project #diy again #Diy");
  assert.deepStrictEqual(r.tags, ["diy"]);
});
t("extractHashtags: a hashtag-only title collapses to an empty string (caller decides the fallback)", () => {
  const r = t2.extractHashtags("#diy #pizza");
  assert.strictEqual(r.title, "");
  assert.deepStrictEqual(r.tags, ["diy", "pizza"]);
});
t("extractHashtags: a lone '#' with no word characters after it is not a tag", () => {
  const r = t2.extractHashtags("Price is # 1 today");
  assert.strictEqual(r.title, "Price is # 1 today");
  assert.deepStrictEqual(r.tags, []);
});
t("extractHashtags: null/undefined/empty input -> empty title, no tags, no throw", () => {
  assert.deepStrictEqual(t2.extractHashtags(null), { title: "", tags: [] });
  assert.deepStrictEqual(t2.extractHashtags(undefined), { title: "", tags: [] });
  assert.deepStrictEqual(t2.extractHashtags(""), { title: "", tags: [] });
});
t("extractHashtags: drops a token longer than 40 characters (defensive cap, matches aiSuggestTags' own tag length cap)", () => {
  const longTag = "#" + "a".repeat(41);
  const r = t2.extractHashtags("Title " + longTag + " end");
  assert.deepStrictEqual(r.tags, []);
  assert.strictEqual(r.title, "Title end");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/title-ai.test.js`
Expected: FAIL — `t2.extractHashtags is not a function` (or similar) on every new assertion.

- [ ] **Step 3: Implement `extractHashtags` in `web/title-ai.js`**

Add this function inside the IIFE, after `composeFallbackTitle` and before the `var api = {...}` line:

```js
  // extractHashtags(rawTitle) — pull #word tokens out of an AI-generated
  // title; returns { title, tags } where title has the tokens (and any
  // resulting double-spaces) removed, and tags is the lowercase, deduped
  // token list, UNCLEANED — bad-pattern rejection and canonicalization onto
  // existing vocabulary is index.html's job (applyGeneratedTitle), since
  // this module has no access to the library's tag state.
  function extractHashtags(rawTitle) {
    var text = String(rawTitle == null ? "" : rawTitle);
    var found = text.match(/#(\w+)/g) || [];
    var title = text.replace(/#\w+/g, "").replace(/\s{2,}/g, " ").trim();
    var seen = {}, tags = [];
    found.forEach(function (h) {
      var tag = h.slice(1).toLowerCase();
      if (!tag || tag.length > 40 || seen[tag]) return;
      seen[tag] = 1;
      tags.push(tag);
    });
    return { title: title, tags: tags };
  }
```

Then update the two export lines to include it:

```js
  var api = { buildTitlePrompt: buildTitlePrompt, parseTitleReply: parseTitleReply, extractWeakContext: extractWeakContext, composeFallbackTitle: composeFallbackTitle, extractHashtags: extractHashtags };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.buildTitlePrompt = buildTitlePrompt; root.parseTitleReply = parseTitleReply; root.extractWeakContext = extractWeakContext; root.composeFallbackTitle = composeFallbackTitle; root.extractHashtags = extractHashtags; }
```

- [ ] **Step 4: Copy the identical change to `pwa/title-ai.js`**

`web/title-ai.js` and `pwa/title-ai.js` are a required exact byte-pair. Apply the exact same two edits (the new function + the two updated export lines) to `pwa/title-ai.js`. Verify with:

```bash
diff web/title-ai.js pwa/title-ai.js
```

Expected: no output (files identical).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/title-ai.test.js`
Expected: all tests pass, including the pre-existing ones (regression check).

- [ ] **Step 6: Commit**

```bash
git add web/title-ai.js pwa/title-ai.js tests/title-ai.test.js
git commit -m "feat: add extractHashtags pure helper to title-ai.js"
```

---

### Task 2: `applyGeneratedTitle` shared write helper in `index.html`

**Files:**
- Modify: `web/index.html`, `pwa/index.html` (identical edit, both copies) — insert after `generateUniqueTitle` ends (`web/index.html:6360`, the line `}` closing that function, immediately before the `// Pick the member to KEEP from a duplicate group.` comment at `web/index.html:6361`)
- Test: `tests/hashtag-title-apply.test.js` (new file)

**Interfaces:**
- Consumes: `extractHashtags` (Task 1, loaded via `require("../web/title-ai.js")` in tests, via `<script src="title-ai.js">` in the browser); the existing `canonicalTag(t)` (`web/index.html:4232`), `tagBadPattern(t)` (`web/index.html:4199`), and `AI_TAB_TAG` constant.
- Produces: `applyGeneratedTitle(card, rawTitle) -> { title: string, tagsAdded: string[] } | null`. Returns `null` and does nothing if `rawTitle` is falsy. Otherwise: extracts hashtags, cleans each extracted tag the same way `aiSuggestTags` cleans its own AI-returned tags (canonicalize onto existing vocabulary, drop anything `tagBadPattern` rejects, drop the reserved `AI_TAB_TAG`, dedupe case-insensitively), writes `card.title` (capped at 250 chars — falls back to the ORIGINAL uncleaned `rawTitle` if stripping hashtags left nothing, so a title is never left empty), merges the cleaned tags into `card.tags` (never replacing), and returns what it did so callers can toast/log the actual title written (not the raw one that may still contain `#`).
- Later tasks (3, 4, 8) call this instead of writing `card.title = ...` directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/hashtag-title-apply.test.js`:

```js
// tests/hashtag-title-apply.test.js — applyGeneratedTitle, the shared write
// path every AI-generated title goes through (impRefreshTitle, enrichOnOpen,
// the Title-issues Apply flow for AI-origin rows, and the new AI-refresh
// batch). Converts embedded #hashtags into tags; deliberately NOT wired into
// manual title edits (cardEditSave/impEditSave) — see
// docs/superpowers/specs/2026-08-02-ai-batch-refresh-design.md.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { extractHashtags } = require("../web/title-ai.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

// Real canonicalTag/tagBadPattern from the source (not reimplemented) —
// canonicalTag depends on allTags(), stubbed here to an injected vocabulary.
function loadApplyGeneratedTitle(src, vocab) {
  const parts = {
    tagBadPattern: extractFn(src, "tagBadPattern"),
    canonicalTag: extractFn(src, "canonicalTag"),
    applyGeneratedTitle: extractFn(src, "applyGeneratedTitle"),
  };
  Object.keys(parts).forEach(name => assert.ok(parts[name], name + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function(
    "extractHashtags", "allTags", "AI_TAB_TAG",
    body + "\nreturn applyGeneratedTitle;"
  );
  return factory(extractHashtags, () => vocab || [], "interests");
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": applyGeneratedTitle returns null and touches nothing for a falsy title", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: ["x"] };
    const out = applyGeneratedTitle(card, "");
    assert.strictEqual(out, null);
    assert.strictEqual(card.title, "old");
    assert.deepStrictEqual(card.tags, ["x"]);
  });

  t(label + ": applyGeneratedTitle strips hashtags from the title and adds them as tags", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const out = applyGeneratedTitle(card, "Backyard Pizza Oven #diy #pizza Build");
    assert.strictEqual(card.title, "Backyard Pizza Oven Build");
    assert.deepStrictEqual(card.tags.sort(), ["diy", "pizza"]);
    assert.strictEqual(out.title, "Backyard Pizza Oven Build");
    assert.deepStrictEqual(out.tagsAdded.sort(), ["diy", "pizza"]);
  });

  t(label + ": applyGeneratedTitle merges into existing tags, never replaces", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: ["existing"] };
    applyGeneratedTitle(card, "New Title #fresh");
    assert.deepStrictEqual(card.tags.sort(), ["existing", "fresh"]);
  });

  t(label + ": applyGeneratedTitle falls back to the raw title when hashtag-stripping empties it", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const out = applyGeneratedTitle(card, "#diy #pizza");
    assert.strictEqual(card.title, "#diy #pizza");
    assert.strictEqual(out.title, "#diy #pizza");
    assert.deepStrictEqual(card.tags, ["diy", "pizza"]);
  });

  t(label + ": applyGeneratedTitle rejects a bad-pattern hashtag (e.g. a bare year) as a tag but still cleans the title", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const out = applyGeneratedTitle(card, "Recap #2024 Highlights");
    assert.strictEqual(card.title, "Recap Highlights");
    assert.deepStrictEqual(card.tags, []);
    assert.deepStrictEqual(out.tagsAdded, []);
  });

  t(label + ": applyGeneratedTitle canonicalizes a hashtag onto an existing near-duplicate tag", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src, ["recipes"]);
    const card = { title: "old", tags: [] };
    applyGeneratedTitle(card, "Dinner Ideas #recipe");
    assert.deepStrictEqual(card.tags, ["recipes"]);
  });

  t(label + ": applyGeneratedTitle drops the reserved AI_TAB_TAG if somehow present as a hashtag", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    applyGeneratedTitle(card, "Something #interests Weird");
    assert.deepStrictEqual(card.tags, []);
  });

  t(label + ": applyGeneratedTitle caps the written title at 250 characters", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const longTitle = "A".repeat(300);
    applyGeneratedTitle(card, longTitle);
    assert.strictEqual(card.title.length, 250);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/hashtag-title-apply.test.js`
Expected: FAIL — `applyGeneratedTitle not found in source` (from `extractFn` returning `null` and the `assert.ok` guard, or a thrown error building the factory).

- [ ] **Step 3: Implement `applyGeneratedTitle` in `web/index.html`**

Insert immediately after line 6360 (the `}` closing `generateUniqueTitle`) and before the `// Pick the member to KEEP from a duplicate group.` comment:

```js
// Shared write path for every AI-GENERATED title (impRefreshTitle,
// enrichOnOpen, the Title-issues Apply flow for AI-origin rows, and the
// AI-refresh batch) — deliberately NOT used by the manual edit forms
// (cardEditSave/impEditSave), which save whatever the user typed verbatim.
// Converts embedded #hashtags into tags (merged, never replacing what the
// card already has) using the same cleaning aiSuggestTags already applies
// to its own AI-returned tags, and writes the cleaned title onto the card.
// Returns null (no-op) for a falsy rawTitle, else { title, tagsAdded } so
// callers can toast/log the title actually written, not the raw one that
// may still contain '#'.
function applyGeneratedTitle(card, rawTitle){
  if(!rawTitle) return null;
  const extracted = extractHashtags(rawTitle);
  const seen=new Set(), cleaned=[];
  extracted.tags.forEach(t=>{
    if(t===AI_TAB_TAG) return;
    t=canonicalTag(t);
    const k=t.toLowerCase();
    if(seen.has(k)) return; seen.add(k);
    if(!tagBadPattern(t)) cleaned.push(t);
  });
  card.title = (extracted.title || rawTitle).slice(0,250);
  if(cleaned.length) card.tags = Array.from(new Set([...(card.tags||[]), ...cleaned]));
  return { title: card.title, tagsAdded: cleaned };
}
```

- [ ] **Step 4: Copy the identical change to `pwa/index.html`**

Find the same insertion point (immediately after `pwa/index.html`'s `generateUniqueTitle` closing brace, before its `dupePrimary` comment) and insert the identical function.

Verify with:

```bash
diff <(sed -n '/^function applyGeneratedTitle/,/^}/p' web/index.html) <(sed -n '/^function applyGeneratedTitle/,/^}/p' pwa/index.html)
```

Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/hashtag-title-apply.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/hashtag-title-apply.test.js
git commit -m "feat: add applyGeneratedTitle shared hashtag-to-tag write path"
```

---

### Task 3: Wire `applyGeneratedTitle` into `impRefreshTitle` and `enrichOnOpen`

**Files:**
- Modify: `web/index.html:6905-6917` (`impRefreshTitle`) and `web/index.html:5104-5109` (`enrichOnOpen`'s AI-title branch); mirror in `pwa/index.html`
- Test: `tests/title-write-sites-hashtags.test.js` (new file)

**Interfaces:**
- Consumes: `applyGeneratedTitle` (Task 2).

- [ ] **Step 1: Write the failing tests**

Create `tests/title-write-sites-hashtags.test.js`:

```js
// tests/title-write-sites-hashtags.test.js — impRefreshTitle and
// enrichOnOpen's AI-title branch route through applyGeneratedTitle, so a
// hashtag in an AI-generated title becomes a tag instead of staying in the
// title text.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

// Top-level await needs an async IIFE — this file is plain CommonJS (no
// "type":"module" in package.json), so bare top-level `await` is a syntax error.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": impRefreshTitle applies a hashtag in the AI's suggested title as a tag, not literal text", async () => {
    const it = { title: "old", tags: [] };
    const imported = [it];
    const applyGeneratedTitle = (card, rawTitle) => { card.title = rawTitle.replace(/#\w+/g, "").trim(); card.tags = ["diy"]; return { title: card.title, tagsAdded: ["diy"] }; };
    const regenerateTitleFor = async () => "New Title #diy";
    let persisted = false, toasted = "";
    const factory = new Function(
      "imported", "applyGeneratedTitle", "regenerateTitleFor", "persistCards", "updateCounts",
      "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "impRefreshTitle") + "\nreturn impRefreshTitle;"
    );
    const impRefreshTitle = factory(
      imported, applyGeneratedTitle, regenerateTitleFor,
      async () => { persisted = true; }, () => {}, "imported",
      () => {}, () => {}, () => {}, () => false, (msg) => { toasted = msg; }
    );
    await impRefreshTitle(0);
    assert.strictEqual(it.title, "New Title");
    assert.deepStrictEqual(it.tags, ["diy"]);
    assert.ok(persisted);
    assert.ok(toasted.indexOf("New Title") >= 0);
    assert.ok(toasted.indexOf("#") === -1, "toast must show the cleaned title, not the raw one with '#'");
  });

  await t(label + ": impRefreshTitle is a no-op when regenerateTitleFor returns null (unchanged)", async () => {
    const it = { title: "old", tags: [] };
    const imported = [it];
    let applyCalled = false;
    const factory = new Function(
      "imported", "applyGeneratedTitle", "regenerateTitleFor", "persistCards", "updateCounts",
      "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "impRefreshTitle") + "\nreturn impRefreshTitle;"
    );
    const impRefreshTitle = factory(
      imported, () => { applyCalled = true; }, async () => null,
      async () => {}, () => {}, "imported",
      () => {}, () => {}, () => {}, () => false, () => {}
    );
    await impRefreshTitle(0);
    assert.strictEqual(it.title, "old");
    assert.strictEqual(applyCalled, false);
  });

  await t(label + ": enrichOnOpen applies a hashtag in the AI's suggested title as a tag, not literal text", async () => {
    // A facebook.com URL makes isFb=true, which short-circuits enrichOnOpen's
    // captureMeta/microlink/image-fallback blocks entirely — isolating just
    // the AI-title branch this task rewired, without having to stub every
    // media-fetch dependency those skipped blocks would otherwise need.
    const it = { title: "Facebook Post", desc: "a real description", url: "https://facebook.com/x/posts/1", tags: [] };
    const isGenericTitle = () => true;
    const generateUniqueTitle = async () => ({ title: "New Title #diy" });
    const applyGeneratedTitle = (card, rawTitle) => { card.title = rawTitle.replace(/#\w+/g, "").trim(); card.tags = ["diy"]; return { title: card.title, tagsAdded: ["diy"] }; };
    let putCardsCalled = false;
    const factory = new Function(
      "Store", "isGenericTitle", "setCardImage", "isBadImg", "fetchMicrolink", "Image",
      "IA_AI", "callAI", "generateUniqueTitle", "applyGeneratedTitle", "imported",
      "curTab", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast", "document",
      extractFn(src, "enrichOnOpen") + "\nreturn enrichOnOpen;"
    );
    // `imported` is only ever passed BY REFERENCE into Store.putCards(imported)
    // — the stub below ignores its argument, so [] satisfies the free
    // variable without needing to mirror the real global array.
    const enrichOnOpen = factory(
      { putCards: () => { putCardsCalled = true; } }, isGenericTitle,
      () => {}, () => false, async () => null, function(){},
      { hasAIKey: () => true }, async () => "", generateUniqueTitle, applyGeneratedTitle, [],
      "imported", () => {}, () => {}, () => false, () => {}, { addEventListener: () => {} }
    );
    await enrichOnOpen(it, 0);
    assert.strictEqual(it.title, "New Title");
    assert.deepStrictEqual(it.tags, ["diy"]);
    assert.ok(putCardsCalled);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/title-write-sites-hashtags.test.js`
Expected: FAIL — `it.title` is still `"New Title #diy"` (unstripped) in the first test.

- [ ] **Step 3: Wire `impRefreshTitle` (`web/index.html:6905-6917`)**

Replace:

```js
async function impRefreshTitle(idx){
  const it = imported[idx]; if(!it) return;
  const out = await regenerateTitleFor(it, null, "Generating a new title…");
  if(!out) return;
  it.title = out.slice(0,250);
  await persistCards();
  updateCounts();
  // Anchor BEFORE the re-render, while the old DOM is still on screen — without
  // this, restoreImpScrollSettle ran against whatever anchor some earlier
  // interaction left behind and jumped away from the card being refreshed.
  if(curTab==="imported"){ anchorImpOnCard(it); renderImported(); restoreImpScrollSettle(); } else refreshTabsViewIfShowing();
  toast("New title: "+out, 7000);
}
```

with:

```js
async function impRefreshTitle(idx){
  const it = imported[idx]; if(!it) return;
  const out = await regenerateTitleFor(it, null, "Generating a new title…");
  if(!out) return;
  const applied = applyGeneratedTitle(it, out);
  await persistCards();
  updateCounts();
  // Anchor BEFORE the re-render, while the old DOM is still on screen — without
  // this, restoreImpScrollSettle ran against whatever anchor some earlier
  // interaction left behind and jumped away from the card being refreshed.
  if(curTab==="imported"){ anchorImpOnCard(it); renderImported(); restoreImpScrollSettle(); } else refreshTabsViewIfShowing();
  toast("New title: "+applied.title, 7000);
}
```

- [ ] **Step 4: Wire `enrichOnOpen`'s AI branch (`web/index.html:5104-5109`)**

Replace:

```js
    if(isGenericTitle(it.title, it.url)){
      try{
        const suggested = await generateUniqueTitle(it, undefined, false);
        if(suggested && suggested.title){ it.title=suggested.title; changed=true; }
      }catch(e){ console.warn("AI title generation failed",e); }
    }
```

with:

```js
    if(isGenericTitle(it.title, it.url)){
      try{
        const suggested = await generateUniqueTitle(it, undefined, false);
        if(suggested && suggested.title){ applyGeneratedTitle(it, suggested.title); changed=true; }
      }catch(e){ console.warn("AI title generation failed",e); }
    }
```

- [ ] **Step 5: Copy both edits identically to `pwa/index.html`**

Same two replacements, same surrounding context, in `pwa/index.html`. Verify with:

```bash
diff <(sed -n '/^async function impRefreshTitle/,/^}/p' web/index.html) <(sed -n '/^async function impRefreshTitle/,/^}/p' pwa/index.html)
diff <(sed -n '/^async function enrichOnOpen/,/^}/p' web/index.html) <(sed -n '/^async function enrichOnOpen/,/^}/p' pwa/index.html)
```

Expected: no output for either.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/title-write-sites-hashtags.test.js`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/title-write-sites-hashtags.test.js
git commit -m "feat: route impRefreshTitle and enrichOnOpen through applyGeneratedTitle"
```

---

### Task 4: Title-issues panel — track AI-origin suggestions, only hashtag-strip those

**Files:**
- Modify: `web/index.html` — `let _titleSuggestions = {};` (`:6834`) region, `retryTitleSuggestion` (`:6892-6902`), `editTitleManually` (`:6945-6954`), `renderHealthTitles` (`:6955-6997`, its empty-state branch and Cancel button's inline `onclick`), `openHealth`/`healthSwitch` (`:6398-6424`), `suggestTitlesForFlagged` (`:7000-7023`), `applyTitleSuggestions` (`:7024-7051`); mirror in `pwa/index.html`
- Test: `tests/title-issues-hashtags.test.js` (new file)

**Why:** `_titleSuggestions[key]` is written from TWO different origins that share the exact same input box and the exact same Apply button: an AI suggestion (`retryTitleSuggestion`, `suggestTitlesForFlagged`) and a hand-typed replacement (`editTitleManually`, via its "✎ Write the title yourself" button — it seeds the box with the current title so the user can edit it, but the value that lands in the box afterward is text the user typed). Applying hashtag-extraction unconditionally in `applyTitleSuggestions` would silently mangle a title someone just typed by hand — the exact thing this feature's design deliberately avoids for `cardEditSave`/`impEditSave`. This task tracks provenance so only AI-origin rows get `applyGeneratedTitle` treatment.

**Interfaces:**
- Consumes: `applyGeneratedTitle` (Task 2).
- Produces: `let _titleSuggestionsAI` (a `Set` of `"<scope>:<id>"` keys currently holding an AI-origin suggestion) and `function clearTitleSuggestions()` (resets both `_titleSuggestions` and `_titleSuggestionsAI` together) — module-level state other tasks do not need to touch.

- [ ] **Step 1: Write the failing tests**

Create `tests/title-issues-hashtags.test.js`:

```js
// tests/title-issues-hashtags.test.js — the Title-issues panel's Apply flow
// only runs hashtag-to-tag conversion on AI-origin suggestions
// (retryTitleSuggestion / suggestTitlesForFlagged), never on a row the user
// hand-edited via editTitleManually — both share the same input box and the
// same Apply button, so provenance has to be tracked explicitly.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function fakeRow(key, value, checked) {
  const input = { value };
  const checkbox = { checked };
  return {
    getAttribute: (a) => a === "data-title-key" ? key : null,
    querySelector: (sel) => sel === "input.title-suggest-input" ? input : (sel === "input[data-title-apply]" ? checkbox : null),
  };
}

// Top-level await needs an async IIFE — this file is plain CommonJS.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": applyTitleSuggestions runs applyGeneratedTitle for an AI-origin row (hashtag becomes a tag)", () => {
    const imported = [{ id: "i1", title: "old", tags: [] }];
    const saved = [];
    const rows = [fakeRow("imported:i1", "New Title #diy", true)];
    const document = { querySelectorAll: () => rows };
    let persistedCards = false, persistedSaved = false, toasted = "";
    const applyGeneratedTitle = (card, val) => { card.title = val.replace(/#\w+/g, "").trim(); card.tags = ["diy"]; return { title: card.title, tagsAdded: ["diy"] }; };
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "clearTitleSuggestions") || "function clearTitleSuggestions(){ _titleSuggestions={}; _titleSuggestionsAI=new Set(); }",
      extractFn(src, "applyTitleSuggestions"),
    ].join("\n");
    const factory = new Function(
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab",
      body + "\n_titleSuggestionsAI.add('imported:i1');\nreturn applyTitleSuggestions;"
    );
    // _healthTab is deliberately NOT "titles" here, so the real function's
    // trailing `if(_healthTab==="titles") renderHealthTitles(...)` re-render
    // is skipped — renderHealthTitles isn't stubbed because this test only
    // cares about the write/persist behavior above it.
    const applyTitleSuggestions = factory(
      document, imported, saved, applyGeneratedTitle,
      () => { persistedCards = true; },
      { putSaved: () => { persistedSaved = true; } },
      (msg) => { toasted = msg; }, "dupes"
    );
    applyTitleSuggestions();
    assert.strictEqual(imported[0].title, "New Title");
    assert.deepStrictEqual(imported[0].tags, ["diy"]);
    assert.ok(persistedCards && persistedSaved);
  });

  await t(label + ": applyTitleSuggestions writes a hand-edited row verbatim, hashtag and all", () => {
    const imported = [{ id: "i1", title: "old", tags: [] }];
    const saved = [];
    const rows = [fakeRow("imported:i1", "My Own Title #keepit", true)];
    const document = { querySelectorAll: () => rows };
    const applyGeneratedTitle = () => { throw new Error("must not be called for a manual row"); };
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "clearTitleSuggestions") || "function clearTitleSuggestions(){ _titleSuggestions={}; _titleSuggestionsAI=new Set(); }",
      extractFn(src, "applyTitleSuggestions"),
    ].join("\n");
    const factory = new Function(
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab",
      body + "\nreturn applyTitleSuggestions;"   // _titleSuggestionsAI deliberately NOT seeded with this key
    );
    const applyTitleSuggestions = factory(
      document, imported, saved, applyGeneratedTitle,
      () => {}, { putSaved: () => {} }, () => {}, "dupes"
    );
    applyTitleSuggestions();
    assert.strictEqual(imported[0].title, "My Own Title #keepit");
    assert.deepStrictEqual(imported[0].tags, []);
  });

  await t(label + ": retryTitleSuggestion marks its key as AI-origin", async () => {
    const flaggedTitleCards = () => [{ scope: "imported", card: { id: "i1" } }];
    const regenerateTitleFor = async () => "AI Suggestion #tag";
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "retryTitleSuggestion"),
    ].join("\n");
    const factory = new Function(
      "flaggedTitleCards", "regenerateTitleFor", "_healthTab", "document", "toast",
      body + "\nreturn { retryTitleSuggestion, get suggestions(){ return _titleSuggestions; }, get ai(){ return _titleSuggestionsAI; } };"
    );
    // _healthTab is deliberately NOT "titles" here, so the real function's
    // `if(_healthTab==="titles") renderHealthTitles(...)` branch is skipped —
    // this test only cares about the AI-origin flag, not the re-render.
    const mod = factory(flaggedTitleCards, regenerateTitleFor, "dupes", { getElementById: () => null }, () => {});
    await mod.retryTitleSuggestion("imported:i1");
    assert.strictEqual(mod.suggestions["imported:i1"], "AI Suggestion #tag");
    assert.ok(mod.ai.has("imported:i1"));
  });

  await t(label + ": editTitleManually clears any prior AI-origin flag for that key", () => {
    const titleRowCard = () => ({ card: { title: "Current Title" } });
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set(['imported:i1']);",
      extractFn(src, "editTitleManually"),
    ].join("\n");
    const factory = new Function(
      "titleRowCard", "document", "toast", "renderHealthTitles", "window",
      body + "\nreturn { editTitleManually, get ai(){ return _titleSuggestionsAI; } };"
    );
    // editTitleManually unconditionally calls renderHealthTitles(...) and
    // touches window.CSS?.escape — both stubbed out; this test only cares
    // about the AI-origin flag being cleared.
    const mod = factory(
      titleRowCard,
      { getElementById: () => null, querySelector: () => null },
      () => {}, () => {}, {}
    );
    mod.editTitleManually("imported:i1");
    assert.strictEqual(mod.ai.has("imported:i1"), false);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/title-issues-hashtags.test.js`
Expected: FAIL — `clearTitleSuggestions`/`_titleSuggestionsAI` don't exist yet, and `applyTitleSuggestions` still writes hashtags verbatim for both rows in the first test.

- [ ] **Step 3: Add the provenance tracker (`web/index.html`, near `:6834`)**

Find `let _titleSuggestions = {};` and replace with:

```js
let _titleSuggestions = {};
// Which _titleSuggestions keys came from the AI (retryTitleSuggestion /
// suggestTitlesForFlagged) vs a hand-typed edit (editTitleManually) — only
// AI-origin rows get hashtag-to-tag conversion on Apply (see
// applyTitleSuggestions). Always reset together via clearTitleSuggestions().
let _titleSuggestionsAI = new Set();
function clearTitleSuggestions(){ _titleSuggestions = {}; _titleSuggestionsAI = new Set(); }
```

- [ ] **Step 4: Replace every reset site with `clearTitleSuggestions()`**

Five sites, each currently `_titleSuggestions = {};` or `_titleSuggestions={};`:
1. `openHealth`/`closeHealth` region, `:6420` (inside `closeHealth`) — replace the statement with `clearTitleSuggestions();`.
2. `healthSwitch`, `:6424` — replace the `_titleSuggestions = {};` segment of that one-line function with `clearTitleSuggestions();`.
3. `renderHealthTitles`'s empty-state branch, `:6957` — replace `_titleSuggestions={};` with `clearTitleSuggestions();`.
4. `renderHealthTitles`'s Cancel button inline `onclick`, `:6968` — change `onclick="_titleSuggestions={};renderHealthTitles(document.getElementById('healthList'));"` to `onclick="clearTitleSuggestions();renderHealthTitles(document.getElementById('healthList'));"`.
5. `applyTitleSuggestions`'s success path, `:7048` — replace `_titleSuggestions={};` with `clearTitleSuggestions();`.

- [ ] **Step 5: Mark AI-origin at the two AI-write sites**

In `retryTitleSuggestion` (`:6899`), change:
```js
  _titleSuggestions[key]=out;
```
to:
```js
  _titleSuggestions[key]=out; _titleSuggestionsAI.add(key);
```

In `suggestTitlesForFlagged` (`:7016`), change:
```js
      if(suggestion){ _titleSuggestions[m.scope+":"+m.card.id]=suggestion; acceptedThisBatch.push(suggestion); }
```
to:
```js
      if(suggestion){ const key=m.scope+":"+m.card.id; _titleSuggestions[key]=suggestion; _titleSuggestionsAI.add(key); acceptedThisBatch.push(suggestion); }
```

- [ ] **Step 6: Clear AI-origin on manual edit**

In `editTitleManually` (`:6948`), change:
```js
  _titleSuggestions[key] = hit.card.title || "";
```
to:
```js
  _titleSuggestions[key] = hit.card.title || ""; _titleSuggestionsAI.delete(key);
```

- [ ] **Step 7: Branch on provenance in `applyTitleSuggestions` (`:7024-7051`)**

Change the row-processing body from:
```js
    card.title=val.slice(0,250); card.titleSet=true;
```
to:
```js
    if(_titleSuggestionsAI.has(key)) applyGeneratedTitle(card, val);
    else card.title=val.slice(0,250);
    card.titleSet=true;
```

- [ ] **Step 8: Copy every edit from Steps 3-7 identically to `pwa/index.html`**

Same statements, same surrounding functions. Verify with:

```bash
diff <(sed -n '/^let _titleSuggestions = {}/,/^function clearTitleSuggestions/p' web/index.html | head -6) <(sed -n '/^let _titleSuggestions = {}/,/^function clearTitleSuggestions/p' pwa/index.html | head -6)
diff <(sed -n '/^function applyTitleSuggestions/,/^}/p' web/index.html) <(sed -n '/^function applyTitleSuggestions/,/^}/p' pwa/index.html)
```

Expected: no output for either.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node tests/title-issues-hashtags.test.js`
Expected: all tests pass.

- [ ] **Step 10: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED (existing tests touching `_titleSuggestions`, e.g. `title-issues-resolved.test.js`, must still pass — they exercise the reset/apply flow this task changed).

- [ ] **Step 11: Commit**

```bash
git add web/index.html pwa/index.html tests/title-issues-hashtags.test.js
git commit -m "feat: track AI-origin title suggestions, only hashtag-strip those on Apply"
```

---

### Task 5: `aiTagChunk` — factor the retag core out of `autoTag`

**Files:**
- Modify: `web/index.html:3473-3507` (`autoTag`); mirror in `pwa/index.html`
- Test: `tests/ai-tag-chunk.test.js` (new file)

**Interfaces:**
- Consumes: existing `callAI`, `parseJsonArray`, `CATS`, `catByName`.
- Produces: `async function aiTagChunk(queue, opts) -> Promise<void>` — `opts.merge` (boolean, default `false`): mutates each card in `queue` in place. `merge:false` (used by `autoTag`, unchanged behavior): sets `q.tags` to the AI's tags, or `["misc"]` if the AI returned none. `merge:true` (used by the new AI-refresh batch, Task 8): merges the AI's tags into `q.tags` (never replaces, never forces `"misc"` — a card that already has tags should never be downgraded just because this particular chunk's AI response was empty for it). Category is always set (never merged — a card has exactly one), using the existing `.category`-vs-`.cat` presence check. The prompt-building line also now reads `q.desc||q.benefit` (previously `q.desc` only) so a `saved`-scope card's description (stored in `.benefit`) is no longer silently dropped from the tagging prompt — `autoTag` already processes `saved` cards, so this is a correctness fix to code this task's refactor now shares with the new batch, not a new behavior being introduced.
- `autoTag` keeps its exact existing public behavior (same button, same "Tag next 120"/"Tag all" callers, same untagged-only queue, same per-chunk persistence) — it becomes a thin loop around `aiTagChunk(queue, {merge:false})`.

- [ ] **Step 1: Write the failing tests**

Create `tests/ai-tag-chunk.test.js`:

```js
// tests/ai-tag-chunk.test.js — aiTagChunk, the shared "send a chunk of cards
// to the AI, get tags+category back" core factored out of autoTag. autoTag
// itself keeps using merge:false (cards had none); the new AI-refresh batch
// (Task 8) uses merge:true (cards may already be tagged, tags add on top).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

const CATS = [{ name: "Personal" }, { name: "Work" }];
function catByName(n) { return CATS.find(c => c.name.toLowerCase() === String(n).toLowerCase()) || CATS[0]; }
function parseJsonArray(text) { try { const m = text.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } }

function load(src) {
  const factory = new Function(
    "callAI", "parseJsonArray", "CATS", "catByName",
    extractFn(src, "aiTagChunk") + "\nreturn aiTagChunk;"
  );
  return factory;
}

// Top-level await needs an async IIFE — this file is plain CommonJS.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": aiTagChunk merge:false sets tags fresh, falls back to ['misc'] when the AI returns none", async () => {
    const callAI = async () => JSON.stringify([{ t: ["fishing"], c: "Personal" }, { t: [], c: "Work" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a" }, { title: "b" }];
    await aiTagChunk(queue, { merge: false });
    assert.deepStrictEqual(queue[0].tags, ["fishing"]);
    assert.deepStrictEqual(queue[1].tags, ["misc"]);
    assert.strictEqual(queue[0].cat, "Personal");
    assert.strictEqual(queue[1].cat, "Work");
  });

  await t(label + ": aiTagChunk merge:true adds to existing tags, never forces 'misc' on an empty AI response", async () => {
    const callAI = async () => JSON.stringify([{ t: ["fishing"], c: "Personal" }, { t: [], c: "Work" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", tags: ["bass"] }, { title: "b", tags: ["existing"] }];
    await aiTagChunk(queue, { merge: true });
    assert.deepStrictEqual(queue[0].tags.sort(), ["bass", "fishing"]);
    assert.deepStrictEqual(queue[1].tags, ["existing"]);   // untouched, NOT downgraded to ['misc']
  });

  await t(label + ": aiTagChunk merge:true dedupes when the AI re-suggests a tag the card already has", async () => {
    const callAI = async () => JSON.stringify([{ t: ["bass", "fishing"], c: "Personal" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", tags: ["bass"] }];
    await aiTagChunk(queue, { merge: true });
    assert.deepStrictEqual(queue[0].tags.sort(), ["bass", "fishing"]);
  });

  await t(label + ": aiTagChunk sets .category (not .cat) for a card that already has a .category field (saved-scope)", async () => {
    const callAI = async () => JSON.stringify([{ t: ["x"], c: "Work" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", category: "Personal" }];
    await aiTagChunk(queue, { merge: false });
    assert.strictEqual(queue[0].category, "Work");
    assert.strictEqual(queue[0].cat, undefined);
  });

  await t(label + ": aiTagChunk includes a saved-scope card's .benefit in the prompt (not just .desc)", async () => {
    let sentPrompt = "";
    const callAI = async (p) => { sentPrompt = p; return JSON.stringify([{ t: ["x"], c: "Personal" }]); };
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", benefit: "A saved-card description" }];
    await aiTagChunk(queue, { merge: false });
    assert.ok(sentPrompt.indexOf("A saved-card description") >= 0, "prompt must include the saved card's .benefit text");
  });

  await t(label + ": aiTagChunk throws when the AI response can't be parsed (propagates to the caller, matches autoTag's existing error handling)", async () => {
    const callAI = async () => "not json";
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    await assert.rejects(() => aiTagChunk([{ title: "a" }], { merge: false }));
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/ai-tag-chunk.test.js`
Expected: FAIL — `aiTagChunk not found in source`.

- [ ] **Step 3: Implement `aiTagChunk` and refactor `autoTag` (`web/index.html:3473-3507`)**

Replace the whole existing `autoTag` function with:

```js
// Shared "send a chunk of cards to the AI, get tags+category back" core.
// autoTag (below) uses merge:false — its cards have no tags yet, so "set"
// and "merge" are the same operation, and an empty AI response still falls
// back to ["misc"] so every processed card ends up tagged. The AI-refresh
// batch uses merge:true — its cards may already be tagged, so new tags are
// ADDED (never replacing what's there), and an empty AI response leaves the
// card's existing tags untouched rather than downgrading them to ["misc"].
async function aiTagChunk(queue, opts){
  const merge = !!(opts && opts.merge);
  const prompt = `Tag each numbered saved item for an interest discovery app. For EACH item return 2-4 short lowercase keyword tags (1-2 words each, reusable across items — e.g. "3d printing", "bass fishing", "claude", "recipes", "linkedin") and the ONE best-fit category, chosen ONLY from this exact list: ${CATS.map(c=>c.name).join(" | ")}.
Return ONLY a JSON array of ${queue.length} objects, same order, shape: [{"t":["tag1","tag2"],"c":"Category Name"}]

${queue.map((q,i)=>(i+1)+". "+q.title+((q.desc||q.benefit)?" — "+(q.desc||q.benefit).slice(0,80):"")).join("\n")}`;
  const text = await callAI(prompt);
  const arr = parseJsonArray(text);
  if(arr===null) throw new Error("No tags found in model response");
  queue.forEach((q,i)=>{
    const r=arr[i]||{};
    const newTags = Array.isArray(r.t) ? r.t.filter(x=>typeof x==="string"&&x.trim()).slice(0,4).map(x=>x.trim().toLowerCase()) : [];
    if(merge){
      if(newTags.length) q.tags = Array.from(new Set([...(q.tags||[]), ...newTags]));
    } else {
      q.tags = newTags.length ? newTags : ["misc"];
    }
    const cat = catByName(String(r.c||"")).name;
    if(q.category!==undefined) q.category = cat;
    else q.cat = cat;
  });
}
async function autoTag(limit){
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); return; }
  const btn=document.getElementById("tagBtn");
  if(btn){ btn.disabled=true; btn.innerHTML='<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Tagging…'; }
  const cap = limit || Infinity;
  try{
    let done=0;
    while(done<cap){
      const queue = imported.filter(i=>!i.tags).concat(saved.filter(i=>!i.tags)).slice(0,40);
      if(!queue.length) break;
      await aiTagChunk(queue, {merge:false});
      done += queue.length;
      Store.putCards(imported); persistAll();
      toast(done+" tagged…");
    }
    const left = imported.filter(i=>!i.tags).length + saved.filter(i=>!i.tags).length;
    toast(left ? done+" tagged — "+left+" remaining" : "All "+done+" items tagged and categorized");
  }catch(e){ console.error(e); toast(IA_AI.creditsMessage(e) || ("Hmm: "+e.message), 6000); }
  if(curTab==="saved") renderSaved();
  renderImportedKeepFocus();
}
```

- [ ] **Step 4: Copy the identical change to `pwa/index.html`**

Replace `pwa/index.html`'s `autoTag` (same original body, different line numbers) with the same `aiTagChunk` + refactored `autoTag` pair. Verify with:

```bash
diff <(sed -n '/^async function aiTagChunk/,/^async function autoTag/p' web/index.html) <(sed -n '/^async function aiTagChunk/,/^async function autoTag/p' pwa/index.html)
diff <(sed -n '/^async function autoTag/,/^function tagRow/p' web/index.html) <(sed -n '/^async function autoTag/,/^function tagRow/p' pwa/index.html)
```

Expected: no output for either.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/ai-tag-chunk.test.js`
Expected: all tests pass.

- [ ] **Step 6: Run the full suite (regression check for autoTag's unchanged behavior)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/ai-tag-chunk.test.js
git commit -m "refactor: factor aiTagChunk out of autoTag, add merge mode"
```

---

### Task 6: `aiRefreshDays` setting + `aiRefreshCandidates()` freshness query

**Files:**
- Modify: `web/index.html:872-900` (`DEFAULTS`) — add `aiRefreshDays:30,` after `catSidebar:false,`; new function near the other health-related pure helpers (insert directly before `const HEALTH_TABS` at `:6389`, so it reads naturally as "the AI-refresh tab's own state, just above its UI"); mirror in `pwa/index.html`
- Test: `tests/ai-refresh-freshness.test.js` (new file)

**Interfaces:**
- Produces: `S.aiRefreshDays` (default `30`) — a plain settings field, saved the same way `S.catSidebar` is (`S.aiRefreshDays = n; save("settings", S);`, wired in Task 7's UI). `function aiRefreshCandidates() -> Array` — reads `imported`, `saved`, and `S.aiRefreshDays`; returns every card (from either array) whose `aiRefreshedAt` is unset or older than `S.aiRefreshDays` days, sorted oldest-first (unset sorts as `0`, i.e. oldest possible, so never-touched cards are always processed before merely-stale ones).

- [ ] **Step 1: Write the failing tests**

Create `tests/ai-refresh-freshness.test.js`:

```js
// tests/ai-refresh-freshness.test.js — aiRefreshCandidates, the freshness
// query behind the "Process next 200" button. Mirrors the existing
// .lc.at/_lcFresh and .sb.at/_sbFresh "skip if checked within N days"
// pattern already used for link-safety checks, with its own field
// (aiRefreshedAt) and its own threshold (S.aiRefreshDays).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": DEFAULTS includes aiRefreshDays: 30", () => {
    assert.match(src, /aiRefreshDays\s*:\s*30\s*,/);
  });

  t(label + ": aiRefreshCandidates includes cards with no aiRefreshedAt and excludes recently-touched ones", () => {
    const now = 1000000000000;
    const S = { aiRefreshDays: 30 };
    const imported = [
      { id: "never", title: "a" },
      { id: "fresh", title: "b", aiRefreshedAt: now - 1 * 864e5 },      // 1 day ago -> not eligible
      { id: "stale", title: "c", aiRefreshedAt: now - 40 * 864e5 },     // 40 days ago -> eligible
    ];
    const saved = [];
    const factory = new Function(
      "imported", "saved", "S", "Date_now",
      "Date.now = Date_now;\n" + extractFn(src, "aiRefreshCandidates") + "\nreturn aiRefreshCandidates;"
    );
    const aiRefreshCandidates = factory(imported, saved, S, () => now);
    const ids = aiRefreshCandidates().map(c => c.id);
    assert.deepStrictEqual(ids.sort(), ["never", "stale"]);
  });

  t(label + ": aiRefreshCandidates sorts oldest-first, with never-touched cards ahead of merely-stale ones", () => {
    const now = 1000000000000;
    const S = { aiRefreshDays: 1 };
    const imported = [
      { id: "stale-recent", aiRefreshedAt: now - 5 * 864e5 },
      { id: "never" },
      { id: "stale-old", aiRefreshedAt: now - 50 * 864e5 },
    ];
    const saved = [];
    const factory = new Function(
      "imported", "saved", "S", "Date_now",
      "Date.now = Date_now;\n" + extractFn(src, "aiRefreshCandidates") + "\nreturn aiRefreshCandidates;"
    );
    const aiRefreshCandidates = factory(imported, saved, S, () => now);
    const ids = aiRefreshCandidates().map(c => c.id);
    assert.deepStrictEqual(ids, ["never", "stale-old", "stale-recent"]);
  });

  t(label + ": aiRefreshCandidates includes both imported and saved cards", () => {
    const now = 1000000000000;
    const S = { aiRefreshDays: 30 };
    const imported = [{ id: "imp1" }];
    const saved = [{ id: "sav1" }];
    const factory = new Function(
      "imported", "saved", "S", "Date_now",
      "Date.now = Date_now;\n" + extractFn(src, "aiRefreshCandidates") + "\nreturn aiRefreshCandidates;"
    );
    const aiRefreshCandidates = factory(imported, saved, S, () => now);
    const ids = aiRefreshCandidates().map(c => c.id);
    assert.deepStrictEqual(ids.sort(), ["imp1", "sav1"]);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/ai-refresh-freshness.test.js`
Expected: FAIL — `aiRefreshDays: 30` not found, `aiRefreshCandidates not found in source`.

- [ ] **Step 3: Add `aiRefreshDays` to `DEFAULTS` (`web/index.html:872-900`)**

Change:
```js
  catSidebar:false,
```
to:
```js
  catSidebar:false,
  aiRefreshDays:30,   // "Process next 200" in Library Health skips any card AI-refreshed within this many days
```

- [ ] **Step 4: Add `aiRefreshCandidates` (`web/index.html`, immediately before `const HEALTH_TABS` at `:6389`)**

```js
// The "Process next 200" freshness query — mirrors the existing .lc.at/
// _lcFresh and .sb.at/_sbFresh "skip if checked within N days" pattern, with
// its own field (aiRefreshedAt) and its own threshold (S.aiRefreshDays).
// Never-touched cards (aiRefreshedAt unset) sort as the oldest possible
// value, so they are always processed ahead of merely-stale ones.
function aiRefreshCandidates(){
  const cutoff = (S.aiRefreshDays||30) * 864e5;
  return imported.concat(saved).filter(it=>it && (!it.aiRefreshedAt || (Date.now()-it.aiRefreshedAt) > cutoff))
    .sort((a,b)=>(a.aiRefreshedAt||0)-(b.aiRefreshedAt||0));
}
```

- [ ] **Step 5: Copy both edits identically to `pwa/index.html`**

Verify with:

```bash
grep -n "aiRefreshDays:30" web/index.html pwa/index.html
diff <(sed -n '/^function aiRefreshCandidates/,/^}/p' web/index.html) <(sed -n '/^function aiRefreshCandidates/,/^}/p' pwa/index.html)
```

Expected: one match per file on the grep, no output on the diff.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/ai-refresh-freshness.test.js`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/ai-refresh-freshness.test.js
git commit -m "feat: add aiRefreshDays setting and aiRefreshCandidates freshness query"
```

---

### Task 7: "AI refresh" Library Health tab (UI only, no batch logic yet)

**Files:**
- Modify: `web/index.html:6389-6395` (`HEALTH_TABS`), `:6487-6501` (`renderHealth`'s dispatch); new render function inserted directly after `renderHealth`; mirror in `pwa/index.html`
- Test: `tests/ai-refresh-ui.test.js` (new file)

**Interfaces:**
- Consumes: `aiRefreshCandidates` (Task 6), `S.aiRefreshDays` (Task 6).
- Produces: `let _airefreshRetag = true, _airefreshRetitle = true;` (session-only checkbox state, both default on), `function renderHealthAiRefresh(list)`, `function airefreshSetDays(v)` (validates/clamps to `>=1`, writes `S.aiRefreshDays`, saves settings, re-renders if this tab is showing), `function airefreshUpdateBtn()` (enables/disables the Process button based on the two checkboxes). The Process button (`id="airefreshBtn"`) calls `runAiRefreshBatch()` — defined in Task 8; this task's own tests stub it out, since wiring the real implementation is Task 8's job.
- No tab-strip badge count is added to `_healthCounts()`/`healthTabStripHTML()` — the spec's "count line" lives inside the tab body only (this task's own `renderHealthAiRefresh`), matching how the count is computed live from in-memory state with no extra scan.

- [ ] **Step 1: Write the failing tests**

Create `tests/ai-refresh-ui.test.js`:

```js
// tests/ai-refresh-ui.test.js — the "AI refresh" Library Health tab's static
// UI: tab-strip entry, dispatch, and renderHealthAiRefresh's markup/state.
// The Process button's actual batch logic (runAiRefreshBatch) is Task 8.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": HEALTH_TABS includes an airefresh entry labeled 'AI refresh'", () => {
    assert.match(src, /\{\s*id:"airefresh",\s*label:"AI refresh"\s*\}/);
  });

  t(label + ": renderHealth dispatches to renderHealthAiRefresh for the airefresh tab", () => {
    assert.match(src, /if\(tab==="airefresh"\)\s*return\s*renderHealthAiRefresh\(list\);/);
  });

  t(label + ": renderHealthAiRefresh shows the eligible count and a working day-threshold input", () => {
    const el = { innerHTML: "" };
    const document = { getElementById: () => el };
    const S = { aiRefreshDays: 30 };
    const aiRefreshCandidates = () => [{ id: "a" }, { id: "b" }];
    const factory = new Function(
      "S", "aiRefreshCandidates", "_airefreshRetag", "_airefreshRetitle",
      extractFn(src, "renderHealthAiRefresh") + "\nreturn renderHealthAiRefresh;"
    );
    const renderHealthAiRefresh = factory(S, aiRefreshCandidates, true, true);
    const list = { innerHTML: "" };
    renderHealthAiRefresh(list);
    assert.ok(list.innerHTML.indexOf("2 card") >= 0, "must show the eligible count");
    assert.ok(list.innerHTML.indexOf('value="30"') >= 0, "must show the current threshold");
    assert.ok(list.innerHTML.indexOf("runAiRefreshBatch()") >= 0, "Process button must call runAiRefreshBatch");
  });

  t(label + ": renderHealthAiRefresh disables the Process button when there is nothing eligible", () => {
    const S = { aiRefreshDays: 30 };
    const aiRefreshCandidates = () => [];
    const factory = new Function(
      "S", "aiRefreshCandidates", "_airefreshRetag", "_airefreshRetitle",
      extractFn(src, "renderHealthAiRefresh") + "\nreturn renderHealthAiRefresh;"
    );
    const renderHealthAiRefresh = factory(S, aiRefreshCandidates, true, true);
    const list = { innerHTML: "" };
    renderHealthAiRefresh(list);
    assert.match(list.innerHTML, /id="airefreshBtn"[^>]*disabled/);
  });

  t(label + ": renderHealthAiRefresh disables the Process button when both checkboxes are off", () => {
    const S = { aiRefreshDays: 30 };
    const aiRefreshCandidates = () => [{ id: "a" }];
    const factory = new Function(
      "S", "aiRefreshCandidates", "_airefreshRetag", "_airefreshRetitle",
      extractFn(src, "renderHealthAiRefresh") + "\nreturn renderHealthAiRefresh;"
    );
    const renderHealthAiRefresh = factory(S, aiRefreshCandidates, false, false);
    const list = { innerHTML: "" };
    renderHealthAiRefresh(list);
    assert.match(list.innerHTML, /id="airefreshBtn"[^>]*disabled/);
  });

  t(label + ": airefreshSetDays clamps below 1 up to 1 and saves settings", () => {
    const S = { aiRefreshDays: 30 };
    let saved = null;
    const save = (k, v) => { saved = [k, v]; };
    const factory = new Function(
      "S", "save", "_healthTab", "document",
      extractFn(src, "airefreshSetDays") + "\nreturn { airefreshSetDays, S };"
    );
    const mod = factory(S, save, "dupes", { getElementById: () => null });
    mod.airefreshSetDays("-5");
    assert.strictEqual(mod.S.aiRefreshDays, 1);
    assert.deepStrictEqual(saved, ["settings", mod.S]);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/ai-refresh-ui.test.js`
Expected: FAIL — none of `HEALTH_TABS`'s airefresh entry, `renderHealth`'s dispatch, or `renderHealthAiRefresh`/`airefreshSetDays` exist yet.

- [ ] **Step 3: Add the tab-strip entry (`web/index.html:6389-6395`)**

Change:
```js
const HEALTH_TABS = [
  { id:"dupes",  label:"Duplicates" },
  { id:"dead",   label:"Dead & unsafe" },
  { id:"failed", label:"Failed captures" },
  { id:"nolink", label:"No link" },
  { id:"titles", label:"Title issues" },
];
```
to:
```js
const HEALTH_TABS = [
  { id:"dupes",  label:"Duplicates" },
  { id:"dead",   label:"Dead & unsafe" },
  { id:"failed", label:"Failed captures" },
  { id:"nolink", label:"No link" },
  { id:"titles", label:"Title issues" },
  { id:"airefresh", label:"AI refresh" },
];
```

- [ ] **Step 4: Add the dispatch (`web/index.html`, inside `renderHealth`, `:6487-6501`)**

Change:
```js
  if(tab==="titles") return renderHealthTitles(list);
}
```
to:
```js
  if(tab==="titles") return renderHealthTitles(list);
  if(tab==="airefresh") return renderHealthAiRefresh(list);
}
```

- [ ] **Step 5: Add the state vars and render function (`web/index.html`, immediately after `renderHealth`'s closing `}`)**

```js
// ---- AI refresh tab (Library Health) ----
// Session-only checkbox state — both default on, matching the "run
// everything" common case; unchecked state does not persist across an app
// restart, unlike S.aiRefreshDays (a real setting).
let _airefreshRetag = true, _airefreshRetitle = true;
function airefreshSetDays(v){
  const n = Math.max(1, parseInt(v,10)||30);
  S.aiRefreshDays = n; save("settings", S);
  if(_healthTab==="airefresh"){ const list=document.getElementById("healthList"); if(list) renderHealthAiRefresh(list); }
}
function airefreshUpdateBtn(){
  const btn = document.getElementById("airefreshBtn"); if(!btn) return;
  btn.disabled = !_airefreshRetag && !_airefreshRetitle;
}
function renderHealthAiRefresh(list){
  const eligible = aiRefreshCandidates();
  const noProcess = (!_airefreshRetag && !_airefreshRetitle) || !eligible.length;
  list.innerHTML = `
    <div class="s" style="opacity:.75;padding:2px 4px 10px">${eligible.length} card${eligible.length===1?"":"s"} eligible — untouched, or last AI-refreshed more than the threshold below.</div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:0 4px 10px">
      <label class="s">Only touch cards older than <input type="number" min="1" id="airefreshDays" value="${S.aiRefreshDays||30}" style="width:56px" onchange="airefreshSetDays(this.value)"> days</label>
    </div>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:0 4px 10px">
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="airefreshRetag" ${_airefreshRetag?"checked":""} onchange="_airefreshRetag=this.checked;airefreshUpdateBtn()"> Retag</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="airefreshRetitle" ${_airefreshRetitle?"checked":""} onchange="_airefreshRetitle=this.checked;airefreshUpdateBtn()"> Retitle</label>
    </div>
    <div class="s" style="opacity:.7;padding:0 4px 10px">Retitle can call the AI's vision tier when a card has no usable description or on-image text — same cost as the single-card refresh button.</div>
    <button class="btn btn-primary" id="airefreshBtn" ${noProcess?"disabled":""} onclick="runAiRefreshBatch()">Process next ${Math.min(200,eligible.length)}</button>`;
}
```

- [ ] **Step 6: Copy every edit from Steps 3-5 identically to `pwa/index.html`**

Verify with:

```bash
diff <(sed -n '/^const HEALTH_TABS = \[/,/^\];/p' web/index.html) <(sed -n '/^const HEALTH_TABS = \[/,/^\];/p' pwa/index.html)
diff <(sed -n '/^let _airefreshRetag/,/^}$/p' web/index.html | sed -n '/^function renderHealthAiRefresh/,/^}$/p') <(sed -n '/^let _airefreshRetag/,/^}$/p' pwa/index.html | sed -n '/^function renderHealthAiRefresh/,/^}$/p')
```

Expected: no output for either.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node tests/ai-refresh-ui.test.js`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add web/index.html pwa/index.html tests/ai-refresh-ui.test.js
git commit -m "feat: add AI refresh tab UI to Library Health"
```

---

### Task 8: `runAiRefreshBatch` — the actual batch runner

**Files:**
- Modify: `web/index.html` — insert `runAiRefreshBatch` immediately after `renderHealthAiRefresh` (Task 7); mirror in `pwa/index.html`
- Test: `tests/ai-refresh-batch.test.js` (new file)

**Interfaces:**
- Consumes: `aiRefreshCandidates` (Task 6), `aiTagChunk` (Task 5), `generateUniqueTitle` + `applyGeneratedTitle` (Task 2), `IA_AI.hasAIKey`, `Store.putCards`, `persistAll`, `_airefreshRetag`/`_airefreshRetitle` (Task 7).
- Produces: `async function runAiRefreshBatch()`. Guards: no-op while already running (`_airefreshRunning`), toasts if neither checkbox is on, toasts if there's no AI key, toasts if nothing is eligible. Otherwise takes `aiRefreshCandidates().slice(0,200)`, processes it in chunks of 40 (matching `autoTag`'s existing chunk size): if Retag is checked, `await aiTagChunk(chunk, {merge:true})` — a thrown error here propagates out of the whole run (matches `autoTag`'s own error handling: the caught error stops the run, already-stamped chunks keep their progress, and re-running the batch naturally retries the un-stamped remainder); if Retitle is checked, iterates the chunk one card at a time calling `generateUniqueTitle` then `applyGeneratedTitle`, with a **per-card** try/catch (matches `suggestTitlesForFlagged`'s existing precedent) so one bad card never aborts the batch. After both steps (whichever ran) for a chunk, every card in that chunk gets `card.aiRefreshedAt = Date.now()` and the chunk is persisted (`Store.putCards(imported); persistAll();`, same as `autoTag`) before moving to the next chunk — this is the whole resumability story: an interrupted run keeps whatever chunks it finished.

- [ ] **Step 1: Write the failing tests**

Create `tests/ai-refresh-batch.test.js`:

```js
// tests/ai-refresh-batch.test.js — runAiRefreshBatch, the "Process next 200"
// orchestrator. Stubs aiTagChunk/generateUniqueTitle/applyGeneratedTitle
// (each already has its own dedicated tests) to isolate the orchestration
// logic: chunking, checkbox gating, stamping, incremental persistence, and
// error propagation.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function makeCards(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: (prefix||"c") + i, title: "t" + i });
  return out;
}

// PROVIDERS[S.provider].keyName is read on the no-AI-key path; a Proxy that
// answers any key avoids having to set a matching S.provider in every state
// object above (several never touch that path at all).
const FAKE_PROVIDERS = new Proxy({}, { get: () => ({ keyName: "key" }) });
function load(src, state) {
  const doc = { getElementById: () => state.btn };
  const factory = new Function(
    "IA_AI", "PROVIDERS", "S", "toast", "aiRefreshCandidates", "aiTagChunk", "generateUniqueTitle", "applyGeneratedTitle",
    "Store", "persistAll", "_airefreshRetag", "_airefreshRetitle", "_airefreshRunning", "document",
    "curTab", "renderSaved", "renderImportedKeepFocus", "_healthTab", "renderHealthAiRefresh", "imported",
    extractFn(src, "runAiRefreshBatch") + "\nreturn runAiRefreshBatch;"
  );
  // `imported` is only ever passed BY REFERENCE into Store.putCards(imported)
  // — the stub below ignores its argument, so a plain [] satisfies the free
  // variable without needing to mirror the real global array's contents.
  return factory(
    state.IA_AI, FAKE_PROVIDERS, state.S, state.toast, state.aiRefreshCandidates,
    state.aiTagChunk, state.generateUniqueTitle, state.applyGeneratedTitle,
    state.Store, state.persistAll, state._airefreshRetag, state._airefreshRetitle, false, doc,
    "saved", state.renderSaved||(()=>{}), state.renderImportedKeepFocus||(()=>{}), "dupes", state.renderHealthAiRefresh||(()=>{}), []
  );
}

// Top-level await needs an async IIFE — this file is plain CommonJS.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": runAiRefreshBatch processes in chunks of 40, stamps aiRefreshedAt, persists per chunk", async () => {
    const cards = makeCards(45);
    const tagChunkCalls = [];
    const persistCalls = [];
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async (chunk) => { tagChunkCalls.push(chunk.length); },
      generateUniqueTitle: async () => ({ title: null }),
      applyGeneratedTitle: () => {},
      Store: { putCards: () => { persistCalls.push("cards"); } },
      persistAll: () => { persistCalls.push("all"); },
      _airefreshRetag: true, _airefreshRetitle: false,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: { } });
    await runAiRefreshBatch();
    assert.deepStrictEqual(tagChunkCalls, [40, 5]);
    assert.ok(cards.every(c => typeof c.aiRefreshedAt === "number"));
    assert.strictEqual(persistCalls.filter(x => x === "cards").length, 2);
  });

  await t(label + ": runAiRefreshBatch caps at 200 candidates even when more are eligible", async () => {
    const cards = makeCards(250);
    let totalTagged = 0;
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async (chunk) => { totalTagged += chunk.length; },
      generateUniqueTitle: async () => ({ title: null }),
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: false,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.strictEqual(totalTagged, 200);
    assert.strictEqual(cards.slice(200).every(c => c.aiRefreshedAt === undefined), true);
  });

  await t(label + ": runAiRefreshBatch only retitles when Retitle is checked, only retags when Retag is checked", async () => {
    const cards = makeCards(1);
    let tagCalled = false, titleCalled = false;
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async () => { tagCalled = true; },
      generateUniqueTitle: async () => { titleCalled = true; return { title: "New" }; },
      applyGeneratedTitle: (card, t) => { card.title = t; },
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: false, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.strictEqual(tagCalled, false);
    assert.strictEqual(titleCalled, true);
    assert.strictEqual(cards[0].title, "New");
  });

  await t(label + ": runAiRefreshBatch: a per-card retitle failure doesn't abort the batch", async () => {
    const cards = makeCards(2);
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async () => {},
      generateUniqueTitle: async (card) => { if (card.id === "c0") throw new Error("boom"); return { title: "ok" }; },
      applyGeneratedTitle: (card, t) => { card.title = t; },
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: false, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.strictEqual(cards[1].title, "ok");
    assert.ok(cards.every(c => typeof c.aiRefreshedAt === "number"), "both cards stamped even though one retitle attempt failed");
  });

  await t(label + ": runAiRefreshBatch: a chunk-level retag failure propagates and stops the run without stamping that chunk", async () => {
    const cards = makeCards(2);
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async () => { throw new Error("AI down"); },
      generateUniqueTitle: async () => ({ title: null }),
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: false,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();   // must not throw out of the function itself — caught and toasted
    assert.ok(cards.every(c => c.aiRefreshedAt === undefined), "no card stamped when its chunk's retag call threw");
  });

  await t(label + ": runAiRefreshBatch no-ops with a toast when nothing is eligible", async () => {
    let toasted = "";
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: (m) => { toasted = m; },
      aiRefreshCandidates: () => [],
      aiTagChunk: async () => { throw new Error("must not be called"); },
      generateUniqueTitle: async () => { throw new Error("must not be called"); },
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.ok(toasted.length > 0);
  });

  await t(label + ": runAiRefreshBatch no-ops with a toast when there's no AI key", async () => {
    let toasted = "";
    const state = {
      IA_AI: { hasAIKey: () => false },
      S: { aiRefreshDays: 30 },
      toast: (m) => { toasted = m; },
      aiRefreshCandidates: () => makeCards(1),
      aiTagChunk: async () => { throw new Error("must not be called"); },
      generateUniqueTitle: async () => { throw new Error("must not be called"); },
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.ok(toasted.indexOf("key") >= 0);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/ai-refresh-batch.test.js`
Expected: FAIL — `runAiRefreshBatch not found in source`.

- [ ] **Step 3: Implement `runAiRefreshBatch` (`web/index.html`, immediately after `renderHealthAiRefresh`)**

```js
async function runAiRefreshBatch(){
  if(_airefreshRunning) return;
  if(!_airefreshRetag && !_airefreshRetitle){ toast("Check Retag and/or Retitle first"); return; }
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); return; }
  const batch = aiRefreshCandidates().slice(0,200);
  if(!batch.length){ toast("Nothing eligible — every card was AI-refreshed within the last "+(S.aiRefreshDays||30)+" days."); return; }
  _airefreshRunning = true;
  const btn = document.getElementById("airefreshBtn");
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Processing…'; }
  let done = 0;
  try{
    for(let i=0; i<batch.length; i+=40){
      const chunk = batch.slice(i, i+40);
      // Retag failures propagate (matches autoTag's own error handling): a
      // chunk that fails stops the whole run here, un-stamped, so re-running
      // the batch naturally retries it instead of silently marking it done.
      if(_airefreshRetag) await aiTagChunk(chunk, {merge:true});
      if(_airefreshRetitle){
        for(const card of chunk){
          try{
            const result = await generateUniqueTitle(card, undefined, true);
            if(result && result.title) applyGeneratedTitle(card, result.title);
          }catch(e){ console.warn("AI refresh: retitle failed for one card", e); }
        }
      }
      chunk.forEach(card=>{ card.aiRefreshedAt = Date.now(); });
      done += chunk.length;
      Store.putCards(imported); persistAll();
      toast("AI refresh: "+done+"/"+batch.length+"…");
    }
    toast("AI refresh done — processed "+done+" card"+(done===1?"":"s"));
  }catch(e){
    console.error(e);
    toast((done ? done+" processed before an error: " : "AI refresh failed: ")+(IA_AI.creditsMessage(e) || e.message), 7000);
  } finally {
    _airefreshRunning = false;
  }
  if(curTab==="saved") renderSaved();
  renderImportedKeepFocus();
  if(_healthTab==="airefresh"){ const list=document.getElementById("healthList"); if(list) renderHealthAiRefresh(list); }
}
```

- [ ] **Step 4: Copy the identical change to `pwa/index.html`**

Verify with:

```bash
diff <(sed -n '/^async function runAiRefreshBatch/,/^}$/p' web/index.html) <(sed -n '/^async function runAiRefreshBatch/,/^}$/p' pwa/index.html)
```

Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/ai-refresh-batch.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/ai-refresh-batch.test.js
git commit -m "feat: implement runAiRefreshBatch, the AI-refresh Process button"
```

---

### Task 9: Parity manifest registration + full-suite verification

**Files:**
- Modify: `tests/surface-parity-manifest.js` (`indexContracts` array)

**Interfaces:**
- Consumes: nothing new — this task only registers already-shipped function names so `tests/surface-parity.test.js` keeps checking for them automatically on every future change.

- [ ] **Step 1: Add every new top-level `index.html` function from this plan to `indexContracts`**

In `tests/surface-parity-manifest.js`, change:
```js
  indexContracts: [
    "setCardImageDurably",
    "ingestImported",
    "drainCaptures",
    "renderPwaRecoveryStatus",
    "recoverPwaMerge",
    "imgHashSrcKey",
    "isDegenerateHash",
    "computeCardHash",
    "loadImgHashCache",
    "saveImgHashCache",
  ],
```
to:
```js
  indexContracts: [
    "setCardImageDurably",
    "ingestImported",
    "drainCaptures",
    "renderPwaRecoveryStatus",
    "recoverPwaMerge",
    "imgHashSrcKey",
    "isDegenerateHash",
    "computeCardHash",
    "loadImgHashCache",
    "saveImgHashCache",
    "applyGeneratedTitle",
    "clearTitleSuggestions",
    "aiTagChunk",
    "aiRefreshCandidates",
    "airefreshSetDays",
    "airefreshUpdateBtn",
    "renderHealthAiRefresh",
    "runAiRefreshBatch",
  ],
```

(`web/title-ai.js`/`pwa/title-ai.js` already appear in `exactPairs`, so `extractHashtags` needs no separate registration — the whole-file hash check already covers it.)

- [ ] **Step 2: Run the full test suite**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED. (If it reports `SOME TEST FILES FAILED` with no locatable `FAIL` line anywhere in the output, this is the known unattributed test-runner flake documented in this session's project memory — re-run once before treating it as a real regression.)

- [ ] **Step 3: Manual byte-identity spot-check across every function this plan touched or added**

```bash
for fn in applyGeneratedTitle clearTitleSuggestions aiTagChunk autoTag aiRefreshCandidates airefreshSetDays airefreshUpdateBtn renderHealthAiRefresh runAiRefreshBatch impRefreshTitle enrichOnOpen applyTitleSuggestions retryTitleSuggestion editTitleManually suggestTitlesForFlagged; do
  echo "-- $fn --"
  diff <(sed -n "/^\(async \)\?function $fn(/,/^}/p" web/index.html) <(sed -n "/^\(async \)\?function $fn(/,/^}/p" pwa/index.html)
done
diff web/title-ai.js pwa/title-ai.js
```

Expected: no output under any `-- $fn --` header, and no output from the `title-ai.js` diff. If anything differs, fix `pwa/index.html`/`pwa/title-ai.js` to match `web/` exactly before proceeding (the `web/` copy is always the source of truth in this project's convention).

- [ ] **Step 4: Commit**

```bash
git add tests/surface-parity-manifest.js
git commit -m "test: register new AI-refresh functions in the surface-parity manifest"
```
