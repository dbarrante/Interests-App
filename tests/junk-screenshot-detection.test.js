// Regression lock: Instagram serves a visually-identical "trouble displaying this
// video" error page for reels it currently won't play. captureTab still takes a REAL
// screenshot of that error page (a genuine data: image, not a raw hotlink), so
// isBadImg/imgFp both call it "fine" and it silently persists as the card's picture
// forever. Found live 2026-07-15: 14 of 609 cached Instagram Reel screenshots were
// this exact error page. This locks the perceptual-hash detector (dHashFromDataUrl +
// isKnownJunkScreenshot) that catches it in drainCaptures, and hammingDist's real
// behavior is covered separately in tests/capture-state.test.js (it's DOM-free and
// Node-testable there). dHashFromDataUrl's decode path (atob/Blob/createImageBitmap)
// IS executed here (sandboxed, mirroring tests/imagehash-cache-wiring.test.js's
// approach for computeCardHash) with scripted fakes for createImageBitmap/
// OffscreenCanvas — those two browser globals still can't run in Node, but atob/Blob
// are real, so the actual base64-decode/mediaType-parse logic is proven, not just
// grepped for.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const { extractFn } = require("./_extract");
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

// Loads the real dHashFromDataUrl out of the HTML source and runs it against
// scripted fakes for createImageBitmap/OffscreenCanvas (atob/Blob are real —
// Node has both natively), so the SHIPPED decode logic executes rather than a
// reimplementation of it. Mirrors loadComputeCardHash in
// tests/imagehash-cache-wiring.test.js.
function loadDHashFromDataUrl(src) {
  // extractFn (not the local grab()) — grab() drops the "async " prefix
  // (it searches for "function NAME(" verbatim), which would hand the
  // sandboxed factory a non-async function containing `await` and blow up
  // with "await is only valid in async functions" the moment it's executed.
  const fnSrc = extractFn(src, "dHashFromDataUrl");   // self-contained: no other fn deps
  assert.ok(fnSrc, "dHashFromDataUrl not found via extractFn");
  let capturedBlob = null;
  const createImageBitmapMock = async (blob) => { capturedBlob = blob; return { __fakeBitmap: true }; };
  function FakeCtx() {}
  FakeCtx.prototype.drawImage = function () {};
  FakeCtx.prototype.getImageData = function (x, y, w, h) {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { d[i * 4] = 128; d[i * 4 + 1] = 128; d[i * 4 + 2] = 128; d[i * 4 + 3] = 255; }
    return { data: d };
  };
  function FakeOffscreenCanvas(w, h) { this.w = w; this.h = h; }
  FakeOffscreenCanvas.prototype.getContext = function () { return new FakeCtx(); };
  const factory = new Function(
    "createImageBitmap", "OffscreenCanvas", "atob", "Blob",
    fnSrc + "\nreturn dHashFromDataUrl;"
  );
  const dHashFromDataUrl = factory(createImageBitmapMock, FakeOffscreenCanvas, atob, Blob);
  return { dHashFromDataUrl, capturedBlob: () => capturedBlob };
}

