// tests/category-remove.test.js — base (built-in) categories can be removed too,
// tracked in S.hiddenBase, with a keep-at-least-one guard. web/index.html has no
// browser harness, so these are source assertions (repo convention).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("hiddenBase is initialized on S", /S\.hiddenBase\s*=\s*S\.hiddenBase\s*\|\|\s*\[\]/.test(src));
ok("rebuildCats filters out hidden base categories", /BASE_CATS\.filter\([\s\S]{0,60}?hiddenBase/.test(src));
ok("every category row renders a remove button (no c.custom gate)",
   /removeCategory\('\$\{c\.key\}'\)/.test(src) && !/c\.custom\?`<button class="act"[\s\S]{0,80}?removeCategory/.test(src));
ok("removeCategory hides a base category via hiddenBase", /S\.hiddenBase\s*=\s*\(S\.hiddenBase\|\|\[\]\)\.concat/.test(src));
ok("removeCategory still drops custom categories from extraCats", /S\.extraCats\s*=\s*S\.extraCats\.filter\(x=>x\.key!==key\)/.test(src));
ok("keep-at-least-one guard", /CATS\.length<=1[\s\S]{0,60}?return/.test(src));
ok("removed base categories are restorable (COR-7)", /function restoreCategory\(key\)/.test(src) && /S\.hiddenBase\s*=\s*\(S\.hiddenBase\|\|\[\]\)\.filter\(k=>k!==key\)/.test(src));
ok("settings renders a Restore control for hidden base categories (COR-7)", /restoreCategory\('\$\{c\.key\}'\)/.test(src));
ok("buildPrompt falls back to all categories when none active (COR-6)", /if\(!active\.length\)\s*active\s*=\s*CATS\.slice\(\)/.test(src));

console.log("category-remove: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
