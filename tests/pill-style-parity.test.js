// tests/pill-style-parity.test.js — the category/tag pills in Stumble and Saved
// use the SAME small .tg style/size as the Imported tag sidebar (not the chunky
// .catpill). Source asserts (no browser harness).
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

// The shared small-pill baseline (this is the Imported tag size the others must match).
ok(".tg baseline is the small 10.5px / 2px 9px pill", /\.tg\{[^}]*font-size:10\.5px[^}]*padding:2px 9px[^}]*\}/.test(src));
ok(".tg.on active style exists", /\.tg\.on\{[^}]*background:var\(--accent\)[^}]*\}/.test(src));

// Stumble category filters render as .tg spans (matching Imported tags), NOT .catpill.
ok("renderCatBar has a stumble branch using .tg pills", /curTab==="stumble"[\s\S]{0,160}?<span class="tg/.test(src));
ok("stumble branch does not fall back to .catpill", !/curTab==="stumble"[\s\S]{0,160}?class="catpill/.test(src));

// Saved category sidebar (v1.12.14) uses .tg with counts, mirroring the tag sidebar.
ok("catSideHTML uses .tg pills with a count <b>", /function catSideHTML\(\)[\s\S]{0,600}?class="tg[\s\S]{0,120}?<b>/.test(src));

console.log("pill-style-parity: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
