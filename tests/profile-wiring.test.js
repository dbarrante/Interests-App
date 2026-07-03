const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("loads profile-analyze.js and has the Build-my-profile handler", () => {
  assert.ok(html.indexOf('src="profile-analyze.js"') >= 0);
  assert.ok(html.indexOf("function buildMyProfile") >= 0);
  assert.ok(html.indexOf("summarizeLibrary(") >= 0);
  assert.ok(html.indexOf("buildProfilePrompt(") >= 0);
  assert.ok(html.indexOf('id="profileReview"') >= 0);
});
t("accept writes interests + about via mergeInterests", () => {
  assert.ok(html.indexOf("function acceptProfile") >= 0);
  assert.ok(html.indexOf("mergeInterests(") >= 0);
});

t("the two profile tools are merged into one Build-my-profile flow", () => {
  // The separate discoverInterests tool is gone; its free-text box is reused by the merge.
  assert.ok(html.indexOf("function discoverInterests") < 0, "discoverInterests removed");
  assert.ok(html.indexOf("function analyzeLibrary") < 0, "analyzeLibrary removed (folded into buildMyProfile)");
  assert.ok(html.indexOf('id="discInput"') >= 0, "optional free-text box retained");
  assert.ok(html.indexOf('onclick="buildMyProfile()"') >= 0, "single Build-my-profile button");
  assert.ok(html.indexOf("&#129504; Build my profile") >= 0, "button relabeled");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
