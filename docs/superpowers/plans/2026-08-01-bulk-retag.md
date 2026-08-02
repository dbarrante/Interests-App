# Bulk Re-tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user apply a tag (existing or new) to many cards at once, in each of Saved, Imported, and an open Custom Tab — replacing each section's current "add to tab only" bulk button with one that opens the full tag picker.

**Architecture:** The existing per-card tag picker (`#tagPicker` popover, driven by `openTagPicker`/`renderTagPicker`/`tagPickerRows`/`tagPickerToggle`/`tagPickerNewTag`) gains a second mode: when a new module-level `_bulkTagItems` array is set (instead of the single-card `_tagPickScope`/`_tagPickId`/`_tagPickIdx` triple), the same popover renders the same tag list, but confirming a tag calls the existing pure `bulkAddTag(items, tag)` against every item in `_bulkTagItems` instead of toggling one card's tags. Each of the three sections gets a thin `open*BulkTagPicker()` wrapper that builds its `items` array from its own existing multi-select state and opens the shared picker.

**Tech Stack:** Vanilla JS, inline in `web/index.html` and `pwa/index.html` (must stay byte-identical for every touched function — this project's existing convention, enforced by `tests/tag-editing-parity.test.js`). No `core/` or `core/db.js` changes — client-side only, same as the spec states.

## Global Constraints

- Add-only: no bulk tag *removal* in this plan (spec: `docs/superpowers/specs/2026-08-01-bulk-retag-design.md`).
- Per-section selection stays independent — no cross-section picker.
- The new "Apply tag…" button **replaces** each section's existing "Add to tab ▾" button/menu (not added alongside it) — the old Custom-Tab-only dropdown mechanism (`savedAddTabMenuHTML`/`impAddTabMenuHTML`/`toggleSavedAddTabMenu`/`toggleImpAddTabMenu`/`addSavedPicksToTab`/`addImportedPicksToTab`/`savedAddTabMenuOpen`/`impAddTabMenuOpen`) becomes fully unused once replaced and must be deleted, not left dead.
- Every function touched in `web/index.html` must be edited identically in `pwa/index.html` — byte-for-byte, including comments. Verify with `tests/tag-editing-parity.test.js` (extend its `FNS` list to cover new functions) after every task.
- Tests are plain Node `assert` scripts (`node tests/<name>.test.js`); `node tests/run.js` runs the syntax gate + all `*.test.js`. This project's `tests/_extract.js` `extractFn(src, name)` pulls one named top-level function's source out of the HTML for isolated `new Function(...)` execution — the established pattern for testing inline script code without a build step.
- If any `pwa/index.html` edit lands, bump `pwa/sw.js`'s `SHELL_CACHE` (check current value, increment) — required project convention, or installed PWAs silently stay on stale code.
- Commit trailer must be exactly `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Shared bulk-mode for the tag picker

**Files:**
- Modify: `web/index.html:4026` (new state vars), `:4162` (`closeTagPicker`), `:3607` (`tabPickerRows`), `:4164` (`tagPickerRows`), `:4174` (`renderTagPicker`), `:4206` (`tagPickerToggle`), `:4216` (`tagPickerNewTag`), `:4225` (outside-click listener) — plus a new `openBulkTagPicker`/`bulkTagPickerApply` pair inserted right after `bulkAddTag` (`:3618-3625`).
- Modify: `pwa/index.html` at the mirrored lines — `:4101` (state vars), `:4237` (`closeTagPicker`), `:3682` (`tabPickerRows`), `:4239` (`tagPickerRows`), `:4249` (`renderTagPicker`), `:4281` (`tagPickerToggle`), `:4291` (`tagPickerNewTag`), `:4300` (outside-click listener), and after `bulkAddTag` (`:3693-3700`).
- Test: `tests/bulk-tag-picker.test.js` (new), `tests/tabs-picker.test.js` (extend), `tests/tag-editing-parity.test.js` (extend `FNS`).

**Interfaces:**
- Produces: `let _bulkTagItems` (array of live card/saved objects, or `null`), `let _bulkTagDone` (`(n, tag) => void`, or `null`); `function openBulkTagPicker(items, onDone, ev)`; `function bulkTagPickerApply(tag)`. Tasks 2-4 call `openBulkTagPicker` and pass their own `onDone` callback — nothing else in this task's surface changes.
- Consumes: existing `bulkAddTag(items, tag)` (`web/index.html:3618`), `positionPicker(ev)` (`:4145`), `allTags()`, `esc()`.

- [ ] **Step 1: Write the failing tests for the render-branching logic**

Create `tests/bulk-tag-picker.test.js`:

```js
// tests/bulk-tag-picker.test.js — the shared #tagPicker popover's bulk mode
// (Task 1 of the bulk-retag plan): when _bulkTagItems is set, the same popover
// applies one tag to many items instead of toggling tags on one card.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }
const escFn = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": bulkTagPickerApply tags every item in _bulkTagItems and reports the count to onDone", () => {
    const body = [fn(src, "bulkAddTag"), fn(src, "bulkTagPickerApply")].join("\n");
    let doneArgs = null, closed = false;
    const factory = new Function(
      "_bulkTagItems", "_bulkTagDone", "closeTagPicker",
      body + "\nreturn bulkTagPickerApply;"
    );
    const items = [{ tags: [] }, { tags: ["travel"] }];
    const bulkTagPickerApply = factory(items, (n, tag) => { doneArgs = [n, tag]; }, () => { closed = true; });
    bulkTagPickerApply("travel");
    assert.deepStrictEqual(items[0].tags, ["travel"]);
    assert.deepStrictEqual(items[1].tags, ["travel"]);
    assert.deepStrictEqual(doneArgs, [1, "travel"]);
    assert.strictEqual(closed, true, "bulkTagPickerApply must close the picker after applying");
  });

  t(label + ": bulkTagPickerApply no-ops on an empty/whitespace tag", () => {
    const body = [fn(src, "bulkAddTag"), fn(src, "bulkTagPickerApply")].join("\n");
    let called = false;
    const factory = new Function(
      "_bulkTagItems", "_bulkTagDone", "closeTagPicker",
      body + "\nreturn bulkTagPickerApply;"
    );
    const items = [{ tags: [] }];
    const bulkTagPickerApply = factory(items, () => { called = true; }, () => { called = true; });
    bulkTagPickerApply("   ");
    assert.deepStrictEqual(items[0].tags, []);
    assert.strictEqual(called, false);
  });

  t(label + ": bulkTagPickerApply is a no-op when _bulkTagItems is null (picker not in bulk mode)", () => {
    const body = [fn(src, "bulkAddTag"), fn(src, "bulkTagPickerApply")].join("\n");
    let called = false;
    const factory = new Function(
      "_bulkTagItems", "_bulkTagDone", "closeTagPicker",
      body + "\nreturn bulkTagPickerApply;"
    );
    const bulkTagPickerApply = factory(null, () => { called = true; }, () => { called = true; });
    bulkTagPickerApply("travel");
    assert.strictEqual(called, false);
  });

  t(label + ": tagPickerRows shows no checkmarks in bulk mode even when every item already has the tag", () => {
    const body = fn(src, "tagPickerRows");
    const factory = new Function(
      "_bulkTagItems", "_tagPickItem", "allTags", "esc",
      body + "\nreturn tagPickerRows;"
    );
    const tagPickerRows = factory(
      [{ tags: ["travel"] }, { tags: ["travel"] }],
      () => { throw new Error("_tagPickItem must not be called in bulk mode"); },
      () => ["travel", "cooking"],
      escFn
    );
    const out = tagPickerRows("");
    assert.match(out, /data-tag="travel"/);
    assert.doesNotMatch(out, /tp-row on/);
    assert.doesNotMatch(out, /&#10003;/);
  });

  t(label + ": tabPickerRows returns empty string in bulk mode (no pinned Tabs section)", () => {
    const body = fn(src, "tabPickerRows");
    const factory = new Function(
      "_bulkTagItems", "_tagPickItem", "tabs", "esc",
      body + "\nreturn tabPickerRows;"
    );
    const tabPickerRows = factory([{ tags: [] }], () => { throw new Error("must not be called"); }, [{ id: "1", name: "STL files", tag: "stl files", reserved: false }], escFn);
    assert.strictEqual(tabPickerRows(), "");
  });

  t(label + ": closeTagPicker resets bulk-mode state", () => {
    const body = fn(src, "closeTagPicker");
    assert.match(body, /_bulkTagItems\s*=\s*null/);
    assert.match(body, /_bulkTagDone\s*=\s*null/);
  });

  t(label + ": the outside-click handler does not close the picker when a bulk-tag trigger button is clicked", () => {
    assert.match(src, /closest\(["']\.bulk-tag-btn["']\)/);
  });

  t(label + ": openBulkTagPicker sets bulk state and opens the picker", () => {
    const body = fn(src, "openBulkTagPicker");
    assert.match(body, /_bulkTagItems\s*=\s*items/);
    assert.match(body, /_bulkTagDone\s*=\s*onDone/);
    assert.match(body, /renderTagPicker\(\)/);
    assert.match(body, /classList\.add\(["']open["']\)/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `node tests/bulk-tag-picker.test.js`
Expected: every case fails (functions/behavior don't exist yet — `bulkTagPickerApply`/`openBulkTagPicker` not found, `closeTagPicker`/`tabPickerRows`/outside-click regexes don't match).

- [ ] **Step 3: Add the bulk-mode state and functions to `web/index.html`**

Immediately after `bulkAddTag` (`web/index.html:3618-3625`), insert:

```js
// ---- bulk tag picker: the SAME #tagPicker popover, retargeted to apply one
// tag to many cards at once (Saved/Imported/Tabs multi-select), instead of
// toggling tags on a single card. Mutually exclusive with the single-card
// _tagPickScope/_tagPickId/_tagPickIdx state — only one mode is ever active,
// since closeTagPicker() always resets both.
function openBulkTagPicker(items, onDone, ev){
  if(!items || !items.length) return;
  _bulkTagItems = items; _bulkTagDone = onDone;
  _tpHi=-1;
  renderTagPicker();
  document.getElementById("tagPicker").classList.add("open");
  positionPicker(ev);
  const inp=document.getElementById("tpNew"); if(inp) inp.focus();
}
function bulkTagPickerApply(tag){
  tag=(tag||"").trim(); if(!tag || !_bulkTagItems) return;
  const n = bulkAddTag(_bulkTagItems, tag);
  const done = _bulkTagDone;
  closeTagPicker();
  if(done) done(n, tag);
}
```

Add the two new state variables right after `_autoErr` (`web/index.html:4026`):

```js
let _bulkTagItems = null;     // array of live card/saved objects when the picker is in bulk mode, else null
let _bulkTagDone = null;      // (n, tag) => void — run after a bulk apply; persists + toasts + exits select mode
```

Change `closeTagPicker` (`web/index.html:4162`) from:

```js
function closeTagPicker(){ const p=document.getElementById("tagPicker"); if(p) p.classList.remove("open"); _tagPickIdx=-1; _tagPickId=null; _autoSug=[]; }
```

to:

```js
function closeTagPicker(){ const p=document.getElementById("tagPicker"); if(p) p.classList.remove("open"); _tagPickIdx=-1; _tagPickId=null; _autoSug=[]; _bulkTagItems=null; _bulkTagDone=null; }
```

Change `tabPickerRows` (`web/index.html:3607-3614`) from:

```js
function tabPickerRows(){
  const it = _tagPickItem(); if(!it || !tabs.length) return "";
  const have = new Set((it.tags||[]).map(t=>t.toLowerCase()));
  const chips = tabs.map(tb=>
    `<button class="tp-row tp-tab${have.has(tb.tag.toLowerCase())?" on":""}" data-tag="${esc(tb.tag)}" onclick="event.stopPropagation();tagPickerToggle(this)">${have.has(tb.tag.toLowerCase())?"&#10003; ":""}${tb.reserved?"&#129302; ":""}${esc(tb.name)}</button>`
  ).join("");
  return `<div class="tp-tabs-label">Tabs</div><div class="tp-tabs">${chips}</div>`;
}
```

to (bulk mode skips this pinned section entirely — the full tag list below already includes every Custom Tab's tag mixed in with regular tags, since a tab's tag is just a tag):

```js
function tabPickerRows(){
  if(_bulkTagItems) return "";
  const it = _tagPickItem(); if(!it || !tabs.length) return "";
  const have = new Set((it.tags||[]).map(t=>t.toLowerCase()));
  const chips = tabs.map(tb=>
    `<button class="tp-row tp-tab${have.has(tb.tag.toLowerCase())?" on":""}" data-tag="${esc(tb.tag)}" onclick="event.stopPropagation();tagPickerToggle(this)">${have.has(tb.tag.toLowerCase())?"&#10003; ":""}${tb.reserved?"&#129302; ":""}${esc(tb.name)}</button>`
  ).join("");
  return `<div class="tp-tabs-label">Tabs</div><div class="tp-tabs">${chips}</div>`;
}
```

Change `tagPickerRows` (`web/index.html:4164-4173`) from:

```js
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
```

to:

```js
function tagPickerRows(query){
  const it=_bulkTagItems ? null : _tagPickItem(); if(!_bulkTagItems && !it) return "";
  const have=it ? new Set((it.tags||[]).map(t=>t.toLowerCase())) : new Set();
  const q=(query||"").trim().toLowerCase();
  let all=allTags();
  if(q) all=all.filter(t=>t.toLowerCase().includes(q));
  if(all.length) return all.map(t=>`<button class="tp-row${have.has(t.toLowerCase())?" on":""}" data-tag="${esc(t)}" onclick="event.stopPropagation();tagPickerToggle(this)">${have.has(t.toLowerCase())?"&#10003; ":""}${esc(t)}</button>`).join("");
  return q ? `<div class="tp-empty">No matches — Add to create &ldquo;${esc(query.trim())}&rdquo;</div>`
           : `<div class="tp-empty">No tags yet — type one above.</div>`;
}
```

Change `renderTagPicker` (`web/index.html:4174-4182`) from:

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

to (bulk mode gets a "N selected" header instead of the single-card guard, and hides the "Select multiple" toggle — that checkbox's "keep the picker open to add several tags to THIS ONE card" meaning doesn't apply to a bulk apply, which is a single-shot action per open):

```js
function renderTagPicker(){
  const p=document.getElementById("tagPicker"); if(!p) return;
  if(!_bulkTagItems){ const it=_tagPickItem(); if(!it){ closeTagPicker(); return; } }
  const header = _bulkTagItems ? `<div class="tp-tabs-label">Apply tag to ${_bulkTagItems.length} selected</div>` : "";
  p.innerHTML = header +
    tabPickerRows() +
    `<div class="tp-new"><input id="tpNew" placeholder="New tag…" autocomplete="off" oninput="filterTagPicker(this.value)" onkeydown="tagPickerKey(event)"><button id="tpAdd" onclick="event.stopPropagation();tagPickerNewTag()">Add</button></div>`+
    (_bulkTagItems ? "" : `<label class="tp-multi"><input type="checkbox" id="tpMulti" ${_tagMulti?"checked":""} onchange="toggleTagMulti(this.checked)"> Select multiple</label>`)+
    `<div class="tp-list">${tagPickerRows("")}</div>`;
}
```

Change `tagPickerToggle` (`web/index.html:4206-4215`) from:

```js
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
```

to:

```js
function tagPickerToggle(btn){
  const tag=btn.getAttribute("data-tag");
  if(_bulkTagItems){ bulkTagPickerApply(tag); return; }
  const it=_tagPickItem(); if(!it) return;
  const has=(it.tags||[]).some(t=>t.toLowerCase()===tag.toLowerCase());
  const identity=_tagPickScope==="saved"?_tagPickId:_tagPickIdx;
  if(has) cardRemoveTag(_tagPickScope, identity, (it.tags||[]).find(t=>t.toLowerCase()===tag.toLowerCase()));
  else cardAddTag(tag);
  if(_tagMulti){ renderTagPicker(); const i=document.getElementById("tpNew"); if(i) i.focus(); }   // keep open + typing
  else closeTagPicker();
}
```

Change `tagPickerNewTag` (`web/index.html:4216-4223`) from:

```js
function tagPickerNewTag(){
  const it=_tagPickItem(); if(!it) return;
  const inp=document.getElementById("tpNew"); const tag=inp?inp.value.trim():"";
  if(!tag) return;
  cardAddTag(tag);
  if(_tagMulti){ renderTagPicker(); const i2=document.getElementById("tpNew"); if(i2) i2.focus(); }
  else closeTagPicker();
}
```

to:

```js
function tagPickerNewTag(){
  const inp=document.getElementById("tpNew"); const tag=inp?inp.value.trim():"";
  if(!tag) return;
  if(_bulkTagItems){ bulkTagPickerApply(tag); return; }
  const it=_tagPickItem(); if(!it) return;
  cardAddTag(tag);
  if(_tagMulti){ renderTagPicker(); const i2=document.getElementById("tpNew"); if(i2) i2.focus(); }
  else closeTagPicker();
}
```

Change the outside-click listener (`web/index.html:4225`) from:

```js
document.addEventListener("click", e=>{ if(!e.target.closest("#tagPicker") && !e.target.closest(".tg-add") && !e.target.closest(".tg-auto")) closeTagPicker(); });
```

to (the new bulk-tag trigger buttons (Task 2-4) need the same exclusion `.tg-add`/`.tg-auto` already get — the button's own `onclick` opens the picker in the same click that bubbles to this document listener; without the exclusion, the picker would open and immediately close in the same tick):

```js
document.addEventListener("click", e=>{ if(!e.target.closest("#tagPicker") && !e.target.closest(".tg-add") && !e.target.closest(".tg-auto") && !e.target.closest(".bulk-tag-btn")) closeTagPicker(); });
```

- [ ] **Step 4: Mirror every change from Step 3 into `pwa/index.html`**

Apply the identical before/after edits at `pwa/index.html`'s mirrored locations: `bulkAddTag` ends at `:3700`, insert the new functions there; state vars after `_autoErr` at `:4101`; `closeTagPicker` at `:4237`; `tabPickerRows` at `:3682-3689`; `tagPickerRows` at `:4239-4248`; `renderTagPicker` at `:4249-4257`; `tagPickerToggle` at `:4281-4290`; `tagPickerNewTag` at `:4291-4298`; outside-click listener at `:4300`. Every one of these must be byte-identical text to what you just wrote in `web/index.html` — copy-paste, don't retype.

- [ ] **Step 5: Run the new test file to verify it passes**

Run: `node tests/bulk-tag-picker.test.js`
Expected: PASS, all cases, both `web` and `pwa` labels.

- [ ] **Step 6: Extend `tests/tabs-picker.test.js` with a bulk-mode case for `tabPickerRows`**

Add this test inside the existing `for (const [label, src] of [["web", html], ["pwa", pwaHtml]])` loop, after the "returns an empty string when there are no tabs yet" test:

```js
  t(label + ": tabPickerRows returns empty string in bulk mode even when tabs exist and the picker isn't closed", () => {
    const body = [fn(src,"_tagPickItem"), fn(src,"tabPickerRows")].join("\n");
    const factory = new Function(
      "imported", "saved", "_tagPickScope", "_tagPickIdx", "_tagPickId", "tabs", "esc", "_bulkTagItems",
      body + "\nreturn tabPickerRows;"
    );
    const tabsList = [{id:"1",name:"STL files",tag:"stl files",reserved:false}];
    const tabPickerRows = factory([], [], "imported", -1, null, tabsList, (s)=>s, [{tags:[]}]);
    assert.strictEqual(tabPickerRows(), "");
  });
```

- [ ] **Step 7: Run `tests/tabs-picker.test.js` to verify it still passes**

Run: `node tests/tabs-picker.test.js`
Expected: PASS, all cases (existing + the new one), both `web` and `pwa`.

- [ ] **Step 8: Add the two new functions to `tests/tag-editing-parity.test.js`'s `FNS` list**

In `tests/tag-editing-parity.test.js`, change:

```js
const FNS = [
  "allTags", "_tagPickItem", "_afterTagEdit", "cardAddTag", "cardRemoveTag", "cardRemoveTagEl",
  "positionPicker", "openTagPicker", "closeTagPicker", "tagPickerRows", "renderTagPicker",
  "filterTagPicker", "tagPickerKey", "tpHighlight", "tagPickerToggle", "tagPickerNewTag",
  "toggleTagMulti", "aiSuggestTags", "openAutoTag", "renderAutoTag", "autoToggleSel",
  "autoRemoveSug", "autoAccept", "canonicalTag", "tagRow",
];
```

to:

```js
const FNS = [
  "allTags", "_tagPickItem", "_afterTagEdit", "cardAddTag", "cardRemoveTag", "cardRemoveTagEl",
  "positionPicker", "openTagPicker", "closeTagPicker", "tagPickerRows", "renderTagPicker",
  "filterTagPicker", "tagPickerKey", "tpHighlight", "tagPickerToggle", "tagPickerNewTag",
  "toggleTagMulti", "aiSuggestTags", "openAutoTag", "renderAutoTag", "autoToggleSel",
  "autoRemoveSug", "autoAccept", "canonicalTag", "tagRow", "tabPickerRows", "bulkAddTag",
  "openBulkTagPicker", "bulkTagPickerApply",
];
```

- [ ] **Step 9: Run `tests/tag-editing-parity.test.js` and the full suite**

Run: `node tests/tag-editing-parity.test.js`
Expected: PASS, every function byte-identical.

Run: `node tests/syntax-check.js && node tests/run.js`
Expected: both green, no regressions in any other test file.

- [ ] **Step 10: Commit**

```bash
git add web/index.html pwa/index.html tests/bulk-tag-picker.test.js tests/tabs-picker.test.js tests/tag-editing-parity.test.js
git commit -m "$(cat <<'EOF'
Add a bulk mode to the shared tag picker

_bulkTagItems, when set, retargets the same #tagPicker popover from
toggling one card's tags to applying one tag to many cards at once via the
existing bulkAddTag(). No call site wired up yet — that's Tasks 2-4.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the Saved section

**Files:**
- Modify: `web/index.html:1064` (`showTab` tabs-entry reset), `:1325-1330` (`renderSaved`), `:3626-3648` (Saved bulk-add block — replace).
- Modify: `pwa/index.html` at the mirrored lines: `:1103`, `:1363-1368`, `:3701-3723`.
- Test: `tests/tabs-bulk-add.test.js` (replace the now-obsolete Saved-side tests).

**Interfaces:**
- Consumes: `openBulkTagPicker(items, onDone, ev)` and `bulkTagPickerApply` (Task 1); `saved` (global array), `savedSelPicks`/`savedSelMode` (existing globals), `Store.putSaved`, `toast`, `renderSaved`.
- Produces: `function openSavedBulkTagPicker(ev)` — Task 5's manual smoke test clicks this section's "Apply tag…" button.

- [ ] **Step 1: Write the failing tests**

In `tests/tabs-bulk-add.test.js`, remove these three tests entirely (they test functions this task deletes): `"addSavedPicksToTab applies the tab's tag to every picked saved id and persists"`, `"savedAddTabMenuHTML closes itself once the backing selection empties, even if left 'open'"`, and the `"entering the Tabs view also closes the new Add-to-tab menu"` test (it asserts on `impAddTabMenuOpen`/`savedAddTabMenuOpen`, which Task 2+3 remove — replaced in Step 1 below with an updated version).

Replace the file's header comment (currently `// tests/tabs-bulk-add.test.js — Task 4: bulkAddTag's pure mutation logic, and the\n// Saved-side + Imported-side wiring that calls it. cardHTML's/the bulk bar's\n// innerHTML is covered by a manual smoke check (same convention as tabs-view).`) with:

```js
// tests/tabs-bulk-add.test.js — bulkAddTag's pure mutation logic, plus the
// Saved/Imported/Tabs wiring that opens the shared bulk tag picker
// (docs/superpowers/plans/2026-08-01-bulk-retag.md). cardHTML's/the bulk
// bar's innerHTML is covered by a manual smoke check (same convention as
// tabs-view).
```

Add these tests inside the existing `for (const [label, src] of [["web", html], ["pwa", pwaHtml]])` loop (keep the two `bulkAddTag` tests and the `cardHTML` pick-overlay test as-is):

```js
  t(label + ": openSavedBulkTagPicker opens the shared bulk picker with every picked saved item", () => {
    const savedArr = [{ id: "s0", tags: [] }, { id: "s1", tags: [] }, { id: "s2", tags: [] }];
    let openedWith = null;
    const factory = new Function(
      "saved", "savedSelPicks", "openBulkTagPicker",
      fn(src, "openSavedBulkTagPicker") + "\nreturn openSavedBulkTagPicker;"
    );
    const openSavedBulkTagPicker = factory(savedArr, new Set(["s0", "s2"]), (items) => { openedWith = items; });
    openSavedBulkTagPicker({});
    assert.deepStrictEqual(openedWith, [savedArr[0], savedArr[2]]);
  });

  t(label + ": openSavedBulkTagPicker does nothing when nothing is picked", () => {
    let called = false;
    const factory = new Function(
      "saved", "savedSelPicks", "openBulkTagPicker",
      fn(src, "openSavedBulkTagPicker") + "\nreturn openSavedBulkTagPicker;"
    );
    const openSavedBulkTagPicker = factory([], new Set(), () => { called = true; });
    openSavedBulkTagPicker({});
    assert.strictEqual(called, false);
  });

  t(label + ": openSavedBulkTagPicker's onDone persists, tags the toast with the applied tag, and exits select mode", () => {
    const savedArr = [{ id: "s0", tags: [] }];
    const calls = [];
    const factory = new Function(
      "saved", "savedSelPicks", "savedSelMode", "openBulkTagPicker", "Store", "toast", "renderSaved",
      fn(src, "openSavedBulkTagPicker") + "\nreturn openSavedBulkTagPicker;"
    );
    const openSavedBulkTagPicker = factory(
      savedArr, new Set(["s0"]), true,
      (items, onDone) => onDone(1, "travel"),
      { putSaved: (arr) => calls.push(["putSaved", arr]) },
      (msg) => calls.push(["toast", msg]),
      () => calls.push("render")
    );
    openSavedBulkTagPicker({});
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putSaved"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "toast" && /travel/.test(c[1])));
    assert.ok(calls.includes("render"));
  });

  t(label + ": the Saved bulk toolbar's tag button is an Apply-tag trigger, not the old tab-only menu", () => {
    const body = fn(src, "renderSaved");
    assert.match(body, /openSavedBulkTagPicker\(event\)/);
    assert.match(body, /bulk-tag-btn/);
    assert.doesNotMatch(body, /toggleSavedAddTabMenu/);
  });

  t(label + ": the old Custom-Tab-only Saved bulk-add mechanism is fully removed", () => {
    assert.strictEqual(extractFn(src, "addSavedPicksToTab"), null);
    assert.strictEqual(extractFn(src, "savedAddTabMenuHTML"), null);
    assert.strictEqual(extractFn(src, "toggleSavedAddTabMenu"), null);
    assert.doesNotMatch(src, /savedAddTabMenuOpen/);
  });

  t(label + ": entering the Tabs view still resets Saved's select mode (savedAddTabMenuOpen reference removed)", () => {
    const body = fn(src, "showTab");
    assert.match(body, /if\(t===["']tabs["']\)\{\s*selMode=false;\s*selPicks\.clear\(\);.*savedSelMode=false;\s*savedSelPicks\.clear\(\);.*renderTabsView\(\)/);
  });
```

Note: `openSavedBulkTagPicker`'s real body reassigns `savedSelMode`/`savedSelPicks` directly (`savedSelMode=false; savedSelPicks.clear();`). Passing them as ordinary parameters of the generated function is enough — the function body's reassignment mutates its own parameter binding, same as any real JS closure, and the test proves persistence/toast/render happened without needing to read the values back afterward.

- [ ] **Step 2: Run the test file to verify the new tests fail**

Run: `node tests/tabs-bulk-add.test.js`
Expected: FAIL — `openSavedBulkTagPicker` not found; the "fully removed" test fails because `addSavedPicksToTab` etc. still exist; the `showTab` regex doesn't match yet.

- [ ] **Step 3: Edit `web/index.html`**

Change `renderSaved` (`web/index.html:1325-1330`) from:

```js
function renderSaved(){
  const list = applyFilter(saved);
  document.getElementById("savedBulkBar").innerHTML = savedSelMode
    ? `<button class="btn btn-ghost" onclick="toggleSavedAddTabMenu()" ${savedSelPicks.size?"":"disabled"}>Add to tab &#9662;</button>${savedAddTabMenuHTML()}
       <button class="btn btn-ghost" onclick="toggleSavedSelMode()">Done</button>`
    : `<button class="btn btn-ghost" onclick="toggleSavedSelMode()">&#9745; Select</button>`;
```

to:

```js
function renderSaved(){
  const list = applyFilter(saved);
  document.getElementById("savedBulkBar").innerHTML = savedSelMode
    ? `<button class="btn btn-ghost bulk-tag-btn" onclick="openSavedBulkTagPicker(event)" ${savedSelPicks.size?"":"disabled"}>Apply tag…</button>
       <button class="btn btn-ghost" onclick="toggleSavedSelMode()">Done</button>`
    : `<button class="btn btn-ghost" onclick="toggleSavedSelMode()">&#9745; Select</button>`;
```

Replace the whole Saved bulk-add block (`web/index.html:3626-3648`, from `let savedSelMode = false;` through the end of `addSavedPicksToTab`) — currently:

```js
let savedSelMode = false;
let savedSelPicks = new Set();   // saved item ids
let savedAddTabMenuOpen = false;
function toggleSavedSelMode(){ savedSelMode=!savedSelMode; if(!savedSelMode){ savedSelPicks.clear(); savedAddTabMenuOpen=false; } renderSaved(); }
function toggleSavedPick(id){ savedSelPicks.has(id)?savedSelPicks.delete(id):savedSelPicks.add(id); renderSaved(); }
function toggleSavedAddTabMenu(){ savedAddTabMenuOpen=!savedAddTabMenuOpen; renderSaved(); }
function savedAddTabMenuHTML(){
  // Also close if the backing selection emptied out from under it (e.g. the
  // user unchecked every card) — otherwise the menu would stay visibly open
  // next to a now-disabled trigger, and clicking a tab row would silently no-op.
  if(!savedAddTabMenuOpen || !savedSelPicks.size) return "";
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
```

with:

```js
let savedSelMode = false;
let savedSelPicks = new Set();   // saved item ids
function toggleSavedSelMode(){ savedSelMode=!savedSelMode; if(!savedSelMode){ savedSelPicks.clear(); } renderSaved(); }
function toggleSavedPick(id){ savedSelPicks.has(id)?savedSelPicks.delete(id):savedSelPicks.add(id); renderSaved(); }
function openSavedBulkTagPicker(ev){
  if(!savedSelPicks.size) return;
  const items = saved.filter(s=>s && savedSelPicks.has(s.id));
  openBulkTagPicker(items, (n,tag)=>{
    Store.putSaved(saved);
    savedSelMode=false; savedSelPicks.clear();
    renderSaved();
    toast(n?("Tagged "+n+" card"+(n>1?"s":"")+" with "+tag):"Already tagged "+tag);
  }, ev);
}
```

Change `showTab` (`web/index.html:1064`) from:

```js
  if(t==="tabs"){ selMode=false; selPicks.clear(); impAddTabMenuOpen=false; savedSelMode=false; savedSelPicks.clear(); savedAddTabMenuOpen=false; tabSelMode=false; tabSelPicks.clear(); _tabSug=[]; _tabSugErr=""; _tabSugLoading=false; renderTabsView(); }
```

to (drop `savedAddTabMenuOpen=false;` only in this task — `impAddTabMenuOpen=false;` is Task 3's cleanup, left alone here so the file stays syntactically valid mid-plan):

```js
  if(t==="tabs"){ selMode=false; selPicks.clear(); impAddTabMenuOpen=false; savedSelMode=false; savedSelPicks.clear(); tabSelMode=false; tabSelPicks.clear(); _tabSug=[]; _tabSugErr=""; _tabSugLoading=false; renderTabsView(); }
```

- [ ] **Step 4: Mirror Step 3 into `pwa/index.html`**

Apply the identical edits at `pwa/index.html`'s mirrored lines: `renderSaved` at `:1363-1368`, the Saved bulk-add block at `:3701-3723`, `showTab` at `:1103`.

- [ ] **Step 5: Run the test file to verify it passes**

Run: `node tests/tabs-bulk-add.test.js`
Expected: PASS, all remaining + new cases, both `web` and `pwa`.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js`
Expected: green. (`tests/tag-editing-parity.test.js` isn't affected by this task — `renderSaved`/`openSavedBulkTagPicker` aren't in its `FNS` list — but confirm no other test references the deleted functions by name; if one does, update it the same way Step 1 updated `tabs-bulk-add.test.js`.)

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-bulk-add.test.js
git commit -m "$(cat <<'EOF'
Wire Saved's bulk toolbar to the shared "Apply tag…" picker

Replaces the Custom-Tab-only "Add to tab" dropdown with the full tag
picker (any existing tag, or create a new one) via openBulkTagPicker.
Removes the now-fully-unused addSavedPicksToTab/savedAddTabMenuHTML/
toggleSavedAddTabMenu/savedAddTabMenuOpen.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire the Imported section

**Files:**
- Modify: `web/index.html:1064` (`showTab`, finish the cleanup Task 2 left), `:2852` (`toggleSelMode`), `:3050-3051` (Imported toolbar, inside `renderImported`), `:3649-3667` (Imported bulk-add block — replace).
- Modify: `pwa/index.html` at the mirrored lines: `:1103`, `:2927`, the Imported toolbar inside `renderImported` (grep `toggleImpAddTabMenu` in `pwa/index.html` to find the current line — Task 2's edits may have shifted line numbers slightly upstream of this block; the function names anchor the location, not the raw numbers), `:3724-3742`.
- Test: `tests/tabs-bulk-add.test.js` (replace the now-obsolete Imported-side tests).

**Interfaces:**
- Consumes: `openBulkTagPicker` (Task 1); `imported` (global array), `selPicks`/`selMode` (existing globals), `Store.putCards`, `toast`, `renderImportedKeepFocus`.
- Produces: `function openImportedBulkTagPicker(ev)`.

- [ ] **Step 1: Write the failing tests**

In `tests/tabs-bulk-add.test.js`, remove the two now-obsolete tests: `"addImportedPicksToTab applies the tab's tag to every picked imported index and persists"` and `"impAddTabMenuHTML closes itself once the backing selection empties, even if left 'open'"`. Update `"Imported's existing select-mode bulk bar gained an Add-to-tab control"` — replace its body:

```js
  t(label + ": Imported's existing select-mode bulk bar gained an Add-to-tab control", () => {
    assert.match(src, /toggleImpAddTabMenu/);
    assert.match(src, /addImportedPicksToTab/);
  });
```

with:

```js
  t(label + ": Imported's select-mode bulk bar has an Apply-tag control, not the old tab-only menu", () => {
    const body = fn(src, "renderImported");
    assert.match(body, /openImportedBulkTagPicker\(event\)/);
    assert.match(body, /bulk-tag-btn/);
    assert.doesNotMatch(body, /toggleImpAddTabMenu/);
  });
```

Add these tests inside the loop:

```js
  t(label + ": openImportedBulkTagPicker opens the shared bulk picker with every picked imported item", () => {
    const importedArr = [{ tags: [] }, { tags: [] }, { tags: [] }];
    let openedWith = null;
    const factory = new Function(
      "imported", "selPicks", "openBulkTagPicker",
      fn(src, "openImportedBulkTagPicker") + "\nreturn openImportedBulkTagPicker;"
    );
    const openImportedBulkTagPicker = factory(importedArr, new Set([0, 2]), (items) => { openedWith = items; });
    openImportedBulkTagPicker({});
    assert.deepStrictEqual(openedWith, [importedArr[0], importedArr[2]]);
  });

  t(label + ": openImportedBulkTagPicker does nothing when nothing is picked", () => {
    let called = false;
    const factory = new Function(
      "imported", "selPicks", "openBulkTagPicker",
      fn(src, "openImportedBulkTagPicker") + "\nreturn openImportedBulkTagPicker;"
    );
    const openImportedBulkTagPicker = factory([], new Set(), () => { called = true; });
    openImportedBulkTagPicker({});
    assert.strictEqual(called, false);
  });

  t(label + ": openImportedBulkTagPicker's onDone persists, toasts, and exits select mode", () => {
    const importedArr = [{ tags: [] }];
    const calls = [];
    const factory = new Function(
      "imported", "selPicks", "selMode", "openBulkTagPicker", "Store", "toast", "renderImportedKeepFocus",
      fn(src, "openImportedBulkTagPicker") + "\nreturn openImportedBulkTagPicker;"
    );
    const openImportedBulkTagPicker = factory(
      importedArr, new Set([0]), true,
      (items, onDone) => onDone(1, "travel"),
      { putCards: (arr) => calls.push(["putCards", arr]) },
      (msg) => calls.push(["toast", msg]),
      () => calls.push("render")
    );
    openImportedBulkTagPicker({});
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "toast" && /travel/.test(c[1])));
    assert.ok(calls.includes("render"));
  });

  t(label + ": the old Custom-Tab-only Imported bulk-add mechanism is fully removed", () => {
    assert.strictEqual(extractFn(src, "addImportedPicksToTab"), null);
    assert.strictEqual(extractFn(src, "impAddTabMenuHTML"), null);
    assert.strictEqual(extractFn(src, "toggleImpAddTabMenu"), null);
    assert.doesNotMatch(src, /impAddTabMenuOpen/);
  });

  t(label + ": entering the Tabs view / leaving select mode no longer reference the deleted impAddTabMenuOpen", () => {
    assert.doesNotMatch(fn(src, "showTab"), /impAddTabMenuOpen/);
    assert.doesNotMatch(fn(src, "toggleSelMode"), /impAddTabMenuOpen/);
  });
```

- [ ] **Step 2: Run the test file to verify the new/changed tests fail**

Run: `node tests/tabs-bulk-add.test.js`
Expected: FAIL on the new/changed cases; the two removed-obsolete-test names are simply gone from the run.

- [ ] **Step 3: Edit `web/index.html`**

Change the Imported toolbar line (`web/index.html:3051`) from:

```js
           <button class="btn btn-ghost" onclick="toggleImpAddTabMenu()" ${selPicks.size?"":"disabled"}>Add to tab &#9662;</button>${impAddTabMenuHTML()}
```

to:

```js
           <button class="btn btn-ghost bulk-tag-btn" onclick="openImportedBulkTagPicker(event)" ${selPicks.size?"":"disabled"}>Apply tag…</button>
```

Replace the whole Imported bulk-add block (`web/index.html:3649-3667`, from `let impAddTabMenuOpen = false;` through the end of `addImportedPicksToTab`) — currently:

```js
let impAddTabMenuOpen = false;
function toggleImpAddTabMenu(){ impAddTabMenuOpen=!impAddTabMenuOpen; renderImportedKeepFocus(); }
function impAddTabMenuHTML(){
  // Also close if the backing selection emptied out from under it (e.g.
  // captureSelected()/fetchSelectedInfo() cleared selPicks) — otherwise the
  // menu would stay visibly open next to a now-disabled trigger, and clicking
  // a tab row would silently no-op.
  if(!impAddTabMenuOpen || !selPicks.size) return "";
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

with:

```js
function openImportedBulkTagPicker(ev){
  if(!selPicks.size) return;
  const items = [...selPicks].map(i=>imported[i]).filter(Boolean);
  openBulkTagPicker(items, (n,tag)=>{
    Store.putCards(imported);
    selMode=false; selPicks.clear();
    renderImportedKeepFocus();
    toast(n?("Tagged "+n+" card"+(n>1?"s":"")+" with "+tag):"Already tagged "+tag);
  }, ev);
}
```

Change `toggleSelMode` (`web/index.html:2852`) from:

```js
function toggleSelMode(){ selMode=!selMode; if(!selMode){ selPicks.clear(); impAddTabMenuOpen=false; } _openedSel.clear(); renderImported(); }
```

to:

```js
function toggleSelMode(){ selMode=!selMode; if(!selMode){ selPicks.clear(); } _openedSel.clear(); renderImported(); }
```

Finish `showTab`'s cleanup (`web/index.html:1064`, current text after Task 2's edit):

```js
  if(t==="tabs"){ selMode=false; selPicks.clear(); impAddTabMenuOpen=false; savedSelMode=false; savedSelPicks.clear(); tabSelMode=false; tabSelPicks.clear(); _tabSug=[]; _tabSugErr=""; _tabSugLoading=false; renderTabsView(); }
```

to:

```js
  if(t==="tabs"){ selMode=false; selPicks.clear(); savedSelMode=false; savedSelPicks.clear(); tabSelMode=false; tabSelPicks.clear(); _tabSug=[]; _tabSugErr=""; _tabSugLoading=false; renderTabsView(); }
```

- [ ] **Step 4: Mirror Step 3 into `pwa/index.html`**

Apply the identical edits at `pwa/index.html`'s mirrored locations (grep the function/variable names — `toggleImpAddTabMenu`, `impAddTabMenuHTML`, `addImportedPicksToTab`, `toggleSelMode`, the `if(t==="tabs")` line — since Task 2's edits mean the raw line numbers listed for `web/index.html` above no longer apply 1:1 to `pwa/index.html` until you've also applied Task 2 there).

- [ ] **Step 5: Run the test file to verify it passes**

Run: `node tests/tabs-bulk-add.test.js`
Expected: PASS, all remaining + new cases, both `web` and `pwa`.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-bulk-add.test.js
git commit -m "$(cat <<'EOF'
Wire Imported's bulk toolbar to the shared "Apply tag…" picker

Same pattern as Saved: replaces the Custom-Tab-only "Add to tab" dropdown
with the full tag picker. Removes the now-fully-unused
addImportedPicksToTab/impAddTabMenuHTML/toggleImpAddTabMenu/
impAddTabMenuOpen and its stale references in showTab/toggleSelMode.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire the open-Tab view

**Files:**
- Modify: `web/index.html:3594-3597` (`renderTabsView`'s `manageHtml`), and add a new `openTabBulkTagPicker` function near `removeTabPicksFromTab` (`:3921-3938`).
- Modify: `pwa/index.html` at the mirrored locations (grep `removeTabPicksFromTab`/`renderTabsView` — Task 2/3's edits will have shifted exact line numbers by this point).
- Test: `tests/tabs-bulk-add.test.js` (add new tests; nothing existing to remove here — the open-Tab view's "Remove from tab" bulk action is untouched).

**Interfaces:**
- Consumes: `openBulkTagPicker` (Task 1); `imported`/`saved` (global arrays), `tabSelPicks`/`tabSelMode` (existing globals, composite keys `"imported:<id>"`/`"saved:<id>"`), `Store.putCards`, `Store.putSaved`, `toast`, `renderTabsView`.
- Produces: `function openTabBulkTagPicker(ev)`.

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing loop in `tests/tabs-bulk-add.test.js`:

```js
  t(label + ": openTabBulkTagPicker resolves both imported: and saved: composite keys into live items", () => {
    const importedArr = [{ id: "i0", tags: [] }, { id: "i1", tags: [] }];
    const savedArr = [{ id: "s0", tags: [] }];
    let openedWith = null;
    const factory = new Function(
      "imported", "saved", "tabSelPicks", "openBulkTagPicker",
      fn(src, "openTabBulkTagPicker") + "\nreturn openTabBulkTagPicker;"
    );
    const tabSelPicks = new Set(["imported:i1", "saved:s0"]);
    const openTabBulkTagPicker = factory(importedArr, savedArr, tabSelPicks, (items) => { openedWith = items; });
    openTabBulkTagPicker({});
    assert.strictEqual(openedWith.length, 2);
    assert.ok(openedWith.includes(importedArr[1]));
    assert.ok(openedWith.includes(savedArr[0]));
  });

  t(label + ": openTabBulkTagPicker does nothing when nothing is picked", () => {
    let called = false;
    const factory = new Function(
      "imported", "saved", "tabSelPicks", "openBulkTagPicker",
      fn(src, "openTabBulkTagPicker") + "\nreturn openTabBulkTagPicker;"
    );
    const openTabBulkTagPicker = factory([], [], new Set(), () => { called = true; });
    openTabBulkTagPicker({});
    assert.strictEqual(called, false);
  });

  t(label + ": openTabBulkTagPicker's onDone persists both arrays, toasts, and exits tab-select mode", () => {
    const importedArr = [{ id: "i0", tags: [] }];
    const savedArr = [{ id: "s0", tags: [] }];
    const calls = [];
    const factory = new Function(
      "imported", "saved", "tabSelPicks", "tabSelMode", "openBulkTagPicker", "Store", "toast", "renderTabsView",
      fn(src, "openTabBulkTagPicker") + "\nreturn openTabBulkTagPicker;"
    );
    const openTabBulkTagPicker = factory(
      importedArr, savedArr, new Set(["imported:i0", "saved:s0"]), true,
      (items, onDone) => onDone(2, "travel"),
      { putCards: (arr) => calls.push(["putCards", arr]), putSaved: (arr) => calls.push(["putSaved", arr]) },
      (msg) => calls.push(["toast", msg]),
      () => calls.push("render")
    );
    openTabBulkTagPicker({});
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putSaved"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "toast" && /travel/.test(c[1])));
    assert.ok(calls.includes("render"));
  });

  t(label + ": the open-Tab view's select-mode toolbar has both Apply-tag and the existing Remove-from-tab actions", () => {
    const body = fn(src, "renderTabsView");
    assert.match(body, /openTabBulkTagPicker\(event\)/);
    assert.match(body, /bulk-tag-btn/);
    assert.match(body, /removeTabPicksFromTab\(\)/);   // existing action, must survive unchanged
  });
```

- [ ] **Step 2: Run the test file to verify the new tests fail**

Run: `node tests/tabs-bulk-add.test.js`
Expected: FAIL — `openTabBulkTagPicker` not found; `renderTabsView` doesn't yet call it.

- [ ] **Step 3: Edit `web/index.html`**

Change `renderTabsView`'s `manageHtml` (`web/index.html:3594-3597`) from:

```js
  const manageHtml = !t ? "" : (t.reserved ? "" : `<button class="btn btn-ghost" onclick="renameTabPrompt('${t.id}')">Rename</button><button class="btn btn-ghost" onclick="deleteTabPrompt('${t.id}')">Remove tab</button>`)
    + (t ? (tabSelMode
        ? `<button class="btn btn-ghost" onclick="removeTabPicksFromTab()" ${tabSelPicks.size?"":"disabled"}>Remove from tab (${tabSelPicks.size})</button><button class="btn btn-ghost" onclick="toggleTabSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleTabSelMode()">&#9745; Select</button><button class="btn btn-ghost" onclick="openTabSuggest()">&#10024; Suggest cards</button>`) : "");
```

to:

```js
  const manageHtml = !t ? "" : (t.reserved ? "" : `<button class="btn btn-ghost" onclick="renameTabPrompt('${t.id}')">Rename</button><button class="btn btn-ghost" onclick="deleteTabPrompt('${t.id}')">Remove tab</button>`)
    + (t ? (tabSelMode
        ? `<button class="btn btn-ghost bulk-tag-btn" onclick="openTabBulkTagPicker(event)" ${tabSelPicks.size?"":"disabled"}>Apply tag…</button><button class="btn btn-ghost" onclick="removeTabPicksFromTab()" ${tabSelPicks.size?"":"disabled"}>Remove from tab (${tabSelPicks.size})</button><button class="btn btn-ghost" onclick="toggleTabSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleTabSelMode()">&#9745; Select</button><button class="btn btn-ghost" onclick="openTabSuggest()">&#10024; Suggest cards</button>`) : "");
```

Add `openTabBulkTagPicker` immediately after `removeTabPicksFromTab` (`web/index.html:3921-3938`):

```js
function openTabBulkTagPicker(ev){
  if(!tabSelPicks.size) return;
  const items = [];
  tabSelPicks.forEach(key=>{
    const sep = key.indexOf(":");
    const scope = key.slice(0,sep), id = key.slice(sep+1);
    const it = scope==="saved" ? saved.find(c=>c&&c.id===id) : imported.find(c=>c&&c.id===id);
    if(it) items.push(it);
  });
  openBulkTagPicker(items, (n,tag)=>{
    Store.putCards(imported);
    Store.putSaved(saved);
    tabSelMode=false; tabSelPicks.clear();
    renderTabsView();
    toast(n?("Tagged "+n+" card"+(n>1?"s":"")+" with "+tag):"Already tagged "+tag);
  }, ev);
}
```

- [ ] **Step 4: Mirror Step 3 into `pwa/index.html`**

Apply the identical edits at `pwa/index.html`'s mirrored locations (grep `renderTabsView`/`removeTabPicksFromTab`).

- [ ] **Step 5: Run the test file to verify it passes**

Run: `node tests/tabs-bulk-add.test.js`
Expected: PASS, all cases, both `web` and `pwa`.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/tabs-bulk-add.test.js
git commit -m "$(cat <<'EOF'
Wire the open-Tab view's bulk toolbar to the shared "Apply tag…" picker

Adds openTabBulkTagPicker alongside the existing Remove-from-tab bulk
action (untouched) — resolves tabSelPicks' composite imported:/saved:
keys into live items, same pattern removeTabPicksFromTab already uses.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Final regression pass

**Files:**
- Modify (conditionally): `pwa/sw.js` (`SHELL_CACHE` bump — required, since Tasks 1-4 all touch `pwa/index.html`).
- No new source files.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing new — this task is verification only.

- [ ] **Step 1: Run the full test suite**

Run: `node tests/syntax-check.js && node tests/run.js`
Expected: green, zero failures, across every `*.test.js` file (not just the ones this plan touched).

- [ ] **Step 2: Confirm byte-parity for every function this plan touched**

Run: `node tests/tag-editing-parity.test.js && node tests/tabs-picker.test.js && node tests/tabs-bulk-add.test.js && node tests/bulk-tag-picker.test.js`
Expected: green. If anything drifted between `web/index.html` and `pwa/index.html` across the four tasks, it fails here.

- [ ] **Step 3: Bump `pwa/sw.js`'s `SHELL_CACHE`**

Read the current value in `pwa/sw.js` (search for `SHELL_CACHE`) and increment it by 1, matching this project's existing convention (every `pwa/index.html` edit needs this, or installed PWAs silently stay on stale code — see `docs/superpowers/specs/2026-08-01-bulk-retag-design.md`'s house rules via `.claude/skills/project-conventions`).

- [ ] **Step 4: Manual smoke test (document the checklist, do not skip)**

Since this feature is UI-heavy and this project's convention for `#tagPicker`/select-mode interactions is a documented manual check (not full DOM-execution unit tests — see `tests/tabs-bulk-add.test.js`'s header comment), write out this checklist as your final report rather than executing it yourself (no browser tooling in this task loop):

1. Saved: enable Select, pick 2+ cards, click "Apply tag…", pick an existing tag → toast shows the count, cards now carry that tag, select mode exits.
2. Saved: same, but type a brand-new tag and click Add → same result, tag is new.
3. Imported: same two checks as Saved.
4. Open a Custom Tab, enable Select, pick cards from a mix of Saved-origin and Imported-origin cards inside that tab, click "Apply tag…" → both persist correctly (check both cards keep the new tag after switching to Saved/Imported directly).
5. Open the tag picker in bulk mode and confirm: no "Select multiple" checkbox is shown; the pinned "Tabs" quick-section IS shown at the top, with every Custom Tab's chip rendered **without** a checkmark (bulk selection is heterogeneous, so there is no "have" state to show) and with the reserved AI tab **excluded** (bulk-applying `__ai_research__` would fire a research panel for every selected card); and clicking outside the picker (not on the "Apply tag…" button) still closes it normally. The Tabs section is load-bearing here — `allTags()` deliberately strips tab-backed tags out of the main scrollable list, so these chips are the only way to bulk-apply a tab's tag.
6. Saved: enable Select, pick 2+ cards, click "Apply tag…", and pick an existing **Custom Tab** chip from the pinned Tabs section → then open that tab and confirm those cards are now in it.
7. Confirm the picker does NOT flash-open-then-close when "Apply tag…" is clicked (the `.bulk-tag-btn` outside-click exclusion from Task 1).

- [ ] **Step 5: Commit (only if Step 3 changed `pwa/sw.js`)**

```bash
git add pwa/sw.js
git commit -m "$(cat <<'EOF'
Bump SHELL_CACHE for the bulk-retag feature's pwa/index.html edits

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
