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

// v1.8.0 review E: doCapture and sendPostClip built the same clipSocialPost info
// object (url/title/author/text/image/rect/strategy/pageUrl) via two near-duplicate
// blocks. Extracted into a shared buildClipInfo(post) helper — assert the helper
// contains the logic AND that both callers delegate to it (Phase 1 Task 8 pattern).
t("buildClipInfo(post) is the single source of the clipSocialPost info shape", () => {
  const body = grab(coreSrc, "buildClipInfo");
  assert.ok(/cfg\.extract\(post,\s*U\)/.test(body), "buildClipInfo extracts author/text via cfg.extract");
  assert.ok(/cfg\.findPermalink\(post,\s*U\)/.test(body), "buildClipInfo resolves the permalink via cfg.findPermalink");
  assert.ok(/U\.largestImg\(post,\s*cfg\.imageCdn\)/.test(body), "buildClipInfo reads the post's own photo via U.largestImg");
  assert.ok(/U\.rectOf\(/.test(body), "buildClipInfo computes the post rect via U.rectOf");
  assert.ok(/strategy:\s*cfg\.image/.test(body), "buildClipInfo stamps strategy: cfg.image");
});

t("doCapture and sendPostClip both delegate to buildClipInfo (no duplicated info-building)", () => {
  const dci = coreSrc.indexOf("const doCapture = function");
  assert.ok(dci >= 0, "doCapture present");
  const dcBody = coreSrc.slice(dci, coreSrc.indexOf("};", dci) + 2);
  assert.ok(/const info = buildClipInfo\(post\)/.test(dcBody), "doCapture builds info via buildClipInfo(post)");
  assert.ok(!/const ex = \(post && cfg\.extract\)/.test(dcBody), "doCapture no longer inlines the extract/author/perma/url/image/rect block");

  const spcBody = grab(coreSrc, "sendPostClip");
  assert.ok(/const info = buildClipInfo\(post\)/.test(spcBody), "sendPostClip builds info via buildClipInfo(post)");
  assert.ok(!/const ex = cfg\.extract/.test(spcBody), "sendPostClip no longer inlines its own extract/author/perma/url/image/rect block");
});

console.log(passed + " passed, " + failed + " failed");
if (failed) process.exitCode = 1;
