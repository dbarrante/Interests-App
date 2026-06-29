const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("loads profile-analyze.js and has the Analyze button + handler", () => {
  assert.ok(html.indexOf('src="profile-analyze.js"') >= 0);
  assert.ok(html.indexOf("function analyzeLibrary") >= 0);
  assert.ok(html.indexOf("summarizeLibrary(") >= 0);
  assert.ok(html.indexOf('id="profileReview"') >= 0);
});
t("accept writes interests + about via mergeInterests", () => {
  assert.ok(html.indexOf("function acceptProfile") >= 0);
  assert.ok(html.indexOf("mergeInterests(") >= 0);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
