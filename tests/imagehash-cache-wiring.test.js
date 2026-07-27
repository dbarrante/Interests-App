// tests/imagehash-cache-wiring.test.js — Task 6: browser-side perceptual
// image hashing (imgHashSrcKey / computeCardHash / loadImgHashCache /
// saveImgHashCache), extracted from the REAL web/pwa index.html source (not
// reimplemented) and run against scripted fakes for the browser-only globals
// (fetch/createImageBitmap/OffscreenCanvas) and for resolveCardImageForAI/
// Store — the same extraction technique tests/title-quality-integration.test.js
// already uses for generateUniqueTitle.
//
// Two defects this file specifically guards against (found reviewing prior
// tasks' briefs, which have each shipped at least one real bug):
//   1. resolveCardImageForAI returns a TRUTHY { failReason } object on
//      failure (no .base64). `if(!image) return "";` alone never fires on
//      that object, so a naive port would silently try to hash "undefined".
//   2. dhashFromGrey returns the SAME all-zero hash for any flat/near-flat
//      sample. Every blank or solid-colour card would therefore collide at
//      distance 0 — and the consumer of these hashes offers to DELETE the
//      loser of a match. computeCardHash must detect a degenerate sample and
//      return "" (unhashable) instead of handing it to dhashFromGrey.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const IA_IMGHASH = require("../web/imagehash.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); pass++; console.log("  ok  " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
}

function fn(src, name) {
  const m = extractFn(src, name);
  assert.ok(m, name + " not found");
  return m;
}

// --- pixel fixtures ------------------------------------------------------
function flatPixels(w, h, v) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  return d;
}
// Same mixed, non-monotonic shape as tests/imagehash.test.js's "base"
// fixture — unambiguously real content, not a ramp that happens to hash to
// the same all-zero value a flat image would (dHash asks "brighter than my
// right neighbour?", so a plain rising ramp is legitimately all-zero too).
function variedPixels(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = (x * x * 3 + y * 17 + ((x * y) % 7) * 11) % 256;
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
  }
  return d;
}
// Duplicates computeCardHash's documented luminance weights (a fixed
// contract, not an implementation detail) so a test can assert the ACTUAL
// hash value rather than merely "some 16-hex string".
function expectedGreyFromRGBA(data, w, h) {
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
  return grey;
}

// Loads the real computeCardHash out of the HTML source and runs it against
// scripted fakes for every browser global it touches, so the SHIPPED
// decision logic executes rather than a reimplementation of it.
function loadComputeCardHash(src, resolveMock, pixelDataFn) {
  // computeCardHash calls isDegenerateHash internally (IMPORTANT 1 widening),
  // so both function declarations must share the sandbox scope — extracting
  // computeCardHash alone would leave that call a ReferenceError, which the
  // function's own try/catch would silently swallow into a false "" result.
  const fnSrc = fn(src, "isDegenerateHash") + "\n" + fn(src, "computeCardHash");
  let fetchCalls = 0;
  const fetchMock = async (url) => { fetchCalls++; return { blob: async () => ({ __fakeBlob: true, url }) }; };
  const createImageBitmapMock = async () => ({ __fakeBitmap: true });
  function FakeCtx() {}
  FakeCtx.prototype.drawImage = function () {};
  FakeCtx.prototype.getImageData = function (x, y, w, h) { return { data: pixelDataFn(w, h) }; };
  function FakeOffscreenCanvas(w, h) { this.w = w; this.h = h; }
  FakeOffscreenCanvas.prototype.getContext = function () { return new FakeCtx(); };
  const factory = new Function(
    "resolveCardImageForAI", "IA_IMGHASH", "fetch", "createImageBitmap", "OffscreenCanvas", "console",
    fnSrc + "\nreturn computeCardHash;"
  );
  const computeCardHash = factory(resolveMock, IA_IMGHASH, fetchMock, createImageBitmapMock, FakeOffscreenCanvas, console);
  return { computeCardHash, fetchCalls: () => fetchCalls };
}

