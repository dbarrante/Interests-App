# Generalize Tag Editing to Saved Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved cards get the exact same add/remove-tag UI (including the AI "AutoTag" suggestion picker) that Imported cards already have, so a card can be tagged into a custom tab regardless of which pool it lives in.

**Architecture:** The existing tag-picker system (`web/index.html` ~3300-3552) is hardcoded to `imported[idx]` via a single module var `_tagPickIdx`. Generalize its addressing to a `(scope, identity)` pair — `scope` is `"imported"` (identity = array index, unchanged from today) or `"saved"` (identity = the item's stable `.id`, matching how Saved's other actions like `unsaveItem(id)` already address items). No new files, no new storage keys — this is a pure refactor of existing inline functions plus one new call site in `cardHTML`.

**Tech Stack:** Vanilla JS inside `web/index.html` / `pwa/index.html` (no framework, no build step). Tests are plain `assert` scripts using `tests/_extract.js`'s function-extraction technique (`new Function(...)` over source pulled straight out of the HTML files — see `tests/image-dupes-ui.test.js` for the established pattern).

## Global Constraints

- Single-file HTML apps (`web/index.html`, `pwa/index.html`) must stay parseable — every change must pass `node tests/syntax-check.js`.
- `web/index.html` and `pwa/index.html` diverge only where a genuine platform difference (Core HTTP vs IndexedDB) requires it. This entire feature has no such difference (`Store.putCards`/`Store.putSaved` already abstract that away identically for both), so every code block in this plan must land **byte-identical** in both files.
- No `core/` (backend), schema, or sync-format changes — this plan touches only `web/index.html` and `pwa/index.html`.
- Every existing Imported-card tag behavior (add, remove, AutoTag suggest) must be byte-for-byte unchanged in its rendered output for the default (`scope` omitted / `"imported"`) case — this is a refactor, not a behavior change, for the code paths that already worked.
- Follow the project's `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` commit trailer convention.

---

### Task 1: Scope-aware picker state + `allTags()`/`canonicalTag()`

