// tests/bstumble-prompt.test.js — source assertion that buildPrompt scopes to
// interestKeys. web/index.html has no browser harness (see tests/README.md), so
// we assert on the source the way tests/capture-wiring.test.js does.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("buildPrompt takes interestKeys", /function buildPrompt\(mode,\s*interestKeys\)/.test(src));
ok("buildPrompt filters active categories by interestKeys",
   /interestKeys[\s\S]{0,200}?filter\([\s\S]{0,80}?\.has\(/.test(src));

console.log("bstumble-prompt: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
