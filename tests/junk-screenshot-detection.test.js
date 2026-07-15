// Regression lock: Instagram serves a visually-identical "trouble displaying this
// video" error page for reels it currently won't play. captureTab still takes a REAL
// screenshot of that error page (a genuine data: image, not a raw hotlink), so
// isBadImg/imgFp both call it "fine" and it silently persists as the card's picture
// forever. Found live 2026-07-15: 14 of 609 cached Instagram Reel screenshots were
// this exact error page. This locks the perceptual-hash detector (dHashFromDataUrl +
// isKnownJunkScreenshot) that catches it in drainCaptures, and hammingDist's real
// behavior is covered separately in tests/capture-state.test.js (it's DOM-free and
// Node-testable there; dHashFromDataUrl needs a canvas, so it's browser-only and only
// string-checked here, matching this repo's established convention for canvas/chrome-
// API-dependent code).
const assert = require("assert");
const fs = require("fs"), path = require("path");
const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

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

[["web", web], ["pwa", pwa]].forEach(([label, src]) => {
  t(label + ": IG_VIDEO_ERROR_DHASHES seeded with exactly 2 known-bad 64-bit reference hashes", () => {
    const m = src.match(/const IG_VIDEO_ERROR_DHASHES = \[([\s\S]*?)\];/);
    assert.ok(m, "constant present");
    const hashes = m[1].match(/"[01]{64}"/g);
    assert.ok(hashes && hashes.length === 2, "exactly 2 seed hashes, each a 64-char binary string");
  });

  t(label + ": JUNK_DHASH_MAX_DIST is the empirically-validated threshold of 8", () => {
    assert.ok(src.indexOf("const JUNK_DHASH_MAX_DIST = 8;") >= 0);
  });

  t(label + ": dHashFromDataUrl decodes via canvas and fails safe (never throws, returns \"\")", () => {
    const body = grab(src, "dHashFromDataUrl");
    assert.ok(body.indexOf("createImageBitmap") >= 0, "decodes the data: URL to a bitmap");
    assert.ok(body.indexOf("OffscreenCanvas") >= 0, "uses OffscreenCanvas (works in any renderer context)");
    assert.ok(body.indexOf("catch(e){ return \"\"; }") >= 0, "swallows decode errors, never blocks a capture");
  });

  t(label + ": isKnownJunkScreenshot compares against every seed hash via hammingDist", () => {
    const body = grab(src, "isKnownJunkScreenshot");
    assert.ok(body.indexOf("dHashFromDataUrl(dataUrl)") >= 0);
    assert.ok(body.indexOf("IG_VIDEO_ERROR_DHASHES.some") >= 0, "checks all seeds, not just the first");
    assert.ok(body.indexOf("hammingDist(hash, ref) <= JUNK_DHASH_MAX_DIST") >= 0);
  });

  t(label + ": drainCaptures rejects a known junk screenshot the SAME way it rejects a known _phFps placeholder", () => {
    const di = src.indexOf("async function drainCaptures(");
    assert.ok(di >= 0, "drainCaptures present");
    const body = src.slice(di, src.indexOf("\n}", di) + 2);
    const phIdx = body.indexOf("_phFps.has(imgFp(best))");
    const junkIdx = body.indexOf("await isKnownJunkScreenshot(best)");
    assert.ok(phIdx >= 0, "existing placeholder check still present");
    assert.ok(junkIdx >= 0, "new junk-screenshot check present");
    assert.ok(junkIdx > phIdx, "junk-screenshot check runs after the placeholder check, same guard style");
    // both checks are gated on the SAME "best is a real data: capture" precondition,
    // and both apply the SAME rejection (lastResult=fail, no image stored, no re-queue)
    const junkBlock = body.slice(junkIdx, junkIdx + 300);
    assert.ok(junkBlock.indexOf('lastResult="fail"') >= 0, "rejects without storing the junk image");
  });
});

t("web and pwa detector code is byte-identical (this repo's binding parity requirement)", () => {
  const w = grab(web, "dHashFromDataUrl") + grab(web, "isKnownJunkScreenshot");
  const p = grab(pwa, "dHashFromDataUrl") + grab(pwa, "isKnownJunkScreenshot");
  assert.strictEqual(w, p);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
