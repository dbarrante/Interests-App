// tests/bstumble-ext-bg.test.js — background wiring for browser stumble (source assertions).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("parses as valid JS", (() => { try { new vm.Script(src); return true; } catch (e) { return false; } })());
ok("handles icon click", /chrome\.action\.onClicked\.addListener/.test(src));
ok("posts a stumble request", /\/api\/bstumble\/request/.test(src));
ok("drains results", /\/api\/bstumble\/results/.test(src));
ok("posts feedback", /\/api\/bstumble\/feedback/.test(src));
ok("injects the overlay", /overlay\.js/.test(src));
ok("reuses the stumble tab", /bstumbleTabId|_stumbleTabId/.test(src));
ok("adds Remove-from-Interests menu item", /removeFromInterests/.test(src));
ok("handles overlay messages", /bstumbleVote[\s\S]{0,400}?bstumbleNext|bstumbleNext[\s\S]{0,400}?bstumbleVote/.test(src));
ok("votes carry the stumbled page's category", /BSTUMBLE_CURRENT_KEY/.test(src) && /category[\s\S]{0,120}?vote[\s\S]{0,40}?feedback|feedback[\s\S]{0,120}?category/.test(src));
ok("Save-to-Interests menu item is toggleable via ia_ctx_save", /ia_ctx_save/.test(src) && /saveEnabled[\s\S]{0,120}?saveToInterests/.test(src));
ok("context menu rebuilds when the toggle changes", /storage\.onChanged\.addListener[\s\S]{0,120}?ia_ctx_save[\s\S]{0,60}?ensureContextMenu/.test(src));
ok("menu items also appear on the extension icon (action context)", /id:\s*["']saveToInterests["'][\s\S]{0,160}?contexts:\s*\[[^\]]*["']action["']/.test(src));

console.log("bstumble-ext-bg: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
