# Roll Back a Renamed Title to Its Original Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any rename (manual or AI-driven), let the user restore a card's title to whatever it was before the very first rename touched it.

**Architecture:** One new plain field, `card.origTitle`, captured once via a shared `captureOrigTitle`/`settleOrigTitle` pair wired into every existing title-write site — the single AI choke point `applyGeneratedTitle` plus the two manual save functions `cardEditSave`/`impEditSave`. Two new UI entry points: a direct-apply icon on the Imported/Tabs card grid, and a stage-for-review button in the shared edit modal.

**Tech Stack:** Vanilla JS, no build step. Tests are plain Node `assert` scripts using this project's `tests/_extract.js` `extractFn()` + `new Function(...)` sandbox pattern.

## Global Constraints

- `origTitle` is captured **once** (the first rename after card creation or after a prior rollback) and **cleared** the moment the current title matches it again — never a multi-level history.
- Every write site follows the same three-step pattern: `captureOrigTitle(card, newTitle)` → assign `card.title` → `settleOrigTitle(card)`.
- The card-grid rollback (`impRevertTitle`) applies immediately, no review step — matching `impRefreshTitle`'s existing precedent.
- The edit-modal rollback (`edRevertTitle`) stages into the `#edTitle` input for review — matching `edAiTitle`'s existing precedent — nothing is written to the card until the user hits Save.
- `impEditSave`'s pre-existing missing 250-char title cap is NOT fixed as part of this work — out of scope, preserve exactly as-is.
- Every function/CSS rule/markup touched in `web/index.html` must be applied identically to `pwa/index.html`.
- This is a client-side card-field/UI feature — no backup/restore/import code is touched, so it follows the **standard** review path, not the data-safety-reviewer.
- Two existing tests reference literal source text that this plan's edits will change — each task that touches the affected function must update that test's regex to match the new (but equivalently strict) shape, not weaken what it verifies:
  - `tests/hashtag-title-apply.test.js`'s `loadApplyGeneratedTitle` sandbox factory only provides `applyGeneratedTitle`/`tagBadPattern`/`canonicalTag` in its extracted-source body — once `applyGeneratedTitle` calls `captureOrigTitle`/`settleOrigTitle`, every existing test in that file will throw `ReferenceError` unless those two functions are added to the same extracted-and-joined body.
  - `tests/title-issues-resolved.test.js:67` asserts the exact literal `if(title){` immediately followed by `it.title = title;` immediately followed by `it.titleSet = true;` immediately followed by `}` for `impEditSave` — this plan's edit inserts `captureOrigTitle`/`settleOrigTitle` calls inside that same `if` block, which will not match the existing regex.
- `node tests/run.js` must stay green after every task.

---

### Task 1: `captureOrigTitle`/`settleOrigTitle` helpers + wire into `applyGeneratedTitle`

**Files:**
- Modify: `web/index.html` — new helpers inserted immediately before `applyGeneratedTitle` (currently `web/index.html:6498`); `applyGeneratedTitle` itself modified to call them
- Mirror identically in `pwa/index.html`
- Modify: `tests/hashtag-title-apply.test.js` (sandbox factory needs the two new functions)
- Test: `tests/title-rollback-core.test.js` (new)

