// tests/ux-loop06.test.js — regression asserts for the LOOP-06 UX fixes.
// web/index.html has no browser harness → source assertions (repo convention).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

// UX-1: primary/accent FILLS use --accent-strong (AA-safe white text) in both themes.
ok("UX-1: --accent-strong defined in light :root", /:root\{[\s\S]*?--accent-strong:#c2410c/.test(src));
ok("UX-1: --accent-strong defined in html.dark (diverges from bright --accent)", /html\.dark\{[\s\S]*?--accent-strong:#c2410c/.test(src));
ok("UX-1: primary button fill uses --accent-strong", /\.btn-primary\{background:var\(--accent-strong\)/.test(src));
ok("UX-1: dark active tab fill uses --accent-strong", /html\.dark \.tab\.active\{background:var\(--accent-strong\)/.test(src));

// UX-2: memory-transparency panel — view + per-item delete of learned signals.
ok("UX-2: #learnedList panel present in settings", /id="learnedList"/.test(src));
ok("UX-2: renderLearned renders likes/hidden/clicks", /function renderLearned\(/.test(src) && /arr:likes/.test(src) && /arr:hidden/.test(src) && /arr:clicks/.test(src));
ok("UX-2: removeLearned splices + persists", /function removeLearned\(kind, idx\)[\s\S]{0,200}?arr\.splice\(idx,1\)[\s\S]{0,40}?persistAll\(\)/.test(src));
ok("UX-2: renderLearned is wired into renderSettings", /renderLearned\(\);/.test(src));

// UX-3: phone-width breakpoint so nothing forces horizontal page scroll.
ok("UX-3: <=640px breakpoint added", /@media\(max-width:640px\)/.test(src));

// UX-4: boot failure shows a banner instead of a silent empty screen.
ok("UX-4: showBootError banner exists", /function showBootError\(/.test(src));
ok("UX-4: bootData rejection routes to the banner", /bootData\(\)\.catch\(showBootError\)/.test(src));

// UX-5: Imported detail view (ig-g1) no longer forces horizontal overflow on
// narrow mobile viewports. Root cause: img.th's base rule sets flex-shrink:0
// (line ~367, shared with every view mode), and the g1-specific override
// (hardcoded width:320px;height:320px) never re-enabled shrinking or capped
// the width — so the image refused to shrink below 320px even when the
// .imp-card flex row had far less than that available, forcing the whole
// card past the screen edge. Fixed by letting it shrink and cap at 100% of
// its flex space, giving the text sibling min-width:0 so it can shrink too
// (a flex item's default min-width:auto blocks shrinking to fit long
// unbroken content), and adding overflow-x:hidden as a defense-in-depth
// backstop against any other unknown overflow source.
// Anchored to line-start (no leading whitespace) so this matches only the
// base rule, not the indented @media(max-width:640px) override of the same
// selector (which intentionally sets just width:100% for the stacked layout).
const ig1ImgRuleMatch = src.match(/^\.ig-g1 \.imp-card img\.th\{([^}]*)\}/m);
ok("UX-5: .ig-g1 img.th rule exists", !!ig1ImgRuleMatch);
const ig1ImgRule = ig1ImgRuleMatch ? ig1ImgRuleMatch[1] : "";
ok("UX-5: .ig-g1 img.th caps at 100% of its available space", /max-width:100%/.test(ig1ImgRule));
ok("UX-5: .ig-g1 img.th re-enables shrink (overrides the inherited flex-shrink:0)", /flex-shrink:1/.test(ig1ImgRule));
ok("UX-5: .ig-g1 img.th keeps a square aspect ratio while shrinking", /aspect-ratio:1\/1/.test(ig1ImgRule) && /height:auto/.test(ig1ImgRule));
ok("UX-5: imp-card's text sibling has min-width:0 so it can shrink/wrap too", /\$\{icon\}\s*<div style="flex:1;min-width:0">/.test(src));
ok("UX-5: html/body has an overflow-x backstop against page-level horizontal overflow", /(?:html|body)[^{]*\{[^}]*overflow-x:hidden/.test(src));

console.log("ux-loop06: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
