// tests/bstumble-options.test.js — the options page parses and wires interests.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const js = fs.readFileSync(path.join(__dirname, "..", "extension", "options.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "extension", "options.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("options.js parses", (() => { try { new vm.Script(js); return true; } catch (e) { return false; } })());
ok("html loads options.js", /options\.js/.test(html));
ok("fetches categories", /\/api\/categories/.test(js));
ok("scans the app port range", /345[6-9]|346[0-5]|3456/.test(js));
ok("saves selected interests", /ia_bstumble_interests/.test(js));

console.log("bstumble-options: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
