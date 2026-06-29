// Instagram capture regressions (root cause of "IG pictures not capturing"):
//   1. largestImg picked Instagram's STATIC UI sprite (static.cdninstagram.com/rsrc.php/*.png)
//      as the post photo, because the IG imageCdn allow-list `/cdninstagram/` matched it.
//      Fix: a pure `isUiAssetUrl` reject (static./rsrc.php//images/) used inside largestImg.
//   2. igIsSpecific only matched /reel/ (singular), not /reels/ (plural) permalinks.
const assert = require("assert");
const fs = require("fs"), path = require("path");

const coreSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "capture-core.js"), "utf8");
const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "capture-configs.js"), "utf8");

// Pull an indented closure function out by name via a brace-balance scan (the shared
// _extract helper only matches column-0 functions). Safe for these pure one-liners —
// their regex literals contain no { } characters.
function grab(src, name){
  const idx = src.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = src.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < src.length; i++){ const ch = src[i]; if (ch === "{") depth++; else if (ch === "}"){ depth--; if (depth === 0){ i++; break; } } }
  return src.slice(idx, i);
}

let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

const isUiAssetUrl = eval("(" + grab(coreSrc, "isUiAssetUrl") + ")");
const igIsSpecific = eval("(" + grab(cfgSrc, "igIsSpecific") + ")");

t("isUiAssetUrl rejects Instagram static UI assets but accepts real post media", () => {
  // the exact bad URL captured on the broken cards
  assert.strictEqual(isUiAssetUrl("https://static.cdninstagram.com/rsrc.php/v4/yD/r/R0fBIMurK8v.png"), true, "static rsrc.php sprite must be rejected");
  assert.strictEqual(isUiAssetUrl("https://scontent-iad3-1.cdninstagram.com/v/t51.2885-15/abc_n.jpg"), false, "real scontent media must be accepted");
  assert.strictEqual(isUiAssetUrl("https://instagram.fxyz1-1.fbcdn.net/v/t51.2885-15/x.jpg"), false, "real fbcdn media must be accepted");
  assert.strictEqual(isUiAssetUrl(""), false, "empty is not a UI asset");
});

t("igIsSpecific matches /reels/ (plural) as well as /reel/, /p/, /tv/", () => {
  assert.ok(igIsSpecific("https://www.instagram.com/reels/DYnA8VyoVYR/"), "reels (plural) permalink");
  assert.ok(igIsSpecific("https://www.instagram.com/reel/DYnA8VyoVYR/"), "reel (singular) permalink");
  assert.ok(igIsSpecific("https://www.instagram.com/p/ABC123/"), "/p/ permalink");
  assert.ok(igIsSpecific("https://www.instagram.com/tv/ABC123/"), "/tv/ permalink");
  assert.ok(!igIsSpecific("https://www.instagram.com/accounts/login/"), "login page is not a specific post");
});

console.log(passed + " passed, " + failed + " failed");
if (failed) process.exitCode = 1;
