// tests/image-dupes.test.js — Task 7: the image-similarity duplicate pass.
//
// The image pass is deliberately a SEPARATE second pass over only the cards
// the url/title pass (scanDuplicates) did NOT already group. It must not
// share a union-find with that pass: with one shared union-find, A~B by image
// plus B~C by title would merge A and C into one group even though nothing
// links A to C directly. Every group produced here becomes a DELETION prompt,
// so a wrong grouping costs the user a card — bias every check toward "does
// not group" being the safe default.
//
// Two defects this file specifically guards against:
//   1. An unhashable card ("" or null hash) must never be grouped. hamming()
//      already returns 64 for malformed input, but the grouper must ALSO
//      skip it explicitly — safety must not depend on a single layer.
//   2. Hamming-distance closeness is NOT transitive. A plain single-linkage
//      union-find over "any pair within maxDistance" lets a CHAIN of
//      near-pairs drag a card that is actually far from the group's other
//      members into the same group (proven below with real hash values: two
//      disjoint 5-bit flips are each within distance 5 of a shared anchor,
//      but 6 bits apart from EACH OTHER — over MAX_DISTANCE). The grouper
//      must guarantee every emitted group is a full pairwise clique (every
//      member within maxDistance of every OTHER member), not just a
//      connected component, or a far card can be transitively pulled into a
//      deletion prompt it was never actually close to.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const { hamming, MAX_DISTANCE } = require("../web/imagehash.js");

const webHtml = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function loadGroupByImageHash(src) {
  const body = extractFn(src, "groupByImageHash");
  assert.ok(body, "groupByImageHash not found in source");
  return eval("(" + body + ")");
}

// --- deterministic hash construction (bit-exact, no hand-transcribed hex) --
function hexFromBits(bits) {
  let big = 0n;
  for (const b of bits) big |= (1n << BigInt(b));
  return big.toString(16).padStart(16, "0");
}

const H_A = "0000000000000000";
const H_A2 = "0000000000000001";   // 1 bit off — same picture, re-encoded
const H_B = "ffffffffffffffff";    // 64 bits off — different picture

