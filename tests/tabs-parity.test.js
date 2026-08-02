// tests/tabs-parity.test.js — every pure-logic function the Custom Tabs feature
// introduced (Tasks 1-6) must be byte-identical between web/index.html and
// pwa/index.html — there is no platform-specific reason for it to differ.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

const FNS = [
  "cardHasTag", "tabCardCount", "bootstrapAiTab", "createTab", "renameTab", "deleteTab",
  "allTags", "tagRow", "aiSuggestTags",
  "tabsFilteredList", "openTab", "newTabPrompt", "renameTabPrompt", "deleteTabPrompt", "renderTabsView",
  "tabPickerRows", "renderTagPicker",
  "bulkAddTag", "toggleSavedSelMode", "toggleSavedPick", "openSavedBulkTagPicker",
  "toggleSelMode", "openImportedBulkTagPicker", "cardHTML", "renderSaved",
  "toggleTabSelMode", "toggleTabPick", "tabCardWrapper", "removeTabPicksFromTab", "openTabBulkTagPicker",
  "aiSuggestCardsForTab", "openTabSuggest", "tabSugToggleSel", "tabSugRemove", "tabSugAccept", "tabSuggestPanelHTML",
  "showTab",
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
