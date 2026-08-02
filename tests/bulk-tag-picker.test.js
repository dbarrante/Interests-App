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

  // A Custom Tab IS just a tag, but allTags() deliberately excludes tab-backed tags
  // from the main scrollable list — so if the pinned Tabs section were hidden in bulk
  // mode, a tab's tag could not be bulk-applied at all. It must render, unchecked
  // (the selection is heterogeneous, so there is no meaningful "have" state).
  function bulkTabPickerRows(src, tabsList, items) {
    const body = fn(src, "tabPickerRows");
    const factory = new Function(
      "_bulkTagItems", "_tagPickItem", "tabs", "esc",
      body + "\nreturn tabPickerRows;"
    );
    return factory(items, () => { throw new Error("_tagPickItem must not be called in bulk mode"); }, tabsList, escFn)();
  }

  t(label + ": tabPickerRows renders the pinned Tabs chips in bulk mode (a tab tag is otherwise unreachable — allTags() excludes it)", () => {
    const tabsList = [{ id: "1", name: "STL files", tag: "stl files", reserved: false }];
    const out = bulkTabPickerRows(src, tabsList, [{ tags: [] }, { tags: [] }]);
    assert.match(out, /data-tag="stl files"/);
    assert.match(out, /tp-tabs-label/);
  });

  t(label + ": tabPickerRows shows no checked state on bulk tab chips even when every selected item already carries the tab's tag", () => {
    const tabsList = [{ id: "1", name: "STL files", tag: "stl files", reserved: false }];
    const out = bulkTabPickerRows(src, tabsList, [{ tags: ["stl files"] }, { tags: ["STL Files"] }]);
    assert.match(out, /data-tag="stl files"/);
    assert.doesNotMatch(out, /tp-row tp-tab on/);
    assert.doesNotMatch(out, /&#10003;/);
  });

  t(label + ": tabPickerRows omits the reserved AI tab in bulk mode (bulk-applying it would fire research for every card)", () => {
    const tabsList = [
      { id: "1", name: "STL files", tag: "stl files", reserved: false },
      { id: "2", name: "AI", tag: "__ai_research__", reserved: true },
    ];
    const out = bulkTabPickerRows(src, tabsList, [{ tags: [] }]);
    assert.match(out, /data-tag="stl files"/);
    assert.doesNotMatch(out, /data-tag="__ai_research__"/);
    assert.doesNotMatch(out, /&#129302;/);
  });

  t(label + ": tabPickerRows returns an empty string in bulk mode when the only tab is the reserved AI tab", () => {
    const tabsList = [{ id: "2", name: "AI", tag: "__ai_research__", reserved: true }];
    assert.strictEqual(bulkTabPickerRows(src, tabsList, [{ tags: [] }]), "");
  });

  t(label + ": tabPickerRows returns an empty string in bulk mode when there are no tabs at all", () => {
    assert.strictEqual(bulkTabPickerRows(src, [], [{ tags: [] }]), "");
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
