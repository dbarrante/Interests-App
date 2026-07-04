// tests/collapsible-sections.test.js — Interest categories / Your profile / What I've
// learned are collapsible in Settings, persisted per-device. Source asserts (no browser harness).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("collapsed CSS hides everything but the h3", /\.sec\.collapsed>\*:not\(h3\)\{display:none\}/.test(src));
ok("chevron rotates when collapsed", /\.sec\.collapsible>h3::before/.test(src) && /\.sec\.collapsed>h3::before\{transform:rotate/.test(src));
ok("toggleSec toggles + persists to localStorage", /function toggleSec\(h\)[\s\S]{0,220}?classList\.toggle\("collapsed"\)[\s\S]{0,160}?ia_collapsed/.test(src));
ok("restoreCollapsed applies saved state per data-sec", /function restoreCollapsed\(\)[\s\S]{0,200}?\.sec\.collapsible\[data-sec\][\s\S]{0,80}?classList\.toggle\("collapsed"/.test(src));
ok("restoreCollapsed is called when Settings renders", /renderLearned\(\);\s*restoreCollapsed\(\);/.test(src));
["categories", "profile", "learned"].forEach(k => {
  ok(`'${k}' section is collapsible + wired`, new RegExp(`class="sec collapsible" data-sec="${k}">\\s*<h3 onclick="toggleSec\\(this\\)"`).test(src));
});

console.log("collapsible-sections: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