**Files:**
- Modify: `web/index.html:3312-3367`
- Modify: `pwa/index.html` (same block — re-locate by content, do not assume the same line numbers; pwa's copy is currently at a different offset)
- Test: `tests/tag-editing-scope.test.js` (new)

**Interfaces:**
- Produces: `allTags(): string[]` (replaces `allImportedTags`), `_tagPickItem(): object|undefined`, module vars `_tagPickScope` ("imported"|"saved"), `_tagPickIdx` (number, meaningful only when scope is "imported"), `_tagPickId` (string|null, meaningful only when scope is "saved").
- Consumes: the existing `imported`/`saved` global arrays (already defined at `web/index.html:879`).

- [ ] **Step 1: Write the failing test**

Create `tests/tag-editing-scope.test.js`:

```js
// tests/tag-editing-scope.test.js — Task 1: scope-aware tag-picker state
// (allTags/_tagPickItem) generalized to work across imported AND saved.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function fn(src, name) {
  const m = extractFn(src, name);
  assert.ok(m, name + " not found in source");
  return m;
}

// Wires allTags/_tagPickItem against scripted `imported`/`saved` arrays and
// picker state, mirroring loadRowRenderers' technique in image-dupes-ui.test.js.
function load(src, state) {
  const factory = new Function(
    "imported", "saved", "_tagPickScope", "_tagPickIdx", "_tagPickId",
    fn(src, "allTags") + "\n" + fn(src, "_tagPickItem") + "\nreturn { allTags, _tagPickItem };"
  );
  return factory(state.imported, state.saved, state.scope, state.idx, state.id);
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": allTags merges tags from imported AND saved, exact-string deduped, sorted case-insensitively", () => {
    // allTags is a plain Set keyed by exact string — same as the original
    // allImportedTags it replaces, it does NOT case-fold two differently-cased
    // spellings of the same tag into one entry (that fuzzy matching is
    // canonicalTag's job, applied at the point a NEW tag is being added, not
    // here). "3d printing" appears in BOTH arrays and must collapse to one
    // entry; "Recipes"/"stl files" are each unique and both survive as-is.
    const { allTags } = load(src, {
      imported: [{ tags: ["3d printing", "Recipes"] }],
      saved: [{ tags: ["stl files", "3d printing"] }],
      scope: "imported", idx: -1, id: null,
    });
    assert.deepStrictEqual(allTags(), ["3d printing", "Recipes", "stl files"]);
  });

  t(label + ": _tagPickItem resolves by INDEX into `imported` when scope is imported", () => {
    const importedArr = [{ id: "i0" }, { id: "i1", tags: ["x"] }];
    const { _tagPickItem } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: 1, id: null });
    assert.strictEqual(_tagPickItem(), importedArr[1]);
  });

  t(label + ": _tagPickItem resolves by ID into `saved` when scope is saved", () => {
    const savedArr = [{ id: "s0" }, { id: "s1", tags: ["x"] }];
    const { _tagPickItem } = load(src, { imported: [], saved: savedArr, scope: "saved", idx: -1, id: "s1" });
    assert.strictEqual(_tagPickItem(), savedArr[1]);
  });

  t(label + ": _tagPickItem returns undefined for a saved id that no longer exists", () => {
    const { _tagPickItem } = load(src, { imported: [], saved: [{ id: "s0" }], scope: "saved", idx: -1, id: "gone" });
    assert.strictEqual(_tagPickItem(), undefined);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tag-editing-scope.test.js`
Expected: FAIL — `allTags not found in source` (function doesn't exist yet; the current name is `allImportedTags` and there is no `_tagPickItem`).

- [ ] **Step 3: Write the implementation**

In `web/index.html`, replace lines 3312-3322 (the `_tagPickIdx`/`_tagMulti`/... declarations plus `allImportedTags`) — full replacement block:

```js
/* ---- inline tag editing (works across imported + saved) ---- */
let _tagPickScope = "imported";   // "imported" | "saved" — which array the open picker edits
let _tagPickIdx = -1;             // index into `imported` — meaningful only when _tagPickScope==="imported"
let _tagPickId = null;            // id of a `saved` item — meaningful only when _tagPickScope==="saved"
let _tagMulti = false;        // "Select multiple" is off by default each time the picker opens
let _tpHi = -1;               // arrow-key highlighted row in the picker list
let _autoSug = [];            // AutoTag AI suggestions: [{tag, sel}]
let _autoErr = "";
function allTags(){
  const s=new Set();
  imported.forEach(i=>(i.tags||[]).forEach(t=>s.add(t)));
  saved.forEach(i=>(i.tags||[]).forEach(t=>s.add(t)));
  return [...s].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
}
// Resolve the item the currently-open tag picker is editing, regardless of scope.
function _tagPickItem(){
  return _tagPickScope==="saved" ? saved.find(s=>s&&s.id===_tagPickId) : imported[_tagPickIdx];
}
```

Then replace `canonicalTag` (lines 3361-3367 in the original — now shifted a few lines down after the block above; locate by the `function canonicalTag(t){` text) so its loop uses `allTags()` instead of `allImportedTags()`:

```js
function canonicalTag(t){
  const k=(t||"").toLowerCase();
  for(const e of allTags()){ const ek=e.toLowerCase();
    if(ek===k || ek===k+"s" || ek+"s"===k || ek.replace(/s$/,"")===k.replace(/s$/,"")) return e;
  }
  return t;
}
```

Leave everything else in the 3323-3360 range (`tsRec`, `tsSave`, `tagBadPattern`, `tagSuppressed`, `preferredVocab`, `learnedAvoid`) untouched — out of scope for this plan.

Apply the exact same two edits to `pwa/index.html` (locate the equivalent block by its content — `/* ---- inline tag editing` — not by line number).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tag-editing-scope.test.js`
Expected: PASS (8 assertions — 4 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tag-editing-scope.test.js
git commit -m "Tag editing: scope-aware picker state (allTags, _tagPickItem)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Generalize the tag CRUD + picker interaction functions

**Files:**
- Modify: `web/index.html:3368-3553` (the full run from `_afterTagEdit` through `autoAccept`'s closing brace, i.e. everything AFTER Task 1's block. Note `tagRow` lives EARLIER in the file, at line 3302-3311 — before both Task 1's and this task's block — and is handled separately in Task 3, not here. The ordering doesn't matter functionally: `tagRow` calls `openTagPicker`/`openAutoTag`/`cardRemoveTagEl`, all plain `function` declarations, which are hoisted. Locate this whole span by its start/end CONTENT, not the line numbers — verified against a real dry-run apply, but `pwa/index.html`'s copy sits at a different offset and any future edit upstream of this block in either file would shift these numbers too.)
- Modify: `pwa/index.html` (same block, located by content)
- Test: `tests/tag-editing-crud.test.js` (new)

**Interfaces:**
- Consumes: `allTags`, `_tagPickItem`, `_tagPickScope`, `_tagPickIdx`, `_tagPickId` (Task 1). `tsRec(tag,kind)`, `tsSave()` (existing, unchanged, at `web/index.html:3323-3358`). `Store.putCards(imported)`, `Store.putSaved(saved)` (existing `Store` API, unchanged).
- Produces: `cardAddTag(tag)`, `cardRemoveTag(scope, identity, tag)`, `cardRemoveTagEl(scope, identity, x)`, `tagPickerToggle(btn)` (replaces `impTagToggle`), `tagPickerNewTag()`, `openTagPicker(scope, identity, ev)`, `closeTagPicker()`, `tagPickerRows(query)`, `renderTagPicker()`, `openAutoTag(scope, identity, ev)`, `autoAccept()`, `_afterTagEdit(scope, identity)`. Task 3 (`tagRow`) and Task 4 (pwa port) both depend on these exact names/signatures.

- [ ] **Step 1: Write the failing test**

Create `tests/tag-editing-crud.test.js`:

```js
// tests/tag-editing-crud.test.js — Task 2: cardAddTag/cardRemoveTag work on
// EITHER `imported` (by index) or `saved` (by id), and route through
// _afterTagEdit with the right (scope, identity) — the generalization this
// whole plan exists for. _afterTagEdit itself is stubbed (it's DOM/Store
// glue, exercised for real in Task 3's tests) so this stays a pure logic test.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function load(src, state, afterTagEditSpy) {
  const body = [
    fn(src, "allTags"), fn(src, "_tagPickItem"),
    fn(src, "cardAddTag"), fn(src, "cardRemoveTag"),
  ].join("\n");
  const factory = new Function(
    "imported", "saved", "_tagPickScope", "_tagPickIdx", "_tagPickId",
    "tsRec", "tsSave", "_afterTagEdit",
    body + "\nreturn { cardAddTag, cardRemoveTag };"
  );
  return factory(
    state.imported, state.saved, state.scope, state.idx, state.id,
    () => {}, () => {}, afterTagEditSpy
  );
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": cardAddTag mutates the SAVED item's tags when scope is saved, not imported", () => {
    const importedArr = [{ id: "i0", tags: [] }];
    const savedArr = [{ id: "s0", tags: [] }];
    let afterArgs = null;
    const { cardAddTag } = load(src, { imported: importedArr, saved: savedArr, scope: "saved", idx: -1, id: "s0" },
      (scope, identity) => { afterArgs = [scope, identity]; });
    cardAddTag("stl files");
    assert.deepStrictEqual(savedArr[0].tags, ["stl files"]);
    assert.deepStrictEqual(importedArr[0].tags, []);
    assert.deepStrictEqual(afterArgs, ["saved", "s0"]);
  });

  t(label + ": cardAddTag mutates the IMPORTED item's tags when scope is imported (unchanged behavior)", () => {
    const importedArr = [{ id: "i0", tags: [] }];
    let afterArgs = null;
    const { cardAddTag } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: 0, id: null },
      (scope, identity) => { afterArgs = [scope, identity]; });
    cardAddTag("3d printing");
    assert.deepStrictEqual(importedArr[0].tags, ["3d printing"]);
    assert.deepStrictEqual(afterArgs, ["imported", 0]);
  });

  t(label + ": cardAddTag is a case-insensitive no-op if the tag is already present", () => {
    const importedArr = [{ id: "i0", tags: ["Recipes"] }];
    const { cardAddTag } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: 0, id: null }, () => {});
    cardAddTag("recipes");
    assert.deepStrictEqual(importedArr[0].tags, ["Recipes"]);
  });

  t(label + ": cardRemoveTag removes from `saved` by id, independent of any open picker state", () => {
    const savedArr = [{ id: "s0", tags: ["a", "b"] }];
    let afterArgs = null;
    const { cardRemoveTag } = load(src, { imported: [], saved: savedArr, scope: "imported", idx: -1, id: null },
      (scope, identity) => { afterArgs = [scope, identity]; });
    cardRemoveTag("saved", "s0", "a");
    assert.deepStrictEqual(savedArr[0].tags, ["b"]);
    assert.deepStrictEqual(afterArgs, ["saved", "s0"]);
  });

  t(label + ": cardRemoveTag removes from `imported` by index (unchanged behavior)", () => {
    const importedArr = [{ id: "i0", tags: ["a", "b"] }];
    const { cardRemoveTag } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: -1, id: null }, () => {});
    cardRemoveTag("imported", 0, "b");
    assert.deepStrictEqual(importedArr[0].tags, ["a"]);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tag-editing-crud.test.js`
Expected: FAIL — `cardAddTag not found in source`.

- [ ] **Step 3: Write the implementation**

In `web/index.html`, replace the block from `_afterTagEdit` through the end of `autoAccept` (originally lines 3368-3552 — locate by content: starts at the comment `// Persist + update ONLY the edited card's tag row in place`, ends at the `toast(added?...)` line closing `autoAccept`) with:

