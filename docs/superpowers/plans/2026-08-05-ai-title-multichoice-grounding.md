# AI Title Multi-Choice + Content Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick from several AI-generated title candidates (configurable count), ground title generation in real article body text instead of a thin `og:description`, and capture `#hashtags` from a title being overwritten (not just the new one) as tags — everywhere a card's title gets rewritten.

**Architecture:** Three additive, mostly-independent changes sharing call sites: (1) a new Settings number field plus a multi-candidate variant of the existing title-regeneration loop, rendered as clickable chips in the edit modal; (2) a new server-side excerpt extractor reusing `core/contentcheck.js`'s existing `extractText`, threaded through `/api/capture-meta` and into `generateUniqueTitle` as a richer alternative to `card.desc`; (3) a shared tag-merge helper applied to the *outgoing* title at the same 5 choke points the title-rollback feature already established for `origTitle` tracking.

**Tech Stack:** Vanilla JS (`web/index.html`, mirrored in `pwa/index.html`), Node/CommonJS backend (`core/`), plain-`assert` tests run via `node tests/run.js`.

**Design doc:** `docs/superpowers/specs/2026-08-05-ai-title-multichoice-grounding-design.md`

## Global Constraints

- `web/index.html` and `pwa/index.html` must stay functionally identical for every touched function — every web/index.html edit in this plan has a matching pwa/index.html edit. Locate the pwa counterpart by grepping for the same function/landmark name; its line numbers differ from web's.
- `buildTitlePrompt`/`parseTitleReply` in `web/title-ai.js` are NOT modified — grounding flows through the existing `description` prompt field only.
- No new field is persisted on cards — the grounding `excerpt` is transient, request-scoped only (never written to `card.desc` or any stored field).
- `S.aiTitleSuggestCount` is clamped to the range 1–5 wherever it's written; always read with an `||3` fallback.
- `pwa/sw.js`'s `SHELL_CACHE` constant must be bumped by +1 (Task 6) — this plan touches `pwa/index.html` across multiple tasks.
- Run `node tests/run.js` (syntax gate + full suite) after every task; it must be green before moving to the next task.

---

### Task 1: Settings — configurable AI title suggestion count

**Files:**
- Modify: `web/index.html` (DEFAULTS block ~line 884, AI Provider settings section ~line 590-601, `renderSettings()` wiring ~line 2050)
- Modify: `pwa/index.html` (same three edits, matching landmarks)
- Test: `tests/settings-wiring.test.js`

**Interfaces:**
- Produces: `S.aiTitleSuggestCount` (number, 1–5, default 3) — consumed by Task 5's `edAiTitle()`.

- [ ] **Step 1: Add the DEFAULTS entry in `web/index.html`**

In the `DEFAULTS` object (starts at `const DEFAULTS = {` around line 884), add a new line right after `backupRetainCount:3,`:

```js
  aiTitleSuggestCount:3,
```

- [ ] **Step 2: Add the same DEFAULTS entry in `pwa/index.html`**

Find `const DEFAULTS = {` in `pwa/index.html` and add the identical line in the same relative position (after `backupRetainCount:3,`).

- [ ] **Step 3: Add the Settings input markup in `web/index.html`**

In the "AI Provider" section (`<div class="sec"><h3>AI Provider</h3>...`), insert a new block right before that section's closing `</div>` (immediately after the existing `<div id="provFields"></div>` line):

```html
        <div class="row2" style="margin-top:12px;align-items:center">
          <div><label for="aiTitleSuggestCount">AI title suggestions to generate</label></div>
          <div style="flex:0 0 auto"><input type="number" id="aiTitleSuggestCount" min="1" max="5" step="1" style="width:80px"></div>
        </div>
```

- [ ] **Step 4: Add the identical markup in `pwa/index.html`**

Find the same "AI Provider" section in `pwa/index.html` (search for `<h3>AI Provider</h3>`) and insert the identical block in the same relative position.

- [ ] **Step 5: Wire the input in `web/index.html`'s `renderSettings()`**

Find the provider-model wiring block that ends with `if(S.provider==="local") document.getElementById("localUrl").oninput = ...` (around line 2050). Add immediately after it:

```js
  document.getElementById("aiTitleSuggestCount").value = S.aiTitleSuggestCount||3;
  document.getElementById("aiTitleSuggestCount").oninput = e=>{ S.aiTitleSuggestCount=Math.max(1,Math.min(5,+e.target.value||3)); save("settings",S); };
```

- [ ] **Step 6: Wire the same input in `pwa/index.html`**

Find the matching spot in `pwa/index.html`'s `renderSettings()` (same landmark: the `localUrl` provider wiring line) and add the identical two lines.

- [ ] **Step 7: Add tests to `tests/settings-wiring.test.js`**

This file already has a `for (const [label, src] of [["web", html], ["pwa", pwaHtml]])` loop with source-text-regex tests for `backupRetainCount` (see the `t(label + ": backupRetainCount default is 3", ...)` block). Add three matching tests inside the same loop, right after the `backupRetainCount` block:

```js
  t(label + ": aiTitleSuggestCount default is 3", () => {
    assert.match(src, /aiTitleSuggestCount:3,/, "DEFAULTS.aiTitleSuggestCount missing");
  });
  t(label + ": AI title suggestions number input exists with a sane range", () => {
    assert.match(src, /<input type="number" id="aiTitleSuggestCount" min="1" max="5"/, "input element missing or range changed");
  });
  t(label + ": aiTitleSuggestCount input clamps 1-5 and persists", () => {
    assert.match(src, /S\.aiTitleSuggestCount=Math\.max\(1,Math\.min\(5,\+e\.target\.value\|\|3\)\); save\("settings",S\);/,
      "oninput handler missing or no longer clamps/saves");
  });
```

- [ ] **Step 8: Run the full suite**

```bash
node tests/run.js
```

Expected: all tests pass, including the 3 new ones.

- [ ] **Step 9: Commit**

```bash
git add web/index.html pwa/index.html tests/settings-wiring.test.js
git commit -m "Add configurable AI title suggestion count setting"
```

---

### Task 2: Outgoing-title hashtag capture, app-wide

**Files:**
- Modify: `web/index.html` — `applyGeneratedTitle` (~6533), `cardEditSave` (~4863), `impEditSave` (~4994), `applyTitleSuggestions` (~7320), `enrichOnOpen` (~5193)
- Modify: `pwa/index.html` — same 5 functions, matching landmarks
- Test: `tests/hashtag-title-apply.test.js` (update existing sandbox), `tests/title-rollback-manual-edit.test.js` (update existing sandbox), `tests/title-issues-hashtags.test.js` (update existing sandbox), `tests/title-write-sites-hashtags.test.js` (add new coverage)

