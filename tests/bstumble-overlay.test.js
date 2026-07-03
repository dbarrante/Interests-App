// tests/bstumble-overlay.test.js — the injected overlay parses and wires its buttons.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "overlay.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("parses as valid JS", (() => { try { new vm.Script(src); return true; } catch (e) { return false; } })());
ok("idempotent guard (won't double-inject)", /ia-bstumble-bar|__iaBstumbleInjected/.test(src));
ok("sends thumbs-up vote", /action:\s*["']bstumbleVote["'][\s\S]{0,40}?vote:\s*1/.test(src));
ok("sends thumbs-down vote", /vote:\s*-1/.test(src));
ok("sends save action", /action:\s*["']bstumbleSave["']/.test(src));
ok("sends next action", /action:\s*["']bstumbleNext["']/.test(src));

console.log("bstumble-overlay: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
