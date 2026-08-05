// tests/quote-escaping-audit.test.js — esc() escapes &<> but not a literal
// '"', so any `attr="${esc(freeText)}"` site is vulnerable to attribute
// breakout when the underlying string contains a quote (worst case: a value
// that STARTS with a quote collapses the attribute to empty — the exact bug
// reported and fixed for the edit-modal title field, see
// tests/card-edit-wiring.test.js). This file structurally guards the other
// user-text attribute sites that share the same shape, so a future edit to
// any of these lines can't silently drop the `.replace(/"/g,"&quot;")` guard.
// Full functional (sandboxed-render) coverage lives in card-edit-wiring.test.js
// for edTitle/edTags and title-rollback-modal-ui.test.js for edPickTitleChoice's
// data-title — these four are lower-traffic call sites where a structural
// source check is proportionate.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": Imported search box escapes quotes in its value attribute", () => {
    assert.match(src,
      /placeholder="Search \$\{imported\.length\} imported items…" value="\$\{esc\(impQuery\)\.replace\(\/"\/g,"&quot;"\)\}"/,
      "impQuery must be quote-escaped, or a search containing \" truncates/empties the box");
  });
  t(label + ": tab rename/new-tab input escapes quotes in its value attribute", () => {
    assert.match(src,
      /id="tabNameInput" type="text" maxlength="60" placeholder="Tab name" value="\$\{esc\(currentName\|\|""\)\.replace\(\/"\/g,"&quot;"\)\}"/,
      "currentName must be quote-escaped, or renaming a tab whose name contains \" breaks the prefill");
  });
  t(label + ": AI-research Q&A draft input escapes quotes in its value attribute", () => {
    assert.match(src,
      /placeholder="Ask a question about this…" value="\$\{esc\(qaDraft\)\.replace\(\/"\/g,"&quot;"\)\}"/,
      "qaDraft must be quote-escaped, or a question containing \" loses its draft text on re-render");
  });
  t(label + ": Title-issues suggestion box escapes quotes in its value attribute", () => {
    assert.match(src,
      /class="title-suggest-input" value="\$\{esc\(suggestion\)\.replace\(\/"\/g,"&quot;"\)\}"/,
      "suggestion must be quote-escaped, or an AI/manual suggestion containing \" truncates/empties the box");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
