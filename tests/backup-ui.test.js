// tests/backup-ui.test.js — structural checks (regex against the actual
// shipped source, no build step) for the client-side backup/restore UI.
// Mirrors tests/title-quality-wiring.test.js's per-file convention.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": restoreLatest skips the rolling mirror when picking the default restore target", () => {
    const m = /async function restoreLatest\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "restoreLatest not found");
    assert.match(m[1], /list\.find\(b=>!b\.mirror\)/,
      "must pick the newest NON-mirror entry -- list[0] can be the rolling mirror (sorts by wall-clock time, so it's routinely newer than the freshest dated snapshot), which is rewritten in place every few minutes and is not a point-in-time recovery point");
    assert.doesNotMatch(m[1], /^\s*return restoreFromList\(list\[0\]\.name\);\s*$/m,
      "must not restore list[0] unconditionally");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
