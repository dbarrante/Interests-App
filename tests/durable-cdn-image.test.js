// Regression lock: a captured Facebook/Instagram og:image is a SIGNED, EXPIRING CDN
// URL (scontent/cdninstagram/fbcdn, "oe=" param) -- stored raw it looks fine for days
// then silently rots once the signature times out, with no error anywhere (root cause
// of the 2026-07-15 "no longer seeing pictures for Instagram cards" report: 51 of 713
// IG-imported cards from one 2026-07-04 batch landed on the raw og:image URL because
// captureTab shipped it unconverted, and isBadImg didn't recognize it as bad).
// captureFbPost/captureFbByOg/clipCurrentPage already guard against exactly this for
// their own paths (see fetchAsDataUrl callers) -- captureTab (the generic, non-FB path
// Instagram falls through to) did not, until this fix.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

function grab(src, name){
  let idx = src.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  if (idx >= 6 && src.slice(idx - 6, idx) === "async ") idx -= 6; // include the async keyword so eval() produces a real async function
  // skip past the parameter list (which may itself contain braces, e.g. a `= {}` default) to find the body's real opening brace
  const parenOpen = src.indexOf("(", idx);
  let pdepth = 0, po = parenOpen;
  for (; po < src.length; po++){ const ch = src[po]; if (ch === "(") pdepth++; else if (ch === ")"){ pdepth--; if (pdepth === 0){ po++; break; } } }
  const open = src.indexOf("{", po);
  let depth = 0, i = open;
  for (; i < src.length; i++){ const ch = src[i]; if (ch === "{") depth++; else if (ch === "}"){ depth--; if (depth === 0){ i++; break; } } }
  return src.slice(idx, i);
}

let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

const isExpiringCdnImage = eval("(" + grab(bg, "isExpiringCdnImage") + ")");

t("isExpiringCdnImage: flags the exact live-broken signed IG CDN URL", () => {
  assert.strictEqual(isExpiringCdnImage(
    "https://scontent.cdninstagram.com/v/t51.71878-15/705018096_1366937845281127_5734660294580020960_n.jpg?stp=cmp1_dst-jpg_e35_s640x640_tt6&_nc_cat=102&oh=00_AQC3erfV06LtnmBwtoebth_LoBqwzRS_iL75vcuB19--Ag&oe=6A48EDD6"
  ), true);
});

t("isExpiringCdnImage: flags fbcdn post photos too (same signed-URL class)", () => {
  assert.strictEqual(isExpiringCdnImage("https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/x.jpg?oh=abc&oe=64ABCDEF"), true);
});

t("isExpiringCdnImage: leaves durable images and non-social CDNs alone", () => {
  assert.strictEqual(isExpiringCdnImage(""), false);
  assert.strictEqual(isExpiringCdnImage("https://i.ytimg.com/vi/abc123/hqdefault.jpg"), false);
  assert.strictEqual(isExpiringCdnImage("https://cdn.example.com/photo.jpg"), false);
  assert.strictEqual(isExpiringCdnImage("data:image/jpeg;base64,/9j/4AAQ"), false);
});

t("isExpiringCdnImage: still excludes IG's static UI sprites (rsrc.php), same as clipCurrentPage's guard", () => {
  assert.strictEqual(isExpiringCdnImage("https://static.cdninstagram.com/rsrc.php/v4/yD/r/R0fBIMurK8v.png"), false);
});

t("captureTab converts ogImage/contentImage through durableImage before shipping them", () => {
  const body = grab(bg, "captureTab");
  const ci = body.indexOf("const capture = {");
  assert.ok(ci >= 0, "capture object present");
  const captureLit = body.slice(ci, body.indexOf("};", ci) + 2);
  assert.ok(/ogImage:\s*blocked \? "" : await durableImage\(meta\.ogImage \|\| ""\)/.test(captureLit),
    "ogImage must be converted via durableImage before delivery");
  assert.ok(/contentImage:\s*blocked \? "" : await durableImage\(meta\.contentImage \|\| ""\)/.test(captureLit),
    "contentImage must be converted via durableImage before delivery");
});

t("durableImage no longer gates on isExpiringCdnImage — Approach A: attempt conversion for any external URL", () => {
  const body = grab(bg, "durableImage");
  assert.ok(body.indexOf("isExpiringCdnImage(url)") === -1,
    "must no longer gate on isExpiringCdnImage — that gate was the whole gap (Pinterest/YouTube/generic CDNs were never protected, only Facebook/Instagram)");
  assert.ok(body.indexOf("fetchAsDataUrl(url)") >= 0, "must still convert via the existing CORS-bypassing fetchAsDataUrl helper");
  assert.ok(/return data \|\| url/.test(body), "must still keep the raw URL as a last resort if the durable fetch fails (never worse than before)");
});

t("durableImage early-outs for an already-durable data: URL or an empty string (no wasted fetch)", () => {
  const body = grab(bg, "durableImage");
  assert.ok(/if\s*\(!url \|\| url\.indexOf\("data:"\) === 0\)\s*return url;/.test(body),
    "must early-out before attempting a fetch for a url that's already durable or empty");
});

t("durableImage actually converts a non-Meta CDN URL now (e.g. Pinterest) — this is the real fix, proven by execution not just source text", () => {
  let calledWith = null;
  async function fetchAsDataUrl(u) { calledWith = u; return "data:image/jpeg;base64,AAAA"; }
  const durableImage = eval("(" + grab(bg, "durableImage") + ")");
  return durableImage("https://i.pinimg.com/564x/ab/cd/ef.jpg").then((result) => {
    assert.strictEqual(calledWith, "https://i.pinimg.com/564x/ab/cd/ef.jpg", "must have attempted the fetch — before this fix, isExpiringCdnImage(pinimg url) is false, so the fetch was skipped entirely");
    assert.strictEqual(result, "data:image/jpeg;base64,AAAA");
  });
});

t("clipCurrentPage converts ogImage/contentImage through durableImage too (previously only captureTab did — clipCurrentPage's right-clicked-image case was protected, but its scraped og:image/contentImage were not)", () => {
  const body = grab(bg, "clipCurrentPage");
  assert.ok(/ogImage:\s*blocked \? "" : await durableImage\(meta\.ogImage \|\| ""\)/.test(body),
    "clipCurrentPage's payload.ogImage must be converted via durableImage before delivery");
  assert.ok(/contentImage:\s*blocked \? "" : await durableImage\(meta\.contentImage \|\| ""\)/.test(body),
    "clipCurrentPage's payload.contentImage must be converted via durableImage before delivery");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