```js
// Persist + patch the DOM for the edited card, regardless of scope.
// Imported: in-place patch of just that card's tag row (no full re-render, so
// the page never jumps while tagging) — falls back to a scroll-preserving full
// render if the card isn't in the DOM. Saved has no per-card DOM patch (its
// masonry grid re-flows on every render anyway), so it always does the
// scroll-preserving full render directly.
function _afterTagEdit(scope, identity){
  if(scope==="saved"){
    Store.putSaved(saved);
    const y=window.scrollY; renderSaved(); window.scrollTo(0,y); requestAnimationFrame(()=>window.scrollTo(0,y));
    return;
  }
  Store.putCards(imported);
  const it=imported[identity];
  if(it && it.id){
    const sel='.imp-card[data-id="'+(window.CSS&&CSS.escape?CSS.escape(it.id):it.id)+'"]';
    const card=document.querySelector(sel);
    if(card){
      const tmp=document.createElement("div"); tmp.innerHTML=tagRow(it.tags, identity);
      const fresh=tmp.firstElementChild;
      const line=card.querySelector(".tagsline");
      if(line && fresh){ line.replaceWith(fresh); return; }
      if(fresh){ const acts=card.querySelector(".imp-acts"); if(acts) acts.parentNode.insertBefore(fresh, acts); return; }
    }
  }
  // fallback only if the card isn't in the DOM: scroll-preserving full render
  const y=window.scrollY; renderImported(); window.scrollTo(0,y); requestAnimationFrame(()=>window.scrollTo(0,y));
}
// Picker-driven ADD — always acts on whatever the open picker is showing.
function cardAddTag(tag){
  const it=_tagPickItem(); tag=(tag||"").trim(); if(!it||!tag) return;
  if(!it.tags) it.tags=[];
  if(!it.tags.some(t=>t.toLowerCase()===tag.toLowerCase())){ it.tags.push(tag); tsRec(tag,"acc"); tsSave(); }   // learn: user wants this tag
  _afterTagEdit(_tagPickScope, _tagPickScope==="saved"?_tagPickId:_tagPickIdx);
}
// Direct chip removal — resolved independently of any open picker (the "×" on
// a rendered chip works whether or not the tag picker itself is open).
function cardRemoveTag(scope, identity, tag){
  const arr = scope==="saved" ? saved : imported;
  const it = scope==="saved" ? arr.find(c=>c&&c.id===identity) : arr[identity];
  if(!it||!it.tags) return;
  const had=it.tags.some(t=>t===tag);
  it.tags=it.tags.filter(t=>t!==tag);
  if(had){ tsRec(tag,"rem"); tsSave(); }   // learn: user removed this tag (strong negative)
  _afterTagEdit(scope, identity);
}
function cardRemoveTagEl(scope, identity, x){
  const chip=x.closest(".tg"); if(!chip) return;
  cardRemoveTag(scope, identity, chip.getAttribute("data-tag"));
}
// position the popover near the clicked control, kept within the viewport
function positionPicker(ev){
  const p=document.getElementById("tagPicker"); if(!p) return;
  const r=(ev&&ev.target&&ev.target.getBoundingClientRect)?ev.target.getBoundingClientRect():{left:100,top:100,bottom:120};
  const w=p.offsetWidth||250, h=p.offsetHeight||320;
  let left=Math.min(r.left, window.innerWidth-w-12);
  let top=r.bottom+6; if(top+h>window.innerHeight-8) top=Math.max(8, r.top-h-6);
  p.style.left=Math.max(8,left)+"px"; p.style.top=top+"px";
}
function openTagPicker(scope, identity, ev){
  _tagPickScope = scope||"imported";
  if(_tagPickScope==="saved"){ _tagPickId=identity; _tagPickIdx=-1; } else { _tagPickIdx=identity; _tagPickId=null; }
  _tagMulti=false; _tpHi=-1;   // single-select + no highlight by default on each open
  renderTagPicker();
  document.getElementById("tagPicker").classList.add("open");
  positionPicker(ev);
  const inp=document.getElementById("tpNew"); if(inp) inp.focus();
}
function closeTagPicker(){ const p=document.getElementById("tagPicker"); if(p) p.classList.remove("open"); _tagPickIdx=-1; _tagPickId=null; _autoSug=[]; }
// build the filtered tag rows (used on open and on every keystroke)
function tagPickerRows(query){
  const it=_tagPickItem(); if(!it) return "";
  const have=new Set((it.tags||[]).map(t=>t.toLowerCase()));
  const q=(query||"").trim().toLowerCase();
  let all=allTags();
  if(q) all=all.filter(t=>t.toLowerCase().includes(q));
  if(all.length) return all.map(t=>`<button class="tp-row${have.has(t.toLowerCase())?" on":""}" data-tag="${esc(t)}" onclick="event.stopPropagation();tagPickerToggle(this)">${have.has(t.toLowerCase())?"&#10003; ":""}${esc(t)}</button>`).join("");
  return q ? `<div class="tp-empty">No matches — Add to create &ldquo;${esc(query.trim())}&rdquo;</div>`
           : `<div class="tp-empty">No tags yet — type one above.</div>`;
}
function renderTagPicker(){
  const p=document.getElementById("tagPicker"); if(!p) return;
  const it=_tagPickItem(); if(!it){ closeTagPicker(); return; }
  p.innerHTML =
    `<div class="tp-new"><input id="tpNew" placeholder="New tag…" autocomplete="off" oninput="filterTagPicker(this.value)" onkeydown="tagPickerKey(event)"><button id="tpAdd" onclick="event.stopPropagation();tagPickerNewTag()">Add</button></div>`+
    `<label class="tp-multi"><input type="checkbox" id="tpMulti" ${_tagMulti?"checked":""} onchange="toggleTagMulti(this.checked)"> Select multiple</label>`+
    `<div class="tp-list">${tagPickerRows("")}</div>`;
}
// live-filter the list as the user types; when nothing matches, just HIGHLIGHT
// the Add button (never steal focus — that interrupts typing). The cursor stays
// in the field; Enter or clicking the highlighted Add creates the typed tag.
function filterTagPicker(q){
  const list=document.querySelector("#tagPicker .tp-list"); if(!list) return;
  list.innerHTML=tagPickerRows(q);
  _tpHi=-1;   // fresh list — no highlight until the user arrows
  const add=document.getElementById("tpAdd");
  if(add) add.classList.toggle("ready", !!q.trim() && !list.querySelector(".tp-row"));
}
// keyboard in the New-tag field: Up/Down highlight a row, Enter picks the
// highlighted tag (or creates the typed text if none is highlighted), Esc closes.
function tagPickerKey(e){
  const rows=Array.prototype.slice.call(document.querySelectorAll("#tagPicker .tp-row"));
  if(e.key==="ArrowDown"){ e.preventDefault(); if(!rows.length) return; _tpHi=(_tpHi+1>=rows.length)?0:_tpHi+1; tpHighlight(rows); }
  else if(e.key==="ArrowUp"){ e.preventDefault(); if(!rows.length) return; _tpHi=(_tpHi<=0)?rows.length-1:_tpHi-1; tpHighlight(rows); }
  else if(e.key==="Enter"){ e.preventDefault(); if(_tpHi>=0 && rows[_tpHi]) tagPickerToggle(rows[_tpHi]); else tagPickerNewTag(); }
  else if(e.key==="Escape"){ e.preventDefault(); closeTagPicker(); }
}
function tpHighlight(rows){
  rows.forEach((r,i)=>r.classList.toggle("hi", i===_tpHi));
  if(rows[_tpHi] && rows[_tpHi].scrollIntoView) rows[_tpHi].scrollIntoView({block:"nearest"});
}
function tagPickerToggle(btn){
  const tag=btn.getAttribute("data-tag");
  const it=_tagPickItem(); if(!it) return;
  const has=(it.tags||[]).some(t=>t.toLowerCase()===tag.toLowerCase());
  const identity=_tagPickScope==="saved"?_tagPickId:_tagPickIdx;
  if(has) cardRemoveTag(_tagPickScope, identity, (it.tags||[]).find(t=>t.toLowerCase()===tag.toLowerCase()));
  else cardAddTag(tag);
  if(_tagMulti){ renderTagPicker(); const i=document.getElementById("tpNew"); if(i) i.focus(); }   // keep open + typing
  else closeTagPicker();
}
function tagPickerNewTag(){
  const it=_tagPickItem(); if(!it) return;
  const inp=document.getElementById("tpNew"); const tag=inp?inp.value.trim():"";
  if(!tag) return;
  cardAddTag(tag);
  if(_tagMulti){ renderTagPicker(); const i2=document.getElementById("tpNew"); if(i2) i2.focus(); }
  else closeTagPicker();
}
function toggleTagMulti(on){ _tagMulti=!!on; }   // session-only; resets to off on next open
document.addEventListener("click", e=>{ if(!e.target.closest("#tagPicker") && !e.target.closest(".tg-add") && !e.target.closest(".tg-auto")) closeTagPicker(); });
/* ---- AutoTag (AI tag suggestions) ---- */
async function aiSuggestTags(it){
  const vocab=preferredVocab(30);
  const avoid=learnedAvoid(15);
  const prompt=`You curate tags for a personal interests library. Suggest 4-7 tags for this item.\n`+
    `Title: "${(it.title||"").slice(0,200)}"\nDescription: "${(it.desc||"").slice(0,300)}"\nURL: ${it.url||""}\n`+
    (vocab.length?`PREFER reusing these existing tags whenever one fits — reusing keeps the library consistent: ${vocab.join(", ")}\n`:"")+
    (avoid.length?`Do NOT suggest these (the user keeps rejecting them): ${avoid.join(", ")}\n`:"")+
    `Best-practice rules: lowercase; 1-2 words; reuse an existing tag instead of a near-synonym; NO years, dates, or numbers; no generic filler (misc, other, stuff); specific and durable. Return ONLY a JSON array of strings, e.g. ["3d printing","arduino"].`;
  const text=await callAI(prompt);
  const m=text.match(/\[[\s\S]*\]/); if(!m) throw new Error("No suggestions returned");
  let arr; try{ arr=JSON.parse(m[0]); }catch(e){ throw new Error("Could not parse suggestions"); }
  if(!Array.isArray(arr)) throw new Error("Unexpected response");
  // clean -> canonicalize onto existing vocab -> drop learned/bad tags -> dedup
  const seen=new Set(), cleaned=[], loose=[];
  arr.forEach(t=>{ t=(""+t).replace(/^#/,"").trim(); if(!t||t.length>40) return; t=canonicalTag(t); const k=t.toLowerCase(); if(seen.has(k)) return; seen.add(k);
    if(!tagBadPattern(t)) loose.push(t);          // keep as a fallback (ignores learned suppression)
    if(!tagSuppressed(t)) cleaned.push(t);
  });
  let out = cleaned.length ? cleaned : loose;     // if learning nuked everything, fall back to non-junk
  // existing-vocabulary tags first, so the user sees consistent tags on top
  const vset=new Set(vocab.map(v=>v.toLowerCase()));
  out.sort((a,b)=>(vset.has(b.toLowerCase())?1:0)-(vset.has(a.toLowerCase())?1:0));
  return out.slice(0,8);
}
function openAutoTag(scope, identity, ev){
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first", 5000); return; }
  _tagPickScope = scope||"imported";
  if(_tagPickScope==="saved"){ _tagPickId=identity; _tagPickIdx=-1; } else { _tagPickIdx=identity; _tagPickId=null; }
  _autoSug=[]; _autoErr="";
  document.getElementById("tagPicker").classList.add("open");
  renderAutoTag("loading");
  positionPicker(ev);
  const it=_tagPickItem(); if(!it){ closeTagPicker(); return; }
  const openScope=_tagPickScope, openIdentity=identity;
  aiSuggestTags(it).then(tags=>{
    if(_tagPickScope!==openScope || (openScope==="saved"?_tagPickId:_tagPickIdx)!==openIdentity) return;   // picker was closed/changed meanwhile
    const have=new Set((it.tags||[]).map(t=>t.toLowerCase()));
    _autoSug = tags.filter(t=>!have.has(t.toLowerCase())).map(t=>({tag:t, sel:false}));
    _autoSug.forEach(s=>tsRec(s.tag,"sug")); tsSave();   // learn: these were offered
    renderAutoTag(); positionPicker(ev);
  }).catch(e=>{ if(_tagPickScope!==openScope || (openScope==="saved"?_tagPickId:_tagPickIdx)!==openIdentity) return; _autoErr=e.message||"Try again"; renderAutoTag("error"); console.warn("AutoTag failed",e); });
}
function renderAutoTag(state){
  const p=document.getElementById("tagPicker"); if(!p) return;
  if(state==="loading"){ p.innerHTML=`<div class="tp-head"><span class="spin"></span> AutoTag — asking ${esc(PROVIDERS[S.provider]?PROVIDERS[S.provider].label:"AI")}…</div>`; return; }
  if(state==="error"){ p.innerHTML=`<div class="tp-head">AutoTag failed</div><div class="tp-empty">${esc(_autoErr)}</div><div class="tp-actions"><button class="tp-cancel" onclick="event.stopPropagation();closeTagPicker()">Close</button></div>`; return; }
  if(!_autoSug.length){ p.innerHTML=`<div class="tp-head">AutoTag</div><div class="tp-empty">No new tags suggested.</div><div class="tp-actions"><button class="tp-cancel" onclick="event.stopPropagation();closeTagPicker()">Close</button></div>`; return; }
  const anySel=_autoSug.some(s=>s.sel);
  const chips=_autoSug.map((s,i)=>`<span class="tp-sug${s.sel?" sel":""}" onclick="event.stopPropagation();autoToggleSel(${i})">${esc(s.tag)}<span class="tgx" title="Drop suggestion" onclick="event.stopPropagation();autoRemoveSug(${i})">&times;</span></span>`).join("");
  p.innerHTML=
    `<div class="tp-head">AI suggestions <span class="tp-hint">click to select · X to drop</span></div>`+
    `<div class="tp-sugs">${chips}</div>`+
    `<div class="tp-actions"><button class="tp-accept" onclick="event.stopPropagation();autoAccept()">${anySel?"Accept selected":"Accept all"}</button><button class="tp-cancel" onclick="event.stopPropagation();closeTagPicker()">Cancel</button></div>`;
}
function autoToggleSel(i){ if(_autoSug[i]){ _autoSug[i].sel=!_autoSug[i].sel; renderAutoTag(); } }
function autoRemoveSug(i){ const s=_autoSug[i]; if(s){ tsRec(s.tag,"rej"); tsSave(); } _autoSug.splice(i,1); renderAutoTag(); }
function autoAccept(){
  const it=_tagPickItem(); if(!it){ closeTagPicker(); return; }
  const anySel=_autoSug.some(s=>s.sel);
  const pick=_autoSug.filter(s=>anySel?s.sel:true).map(s=>s.tag);
  if(!pick.length){ toast("No tags selected"); return; }
  // learn: accepted vs shown-but-not-accepted
  const pickSet=new Set(pick.map(t=>t.toLowerCase()));
  _autoSug.forEach(s=>tsRec(s.tag, pickSet.has(s.tag.toLowerCase())?"acc":"rej")); tsSave();
  if(!it.tags) it.tags=[];
  let added=0;
  pick.forEach(t=>{ if(!it.tags.some(x=>x.toLowerCase()===t.toLowerCase())){ it.tags.push(t); added++; } });
  _afterTagEdit(_tagPickScope, _tagPickScope==="saved"?_tagPickId:_tagPickIdx);
  closeTagPicker();
  toast(added?("Added "+added+" tag"+(added>1?"s":"")):"Already on the card");
}
```