**Interfaces:**
- Produces: `captureOrigTitle(card, newTitle)` — if `card`, `newTitle` are truthy and `card.title !== newTitle`, sets `card.origTitle = card.title` ONLY if `card.origTitle` is currently `undefined`. `settleOrigTitle(card)` — if `card.origTitle !== undefined` and `card.title === card.origTitle`, deletes `card.origTitle`. Both are pure with respect to everything except the `card` object passed in.
- `applyGeneratedTitle` now computes its `newTitle` into a local variable, calls `captureOrigTitle`/`settleOrigTitle` around the assignment; its existing public signature/return shape (`{title, tagsAdded}` or `null`) is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/title-rollback-core.test.js`:

```js
// tests/title-rollback-core.test.js — captureOrigTitle/settleOrigTitle, the
// shared pair every title-write site uses to track a card's true original
// title, plus their wiring into applyGeneratedTitle (the single choke point
// for every AI-driven rename).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { extractHashtags } = require("../web/title-ai.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function loadHelpers(src) {
  const parts = { captureOrigTitle: extractFn(src, "captureOrigTitle"), settleOrigTitle: extractFn(src, "settleOrigTitle") };
  Object.keys(parts).forEach(name => assert.ok(parts[name], name + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function(body + "\nreturn { captureOrigTitle, settleOrigTitle };");
  return factory();
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": captureOrigTitle captures the current title on the first real rename", () => {
    const { captureOrigTitle } = loadHelpers(src);
    const card = { title: "Original" };
    captureOrigTitle(card, "Renamed");
    assert.strictEqual(card.origTitle, "Original");
  });

  t(label + ": captureOrigTitle is a no-op when the new title equals the current one", () => {
    const { captureOrigTitle } = loadHelpers(src);
    const card = { title: "Same" };
    captureOrigTitle(card, "Same");
    assert.strictEqual(card.origTitle, undefined);
  });

  t(label + ": captureOrigTitle never overwrites an already-captured original across multiple renames", () => {
    const { captureOrigTitle } = loadHelpers(src);
    const card = { title: "Original", origTitle: "Original" };
    captureOrigTitle(card, "Second rename");
    assert.strictEqual(card.origTitle, "Original", "must stay the TRUE original, not the most recent prior title");
  });

  t(label + ": settleOrigTitle clears origTitle once the current title matches it again", () => {
    const { settleOrigTitle } = loadHelpers(src);
    const card = { title: "Original", origTitle: "Original" };
    settleOrigTitle(card);
    assert.strictEqual(card.origTitle, undefined);
  });

  t(label + ": settleOrigTitle leaves origTitle alone when the title still differs", () => {
    const { settleOrigTitle } = loadHelpers(src);
    const card = { title: "Renamed", origTitle: "Original" };
    settleOrigTitle(card);
    assert.strictEqual(card.origTitle, "Original");
  });

  t(label + ": settleOrigTitle is a no-op when origTitle was never set", () => {
    const { settleOrigTitle } = loadHelpers(src);
    const card = { title: "Whatever" };
    settleOrigTitle(card);
    assert.strictEqual(card.origTitle, undefined);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
```

Also add these cases to `tests/hashtag-title-apply.test.js`'s existing `for (const [label, src] of ...)` loop, right after its last existing `t(...)` call:

```js
  t(label + ": applyGeneratedTitle captures origTitle on the first AI rename and settles it away on a coincidental round-trip", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "Original Title", tags: [] };
    applyGeneratedTitle(card, "New AI Title");
    assert.strictEqual(card.origTitle, "Original Title");
    applyGeneratedTitle(card, "Original Title");
    assert.strictEqual(card.title, "Original Title");
    assert.strictEqual(card.origTitle, undefined, "settles once the title round-trips back to the original");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/title-rollback-core.test.js`
Expected: FAIL — `captureOrigTitle not found in source`.

Run: `node tests/hashtag-title-apply.test.js`
Expected: the new test FAILS (function doesn't set `origTitle` yet); existing tests in this file still pass unchanged at this point (no sandbox change made yet).

- [ ] **Step 3: Implement the helpers and wire them into `applyGeneratedTitle` (`web/index.html`)**

Insert immediately before the existing `applyGeneratedTitle` function (currently `web/index.html:6498`):

```js
// Captures the card's TRUE original title, once, the first time a rename
// would actually change something -- never overwritten again, so it always
// points at the original no matter how many renames happen in between.
function captureOrigTitle(card, newTitle){
  if(!card || !newTitle || card.title===newTitle) return;
  if(card.origTitle===undefined) card.origTitle = card.title;
}
// Clears origTitle once the current title matches it again -- nothing left
// to roll back to; the next rename starts a fresh baseline.
function settleOrigTitle(card){
  if(card && card.origTitle!==undefined && card.title===card.origTitle) delete card.origTitle;
}
```

Then change `applyGeneratedTitle` from:
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
  card.title = (extracted.title || rawTitle).slice(0,250);
  if(cleaned.length) card.tags = Array.from(new Set([...(card.tags||[]), ...cleaned]));
  return { title: card.title, tagsAdded: cleaned };
}
```
to:
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

- [ ] **Step 4: Fix `tests/hashtag-title-apply.test.js`'s sandbox factory**

In `loadApplyGeneratedTitle`, change:
```js
  const parts = {
    tagBadPattern: extractFn(src, "tagBadPattern"),
    canonicalTag: extractFn(src, "canonicalTag"),
    applyGeneratedTitle: extractFn(src, "applyGeneratedTitle"),
  };
```
to:
```js
  const parts = {
    tagBadPattern: extractFn(src, "tagBadPattern"),
    canonicalTag: extractFn(src, "canonicalTag"),
    captureOrigTitle: extractFn(src, "captureOrigTitle"),
    settleOrigTitle: extractFn(src, "settleOrigTitle"),
    applyGeneratedTitle: extractFn(src, "applyGeneratedTitle"),
  };
```
(the rest of that function — the `Object.keys(...).forEach(assert.ok...)` loop, the `body = Object.values(parts).join("\n")`, the factory call — needs no other change, since it already iterates `parts` generically).

- [ ] **Step 5: Copy the helpers and the `applyGeneratedTitle` edit identically to `pwa/index.html`**

Verify with:
```bash
diff <(sed -n '/^function captureOrigTitle/,/^}/p' web/index.html) <(sed -n '/^function captureOrigTitle/,/^}/p' pwa/index.html)
diff <(sed -n '/^function settleOrigTitle/,/^}/p' web/index.html) <(sed -n '/^function settleOrigTitle/,/^}/p' pwa/index.html)
diff <(sed -n '/^function applyGeneratedTitle/,/^}/p' web/index.html) <(sed -n '/^function applyGeneratedTitle/,/^}/p' pwa/index.html)
```
Expected: no output for any.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/title-rollback-core.test.js` and `node tests/hashtag-title-apply.test.js`
Expected: all tests pass in both files.

- [ ] **Step 7: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 8: Commit**

```bash
git add web/index.html pwa/index.html tests/hashtag-title-apply.test.js tests/title-rollback-core.test.js
git commit -m "feat: add captureOrigTitle/settleOrigTitle, wire into applyGeneratedTitle"
```

---

### Task 2: Wire into the manual save paths (`cardEditSave`, `impEditSave`)

**Files:**
- Modify: `web/index.html:4862` (`cardEditSave`), `web/index.html:4982` (`impEditSave`)
- Mirror identically in `pwa/index.html`
- Modify: `tests/title-issues-resolved.test.js` (one regex needs updating — see Global Constraints)
- Test: `tests/title-rollback-manual-edit.test.js` (new)

**Interfaces:**
- Consumes: `captureOrigTitle`/`settleOrigTitle` (Task 1).
- `cardEditSave`/`impEditSave` keep their exact existing external behavior (toasts, persistence, `titleSet` stamping, the 250-char cap asymmetry between the two functions) — this task only adds origTitle tracking around the existing title assignment.

- [ ] **Step 1: Write the failing tests**

Create `tests/title-rollback-manual-edit.test.js`:

```js
// tests/title-rollback-manual-edit.test.js — cardEditSave/impEditSave capture
// origTitle on the first manual rename, don't re-capture on a second, and
// settle it away when a save restores the original text.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function loadFn(src, name, extraFreeVars) {
  const parts = { captureOrigTitle: extractFn(src, "captureOrigTitle"), settleOrigTitle: extractFn(src, "settleOrigTitle"), [name]: extractFn(src, name) };
  Object.keys(parts).forEach(k => assert.ok(parts[k], k + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function(...(extraFreeVars || []), body + "\nreturn " + name + ";");
  return factory;
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": cardEditSave captures origTitle on the first manual rename", async () => {
    const it = { id: "s1", title: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(it.origTitle, "Original");
  });

  await t(label + ": cardEditSave does not re-capture on a second rename", async () => {
    const it = { id: "s1", title: "Renamed Once", origTitle: "The True Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed Twice" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed Twice");
    assert.strictEqual(it.origTitle, "The True Original", "must stay the TRUE original");
  });

  await t(label + ": cardEditSave settles origTitle when the saved title restores the original", async () => {
    const it = { id: "s1", title: "Renamed", origTitle: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Original" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
  });

  await t(label + ": impEditSave captures origTitle on the first manual rename", async () => {
    const it = { id: "i1", title: "Original" };
    const imported = [it];
    const els = { edTitle: { value: "Renamed" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(it.origTitle, "Original");
  });

  await t(label + ": impEditSave does not re-capture on a second rename", async () => {
    const it = { id: "i1", title: "Renamed Once", origTitle: "The True Original" };
    const imported = [it];
    const els = { edTitle: { value: "Renamed Twice" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Renamed Twice");
    assert.strictEqual(it.origTitle, "The True Original");
  });

  await t(label + ": impEditSave settles origTitle when the saved title restores the original", async () => {
    const it = { id: "i1", title: "Renamed", origTitle: "Original" };
    const imported = [it];
    const els = { edTitle: { value: "Original" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/title-rollback-manual-edit.test.js`
Expected: FAIL — `it.origTitle` is `undefined` where the tests expect a captured value (the wiring doesn't exist yet).

- [ ] **Step 3: Wire `cardEditSave` (`web/index.html:4862`)**

Change:
```js
async function cardEditSave(){
  const box = document.getElementById("edTitle"); if(!box) return;
  const title = box.value.trim();
  if(!title){ toast("Give the card a title first."); return; }
  const it = (saved||[]).find(x=>x && x.id===_edSavedId);
  if(!it){ toast("That card is no longer available."); closeGuide(); return; }
  it.title = title.slice(0,250); it.titleSet = true;
  await Store.putSaved(saved);
  closeGuide();
  if(!refreshTabsViewIfShowing()) renderSaved();
  toast("Title updated");
}
```
to:
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
(`title.slice(0,250)` is deliberately computed twice rather than introducing a local variable — this keeps `it.title = title.slice(0,250); it.titleSet = true;` a byte-for-byte literal match for the existing regex in `tests/title-issues-resolved.test.js:66`, which is NOT being changed by this task.)

- [ ] **Step 4: Wire `impEditSave` (`web/index.html:4982`)**

Change:
```js
  if(title){ it.title=title; it.titleSet=true; }
```
to:
```js
  if(title){ captureOrigTitle(it, title); it.title=title; it.titleSet=true; settleOrigTitle(it); }
```

- [ ] **Step 5: Fix `tests/title-issues-resolved.test.js:67`'s now-stale regex**

Change:
```js
    ["impEditSave", /if\(title\)\{\s*it\.title\s*=\s*title;\s*it\.titleSet\s*=\s*true;\s*\}/],
```
to:
```js
    ["impEditSave", /if\(title\)\{[\s\S]*?it\.title\s*=\s*title;\s*it\.titleSet\s*=\s*true;[\s\S]*?\}/],
```
(this still requires the exact literal `it.title = title;` immediately followed by `it.titleSet = true;` — the property this test exists to guard — it just tolerates the new `captureOrigTitle`/`settleOrigTitle` calls around it instead of requiring nothing else in the block. Do NOT touch the other two entries in that same `writePaths` array (`applyTitleSuggestions`, `cardEditSave`) — neither is affected by this task's edits.)

- [ ] **Step 6: Copy Steps 3-4 identically to `pwa/index.html`**

Verify with:
```bash
diff <(sed -n '/^async function cardEditSave/,/^}/p' web/index.html) <(sed -n '/^async function cardEditSave/,/^}/p' pwa/index.html)
diff <(sed -n '/^function impEditSave/,/^}/p' web/index.html) <(sed -n '/^function impEditSave/,/^}/p' pwa/index.html)
```
Expected: no output for either.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node tests/title-rollback-manual-edit.test.js` and `node tests/title-issues-resolved.test.js`
Expected: all tests pass in both files.

- [ ] **Step 8: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 9: Commit**

```bash
git add web/index.html pwa/index.html tests/title-issues-resolved.test.js tests/title-rollback-manual-edit.test.js
git commit -m "feat: track origTitle through cardEditSave and impEditSave"
```

---

### Task 3: Card-grid rollback icon (`impRevertTitle`)

**Files:**
- Modify: `web/index.html` — CSS near `:423-432` (add `.imp-revert` to the shared selector groups), `impCardHTML` (`:4754-4783`, add the conditional button), new `impRevertTitle` function near `impRefreshTitle` (currently `web/index.html:7152`)
- Mirror identically in `pwa/index.html`
- Test: `tests/title-rollback-grid-ui.test.js` (new)

**Interfaces:**
- Consumes: `card.origTitle` (Tasks 1-2 populate it).
- Produces: `impRevertTitle(idx)` — no-ops if the card or its `origTitle` is missing; otherwise applies immediately (`it.title = it.origTitle`), settles `origTitle` away, persists, re-renders, toasts — mirroring `impRefreshTitle`'s exact after-write shape.

- [ ] **Step 1: Write the failing tests**

Create `tests/title-rollback-grid-ui.test.js`:

```js
// tests/title-rollback-grid-ui.test.js — impRevertTitle (direct-apply, no
// review step, matching impRefreshTitle's precedent) and the conditional
// .imp-revert icon in impCardHTML.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": impRevertTitle restores origTitle, clears it, and persists", () => {
    const it = { id: "i1", title: "Renamed", origTitle: "Original" };
    const imported = [it];
    let persisted = false, toasted = "";
    const factory = new Function(
      "imported", "persistCards", "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "settleOrigTitle") + "\n" + extractFn(src, "impRevertTitle") + "\nreturn impRevertTitle;"
    );
    const impRevertTitle = factory(imported, () => { persisted = true; }, "imported", () => {}, () => {}, () => {}, () => false, (msg) => { toasted = msg; });
    impRevertTitle(0);
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
    assert.ok(persisted);
    assert.ok(toasted.indexOf("Original") >= 0);
  });

  t(label + ": impRevertTitle is a no-op when the card has no origTitle", () => {
    const it = { id: "i1", title: "Never Renamed" };
    const imported = [it];
    let persisted = false;
    const factory = new Function(
      "imported", "persistCards", "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "settleOrigTitle") + "\n" + extractFn(src, "impRevertTitle") + "\nreturn impRevertTitle;"
    );
    const impRevertTitle = factory(imported, () => { persisted = true; }, "imported", () => {}, () => {}, () => {}, () => false, () => {});
    impRevertTitle(0);
    assert.strictEqual(it.title, "Never Renamed");
    assert.strictEqual(persisted, false);
  });

  t(label + ": impCardHTML renders the revert icon only when origTitle is set", () => {
    const withOrig = extractFn(src, "impCardHTML");
    assert.match(withOrig, /it\.origTitle\s*!==\s*undefined[\s\S]*?impRevertTitle\(\$\{idx\}\)/,
      "impCardHTML must conditionally emit an impRevertTitle(...) trigger keyed on it.origTitle");
  });

  t(label + ": .imp-revert joins the shared hover-reveal CSS group", () => {
    assert.match(src, /\.imp-edit,\.imp-refresh,\.imp-reader,\.imp-title,\.imp-revert\{/);
    assert.match(src, /\.imp-card:hover \.imp-edit,\.imp-card:hover \.imp-refresh,\.imp-card:hover \.imp-reader,\.imp-card:hover \.imp-title,\.imp-card:hover \.imp-revert\{display:flex\}/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/title-rollback-grid-ui.test.js`
Expected: FAIL — `impRevertTitle not found in source`, CSS/markup assertions fail.

- [ ] **Step 3: Add `.imp-revert` to the shared CSS selector groups (`web/index.html`, near `:423-432`)**

Change each of these four lines (they currently list `.imp-edit,.imp-refresh,.imp-reader,.imp-title` — add `,.imp-revert` to each, keeping every other character identical):
```css
.imp-edit,.imp-refresh,.imp-reader,.imp-title{position:absolute;top:6px;z-index:6;width:28px;height:28px;border:1px solid var(--line);background:rgba(255,255,255,.94);border-radius:8px;cursor:pointer;display:none;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;color:var(--muted);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.imp-edit{right:6px}
.imp-card:hover .imp-edit,.imp-card:hover .imp-refresh,.imp-card:hover .imp-reader,.imp-card:hover .imp-title{display:flex}
.imp-edit:hover,.imp-refresh:hover,.imp-reader:hover,.imp-title:hover{border-color:var(--accent);color:var(--accent)}
```
to:
```css
.imp-edit,.imp-refresh,.imp-reader,.imp-title,.imp-revert{position:absolute;top:6px;z-index:6;width:28px;height:28px;border:1px solid var(--line);background:rgba(255,255,255,.94);border-radius:8px;cursor:pointer;display:none;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;color:var(--muted);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.imp-edit{right:6px}
.imp-card:hover .imp-edit,.imp-card:hover .imp-refresh,.imp-card:hover .imp-reader,.imp-card:hover .imp-title,.imp-card:hover .imp-revert{display:flex}
.imp-edit:hover,.imp-refresh:hover,.imp-reader:hover,.imp-title:hover,.imp-revert:hover{border-color:var(--accent);color:var(--accent)}
```
(the `@media(max-width:760px){.imp-edit,.imp-refresh,.imp-reader,.imp-title{display:flex}}` rule also needs `,.imp-revert` added the same way, so the icon is reachable on touch devices — same reasoning `tests/card-edit-wiring.test.js` already documents for the analogous `.card-edit` icon.)

- [ ] **Step 4: Add the conditional button to `impCardHTML` (`web/index.html:4777`)**

Insert a new `${it.origTitle!==undefined?...}` fragment right after the existing `imp-title` button and before `imp-edit`, inside the same template-literal line:

Change:
```js
    ${selMode?`<div class="pickov" onclick="togglePick(${idx})">${selPicks.has(idx)?'<span class="pk">&#10003;</span>':""}</div>`:`${it.url?`<button class="imp-refresh${(it.lastResult==='pending' && _refreshPins.has(it.id))?' spin':''}" title="Refresh image — recapture this page" onclick="event.stopPropagation();impRefresh(${idx})">&#8635;</button>`:""}<button class="imp-reader" title="Open reader view" onclick="event.stopPropagation();openReader(${idx})">&#128214;</button><button class="imp-title" title="Suggest a new title for this card (AI)" onclick="event.stopPropagation();impRefreshTitle(${idx})">Aa</button><button class="imp-edit" title="Edit card" onclick="event.stopPropagation();impEdit(${idx})">&#9998;</button>`}
```
to:
```js
    ${selMode?`<div class="pickov" onclick="togglePick(${idx})">${selPicks.has(idx)?'<span class="pk">&#10003;</span>':""}</div>`:`${it.url?`<button class="imp-refresh${(it.lastResult==='pending' && _refreshPins.has(it.id))?' spin':''}" title="Refresh image — recapture this page" onclick="event.stopPropagation();impRefresh(${idx})">&#8635;</button>`:""}<button class="imp-reader" title="Open reader view" onclick="event.stopPropagation();openReader(${idx})">&#128214;</button><button class="imp-title" title="Suggest a new title for this card (AI)" onclick="event.stopPropagation();impRefreshTitle(${idx})">Aa</button>${it.origTitle!==undefined?`<button class="imp-revert" title="Revert to the original title: ${esc(it.origTitle)}" onclick="event.stopPropagation();impRevertTitle(${idx})">&#8617;</button>`:""}<button class="imp-edit" title="Edit card" onclick="event.stopPropagation();impEdit(${idx})">&#9998;</button>`}
```

- [ ] **Step 5: Add `impRevertTitle` (`web/index.html`, immediately after `impRefreshTitle`, currently ending around `:7159`)**

```js
// Card-grid hover icon: no review step (same as impRefreshTitle it sits
// beside), applies straight away.
function impRevertTitle(idx){
  const it = imported[idx]; if(!it || it.origTitle===undefined) return;
  it.title = it.origTitle;
  settleOrigTitle(it);
  persistCards();
  if(curTab==="imported"){ anchorImpOnCard(it); renderImported(); restoreImpScrollSettle(); } else refreshTabsViewIfShowing();
  toast("Title reverted to: "+it.title, 7000);
}
```

- [ ] **Step 6: Copy Steps 3-5 identically to `pwa/index.html`**

Verify with:
```bash
diff <(sed -n '/^function impRevertTitle/,/^}/p' web/index.html) <(sed -n '/^function impRevertTitle/,/^}/p' pwa/index.html)
grep -c '\.imp-revert' web/index.html pwa/index.html
```
Expected: no diff output; equal grep counts for both files.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node tests/title-rollback-grid-ui.test.js`
Expected: all tests pass.

- [ ] **Step 8: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 9: Commit**

```bash
git add web/index.html pwa/index.html tests/title-rollback-grid-ui.test.js
git commit -m "feat: add impRevertTitle and the card-grid revert-to-original icon"
```

---

### Task 4: Edit-modal rollback button (`edRevertTitle`)

**Files:**
- Modify: `web/index.html` — `impEdit`'s modal template (currently `web/index.html:~4810-4811`), `cardEdit`'s modal template (currently `web/index.html:~4852-4853`), new `edRevertTitle` function near `edAiTitle` (currently `web/index.html:4878`)
- Mirror identically in `pwa/index.html`
- Test: `tests/title-rollback-modal-ui.test.js` (new)

**Interfaces:**
- Consumes: `card.origTitle` (Tasks 1-2), `_edScope`/`_edSavedId`/`_editIdx` (existing module state `edAiTitle` already reads the same way).
- Produces: `edRevertTitle()` — no-ops if the resolved card or its `origTitle` is missing; otherwise stages `card.origTitle` into the `#edTitle` input and focuses it, WITHOUT writing to the card — matching `edAiTitle`'s exact "review before Save" contract.

- [ ] **Step 1: Write the failing tests**

Create `tests/title-rollback-modal-ui.test.js`:

```js
// tests/title-rollback-modal-ui.test.js — edRevertTitle stages origTitle
// into the edit modal's title input for review (same contract as edAiTitle),
// and both edit-modal templates (impEdit, cardEdit) conditionally render the
// trigger button.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": edRevertTitle stages origTitle into the input for a Saved card, without writing the card", () => {
    const saved = [{ id: "s1", title: "Renamed", origTitle: "Original" }];
    const imported = [];
    const box = { value: "", focus: () => { box.focused = true; } };
    const document = { getElementById: (id) => id === "edTitle" ? box : null };
    const factory = new Function(
      "document", "saved", "imported", "_edScope", "_edSavedId", "_editIdx",
      extractFn(src, "edRevertTitle") + "\nreturn edRevertTitle;"
    );
    const edRevertTitle = factory(document, saved, imported, "saved", "s1", -1);
    edRevertTitle();
    assert.strictEqual(box.value, "Original");
    assert.ok(box.focused);
    assert.strictEqual(saved[0].title, "Renamed", "must NOT write the card — stage only, same as edAiTitle");
  });

  t(label + ": edRevertTitle stages origTitle into the input for an Imported card", () => {
    const saved = [];
    const imported = [{ id: "i1", title: "Renamed", origTitle: "Original" }];
    const box = { value: "", focus: () => {} };
    const document = { getElementById: (id) => id === "edTitle" ? box : null };
    const factory = new Function(
      "document", "saved", "imported", "_edScope", "_edSavedId", "_editIdx",
      extractFn(src, "edRevertTitle") + "\nreturn edRevertTitle;"
    );
    const edRevertTitle = factory(document, saved, imported, "imported", "", 0);
    edRevertTitle();
    assert.strictEqual(box.value, "Original");
  });

  t(label + ": edRevertTitle is a no-op when the card has no origTitle", () => {
    const saved = [{ id: "s1", title: "Never Renamed" }];
    const box = { value: "should not change", focus: () => { box.focused = true; } };
    const document = { getElementById: (id) => id === "edTitle" ? box : null };
    const factory = new Function(
      "document", "saved", "imported", "_edScope", "_edSavedId", "_editIdx",
      extractFn(src, "edRevertTitle") + "\nreturn edRevertTitle;"
    );
    const edRevertTitle = factory(document, saved, [], "saved", "s1", -1);
    edRevertTitle();
    assert.strictEqual(box.value, "should not change");
    assert.ok(!box.focused);
  });

  t(label + ": both edit-modal templates conditionally render the revert trigger", () => {
    const hits = src.match(/onclick="edRevertTitle\(\)"/g) || [];
    assert.strictEqual(hits.length, 2, "one in impEdit's template, one in cardEdit's template, got " + hits.length);
    assert.match(src, /it\.origTitle\s*!==\s*undefined[\s\S]{0,120}?edRevertTitle\(\)/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/title-rollback-modal-ui.test.js`
Expected: FAIL — `edRevertTitle not found in source`.

- [ ] **Step 3: Add the trigger button to both edit-modal templates**

In `impEdit`'s template (`web/index.html:~4810`), change:
```js
    <label>Title <button type="button" class="btn btn-ghost ed-ai" onclick="edAiTitle()" title="Ask the AI for a better title for this card">&#10024; AI title lookup</button></label>
    <input type="text" id="edTitle" value="${esc(it.title||"")}">
```
to:
```js
    <label>Title <button type="button" class="btn btn-ghost ed-ai" onclick="edAiTitle()" title="Ask the AI for a better title for this card">&#10024; AI title lookup</button>${it.origTitle!==undefined?` <button type="button" class="btn btn-ghost ed-ai" onclick="edRevertTitle()" title="Restore the original title: ${esc(it.origTitle)}">&#8617; Revert to original</button>`:""}</label>
    <input type="text" id="edTitle" value="${esc(it.title||"")}">
```

Apply the exact same two-line change in `cardEdit`'s template (`web/index.html:~4852`).

- [ ] **Step 4: Add `edRevertTitle` (`web/index.html`, immediately after `edAiTitle`, currently ending around `:4889`)**

```js
// Stages the original title into the input for review -- same "nothing is
// stored until Save changes" contract as edAiTitle.
function edRevertTitle(){
  const box = document.getElementById("edTitle"); if(!box) return;
  const card = _edScope==="saved" ? saved.find(x=>x && x.id===_edSavedId) : imported[_editIdx];
  if(!card || card.origTitle===undefined) return;
  box.value = card.origTitle;
  box.focus();
}
```

- [ ] **Step 5: Copy Steps 3-4 identically to `pwa/index.html`**

Verify with:
```bash
diff <(sed -n '/^function edRevertTitle/,/^}/p' web/index.html) <(sed -n '/^function edRevertTitle/,/^}/p' pwa/index.html)
grep -c 'onclick="edRevertTitle()"' web/index.html pwa/index.html
```
Expected: no diff output; both grep counts equal `2`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/title-rollback-modal-ui.test.js`
Expected: all tests pass.

- [ ] **Step 7: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 8: Commit**

```bash
git add web/index.html pwa/index.html tests/title-rollback-modal-ui.test.js
git commit -m "feat: add edRevertTitle and the edit-modal revert-to-original button"
```

---

### Task 5: Parity manifest + full verification

**Files:**
- Modify: `tests/surface-parity-manifest.js` (`indexContracts` array)

- [ ] **Step 1: Register the new top-level `index.html` functions**

Add to `indexContracts` in `tests/surface-parity-manifest.js`:
```js
    "captureOrigTitle",
    "settleOrigTitle",
    "impRevertTitle",
    "edRevertTitle",
```

- [ ] **Step 2: Run the full test suite**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 3: Manual byte-identity spot-check**

```bash
for fn in captureOrigTitle settleOrigTitle applyGeneratedTitle cardEditSave impEditSave impRevertTitle edRevertTitle; do
  echo "-- $fn --"
  diff <(sed -n "/^\(async \)\?function $fn(/,/^}/p" web/index.html) <(sed -n "/^\(async \)\?function $fn(/,/^}/p" pwa/index.html)
done
grep -n '\.imp-revert' web/index.html pwa/index.html
grep -n 'onclick="edRevertTitle()"' web/index.html pwa/index.html
```

Expected: no output under any `-- $fn --` header; equal match counts between web/pwa for both grep calls.

- [ ] **Step 4: Commit**

```bash
git add tests/surface-parity-manifest.js
git commit -m "test: register title-rollback functions in the surface-parity manifest"
```
