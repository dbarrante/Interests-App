// tests/title-quality-wiring.test.js — card-title-quality feature wiring,
// checked structurally against both web/index.html and pwa/index.html
// (regex-based, matching the settings-wiring.test.js convention — these
// files have no build step, so we assert on the actual shipped source).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": the old genericTitle() function is gone", () => {
    assert.ok(!/function genericTitle\(/.test(src), "genericTitle() should be fully replaced by isGenericTitle()");
  });
  t(label + ": enrichPins uses isGenericTitle", () => {
    assert.match(src, /if\(m\.title && isGenericTitle\(p\.title, ?p\.url\)\) p\.title=m\.title\.slice\(0,250\);/);
  });
  t(label + ": enrichOnOpen's free re-fetch uses isGenericTitle", () => {
    assert.match(src, /if\(m\.title && m\.title\.length>10 && isGenericTitle\(it\.title, ?it\.url\)\)\{ it\.title=m\.title\.slice\(0,250\); changed=true; \}/);
  });
  t(label + ": addClip uses isGenericTitle", () => {
    assert.match(src, /if\(cap\.title && \(isNew \|\| isGenericTitle\(item\.title\|\|"", ?item\.url\)\)\) item\.title = cap\.title\.slice\(0,250\);/);
  });
  t(label + ": normalizeTitleKey exists and normalizes case/whitespace", () => {
    assert.match(src, /function normalizeTitleKey\(t\)\{/);
  });
  t(label + ": allTitleKeys scans both imported and saved", () => {
    const m = /function allTitleKeys\(excludeId\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "allTitleKeys not found");
    assert.match(m[1], /imported\.forEach/);
    assert.match(m[1], /saved\.forEach/);
  });
  t(label + ": generateUniqueTitle retries up to 3 times on collision, then disambiguates", () => {
    const m = /async function generateUniqueTitle\(card, ?extraAvoid\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "generateUniqueTitle not found");
    assert.match(m[1], /attempt\s*<\s*3/, "should retry up to 3 times");
    assert.match(m[1], /buildTitlePrompt\(/);
    assert.match(m[1], /parseTitleReply\(/);
  });
  t(label + ": enrichOnOpen calls generateUniqueTitle automatically when still generic", () => {
    const start = src.indexOf("async function enrichOnOpen(");
    const end = src.indexOf("\nif(changed){", start) >= 0 ? src.indexOf("\nif(changed){", start) : src.indexOf("    if(changed){", start);
    assert.ok(start >= 0 && end > start, "enrichOnOpen not found");
    const body = src.slice(start, end);
    assert.match(body, /isGenericTitle\(it\.title, ?it\.url\)/, "should re-check isGenericTitle after the free re-fetch");
    assert.match(body, /generateUniqueTitle\(it\)/, "should call generateUniqueTitle for a still-generic title");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