**Interfaces:**
- Produces: `mergeCleanTags(card, rawTags)` — pure, merges a cleaned/deduped/canonicalized tag list into `card.tags`. `captureOutgoingHashtags(card)` — extracts hashtags from `card.title` (before it's overwritten) and merges them via `mergeCleanTags`. Both consumed by every title-write site in this task.
- Consumes: `extractHashtags` (`web/title-ai.js`, already imported/available in both HTML files), `AI_TAB_TAG`, `canonicalTag`, `tagBadPattern` (existing globals in both HTML files).

- [ ] **Step 1: Add `mergeCleanTags` and `captureOutgoingHashtags`, refactor `applyGeneratedTitle`, in `web/index.html`**

Locate `applyGeneratedTitle` (~line 6533):

```js
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
  const newTitle = (extracted.title || rawTitle).slice(0,250);
  captureOrigTitle(card, newTitle);
  card.title = newTitle;
  settleOrigTitle(card);
  if(cleaned.length) card.tags = Array.from(new Set([...(card.tags||[]), ...cleaned]));
  return { title: card.title, tagsAdded: cleaned };
}
```

Replace it with:

```js
// Clean + merge a raw hashtag list into the card's tags (dedupe, canonicalize,
// filter AI_TAB_TAG and bad patterns) -- shared by both the incoming-AI-title
// path (applyGeneratedTitle below) and the outgoing-title path
// (captureOutgoingHashtags). Returns the cleaned list actually added.
function mergeCleanTags(card, rawTags){
  const seen=new Set(), cleaned=[];
  (rawTags||[]).forEach(t=>{
    if(t===AI_TAB_TAG) return;
    t=canonicalTag(t);
    const k=t.toLowerCase();
    if(seen.has(k)) return; seen.add(k);
    if(!tagBadPattern(t)) cleaned.push(t);
  });
  if(cleaned.length) card.tags = Array.from(new Set([...(card.tags||[]), ...cleaned]));
  return cleaned;
}
// Pull #hashtags out of a title about to be overwritten and add them as tags
// too -- the most common real source is a raw imported caption used as a
// fallback title, not the AI's own (rarely hashtag-laden) prose. No-op for a
// blank/missing title (nothing to scan).
function captureOutgoingHashtags(card){
  if(!card || !card.title) return;
  mergeCleanTags(card, extractHashtags(card.title).tags);
}
function applyGeneratedTitle(card, rawTitle){
  if(!rawTitle) return null;
  const extracted = extractHashtags(rawTitle);
  const newTitle = (extracted.title || rawTitle).slice(0,250);
  captureOutgoingHashtags(card);
  captureOrigTitle(card, newTitle);
  card.title = newTitle;
  settleOrigTitle(card);
  const cleaned = mergeCleanTags(card, extracted.tags);
  return { title: card.title, tagsAdded: cleaned };
}
```

Note the ordering: `captureOutgoingHashtags(card)` runs while `card.title` is still the OLD title (before `captureOrigTitle`/the assignment), then the new title's own hashtags are merged via `mergeCleanTags` afterward — both merges are additive to `card.tags`, so order between them doesn't matter, but `captureOutgoingHashtags` MUST run before `card.title = newTitle`.

- [ ] **Step 2: Apply the identical refactor in `pwa/index.html`**

Find `applyGeneratedTitle` in `pwa/index.html` and apply the same replacement.

- [ ] **Step 3: Wire `captureOutgoingHashtags` into `cardEditSave` in `web/index.html`**

Locate `cardEditSave` (~line 4863):

```js
async function cardEditSave(){
  const box = document.getElementById("edTitle"); if(!box) return;
  const title = box.value.trim();
  if(!title){ toast("Give the card a title first."); return; }
  const it = (saved||[]).find(x=>x && x.id===_edSavedId);
  if(!it){ toast("That card is no longer available."); closeGuide(); return; }
  captureOrigTitle(it, title.slice(0,250));
  it.title = title.slice(0,250); it.titleSet = true;
  settleOrigTitle(it);
  await Store.putSaved(saved);
  closeGuide();
  if(!refreshTabsViewIfShowing()) renderSaved();
  toast("Title updated");
}
```

Add `captureOutgoingHashtags(it);` right before `captureOrigTitle(it, title.slice(0,250));`:

```js
  captureOutgoingHashtags(it);
  captureOrigTitle(it, title.slice(0,250));
```

- [ ] **Step 4: Same change to `cardEditSave` in `pwa/index.html`**

- [ ] **Step 5: Wire `captureOutgoingHashtags` into `impEditSave` in `web/index.html`**

Locate `impEditSave` (~line 4994):

```js
  if(title){ captureOrigTitle(it, title); it.title=title; it.titleSet=true; settleOrigTitle(it); }
```

Replace with:

```js
  if(title){ captureOutgoingHashtags(it); captureOrigTitle(it, title); it.title=title; it.titleSet=true; settleOrigTitle(it); }
```

- [ ] **Step 6: Same change to `impEditSave` in `pwa/index.html`**

- [ ] **Step 7: Wire `captureOutgoingHashtags` into `applyTitleSuggestions`'s manual branch in `web/index.html`**

Locate the row-processing loop inside `applyTitleSuggestions` (~line 7320-7342):

```js
    const newTitle = _titleSuggestionsAI.has(key) ? val : val.slice(0,250);
    captureOrigTitle(card, newTitle);
    if(_titleSuggestionsAI.has(key)) applyGeneratedTitle(card, val);
    else card.title=val.slice(0,250);
    card.titleSet=true;
```

Replace with:

```js
    const newTitle = _titleSuggestionsAI.has(key) ? val : val.slice(0,250);
    if(!_titleSuggestionsAI.has(key)) captureOutgoingHashtags(card);
    captureOrigTitle(card, newTitle);
    if(_titleSuggestionsAI.has(key)) applyGeneratedTitle(card, val);
    else card.title=val.slice(0,250);
    card.titleSet=true;
```

The AI-origin branch (`applyGeneratedTitle(card, val)`) already calls `captureOutgoingHashtags` internally (Step 1) — guard against calling it twice by only calling it here for the manual (non-AI) branch.

- [ ] **Step 8: Same change to `applyTitleSuggestions` in `pwa/index.html`**

- [ ] **Step 9: Wire `captureOutgoingHashtags` into `enrichOnOpen`'s og-tag branch in `web/index.html`**

Locate the block inside `enrichOnOpen` (~line 5212-5218):

```js
          if(m.title && m.title.length>10 && isGenericTitle(it.title, it.url)){
            const newTitle = m.title.slice(0,250);
            captureOrigTitle(it, newTitle);
            it.title=newTitle;
            settleOrigTitle(it);
            changed=true;
          }
```

Replace with:

```js
          if(m.title && m.title.length>10 && isGenericTitle(it.title, it.url)){
            const newTitle = m.title.slice(0,250);
            captureOutgoingHashtags(it);
            captureOrigTitle(it, newTitle);
            it.title=newTitle;
            settleOrigTitle(it);
            changed=true;
          }
```

- [ ] **Step 10: Same change to `enrichOnOpen` in `pwa/index.html`**

- [ ] **Step 11: Update `tests/hashtag-title-apply.test.js`'s sandbox for the refactored `applyGeneratedTitle`**

The `loadApplyGeneratedTitle(src, vocab)` helper (near the top of the file) currently assembles:

```js
  const parts = {
    tagBadPattern: extractFn(src, "tagBadPattern"),
    canonicalTag: extractFn(src, "canonicalTag"),
    captureOrigTitle: extractFn(src, "captureOrigTitle"),
    settleOrigTitle: extractFn(src, "settleOrigTitle"),
    applyGeneratedTitle: extractFn(src, "applyGeneratedTitle"),
  };
```

`applyGeneratedTitle` now calls `mergeCleanTags` and `captureOutgoingHashtags`, both new top-level functions not yet in this sandbox — add them:

```js
  const parts = {
    tagBadPattern: extractFn(src, "tagBadPattern"),
    canonicalTag: extractFn(src, "canonicalTag"),
    captureOrigTitle: extractFn(src, "captureOrigTitle"),
    settleOrigTitle: extractFn(src, "settleOrigTitle"),
    mergeCleanTags: extractFn(src, "mergeCleanTags"),
    captureOutgoingHashtags: extractFn(src, "captureOutgoingHashtags"),
    applyGeneratedTitle: extractFn(src, "applyGeneratedTitle"),
  };
```

No other change needed in this file — the existing tests still pass unchanged (`captureOutgoingHashtags` reading a title with no hashtags is a no-op). Add one new test right after the existing "strips hashtags from the title and adds them as tags" test, proving the new behavior:

```js
  t(label + ": applyGeneratedTitle also captures hashtags from the OUTGOING title being replaced", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "Old Caption #vintage", tags: [] };
    const out = applyGeneratedTitle(card, "New AI Title");
    assert.strictEqual(card.title, "New AI Title");
    assert.deepStrictEqual(card.tags, ["vintage"]);
    assert.deepStrictEqual(out.tagsAdded, [], "tagsAdded reflects only the NEW title's own hashtags, not the outgoing one's");
  });
```

- [ ] **Step 12: Update `tests/title-rollback-manual-edit.test.js`'s sandbox for `cardEditSave`/`impEditSave`**

The `loadFn(src, name, extraFreeVars)` helper currently assembles:

```js
function loadFn(src, name, extraFreeVars) {
  const parts = { captureOrigTitle: extractFn(src, "captureOrigTitle"), settleOrigTitle: extractFn(src, "settleOrigTitle"), [name]: extractFn(src, name) };
  Object.keys(parts).forEach(k => assert.ok(parts[k], k + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function(...(extraFreeVars || []), body + "\nreturn " + name + ";");
  return factory;
}
```

`cardEditSave`/`impEditSave` now call `captureOutgoingHashtags`, which calls `mergeCleanTags` and `extractHashtags` (the last is imported from `web/title-ai.js`, not extracted from HTML source). Update the helper:

```js
function loadFn(src, name, extraFreeVars) {
  const parts = {
    captureOrigTitle: extractFn(src, "captureOrigTitle"),
    settleOrigTitle: extractFn(src, "settleOrigTitle"),
    mergeCleanTags: extractFn(src, "mergeCleanTags"),
    captureOutgoingHashtags: extractFn(src, "captureOutgoingHashtags"),
    [name]: extractFn(src, name),
  };
  Object.keys(parts).forEach(k => assert.ok(parts[k], k + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function("extractHashtags", "AI_TAB_TAG", "canonicalTag", "tagBadPattern", ...(extraFreeVars || []), body + "\nreturn " + name + ";");
  return factory;
}
```

Add the import at the top of the file (alongside the existing `require`s):

```js
const { extractHashtags } = require("../web/title-ai.js");
```

Every existing call site does `factory(document, ...)` — since the new `extraFreeVars`-independent params (`extractHashtags, AI_TAB_TAG, canonicalTag, tagBadPattern`) were added BEFORE `...extraFreeVars` in the parameter list, every existing `factory(...)` call in this file must be updated to pass them first. For each of the 6 existing `factory(...)` calls in this file, change e.g.:

```js
const cardEditSave = factory(document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
```

to:

```js
const cardEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
```

(stub `canonicalTag` as identity-lowercase and `tagBadPattern` as always-false — these tests don't exercise tag-cleaning edge cases, they only need `captureOutgoingHashtags` to not throw when the fixture titles have no hashtags). Apply the same prefix to the `impEditSave` factory calls. Add one new test proving the behavior, e.g. after the existing "cardEditSave captures origTitle on the first manual rename" test:

```js
  await t(label + ": cardEditSave captures hashtags from the outgoing title as tags", async () => {
    const it = { id: "s1", title: "Old #vintage", tags: [] };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.deepStrictEqual(it.tags, ["vintage"]);
  });
```

- [ ] **Step 13: Update `tests/title-issues-hashtags.test.js`'s sandbox for `applyTitleSuggestions`'s manual branch**

Add the import at the top of the file:

```js
const { extractHashtags } = require("../web/title-ai.js");
```

In the second test ("applyTitleSuggestions writes a hand-edited row verbatim, hashtag and all"), the `body` array currently is:

```js
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "clearTitleSuggestions") || "function clearTitleSuggestions(){ _titleSuggestions={}; _titleSuggestionsAI=new Set(); }",
      extractFn(src, "captureOrigTitle"),
      extractFn(src, "settleOrigTitle"),
      extractFn(src, "applyTitleSuggestions"),
    ].join("\n");
    const factory = new Function(
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab",
      body + "\nreturn applyTitleSuggestions;"
    );
```

Update to:

```js
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "clearTitleSuggestions") || "function clearTitleSuggestions(){ _titleSuggestions={}; _titleSuggestionsAI=new Set(); }",
      extractFn(src, "captureOrigTitle"),
      extractFn(src, "settleOrigTitle"),
      extractFn(src, "mergeCleanTags"),
      extractFn(src, "captureOutgoingHashtags"),
      extractFn(src, "applyTitleSuggestions"),
    ].join("\n");
    const factory = new Function(
      "extractHashtags", "AI_TAB_TAG", "canonicalTag", "tagBadPattern",
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab",
      body + "\nreturn applyTitleSuggestions;"
    );
```

and its `factory(...)` call from:

```js
    const applyTitleSuggestions = factory(
      document, imported, saved, applyGeneratedTitle,
      () => {}, { putSaved: () => {} }, () => {}, "dupes"
    );
```

to:

```js
    const applyTitleSuggestions = factory(
      extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false,
      document, imported, saved, applyGeneratedTitle,
      () => {}, { putSaved: () => {} }, () => {}, "dupes"
    );
```

The first test ("applyTitleSuggestions runs applyGeneratedTitle for an AI-origin row") does NOT exercise the manual branch (it stubs `applyGeneratedTitle` and never reaches the `captureOutgoingHashtags` call), so its `body`/factory can stay as-is — leave it unchanged. Then update the existing "hand-edited row verbatim" assertion's fixture and add a new assertion proving outgoing-hashtag capture on that same row: change the card's starting title from `"old"` to `"old #legacy"`:

```js
  await t(label + ": applyTitleSuggestions writes a hand-edited row verbatim, hashtag and all", () => {
    const imported = [{ id: "i1", title: "old #legacy", tags: [] }];
    ...
    applyTitleSuggestions();
    assert.strictEqual(imported[0].title, "My Own Title #keepit");
    assert.deepStrictEqual(imported[0].tags, ["legacy"], "the OUTGOING title's hashtag becomes a tag; the new (manually typed) title's #keepit stays literal");
    assert.strictEqual(imported[0].origTitle, "old #legacy", "a hand-edited (non-AI) suggestion must still capture the pre-write title");
```

(update the `assert.strictEqual(imported[0].origTitle, "old", ...)` line similarly to `"old #legacy"`.)

- [ ] **Step 14: Add a new test in `tests/title-write-sites-hashtags.test.js` for `enrichOnOpen`'s og-tag branch**

The existing `enrichOnOpen` test in this file only exercises the Facebook URL path (which skips the og-tag branch entirely via `isFb=true`). Add a new test after it, exercising the non-Facebook og-tag branch with `captureOutgoingHashtags` stubbed (not extracted for real — matching this file's existing convention of stubbing `applyGeneratedTitle` rather than extracting it):

```js
  await t(label + ": enrichOnOpen's metadata-title branch captures hashtags from the outgoing title", async () => {
    const it = { id: "c1", title: "Old Post #throwback", desc: "a real description", url: "https://example.test/article", tags: [] };
    const isGenericTitle = () => true;
    let capturedFrom = null;
    const captureOutgoingHashtags = (card) => { capturedFrom = card.title; card.tags = ["throwback"]; };
    const captureOrigTitle = () => {};
    const settleOrigTitle = () => {};
    const factory = new Function(
      "Store", "isGenericTitle", "setCardImage", "isBadImg", "fetchMicrolink", "Image",
      "IA_AI", "callAI", "generateUniqueTitle", "applyGeneratedTitle", "captureOutgoingHashtags", "captureOrigTitle", "settleOrigTitle", "imported",
      "curTab", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast", "document",
      extractFn(src, "enrichOnOpen") + "\nreturn enrichOnOpen;"
    );
    const enrichOnOpen = factory(
      { putCards: () => {}, captureMeta: async () => [{ id: "c1", title: "A Real Page Title From The Site", description: "", hasImage: false }] },
      isGenericTitle, () => {}, () => false, async () => null, function(){},
      { hasAIKey: () => false }, async () => "", async () => ({ title: null }), () => {}, captureOutgoingHashtags, captureOrigTitle, settleOrigTitle, [],
      "imported", () => {}, () => {}, () => false, () => {}, { addEventListener: () => {} }
    );
    await enrichOnOpen(it, 0);
    assert.strictEqual(capturedFrom, "Old Post #throwback");
    assert.deepStrictEqual(it.tags, ["throwback"]);
  });
```

- [ ] **Step 15: Run the full suite**

```bash
node tests/run.js
```

Expected: all tests pass, including every updated/new test above. If a `ReferenceError` appears naming a function not found in the sandbox, it means a sandbox in one of the 4 updated test files is still missing a function this task added — cross-check against the specific `parts`/free-var list shown in Steps 11-14.

- [ ] **Step 16: Commit**

```bash
git add web/index.html pwa/index.html tests/hashtag-title-apply.test.js tests/title-rollback-manual-edit.test.js tests/title-issues-hashtags.test.js tests/title-write-sites-hashtags.test.js
git commit -m "Capture hashtags from outgoing titles as tags, at every title-write site"
```

---

### Task 3: Server-side article excerpt extraction

**Files:**
- Modify: `core/capturemeta.js` (add `extractArticleExcerpt`, wire into `captureMetaChunk`)
- Modify: `core/server.js` (add `excerpt` to the `/api/capture-meta` response, ~line 1059)
- Test: `tests/capturemeta.test.js` (add unit tests), `tests/capture-meta-endpoint.test.js` (add integration test)

**Interfaces:**
- Produces: `extractArticleExcerpt(html) -> string` (exported from `core/capturemeta.js`, pure). `captureMetaChunk`'s per-item result gains an `excerpt` field. `/api/capture-meta`'s JSON response's `results[]` items gain an `excerpt` field. Consumed by Task 4.

- [ ] **Step 1: Add `extractArticleExcerpt` to `core/capturemeta.js`**

Add this new function right after `extractOg` (before the `var gf = require("./guardedfetch");` line, ~line 27):

```js
// Extract a longer excerpt of real page content for AI title-grounding (Task 4
// of the AI-title-multichoice-grounding plan consumes this) -- distinct from
// extractOg's short og:description, which is often thin, generic, or entirely
// absent. Prefers <p> tag text (article bodies are <p>-heavy; nav/footer
// chrome usually isn't) and falls back to contentcheck's whole-page flatten
// for pages that don't use <p> tags. Lazy require of contentcheck for the
// same load-time-cycle reason captureMetaChunk already documents below.
function extractArticleExcerpt(html) {
  var h = String(html || "");
  if (h.length > 300000) h = h.slice(0, 300000);
  var paras = h.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
  var joined = paras.map(function (p) {
    return p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }).filter(Boolean).join(" ");
  var text = joined.length >= 200 ? joined : require("./contentcheck").extractText(h, 1500);
  return text.length > 1500 ? text.slice(0, 1500) : text;
}
```

- [ ] **Step 2: Wire it into `captureMetaChunk` and export it**

Locate the success-path return in `captureMetaChunk` (~line 91-108):

```js
      var og = extractOg(page.html);
      var imageDataUrl = "";
```

Add right after `var og = extractOg(page.html);`:

```js
      var excerpt = page.html ? extractArticleExcerpt(page.html) : "";
```

Then update the 4 `return` statements in `captureMetaChunk` to include `excerpt`:

- Skipped-host return (~line 76): `return { id: it.id, skipped: true, imageDataUrl: "", title: "", description: "", excerpt: "", reason: skipReason };`
- Not-found return (~line 89): `return { id: it.id, imageDataUrl: "", imageUrl: "", title: "", description: "", excerpt: "", reason: "notfound" };`
- Success return (~line 108): `return { id: it.id, imageDataUrl: imageDataUrl, imageUrl: imageUrl, title: og.title, description: og.description, excerpt: excerpt, reason: reason };`
- Catch-block return (~line 110): `return { id: it.id, imageDataUrl: "", title: "", description: "", excerpt: "", reason: "unreachable" };`

Update the final export line:

```js
module.exports = { extractOg: extractOg, extractArticleExcerpt: extractArticleExcerpt, captureMetaChunk: captureMetaChunk };
```

- [ ] **Step 3: Add `excerpt` to the `/api/capture-meta` route response in `core/server.js`**

Locate the route (~line 1047-1066):

```js
      const results = found.map((r) => {
        let hasImage = false;
        if (r && r.imageDataUrl) {
          try { images.putImg(ctx.storeDir, r.id, r.imageDataUrl); hasImage = true; }
          catch (e) { console.error("capture-meta putImg failed:", e && e.message); }
        }
        const imageUrl = (!hasImage && r && /^https?:\/\//i.test(r.imageUrl || "")) ? r.imageUrl : "";
        return { id: r && r.id, hasImage: hasImage, imageUrl: imageUrl, title: (r && r.title) || "", description: (r && r.description) || "", reason: (hasImage || imageUrl) ? "" : ((r && r.reason) || "unreachable") };
      });
```

Change the returned object to add `excerpt`:

```js
        return { id: r && r.id, hasImage: hasImage, imageUrl: imageUrl, title: (r && r.title) || "", description: (r && r.description) || "", excerpt: (r && r.excerpt) || "", reason: (hasImage || imageUrl) ? "" : ((r && r.reason) || "unreachable") };
```

- [ ] **Step 4: Add unit tests to `tests/capturemeta.test.js`**

Add these tests after the existing `extractOg` tests, before the `console.log` line:

```js
t("extractArticleExcerpt joins <p> tag text and strips inner tags", () => {
  const html = "<html><body><nav>Menu Home About</nav>" +
    "<p>This is the <b>first</b> real paragraph of the article, long enough to count as real content for grounding purposes here.</p>" +
    "<p>And a second paragraph continuing the same thought with more real substance about the actual topic.</p>" +
    "</body></html>";
  const r = cm.extractArticleExcerpt(html);
  assert.ok(r.indexOf("first real paragraph") >= 0, "should include first <p> text: " + r);
  assert.ok(r.indexOf("second paragraph") >= 0, "should include second <p> text: " + r);
  assert.ok(r.indexOf("<b>") === -1, "inner tags must be stripped");
  assert.ok(r.indexOf("Menu Home About") === -1, "must prefer <p> text over nav chrome when <p> content is substantial");
});
t("extractArticleExcerpt falls back to whole-page text when there's little/no <p> content", () => {
  const html = "<html><body><div>Real article text with no paragraph tags at all, just a div wrapping everything the page actually says about its topic.</div></body></html>";
  const r = cm.extractArticleExcerpt(html);
  assert.ok(r.indexOf("Real article text") >= 0, "should fall back to contentcheck.extractText: " + r);
});
t("extractArticleExcerpt caps at 1500 chars", () => {
  const html = "<p>" + "word ".repeat(2000) + "</p>";
  const r = cm.extractArticleExcerpt(html);
  assert.ok(r.length <= 1500, "got length " + r.length);
});
t("extractArticleExcerpt empty for empty/null input", () => {
  assert.strictEqual(cm.extractArticleExcerpt(""), "");
  assert.strictEqual(cm.extractArticleExcerpt(null), "");
});
```

- [ ] **Step 5: Run the capturemeta unit tests directly**

```bash
node tests/capturemeta.test.js
```

Expected: all pass, 0 failed.

- [ ] **Step 6: Add an integration test to `tests/capture-meta-endpoint.test.js`**

Add this test after the existing `"POST /api/capture-meta writes the image file + returns hasImage/title"` test:

```js
  await t("POST /api/capture-meta returns an article excerpt extracted from <p> tags", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/png" : null }, arrayBuffer: async () => new Uint8Array([137,80,78,71]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/p.png"><title>Hi</title><p>A real paragraph of article body text, long enough to be picked up as the grounding excerpt for this test case here.</p>' };
    };
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"e1", url:"https://example.test/excerpt-page" }] });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.results[0].excerpt.indexOf("real paragraph of article body text") >= 0, "got: " + r.json.results[0].excerpt);
  });
```

Note: this test must run before the later tests in this file reassign `global.fetch` to responses without `<p>` tags — placing it immediately after the first test (as instructed above) keeps it isolated.

- [ ] **Step 7: Run the endpoint test directly**

```bash
node tests/capture-meta-endpoint.test.js
```

Expected: all pass, 0 failed.

- [ ] **Step 8: Run the full suite**

```bash
node tests/run.js
```

- [ ] **Step 9: Commit**

```bash
git add core/capturemeta.js core/server.js tests/capturemeta.test.js tests/capture-meta-endpoint.test.js
git commit -m "Extract real article-body excerpt server-side for AI title grounding"
```

---

### Task 4: Ground title generation in the article excerpt

**Files:**
- Modify: `web/index.html` — `generateUniqueTitle` (~6470), `regenerateTitleFor` (~7147), `enrichOnOpen` (~5193)
- Modify: `pwa/index.html` — same 3 functions, matching landmarks
- Test: `tests/title-tiers-structural.test.js` or a new `tests/title-grounding.test.js` (create if no existing file fits — see Step 6)

**Interfaces:**
- Produces: `generateUniqueTitle(card, extraAvoid, allowVision, groundingText)` — new optional 4th param. `fetchGroundingExcerpt(card)` — new helper, calls `Store.captureMeta` and returns `.excerpt` or `""`. Consumed by Task 5's `regenerateTitleChoices`.
- Consumes: `Store.captureMeta` (existing, `web/storage.js:211`), the `excerpt` field added to its response in Task 3.

- [ ] **Step 1: Add the `groundingText` param to `generateUniqueTitle` in `web/index.html`**

Locate (~line 6470):

```js
async function generateUniqueTitle(card, extraAvoid, allowVision=true){
  if(!IA_AI.hasAIKey()) return { title: null, failReason: "" };
  const rawDesc = card.desc || card.benefit || "";
  // "Saved from Facebook"/"From your <list>" is placeholder boilerplate set at capture
  // time (see enrichOnOpen), not real content — treat it as no description, same as
  // the "is this a real description" check elsewhere in this file.
  const description = (rawDesc && !rawDesc.startsWith("Saved from") && !rawDesc.startsWith("From your")) ? rawDesc : "";
```

Change to:

```js
async function generateUniqueTitle(card, extraAvoid, allowVision=true, groundingText=""){
  if(!IA_AI.hasAIKey()) return { title: null, failReason: "" };
  const rawDesc = card.desc || card.benefit || "";
  // "Saved from Facebook"/"From your <list>" is placeholder boilerplate set at capture
  // time (see enrichOnOpen), not real content — treat it as no description, same as
  // the "is this a real description" check elsewhere in this file. A non-empty
  // groundingText (a freshly-fetched article excerpt) always wins over card.desc —
  // it's fresher and richer by construction; card.desc itself is never written from it.
  const description = groundingText || ((rawDesc && !rawDesc.startsWith("Saved from") && !rawDesc.startsWith("From your")) ? rawDesc : "");
```

(The video-caption-OCR branch immediately below this still runs first and unconditionally, unaffected — it only reads `card`, not `description`.)

- [ ] **Step 2: Same change to `generateUniqueTitle` in `pwa/index.html`**

- [ ] **Step 3: Add `fetchGroundingExcerpt` and wire it into `regenerateTitleFor` in `web/index.html`**

Add this new function right before `regenerateTitleFor` (~line 7147):

```js
// Fetch a longer real-content excerpt (Core-side, SSRF-guarded) to ground AI
// title generation -- richer than the thin og:description card.desc may
// hold. Failure/no-URL/social-host all resolve to "", silently falling back
// to today's card.desc/OCR/vision/fallback tiers -- no new error states.
async function fetchGroundingExcerpt(card){
  if(!card || !card.url) return "";
  try{
    const res = await Store.captureMeta([{id:card.id, url:card.url}]);
    const m = res && res[0];
    return (m && m.excerpt) || "";
  }catch(e){ return ""; }
}
```

Then locate `regenerateTitleFor` (~line 7147):

```js
async function regenerateTitleFor(card, extraAvoid, busyLabel){
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); return null; }
  showBusyOverlay(busyLabel||"Generating a new title…");
  await new Promise(r=>requestAnimationFrame(r));
  let out=null, failReason="";
  try{
    const result = await generateUniqueTitle(card, extraAvoid);
    out = (result && result.title) || null;
    failReason = (result && result.failReason) || "";
  }
  catch(e){ console.warn("title regeneration failed", e); }
  hideBusyOverlay();
```

Change to:

```js
async function regenerateTitleFor(card, extraAvoid, busyLabel){
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); return null; }
  showBusyOverlay(busyLabel||"Generating a new title…");
  await new Promise(r=>requestAnimationFrame(r));
  let out=null, failReason="";
  try{
    const groundingText = await fetchGroundingExcerpt(card);
    const result = await generateUniqueTitle(card, extraAvoid, true, groundingText);
    out = (result && result.title) || null;
    failReason = (result && result.failReason) || "";
  }
  catch(e){ console.warn("title regeneration failed", e); }
  hideBusyOverlay();
```

- [ ] **Step 4: Same changes (`fetchGroundingExcerpt` + `regenerateTitleFor` wiring) to `pwa/index.html`**

- [ ] **Step 5: Pass grounding through in `enrichOnOpen` in `web/index.html`**

Locate the top of `enrichOnOpen` (~line 5193-5196):

```js
async function enrichOnOpen(it, idx){
  try{
    let changed=false;
    const isFb = /facebook\.com|fb\.watch/.test(it.url);
```

Add a `groundingExcerpt` variable:

```js
async function enrichOnOpen(it, idx){
  try{
    let changed=false;
    let groundingExcerpt = "";
    const isFb = /facebook\.com|fb\.watch/.test(it.url);
```

Locate where `m` is read (~line 5204-5206):

```js
        const res = await Store.captureMeta([{id:it.id, url:it.url}]);
        const m = res && res[0];
        if(m){
```

Add right after `if(m){`:

```js
        const res = await Store.captureMeta([{id:it.id, url:it.url}]);
        const m = res && res[0];
        if(m){
          groundingExcerpt = m.excerpt || "";
```

Locate the title-generation branch (~line 5254-5259):

```js
    if(isGenericTitle(it.title, it.url)){
      try{
        const suggested = await generateUniqueTitle(it, undefined, false);
        if(suggested && suggested.title){ applyGeneratedTitle(it, suggested.title); changed=true; }
      }catch(e){ console.warn("AI title generation failed",e); }
    }
```

Change to pass `groundingExcerpt` as the 4th arg:

```js
    if(isGenericTitle(it.title, it.url)){
      try{
        const suggested = await generateUniqueTitle(it, undefined, false, groundingExcerpt);
        if(suggested && suggested.title){ applyGeneratedTitle(it, suggested.title); changed=true; }
      }catch(e){ console.warn("AI title generation failed",e); }
    }
```

- [ ] **Step 6: Same 3 changes to `enrichOnOpen` in `pwa/index.html`**

- [ ] **Step 7: Verify `tests/title-write-sites-hashtags.test.js`'s existing `enrichOnOpen` tests still pass unchanged**

That file's existing `enrichOnOpen` sandbox stubs `generateUniqueTitle` as `async () => ({ title: "New Title #diy" })` (ignores its arguments) — unaffected by the new 4th positional arg. The Task 2 Step 14 test added to this same file stubs `generateUniqueTitle` with a fixed `async () => ({ title: null })` — also unaffected. No changes needed to this file for Task 4; just confirm via the full suite run in Step 9 below.

- [ ] **Step 8: Add `tests/title-grounding.test.js`**

Create this new test file:

```js
// tests/title-grounding.test.js — generateUniqueTitle prefers a freshly-fetched
// groundingText excerpt over card.desc when both are present; regenerateTitleFor
// fetches it via Store.captureMeta before generating.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": generateUniqueTitle uses groundingText instead of card.desc when both are present", async () => {
    let seenDescription = null;
    const factory = new Function(
      "IA_AI", "looksLikeVideo", "ocrExtractText", "titleFromSignal", "extractWeakContext", "resolveCardImageForAI",
      extractFn(src, "generateUniqueTitle") + "\nreturn generateUniqueTitle;"
    );
    const generateUniqueTitle = factory(
      { hasAIKey: () => true },
      () => false,
      async () => null,
      async (card, opts) => { seenDescription = opts.description; return "Resulting Title"; },
      () => ({ collection: "" }),
      async () => null
    );
    const card = { desc: "thin og description", url: "https://example.test/x" };
    await generateUniqueTitle(card, [], true, "A much richer article excerpt fetched fresh from the page.");
    assert.strictEqual(seenDescription, "A much richer article excerpt fetched fresh from the page.");
  });

  await t(label + ": generateUniqueTitle falls back to card.desc when groundingText is empty", async () => {
    let seenDescription = null;
    const factory = new Function(
      "IA_AI", "looksLikeVideo", "ocrExtractText", "titleFromSignal", "extractWeakContext", "resolveCardImageForAI",
      extractFn(src, "generateUniqueTitle") + "\nreturn generateUniqueTitle;"
    );
    const generateUniqueTitle = factory(
      { hasAIKey: () => true },
      () => false,
      async () => null,
      async (card, opts) => { seenDescription = opts.description; return "Resulting Title"; },
      () => ({ collection: "" }),
      async () => null
    );
    const card = { desc: "a real usable description", url: "https://example.test/x" };
    await generateUniqueTitle(card, [], true, "");
    assert.strictEqual(seenDescription, "a real usable description");
  });

  await t(label + ": regenerateTitleFor fetches grounding via Store.captureMeta before generating", async () => {
    let capturedArg = null, seenGrounding = null;
    const factory = new Function(
      "IA_AI", "PROVIDERS", "S", "toast", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame", "Store", "generateUniqueTitle",
      extractFn(src, "fetchGroundingExcerpt") + "\n" + extractFn(src, "regenerateTitleFor") + "\nreturn regenerateTitleFor;"
    );
    const regenerateTitleFor = factory(
      { hasAIKey: () => true }, { anthropic: { keyName: "key" } }, { provider: "anthropic" },
      () => {}, () => {}, () => {}, (cb) => cb(),
      { captureMeta: async (items) => { capturedArg = items; return [{ id: items[0].id, excerpt: "fetched excerpt text" }]; } },
      async (card, extraAvoid, allowVision, groundingText) => { seenGrounding = groundingText; return { title: "New Title", failReason: "" }; }
    );
    const out = await regenerateTitleFor({ id: "c1", url: "https://example.test/y" }, [], "");
    assert.strictEqual(out, "New Title");
    assert.deepStrictEqual(capturedArg, [{ id: "c1", url: "https://example.test/y" }]);
    assert.strictEqual(seenGrounding, "fetched excerpt text");
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 9: Run the full suite**

```bash
node tests/run.js
```

Expected: all tests pass, including the new `title-grounding.test.js`.

- [ ] **Step 10: Commit**

```bash
git add web/index.html pwa/index.html tests/title-grounding.test.js
git commit -m "Ground AI title generation in a fetched article excerpt instead of thin og:description"
```

---

### Task 5: Multi-choice title picker

**Files:**
- Modify: `web/index.html` — `edAiTitle` (~4881), edit-modal templates in `impEdit` (~4809-4812) and `cardEdit` (~4851-4854)
- Modify: `pwa/index.html` — same functions/templates, matching landmarks
- Test: `tests/title-multichoice.test.js` (new)

**Interfaces:**
- Produces: `regenerateTitleChoices(card, extraAvoid, count)` — returns `Promise<string[]>`, up to `count` distinct candidates. `renderTitleChoices(list)`, `edPickTitleChoice(el)` — DOM helpers for the new `#edTitleChoices` chip picker. `titleFailReasonMessage(failReason)` — shared toast-message helper, factored out of `regenerateTitleFor`'s existing inline ternary and reused by `regenerateTitleChoices`.
- Consumes: `S.aiTitleSuggestCount` (Task 1), `generateUniqueTitle`'s `groundingText` param and `fetchGroundingExcerpt` (Task 4).

- [ ] **Step 1: Add `#edTitleChoices` to both edit-modal templates in `web/index.html`**

In `impEdit` (~line 4812):

```js
    <input type="text" id="edTitle" value="${esc(it.title||"")}">
```

Change to:

```js
    <input type="text" id="edTitle" value="${esc(it.title||"")}">
    <div id="edTitleChoices"></div>
```

In `cardEdit` (~line 4854), the identical change:

```js
    <input type="text" id="edTitle" value="${esc(it.title||"")}">
    <div id="edTitleChoices"></div>
```

- [ ] **Step 2: Same two markup changes in `pwa/index.html`**

- [ ] **Step 3: Factor out `titleFailReasonMessage` and rewrite `regenerateTitleFor` to use it in `web/index.html`**

Locate `regenerateTitleFor` (post-Task-4 shape, ~line 7147):

```js
  hideBusyOverlay();
  if(!out){
    const why = failReason === "fetch-blocked"
      ? "Couldn't load that card's picture — the site may be blocking it, or it may be gone."
      : failReason === "decode-failed"
      ? "That card's picture couldn't be read."
      : failReason === "no-image"
      ? "That card has no picture to read a title from."
      : "Couldn't generate a title — check your AI key, credits, and rate limits.";
    toast(why, 7000);
  }
  return out;
}
```

Add `titleFailReasonMessage` right before `regenerateTitleFor`:

```js
// Shared fail-reason -> toast message, used by both regenerateTitleFor (one
// candidate) and regenerateTitleChoices (up to N candidates).
function titleFailReasonMessage(failReason){
  return failReason === "fetch-blocked" ? "Couldn't load that card's picture — the site may be blocking it, or it may be gone."
    : failReason === "decode-failed" ? "That card's picture couldn't be read."
    : failReason === "no-image" ? "That card has no picture to read a title from."
    : "Couldn't generate a title — check your AI key, credits, and rate limits.";
}
```

And change the `if(!out){...}` block to use it:

```js
  hideBusyOverlay();
  if(!out) toast(titleFailReasonMessage(failReason), 7000);
  return out;
}
```

- [ ] **Step 4: Add `regenerateTitleChoices` right after `regenerateTitleFor` in `web/index.html`**

```js
// Generates up to `count` distinct AI title candidates for the multi-choice
// picker (edAiTitle). Grounding is fetched ONCE and reused across every
// attempt -- it's a property of the source article, not of any one attempt.
// Each successful candidate is added to the avoid-list before the next
// attempt, reusing titleFromSignal's existing collision-avoidance. Returns
// fewer than `count` (never padded) when an attempt fails the quality gate
// -- no title beats a bad one, same philosophy as every other tier here.
async function regenerateTitleChoices(card, extraAvoid, count){
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); return []; }
  showBusyOverlay("Looking up a better title…");
  await new Promise(r=>requestAnimationFrame(r));
  const groundingText = await fetchGroundingExcerpt(card);
  const avoid = (extraAvoid||[]).slice();
  const out = [];
  let failReason = "";
  try{
    for(let i=0;i<count;i++){
      const result = await generateUniqueTitle(card, avoid, true, groundingText);
      const title = result && result.title;
      if(!title){ if(!out.length) failReason = (result && result.failReason)||""; break; }
      out.push(title);
      avoid.push(title);
    }
  }catch(e){ console.warn("title choices generation failed", e); }
  hideBusyOverlay();
  if(!out.length) toast(titleFailReasonMessage(failReason), 7000);
  return out;
}
```

- [ ] **Step 5: Same 2 additions (`titleFailReasonMessage` refactor + `regenerateTitleChoices`) to `pwa/index.html`**

- [ ] **Step 6: Add `renderTitleChoices`/`edPickTitleChoice` and rewrite `edAiTitle` in `web/index.html`**

Locate `edAiTitle` (~line 4881):

```js
async function edAiTitle(){
  const box = document.getElementById("edTitle"); if(!box) return;
  const card = _edScope==="saved"
    ? saved.find(x=>x && x.id===_edSavedId)
    : imported[_editIdx];
  if(!card){ toast("That card is no longer available."); return; }
  const out = await regenerateTitleFor(card, [box.value.trim()].filter(Boolean), "Looking up a better title…");
  if(!out) return;
  box.value = out.slice(0,250);
  box.focus();
  toast("Title suggested — edit it if you like, then Save changes.", 6000);
}
```

Replace with:

```js
async function edAiTitle(){
  const box = document.getElementById("edTitle"); if(!box) return;
  const card = _edScope==="saved"
    ? saved.find(x=>x && x.id===_edSavedId)
    : imported[_editIdx];
  if(!card){ toast("That card is no longer available."); return; }
  renderTitleChoices([]);
  const choices = await regenerateTitleChoices(card, [box.value.trim()].filter(Boolean), S.aiTitleSuggestCount||3);
  if(!choices.length) return;
  box.value = choices[0].slice(0,250);
  box.focus();
  renderTitleChoices(choices);
  toast(choices.length>1 ? "Pick a suggestion below, or edit it, then Save changes." : "Title suggested — edit it if you like, then Save changes.", 6000);
}
// Renders the multi-choice picker's candidate chips below the title input.
// Clicking a chip stages it into the input -- same "nothing written until
// Save" contract as the rest of the edit modal.
function renderTitleChoices(list){
  const box = document.getElementById("edTitleChoices"); if(!box) return;
  box.innerHTML = (list && list.length)
    ? `<div class="hint" style="margin:8px 0 4px">Suggestions (click to use):</div>
       <div class="tagwrap">${list.map(t=>`<span class="catpill" onclick="edPickTitleChoice(this)" data-title="${esc(t).replace(/"/g,"&quot;")}">${esc(t)}</span>`).join("")}</div>`
    : "";
}
function edPickTitleChoice(el){
  const box = document.getElementById("edTitle"); if(!box) return;
  box.value = el.getAttribute("data-title")||"";
  box.focus();
}
```

- [ ] **Step 7: Same 3 additions/rewrite to `pwa/index.html`**

- [ ] **Step 8: Add `tests/title-multichoice.test.js`**

```js
// tests/title-multichoice.test.js — regenerateTitleChoices generates up to
// `count` distinct candidates (never padded on partial failure), and
// edAiTitle wires it into the edit modal's chip picker.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": regenerateTitleChoices returns up to `count` candidates, each avoiding all prior ones", async () => {
    const seenAvoid = [];
    const factory = new Function(
      "IA_AI", "toast", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame",
      "fetchGroundingExcerpt", "generateUniqueTitle", "titleFailReasonMessage",
      extractFn(src, "regenerateTitleChoices") + "\nreturn regenerateTitleChoices;"
    );
    let n = 0;
    const regenerateTitleChoices = factory(
      { hasAIKey: () => true }, () => {}, () => {}, () => {}, (cb) => cb(),
      async () => "grounding text", async (card, avoid) => { seenAvoid.push(avoid.slice()); n++; return { title: "Title " + n, failReason: "" }; },
      () => "fail message"
    );
    const out = await regenerateTitleChoices({ id: "c1", url: "https://example.test" }, [], 3);
    assert.deepStrictEqual(out, ["Title 1", "Title 2", "Title 3"]);
    assert.deepStrictEqual(seenAvoid, [[], ["Title 1"], ["Title 1", "Title 2"]]);
  });

  await t(label + ": regenerateTitleChoices returns fewer than `count` when an attempt fails the quality gate (never padded)", async () => {
    const factory = new Function(
      "IA_AI", "toast", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame",
      "fetchGroundingExcerpt", "generateUniqueTitle", "titleFailReasonMessage",
      extractFn(src, "regenerateTitleChoices") + "\nreturn regenerateTitleChoices;"
    );
    let n = 0;
    const regenerateTitleChoices = factory(
      { hasAIKey: () => true }, () => {}, () => {}, () => {}, (cb) => cb(),
      async () => "", async () => { n++; return n===1 ? { title: "Only One", failReason: "" } : { title: null, failReason: "" }; },
      () => "fail message"
    );
    const out = await regenerateTitleChoices({ id: "c1", url: "https://example.test" }, [], 3);
    assert.deepStrictEqual(out, ["Only One"]);
  });

  await t(label + ": regenerateTitleChoices returns [] and toasts when no AI key is configured", async () => {
    let toasted = "";
    const factory = new Function(
      "IA_AI", "toast", "PROVIDERS", "S", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame",
      "fetchGroundingExcerpt", "generateUniqueTitle", "titleFailReasonMessage",
      extractFn(src, "regenerateTitleChoices") + "\nreturn regenerateTitleChoices;"
    );
    const regenerateTitleChoices = factory(
      { hasAIKey: () => false }, (msg) => { toasted = msg; }, { anthropic: { keyName: "Anthropic key" } }, { provider: "anthropic" },
      () => {}, () => {}, (cb) => cb(), async () => "", async () => ({ title: "x" }), () => ""
    );
    const out = await regenerateTitleChoices({ id: "c1", url: "https://example.test" }, [], 3);
    assert.deepStrictEqual(out, []);
    assert.ok(toasted.indexOf("Anthropic key") >= 0);
  });

  await t(label + ": renderTitleChoices renders a clickable chip per candidate; edPickTitleChoice stages it into the title input", () => {
    let html2 = "";
    const box = { innerHTML: "" };
    Object.defineProperty(box, "innerHTML", { get: () => html2, set: (v) => { html2 = v; } });
    const editBox = { value: "", focus: () => {} };
    const els = { edTitleChoices: box, edTitle: editBox };
    const document = { getElementById: (id) => els[id] || null };
    const factory = new Function(
      "document", "esc",
      extractFn(src, "renderTitleChoices") + "\n" + extractFn(src, "edPickTitleChoice") + "\nreturn { renderTitleChoices, edPickTitleChoice };"
    );
    const esc = (s) => String(s);
    const mod = factory(document, esc);
    mod.renderTitleChoices(["First Choice", "Second Choice"]);
    assert.ok(html2.indexOf("First Choice") >= 0 && html2.indexOf("Second Choice") >= 0);
    mod.edPickTitleChoice({ getAttribute: () => "Second Choice" });
    assert.strictEqual(editBox.value, "Second Choice");
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 9: Run the full suite**

```bash
node tests/run.js
```

Expected: all tests pass, including the new `title-multichoice.test.js`.

- [ ] **Step 10: Commit**

```bash
git add web/index.html pwa/index.html tests/title-multichoice.test.js
git commit -m "Add multi-choice AI title picker to the edit modal"
```

---

### Task 6: SHELL_CACHE bump and final verification

**Files:**
- Modify: `pwa/sw.js`

**Interfaces:** None — this task only bumps a version constant and re-verifies the full suite.

- [ ] **Step 1: Bump `SHELL_CACHE` in `pwa/sw.js`**

This plan's Tasks 1, 2, 4, and 5 all edit `pwa/index.html`. Locate:

```js
const SHELL_CACHE = "interests-pwa-shell-v100"; // bump on ANY edit to an already-cached
```

Increment the version number by 1 (check `git log -- pwa/sw.js` or grep the current value first, in case another change bumped it since this plan was written — increment from whatever the current value actually is, don't assume v100 is still current):

```js
const SHELL_CACHE = "interests-pwa-shell-v101"; // bump on ANY edit to an already-cached
```

- [ ] **Step 2: Run the full suite one final time**

```bash
node tests/run.js
```

Expected: all tests pass, 0 failures, across every test file this plan touched or added (`settings-wiring`, `hashtag-title-apply`, `title-rollback-manual-edit`, `title-issues-hashtags`, `title-write-sites-hashtags`, `capturemeta`, `capture-meta-endpoint`, `title-grounding`, `title-multichoice`) plus the rest of the pre-existing suite.

- [ ] **Step 3: Commit**

```bash
git add pwa/sw.js
git commit -m "Bump PWA shell cache for the AI title multi-choice + grounding feature"
```
