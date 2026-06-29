const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("settings has a Safe Browsing key field", () => {
  assert.ok(html.indexOf('id="sbKey"') >= 0);
});
t("saves the key via Store", () => {
  assert.ok(html.indexOf("Store.setSafeBrowsingKey") >= 0);
  assert.ok(html.indexOf("Store.getSafeBrowsingKey") >= 0);
});

t("loads the safety helper entry points", () => {
  assert.ok(html.indexOf("function checkLinkSafety") >= 0);
  assert.ok(html.indexOf("Store.checkSafety") >= 0);
  assert.ok(html.indexOf('id="safetyModal"') >= 0);
});
t("has the Check link safety button", () => {
  assert.ok(html.indexOf("checkLinkSafety()") >= 0);
  assert.ok(html.indexOf("Check link safety") >= 0);
});

t("shared runSafetyPass helper exists and checkLinkSafety uses it", () => {
  assert.ok(html.indexOf("function runSafetyPass") >= 0);
  assert.ok(html.indexOf("runSafetyPass(") >= 0);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
