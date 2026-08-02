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
  "autoRemoveSug", "autoAccept", "canonicalTag", "tagRow", "tabPickerRows", "bulkAddTag",
  "openBulkTagPicker", "bulkTagPickerApply",
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