let passed = 0, failed = 0;
async function t(n, fn){ try { await fn(); passed++; } catch(e){ failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

(async () => {

for (const [label, src] of [["web", web], ["pwa", pwa]]) {
  await t(label + ": IG_VIDEO_ERROR_DHASHES seeded with exactly 2 known-bad 64-bit reference hashes", () => {
    const m = src.match(/const IG_VIDEO_ERROR_DHASHES = \[([\s\S]*?)\];/);
    assert.ok(m, "constant present");
    const hashes = m[1].match(/"[01]{64}"/g);
    assert.ok(hashes && hashes.length === 2, "exactly 2 seed hashes, each a 64-char binary string");
  });

  await t(label + ": JUNK_DHASH_MAX_DIST is the empirically-validated threshold of 8", () => {
    assert.ok(src.indexOf("const JUNK_DHASH_MAX_DIST = 8;") >= 0);
  });

  await t(label + ": dHashFromDataUrl decodes via canvas and fails safe (never throws, returns \"\")", () => {
    const body = grab(src, "dHashFromDataUrl");
    assert.ok(body.indexOf("createImageBitmap") >= 0, "decodes the data: URL to a bitmap");
    assert.ok(body.indexOf("OffscreenCanvas") >= 0, "uses OffscreenCanvas (works in any renderer context)");
    assert.ok(body.indexOf("catch(e){ return \"\"; }") >= 0, "swallows decode errors, never blocks a capture");
  });

  // STRUCTURAL GUARD: dHashFromDataUrl used to do createImageBitmap(await (await
  // fetch(dataUrl)).blob()) -- the same trap as computeCardHash
  // (tests/imagehash-cache-wiring.test.js): on the web/ surface (served by
  // core/server.js), its CSP connect-src 'self' https: has no "data:" scheme, so
  // fetch() on the data: URL passed in here throws TypeError: Failed to fetch,
  // caught by the try/catch above, silently making every capture look like NOT a
  // known junk screenshot. Read the source text directly (no fetch mock in the
  // loop) so a reintroduced fetch(dataUrl) fails this test even if a future
  // behavioral mock would tolerate it.
  await t(label + ": dHashFromDataUrl's source never calls fetch() on the data: URL again — decodes its base64 payload directly instead", () => {
    const body = grab(src, "dHashFromDataUrl");
    assert.ok(!/fetch\(/.test(body), "fetch(dataUrl) is CSP-blocked on the web/ surface and silently makes isKnownJunkScreenshot always return false");
    assert.ok(body.indexOf("atob(") >= 0, "must decode the base64 payload directly via atob(), not round-trip it through fetch()");
  });

  // BEHAVIORAL (executed, not just grepped): proves the decode is actually
  // correct — a broken slice/split media-type parse or a broken charCodeAt
  // decode loop would still satisfy the structural guard above (it has no
  // fetch( and does call atob() ) while silently producing garbage bytes or
  // the wrong Blob type. Uses a real data: URL with a DIFFERENT media type and
  // payload than computeCardHash's fixture ("image/png", 6 bytes) so this test
  // cannot coincidentally pass off a copy-pasted expectation.
  await t(label + ": dHashFromDataUrl decodes the real base64 payload and media type — behavioral, executes the shipped code", async () => {
    const { dHashFromDataUrl, capturedBlob } = loadDHashFromDataUrl(src);
    // "Zm9vYmFy" is the base64 encoding of "foobar" (6 bytes).
    const hash = await dHashFromDataUrl("data:image/png;base64,Zm9vYmFy");
    const blob = capturedBlob();
    assert.ok(blob instanceof Blob, "createImageBitmap must be called with a real Blob, not a Response/data: URL");
    assert.strictEqual(blob.type, "image/png", "must parse the media type out of the \"image/png;base64\" header, not the whole header string");
    assert.strictEqual(blob.size, 6, "must decode the payload AFTER the comma (\"Zm9vYmFy\" -> \"foobar\", 6 bytes)");
    assert.strictEqual(hash.length, 64, "must return the documented 64-char binary dHash");
    assert.match(hash, /^[01]{64}$/, "hash must be a binary (0/1) string, matching IG_VIDEO_ERROR_DHASHES' format");
  });

  await t(label + ": isKnownJunkScreenshot compares against every seed hash via hammingDist", () => {
    const body = grab(src, "isKnownJunkScreenshot");
    assert.ok(body.indexOf("dHashFromDataUrl(dataUrl)") >= 0);
    assert.ok(body.indexOf("IG_VIDEO_ERROR_DHASHES.some") >= 0, "checks all seeds, not just the first");
    assert.ok(body.indexOf("hammingDist(hash, ref) <= JUNK_DHASH_MAX_DIST") >= 0);
  });

  await t(label + ": drainCaptures rejects a known junk screenshot the SAME way it rejects a known _phFps placeholder", () => {
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
}

await t("web and pwa detector code is byte-identical (this repo's binding parity requirement)", () => {
  const w = grab(web, "dHashFromDataUrl") + grab(web, "isKnownJunkScreenshot");
  const p = grab(pwa, "dHashFromDataUrl") + grab(pwa, "isKnownJunkScreenshot");
  assert.strictEqual(w, p);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;

})();
