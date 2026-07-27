// tests/title-issues-resolved.test.js
//
// The Title-issues panel is a to-do list, not a live quality report: once the
// USER has set a card's title (applied a suggestion, or hand-edited it), that
// card must leave the list and stay gone — even if the new title is one the
// generic-title heuristic would otherwise flag (e.g. shorter than 25 chars, the
// most common case: "Braided Pesto Bread" is 19).
//
// isGenericTitle only ever sees the string, so it cannot tell a title the user
// deliberately chose from an identical one a capture produced. The fix is a
// stored `titleSet` flag set by the user-driven write paths and honoured by
// flaggedTitleCards. This test proves both halves BEHAVIOURALLY (running the
// real extracted flaggedTitleCards against the real isGenericTitle), plus a
// structural check that every user title-write path stamps the flag, mirrored
// across web/ and pwa/.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const webHtml = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");
const { isGenericTitle } = require(path.join(__dirname, "..", "web", "lib", "capture-state.js"));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

// Build a live flaggedTitleCards() from the real source, with imported/saved and
// isGenericTitle injected (the three globals it closes over).
function buildFlagged(src, imported, saved) {
  const fnSrc = extractFn(src, "flaggedTitleCards");
  if (!fnSrc) throw new Error("could not extract flaggedTitleCards");
  const factory = new Function("imported", "saved", "isGenericTitle", fnSrc + "\nreturn flaggedTitleCards();");
  return factory(imported, saved, isGenericTitle);
}

for (const [label, src] of [["web", webHtml], ["pwa", pwaHtml]]) {
  t(label + ": a short, un-set title IS flagged (the mechanism the bug rides on)", () => {
    // 19 chars, perfectly descriptive, but under the 25-char heuristic — this is
    // exactly the title a user sets that used to keep the card in the list.
    const flagged = buildFlagged(src, [{ id: "a", url: "https://x/a", title: "Braided Pesto Bread" }], []);
    assert.strictEqual(flagged.length, 1, "a short title with no titleSet flag must still be flagged");
    assert.strictEqual(flagged[0].card.id, "a");
  });

  t(label + ": a long descriptive title is NOT flagged (drops out on its own)", () => {
    const flagged = buildFlagged(src, [{ id: "b", url: "https://x/b", title: "How to braid a pesto bread at home, step by step" }], []);
    assert.strictEqual(flagged.length, 0, "a clearly-descriptive title never needed the flag");
  });

  t(label + ": a user-set SHORT title is excluded — the reported bug", () => {
    // Same 19-char title, now marked titleSet:true because the user chose it.
    // Before the fix flaggedTitleCards ignored the flag and this card stayed.
    const flagged = buildFlagged(src, [{ id: "c", url: "https://x/c", title: "Braided Pesto Bread", titleSet: true }], []);
    assert.strictEqual(flagged.length, 0, "a title the user set must leave the list even when short");
  });

  t(label + ": titleSet exclusion applies to saved cards too, not just imported", () => {
    const flagged = buildFlagged(src, [], [{ id: "d", url: "https://x/d", title: "Cats", titleSet: true }]);
    assert.strictEqual(flagged.length, 0, "a user-set saved-card title must also be excluded");
  });

  // --- structural: every user title-write path stamps titleSet -----------------
  const writePaths = [
    ["applyTitleSuggestions", /card\.title\s*=\s*val\.slice\(0,250\);\s*card\.titleSet\s*=\s*true;/],
    ["cardEditSave", /it\.title\s*=\s*title\.slice\(0,250\);\s*it\.titleSet\s*=\s*true;/],
    ["impEditSave", /if\(title\)\{\s*it\.title\s*=\s*title;\s*it\.titleSet\s*=\s*true;\s*\}/],
  ];
  for (const [fnName, re] of writePaths) {
    t(label + ": " + fnName + " stamps titleSet when the user writes a title", () => {
      const fnSrc = extractFn(src, fnName);
      assert.ok(fnSrc, fnName + " not found");
      assert.match(fnSrc, re, fnName + " must set titleSet=true on the card it writes");
    });
  }

  t(label + ": flaggedTitleCards honours the titleSet flag", () => {
    const fnSrc = extractFn(src, "flaggedTitleCards");
    assert.match(fnSrc, /!c\.titleSet/, "flaggedTitleCards must skip cards whose title the user has set");
  });
}

t("flaggedTitleCards is byte-identical between web and pwa (binding parity)", () => {
  assert.strictEqual(extractFn(webHtml, "flaggedTitleCards"), extractFn(pwaHtml, "flaggedTitleCards"),
    "flaggedTitleCards has drifted between web/ and pwa/");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
