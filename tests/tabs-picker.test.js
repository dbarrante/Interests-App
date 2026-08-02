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
    "imported", "saved", "_tagPickScope", "_tagPickIdx", "_tagPickId", "tabs", "esc", "_bulkTagItems",
    body + "\nreturn tabPickerRows;"
  );
  const escFn = (s) => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  return factory(state.imported||[], state.saved||[], state.scope||"imported", state.idx??-1, state.id??null, state.tabs||[], escFn, state.bulkTagItems||null);
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

  // Bulk mode: there is no single "current card", so the pinned Tabs section is built
  // from `tabs` alone — with no checked state, and without the reserved AI tab. It must
  // still render, because allTags() strips tab-backed tags out of the main list below.
  t(label + ": tabPickerRows renders a tab chip in bulk mode, unchecked, with no current card at all", () => {
    const tabsList = [{id:"1",name:"STL files",tag:"stl files",reserved:false}];
    // no imported/saved arrays and idx -1: _tagPickItem() would find nothing, yet the chip must still render
    const tabPickerRows = loadTabPickerRows(src, { tabs: tabsList, bulkTagItems: [{tags:["stl files"]}, {tags:[]}] });
    const out = tabPickerRows();
    assert.match(out, /data-tag="stl files"/);
    assert.doesNotMatch(out, /tp-row tp-tab on/);
    assert.doesNotMatch(out, /&#10003;/);
  });

  t(label + ": tabPickerRows hides the reserved AI tab in bulk mode", () => {
    const tabsList = [{id:"1",name:"STL files",tag:"stl files",reserved:false}, {id:"2",name:"AI",tag:"__ai_research__",reserved:true}];
    const tabPickerRows = loadTabPickerRows(src, { tabs: tabsList, bulkTagItems: [{tags:[]}] });
    const out = tabPickerRows();
    assert.match(out, /data-tag="stl files"/);
    assert.doesNotMatch(out, /data-tag="__ai_research__"/);
  });

  t(label + ": tabPickerRows returns an empty string in bulk mode when there are no tabs at all", () => {
    const tabPickerRows = loadTabPickerRows(src, { tabs: [], bulkTagItems: [{tags:[]}] });
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
