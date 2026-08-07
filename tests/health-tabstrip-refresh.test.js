// tests/health-tabstrip-refresh.test.js — Library Health's tab-strip count
// badges (failed/nolink/titles) only ever re-rendered on openHealth()/
// healthSwitch(); every in-tab action that actually changes one of those
// counts (mark-done, remove, apply/commit a title) re-rendered #healthList
// but never re-ran healthTabStripHTML(), so the "(N)" badges sat stale for
// the rest of the session (2026-08-07 report: "the numbers next to the tabs
// aren't updating"). refreshHealthTabStrip() is a targeted outerHTML swap of
// just the .health-tabs strip, called alongside the existing list refresh at
// every count-changing site.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": refreshHealthTabStrip swaps only the .health-tabs strip (not the whole health body)", () => {
    const body = extractFn(src, "refreshHealthTabStrip");
    assert.ok(body, "refreshHealthTabStrip not found");
    assert.match(body, /querySelector\("#healthBody \.health-tabs"\)/);
    assert.match(body, /outerHTML\s*=\s*healthTabStripHTML\(\)/);
  });

  const sites = [
    ["markFailDone", "marks selected failed cards done (changes the failed count)"],
    ["removeFailSelected", "removes selected failed cards (changes the failed count)"],
    ["groomNoLink", "removes selected no-link cards (changes the nolink count)"],
    ["applyTitleSuggestions", "bulk-applies title suggestions (changes the titles count)"],
    ["commitOneTitleSuggestion", "commits one title on Enter (changes the titles count)"],
  ];
  for (const [fn, desc] of sites) {
    t(label + ": " + fn + " refreshes the tab-strip badges after " + desc, () => {
      const body = extractFn(src, fn);
      assert.ok(body, fn + " not found");
      assert.match(body, /refreshHealthTabStrip\(\)/, fn + " must call refreshHealthTabStrip() so its count change is visible immediately");
    });
  }

  // Staging-only actions (nothing committed yet) must NOT need a tab-strip
  // refresh — the flagged/failed/nolink counts are unaffected until Apply or
  // Enter actually commits. Negative check keeps the fix scoped to real
  // count changes, not sprinkled everywhere defensively.
  t(label + ": retryTitleSuggestion (stages an AI suggestion, doesn't commit) does not need a tab-strip refresh", () => {
    const body = extractFn(src, "retryTitleSuggestion");
    assert.ok(body, "retryTitleSuggestion not found");
    assert.ok(!/refreshHealthTabStrip\(\)/.test(body), "staging a suggestion doesn't change any tab-strip count");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