for (const [label, src] of [["web", webHtml], ["pwa", pwaHtml]]) {
  const groupByImageHash = loadGroupByImageHash(src);

  t(label + ": groups cards whose hashes are within MAX_DISTANCE", () => {
    const g = groupByImageHash([
      { key: "imported:1", hash: H_A }, { key: "imported:2", hash: H_A2 },
    ], new Set(), hamming, MAX_DISTANCE);
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].length, 2);
  });

  t(label + ": does not group visibly different images", () => {
    const g = groupByImageHash([
      { key: "imported:1", hash: H_A }, { key: "imported:2", hash: H_B },
    ], new Set(), hamming, MAX_DISTANCE);
    assert.strictEqual(g.length, 0);
  });

  t(label + ": skips cards the url/title pass already grouped", () => {
    const g = groupByImageHash([
      { key: "imported:1", hash: H_A }, { key: "imported:2", hash: H_A2 },
    ], new Set(["imported:1"]), hamming, MAX_DISTANCE);
    assert.strictEqual(g.length, 0, "an already-grouped card must not be pulled into a second group");
  });

  t(label + ": ignores unhashable cards entirely (empty string AND null, not just relying on hamming()'s 64)", () => {
    const g = groupByImageHash([
      { key: "imported:1", hash: "" }, { key: "imported:2", hash: "" }, { key: "imported:3", hash: null },
    ], new Set(), hamming, MAX_DISTANCE);
    assert.strictEqual(g.length, 0, "empty/null hashes must never group");
  });

  t(label + ": a lone card is not a group", () => {
    const g = groupByImageHash([{ key: "imported:1", hash: H_A }], new Set(), hamming, MAX_DISTANCE);
    assert.strictEqual(g.length, 0);
  });

  t(label + ": three near-identical images form ONE group, not three pairs", () => {
    const g = groupByImageHash([
      { key: "a", hash: "0000000000000000" }, { key: "b", hash: "0000000000000001" }, { key: "c", hash: "0000000000000003" },
    ], new Set(), hamming, MAX_DISTANCE);
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].length, 3);
  });

  t(label + ": a chain of pairwise-near hashes cannot transitively drag in a card that is far from the rest", () => {
    // A and B are exactly MAX_DISTANCE apart (5 disjoint bits). B and C are
    // very close (1 bit apart) but via a DIFFERENT bit, so A and C land 6
    // bits apart — over MAX_DISTANCE. A naive union-find over "any pair
    // within maxDistance" would still merge all three via the A-B and B-C
    // edges. The grouper must not do that: A and C were never actually close.
    const A = hexFromBits([]);
    const B = hexFromBits([0, 1, 2, 3, 4]);
    const C = hexFromBits([0, 1, 2, 3, 4, 10]);
    // Positive control: prove the fixture really has the claimed shape
    // against the REAL hamming(), not an assumption about bit arithmetic.
    assert.strictEqual(hamming(A, B), 5, "fixture sanity: A-B must be exactly MAX_DISTANCE");
    assert.strictEqual(hamming(B, C), 1, "fixture sanity: B-C must be well within MAX_DISTANCE");
    assert.strictEqual(hamming(A, C), 6, "fixture sanity: A-C must exceed MAX_DISTANCE");

    const g = groupByImageHash([
      { key: "a", hash: A }, { key: "b", hash: B }, { key: "c", hash: C },
    ], new Set(), hamming, MAX_DISTANCE);
    const allKeys = g.flatMap(grp => grp.map(e => e.key));
    assert.ok(!(allKeys.includes("a") && allKeys.includes("c") && g.some(grp => grp.length === 3)),
      "a and c must never end up in the same group — they are 6 bits apart, over MAX_DISTANCE");
    for (const grp of g) {
      assert.ok(!(grp.some(e => e.key === "a") && grp.some(e => e.key === "c")),
        "no single emitted group may contain both a and c");
    }
  });

  t(label + ": two independent close clusters stay separate groups, not merged via a cross-cluster near-miss", () => {
    const g = groupByImageHash([
      { key: "a", hash: "0000000000000000" }, { key: "b", hash: "0000000000000001" },
      { key: "c", hash: "ffffffffffffffff" }, { key: "d", hash: "fffffffffffffffe" },
    ], new Set(), hamming, MAX_DISTANCE);
    assert.strictEqual(g.length, 2, "expected exactly two independent groups");
    const keysets = g.map(grp => grp.map(e => e.key).sort().join(","));
    assert.ok(keysets.includes("a,b"), "a and b must be grouped together");
    assert.ok(keysets.includes("c,d"), "c and d must be grouped together");
  });

  t(label + ": every emitted group is a full pairwise clique (every member within maxDistance of every OTHER member)", () => {
    // General property check, not just the two hand-built scenarios above:
    // for any group groupByImageHash emits, every pairwise hamming distance
    // inside it must be <= MAX_DISTANCE. A single-linkage (union-find)
    // grouper can violate this; a clique-based one cannot.
    const entries = [
      { key: "a", hash: hexFromBits([]) },
      { key: "b", hash: hexFromBits([0, 1, 2, 3, 4]) },
      { key: "c", hash: hexFromBits([0, 1, 2, 3, 4, 10]) },
      { key: "d", hash: hexFromBits([0, 1]) },
      { key: "e", hash: "ffffffffffffffff" },
    ];
    const g = groupByImageHash(entries, new Set(), hamming, MAX_DISTANCE);
    for (const grp of g) {
      for (let i = 0; i < grp.length; i++) {
        for (let j = i + 1; j < grp.length; j++) {
          assert.ok(hamming(grp[i].hash, grp[j].hash) <= MAX_DISTANCE,
            "group member " + grp[i].key + " and " + grp[j].key + " exceed MAX_DISTANCE but were grouped together");
        }
      }
    }
  });
}

