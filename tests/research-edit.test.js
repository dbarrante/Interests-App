// tests/research-edit.test.js — Task 3: editing an already-generated article's text
// in place (a plain textarea over research.article.text, per the design spec — no
// version history, no regeneration involved). Mirrors impEditSave's edit-toggle
// shape but scoped to just the article field.
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
  t(label + ": toggleArticleEdit adds/removes the scope:id key, discards the draft on Cancel, and re-renders", () => {
    const calls = [];
    const factory = new Function(
      "_articleEditing", "_articleDrafts", "renderTabsView",
      fn(src, "toggleArticleEdit") + "\nreturn toggleArticleEdit;"
    );
    const editing = new Set();
    const drafts = { "imported:i0": "some in-progress text" };
    const toggleArticleEdit = factory(editing, drafts, ()=>calls.push("render"));
    toggleArticleEdit("imported", "i0");
    assert.ok(editing.has("imported:i0"));
    toggleArticleEdit("imported", "i0");   // Cancel
    assert.ok(!editing.has("imported:i0"));
    assert.ok(!("imported:i0" in drafts), "Cancel must discard the draft, not leave it to leak into the next edit session");
    assert.strictEqual(calls.length, 2);
  });

  t(label + ": saveArticleEdit writes the textarea's trimmed value, persists, exits edit mode, clears the draft", () => {
    const impArr = [{ id: "i0", research: { article: { text: "old text", sources: [], generatedAt: 1 }, qa: [] } }];
    const calls = [];
    const editing = new Set(["imported:i0"]);
    const drafts = { "imported:i0": "  new edited text  " };
    const factory = new Function(
      "imported", "saved", "_articleEditing", "_articleDrafts", "Store", "renderTabsView", "toast", "document",
      fn(src, "_researchCard") + "\n" + fn(src, "saveArticleEdit") + "\nreturn saveArticleEdit;"
    );
    const fakeTextarea = { value: "  new edited text  " };
    const fakeDocument = { getElementById: (id) => id === "artEdit_imported_i0" ? fakeTextarea : null };
    const saveArticleEdit = factory(
      impArr, [], editing, drafts,
      { putCards: (arr)=>calls.push(["putCards",arr]), putSaved: ()=>{} },
      ()=>calls.push("render"), ()=>calls.push("toast"), fakeDocument
    );
    saveArticleEdit("imported", "i0");
    assert.strictEqual(impArr[0].research.article.text, "new edited text");
    assert.strictEqual(impArr[0].research.article.sources.length, 0);   // untouched
    assert.ok(!editing.has("imported:i0"));
    assert.ok(!("imported:i0" in drafts), "a successful save must clear the draft too");
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.includes("render"));
  });

  t(label + ": saveArticleEdit refuses an empty/whitespace-only edit and leaves the article untouched", () => {
    const impArr = [{ id: "i0", research: { article: { text: "old text", sources: [], generatedAt: 1 }, qa: [] } }];
    const editing = new Set(["imported:i0"]);
    const factory = new Function(
      "imported", "saved", "_articleEditing", "_articleDrafts", "Store", "renderTabsView", "toast", "document",
      fn(src, "_researchCard") + "\n" + fn(src, "saveArticleEdit") + "\nreturn saveArticleEdit;"
    );
    const fakeDocument = { getElementById: () => ({ value: "   " }) };
    const saveArticleEdit = factory(impArr, [], editing, {}, { putCards: ()=>{}, putSaved: ()=>{} }, ()=>{}, ()=>{}, fakeDocument);
    saveArticleEdit("imported", "i0");
    assert.strictEqual(impArr[0].research.article.text, "old text");
    assert.ok(editing.has("imported:i0"), "edit mode must stay open on a rejected save");
  });

  t(label + ": researchPanelHTML renders a textarea (wired to save its live value into _articleDrafts) and Save/Cancel when editing", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(["imported:i0"]), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: { text: "Editable body.", sources: [], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /<textarea id="artEdit_imported_i0" oninput="_articleDrafts\['imported:i0'\]=this\.value">Editable body\.<\/textarea>/);
    assert.match(out, /saveArticleEdit\('imported','i0'\)/);
    assert.match(out, /toggleArticleEdit\('imported','i0'\)/);
    assert.doesNotMatch(out, /Regenerate/);   // view-mode-only actions must not also render
  });

  t(label + ": researchPanelHTML's view mode (not editing) offers an Edit button alongside Copy/Regenerate", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: { text: "Body.", sources: [], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /toggleArticleEdit\('imported','i0'\)/);
    assert.match(out, />Edit</);
    assert.doesNotMatch(out, /<textarea/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
