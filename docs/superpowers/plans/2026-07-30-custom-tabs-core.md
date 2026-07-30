# Custom Tabs Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the core Custom Tabs mechanic — create/rename/remove a tab, populate it individually (tag picker), in bulk (Saved/Imported select mode, and remove-from-tab inside a tab), or via an on-demand AI suggestion sweep — as a new "Tabs" nav area. This is Plan 2 of 3 (Plan 1, generalizing tag editing to Saved cards, is already merged to `master`). Plan 3 (the AI research assistant's article/Q&A features on the reserved AI tab) is separate and out of scope here.

**Architecture:** A tab is a pinned tag, per the approved design spec (`docs/superpowers/specs/2026-07-29-custom-tabs-and-ai-research-design.md`). A new `ia_tabs` KV array (`[{id,name,tag,reserved,createdAt}]`) lives alongside the app's other small config keys (`ia_fcat`, `ia_itag`), read/written through the existing generic `load(k,d)`/`save(k,v)` wrapper — no new storage tier, no `core/` (backend) changes. Membership in a tab is purely "does this card's `tags` array contain the tab's `tag`" — the same tag-add/remove machinery Plan 1 already generalized to work across `imported` and `saved` (`cardAddTag`/`cardRemoveTag`/`_afterTagEdit`). The reserved 🤖 AI tab is auto-created once, backed by a namespaced tag (`__ai_research__`) that's suppressed everywhere a raw tag would otherwise be user-visible (the freeform tag list, AI tag suggestions, and rendered tag chips) — this plan builds the tab mechanism and includes the ability to flag a card into the AI tab (it's a tab like any other), but NOT the AI tab's special research/Q&A features, which are Plan 3.

**Tech Stack:** Vanilla JS inside `web/index.html` / `pwa/index.html` (no framework, no build step). Tests are plain `assert` scripts using `tests/_extract.js`'s function-extraction technique, following the pattern established by `tests/tag-editing-*.test.js` (Plan 1).

## Global Constraints

- Single-file HTML apps (`web/index.html`, `pwa/index.html`) must stay parseable — every change must pass `node tests/syntax-check.js`.
- `web/index.html` and `pwa/index.html` are NOT byte-identical files overall (each includes different platform-specific `<script>` tags), but every new **pure-logic function** this plan introduces (tab CRUD, `cardHasTag`, `tabCardCount`, `tabsFilteredList`, `bulkAddTag`, the AI-suggest-cards logic, etc.) must be byte-identical between the two files — verified by a dedicated parity test (Task 7), following the exact precedent Plan 1 set with `tests/tag-editing-parity.test.js`.
- No `core/` (backend), `core/db.js` schema, or sync/backup-format changes. `ia_tabs` is a plain KV array through the existing `Store.kvGet`/`Store.kvSet` path; `restore-legacy.js`'s backup/restore key handling already has a catch-all `everything else (ia_*) -> plan.kv` branch (confirmed by direct inspection — no restore-path changes needed for this plan).
- Every existing Imported/Saved tag-editing, AutoTag-suggestion, and Imported-select-mode (Recapture/Fetch/Open) behavior must be unchanged for cards and tags that have nothing to do with tabs — this plan is additive except for one narrow, deliberate suppression: the reserved tag `__ai_research__` never appears as a visible chip, in the freeform tag list, or as an AI tag suggestion (it's an implementation detail per the design spec).
- Reuse existing CSS classes and interaction patterns wherever their shape matches — `.catpill`/`.catbar` for pill rows, `.tp-row`/`.tp-list`/`.tp-sugs`/`.tp-sug` for popover rows and AI-suggestion chips, `.pickov`/`.pk`/`.selpick` for bulk-select checkbox overlays, bare `prompt()`/`confirm()` for simple text input and destructive confirmations (both already used throughout this codebase, e.g. `web/index.html:1623,2699`). No new visual language introduced without cause.
- Entering the Tabs nav view must clear Imported's own Select mode (`selMode`/`selPicks`, and once Task 4 introduces it, `impAddTabMenuOpen`) — otherwise `impCardHTML`'s own pick-overlay (tied to `selMode`) would render underneath the tab-detail view's separate `tabSelMode` overlay (Task 5), stacking two overlays and leaving Imported's `selPicks` silently mutable from inside a view with no bulk bar to act on them. See Task 2's `showTab` edit and Task 4's follow-up to it.
- `pwa/sw.js`'s `SHELL_CACHE` must be bumped once this plan's `pwa/index.html` edits are complete (Task 7) — every task from 1 through 6 touches `pwa/index.html`, and per this project's established convention, an unbumped `SHELL_CACHE` leaves already-installed PWAs silently serving the old shell indefinitely (cache-first, no other invalidation path). No single task owns this — it's called out here and satisfied once, in Task 7, after all other edits land.
- Follow the project's `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` commit trailer convention.

---

### Task 1: `ia_tabs` data model, tab CRUD, and reserved-tag suppression

**Files:**
- Modify: `web/index.html` (new state+CRUD block after `tagRow()`, `web/index.html:3302-3316`; `allTags()` at `web/index.html:3325-3330`; `aiSuggestTags()`'s cleaning loop at `web/index.html:3526`; `bootData()` at `web/index.html:7592`)
- Modify: `pwa/index.html` (same edits, located by content — search for the `tagRow`/`allTags`/`aiSuggestTags`/`tagStats  = (await load("tagstats", {}))` anchors)
- Test: `tests/tabs-crud.test.js` (new)

**Interfaces:**
- Consumes: `newId()` (existing, `web/index.html:910`), `load(k,d)`/`save(k,v)` (existing generic KV wrapper, `web/index.html:893-898`), `imported`/`saved` (existing globals), `esc`/`toast` (existing), `canonicalTag`/`allTags` (Plan 1, being modified here).
- Produces: `AI_TAB_TAG` (const string `"__ai_research__"`), `tabs` (module-level array, hydrated at boot), `bootstrapAiTab()`, `createTab(name)` (returns the created `{id,name,tag,reserved,createdAt}` or `null`), `renameTab(id,name)`, `deleteTab(id)` (returns `true`/`false`), `cardHasTag(it,tag)`, `tabCardCount(tag)`. Every later task consumes `tabs`, `cardHasTag`, `tabCardCount`, and the CRUD functions by these exact names/signatures.

- [ ] **Step 1: Write the failing test**

Create `tests/tabs-crud.test.js`:

```js
// tests/tabs-crud.test.js — Task 1: the ia_tabs data model (bootstrapAiTab,
// createTab, renameTab, deleteTab, cardHasTag, tabCardCount) and the reserved
// AI_TAB_TAG's suppression from allTags()/tagRow() — it's an implementation
// detail (a namespaced tag), never a user-visible chip or freeform tag.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadTabs(src, state) {
  const body = [
    fn(src, "cardHasTag"), fn(src, "tabCardCount"), fn(src, "bootstrapAiTab"),
    fn(src, "createTab"), fn(src, "renameTab"), fn(src, "deleteTab"),
  ].join("\n");
  const factory = new Function(
    "imported", "saved", "tabs", "AI_TAB_TAG", "newId", "save", "toast",
    body + "\nreturn { cardHasTag, tabCardCount, bootstrapAiTab, createTab, renameTab, deleteTab, tabs: function(){ return tabs; } };"
  );
  return factory(
    state.imported || [], state.saved || [], state.tabs || [], "__ai_research__",
    () => "id_" + Math.random().toString(36).slice(2),
    () => {}, () => {}
  );
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": AI_TAB_TAG constant is exactly \"__ai_research__\"", () => {
    assert.match(src, /const AI_TAB_TAG\s*=\s*"__ai_research__"/);
  });

  t(label + ": bootstrapAiTab creates exactly one reserved AI tab, idempotently", () => {
    const api = loadTabs(src, { tabs: [] });
    api.bootstrapAiTab();
    assert.strictEqual(api.tabs().length, 1);
    assert.strictEqual(api.tabs()[0].reserved, true);
    assert.strictEqual(api.tabs()[0].tag, "__ai_research__");
    assert.strictEqual(api.tabs()[0].name, "AI");
    api.bootstrapAiTab();   // calling again must not create a second one
    assert.strictEqual(api.tabs().length, 1);
  });

  t(label + ": bootstrapAiTab does nothing if a reserved tab already exists", () => {
    const existing = [{ id: "x", name: "AI", tag: "__ai_research__", reserved: true, createdAt: 1 }];
    const api = loadTabs(src, { tabs: existing });
    api.bootstrapAiTab();
    assert.strictEqual(api.tabs().length, 1);
    assert.strictEqual(api.tabs()[0].id, "x");   // untouched, not replaced
  });

  t(label + ": createTab creates a new tab keyed by the lowercased name as its tag", () => {
    const api = loadTabs(src, { tabs: [] });
    const created = api.createTab("STL files");
    assert.strictEqual(created.name, "STL files");
    assert.strictEqual(created.tag, "stl files");
    assert.strictEqual(created.reserved, false);
    assert.strictEqual(api.tabs().length, 1);
  });

  t(label + ": createTab refuses a duplicate (same tag, case-insensitive) and returns null", () => {
    const api = loadTabs(src, { tabs: [{ id: "1", name: "STL files", tag: "stl files", reserved: false, createdAt: 1 }] });
    const result = api.createTab("stl Files");
    assert.strictEqual(result, null);
    assert.strictEqual(api.tabs().length, 1);
  });

  t(label + ": createTab rejects an empty/whitespace-only name", () => {
    const api = loadTabs(src, { tabs: [] });
    assert.strictEqual(api.createTab("   "), null);
    assert.strictEqual(api.tabs().length, 0);
  });

  t(label + ": renameTab updates the name but leaves the underlying tag untouched", () => {
    const api = loadTabs(src, { tabs: [{ id: "1", name: "STL files", tag: "stl files", reserved: false, createdAt: 1 }] });
    api.renameTab("1", "3D Prints");
    assert.strictEqual(api.tabs()[0].name, "3D Prints");
    assert.strictEqual(api.tabs()[0].tag, "stl files");
  });

  t(label + ": renameTab is a no-op on the reserved tab", () => {
    const api = loadTabs(src, { tabs: [{ id: "1", name: "AI", tag: "__ai_research__", reserved: true, createdAt: 1 }] });
    api.renameTab("1", "Something else");
    assert.strictEqual(api.tabs()[0].name, "AI");
  });

  t(label + ": deleteTab unpins a non-reserved tab and returns true", () => {
    const api = loadTabs(src, { tabs: [{ id: "1", name: "STL files", tag: "stl files", reserved: false, createdAt: 1 }] });
    assert.strictEqual(api.deleteTab("1"), true);
    assert.strictEqual(api.tabs().length, 0);
  });

  t(label + ": deleteTab refuses to delete the reserved tab and returns false", () => {
    const api = loadTabs(src, { tabs: [{ id: "1", name: "AI", tag: "__ai_research__", reserved: true, createdAt: 1 }] });
    assert.strictEqual(api.deleteTab("1"), false);
    assert.strictEqual(api.tabs().length, 1);
  });

  t(label + ": deleteTab does NOT strip the tag from any card (non-destructive unpin)", () => {
    const importedArr = [{ id: "i0", tags: ["stl files"] }];
    const api = loadTabs(src, { imported: importedArr, tabs: [{ id: "1", name: "STL files", tag: "stl files", reserved: false, createdAt: 1 }] });
    api.deleteTab("1");
    assert.deepStrictEqual(importedArr[0].tags, ["stl files"]);
  });

  t(label + ": cardHasTag checks the tags array directly and tolerates null holes/missing tags", () => {
    const api = loadTabs(src, {});
    assert.strictEqual(api.cardHasTag({ tags: ["a", "b"] }, "a"), true);
    assert.strictEqual(api.cardHasTag({ tags: ["a", "b"] }, "c"), false);
    assert.strictEqual(api.cardHasTag({ tags: null }, "a"), false);
    assert.strictEqual(api.cardHasTag(null, "a"), false);
  });

  t(label + ": tabCardCount counts matching cards across BOTH imported and saved, tolerating null holes", () => {
    const importedArr = [{ tags: ["stl files"] }, { tags: ["other"] }];
    const savedArr = [{ tags: ["stl files"] }, { tags: [] }, null];   // bulk-remove leaves null holes in `saved`
    const api = loadTabs(src, { imported: importedArr, saved: savedArr });
    assert.strictEqual(api.tabCardCount("stl files"), 2);
  });

  t(label + ": allTags() excludes the reserved AI_TAB_TAG from its output", () => {
    const factory = new Function(
      "imported", "saved", "AI_TAB_TAG",
      fn(src, "allTags") + "\nreturn allTags;"
    );
    const allTags = factory(
      [{ tags: ["3d printing", "__ai_research__"] }], [{ tags: ["stl files"] }], "__ai_research__"
    );
    const out = allTags();
    assert.ok(!out.includes("__ai_research__"));
    assert.ok(out.includes("3d printing"));
    assert.ok(out.includes("stl files"));
  });

  t(label + ": tagRow() never renders the reserved AI_TAB_TAG as a visible chip", () => {
    const factory = new Function(
      "esc", "curTab", "viewMode", "impTag", "AI_TAB_TAG",
      fn(src, "tagRow") + "\nreturn tagRow;"
    );
    const escFn = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const tagRow = factory(escFn, "saved", "g4", "", "__ai_research__");
    const out = tagRow(["stl files", "__ai_research__"], "s0", "saved");
    assert.ok(!out.includes("__ai_research__"));
    assert.match(out, /stl files/);
  });

  t(label + ": aiSuggestTags's cleaning loop drops a literal AI_TAB_TAG suggestion (defense in depth)", () => {
    const body = fn(src, "aiSuggestTags");
    assert.match(body, /t\.toLowerCase\(\)===AI_TAB_TAG/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tabs-crud.test.js`
Expected: FAIL — every test throws (`cardHasTag not found in source`, etc.) since none of these functions/constants exist yet.

- [ ] **Step 3: Write the implementation**

In `web/index.html`, insert this new block immediately after `tagRow()`'s closing brace (`web/index.html:3316`, right before the `/* ---- inline tag editing (works across imported + saved) ---- */` comment):

```js
/* ---- custom tabs (pinned tags) ---- */
const AI_TAB_TAG = "__ai_research__";   // namespaced so it can never collide with a user-typed tag
let tabs = [];   // [{id,name,tag,reserved,createdAt}] — hydrated from Store.kv in bootData()
function cardHasTag(it, tag){ return !!(it && it.tags && it.tags.includes(tag)); }
function tabCardCount(tag){
  return imported.filter(it=>cardHasTag(it,tag)).length + saved.filter(it=>cardHasTag(it,tag)).length;
}
// Auto-creates the reserved AI tab exactly once (idempotent — safe to call every boot).
function bootstrapAiTab(){
  if(tabs.some(t=>t.reserved)) return;
  tabs.push({ id:newId(), name:"AI", tag:AI_TAB_TAG, reserved:true, createdAt:Date.now() });
  save("tabs", tabs);
}
function createTab(name){
  name=(name||"").trim();
  if(!name) return null;
  const tag=name.toLowerCase();
  if(tabs.some(t=>t.tag===tag)){ toast(`A tab named "${name}" already exists`); return null; }
  const t={ id:newId(), name, tag, reserved:false, createdAt:Date.now() };
  tabs.push(t);
  save("tabs", tabs);
  return t;
}
function renameTab(id, name){
  name=(name||"").trim(); if(!name) return;
  const t=tabs.find(x=>x.id===id);
  if(!t || t.reserved) return;
  t.name=name;
  save("tabs", tabs);
}
function deleteTab(id){
  const t=tabs.find(x=>x.id===id);
  if(!t || t.reserved) return false;
  tabs=tabs.filter(x=>x.id!==id);
  save("tabs", tabs);
  return true;
}
```

Modify `allTags()` (`web/index.html:3325-3330` — locate by content, this exact block):

Old:
```js
function allTags(){
  const s=new Set();
  imported.forEach(i=>(i&&i.tags||[]).forEach(t=>s.add(t)));
  saved.forEach(i=>(i&&i.tags||[]).forEach(t=>s.add(t)));
  return [...s].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
}
```

New:
```js
function allTags(){
  const s=new Set();
  imported.forEach(i=>(i&&i.tags||[]).forEach(t=>{ if(t!==AI_TAB_TAG) s.add(t); }));
  saved.forEach(i=>(i&&i.tags||[]).forEach(t=>{ if(t!==AI_TAB_TAG) s.add(t); }));
  return [...s].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
}
```

Modify `tagRow()` (`web/index.html:3302-3316` — locate by content, this exact block):

Old:
```js
function tagRow(tags, identity, scope){
  scope = scope || "imported";
  if(scope==="saved"){
    const chips=(tags||[]).map(t=>`<span class="tg" data-tag="${esc(t)}">${esc(t)}<span class="tgx" title="Remove tag" onclick="event.stopPropagation();cardRemoveTagEl('saved','${esc(identity)}',this)">&times;</span></span>`).join("");
    return `<div class="tagsline edit">${chips}<span class="tg tg-add" title="Add tag" onclick="event.stopPropagation();openTagPicker('saved','${esc(identity)}',event)">+</span><span class="tg tg-auto" title="AutoTag with AI" onclick="event.stopPropagation();openAutoTag('saved','${esc(identity)}',event)">&#10024; AI</span></div>`;
  }
  // Editable chips + a "+" picker in the 1x1 imported view; read-only elsewhere.
  if(typeof identity==="number" && curTab==="imported" && viewMode==="g1"){
    const chips=(tags||[]).map(t=>`<span class="tg" data-tag="${esc(t)}" onclick="event.stopPropagation();if(curTab!=='imported')showTab('imported');setImpTag('${esc(t)}')">${esc(t)}<span class="tgx" title="Remove tag" onclick="event.stopPropagation();cardRemoveTagEl('imported',${identity},this)">&times;</span></span>`).join("");
    return `<div class="tagsline edit">${chips}<span class="tg tg-add" title="Add tag" onclick="event.stopPropagation();openTagPicker('imported',${identity},event)">+</span><span class="tg tg-auto" title="AutoTag with AI" onclick="event.stopPropagation();openAutoTag('imported',${identity},event)">&#10024; AI</span></div>`;
  }
  return tags && tags.length
    ? `<div class="tagsline">${tags.map(t=>`<span class="tg${impTag===t?" on":""}" onclick="event.stopPropagation();if(curTab!=='imported')showTab('imported');setImpTag('${esc(t)}')">${esc(t)}</span>`).join("")}</div>`
    : "";
}
```

New:
```js
function tagRow(tags, identity, scope){
  scope = scope || "imported";
  tags = (tags||[]).filter(t=>t!==AI_TAB_TAG);   // the reserved AI-tab tag is an implementation detail, never shown as a chip
  if(scope==="saved"){
    const chips=tags.map(t=>`<span class="tg" data-tag="${esc(t)}">${esc(t)}<span class="tgx" title="Remove tag" onclick="event.stopPropagation();cardRemoveTagEl('saved','${esc(identity)}',this)">&times;</span></span>`).join("");
    return `<div class="tagsline edit">${chips}<span class="tg tg-add" title="Add tag" onclick="event.stopPropagation();openTagPicker('saved','${esc(identity)}',event)">+</span><span class="tg tg-auto" title="AutoTag with AI" onclick="event.stopPropagation();openAutoTag('saved','${esc(identity)}',event)">&#10024; AI</span></div>`;
  }
  // Editable chips + a "+" picker in the 1x1 imported view; read-only elsewhere.
  if(typeof identity==="number" && curTab==="imported" && viewMode==="g1"){
    const chips=tags.map(t=>`<span class="tg" data-tag="${esc(t)}" onclick="event.stopPropagation();if(curTab!=='imported')showTab('imported');setImpTag('${esc(t)}')">${esc(t)}<span class="tgx" title="Remove tag" onclick="event.stopPropagation();cardRemoveTagEl('imported',${identity},this)">&times;</span></span>`).join("");
    return `<div class="tagsline edit">${chips}<span class="tg tg-add" title="Add tag" onclick="event.stopPropagation();openTagPicker('imported',${identity},event)">+</span><span class="tg tg-auto" title="AutoTag with AI" onclick="event.stopPropagation();openAutoTag('imported',${identity},event)">&#10024; AI</span></div>`;
  }
  return tags.length
    ? `<div class="tagsline">${tags.map(t=>`<span class="tg${impTag===t?" on":""}" onclick="event.stopPropagation();if(curTab!=='imported')showTab('imported');setImpTag('${esc(t)}')">${esc(t)}</span>`).join("")}</div>`
    : "";
}
```

Modify `aiSuggestTags()`'s cleaning loop — locate by content, the line inside `aiSuggestTags` (`web/index.html:3526`) that starts `arr.forEach(t=>{ t=(""+t).replace(/^#/,"").trim(); if(!t||t.length>40) return;`:

Old:
```js
  arr.forEach(t=>{ t=(""+t).replace(/^#/,"").trim(); if(!t||t.length>40) return; t=canonicalTag(t); const k=t.toLowerCase(); if(seen.has(k)) return; seen.add(k);
```

New:
```js
  arr.forEach(t=>{ t=(""+t).replace(/^#/,"").trim(); if(!t||t.length>40||t.toLowerCase()===AI_TAB_TAG) return; t=canonicalTag(t); const k=t.toLowerCase(); if(seen.has(k)) return; seen.add(k);
```

Modify `bootData()` — locate by content, immediately after the line `tagStats  = (await load("tagstats", {})) || {};` (`web/index.html:7592`):

Old:
```js
  tagStats  = (await load("tagstats", {})) || {};
```

New:
```js
  tagStats  = (await load("tagstats", {})) || {};
  tabs = (await load("tabs", [])) || [];
  bootstrapAiTab();
```

Apply all five edits identically to `pwa/index.html` (locate each by content — the anchors above are identical text in both files).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tabs-crud.test.js`
Expected: PASS (16 assertions — 8 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-crud.test.js
git commit -m "Custom tabs: ia_tabs data model, CRUD, reserved AI tab, reserved-tag suppression

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Nav entry + Tabs view (pill row and tab-detail grid)

**Files:**
- Modify: `web/index.html` (desktop nav `web/index.html:512-517`; mobile nav `web/index.html:523-528`; view container `web/index.html:534`; `showTab()` `web/index.html:1031-1055`; new `tabsFilteredList`/`openTab`/`newTabPrompt`/`renameTabPrompt`/`deleteTabPrompt`/`renderTabsView` functions, placed after Task 1's new block)
- Modify: `pwa/index.html` (same, located by content)
- Test: `tests/tabs-view.test.js` (new)

**Interfaces:**
- Consumes: `tabs`, `cardHasTag`, `createTab`, `renameTab`, `deleteTab` (Task 1), `cardHTML(item,mode)` (existing, `web/index.html:1262`), `impCardHTML(it,idx)` (existing, `web/index.html:3755`), `gridClass()`/`attachCardImages()` (existing, used by `renderSaved()`).
- Produces: `openTabId` (module state — id of the currently open tab pill, or `null`), `tabsFilteredList(tag)` (pure — returns `[{kind:"imported",it,idx}]` or `[{kind:"saved",it}]` for every card carrying `tag`), `openTab(id)`, `renderTabsView()`. Task 4/5/6 render inside `#view-tabs` via `renderTabsView()` and read `openTabId`/`tabsFilteredList`.

- [ ] **Step 1: Write the failing test**

Create `tests/tabs-view.test.js`:

```js
// tests/tabs-view.test.js — Task 2: the pure list-building logic behind the Tabs
// nav view (tabsFilteredList — critically, it must preserve each imported card's
// REAL index into `imported`, not a compacted 0..n index, since impCardHTML's
// buttons are all wired to that real index), plus showTab's wiring (nav array +
// catBar visibility) and openTab's state transition. Full DOM rendering
// (renderTabsView's innerHTML) is exercised by a manual smoke check per this
// repo's convention for innerHTML-heavy view functions (see tag-editing-render's
// sibling scope — pure logic gets unit tests, DOM string-building gets smoke-tested).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadFilteredList(src, importedArr, savedArr){
  const factory = new Function(
    "imported", "saved", "cardHasTag",
    fn(src,"tabsFilteredList") + "\nreturn tabsFilteredList;"
  );
  return factory(importedArr, savedArr, (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)));
}

function loadOpenTab(src, initialOpenTabId, log){
  const factory = new Function(
    "openTabId", "window", "renderTabsView",
    fn(src, "openTab") + "\nreturn { openTab, get: () => openTabId };"
  );
  return factory(initialOpenTabId, { scrollTo: () => {} }, () => log.push("rendered"));
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": tabsFilteredList returns imported entries WITH their real array index", () => {
    const importedArr = [{tags:["x"]}, {tags:["stl files"]}, {tags:["x"]}, {tags:["stl files"]}];
    const tabsFilteredList = loadFilteredList(src, importedArr, []);
    const list = tabsFilteredList("stl files");
    assert.deepStrictEqual(list.map(r=>r.idx), [1,3]);
    assert.ok(list.every(r=>r.kind==="imported"));
  });

  t(label + ": tabsFilteredList includes matching saved entries (kind='saved', no idx)", () => {
    const savedArr = [{id:"s0",tags:["stl files"]}, {id:"s1",tags:["other"]}];
    const tabsFilteredList = loadFilteredList(src, [], savedArr);
    const list = tabsFilteredList("stl files");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].kind, "saved");
    assert.strictEqual(list[0].it.id, "s0");
    assert.strictEqual(list[0].idx, undefined);
  });

  t(label + ": tabsFilteredList tolerates a null hole in saved without throwing", () => {
    const savedArr = [null, {id:"s1",tags:["stl files"]}];
    const tabsFilteredList = loadFilteredList(src, [], savedArr);
    const list = tabsFilteredList("stl files");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].it.id, "s1");
  });

  t(label + ": openTab sets openTabId and triggers a re-render", () => {
    const log = [];
    const api = loadOpenTab(src, null, log);
    api.openTab("t1");
    assert.strictEqual(api.get(), "t1");
    assert.deepStrictEqual(log, ["rendered"]);
  });

  t(label + ": showTab wiring includes the new tabs view (nav array + catBar hidden + render call)", () => {
    const body = fn(src, "showTab");
    assert.match(body, /\[\s*"stumble"\s*,\s*"saved"\s*,\s*"imported"\s*,\s*"settings"\s*,\s*"tabs"\s*\]/);
    assert.match(body, /t===["']settings["']\s*\|\|\s*t===["']tabs["']/);
    assert.match(body, /if\(t===["']tabs["']\)\{\s*selMode=false;\s*selPicks\.clear\(\);\s*renderTabsView\(\)/);
  });

  t(label + ": the desktop nav and mobile nav both gained a Tabs button", () => {
    const navMatches = src.match(/data-tab="tabs"/g) || [];
    assert.strictEqual(navMatches.length, 2, "expected exactly 2 data-tab=\"tabs\" buttons (desktop + mobile)");
  });

  t(label + ": a #view-tabs container exists", () => {
    assert.match(src, /id="view-tabs"/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tabs-view.test.js`
Expected: FAIL — `tabsFilteredList not found in source`, etc.

- [ ] **Step 3: Write the implementation**

Add a new nav button to the desktop nav (`web/index.html:512-517` — locate by content):

Old:
```html
    <nav>
      <button class="tab active" data-tab="stumble" onclick="showTab('stumble')">Stumble</button>
      <button class="tab" data-tab="saved" onclick="showTab('saved')">Saved <span class="cnt" data-cnt="saved"></span></button>
      <button class="tab" data-tab="imported" onclick="showTab('imported')">Imported <span class="cnt" data-cnt="imported"></span></button>
      <button class="tab" data-tab="settings" onclick="showTab('settings')">Settings</button>
    </nav>
```

New:
```html
    <nav>
      <button class="tab active" data-tab="stumble" onclick="showTab('stumble')">Stumble</button>
      <button class="tab" data-tab="saved" onclick="showTab('saved')">Saved <span class="cnt" data-cnt="saved"></span></button>
      <button class="tab" data-tab="imported" onclick="showTab('imported')">Imported <span class="cnt" data-cnt="imported"></span></button>
      <button class="tab" data-tab="tabs" onclick="showTab('tabs')">Tabs</button>
      <button class="tab" data-tab="settings" onclick="showTab('settings')">Settings</button>
    </nav>
```

Add the matching mobile nav button (`web/index.html:523-528` — locate by content):

Old:
```html
<nav class="mtabbar" aria-label="Main">
  <button class="tab mtab active" data-tab="stumble" onclick="showTab('stumble')"><span class="micon">&#127919;</span>Stumble</button>
  <button class="tab mtab" data-tab="saved" onclick="showTab('saved')"><span class="micon">&#11088;</span><span>Saved <span class="cnt" data-cnt="saved"></span></span></button>
  <button class="tab mtab" data-tab="imported" onclick="showTab('imported')"><span class="micon">&#128229;</span><span>Imported <span class="cnt" data-cnt="imported"></span></span></button>
  <button class="tab mtab" data-tab="settings" onclick="showTab('settings')"><span class="micon">&#9881;</span>Settings</button>
</nav>
```

New:
```html
<nav class="mtabbar" aria-label="Main">
  <button class="tab mtab active" data-tab="stumble" onclick="showTab('stumble')"><span class="micon">&#127919;</span>Stumble</button>
  <button class="tab mtab" data-tab="saved" onclick="showTab('saved')"><span class="micon">&#11088;</span><span>Saved <span class="cnt" data-cnt="saved"></span></span></button>
  <button class="tab mtab" data-tab="imported" onclick="showTab('imported')"><span class="micon">&#128229;</span><span>Imported <span class="cnt" data-cnt="imported"></span></span></button>
  <button class="tab mtab" data-tab="tabs" onclick="showTab('tabs')"><span class="micon">&#128204;</span>Tabs</button>
  <button class="tab mtab" data-tab="settings" onclick="showTab('settings')"><span class="micon">&#9881;</span>Settings</button>
</nav>
```

Add the view container (`web/index.html:534` — locate by content):

Old:
```html
  <div id="view-imported" style="display:none"></div>
```

New:
```html
  <div id="view-imported" style="display:none"></div>
  <div id="view-tabs" style="display:none"></div>
```

Modify `showTab()` (`web/index.html:1031-1055` — locate by content, this exact block):

Old:
```js
function showTab(t, deferStumble){
  curTab = t;
  mobileFilterOpen = false;
  _refreshPins.clear();
  save("tab", t);
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===t));
  ["stumble","saved","imported","settings"].forEach(v=>document.getElementById("view-"+v).style.display = v===t?"":"none");
  window.scrollTo(0,0);   // land at the top of every tab — don't inherit the previous tab's scroll depth
  document.getElementById("catBar").style.display = t==="settings"?"none":"";
  renderCatBar();
  if(t==="saved") renderSaved();
  if(t==="settings") renderSettings();
  // "NEW" badge semantics: a card is NEW if it was imported after the LAST
  // visit to the Imported tab (per-device stamp in localStorage, ia_impseen).
  // The stamp advances on each visit, so badges self-clear once seen. A
  // missing stamp (first run after this feature shipped) initializes
  // silently — badging the whole historical library as NEW helps no one.
  if(t==="imported"){
    const prev = Number(localStorage.getItem("ia_impseen")||0);
    _impPrevSeen = prev || Date.now();
    try{ localStorage.setItem("ia_impseen", String(Date.now())); }catch(e){}
    renderImported();
  }
  if(t==="stumble"){ if(!stDeal.length && !deferStumble) stumbleNext(); else renderStumble(); }
}
```

New:
```js
function showTab(t, deferStumble){
  curTab = t;
  mobileFilterOpen = false;
  _refreshPins.clear();
  save("tab", t);
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===t));
  ["stumble","saved","imported","settings","tabs"].forEach(v=>document.getElementById("view-"+v).style.display = v===t?"":"none");
  window.scrollTo(0,0);   // land at the top of every tab — don't inherit the previous tab's scroll depth
  document.getElementById("catBar").style.display = (t==="settings"||t==="tabs")?"none":"";
  renderCatBar();
  if(t==="saved") renderSaved();
  if(t==="settings") renderSettings();
  if(t==="tabs"){ selMode=false; selPicks.clear(); renderTabsView(); }
  // "NEW" badge semantics: a card is NEW if it was imported after the LAST
  // visit to the Imported tab (per-device stamp in localStorage, ia_impseen).
  // The stamp advances on each visit, so badges self-clear once seen. A
  // missing stamp (first run after this feature shipped) initializes
  // silently — badging the whole historical library as NEW helps no one.
  if(t==="imported"){
    const prev = Number(localStorage.getItem("ia_impseen")||0);
    _impPrevSeen = prev || Date.now();
    try{ localStorage.setItem("ia_impseen", String(Date.now())); }catch(e){}
    renderImported();
  }
  if(t==="stumble"){ if(!stDeal.length && !deferStumble) stumbleNext(); else renderStumble(); }
}
```

Add the new Tabs-view functions — insert this block right after Task 1's new block (after `deleteTab`'s closing brace):

```js
/* ---- Tabs nav view ---- */
let openTabId = null;   // id of the currently open tab pill, or null (no tabs yet / just deleted)
// Pure: every card (imported OR saved) currently carrying `tag`. Imported entries
// keep their REAL index into `imported` (impCardHTML's buttons are index-wired),
// saved entries carry the item only (saved's own actions address by .id).
function tabsFilteredList(tag){
  const list = [];
  imported.forEach((it,idx)=>{ if(cardHasTag(it,tag)) list.push({kind:"imported", it, idx}); });
  saved.forEach(it=>{ if(it && cardHasTag(it,tag)) list.push({kind:"saved", it}); });
  return list;
}
function openTab(id){
  openTabId = id;
  window.scrollTo(0,0);
  renderTabsView();
}
function newTabPrompt(){
  const name = prompt("New tab name:");
  if(name==null) return;
  const created = createTab(name);
  if(created) openTab(created.id);
  else renderTabsView();
}
function renameTabPrompt(id){
  const t = tabs.find(x=>x.id===id); if(!t || t.reserved) return;
  const name = prompt("Rename tab:", t.name);
  if(name==null) return;
  renameTab(id, name);
  renderTabsView();
}
function deleteTabPrompt(id){
  const t = tabs.find(x=>x.id===id); if(!t) return;
  if(t.reserved){ toast("The AI tab can't be deleted"); return; }
  if(confirm(`Remove the "${t.name}" tab? Cards keep their "${t.tag}" tag — nothing is deleted.`)){
    if(deleteTab(id) && openTabId===id) openTabId=null;
    renderTabsView();
  }
}
function renderTabsView(){
  const v = document.getElementById("view-tabs"); if(!v) return;
  if((!openTabId || !tabs.some(x=>x.id===openTabId)) && tabs.length) openTabId = tabs[0].id;
  const pills = tabs.map(tb=>
    `<button class="catpill${openTabId===tb.id?" on":""}" style="${openTabId===tb.id?"background:var(--ink)":""}" onclick="openTab('${tb.id}')">${tb.reserved?"&#129302; ":""}${esc(tb.name)} <span class="cnt">${tabCardCount(tb.tag)}</span></button>`
  ).join("") + `<button class="catpill" onclick="newTabPrompt()">+ New tab</button>`;
  const t = tabs.find(x=>x.id===openTabId);
  let gridHtml;
  if(!tabs.length){
    gridHtml = `<div class="empty"><h2>No tabs yet</h2><p>Create a tab to organize cards around a topic — like "STL files" or a project you're tracking.</p><button class="btn btn-primary" onclick="newTabPrompt()">+ New tab</button></div>`;
  } else if(!t){
    gridHtml = "";
  } else {
    const list = tabsFilteredList(t.tag);
    gridHtml = !list.length
      ? `<div class="empty"><h2>Nothing in "${esc(t.name)}" yet</h2><p>Add cards from Saved or Imported using the tag picker's Tabs section.</p></div>`
      : `<div class="${gridClass()}">${list.map(r=>r.kind==="saved"?cardHTML(r.it,"saved"):impCardHTML(r.it,r.idx)).join("")}</div>`;
  }
  const manageHtml = t && !t.reserved
    ? `<button class="btn btn-ghost" onclick="renameTabPrompt('${t.id}')">Rename</button><button class="btn btn-ghost" onclick="deleteTabPrompt('${t.id}')">Remove tab</button>`
    : "";
  v.innerHTML = `<div class="tabbar-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">${pills}</div>` +
    (t ? `<div style="display:flex;gap:8px;margin-bottom:10px">${manageHtml}</div>` : "") +
    gridHtml;
  attachCardImages();
}
```

Apply all edits identically to `pwa/index.html` (locate each by content).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tabs-view.test.js`
Expected: PASS (14 assertions — 7 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-view.test.js
git commit -m "Custom tabs: Tabs nav entry, pill row, and tab-detail grid

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Individual populate — pinned Tabs section in the tag picker

**Files:**
- Modify: `web/index.html` (new `tabPickerRows()` function, placed after Task 2's block; `renderTagPicker()`; a small CSS addition near `.tp-empty`)
- Modify: `pwa/index.html` (same, located by content)
- Test: `tests/tabs-picker.test.js` (new)

**Interfaces:**
- Consumes: `tabs` (Task 1), `_tagPickItem()`/`tagPickerToggle(btn)` (Plan 1, unchanged — a tab pill toggle reuses `tagPickerToggle` directly via the same `data-tag` attribute a regular tag row uses).
- Produces: `tabPickerRows()` (returns the pinned-tabs section HTML, or `""` if there are no tabs yet).

- [ ] **Step 1: Write the failing test**

Create `tests/tabs-picker.test.js`:

```js
// tests/tabs-picker.test.js — Task 3: the tag picker's pinned "Tabs" section
// (tabPickerRows). Toggling a tab pill reuses tagPickerToggle directly (a tab IS
// a tag), so this only needs to prove the pill row itself is built correctly:
// one entry per tab, checked state reflecting the card's current tags, the
// reserved AI tab's icon, and that renderTagPicker actually calls it before the
// new-tag input.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadTabPickerRows(src, state){
  const body = [fn(src,"_tagPickItem"), fn(src,"tabPickerRows")].join("\n");
  const factory = new Function(
    "imported", "saved", "_tagPickScope", "_tagPickIdx", "_tagPickId", "tabs", "esc",
    body + "\nreturn tabPickerRows;"
  );
  const escFn = (s) => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  return factory(state.imported||[], state.saved||[], state.scope||"imported", state.idx??-1, state.id??null, state.tabs||[], escFn);
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": tabPickerRows renders one pill per tab, data-tag = the tab's tag", () => {
    const tabsList = [{id:"1",name:"STL files",tag:"stl files",reserved:false}, {id:"2",name:"AI",tag:"__ai_research__",reserved:true}];
    const importedArr = [{id:"i0", tags:[]}];
    const tabPickerRows = loadTabPickerRows(src, { imported: importedArr, scope:"imported", idx:0, tabs: tabsList });
    const out = tabPickerRows();
    assert.match(out, /data-tag="stl files"/);
    assert.match(out, /data-tag="__ai_research__"/);
  });

  t(label + ": a tab pill shows checked state when the card already carries that tag", () => {
    const tabsList = [{id:"1",name:"STL files",tag:"stl files",reserved:false}];
    const importedArr = [{id:"i0", tags:["stl files"]}];
    const tabPickerRows = loadTabPickerRows(src, { imported: importedArr, scope:"imported", idx:0, tabs: tabsList });
    const out = tabPickerRows();
    assert.match(out, /tp-row tp-tab on/);
    assert.match(out, /&#10003;/);
  });

  t(label + ": reserved tab pill gets the robot icon, non-reserved does not", () => {
    const tabsList = [{id:"1",name:"AI",tag:"__ai_research__",reserved:true}, {id:"2",name:"STL files",tag:"stl files",reserved:false}];
    const importedArr = [{id:"i0", tags:[]}];
    const tabPickerRows = loadTabPickerRows(src, { imported: importedArr, scope:"imported", idx:0, tabs: tabsList });
    const out = tabPickerRows();
    const rows = out.split("<button").slice(1);
    assert.ok(rows[0].includes("&#129302;"));
    assert.ok(!rows[1].includes("&#129302;"));
  });

  t(label + ": tabPickerRows returns an empty string when there are no tabs yet", () => {
    const importedArr = [{id:"i0", tags:[]}];
    const tabPickerRows = loadTabPickerRows(src, { imported: importedArr, scope:"imported", idx:0, tabs: [] });
    assert.strictEqual(tabPickerRows(), "");
  });

  t(label + ": renderTagPicker calls tabPickerRows() and places it before the new-tag input", () => {
    const body = fn(src, "renderTagPicker");
    const tabsIdx = body.indexOf("tabPickerRows()");
    const newIdx = body.indexOf("tp-new");
    assert.ok(tabsIdx >= 0, "tabPickerRows() not called from renderTagPicker");
    assert.ok(tabsIdx < newIdx, "tabPickerRows() must render before the new-tag input");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tabs-picker.test.js`
Expected: FAIL — `tabPickerRows not found in source`.

- [ ] **Step 3: Write the implementation**

Insert this new function right after Task 2's block (after `renderTabsView`'s closing brace):

```js
// Pinned "Tabs" section at the top of the tag picker — a tab is just a tag, so
// toggling one of these pills IS adding/removing that tag (reuses tagPickerToggle
// directly via the same data-tag attribute the regular tag rows already use).
function tabPickerRows(){
  const it = _tagPickItem(); if(!it || !tabs.length) return "";
  const have = new Set((it.tags||[]).map(t=>t.toLowerCase()));
  const chips = tabs.map(tb=>
    `<button class="tp-row tp-tab${have.has(tb.tag.toLowerCase())?" on":""}" data-tag="${esc(tb.tag)}" onclick="event.stopPropagation();tagPickerToggle(this)">${have.has(tb.tag.toLowerCase())?"&#10003; ":""}${tb.reserved?"&#129302; ":""}${esc(tb.name)}</button>`
  ).join("");
  return `<div class="tp-tabs-label">Tabs</div><div class="tp-tabs">${chips}</div>`;
}
```

Modify `renderTagPicker()` — locate by content, this exact block:

Old:
```js
function renderTagPicker(){
  const p=document.getElementById("tagPicker"); if(!p) return;
  const it=_tagPickItem(); if(!it){ closeTagPicker(); return; }
  p.innerHTML =
    `<div class="tp-new"><input id="tpNew" placeholder="New tag…" autocomplete="off" oninput="filterTagPicker(this.value)" onkeydown="tagPickerKey(event)"><button id="tpAdd" onclick="event.stopPropagation();tagPickerNewTag()">Add</button></div>`+
    `<label class="tp-multi"><input type="checkbox" id="tpMulti" ${_tagMulti?"checked":""} onchange="toggleTagMulti(this.checked)"> Select multiple</label>`+
    `<div class="tp-list">${tagPickerRows("")}</div>`;
}
```

New:
```js
function renderTagPicker(){
  const p=document.getElementById("tagPicker"); if(!p) return;
  const it=_tagPickItem(); if(!it){ closeTagPicker(); return; }
  p.innerHTML =
    tabPickerRows() +
    `<div class="tp-new"><input id="tpNew" placeholder="New tag…" autocomplete="off" oninput="filterTagPicker(this.value)" onkeydown="tagPickerKey(event)"><button id="tpAdd" onclick="event.stopPropagation();tagPickerNewTag()">Add</button></div>`+
    `<label class="tp-multi"><input type="checkbox" id="tpMulti" ${_tagMulti?"checked":""} onchange="toggleTagMulti(this.checked)"> Select multiple</label>`+
    `<div class="tp-list">${tagPickerRows("")}</div>`;
}
```

Add CSS for the pinned section — locate by content, immediately after the `.tp-empty{...}` rule (`web/index.html:456`):

Old:
```css
.tp-empty{padding:8px 10px;color:var(--muted);font-size:12px}
```

New:
```css
.tp-empty{padding:8px 10px;color:var(--muted);font-size:12px}
.tp-tabs-label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;padding:4px 10px 2px}
.tp-tabs{display:flex;flex-direction:column;margin-bottom:4px;border-bottom:1px solid var(--line);padding-bottom:4px}
```

Apply all edits identically to `pwa/index.html` (locate each by content).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tabs-picker.test.js`
Expected: PASS (10 assertions — 5 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-picker.test.js
git commit -m "Custom tabs: pinned Tabs section in the tag picker

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Bulk populate — "Add to tab" from Saved and Imported

**Files:**
- Modify: `web/index.html` (new `bulkAddTag` helper; new Saved select-mode state + bulk bar; `cardHTML` gets a pick-overlay branch; Imported's existing select-mode bulk bar gets one more button)
- Modify: `pwa/index.html` (same, located by content)
- Test: `tests/tabs-bulk-add.test.js` (new)

**Interfaces:**
- Consumes: `tabs`, `bulkAddTag` is new-in-this-task but shared by both call sites; `Store.putSaved`/`Store.putCards` (existing); `renderSaved()`/`renderImportedKeepFocus()` (existing).
- Produces: `bulkAddTag(items, tag)` (pure — mutates each item's `tags` in place, returns count changed), `savedSelMode`/`savedSelPicks` (new Saved-only select state, `Set` of ids), `toggleSavedSelMode()`, `toggleSavedPick(id)`, `toggleSavedAddTabMenu()`, `savedAddTabMenuHTML()`, `addSavedPicksToTab(tabId)`; `impAddTabMenuOpen`, `toggleImpAddTabMenu()`, `impAddTabMenuHTML()`, `addImportedPicksToTab(tabId)` (extends Imported's existing `selMode`/`selPicks`, unchanged).

- [ ] **Step 1: Write the failing test**

Create `tests/tabs-bulk-add.test.js`:

```js
// tests/tabs-bulk-add.test.js — Task 4: bulkAddTag's pure mutation logic, and the
// Saved-side + Imported-side wiring that calls it. cardHTML's/the bulk bar's
// innerHTML is covered by a manual smoke check (same convention as tabs-view).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": bulkAddTag adds the tag to every item missing it and counts only those changed", () => {
    const factory = new Function(fn(src, "bulkAddTag") + "\nreturn bulkAddTag;");
    const bulkAddTag = factory();
    const items = [{ tags: [] }, { tags: ["stl files"] }, { tags: ["other"] }];
    const n = bulkAddTag(items, "stl files");
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(items[0].tags, ["stl files"]);
    assert.deepStrictEqual(items[1].tags, ["stl files"]);   // already had it — untouched, not duplicated
    assert.deepStrictEqual(items[2].tags, ["other", "stl files"]);
  });

  t(label + ": bulkAddTag is case-insensitive when checking for an existing tag", () => {
    const factory = new Function(fn(src, "bulkAddTag") + "\nreturn bulkAddTag;");
    const bulkAddTag = factory();
    const items = [{ tags: ["STL Files"] }];
    const n = bulkAddTag(items, "stl files");
    assert.strictEqual(n, 0);
    assert.deepStrictEqual(items[0].tags, ["STL Files"]);
  });

  t(label + ": addSavedPicksToTab applies the tab's tag to every picked saved id and persists", () => {
    const savedArr = [{ id: "s0", tags: [] }, { id: "s1", tags: [] }, { id: "s2", tags: [] }];
    const calls = [];
    const body = [fn(src, "bulkAddTag"), fn(src, "addSavedPicksToTab")].join("\n");
    const factory = new Function(
      "saved", "tabs", "savedSelPicks", "savedSelMode", "Store", "toast", "renderSaved",
      body + "\nreturn addSavedPicksToTab;"
    );
    const addSavedPicksToTab = factory(
      savedArr, [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }],
      new Set(["s0", "s2"]), true,
      { putSaved: (arr) => calls.push(["putSaved", arr]) },
      () => calls.push("toast"), () => calls.push("render")
    );
    addSavedPicksToTab("t1");
    assert.deepStrictEqual(savedArr[0].tags, ["stl files"]);
    assert.deepStrictEqual(savedArr[1].tags, []);
    assert.deepStrictEqual(savedArr[2].tags, ["stl files"]);
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putSaved"));
  });

  t(label + ": addImportedPicksToTab applies the tab's tag to every picked imported index and persists", () => {
    const importedArr = [{ tags: [] }, { tags: [] }];
    const calls = [];
    const body = [fn(src, "bulkAddTag"), fn(src, "addImportedPicksToTab")].join("\n");
    const factory = new Function(
      "imported", "tabs", "selPicks", "Store", "toast", "renderImportedKeepFocus",
      body + "\nreturn addImportedPicksToTab;"
    );
    const addImportedPicksToTab = factory(
      importedArr, [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }],
      new Set([0]),
      { putCards: (arr) => calls.push(["putCards", arr]) },
      () => calls.push("toast"), () => calls.push("render")
    );
    addImportedPicksToTab("t1");
    assert.deepStrictEqual(importedArr[0].tags, ["stl files"]);
    assert.deepStrictEqual(importedArr[1].tags, []);
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
  });

  t(label + ": cardHTML's saved-mode branch supports a pick-overlay when savedSelMode is on", () => {
    const body = fn(src, "cardHTML");
    assert.match(body, /savedSelMode/);
    assert.match(body, /toggleSavedPick/);
  });

  t(label + ": Imported's existing select-mode bulk bar gained an Add-to-tab control", () => {
    assert.match(src, /toggleImpAddTabMenu/);
    assert.match(src, /addImportedPicksToTab/);
  });

  t(label + ": a #savedBulkBar container exists in the static shell (both files, not just web)", () => {
    assert.match(src, /id="savedBulkBar"/);
  });

  t(label + ": entering the Tabs view also closes the new Add-to-tab menu", () => {
    const body = fn(src, "showTab");
    assert.match(body, /if\(t===["']tabs["']\)\{\s*selMode=false;\s*selPicks\.clear\(\);\s*impAddTabMenuOpen=false;\s*renderTabsView\(\)/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tabs-bulk-add.test.js`
Expected: FAIL — `bulkAddTag not found in source`, etc.

- [ ] **Step 3: Write the implementation**

Insert this new block right after Task 3's `tabPickerRows` function:

```js
/* ---- bulk "Add to tab" (Saved + Imported) ---- */
// Pure: add `tag` to every item missing it (case-insensitive check). Returns how
// many actually changed, for the toast.
function bulkAddTag(items, tag){
  let n=0;
  items.forEach(it=>{
    if(!it.tags) it.tags=[];
    if(!it.tags.some(x=>x.toLowerCase()===tag.toLowerCase())){ it.tags.push(tag); n++; }
  });
  return n;
}
let savedSelMode = false;
let savedSelPicks = new Set();   // saved item ids
let savedAddTabMenuOpen = false;
function toggleSavedSelMode(){ savedSelMode=!savedSelMode; if(!savedSelMode){ savedSelPicks.clear(); savedAddTabMenuOpen=false; } renderSaved(); }
function toggleSavedPick(id){ savedSelPicks.has(id)?savedSelPicks.delete(id):savedSelPicks.add(id); renderSaved(); }
function toggleSavedAddTabMenu(){ savedAddTabMenuOpen=!savedAddTabMenuOpen; renderSaved(); }
function savedAddTabMenuHTML(){
  if(!savedAddTabMenuOpen) return "";
  if(!tabs.length) return `<div class="addtab-menu"><div class="tp-empty">No tabs yet — create one from the Tabs nav area.</div></div>`;
  return `<div class="addtab-menu">${tabs.map(tb=>`<button class="tp-row" onclick="addSavedPicksToTab('${tb.id}')">${tb.reserved?"&#129302; ":""}${esc(tb.name)}</button>`).join("")}</div>`;
}
function addSavedPicksToTab(tabId){
  const tb = tabs.find(x=>x.id===tabId); if(!tb || !savedSelPicks.size) return;
  const items = saved.filter(s=>s && savedSelPicks.has(s.id));
  const n = bulkAddTag(items, tb.tag);
  Store.putSaved(saved);
  savedSelMode=false; savedSelPicks.clear(); savedAddTabMenuOpen=false;
  renderSaved();
  toast(n?("Added "+n+" card"+(n>1?"s":"")+" to "+tb.name):"Already in "+tb.name);
}
let impAddTabMenuOpen = false;
function toggleImpAddTabMenu(){ impAddTabMenuOpen=!impAddTabMenuOpen; renderImportedKeepFocus(); }
function impAddTabMenuHTML(){
  if(!impAddTabMenuOpen) return "";
  if(!tabs.length) return `<div class="addtab-menu"><div class="tp-empty">No tabs yet — create one from the Tabs nav area.</div></div>`;
  return `<div class="addtab-menu">${tabs.map(tb=>`<button class="tp-row" onclick="addImportedPicksToTab('${tb.id}')">${tb.reserved?"&#129302; ":""}${esc(tb.name)}</button>`).join("")}</div>`;
}
function addImportedPicksToTab(tabId){
  const tb = tabs.find(x=>x.id===tabId); if(!tb || !selPicks.size) return;
  const items = [...selPicks].map(i=>imported[i]).filter(Boolean);
  const n = bulkAddTag(items, tb.tag);
  Store.putCards(imported);
  renderImportedKeepFocus();
  toast(n?("Added "+n+" card"+(n>1?"s":"")+" to "+tb.name):"Already in "+tb.name);
}
```

Modify `toggleSelMode()` (Imported's existing select toggle, `web/index.html:2713` — locate by content) so leaving select mode also closes the new menu:

Old:
```js
function toggleSelMode(){ selMode=!selMode; if(!selMode) selPicks.clear(); _openedSel.clear(); renderImported(); }
```

New:
```js
function toggleSelMode(){ selMode=!selMode; if(!selMode){ selPicks.clear(); impAddTabMenuOpen=false; } _openedSel.clear(); renderImported(); }
```

Modify `showTab()`'s tabs branch (Task 2's edit — locate by content) so entering the Tabs view also closes the Add-to-tab menu Task 4 just introduced, now that it exists:

Old:
```js
  if(t==="tabs"){ selMode=false; selPicks.clear(); renderTabsView(); }
```

New:
```js
  if(t==="tabs"){ selMode=false; selPicks.clear(); impAddTabMenuOpen=false; renderTabsView(); }
```

Modify Imported's existing bulk action bar (`web/index.html:2908-2914` — locate by content, the `${selMode ? ... : ...}` block) to add one more button. Find the line ending `&#128279; Open (${selPicks.size})</button>` and insert a new line immediately after it, before the `Select all shown` button:

Old (relevant excerpt):
```js
      ${selMode
        ? `<button class="btn btn-primary" id="capSelBtn" onclick="captureSelected()" ${selPicks.size?"":"disabled"} title="Recapture the selected cards via the extension worker — every platform (Instagram, Facebook, bookmarks, YouTube, Pinterest). Each page opens briefly, is captured, and closes; the real screenshot overwrites the old image. Keep Chrome open and stay logged in.">&#128260; Recapture (${selPicks.size})</button>
           <button class="btn btn-ghost" id="fetchBtn" onclick="fetchSelectedInfo()" ${selPicks.size?"":"disabled"} title="Fetch an og:image + AI description without the extension (best for non-Facebook links)">&#11015; Fetch info (${selPicks.size})</button>
           <button class="btn btn-ghost" id="openSelBtn" onclick="openSelected()" ${selPicks.size?"":"disabled"} title="Open each selected card's link in its own browser tab. Your browser may ask to allow pop-ups the first time — allow them for this site.">&#128279; Open (${selPicks.size})</button>
           <button class="btn btn-ghost" onclick="selectShown()">Select all shown</button>
           <button class="btn btn-ghost" onclick="toggleSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleSelMode()">&#9745; Select</button>`}
```

New:
```js
      ${selMode
        ? `<button class="btn btn-primary" id="capSelBtn" onclick="captureSelected()" ${selPicks.size?"":"disabled"} title="Recapture the selected cards via the extension worker — every platform (Instagram, Facebook, bookmarks, YouTube, Pinterest). Each page opens briefly, is captured, and closes; the real screenshot overwrites the old image. Keep Chrome open and stay logged in.">&#128260; Recapture (${selPicks.size})</button>
           <button class="btn btn-ghost" id="fetchBtn" onclick="fetchSelectedInfo()" ${selPicks.size?"":"disabled"} title="Fetch an og:image + AI description without the extension (best for non-Facebook links)">&#11015; Fetch info (${selPicks.size})</button>
           <button class="btn btn-ghost" id="openSelBtn" onclick="openSelected()" ${selPicks.size?"":"disabled"} title="Open each selected card's link in its own browser tab. Your browser may ask to allow pop-ups the first time — allow them for this site.">&#128279; Open (${selPicks.size})</button>
           <button class="btn btn-ghost" onclick="toggleImpAddTabMenu()" ${selPicks.size?"":"disabled"}>Add to tab &#9662;</button>${impAddTabMenuHTML()}
           <button class="btn btn-ghost" onclick="selectShown()">Select all shown</button>
           <button class="btn btn-ghost" onclick="toggleSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleSelMode()">&#9745; Select</button>`}
```

Modify `cardHTML(item, mode)` (`web/index.html:1262-1296` — locate by content, this exact function) to support a Saved-side pick overlay:

Old:
```js
function cardHTML(item, mode){
  const cat = catByName(item.category);
  const dom = domain(item.url);
  const fav = dom ? `https://www.google.com/s2/favicons?domain=${dom}&sz=64` : "";
  const id = esc(item.id);
  const grad = catGrad(cat);
  const chain = imageChain(item);
  imgChains[id] = chain.slice(1);
  const first = chain[0];
  // Big image data URLs (idb-resolved card images or inline saved-clip images) must
  // NOT be inlined into the joined grid HTML — thousands overflow JS's ~512 MB string
  // limit (RangeError, same bug fixed in Imported). Emit a placeholder; attachCardImages
  // fills src after render (IntersectionObserver). Tiny http(s) thumbs stay inline.
  const bigImg = item.image && (String(item.image).indexOf("idb:")===0 || String(item.image).indexOf("data:")===0);
  const imgAttrs = `loading="lazy" data-grad="${grad}" data-fav="${esc(fav)}" data-dom="${esc(dom)}" onerror="nextImg(this,'${id}')" onload="mshotsRetry(this)"`;
  const imgTag = bigImg
    ? `<img data-imgsrc="${id}" ${imgAttrs}>`
    : (first ? `<img src="${esc(first)}" ${imgAttrs}>` : `<div class="ph" style="background:linear-gradient(135deg,${grad})">${fav?`<img src="${esc(fav)}">`:""}${esc(dom||"idea")}</div>`);
  return `<div class="card" id="card-${id}">
    <button class="card-edit" title="Edit title" onclick="event.stopPropagation();cardEdit('${id}')">&#9998;</button>
    <a class="thumb" onclick="openItem('${id}','${mode}')" title="Open article">
      ${imgTag}
    </a>
    <div class="body">
      <span class="chip" style="background:${cat.chip}">${esc(cat.name)}</span>
      <div class="title" onclick="openItem('${id}','${mode}')">${esc(item.title)}</div>
      <div class="src">${esc(item.source||dom)}</div>
      <div class="benefit"><b>Why for you:</b> ${esc(item.benefit)}</div>
      ${mode==="saved"?tagRow(item.tags, item.id, "saved"):""}
    </div>
    <div class="actions">
      <button class="act saved" onclick="unsaveItem('${id}')">&#10003; Saved — remove</button>
    </div>
  </div>`;
}
```

New:
```js
function cardHTML(item, mode){
  const cat = catByName(item.category);
  const dom = domain(item.url);
  const fav = dom ? `https://www.google.com/s2/favicons?domain=${dom}&sz=64` : "";
  const id = esc(item.id);
  const grad = catGrad(cat);
  const chain = imageChain(item);
  imgChains[id] = chain.slice(1);
  const first = chain[0];
  // Big image data URLs (idb-resolved card images or inline saved-clip images) must
  // NOT be inlined into the joined grid HTML — thousands overflow JS's ~512 MB string
  // limit (RangeError, same bug fixed in Imported). Emit a placeholder; attachCardImages
  // fills src after render (IntersectionObserver). Tiny http(s) thumbs stay inline.
  const bigImg = item.image && (String(item.image).indexOf("idb:")===0 || String(item.image).indexOf("data:")===0);
  const imgAttrs = `loading="lazy" data-grad="${grad}" data-fav="${esc(fav)}" data-dom="${esc(dom)}" onerror="nextImg(this,'${id}')" onload="mshotsRetry(this)"`;
  const imgTag = bigImg
    ? `<img data-imgsrc="${id}" ${imgAttrs}>`
    : (first ? `<img src="${esc(first)}" ${imgAttrs}>` : `<div class="ph" style="background:linear-gradient(135deg,${grad})">${fav?`<img src="${esc(fav)}">`:""}${esc(dom||"idea")}</div>`);
  const savedPickOverlay = (mode==="saved" && savedSelMode)
    ? `<div class="pickov" onclick="event.stopPropagation();toggleSavedPick('${id}')">${savedSelPicks.has(item.id)?'<span class="pk">&#10003;</span>':""}</div>`
    : "";
  return `<div class="card${(mode==="saved" && savedSelPicks.has(item.id))?" selpick":""}" id="card-${id}">
    ${savedPickOverlay}
    <button class="card-edit" title="Edit title" onclick="event.stopPropagation();cardEdit('${id}')">&#9998;</button>
    <a class="thumb" onclick="openItem('${id}','${mode}')" title="Open article">
      ${imgTag}
    </a>
    <div class="body">
      <span class="chip" style="background:${cat.chip}">${esc(cat.name)}</span>
      <div class="title" onclick="openItem('${id}','${mode}')">${esc(item.title)}</div>
      <div class="src">${esc(item.source||dom)}</div>
      <div class="benefit"><b>Why for you:</b> ${esc(item.benefit)}</div>
      ${mode==="saved"?tagRow(item.tags, item.id, "saved"):""}
    </div>
    <div class="actions">
      <button class="act saved" onclick="unsaveItem('${id}')">&#10003; Saved — remove</button>
    </div>
  </div>`;
}
```

Modify `renderSaved()` (`web/index.html:1297-1315` — locate by content) to render the new Saved bulk bar. Find the line `const g = document.getElementById("savedGrid");` and the static shell div at `web/index.html:533`:

Old (static shell, `web/index.html:533`):
```html
  <div id="view-saved" style="display:none"><div id="savedBody"><aside class="tag-side cat-side" id="catSide" style="display:none"></aside><div class="masonry" id="savedGrid"></div></div><div id="savedEmpty"></div></div>
```

New:
```html
  <div id="view-saved" style="display:none"><div id="savedBulkBar" style="margin-bottom:10px"></div><div id="savedBody"><aside class="tag-side cat-side" id="catSide" style="display:none"></aside><div class="masonry" id="savedGrid"></div></div><div id="savedEmpty"></div></div>
```

Old (`renderSaved()`):
```js
function renderSaved(){
  const list = applyFilter(saved);
  const g = document.getElementById("savedGrid");
  g.className = gridClass();
  g.innerHTML = list.map(i=>cardHTML(i,"saved")).join("");
  const body = document.getElementById("savedBody");
  const side = document.getElementById("catSide");
  if(catSidebarOn()){
    body.classList.add("imp-body");
    side.style.display = "";
    side.innerHTML = catSideHTML();
  } else {
    body.classList.remove("imp-body");
    side.style.display = "none";
    side.innerHTML = "";
  }
  attachCardImages();
  document.getElementById("savedEmpty").innerHTML = list.length?"":`<div class="empty"><h2>Nothing saved${filterCat?" in this category":" yet"}</h2><p>Save items from Stumble and they collect here — and every save teaches the AI what to bring you next.</p></div>`;
}
```

New:
```js
function renderSaved(){
  const list = applyFilter(saved);
  document.getElementById("savedBulkBar").innerHTML = savedSelMode
    ? `<button class="btn btn-ghost" onclick="toggleSavedAddTabMenu()" ${savedSelPicks.size?"":"disabled"}>Add to tab &#9662;</button>${savedAddTabMenuHTML()}
       <button class="btn btn-ghost" onclick="toggleSavedSelMode()">Done</button>`
    : `<button class="btn btn-ghost" onclick="toggleSavedSelMode()">&#9745; Select</button>`;
  const g = document.getElementById("savedGrid");
  g.className = gridClass();
  g.innerHTML = list.map(i=>cardHTML(i,"saved")).join("");
  const body = document.getElementById("savedBody");
  const side = document.getElementById("catSide");
  if(catSidebarOn()){
    body.classList.add("imp-body");
    side.style.display = "";
    side.innerHTML = catSideHTML();
  } else {
    body.classList.remove("imp-body");
    side.style.display = "none";
    side.innerHTML = "";
  }
  attachCardImages();
  document.getElementById("savedEmpty").innerHTML = list.length?"":`<div class="empty"><h2>Nothing saved${filterCat?" in this category":" yet"}</h2><p>Save items from Stumble and they collect here — and every save teaches the AI what to bring you next.</p></div>`;
}
```

Add CSS for `.addtab-menu` — locate by content, immediately after the `.tp-tabs{...}` rule Task 3 added:

Old:
```css
.tp-tabs{display:flex;flex-direction:column;margin-bottom:4px;border-bottom:1px solid var(--line);padding-bottom:4px}
```

New:
```css
.tp-tabs{display:flex;flex-direction:column;margin-bottom:4px;border-bottom:1px solid var(--line);padding-bottom:4px}
.addtab-menu{display:inline-flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:4px;margin-left:8px;vertical-align:top}
```

Apply all edits identically to `pwa/index.html` (locate each by content).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tabs-bulk-add.test.js`
Expected: PASS (12 assertions — 6 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-bulk-add.test.js
git commit -m "Custom tabs: bulk 'Add to tab' from Saved and Imported

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Bulk populate — "Remove from tab" inside a tab

**Files:**
- Modify: `web/index.html` (new `tabSelMode`/`tabSelPicks` state; `tabCardWrapper` helper; `renderTabsView()` extended with a select toggle, wrapped cards, and a "Remove from tab" bulk bar)
- Modify: `pwa/index.html` (same, located by content)
- Test: `tests/tabs-bulk-remove.test.js` (new)

**Interfaces:**
- Consumes: `tabs`, `openTabId`, `tabsFilteredList` (Task 2), `Store.putCards`/`Store.putSaved` (existing).
- Produces: `tabSelMode`/`tabSelPicks` (`Set` of `"<kind>:<identity>"` composite keys — `"imported:4"` or `"saved:s0"`), `toggleTabSelMode()`, `toggleTabPick(scope,identity)`, `tabCardWrapper(innerHtml,scope,identity,picked)`, `removeTabPicksFromTab()`.

This task deliberately does **not** modify `cardHTML`/`impCardHTML` for this overlay — those functions already have their own independent select-mode concepts (`savedSelMode`, `selMode`) for their native grids. `tabCardWrapper` wraps the rendered card HTML from the OUTSIDE with its own overlay, so the tab-detail view's bulk-select never touches or conflicts with Saved's/Imported's own select modes (see this plan's "Known, deliberately out-of-scope edge case" note for the one case this doesn't fully cover).

- [ ] **Step 1: Write the failing test**

Create `tests/tabs-bulk-remove.test.js`:

```js
// tests/tabs-bulk-remove.test.js — Task 5: the tab-detail view's own bulk-select
// (composite scope:identity keys, since a tab mixes imported+saved cards) and its
// one bulk action, "Remove from tab" — which strips just the tab's own tag, not
// the whole tags array.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": toggleTabPick adds/removes the composite scope:identity key", () => {
    const factory = new Function(
      "tabSelPicks", "renderTabsView",
      fn(src, "toggleTabPick") + "\nreturn toggleTabPick;"
    );
    const picks = new Set();
    const toggleTabPick = factory(picks, () => {});
    toggleTabPick("imported", 4);
    assert.ok(picks.has("imported:4"));
    toggleTabPick("imported", 4);
    assert.ok(!picks.has("imported:4"));
  });

  t(label + ": tabCardWrapper leaves the card untouched when tabSelMode is off", () => {
    const factory = new Function("tabSelMode", fn(src, "tabCardWrapper") + "\nreturn tabCardWrapper;");
    const tabCardWrapper = factory(false);
    assert.strictEqual(tabCardWrapper("<div>card</div>", "imported", 4, false), "<div>card</div>");
  });

  t(label + ": tabCardWrapper adds a pick overlay reflecting the picked state when tabSelMode is on", () => {
    const factory = new Function("tabSelMode", fn(src, "tabCardWrapper") + "\nreturn tabCardWrapper;");
    const tabCardWrapper = factory(true);
    const wrapped = tabCardWrapper("<div>card</div>", "saved", "s0", true);
    assert.match(wrapped, /toggleTabPick\('saved','s0'\)/);
    assert.match(wrapped, /&#10003;/);
    const unpicked = tabCardWrapper("<div>card</div>", "saved", "s1", false);
    assert.doesNotMatch(unpicked, /&#10003;/);
  });

  t(label + ": removeTabPicksFromTab strips only the open tab's tag, from both imported and saved picks", () => {
    const importedArr = [{ tags: ["stl files", "other"] }, { tags: ["stl files"] }];
    const savedArr = [{ id: "s0", tags: ["stl files"] }];
    const calls = [];
    const body = [fn(src, "removeTabPicksFromTab")].join("\n");
    const factory = new Function(
      "tabs", "openTabId", "tabSelPicks", "tabSelMode", "imported", "saved", "Store", "toast", "renderTabsView",
      body + "\nreturn removeTabPicksFromTab;"
    );
    const removeTabPicksFromTab = factory(
      [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], "t1",
      new Set(["imported:0", "saved:s0"]), true,
      importedArr, savedArr,
      { putCards: (arr) => calls.push(["putCards", arr]), putSaved: (arr) => calls.push(["putSaved", arr]) },
      () => calls.push("toast"), () => calls.push("render")
    );
    removeTabPicksFromTab();
    assert.deepStrictEqual(importedArr[0].tags, ["other"]);
    assert.deepStrictEqual(importedArr[1].tags, ["stl files"]);   // not picked — untouched
    assert.deepStrictEqual(savedArr[0].tags, []);
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putSaved"));
  });

  t(label + ": renderTabsView wires a Select toggle and, when active, the Remove-from-tab bar", () => {
    const body = fn(src, "renderTabsView");
    assert.match(body, /toggleTabSelMode/);
    assert.match(body, /removeTabPicksFromTab/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tabs-bulk-remove.test.js`
Expected: FAIL — `toggleTabPick not found in source`, etc.

- [ ] **Step 3: Write the implementation**

Insert this new block right after Task 4's block:

```js
/* ---- bulk "Remove from tab" (inside an open tab) ---- */
let tabSelMode = false;
let tabSelPicks = new Set();   // composite keys: "imported:<idx>" or "saved:<id>"
function toggleTabSelMode(){ tabSelMode=!tabSelMode; if(!tabSelMode) tabSelPicks.clear(); renderTabsView(); }
function toggleTabPick(scope, identity){
  const key = scope+":"+identity;
  tabSelPicks.has(key)?tabSelPicks.delete(key):tabSelPicks.add(key);
  renderTabsView();
}
// Wraps an already-rendered card's HTML with the tab-detail view's OWN pick overlay
// — deliberately independent of cardHTML's/impCardHTML's own select-mode overlays
// (savedSelMode/selMode), so the two never conflict.
function tabCardWrapper(innerHtml, scope, identity, picked){
  if(!tabSelMode) return innerHtml;
  return `<div style="position:relative">${innerHtml}<div class="pickov" onclick="event.stopPropagation();toggleTabPick('${scope}','${identity}')">${picked?'<span class="pk">&#10003;</span>':""}</div></div>`;
}
function removeTabPicksFromTab(){
  const t = tabs.find(x=>x.id===openTabId); if(!t || !tabSelPicks.size) return;
  let n=0;
  tabSelPicks.forEach(key=>{
    const sep = key.indexOf(":");
    const scope = key.slice(0,sep), id = key.slice(sep+1);
    const it = scope==="saved" ? saved.find(c=>c&&c.id===id) : imported[Number(id)];
    if(it && it.tags && it.tags.some(x=>x.toLowerCase()===t.tag.toLowerCase())){
      it.tags = it.tags.filter(x=>x.toLowerCase()!==t.tag.toLowerCase());
      n++;
    }
  });
  Store.putCards(imported);
  Store.putSaved(saved);
  tabSelMode=false; tabSelPicks.clear();
  renderTabsView();
  toast(n?("Removed "+n+" card"+(n>1?"s":"")+" from "+t.name):"Nothing removed");
}
```

Modify `renderTabsView()` (Task 2's function — locate by content, this exact function) to add the Select toggle, wrap cards in the grid, and reset `tabSelMode`/`tabSelPicks` on `openTab`:

Old:
```js
function openTab(id){
  openTabId = id;
  window.scrollTo(0,0);
  renderTabsView();
}
```

New:
```js
function openTab(id){
  openTabId = id;
  tabSelMode = false; tabSelPicks.clear();
  window.scrollTo(0,0);
  renderTabsView();
}
```

Old (the grid-building line inside `renderTabsView`):
```js
    const list = tabsFilteredList(t.tag);
    gridHtml = !list.length
      ? `<div class="empty"><h2>Nothing in "${esc(t.name)}" yet</h2><p>Add cards from Saved or Imported using the tag picker's Tabs section.</p></div>`
      : `<div class="${gridClass()}">${list.map(r=>r.kind==="saved"?cardHTML(r.it,"saved"):impCardHTML(r.it,r.idx)).join("")}</div>`;
```

New:
```js
    const list = tabsFilteredList(t.tag);
    gridHtml = !list.length
      ? `<div class="empty"><h2>Nothing in "${esc(t.name)}" yet</h2><p>Add cards from Saved or Imported using the tag picker's Tabs section.</p></div>`
      : `<div class="${gridClass()}">${list.map(r=>{
          const inner = r.kind==="saved" ? cardHTML(r.it,"saved") : impCardHTML(r.it,r.idx);
          const identity = r.kind==="saved" ? r.it.id : r.idx;
          return tabCardWrapper(inner, r.kind, identity, tabSelPicks.has(r.kind+":"+identity));
        }).join("")}</div>`;
```

Old (the `manageHtml` line inside `renderTabsView`):
```js
  const manageHtml = t && !t.reserved
    ? `<button class="btn btn-ghost" onclick="renameTabPrompt('${t.id}')">Rename</button><button class="btn btn-ghost" onclick="deleteTabPrompt('${t.id}')">Remove tab</button>`
    : "";
```

New:
```js
  const manageHtml = !t ? "" : (t.reserved ? "" : `<button class="btn btn-ghost" onclick="renameTabPrompt('${t.id}')">Rename</button><button class="btn btn-ghost" onclick="deleteTabPrompt('${t.id}')">Remove tab</button>`)
    + (t ? (tabSelMode
        ? `<button class="btn btn-ghost" onclick="removeTabPicksFromTab()" ${tabSelPicks.size?"":"disabled"}>Remove from tab (${tabSelPicks.size})</button><button class="btn btn-ghost" onclick="toggleTabSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleTabSelMode()">&#9745; Select</button>`) : "");
```

Apply all edits identically to `pwa/index.html` (locate each by content).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tabs-bulk-remove.test.js`
Expected: PASS (10 assertions — 5 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-bulk-remove.test.js
git commit -m "Custom tabs: bulk 'Remove from tab' inside an open tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: AI-suggest cards for a tab

**Files:**
- Modify: `web/index.html` (new `aiSuggestCardsForTab`/`openTabSuggest`/`tabSugToggleSel`/`tabSugRemove`/`tabSugAccept`/`tabSuggestPanelHTML` functions; `renderTabsView()` gets a "✨ Suggest cards" button + suggestion panel; `openTab()` resets suggestion state on tab switch)
- Modify: `pwa/index.html` (same, located by content)
- Test: `tests/tabs-ai-suggest.test.js` (new)

**Interfaces:**
- Consumes: `tabsFilteredList` (Task 2), `openTabId`/`tabs` (Task 1/2), `callAI` (existing per-provider AI call function, used identically by Plan 1's `aiSuggestTags`), `IA_AI.hasAIKey()`/`PROVIDERS`/`S.provider` (existing, used identically by Plan 1's `openAutoTag`).
- Produces: `aiSuggestCardsForTab(tab)` (async, pure aside from `callAI` — returns an array of `{scope,identity,title,desc}` candidates), `openTabSuggest()`, `tabSugToggleSel(i)`, `tabSugRemove(i)`, `tabSugAccept()`, `tabSuggestPanelHTML()`.

This feature does **not** require a web-search-capable AI provider — like `aiSuggestTags` (Plan 1), it only classifies existing card title/description text against the tab's name as a theme; it never fetches external sources. The web-search-capable-provider requirement in the design spec applies only to Plan 3's "Research & draft article"/"Ask a question" features.

- [ ] **Step 1: Write the failing test**

Create `tests/tabs-ai-suggest.test.js`:

```js
// tests/tabs-ai-suggest.test.js — Task 6: the AI-suggest-cards-for-a-tab batching
// (candidate building, excluding cards already in the tab, capping at 40) and the
// accept/reject review state, mirroring aiSuggestTags/openAutoTag/autoAccept's
// established pattern (Plan 1) but for CARDS instead of tags.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": aiSuggestCardsForTab excludes cards already in the tab from its candidate batch", async () => {
    const importedArr = [{ tags: ["stl files"], title: "Already in" }, { tags: [], title: "Candidate A", desc: "" }];
    const savedArr = [{ id: "s0", tags: [], title: "Candidate B", desc: "" }];
    const body = [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab")].join("\n");
    const factory = new Function(
      "imported", "saved", "cardHasTag", "callAI",
      body + "\nreturn aiSuggestCardsForTab;"
    );
    let sentPrompt = "";
    const aiSuggestCardsForTab = factory(
      importedArr, savedArr,
      (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      async (prompt) => { sentPrompt = prompt; return "[0,1]"; }   // both remaining candidates picked
    );
    const picks = await aiSuggestCardsForTab({ name: "STL files", tag: "stl files" });
    assert.ok(!sentPrompt.includes("Already in"), "the already-tagged card must not be sent as a candidate");
    assert.strictEqual(picks.length, 2);
    assert.ok(picks.some(p=>p.title==="Candidate A" && p.scope==="imported"));
    assert.ok(picks.some(p=>p.title==="Candidate B" && p.scope==="saved"));
  });

  t(label + ": aiSuggestCardsForTab throws a clear error when the AI returns nothing parseable", async () => {
    const body = [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab")].join("\n");
    const factory = new Function(
      "imported", "saved", "cardHasTag", "callAI",
      body + "\nreturn aiSuggestCardsForTab;"
    );
    const aiSuggestCardsForTab = factory(
      [{ tags: [], title: "A" }], [],
      (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      async () => "not json at all"
    );
    await assert.rejects(() => aiSuggestCardsForTab({ name: "STL files", tag: "stl files" }));
  });

  t(label + ": tabSugAccept applies the tab's tag to selected (or all, if none selected) candidates", () => {
    const importedArr = [{ tags: [] }];
    const savedArr = [{ id: "s0", tags: [] }];
    const calls = [];
    const body = [fn(src, "tabSugAccept")].join("\n");
    const factory = new Function(
      "tabs", "openTabId", "_tabSug", "imported", "saved", "Store", "toast", "renderTabsView",
      body + "\nreturn tabSugAccept;"
    );
    const tabSugAccept = factory(
      [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], "t1",
      [ { scope: "imported", identity: 0, title: "A", sel: false }, { scope: "saved", identity: "s0", title: "B", sel: false } ],
      importedArr, savedArr,
      { putCards: (arr)=>calls.push(["putCards",arr]), putSaved: (arr)=>calls.push(["putSaved",arr]) },
      ()=>calls.push("toast"), ()=>calls.push("render")
    );
    tabSugAccept();   // none selected -> accept all
    assert.deepStrictEqual(importedArr[0].tags, ["stl files"]);
    assert.deepStrictEqual(savedArr[0].tags, ["stl files"]);
  });

  t(label + ": tabSuggestPanelHTML renders nothing when idle (no suggestions, not loading, no error)", () => {
    const factory = new Function(
      "_tabSug", "_tabSugErr", "_tabSugLoading", "esc",
      fn(src, "tabSuggestPanelHTML") + "\nreturn tabSuggestPanelHTML;"
    );
    const tabSuggestPanelHTML = factory([], "", false, (s)=>s);
    assert.strictEqual(tabSuggestPanelHTML(), "");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tabs-ai-suggest.test.js`
Expected: FAIL — `aiSuggestCardsForTab not found in source`.

- [ ] **Step 3: Write the implementation**

Insert this new block right after Task 5's block:

```js
/* ---- AI-suggest cards for a tab ---- */
let _tabSug = [];       // AI-suggested candidate cards for the open tab: [{scope,identity,title,sel}]
let _tabSugErr = "";
let _tabSugLoading = false;
async function aiSuggestCardsForTab(tab){
  const already = new Set(tabsFilteredList(tab.tag).map(r=>r.kind+":"+(r.kind==="saved"?r.it.id:r.idx)));
  const candidates = [];
  imported.forEach((it,idx)=>{ if(!already.has("imported:"+idx)) candidates.push({scope:"imported", identity:idx, title:it.title, desc:it.desc}); });
  saved.forEach(it=>{ if(it && !already.has("saved:"+it.id)) candidates.push({scope:"saved", identity:it.id, title:it.title, desc:it.desc}); });
  const batch = candidates.slice(0,40);
  if(!batch.length) throw new Error("Nothing left to suggest — every card is already in this tab");
  const listText = batch.map((c,i)=>`${i}. "${(c.title||"").slice(0,120)}" — ${(c.desc||"").slice(0,160)}`).join("\n");
  const prompt = `A user has a tab called "${tab.name}" for organizing cards around that theme. Given this numbered list of candidate cards (title — description), return the indices of ones that clearly belong in a "${tab.name}" tab. Return ONLY a JSON array of integers, e.g. [0,3,7]. If none clearly fit, return [].\n\n${listText}`;
  const text = await callAI(prompt);
  const m = text.match(/\[[\s\S]*\]/); if(!m) throw new Error("No suggestions returned");
  let idxArr; try{ idxArr = JSON.parse(m[0]); }catch(e){ throw new Error("Could not parse suggestions"); }
  if(!Array.isArray(idxArr)) throw new Error("Unexpected response");
  return idxArr.filter(i=>Number.isInteger(i) && i>=0 && i<batch.length).map(i=>batch[i]);
}
function openTabSuggest(){
  const t = tabs.find(x=>x.id===openTabId); if(!t) return;
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first", 5000); return; }
  _tabSug=[]; _tabSugErr=""; _tabSugLoading=true;
  renderTabsView();
  aiSuggestCardsForTab(t).then(cands=>{
    _tabSugLoading=false;
    _tabSug = cands.map(c=>Object.assign({sel:false}, c));
    renderTabsView();
  }).catch(e=>{ _tabSugLoading=false; _tabSugErr=e.message||"Try again"; renderTabsView(); });
}
function tabSugToggleSel(i){ if(_tabSug[i]){ _tabSug[i].sel=!_tabSug[i].sel; renderTabsView(); } }
function tabSugRemove(i){ _tabSug.splice(i,1); renderTabsView(); }
function tabSugAccept(){
  const t = tabs.find(x=>x.id===openTabId); if(!t) return;
  const anySel = _tabSug.some(s=>s.sel);
  const pick = _tabSug.filter(s=>anySel?s.sel:true);
  if(!pick.length){ toast("No cards selected"); return; }
  let n=0;
  pick.forEach(c=>{
    const it = c.scope==="saved" ? saved.find(s=>s&&s.id===c.identity) : imported[c.identity];
    if(it){ if(!it.tags) it.tags=[]; if(!it.tags.some(x=>x.toLowerCase()===t.tag.toLowerCase())){ it.tags.push(t.tag); n++; } }
  });
  Store.putCards(imported); Store.putSaved(saved);
  _tabSug=[];
  renderTabsView();
  toast(n?("Added "+n+" card"+(n>1?"s":"")+" to "+t.name):"Already in "+t.name);
}
function tabSuggestPanelHTML(){
  if(_tabSugLoading) return `<div class="tp-head"><span class="spin"></span> Suggesting cards for this tab…</div>`;
  if(_tabSugErr) return `<div class="tp-head">Suggest failed</div><div class="tp-empty">${esc(_tabSugErr)}</div>`;
  if(!_tabSug.length) return "";
  const anySel = _tabSug.some(s=>s.sel);
  const chips = _tabSug.map((c,i)=>`<span class="tp-sug${c.sel?" sel":""}" onclick="tabSugToggleSel(${i})">${esc((c.title||"").slice(0,60))}<span class="tgx" title="Drop" onclick="event.stopPropagation();tabSugRemove(${i})">&times;</span></span>`).join("");
  return `<div class="tp-head">AI suggestions <span class="tp-hint">click to select · X to drop</span></div><div class="tp-sugs">${chips}</div><div class="tp-actions"><button class="tp-accept" onclick="tabSugAccept()">${anySel?"Accept selected":"Accept all"}</button><button class="tp-cancel" onclick="_tabSug=[];renderTabsView()">Cancel</button></div>`;
}
```

Modify `openTab()` (Task 2's function — locate by content) so switching tabs discards a stale suggestion review:

Old:
```js
function openTab(id){
  openTabId = id;
  tabSelMode = false; tabSelPicks.clear();
  window.scrollTo(0,0);
  renderTabsView();
}
```

New:
```js
function openTab(id){
  openTabId = id;
  tabSelMode = false; tabSelPicks.clear();
  _tabSug = []; _tabSugErr = ""; _tabSugLoading = false;
  window.scrollTo(0,0);
  renderTabsView();
}
```

Modify `renderTabsView()`'s `manageHtml` line (Task 5's edit — locate by content) to add the "✨ Suggest cards" button and append the suggestion panel:

Old:
```js
  const manageHtml = !t ? "" : (t.reserved ? "" : `<button class="btn btn-ghost" onclick="renameTabPrompt('${t.id}')">Rename</button><button class="btn btn-ghost" onclick="deleteTabPrompt('${t.id}')">Remove tab</button>`)
    + (t ? (tabSelMode
        ? `<button class="btn btn-ghost" onclick="removeTabPicksFromTab()" ${tabSelPicks.size?"":"disabled"}>Remove from tab (${tabSelPicks.size})</button><button class="btn btn-ghost" onclick="toggleTabSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleTabSelMode()">&#9745; Select</button>`) : "");
```

New:
```js
  const manageHtml = !t ? "" : (t.reserved ? "" : `<button class="btn btn-ghost" onclick="renameTabPrompt('${t.id}')">Rename</button><button class="btn btn-ghost" onclick="deleteTabPrompt('${t.id}')">Remove tab</button>`)
    + (t ? (tabSelMode
        ? `<button class="btn btn-ghost" onclick="removeTabPicksFromTab()" ${tabSelPicks.size?"":"disabled"}>Remove from tab (${tabSelPicks.size})</button><button class="btn btn-ghost" onclick="toggleTabSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleTabSelMode()">&#9745; Select</button><button class="btn btn-ghost" onclick="openTabSuggest()">&#10024; Suggest cards</button>`) : "");
```

Old (the final `v.innerHTML = ...` line inside `renderTabsView`):
```js
  v.innerHTML = `<div class="tabbar-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">${pills}</div>` +
    (t ? `<div style="display:flex;gap:8px;margin-bottom:10px">${manageHtml}</div>` : "") +
    gridHtml;
  attachCardImages();
```

New:
```js
  v.innerHTML = `<div class="tabbar-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">${pills}</div>` +
    (t ? `<div style="display:flex;gap:8px;margin-bottom:10px">${manageHtml}</div>` : "") +
    (t ? tabSuggestPanelHTML() : "") +
    gridHtml;
  attachCardImages();
```

Apply all edits identically to `pwa/index.html` (locate each by content).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tabs-ai-suggest.test.js`
Expected: PASS (8 assertions — 4 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-ai-suggest.test.js
git commit -m "Custom tabs: on-demand AI card-suggestion sweep for a tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Web/PWA parity test + full regression pass

**Files:**
- Modify: `pwa/sw.js` (`SHELL_CACHE` version bump)
- Test: `tests/tabs-parity.test.js` (new)
- Source changes are limited to the `SHELL_CACHE` bump — everything else this task touches PROVES Tasks 1-6 landed identically (for pure-logic functions) in both files.

**Interfaces:**
- Consumes: every pure-logic function name introduced in Tasks 1-6.

- [ ] **Step 1: Write the test**

Create `tests/tabs-parity.test.js`:

```js
// tests/tabs-parity.test.js — every pure-logic function the Custom Tabs feature
// introduced (Tasks 1-6) must be byte-identical between web/index.html and
// pwa/index.html — there is no platform-specific reason for it to differ.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

const FNS = [
  "cardHasTag", "tabCardCount", "bootstrapAiTab", "createTab", "renameTab", "deleteTab",
  "allTags", "tagRow", "aiSuggestTags",
  "tabsFilteredList", "openTab", "newTabPrompt", "renameTabPrompt", "deleteTabPrompt", "renderTabsView",
  "tabPickerRows", "renderTagPicker",
  "bulkAddTag", "toggleSavedSelMode", "toggleSavedPick", "toggleSavedAddTabMenu", "savedAddTabMenuHTML", "addSavedPicksToTab",
  "toggleSelMode", "toggleImpAddTabMenu", "impAddTabMenuHTML", "addImportedPicksToTab", "cardHTML", "renderSaved",
  "toggleTabSelMode", "toggleTabPick", "tabCardWrapper", "removeTabPicksFromTab",
  "aiSuggestCardsForTab", "openTabSuggest", "tabSugToggleSel", "tabSugRemove", "tabSugAccept", "tabSuggestPanelHTML",
  "showTab",
];

for (const name of FNS) {
  t(name + " is byte-identical between web and pwa", () => {
    const a = extractFn(html, name);
    const b = extractFn(pwaHtml, name);
    assert.ok(a, "missing from web/index.html");
    assert.ok(b, "missing from pwa/index.html");
    assert.strictEqual(a.trim(), b.trim());
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it**

Run: `node tests/tabs-parity.test.js`
Expected: PASS for every function. If any FAIL, diff that one function between the two files and make `pwa/index.html` match `web/index.html` exactly (web is the source of truth, per this project's existing convention and Plan 1's precedent).

- [ ] **Step 3: Bump the PWA shell cache version**

Every task from 1 through 6 edited `pwa/index.html`. Per this project's established convention (`pwa/sw.js`'s own inline comment: "bump on ANY edit to an already-cached file"), an unbumped `SHELL_CACHE` leaves already-installed PWAs silently serving the pre-feature shell forever — cache-first, no other invalidation path. Locate by content, in `pwa/sw.js`:

Old:
```js
const SHELL_CACHE = "interests-pwa-shell-v76"; // bump on ANY edit to an already-cached
```

New:
```js
const SHELL_CACHE = "interests-pwa-shell-v77"; // bump on ANY edit to an already-cached
```

(If a release between Plan 1 and this plan's execution already bumped past `v76`, use the next integer after whatever is currently there — the point is any bump, not this exact number.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 5: Manual smoke check (both apps)**

Launch the desktop app (or `node core/server.js` + open `web/index.html` in a browser) and confirm by hand:
1. A new "Tabs" button appears in both the desktop nav and the mobile bottom bar.
2. Create a tab (e.g. "STL files") via "+ New tab"; it appears as a pill with a live count.
3. From Saved or Imported, open the tag picker on a card — a pinned "Tabs" section appears at the top, including the tab just created and the 🤖 AI tab; toggling it adds/removes the card from that tab, and the pill's count updates.
4. From Saved: toggle Select mode, pick a couple of cards, "Add to tab ▾" a tab, confirm they now show up in that tab's grid.
5. From Imported: same, using the existing Select mode's new "Add to tab ▾" button.
6. Open the tab, toggle its own Select mode, pick a card, "Remove from tab" — it drops out of the grid but is NOT deleted (still visible/tagged normally elsewhere except for this one tag).
7. Rename the tab, confirm the pill label updates but existing cards stay tagged (tag string itself doesn't change).
8. Delete the tab (confirm dialog appears); confirm the pill disappears but the underlying tag is untouched on cards (re-creating a tab with the same name re-attaches to the same cards).
9. Click "✨ Suggest cards" on a tab with an AI provider configured; review the suggested cards, accept some, confirm they're added.
10. Confirm the 🤖 AI tab is present, pinned, cannot be renamed or deleted (buttons don't appear for it), and its underlying tag never appears as a visible chip anywhere.

- [ ] **Step 6: Commit**

```bash
git add pwa/sw.js tests/tabs-parity.test.js
git commit -m "Custom tabs: bump PWA shell cache + web/pwa byte-identity test

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## What this plan deliberately does NOT do (left for Plan 3)

- No `research` field, no "Research & draft article" button, no "Ask a question" input, no article panel (edit/regenerate/copy).
- No provider-capability gate (web-search-capable provider required) — not needed by anything in this plan.
- No AI-tab-specific UI beyond what any other tab already gets from this plan (nav pill, filtering, individual/bulk/AI-suggest population).
