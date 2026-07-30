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
    assert.match(out, /class="tg tg-add"/);
    assert.match(out, /class="tg tg-auto"/);
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