Apply the identical block to `pwa/index.html` (locate by content, not line number — search for the `_afterTagEdit` doc comment).

**Note:** `impTagToggle` no longer exists (renamed `tagPickerToggle`) and `impAddTag`/`impRemoveTag`/`impRemoveTagEl` no longer exist (renamed `cardAddTag`/`cardRemoveTag`/`cardRemoveTagEl` with new signatures) — Task 3 updates `tagRow`, the only other place these were referenced (confirmed by grep: every call site of the old names lives either inside this block or inside `tagRow`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tag-editing-crud.test.js`
Expected: PASS (10 assertions — 5 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tag-editing-crud.test.js
git commit -m "Tag editing: generalize CRUD + picker functions to (scope, identity)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Generalize `tagRow()` and wire it into `cardHTML` for Saved cards

**Files:**
- Modify: `web/index.html:3302-3311` (`tagRow`)
- Modify: `web/index.html:1290` (`cardHTML`'s saved-mode call site)
- Modify: `pwa/index.html` (same two spots, located by content)
- Test: `tests/tag-editing-render.test.js` (new)

**Interfaces:**
- Consumes: `cardRemoveTagEl`, `openTagPicker`, `openAutoTag` (Task 2), `esc` (existing global HTML-escape helper), `curTab`/`viewMode`/`impTag`/`setImpTag`/`showTab` (existing globals, unchanged).
- Produces: `tagRow(tags, identity, scope)` — `scope` defaults to `"imported"` when omitted, preserving every existing call site's behavior with zero changes required at those call sites.

- [ ] **Step 1: Write the failing test**

Create `tests/tag-editing-render.test.js`:

```js
// tests/tag-editing-render.test.js — Task 3: tagRow renders an editable
// add/remove UI for BOTH imported (g1 view, unchanged regression) and saved
// (new) cards, wired to the Task 2 functions with the right scope/identity.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadTagRow(src, globals) {
  const factory = new Function(
    "esc", "curTab", "viewMode", "impTag",
    fn(src, "tagRow") + "\nreturn tagRow;"
  );
  return factory(
    (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    globals.curTab, globals.viewMode, globals.impTag
  );
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": tagRow(scope='saved') always renders editable chips + tg-add + tg-auto, wired to the saved id", () => {
    const tagRow = loadTagRow(src, { curTab: "saved", viewMode: "g4", impTag: "" });
    const out = tagRow(["stl files"], "s0", "saved");
    assert.match(out, /cardRemoveTagEl\('saved','s0',this\)/);
    assert.match(out, /openTagPicker\('saved','s0',event\)/);
    assert.match(out, /openAutoTag\('saved','s0',event\)/);
    assert.match(out, /class="tg-add"/);
    assert.match(out, /class="tg-auto"/);
  });

  t(label + ": tagRow(scope omitted) on an imported card in g1 view is UNCHANGED — still renders the editable imported branch", () => {
    const tagRow = loadTagRow(src, { curTab: "imported", viewMode: "g1", impTag: "" });
    const out = tagRow(["3d printing"], 4);
    assert.match(out, /cardRemoveTagEl\('imported',4,this\)/);
    assert.match(out, /openTagPicker\('imported',4,event\)/);
    assert.match(out, /openAutoTag\('imported',4,event\)/);
  });

  t(label + ": tagRow(scope omitted) outside imported g1 view stays read-only (regression)", () => {
    const tagRow = loadTagRow(src, { curTab: "imported", viewMode: "g4", impTag: "" });
    const out = tagRow(["3d printing"], 4);
    assert.doesNotMatch(out, /tg-add/);
    assert.doesNotMatch(out, /openTagPicker/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/tag-editing-render.test.js`
Expected: FAIL — the saved-scope assertions fail (`tagRow` doesn't accept a 3rd `scope` argument yet, so `scope==="saved"` never fires and no `cardRemoveTagEl('saved',...)` string is produced).

- [ ] **Step 3: Write the implementation**

Replace `tagRow` (`web/index.html:3302-3311`) with:

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

Then in `cardHTML` (`web/index.html:1290`), change:

```js
      ${mode==="saved"?tagRow(item.tags):""}
```

to:

```js
      ${mode==="saved"?tagRow(item.tags, item.id, "saved"):""}
```

`impCardHTML`'s existing call site (`tagRow(it.tags, idx)`, line 3755) needs **no change** — `scope` is omitted, which defaults to `"imported"`, exactly matching today's behavior.

Apply both edits identically to `pwa/index.html`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/tag-editing-render.test.js`
Expected: PASS (6 assertions — 3 per file).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/tag-editing-render.test.js
git commit -m "Tag editing: tagRow renders an editable tag UI on Saved cards too

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Web/PWA byte-identity + full regression pass

**Files:**
- Test: `tests/tag-editing-parity.test.js` (new)
- No source changes expected — this task PROVES Tasks 1-3 landed identically in both files. If it fails, fix whichever file drifted.

**Interfaces:**
- Consumes: every function name introduced/changed in Tasks 1-3.

- [ ] **Step 1: Write the test**

Create `tests/tag-editing-parity.test.js`:

```js
// tests/tag-editing-parity.test.js — the whole generalized tag-editing
// system (Tasks 1-3) must be byte-identical between web/index.html and
// pwa/index.html — there is no platform-specific reason for it to differ
// (Store.putCards/putSaved already abstract Core-HTTP vs IndexedDB away).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

const FNS = [
  "allTags", "_tagPickItem", "_afterTagEdit", "cardAddTag", "cardRemoveTag", "cardRemoveTagEl",
  "positionPicker", "openTagPicker", "closeTagPicker", "tagPickerRows", "renderTagPicker",
  "filterTagPicker", "tagPickerKey", "tpHighlight", "tagPickerToggle", "tagPickerNewTag",
  "toggleTagMulti", "aiSuggestTags", "openAutoTag", "renderAutoTag", "autoToggleSel",
  "autoRemoveSug", "autoAccept", "canonicalTag", "tagRow",
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

Run: `node tests/tag-editing-parity.test.js`
Expected: PASS for every function. If any FAIL, diff that one function between the two files and make `pwa/index.html` match `web/index.html` exactly (web is the source of truth per the project's existing convention — `pwa/index.html` is the mirror).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: `ALL TEST FILES PASSED`. Pay particular attention to any pre-existing test that references `impAddTag`, `impRemoveTag`, `impTagToggle`, or `allImportedTags` by name (none were found in the current suite, but re-confirm — a stale reference would now fail with "not found in source").

- [ ] **Step 4: Manual smoke check (both apps)**

Launch the desktop app (or `node core/server.js` + open `web/index.html` in a browser) and confirm by hand:
1. Imported tab, single-card (g1) view: add a tag via "+", add via "✨ AI", remove a tag via "×" — all still work exactly as before.
2. Saved tab: every card now shows tag chips + "+" + "✨ AI"; add/remove a tag on a Saved card and confirm it persists after a page reload (`Store.putSaved` actually wrote it).

- [ ] **Step 5: Commit**

```bash
git add tests/tag-editing-parity.test.js
git commit -m "Tag editing: web/pwa byte-identity test for the generalized system

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## What this plan deliberately does NOT do (left for later plans)

- No new nav, no `ia_tabs` data model, no tab creation/management UI — that's Plan 2 (Custom Tabs core).
- No AI research/article feature — that's Plan 3.
- `preferredVocab`/`learnedAvoid`/`tsRec`/`tsSave` (the tag-learning helpers) are untouched — they already treat `imported`+`saved` together where it matters (see `autoTag`'s existing cross-array queue), so no change was needed for this plan's goal.
- No CSS changes — the existing `.tagsline`/`.tg`/`.tg-add`/`.tg-auto`/`#tagPicker` rules are reused as-is on Saved cards. If the extra row feels visually cramped once built, that's a follow-up polish task, not a blocker for this plan.
