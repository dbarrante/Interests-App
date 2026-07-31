// tests/research-parity.test.js — Task 5: every pure-logic and UI function this
// plan introduced (Tasks 1-4) must be byte-identical between web/index.html and
// pwa/index.html. Same technique as tests/tabs-parity.test.js (Plan 2).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

const FNS = [
  "hasResearchProvider", "_researchCard", "buildArticlePrompt", "buildQuestionPrompt", "parseResearchResponse",
  "generateArticle", "copyArticleText", "toggleArticleExpanded",
  "toggleArticleEdit", "saveArticleEdit",
  "askQuestion", "deleteQaEntry",
  "researchPanelHTML",
];

for (const name of FNS) {
  t(name + " is byte-identical between web and pwa", () => {
    const a = extractFn(html, name), b = extractFn(pwaHtml, name);
    assert.ok(a, name + " not found in web/index.html");
    assert.ok(b, name + " not found in pwa/index.html");
    assert.strictEqual(a, b);
  });
}

t("RESEARCH_PROVIDERS declaration is byte-identical between web and pwa", () => {
  const a = html.match(/const RESEARCH_PROVIDERS[^;]+;/);
  const b = pwaHtml.match(/const RESEARCH_PROVIDERS[^;]+;/);
  assert.ok(a && b);
  assert.strictEqual(a[0], b[0]);
});

t("renderTabsView's card loop wires researchPanelHTML gated on t.reserved", () => {
  const a = extractFn(html, "renderTabsView"), b = extractFn(pwaHtml, "renderTabsView");
  assert.match(a, /if\(t\.reserved\)\s*inner\s*\+=\s*researchPanelHTML\(r\.kind,\s*r\.it\)/);
  assert.strictEqual(a, b);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
