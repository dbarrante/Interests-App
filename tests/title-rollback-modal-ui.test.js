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