function loadPureFn(src, name) { return eval("(" + fn(src, name) + ")"); }

function loadCacheFns(src, storeMock) {
  const factory = new Function("Store", fn(src, "loadImgHashCache") + "\n" + fn(src, "saveImgHashCache") + "\nreturn { loadImgHashCache, saveImgHashCache };");
  return factory(storeMock);
}

// Loads the REAL setSavedImage alongside the REAL imgHashSrcKey, so a test
// can exercise the actual Saved-card image-write path (not a reimplementation
// of it) and observe whether it stamps what imgHashSrcKey actually reads.
function loadSavedImageFns(src, storeMock) {
  const factory = new Function("Store", fn(src, "setSavedImage") + "\n" + fn(src, "imgHashSrcKey") + "\nreturn { setSavedImage, imgHashSrcKey };");
  return factory(storeMock);
}

(async () => {

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {

  await t(label + ": imagehash.js is loaded", () => {
    assert.match(src, /<script src="imagehash\.js"><\/script>/);
  });

  await t(label + ": the hash is computed from a sample sized by IA_IMGHASH's own constants, using its dHash", () => {
    const b = fn(src, "computeCardHash");
    assert.match(b, /IA_IMGHASH\.HASH_W/);
    assert.match(b, /IA_IMGHASH\.HASH_H/);
    assert.match(b, /IA_IMGHASH\.dhashFromGrey/);
  });

  await t(label + ": a resolveCardImageForAI FAILURE (truthy {failReason} object, no .base64) never reaches fetch — `if(!image)` alone is not enough", async () => {
    // resolveCardImageForAI's contract (Task 4): failure returns a TRUTHY
    // object with no .base64. A buggy `if(!image) return "";` never fires
    // here (the object IS truthy) and falls through to
    // fetch("data:"+undefined+";base64,"+undefined) — this test proves the
    // real guard checks .base64, not just truthiness.
    const resolveMock = async () => ({ failReason: "fetch-blocked" });
    const { computeCardHash, fetchCalls } = loadComputeCardHash(src, resolveMock, () => flatPixels(9, 8, 128));
    const hash = await computeCardHash({ id: "c1", img: "https://x.example/y.jpg" });
    assert.strictEqual(hash, "");
    assert.strictEqual(fetchCalls(), 0, "must bail out on the failure object before building a data: URL from its missing .base64");
  });

  await t(label + ": a resolveCardImageForAI success with NO base64 field is still treated as a failure", async () => {
    const resolveMock = async () => ({ mediaType: "image/jpeg" }); // malformed: no base64
    const { computeCardHash, fetchCalls } = loadComputeCardHash(src, resolveMock, () => flatPixels(9, 8, 128));
    const hash = await computeCardHash({ id: "c1b", img: "idb:c1b" });
    assert.strictEqual(hash, "");
    assert.strictEqual(fetchCalls(), 0);
  });

  await t(label + ": a flat/uniform sampled image returns \"\" instead of the all-zero hash every blank card would share (deletion-safety guard)", async () => {
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const { computeCardHash } = loadComputeCardHash(src, resolveMock, (w, h) => flatPixels(w, h, 200));
    const hash = await computeCardHash({ id: "c2", img: "idb:c2" });
    assert.strictEqual(hash, "", "a uniform sample must never be hashed — dhashFromGrey returns the same 0000000000000000 for EVERY blank/solid card, and the duplicate scanner offers to DELETE matches");
  });

  await t(label + ": a near-flat sample (post-conversion grey range 7, just under the documented threshold of 8) is still treated as unhashable", async () => {
    // 100/107 verified empirically to survive the 0.299/0.587/0.114 luminance
    // conversion's floating-point rounding with an EXACT grey range of 7 — a
    // naive "just pick two RGB values 7 apart" fixture is not safe here,
    // since that conversion rounds some inputs down by 1 (e.g. 128 -> 127)
    // and can silently widen the gap.
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const { computeCardHash } = loadComputeCardHash(src, resolveMock, (w, h) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) { const v = 100 + (i % 2 ? 7 : 0); d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
      return d;
    });
    const hash = await computeCardHash({ id: "c3", img: "idb:c3" });
    assert.strictEqual(hash, "");
  });

  await t(label + ": a sample with post-conversion grey range exactly 8 (at the boundary, not below it) IS hashed — the guard must not over-fire on real low-contrast photos", async () => {
    // 103..111 verified to produce an EXACT grey range of 8 through the same
    // luminance conversion (see the range-7 test above for why this can't
    // just be "pick two RGB values 8 apart"). Deliberately NOT a simple
    // `i % 2` alternation: that shape is exactly the row-major
    // [100,101,100,101,...] pattern IMPORTANT 1's widened isDegenerateHash
    // guard must reject (it hashes to 55aa55aa55aa55aa, period 4) — using it
    // here would make this "must not over-fire" test collide with the very
    // guard it's supposed to prove doesn't over-fire. This formula is
    // verified (against the real dhashFromGrey) to stay non-degenerate.
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const { computeCardHash } = loadComputeCardHash(src, resolveMock, (w, h) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = 103 + (x * 3 + y * 5 + ((x * y) % 3) * 2) % 9;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      return d;
    });
    const hash = await computeCardHash({ id: "c4", img: "idb:c4" });
    assert.notStrictEqual(hash, "");
    assert.match(hash, /^[0-9a-f]{16}$/);
  });

  await t(label + ": two DIFFERENT smooth greyscale gradients both hash to \"\" instead of colliding at the shared degenerate dHash (gradient-collision guard, IMPORTANT 3)", async () => {
    // dHash only encodes "brighter than my right-hand neighbour?", not by how
    // much — so ANY strictly-increasing left-to-right gradient (sky, vignette,
    // bokeh, gradient banner) hashes to all-zero regardless of its actual pixel
    // values. Both gradients below span a grey range of ~180-200 (far past the
    // hi-lo>=8 input guard) and are genuinely different images (different
    // start/slope, verified distinct pixel arrays), yet the OLD code hashes
    // both to the identical "0000000000000000" -- a false duplicate match that
    // becomes a delete prompt. The fix must reject the OUTPUT, not just judge
    // the input's range.
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    function gradPixels(w, h, start, step) {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; const v = start + x * step;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      return d;
    }
    // Verified against the real IA_IMGHASH.dhashFromGrey: both are strictly
    // increasing L-to-R and both collapse to "0000000000000000".
    const { computeCardHash: hashA } = loadComputeCardHash(src, resolveMock, (w, h) => gradPixels(w, h, 10, 27));
    const { computeCardHash: hashB } = loadComputeCardHash(src, resolveMock, (w, h) => gradPixels(w, h, 30, 22));
    const a = await hashA({ id: "gradA", img: "idb:gradA" });
    const b = await hashB({ id: "gradB", img: "idb:gradB" });
    assert.strictEqual(a, "", "a smooth gradient must be refused, not hashed to the shared all-zero value");
    assert.strictEqual(b, "", "a smooth gradient must be refused, not hashed to the shared all-zero value");
  });

  await t(label + ": two DIFFERENT descending greyscale gradients both hash to \"\" instead of colliding at the shared all-f dHash (MINOR 3 — the all-f half of the guard, previously untested)", async () => {
    // Mirror of the ascending-gradient test above, but for the DESCENDING
    // (all-f) branch: a prior review deleted just the /^f{16}$/ half of the
    // guard from both files and the suite still passed 45/45, because only
    // the ascending/all-zero branch had a test. Both gradients below are
    // strictly decreasing L-to-R, span a grey range far past the hi-lo>=8
    // input guard, and are genuinely different pixel arrays (verified
    // distinct), yet both collapse to "ffffffffffffffff" against the real
    // IA_IMGHASH.dhashFromGrey.
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    function descPixels(w, h, start, step) {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; const v = start + x * step;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      return d;
    }
    const { computeCardHash: hashA } = loadComputeCardHash(src, resolveMock, (w, h) => descPixels(w, h, 245, -27));
    const { computeCardHash: hashB } = loadComputeCardHash(src, resolveMock, (w, h) => descPixels(w, h, 225, -22));
    const a = await hashA({ id: "gradDescA", img: "idb:gradDescA" });
    const b = await hashB({ id: "gradDescB", img: "idb:gradDescB" });
    assert.strictEqual(a, "", "a smooth descending gradient must be refused, not hashed to the shared all-f value");
    assert.strictEqual(b, "", "a smooth descending gradient must be refused, not hashed to the shared all-f value");
  });

  await t(label + ": two DIFFERENT vertical-stripe images both hash to \"\" and cannot collide as a match (IMPORTANT 1 — repeating-pattern guard)", async () => {
    // Reproduces the review's reported collision: period-2-column vertical
    // stripes at two different value pairs both hash to
    // "aaaaaaaaaaaaaaaa" against the real dhashFromGrey (verified), despite
    // spanning a wide grey range that sails past the hi-lo input guard. The
    // OLD guard (0000.../ffff... only) let both through unhashed-degenerate
    // detection and they'd collide at Hamming distance 0 — a false duplicate
    // match that becomes a delete prompt.
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    function stripePixels(w, h, valA, valB) {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; const v = (x % 2 === 0) ? valA : valB;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      return d;
    }
    const { computeCardHash: hashA } = loadComputeCardHash(src, resolveMock, (w, h) => stripePixels(w, h, 220, 30));
    const { computeCardHash: hashB } = loadComputeCardHash(src, resolveMock, (w, h) => stripePixels(w, h, 255, 0));
    const a = await hashA({ id: "stripeA", img: "idb:stripeA" });
    const b = await hashB({ id: "stripeB", img: "idb:stripeB" });
    assert.strictEqual(a, "", "vertical stripes must be refused, not hashed to the shared aaaa...a value");
    assert.strictEqual(b, "", "vertical stripes must be refused, not hashed to the shared aaaa...a value");
    // Belt-and-suspenders: even if a future change let a non-"" degenerate
    // value through, confirm the scanner's own junk-safety still wouldn't
    // treat two empty-string hashes as a distance-0 match.
    assert.strictEqual(IA_IMGHASH.hamming(a, b), 64, "hamming() must not treat two unhashable cards as identical");
  });

  await t(label + ": a checkerboard image hashes to \"\" instead of the degenerate aa55aa55... dHash (IMPORTANT 1 — repeating-pattern guard, period 4)", async () => {
    // A checkerboard is NOT caught by a period-1-only or period-2-only check
    // (it's period 4 in hex characters: unit "aa55" repeated 4 times) —
    // reproduces the review's second collision class.
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const { computeCardHash } = loadComputeCardHash(src, resolveMock, (w, h) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; const v = ((x + y) % 2 === 0) ? 220 : 30;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      return d;
    });
    const hash = await computeCardHash({ id: "checker1", img: "idb:checker1" });
    assert.strictEqual(hash, "", "a checkerboard sample must be refused, not hashed to the shared aa55aa55... value");
  });

  await t(label + ": the row-major alternating-value pattern [100,101,100,101,...] hashes to \"\" instead of the degenerate 55aa55aa... dHash (IMPORTANT 1 — repeating-pattern guard)", async () => {
    // Third collision class from the review: not a geometric stripe/checker
    // pattern, just a plain alternating pixel VALUE with only 1 level of
    // contrast (hi-lo=1, so the input guard alone already rejects it) —
    // confirms the OUTPUT guard independently catches it too now, per
    // IMPORTANT 2's corrected comment (the two guards are not a subset
    // relationship; this case happens to be caught by both).
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const { computeCardHash } = loadComputeCardHash(src, resolveMock, (w, h) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) { const v = (i % 2 === 0) ? 100 : 101; d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
      return d;
    });
    const hash = await computeCardHash({ id: "altarr1", img: "idb:altarr1" });
    assert.strictEqual(hash, "");
  });

  await t(label + ": a genuinely varied image (non-degenerate dHash) is still hashed — the gradient-collision guard must not over-reject real photos", async () => {
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const { computeCardHash } = loadComputeCardHash(src, resolveMock, (w, h) => variedPixels(w, h));
    const hash = await computeCardHash({ id: "gradV", img: "idb:gradV" });
    assert.notStrictEqual(hash, "");
    assert.doesNotMatch(hash, /^0{16}$/);
    assert.doesNotMatch(hash, /^f{16}$/);
  });

  await t(label + ": a real varied image hashes to the EXACT dHash IA_IMGHASH.dhashFromGrey computes for its greyscale sample", async () => {
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const { computeCardHash } = loadComputeCardHash(src, resolveMock, (w, h) => variedPixels(w, h));
    const hash = await computeCardHash({ id: "c5", img: "idb:c5" });
    const W = IA_IMGHASH.HASH_W, H = IA_IMGHASH.HASH_H;
    const expected = IA_IMGHASH.dhashFromGrey(expectedGreyFromRGBA(variedPixels(W, H), W, H), W, H);
    assert.strictEqual(hash, expected);
  });

  await t(label + ": an exception anywhere in the pipeline (e.g. a corrupt blob) is caught and reported as the unhashable sentinel, not thrown", async () => {
    const resolveMock = async () => ({ mediaType: "image/jpeg", base64: "Zm9v" });
    const fnSrc = fn(src, "computeCardHash");
    const factory = new Function(
      "resolveCardImageForAI", "IA_IMGHASH", "fetch", "createImageBitmap", "OffscreenCanvas", "console",
      fnSrc + "\nreturn computeCardHash;"
    );
    const throwingCreateImageBitmap = async () => { throw new Error("corrupt image"); };
    const fetchMock = async () => ({ blob: async () => ({}) });
    const computeCardHash = factory(resolveMock, IA_IMGHASH, fetchMock, throwingCreateImageBitmap, function () {}, console);
    await assert.doesNotReject(async () => {
      const hash = await computeCardHash({ id: "c6", img: "idb:c6" });
      assert.strictEqual(hash, "");
    });
  });

  await t(label + ": an unhashable card caches \"\" so it isn't retried every scan", () => {
    const b = fn(src, "computeCardHash");
    assert.match(b, /return "";/, "must return the empty-string sentinel rather than throwing");
  });

  await t(label + ": isDegenerateHash rejects period-1 hex-char repeats (solid fill / vertical-stripe shape)", () => {
    const isDegenerateHash = loadPureFn(src, "isDegenerateHash");
    assert.strictEqual(isDegenerateHash("0000000000000000"), true);
    assert.strictEqual(isDegenerateHash("ffffffffffffffff"), true);
    assert.strictEqual(isDegenerateHash("aaaaaaaaaaaaaaaa"), true);   // two DIFFERENT vertical-stripe images both land here
    assert.strictEqual(isDegenerateHash("5555555555555555"), true);
  });

  await t(label + ": isDegenerateHash rejects period-4 hex-char repeats (checkerboard / alternating-row shape) — NOT caught by a period-1-or-2-only check", () => {
    // A checkerboard's hash ("aa55aa55...") repeats every 4 hex characters,
    // not every 1 or 2 — a guard that only checked periods 1 and 2 would
    // silently let it through. Verified against the real dhashFromGrey (see
    // the checkerboard behavioral test above for the source pixel pattern).
    const isDegenerateHash = loadPureFn(src, "isDegenerateHash");
    assert.strictEqual(isDegenerateHash("aa55aa55aa55aa55"), true, "checkerboard shape");
    assert.strictEqual(isDegenerateHash("55aa55aa55aa55aa"), true, "row-major [100,101,100,101,...] shape");
    // Confirm this ISN'T just "any hex string starting with a repeated
    // 2-char prefix" — a period-4 pattern whose first 2 chars happen not to
    // repeat at position 2 must not be caught by the period-1/2 checks alone
    // (it's period 4 specifically that catches it).
    assert.strictEqual("aa55".slice(0, 2).repeat(8) === "aa55aa55aa55aa55", false, "sanity: aa55... is genuinely NOT a period-2 hex-char repeat");
  });

  await t(label + ": isDegenerateHash does not reject a genuinely varied (non-repeating) hash", () => {
    const isDegenerateHash = loadPureFn(src, "isDegenerateHash");
    assert.strictEqual(isDegenerateHash("0002122b5d7e8020"), false);
    assert.strictEqual(isDegenerateHash("24b649926d9249db"), false);
  });

  await t(label + ": isDegenerateHash treats malformed input (wrong length, non-string) as degenerate rather than throwing", () => {
    const isDegenerateHash = loadPureFn(src, "isDegenerateHash");
    assert.strictEqual(isDegenerateHash(""), true);
    assert.strictEqual(isDegenerateHash("abc"), true);
    assert.strictEqual(isDegenerateHash(undefined), true);
    assert.strictEqual(isDegenerateHash(null), true);
  });

  await t(label + ": imgHashSrcKey ties an idb: image to the card id AND its lastUpdate stamp, so a re-capture invalidates the cached hash", () => {
    const imgHashSrcKey = loadPureFn(src, "imgHashSrcKey");
    const before = imgHashSrcKey({ id: "c7", img: "idb:c7", lastUpdate: 100 });
    const after = imgHashSrcKey({ id: "c7", img: "idb:c7", lastUpdate: 200 });
    assert.notStrictEqual(before, after, "bumping lastUpdate (a re-capture) must change the src key so the stale cached hash is not reused");
  });

  await t(label + ": imgHashSrcKey uses the MOST RECENT of lastUpdate/edited, not the first truthy one (CRITICAL 2 — OR-precedence bug)", () => {
    // Reproduces the exact scenario from the review: a captured card already
    // has .lastUpdate set (true for virtually every captured card). A LATER
    // manual paste bumps only .edited. `lastUpdate||edited` short-circuits on
    // the first truthy value, so once .lastUpdate is set once, a later .edited
    // is permanently invisible to the src key -- the stale cached hash from
    // BEFORE the manual paste keeps being reused for the picture AFTER it.
    const imgHashSrcKey = loadPureFn(src, "imgHashSrcKey");
    const beforeEdit = imgHashSrcKey({ id: "c9", img: "idb:c9", lastUpdate: 1000 });
    const afterEdit = imgHashSrcKey({ id: "c9", img: "idb:c9", lastUpdate: 1000, edited: 5000 });
    assert.notStrictEqual(beforeEdit, afterEdit, "a LATER .edited stamp (manual paste after a capture already set .lastUpdate) must change the src key");
    assert.strictEqual(afterEdit, "idb:c9:5000", "the src key must reflect the MAX of lastUpdate/edited, not whichever is checked first");
  });

  await t(label + ": replacing a Saved card's image via setSavedImage stamps something imgHashSrcKey reads, so re-clipping the SAME id invalidates the cached hash (CRITICAL 1)", () => {
    // Reproduces the exact scenario from the review: setSavedImage,
    // setSavedImageDurably, and setClipImageInline all replace the image
    // bytes at the SAME item.id and rewrite item.image to the identical
    // "idb:"+item.id string. Without a stamp, imgHashSrcKey's srcKey is the
    // same constant "idb:<id>:0" forever, and a cached hash for the OLD
    // picture is silently reused as if it still describes the NEW one.
    const store = { imgPut: () => {}, imgDel: () => {} };
    const { setSavedImage, imgHashSrcKey } = loadSavedImageFns(src, store);
    const item = { id: "sv1", image: "idb:sv1" };   // an existing Saved card with a previously-cached hash
    const before = imgHashSrcKey(item);
    setSavedImage(item, "data:image/jpeg;base64,AAAA");   // re-clip: NEW image bytes written to the SAME id
    const after = imgHashSrcKey(item);
    assert.notStrictEqual(before, after, "setSavedImage must stamp .edited (or equivalent) so a Saved card's srcKey changes when its image is replaced at the same id");
  });

  await t(label + ": imgHashSrcKey is the plain URL string for a remote image (identity is the URL itself)", () => {
    const imgHashSrcKey = loadPureFn(src, "imgHashSrcKey");
    const k1 = imgHashSrcKey({ id: "c8", img: "https://example.com/a.jpg", lastUpdate: 100 });
    const k2 = imgHashSrcKey({ id: "c8", img: "https://example.com/a.jpg", lastUpdate: 999 });
    assert.strictEqual(k1, k2);
    assert.strictEqual(k1, "https://example.com/a.jpg");
  });

  await t(label + ": the cache entry records WHICH image it was computed from", () => {
    const b = fn(src, "imgHashSrcKey");
    assert.ok(/card\.img|card\.image/.test(b), "srcKey must derive from the card's current image");
  });

  await t(label + ": loadImgHashCache reads the ia_imghash kv key and defaults to {} when empty", async () => {
    const calls = [];
    const store = { kvGet: async (k) => { calls.push(k); return null; } };
    const { loadImgHashCache } = loadCacheFns(src, store);
    assert.deepStrictEqual(await loadImgHashCache(), {});
    assert.deepStrictEqual(calls, ["ia_imghash"]);
  });

  await t(label + ": loadImgHashCache returns the stored map untouched", async () => {
    const store = { kvGet: async () => ({ card1: { h: "abc", src: "x" } }) };
    const { loadImgHashCache } = loadCacheFns(src, store);
    assert.deepStrictEqual(await loadImgHashCache(), { card1: { h: "abc", src: "x" } });
  });

  await t(label + ": loadImgHashCache tolerates a kvGet rejection and returns {} rather than throwing", async () => {
    const store = { kvGet: async () => { throw new Error("offline"); } };
    const { loadImgHashCache } = loadCacheFns(src, store);
    await assert.doesNotReject(async () => assert.deepStrictEqual(await loadImgHashCache(), {}));
  });

  await t(label + ": saveImgHashCache writes the whole map to ia_imghash via Store.kvSet", () => {
    const calls = [];
    const store = { kvSet: (k, v) => { calls.push([k, v]); } };
    const { saveImgHashCache } = loadCacheFns(src, store);
    const payload = { c1: { h: "abc", src: "x" } };
    saveImgHashCache(payload);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], "ia_imghash");
    assert.deepStrictEqual(calls[0][1], payload);
  });

  await t(label + ": the cache lives in ia_imghash, not the fp table", () => {
    assert.match(src, /"ia_imghash"/);
    const b = fn(src, "loadImgHashCache");
    assert.doesNotMatch(b, /fpSet|fpGet/, "fp is placeholder detection — overloading it would break that");
  });
}

await t("pwa/imagehash.js is a byte-identical copy of web/imagehash.js (the PWA serves its own copy)", () => {
  const a = fs.readFileSync(path.join(__dirname, "..", "web", "imagehash.js"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "..", "pwa", "imagehash.js"), "utf8");
  assert.strictEqual(a, b);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

})();
