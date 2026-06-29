const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("loads the deadcheck-ai helper script", () => {
  assert.ok(html.indexOf('src="deadcheck-ai.js"') >= 0);
});
t("checkDeadLinks calls the content tier", () => {
  assert.ok(html.indexOf("Store.checkContent") >= 0);
});
t("uses the AI helpers for the confirmation tier", () => {
  assert.ok(html.indexOf("buildDeadCheckPrompt") >= 0);
  assert.ok(html.indexOf("parseDeadVerdict") >= 0);
});
t("caps paid AI calls", () => {
  assert.ok(/AI_DEAD_CAP\s*=\s*\d+/.test(html));
});
t("offers a wayback recovery link on AI-confirmed rows", () => {
  assert.ok(html.indexOf("waybackUrl(") >= 0);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
