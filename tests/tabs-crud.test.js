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

  t(label + ": cardHasTag matches case-insensitively — createTab lowercases a tab's tag, but a card's actual tag chip may keep whatever case was typed/imported", () => {
    const api = loadTabs(src, {});
    assert.strictEqual(api.cardHasTag({ tags: ["STL Files"] }, "stl files"), true);
    assert.strictEqual(api.cardHasTag({ tags: ["stl files"] }, "STL Files"), true);
  });

  t(label + ": tabCardCount counts matching cards across BOTH imported and saved, tolerating null holes", () => {
    const importedArr = [{ tags: ["stl files"] }, { tags: ["other"] }];
    const savedArr = [{ tags: ["stl files"] }, { tags: [] }, null];   // bulk-remove leaves null holes in `saved`
    const api = loadTabs(src, { imported: importedArr, saved: savedArr });
    assert.strictEqual(api.tabCardCount("stl files"), 2);
  });

  t(label + ": allTags() excludes the reserved AI_TAB_TAG from its output", () => {
    const factory = new Function(
      "imported", "saved", "tabs", "AI_TAB_TAG",
      fn(src, "allTags") + "\nreturn allTags;"
    );
    const allTags = factory(
      [{ tags: ["3d printing", "__ai_research__"] }], [{ tags: ["stl files"] }], [], "__ai_research__"
    );
    const out = allTags();
    assert.ok(!out.includes("__ai_research__"));
    assert.ok(out.includes("3d printing"));
    assert.ok(out.includes("stl files"));
  });

  t(label + ": allTags() also excludes a NON-reserved tab's tag — it's shown in the picker's pinned Tabs section instead, not duplicated in the freeform list", () => {
    const factory = new Function(
      "imported", "saved", "tabs", "AI_TAB_TAG",
      fn(src, "allTags") + "\nreturn allTags;"
    );
    const allTags = factory(
      [{ tags: ["3d printing", "stl files"] }], [], [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], "__ai_research__"
    );
    const out = allTags();
    assert.ok(!out.includes("stl files"));
    assert.ok(out.includes("3d printing"));
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
