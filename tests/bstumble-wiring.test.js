// tests/bstumble-wiring.test.js — source assertions for the renderer drain loop.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("pollBrowserStumble defined", /function pollBrowserStumble\(/.test(src));
ok("drain loop on a timer", /setInterval\(\s*pollBrowserStumble\s*,\s*\d+\s*\)/.test(src));
ok("drain loop gated on _booted", /pollBrowserStumble[\s\S]{0,120}?_booted/.test(src));
ok("thumbs-up maps to likes", /v\.vote\s*>\s*0[\s\S]{0,60}?likes\.push/.test(src));
ok("thumbs-down maps to hidden", /v\.vote\s*<\s*0[\s\S]{0,80}?hidden\.push/.test(src));
ok("rated pages are suppressed via shown", /shown\.push\(String\(v\.url\)\)/.test(src));
ok("feedback draining is independent of the AI fetch (COR-3)", /function drainBrowserFeedback\(/.test(src) && /async function pollBrowserStumble\(\)\{\s*drainBrowserFeedback\(\);/.test(src));
ok("vote title/category are coerced + length-capped (DAT-1/SEC-2)", /String\(v\.title[\s\S]{0,30}?\.slice\(0,200\)/.test(src) && /String\(v\.category[\s\S]{0,30}?\.slice\(0,80\)/.test(src));
ok("caps likes/hidden like the rest of the file", /likes\.length>60\) likes=likes\.slice\(-60\)/.test(src) && /hidden\.length>60\) hidden=hidden\.slice\(-60\)/.test(src));
ok("stumbleForInterests scopes the prompt", /buildPrompt\(\s*["']stumble["']\s*,\s*interestKeys\s*\)/.test(src));
ok("publishes categories", /ia_bstumble_cats/.test(src));
ok("republishes categories after settings load at boot (not just on edit)", /Store\.kvGet\(["']ia_settings["']\)[\s\S]{0,400}?rebuildCats\(\)/.test(src));

console.log("bstumble-wiring: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
