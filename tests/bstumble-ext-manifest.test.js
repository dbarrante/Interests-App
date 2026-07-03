// tests/bstumble-ext-manifest.test.js — manifest wiring for browser stumble.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("version bumped to 4.50", m.version === "4.50");
ok("no default_popup (icon click fires onClicked)", !(m.action && m.action.default_popup));
ok("options_page set", m.options_page === "options.html");
ok("still has scripting + tabs + notifications perms", ["scripting","tabs","notifications"].every(p => m.permissions.includes(p)));

console.log("bstumble-ext-manifest: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
