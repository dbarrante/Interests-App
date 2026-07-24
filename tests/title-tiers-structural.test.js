// tests/title-tiers-structural.test.js — structural checks (regex against the
// actual shipped source, no build step) for the browser-only pieces of the
// tiered title-generation pipeline that can't run in Node (canvas/fetch/OCR).
// Mirrors tests/title-quality-wiring.test.js's per-file convention.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": resolveCardImageForAI exists and downscales to a bounded edge", () => {
    const m = /async function resolveCardImageForAI\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "resolveCardImageForAI not found");
    assert.match(m[1], /maxEdge\s*=\s*1024/);
    assert.match(m[1], /image\/jpeg/);
    assert.match(m[1], /quality\s*:\s*0\.7/);
    assert.match(m[1], /idb:/, "must handle idb:-backed images");
    assert.match(m[1], /Store\.ensureImage/);
  });
  t(label + ": resolveCardImageForAI returns null on failure, never throws to its caller", () => {
    const m = /async function resolveCardImageForAI\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.match(m[1], /catch\s*\(e\)\{[^}]*return null;/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