t("groupByImageHash is byte-identical between web and pwa", () => {
  const a = extractFn(webHtml, "groupByImageHash");
  const b = extractFn(pwaHtml, "groupByImageHash");
  assert.ok(a && b);
  assert.strictEqual(a, b);
});

t("scanImageDuplicates is byte-identical between web and pwa", () => {
  const a = extractFn(webHtml, "scanImageDuplicates");
  const b = extractFn(pwaHtml, "scanImageDuplicates");
  assert.ok(a && b, "scanImageDuplicates not found in one or both sources");
  assert.strictEqual(a, b);
});

// --- scanImageDuplicates: wiring/composition checks on the real source ----
// scanImageDuplicates depends on browser globals (imported/saved/IA_IMGHASH/
// Store/loadImgHashCache/computeCardHash) that would need heavy mocking to
// execute directly — Task 6's suite already covers computeCardHash and the
// hash cache in isolation. Here we check the REAL extracted source composes
// those already-tested pieces correctly, the same lightweight technique
// tests/imagehash-cache-wiring.test.js uses for "the cache lives in
// ia_imghash, not the fp table".
for (const [label, src] of [["web", webHtml], ["pwa", pwaHtml]]) {
  const body = extractFn(src, "scanImageDuplicates");

  t(label + ": scanImageDuplicates is async (loadImgHashCache/computeCardHash are awaited)", () => {
    assert.ok(body, "scanImageDuplicates not found");
    assert.match(src, /async function scanImageDuplicates\(/);
  });

  t(label + ": scanImageDuplicates only hashes cards NOT already grouped by the url/title pass", () => {
    assert.match(body, /alreadyGroupedKeys/);
    assert.match(body, /!alreadyGroupedKeys\.has\(m\.key\)/, "must filter members by the already-grouped key set before hashing");
  });

  t(label + ": scanImageDuplicates reuses the Task 6 hash cache (loadImgHashCache/saveImgHashCache), not a fresh recompute every time", () => {
    assert.match(body, /loadImgHashCache\(\)/);
    assert.match(body, /saveImgHashCache\(/);
    assert.match(body, /imgHashSrcKey\(/, "must invalidate on the card's current image, not trust a stale cache entry unconditionally");
  });

  t(label + ": scanImageDuplicates groups via groupByImageHash using IA_IMGHASH.hamming and IA_IMGHASH.MAX_DISTANCE", () => {
    assert.match(body, /groupByImageHash\(/);
    assert.match(body, /IA_IMGHASH\.hamming/);
    assert.match(body, /IA_IMGHASH\.MAX_DISTANCE/);
  });

  t(label + ": scanImageDuplicates passes alreadyGroupedKeys into groupByImageHash too (defense in depth, not relying on the earlier filter alone)", () => {
    assert.match(body, /groupByImageHash\(todo,\s*alreadyGroupedKeys/, "the safety of skipping already-grouped cards must not depend on the `todo` filter alone");
  });

  t(label + ": scanImageDuplicates marks every result imageMatch:true so the UI can badge/leave-unchecked these groups", () => {
    assert.match(body, /imageMatch:\s*true/);
  });

  t(label + ": scanImageDuplicates reuses dupeGroupDismissed/dupeMemberKey/dupePrimary rather than reimplementing dismissal or keep-pick logic", () => {
    assert.match(body, /dupeGroupDismissed\(/);
    assert.match(body, /dupeMemberKey\(/);
    assert.match(body, /dupePrimary\(/);
  });

  t(label + ": scanImageDuplicates respects an abort flag so closing the modal mid-scan doesn't run to completion", () => {
    assert.match(src, /let _imgScanAbort\s*=\s*false;/);
    assert.match(body, /_imgScanAbort/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
