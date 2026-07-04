// tests/dislike-blocklist.test.js — source asserts for the thumbs-down "never show
// again" blocklist + the settings-sync updatedAt stamp (web/index.html, no browser harness).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

// Thumbs-down blocklist
ok("disliked global exists", /let disliked=\[\]/.test(src));
ok("disliked is persisted", /save\("disliked",\s*disliked\)/.test(src));
ok("disliked is loaded at boot", /disliked = \(await load\("disliked",\s*\[\]\)\)/.test(src));
ok("dropAlreadySaved HARD-filters disliked urls", /nope\.has\(feedKey\(i\.url\)\)\)\s*return false/.test(src) && /disliked\|\|\[\]/.test(src));
ok("in-app 👎 records the url in disliked", /!up && it\.url[\s\S]{0,80}?disliked\.push\(feedKey\(it\.url\)\)/.test(src));
ok("browser 👎 records the url in disliked", /disliked\.push\(feedKey\(v\.url\)\)/.test(src));
ok("disliked is bounded", /disliked\.length>3000\) disliked=disliked\.slice\(-3000\)/.test(src));
ok("memory panel shows 'Never show again' with un-block", /Never show again/.test(src) && /removeLearned\('disliked'/.test(src));
ok("removeLearned handles the disliked list", /kind==="disliked" \? disliked/.test(src));

// Settings-sync stamp
ok("settings stamp only fires on real content change (not every boot save)", /_lastSettingsJson/.test(src) && /j !== _lastSettingsJson[\s\S]{0,90}?ia_settings_updatedAt/.test(src));
ok("boot baselines the settings content before its re-save", /_lastSettingsJson = JSON\.stringify\(S\)[\s\S]{0,60}?save\("settings", S\)/.test(src));

console.log("dislike-blocklist: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
