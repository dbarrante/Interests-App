// tests/seen-suppression.test.js — a stumbled page shouldn't reappear for ~5 days.
// Source asserts (web/index.html has no browser harness) + the extension "seen" ping.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("SEEN_TTL is 5 days", /SEEN_TTL = 5\*24\*60\*60\*1000/.test(html));
ok("seenAt map + markSeen + pruneSeen exist", /let seenAt=\{\}/.test(html) && /function markSeen\(url\)/.test(html) && /function pruneSeen\(\)/.test(html));
ok("dropAlreadySaved skips pages seen within the window", /seenAt\[feedKey\(i\.url\)\] >= seenCut\) return false/.test(html));
ok("in-app deal (spoolTake) marks the page seen", /spool = spool\.filter\(p=>p\.url!==it\.url\);\s*markSeen\(it\.url\)/.test(html));
ok("browser feedback marks the page seen", /markSeen\(v\.url\)/.test(html));
ok("seenAt is persisted + loaded + pruned at boot", /save\("seen",seenAt\)/.test(html) && /seenAt = \(await load\("seen"/.test(html) && /pruneSeen\(\)/.test(html));
ok("extension sends a seen ping (vote:0) when a page is opened", /vote: \{ url: next\.url[\s\S]{0,40}?vote: 0 \}/.test(bg));

console.log("seen-suppression: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
