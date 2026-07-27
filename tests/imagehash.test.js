// tests/imagehash.test.js — dHash + Hamming. Pure functions: the greyscale
// sampling lives in the browser, the bit math lives here so it can be tested.
const assert = require("assert");
const { dhashFromGrey, hamming, HASH_W, HASH_H, MAX_DISTANCE } = require("../web/imagehash.js");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }

function grey(fn) {
  const out = new Uint8Array(HASH_W * HASH_H);
  for (let y = 0; y < HASH_H; y++) for (let x = 0; x < HASH_W; x++) out[y * HASH_W + x] = fn(x, y);
  return out;
}

t("produces 16 hex chars (64 bits)", () => {
  const h = dhashFromGrey(grey((x) => x * 20));
  assert.strictEqual(h.length, 16);
  assert.match(h, /^[0-9a-f]{16}$/);
});

t("is deterministic", () => {
  const g = grey((x, y) => (x * 7 + y * 13) % 256);
  assert.strictEqual(dhashFromGrey(g), dhashFromGrey(g));
});

t("a left-to-right ramp is all zero bits; its mirror is all ones", () => {
  // dHash asks "is this pixel brighter than the one to its right?"
  assert.strictEqual(dhashFromGrey(grey((x) => x * 20)), "0000000000000000");
  assert.strictEqual(dhashFromGrey(grey((x) => 200 - x * 20)), "ffffffffffffffff");
});

t("hamming: identical is 0, inverted is 64", () => {
  assert.strictEqual(hamming("0000000000000000", "0000000000000000"), 0);
  assert.strictEqual(hamming("ffffffffffffffff", "0000000000000000"), 64);
});

t("hamming: counts single-bit differences", () => {
  assert.strictEqual(hamming("0000000000000001", "0000000000000000"), 1);
  assert.strictEqual(hamming("0000000000000003", "0000000000000000"), 2);
});

t("hamming: missing or malformed input is maximally distant, never 0", () => {
  // Returning 0 for junk would group every unhashable card together — the
  // worst possible failure mode when the outcome is deletion.
  assert.strictEqual(hamming("", ""), 64);
  assert.strictEqual(hamming(null, "0000000000000000"), 64);
  assert.strictEqual(hamming("abc", "0000000000000000"), 64);
});

t("a small brightness shift stays within MAX_DISTANCE; a different image does not", () => {
  // A pattern with real mixed bits (not a plain monotonic ramp), so this test
  // can't be satisfied by any MAX_DISTANCE between 0 and 63 — see below.
  const baseFn = (x, y) => (x * x * 3 + y * 17 + ((x * y) % 7) * 11) % 256;
  const base = grey(baseFn);
  const shifted = grey((x, y) => Math.min(255, baseFn(x, y) + 4));   // re-compression noise
  assert.ok(hamming(dhashFromGrey(base), dhashFromGrey(shifted)) <= MAX_DISTANCE);
  // A genuinely different picture: mirrored horizontal gradient (brightness
  // falls left-to-right instead of rising) with an unrelated vertical term.
  // NOTE: dHash only compares horizontal neighbors, so a fixture that merely
  // reweights x/y coefficients while keeping the row brightness *rising*
  // (e.g. (y*37 + x*5) % 256) hashes almost identically to `base` — both are
  // monotonic left-to-right, so the per-row bits come out the same regardless
  // of the y term. The fixture must flip the horizontal direction to actually
  // exercise "different image". Also avoid an all-0s-vs-all-1s pair here (that's
  // already covered by the "inverted is 64" test above and would let MAX_DISTANCE
  // be anything from 0 to 63 without failing this assertion).
  const other = grey((x, y) => (200 - x * 22 + y * 31) % 256);
  assert.ok(hamming(dhashFromGrey(base), dhashFromGrey(other)) > MAX_DISTANCE);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
