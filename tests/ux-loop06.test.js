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

console.log("ux-loop06: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
