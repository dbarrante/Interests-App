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

for (const name of ["splitGroupsOnTextConflict", "ocrTextConflicts", "ocrTextOverlap", "normalizeOcrWords"]) {
  t(name + " is byte-identical between web and pwa", () => {
    const a = extractFn(webHtml, name), b = extractFn(pwaHtml, name);
    assert.ok(a && b, name + " not found in one or both sources");
    assert.strictEqual(a, b);
  });
}

// The test harness INJECTS IMAGE_GROUP_SIZE_CAP/OCR_TEXT_CONFLICT_THRESHOLD as
// sandbox parameters everywhere else in this file (so behavior can be tested
// against controlled values) -- which means nothing else in this suite ever
// reads the REAL declared value in web/pwa index.html. web and pwa could
// silently disagree (e.g. pwa left at a stale/different cap) with every other
// test here still green (data-safety review finding). Pin the literal value
// in both real sources directly.
for (const [label, src] of [["web", webHtml], ["pwa", pwaHtml]]) {
  t(label + ": IMAGE_GROUP_SIZE_CAP is declared as exactly 8", () => {
    assert.match(src, /const IMAGE_GROUP_SIZE_CAP = 8;/);
  });
  t(label + ": OCR_TEXT_CONFLICT_THRESHOLD is declared as exactly 0.35", () => {
    assert.match(src, /const OCR_TEXT_CONFLICT_THRESHOLD = 0\.35;/);
  });
}

// --- OCR-text-conflict pure functions (Task: "look at the text in the
// pictures too" — dHash's 9x8 sample can't see text at all; two DIFFERENT
// pictures sharing a template/UI-chrome can still land within MAX_DISTANCE.
// OCR is the second, independent signal that can see past that. ---------
function loadOcrFns(src) {
  const names = ["ocrTextOverlap", "ocrTextConflicts", "normalizeOcrWords"];
  const body = names.map(n => extractFn(src, n)).join("\n");
  const factory = new Function("OCR_TEXT_CONFLICT_THRESHOLD", body + "\nreturn {ocrTextOverlap, ocrTextConflicts, normalizeOcrWords};");
  return factory(0.35);
}

for (const [label, src] of [["web", webHtml], ["pwa", pwaHtml]]) {
  const { ocrTextOverlap, ocrTextConflicts } = loadOcrFns(src);

  t(label + ": identical text never conflicts", () => {
    assert.strictEqual(ocrTextOverlap("Happy New Year Messages", "Happy New Year Messages"), 1);
    assert.ok(!ocrTextConflicts("Happy New Year Messages", "Happy New Year Messages"));
  });

  t(label + ": the same text with minor OCR noise (case, punctuation, a dropped word) stays well clear of conflict", () => {
    assert.ok(!ocrTextConflicts("Happy New Year Messages", "happy new year, messages"));
  });

  t(label + ": completely unrelated captions conflict (the Instagram-reels false-positive case)", () => {
    // Real text extracted from this app's own library during diagnosis: two
    // different Reels screenshots sharing the same viewer UI chrome, whose
    // ACTUAL captions have nothing to do with each other.
    assert.ok(ocrTextConflicts(
      "Happy New Year Messages",
      "As the U.S. and Israel launched military strikes deep inside Iran"
    ), "a New Year greeting and a war-news caption must be treated as conflicting text");
  });

  t(label + ": shared UI-chrome words alone are not enough to call two captions the same", () => {
    // Both share only generic app-chrome tokens ("Messages"); the real
    // content ("bio" promo vs a philosophical quote about borders) differs.
    assert.ok(ocrTextConflicts(
      "Get yours in our bio Messages",
      "If borders arent real neither are property lines Messages"
    ));
  });

  t(label + ": either side empty/near-empty never causes a conflict (a weak OCR read must never manufacture evidence)", () => {
    assert.strictEqual(ocrTextOverlap("", "Some real caption here"), 1);
    assert.ok(!ocrTextConflicts("", "Some real caption here"));
    assert.ok(!ocrTextConflicts("!!! ??? ...", "Some real caption here"));
  });

  t(label + ": normalization ignores case, punctuation, and spacing differences", () => {
    assert.strictEqual(ocrTextOverlap("Hello, World!", "hello   world"), 1);
  });
}

// --- splitGroupsOnTextConflict: the safety-preserving post-processor over
// groupByImageHash's output. Can only ever shrink/drop a group, never grow
// one or merge two of groupByImageHash's groups together. -----------------
function loadSplitFn(src) {
  const names = ["splitGroupsOnTextConflict"];
  const body = names.map(n => extractFn(src, n)).join("\n");
  return new Function(body + "\nreturn splitGroupsOnTextConflict;")();
}

for (const [label, src] of [["web", webHtml], ["pwa", pwaHtml]]) {
  const splitGroupsOnTextConflict = loadSplitFn(src);
  const CONFLICTS = (a, b) => a !== b;   // simple test predicate: any different label conflicts

  t(label + ": a group where two members' text conflicts is split apart", () => {
    const groups = splitGroupsOnTextConflict(
      [[{ key: "a" }, { key: "b" }]],
      { a: "topic-1", b: "topic-2" },
      CONFLICTS
    );
    assert.strictEqual(groups.length, 0, "a conflicting pair must not survive as a group at all");
  });

  t(label + ": a group where text agrees stays together", () => {
    const groups = splitGroupsOnTextConflict(
      [[{ key: "a" }, { key: "b" }]],
      { a: "topic-1", b: "topic-1" },
      CONFLICTS
    );
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].length, 2);
  });

  t(label + ": a member with NO extracted text is never treated as conflicting -- insufficient evidence, not evidence of difference", () => {
    const groups = splitGroupsOnTextConflict(
      [[{ key: "a" }, { key: "b" }]],
      { a: "topic-1" },   // b has no entry at all -- OCR found nothing usable
      CONFLICTS
    );
    assert.strictEqual(groups.length, 1, "missing OCR text on one side must fall back to hash-only behavior (keep grouped)");
  });

  t(label + ": both members missing text also keeps the group together (today's unchanged behavior)", () => {
    const groups = splitGroupsOnTextConflict([[{ key: "a" }, { key: "b" }]], {}, CONFLICTS);
    assert.strictEqual(groups.length, 1);
  });

  t(label + ": a 3-member group where one member conflicts with the other two shrinks to a pair, dropping the odd one out", () => {
    const groups = splitGroupsOnTextConflict(
      [[{ key: "a" }, { key: "b" }, { key: "c" }]],
      { a: "topic-1", b: "topic-1", c: "topic-2" },
      CONFLICTS
    );
    const allKeys = groups.flatMap(g => g.map(e => e.key)).sort();
    assert.deepStrictEqual(allKeys, ["a", "b"], "c must be excluded; a and b (agreeing text) must survive as a pair");
  });

  t(label + ": never merges two SEPARATE groupByImageHash groups together, even if their text happens to agree", () => {
    const groups = splitGroupsOnTextConflict(
      [[{ key: "a" }, { key: "b" }], [{ key: "c" }, { key: "d" }]],
      { a: "same", b: "same", c: "same", d: "same" },
      CONFLICTS
    );
    assert.strictEqual(groups.length, 2, "two distinct hash-matched groups must never be combined into one");
    const keysets = groups.map(g => g.map(e => e.key).sort().join(",")).sort();
    assert.deepStrictEqual(keysets, ["a,b", "c,d"]);
  });

  t(label + ": can only shrink or drop groups, never grow one beyond its original members", () => {
    const input = [[{ key: "a" }, { key: "b" }, { key: "c" }]];
    const groups = splitGroupsOnTextConflict(input, {}, CONFLICTS);   // no text at all -> nothing to split
    const outKeys = groups.flatMap(g => g.map(e => e.key));
    assert.ok(outKeys.every(k => ["a", "b", "c"].includes(k)), "output must never contain a member absent from the input group");
  });
}

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

  t(label + ": scanImageDuplicates excludes oversized cliques BEFORE any OCR is spent (placeholder-cluster guard)", () => {
    const capIdx = body.search(/groups\s*=\s*groups\.filter\(mem\s*=>\s*mem\.length\s*<=\s*IMAGE_GROUP_SIZE_CAP\)/);
    const ocrIdx = body.indexOf("loadImgOcrCache()");
    assert.ok(capIdx >= 0, "must filter groups by IMAGE_GROUP_SIZE_CAP");
    assert.ok(ocrIdx >= 0, "must load the OCR cache");
    assert.ok(capIdx < ocrIdx, "the size-cap filter must run BEFORE any OCR work, not after -- excluding by count alone must cost nothing");
  });

  t(label + ": scanImageDuplicates runs OCR only over members of surviving (post-size-cap) candidate groups, not the whole library", () => {
    assert.match(body, /groups\.forEach\(mem\s*=>\s*mem\.forEach\(e\s*=>/, "OCR candidates must be gathered FROM the groups, not from `members`/`todo`/the full library");
    assert.doesNotMatch(body, /todo\.forEach\([^)]*ocrExtractText/, "must not run OCR over the full `todo` list");
  });

  t(label + ": scanImageDuplicates never caches a null/failed OCR result -- only a successful extraction is written to ia_imgocr", () => {
    assert.match(body, /if\(text\)\{\s*\n\s*ocrCache\[e\.card\.id\]\s*=\s*\{\s*text,\s*src\s*\}/,
      "a null OCR result must never be written to the cache, or a transient failure becomes permanent \"no text\" (same bug class computeCardHash's null-vs-\"\" split already guards against)");
  });

  t(label + ": scanImageDuplicates splits groups on OCR text conflict via splitGroupsOnTextConflict/ocrTextConflicts, not a bespoke re-grouping", () => {
    assert.match(body, /splitGroupsOnTextConflict\(groups,\s*textByKey,\s*ocrTextConflicts\)/);
  });

  t(label + ": scanImageDuplicates falls back to normTitle for any member OCR found nothing for, BEFORE the split runs", () => {
    const titleFallbackIdx = body.search(/const nt = normTitle\(e\.card && e\.card\.title\)/);
    const splitIdx = body.indexOf("groups = ocrAborted ? [] : splitGroupsOnTextConflict");
    assert.ok(titleFallbackIdx >= 0, "title-fallback line not found");
    assert.ok(splitIdx > titleFallbackIdx, "the title fallback must run BEFORE the split, or it never affects the result");
    assert.match(body, /if\(!\(e\.key in textByKey\)\)/, "must only fill in members OCR found NOTHING for -- OCR must never be overridden by title");
  });

  t(label + ": the OCR loop references _imgScanAbort at all (source smoke check only -- see the BEHAVIORAL abort tests below for proof it actually stops)", () => {
    const ocrLoopStart = body.indexOf("for(const e of ocrMembers)");
    const ocrBlockEnd = body.indexOf("ocrAborted ? [] : splitGroupsOnTextConflict", ocrLoopStart);
    assert.ok(ocrLoopStart >= 0, "OCR loop not found");
    assert.ok(ocrBlockEnd > ocrLoopStart, "end-of-OCR-block marker not found");
    const ocrLoopBody = body.slice(ocrLoopStart, ocrBlockEnd);
    assert.match(ocrLoopBody, /_imgScanAbort/, "the OCR loop must be abortable exactly like the hash loop above it");
  });

  t(label + ": scanImageDuplicates tags onProgress calls with a phase (\"hash\" then \"ocr\") so the UI can tell the two apart", () => {
    assert.match(body, /onProgress\([^)]*,\s*"hash"\)/);
    assert.match(body, /onProgress\([^)]*,\s*"ocr"\)/);
  });
}

// --- Property test: groupByImageHash over randomized inputs (Part A carry-
// over fix #1 — determinism) --------------------------------------------
// The hand-built fixtures above prove specific shapes are handled correctly.
// This generates ~200 randomized variations — plain random noise, guaranteed-
// clique clusters, and (most importantly) the CONTESTED "bridge" shape from
// the chain-fixture above (A-B exactly MAX_DISTANCE, B-C well within it, A-C
// just OVER it) with randomized anchors/bit positions each trial — and checks
// on every trial that (a) every emitted group is a full pairwise clique and
// (b) no card appears in two groups, THEN shuffles the input and re-runs,
// asserting the exact same groups come out. Verified against the pre-fix
// (unsorted) implementation: this generator produces mismatches in ~1/3 of
// trials there, and zero against the fixed (sorted) implementation — a
// generator built only from guaranteed cliques would pass either way (greedy
// order can't change an unambiguous clique's outcome), so the bridge shape is
// load-bearing for actually exercising the fix.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randHexHash(rand) {
  let hex = "";
  for (let i = 0; i < 16; i++) hex += Math.floor(rand() * 16).toString(16);
  return hex;
}
function flipBits(hexBase, bitPositions) {
  let big = BigInt("0x" + hexBase);
  for (const b of bitPositions) big ^= (1n << BigInt(b));
  return big.toString(16).padStart(16, "0");
}
function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}
function pickBitPool(rand, count) {
  const pool = [];
  while (pool.length < count) {
    const b = Math.floor(rand() * 64);
    if (pool.indexOf(b) < 0) pool.push(b);
  }
  return pool;
}
function normalizeGroups(groups) {
  return groups
    .map(grp => grp.map(e => e.key).slice().sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(arr => arr.join(","));
}

t("groupByImageHash property: 200 randomized trials — every emitted group is a full clique, no card in two groups, and the result is order-stable under shuffling", () => {
  const groupByImageHash = loadGroupByImageHash(webHtml);   // pwa is asserted byte-identical above
  const rand = mulberry32(20260727);   // fixed seed: reproducible, not flaky
  const TRIALS = 200;
  for (let trial = 0; trial < TRIALS; trial++) {
    let seq = 0;
    const entries = [];
    // Plain random noise — mostly far apart, occasionally close by sheer
    // chance; either way the invariants below must hold regardless.
    const noiseCount = 3 + Math.floor(rand() * 6);
    for (let i = 0; i < noiseCount; i++) entries.push({ key: "n" + (seq++), hash: randHexHash(rand) });
    // Deliberately tight clusters — guaranteed cliques (<=2 bits off a shared
    // anchor, so any two members are within 4 bits of each other, safely
    // under MAX_DISTANCE=5). These exercise ordinary grouping, not the
    // order-sensitive path.
    const clusterCount = 1 + Math.floor(rand() * 2);
    for (let c = 0; c < clusterCount; c++) {
      const anchor = randHexHash(rand);
      const size = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < size; i++) {
        const bits = pickBitPool(rand, Math.floor(rand() * 3));   // 0-2 bits
        entries.push({ key: "c" + (seq++), hash: flipBits(anchor, bits) });
      }
    }
    // The contested bridge shape: A-B is exactly MAX_DISTANCE apart, B-C is 1
    // bit apart (via a DIFFERENT bit), so A-C lands MAX_DISTANCE+1 apart —
    // over the limit. Whichever of A or C the greedy pass visits first wins
    // B; this is the shape where array order actually decides the outcome.
    if (rand() < 0.7) {
      const base = randHexHash(rand);
      const bitsAB = pickBitPool(rand, MAX_DISTANCE);
      let bitC = Math.floor(rand() * 64);
      while (bitsAB.indexOf(bitC) >= 0) bitC = Math.floor(rand() * 64);
      const A = base;
      const B = flipBits(base, bitsAB);
      const C = flipBits(B, [bitC]);
      entries.push({ key: "bridgeA" + (seq++), hash: A });
      entries.push({ key: "bridgeB" + (seq++), hash: B });
      entries.push({ key: "bridgeC" + (seq++), hash: C });
    }

    const groups1 = groupByImageHash(entries, new Set(), hamming, MAX_DISTANCE);
    // (a) every emitted group is a full pairwise clique
    for (const grp of groups1) {
      for (let i = 0; i < grp.length; i++) {
        for (let j = i + 1; j < grp.length; j++) {
          assert.ok(hamming(grp[i].hash, grp[j].hash) <= MAX_DISTANCE,
            "trial " + trial + ": " + grp[i].key + " and " + grp[j].key + " exceed MAX_DISTANCE but were grouped together");
        }
      }
    }
    // (b) no card appears in two groups
    const seen = new Set();
    for (const grp of groups1) {
      for (const e of grp) {
        assert.ok(!seen.has(e.key), "trial " + trial + ": " + e.key + " appeared in more than one group");
        seen.add(e.key);
      }
    }
    // Order-stability: shuffling the input must produce the SAME groups.
    const groups2 = groupByImageHash(shuffled(entries, rand), new Set(), hamming, MAX_DISTANCE);
    assert.deepStrictEqual(normalizeGroups(groups2), normalizeGroups(groups1),
      "trial " + trial + ": shuffling the input array changed which groups were formed");
  }
});

console.log(pass + " passed, " + fail + " failed");

// --- Behavioral tests for scanImageDuplicates's internal loop (Part A
// carry-over fixes #2 and #3 — checkpoint cadence and final progress tick) -
// Extracted and run against scripted deps (same technique
// tests/imagehash-cache-wiring.test.js uses for computeCardHash) so the
// ACTUAL shipped loop is exercised, not a reimplementation of it. Async,
// so these run in a trailing IIFE after the synchronous tests above finish
// (the shared pass/fail counters and final summary/exit are relocated here).
function loadScanImageDuplicates(src, deps) {
  // scanImageDuplicates calls groupByImageHash, splitGroupsOnTextConflict, and
  // ocrTextConflicts internally — every function declaration it calls must
  // share the sandbox scope (same trap the cache-wiring suite already
  // documented for computeCardHash/isDegenerateHash): omitting one here would
  // throw a ReferenceError deep inside the call, which is NOT swallowed
  // (scanImageDuplicates has no try/catch of its own around these calls), so
  // this is a load-bearing inclusion list, not decoration.
  const fnSrc = ["groupByImageHash", "splitGroupsOnTextConflict", "ocrTextConflicts", "normalizeOcrWords", "ocrTextOverlap", "normTitle", "scanImageDuplicates"]
    .map(n => extractFn(src, n)).join("\n");
  assert.ok(fnSrc, "scanImageDuplicates (or one of its dependencies) not found");
  // _imgScanAbort is shadowed by an inner `let` seeded from the factory
  // param, then exposed as a `.setAbort()` on the returned function -- a
  // real running scan can be aborted MID-LOOP this way (data-safety review:
  // the previous version passed it as a plain snapshotted parameter, which
  // could never change once scanImageDuplicates started running, so the
  // structural "does _imgScanAbort appear in the source" checks below were
  // the only thing standing in for actual abort behavior).
  const factory = new Function(
    "imported", "saved", "loadImgHashCache", "saveImgHashCache", "imgHashSrcKey", "computeCardHash",
    "IA_IMGHASH", "dupeGroupDismissed", "dupeMemberKey", "dupePrimary", "isBadImg", "_imgScanAbortInit",
    "IMAGE_GROUP_SIZE_CAP", "OCR_TEXT_CONFLICT_THRESHOLD", "loadImgOcrCache", "saveImgOcrCache", "ocrExtractText",
    "let _imgScanAbort = _imgScanAbortInit;\n" + fnSrc +
    "\nreturn Object.assign(scanImageDuplicates, { setAbort: (v) => { _imgScanAbort = v; } });"
  );
  return factory(
    deps.imported, deps.saved, deps.loadImgHashCache, deps.saveImgHashCache, deps.imgHashSrcKey,
    deps.computeCardHash, deps.IA_IMGHASH, deps.dupeGroupDismissed, deps.dupeMemberKey, deps.dupePrimary,
    deps.isBadImg, deps._imgScanAbort, deps.IMAGE_GROUP_SIZE_CAP, deps.OCR_TEXT_CONFLICT_THRESHOLD,
    deps.loadImgOcrCache, deps.saveImgOcrCache, deps.ocrExtractText
  );
}
function baseDeps(cards) {
  return {
    imported: cards, saved: [],
    loadImgHashCache: async () => ({}),
    saveImgHashCache: () => {},
    imgHashSrcKey: (card) => "src-" + card.id,
    computeCardHash: async () => "1111111111111111",
    IA_IMGHASH: { hamming: () => 64, MAX_DISTANCE: 5 },
    dupeGroupDismissed: () => false,
    dupeMemberKey: (m) => m.scope + ":" + m.card.id,
    dupePrimary: (members) => members[0],
    isBadImg: () => false,   // by default no card is a placeholder; the exclusion test overrides this
    _imgScanAbort: false,
    IMAGE_GROUP_SIZE_CAP: 8,
    OCR_TEXT_CONFLICT_THRESHOLD: 0.35,
    loadImgOcrCache: async () => ({}),
    saveImgOcrCache: () => {},
    ocrExtractText: async () => null,   // by default no card yields OCR text; conflict tests override this
  };
}
async function at(n, fn) {
  try { await fn(); pass++; console.log("  ok  " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
}

(async () => {
  for (const [label, src] of [["web", webHtml], ["pwa", pwaHtml]]) {
    await at(label + ": scanImageDuplicates checkpoints on the 25th ACTUAL RECOMPUTE, not the 25th mixed hit/miss item", async () => {
      // 31 items. The old (buggy) code checked `done % 25 === 0` inside the
      // miss branch using the mixed hit/miss counter (`done` read BEFORE
      // increment) -- so the only positions where that check could ever fire
      // are array positions 0 and 25 (0, 25, 50, ... within a 31-item run).
      // Both of those positions are made cache HITS here, so the old code's
      // checkpoint branch is never reached at all in this run (proven against
      // the actual pre-fix source below). All 25 OTHER positions are cache
      // MISSES (recomputes) -- exactly 25 of them, spread on both sides of
      // position 25. The fix checkpoints on the recompute COUNT directly, so
      // it still fires exactly once, on the 25th miss, regardless of which
      // array positions the misses land on.
      const HIT_IDS = new Set(["c0", "c1", "c2", "c3", "c4", "c25"]);   // positions 0 and 25 (plus padding)
      const cards = [];
      for (let i = 0; i < 31; i++) cards.push({ id: "c" + i });   // 6 hits + 25 misses
      const cache = {};
      for (const id of HIT_IDS) cache[id] = { h: "0000000000000000", src: "hit-" + id };
      let saveCalls = 0;
      const deps = Object.assign(baseDeps(cards), {
        loadImgHashCache: async () => cache,
        saveImgHashCache: () => { saveCalls++; },
        imgHashSrcKey: (card) => (HIT_IDS.has(card.id) ? "hit-" + card.id : "miss-" + card.id),
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      await scanImageDuplicates(new Set(), null);
      // Exactly 2 calls expected: the mid-run checkpoint at the 25th
      // recompute, plus the guaranteed final save after the loop. The old
      // hit/miss-counter code produces only 1 (the final save only) against
      // this fixture -- verified against the actual pre-fix committed source.
      assert.strictEqual(saveCalls, 2, "expected one mid-run checkpoint (25th recompute) plus the final save; got " + saveCalls + " total saveImgHashCache calls");
    });

    await at(label + ": scanImageDuplicates guarantees a final onProgress tick even when the total isn't a multiple of 10", async () => {
      const cards = [];
      for (let i = 0; i < 23; i++) cards.push({ id: "c" + i });   // 23: not a multiple of 10
      const progressTicks = [];
      const scanImageDuplicates = loadScanImageDuplicates(src, baseDeps(cards));
      await scanImageDuplicates(new Set(), (done) => progressTicks.push(done));
      assert.deepStrictEqual(progressTicks, [10, 20, 23], "must tick at every 10 AND at the final count, even though 23 isn't a multiple of 10");
    });

    await at(label + ": scanImageDuplicates does not double-tick when the total IS an exact multiple of 10", () => {
      const cards = [];
      for (let i = 0; i < 20; i++) cards.push({ id: "c" + i });
      const progressTicks = [];
      const scanImageDuplicates = loadScanImageDuplicates(src, baseDeps(cards));
      return scanImageDuplicates(new Set(), (done) => progressTicks.push(done)).then(() => {
        assert.deepStrictEqual(progressTicks, [10, 20]);
      });
    });

    await at(label + ": scanImageDuplicates never caches a TRANSIENT computeCardHash failure (null) -- the same card is retried on the next scan and can succeed (F3)", async () => {
      // Before this fix, computeCardHash returned "" for both a genuine
      // unhashable verdict AND a plain fetch failure, and this loop cached
      // whatever it got back keyed on the card's CURRENT image -- for a
      // remote card that key never changes on its own, so one transient
      // failure (e.g. a server restart mid-scan) would zero the card's
      // duplicate detection forever; not a rescan, not closing/reopening the
      // modal, nothing short of a code-level guard-version bump could clear
      // it. `persisted` stands in for the real KV-backed cache and is reused
      // across TWO separate scanImageDuplicates calls below, the same way
      // the real cache survives between two runs of the health modal.
      const persisted = {};
      let calls = 0;
      const computeCardHash = async () => (++calls === 1 ? null : "1111111111111111");   // fails once, then succeeds
      const deps = Object.assign(baseDeps([{ id: "c0" }]), {
        loadImgHashCache: async () => persisted,
        saveImgHashCache: () => {},   // `persisted` IS the object scanImageDuplicates mutates in place -- nothing extra to persist here
        computeCardHash,
      });

      const firstScan = loadScanImageDuplicates(src, deps);
      await firstScan(new Set(), null);
      assert.strictEqual(calls, 1, "computeCardHash must be attempted on the first scan");
      assert.ok(!("c0" in persisted), "a transient (null) result must never be written to the cache -- caching it would make the failure permanent");

      const secondScan = loadScanImageDuplicates(src, deps);
      await secondScan(new Set(), null);
      assert.strictEqual(calls, 2, "an uncached (previously-failed) card must be retried on the next scan, not silently skipped forever");
      assert.ok(persisted.c0 && persisted.c0.h === "1111111111111111", "a successful retry must be cached normally, exactly like any other verdict");
    });

    await at(label + ": scanImageDuplicates EXCLUDES placeholder-image cards (isBadImg) so they can't form false 'same picture' groups", async () => {
      // Placeholder thumbnails (favicon / screenshot-fallback) are shared by many
      // unrelated cards; hashing them collapsed those cards into bogus image groups.
      // Two real-image cards with a matching hash still group; two placeholder cards
      // with the SAME matching hash must not appear in any group at all.
      const cards = [
        { id: "real1", img: "https://cdn.example.com/photo1.jpg" },
        { id: "real2", img: "https://cdn.example.com/photo2.jpg" },
        { id: "ph1", img: "https://s0.wp.com/mshots/v1/aaa" },
        { id: "ph2", img: "https://s0.wp.com/mshots/v1/bbb" },
      ];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "ffffffffffffffff",   // identical hash for every hashed card
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },  // distance 0 -> everything hashed would match
        isBadImg: (u) => /mshots|thum\.io|microlink/.test(u || ""),
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      const allIds = groups.flatMap(g => g.members.map(m => m.card.id));
      assert.ok(!allIds.includes("ph1") && !allIds.includes("ph2"),
        "a placeholder-image card must never be hashed into an image-match group");
      assert.ok(groups.some(g => { const ids = g.members.map(m => m.card.id); return ids.includes("real1") && ids.includes("real2"); }),
        "two real images with matching hashes must still group");
    });

    await at(label + ": scanImageDuplicates excludes a clique larger than IMAGE_GROUP_SIZE_CAP entirely, and spends NO OCR calls confirming it (placeholder-cluster guard)", async () => {
      // Modeled on this app's own real library: a shared placeholder/broken-
      // capture image (a VPN block page, a site's generic "no thumbnail" logo)
      // independently produced 30-100 member cliques -- offering that as a
      // one-click bulk-removal prompt is a real deletion hazard regardless of
      // cause. A normal 2-3 member duplicate cluster must be unaffected.
      const bigCards = Array.from({ length: 12 }, (_, i) => ({ id: "big" + i }));
      const smallCards = [{ id: "s1" }, { id: "s2" }];
      const ocrCalledFor = [];
      const deps = Object.assign(baseDeps(bigCards.concat(smallCards)), {
        computeCardHash: async (card) => (card.id.startsWith("big") ? "0000000000000000" : "ffffffffffffffff"),
        IA_IMGHASH: { hamming: (a, b) => (a === b ? 0 : 64), MAX_DISTANCE: 5 },
        ocrExtractText: async (card) => { ocrCalledFor.push(card.id); return null; },
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      const allIds = groups.flatMap(g => g.members.map(m => m.card.id));
      assert.ok(!bigCards.some(c => allIds.includes(c.id)), "the 12-member clique must be excluded entirely, not offered as a duplicate group");
      assert.ok(allIds.includes("s1") && allIds.includes("s2"), "an ordinary 2-member cluster must still group normally");
      assert.ok(!ocrCalledFor.some(id => id.startsWith("big")), "OCR must never be spent on a clique the size cap already excluded -- that's the whole point of checking size first");
    });

    await at(label + ": scanImageDuplicates splits a hash-matched group whose members' OCR text clearly conflicts", async () => {
      const cards = [{ id: "a", img: "idb:a" }, { id: "b", img: "idb:b" }];
      const texts = { a: "Happy New Year Messages", b: "military strikes deep inside Iran breaking news today" };
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async (card) => texts[card.id],
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 0, "conflicting OCR text must remove this pair from the duplicate results entirely");
    });

    await at(label + ": scanImageDuplicates keeps a hash-matched group together when OCR text agrees (a true reposted duplicate)", async () => {
      const cards = [{ id: "a", img: "idb:a" }, { id: "b", img: "idb:b" }];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => "Same real caption on both copies",
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 1, "agreeing OCR text must not block a real duplicate match");
      assert.strictEqual(groups[0].members.length, 2);
    });

    await at(label + ": scanImageDuplicates keeps a hash-matched group together when OCR finds no usable text on either side (unchanged, hash-only behavior)", async () => {
      const cards = [{ id: "a", img: "idb:a" }, { id: "b", img: "idb:b" }];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => null,
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 1, "no OCR evidence on either side must fall back to today's hash-only grouping, not an unconfirmed split");
    });

    // --- title fallback (real-library finding: two unrelated cults3d.com posts,
    // and a 3-way trivia/Facebook/recipe tangle, both shared a photo-like image
    // OCR found no text in at all -- OCR alone left them grouped; only their
    // titles tell them apart). Only ever consulted when OCR found NOTHING on a
    // member -- see the priority-ordering tests further below. -------------
    await at(label + ": scanImageDuplicates falls back to card TITLES when OCR finds no usable text on either side, splitting clearly unrelated posts", async () => {
      const cards = [
        { id: "a", img: "idb:a", title: "3D Printable Designs by Yohanna Jeong" },
        { id: "b", img: "idb:b", title: "Whimsical T-Shirt Designs by LuisCreation" },
      ];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => null,   // photo-like image; OCR finds nothing, exactly the real-library case
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 0, "clearly unrelated titles must remove this pair when OCR has no evidence at all");
    });

    await at(label + ": scanImageDuplicates keeps a group together when titles agree (or are close enough), even with no OCR evidence", async () => {
      const cards = [
        { id: "a", img: "idb:a", title: "Homemade Sourdough Starter Guide" },
        { id: "b", img: "idb:b", title: "Homemade Sourdough Starter Guide (repost)" },
      ];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => null,
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 1, "agreeing titles must not block a real duplicate match");
    });

    await at(label + ": scanImageDuplicates does NOT use a generic/platform-fallback title as evidence (reuses normTitle's own rejection rules)", async () => {
      // "post by" fallback titles (the exact real-library "Old Made New post by
      // Luis Chambers" case) and bare platform-generic titles say nothing about
      // content -- normTitle already rejects both for the url/title pass; this
      // must inherit that rejection, not treat a shared/near-empty normalized
      // string as either agreement or conflict.
      const cards = [
        { id: "a", img: "idb:a", title: "Old Made New post by Luis Chambers" },
        { id: "b", img: "idb:b", title: "Facebook post" },
      ];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => null,
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 1, "unusable (generic/fallback) titles must be 'no evidence', falling back to today's hash-only grouping, not a wrongly-forced split");
    });

    await at(label + ": OCR evidence takes priority over title evidence when both are present -- OCR agreement is not overridden by differing titles", async () => {
      const cards = [
        { id: "a", img: "idb:a", title: "Totally Different Topic One Here" },
        { id: "b", img: "idb:b", title: "A Completely Unrelated Topic Two" },
      ];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => "Same real caption on both copies",   // OCR agrees on both sides
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 1, "OCR agreement must win over differing titles -- title is only a FALLBACK for when OCR has nothing to say");
    });

    await at(label + ": OCR conflict takes priority over title evidence when both are present -- agreeing titles do not override an OCR-confirmed conflict", async () => {
      const texts = { a: "Happy New Year Messages", b: "military strikes deep inside Iran breaking news today" };
      const cards = [
        { id: "a", img: "idb:a", title: "Homemade Sourdough Starter Guide" },
        { id: "b", img: "idb:b", title: "Homemade Sourdough Starter Guide (repost)" },
      ];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async (card) => texts[card.id],
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 0, "OCR conflict must win over agreeing titles -- the images' actual text is the stronger signal");
    });

    await at(label + ": PINNED (data-safety review): mixed evidence -- OCR text on one side, title fallback on the other -- compares across signal types and can split even a genuine duplicate with IDENTICAL titles", async () => {
      // A real, plausible case: one copy's image happens to have legible
      // baked-in text (e.g. an ingredient list) an OCR run reads successfully;
      // the other copy's image doesn't. Comparing that OCR string against the
      // OTHER side's title (not its own -- it has none to compare) can
      // conflict even though the two CARDS' titles agree perfectly. This is
      // an accepted, documented trade-off (see splitGroupsOnTextConflict's
      // comment) -- fewer, more conservative groups is the safe direction --
      // not a bug to fix. Pinned so a future edit to the priority/fallback
      // logic changes this on PURPOSE, not by accident.
      const cards = [
        { id: "a", img: "idb:a", title: "Homemade Sourdough Starter Guide" },
        { id: "b", img: "idb:b", title: "Homemade Sourdough Starter Guide" },
      ];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async (card) => (card.id === "a" ? "step by step overnight proof dutch oven bake" : null),
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      const groups = await scanImageDuplicates(new Set(), null);
      assert.strictEqual(groups.length, 0, "current, accepted behavior: cross-type OCR-vs-title comparison splits this pair despite identical titles");
    });

    await at(label + ": scanImageDuplicates never caches a failed/null OCR result -- a transient failure is retried, not permanently locked in", async () => {
      const cards = [{ id: "a", img: "idb:a" }, { id: "b", img: "idb:b" }];
      let calls = 0;
      const persistedOcr = {};
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        loadImgOcrCache: async () => persistedOcr,
        saveImgOcrCache: () => {},   // persistedOcr IS the object mutated in place, mirroring the real KV-backed cache
        ocrExtractText: async (card) => { calls++; return (card.id === "a" && calls <= 1) ? null : "some real caption text here"; },
      });
      const firstScan = loadScanImageDuplicates(src, deps);
      await firstScan(new Set(), null);
      assert.ok(!("a" in persistedOcr), "a failed/null OCR result must never be written to the cache");

      const secondScan = loadScanImageDuplicates(src, deps);
      await secondScan(new Set(), null);
      assert.ok(persistedOcr.a && persistedOcr.a.text, "a successful retry on a later scan must be cached normally");
    });

    await at(label + ": scanImageDuplicates reports onProgress with phase \"hash\" during hashing and phase \"ocr\" during OCR confirmation", async () => {
      const cards = [{ id: "a", img: "idb:a" }, { id: "b", img: "idb:b" }];
      const phases = [];
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async () => "0000000000000000",
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => null,
      });
      const scanImageDuplicates = loadScanImageDuplicates(src, deps);
      await scanImageDuplicates(new Set(), (done, total, phase) => phases.push(phase));
      assert.ok(phases.includes("hash"), "must report at least one hash-phase progress tick");
      assert.ok(phases.includes("ocr"), "must report at least one ocr-phase progress tick");
    });

    // --- BEHAVIORAL abort tests (data-safety review: the structural "does
    // _imgScanAbort appear in the source" checks above cannot prove the loop
    // actually stops -- _imgScanAbort is now a mutable inner `let` exposed via
    // .setAbort() precisely so these can flip it mid-run, the same technique
    // tests/_dupe-harness.js uses for other live scan state). ---------------
    await at(label + ": aborting MID-OCR-pass stops further OCR calls immediately and discards the result entirely, not a partial/less-confirmed one", async () => {
      const cards = [{ id: "a1" }, { id: "a2" }, { id: "b1" }, { id: "b2" }, { id: "c1" }, { id: "c2" }];
      const HASHES = { a1: "H1", a2: "H1", b1: "H2", b2: "H2", c1: "H3", c2: "H3" };
      let ocrCalls = 0, scanRef;
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async (card) => HASHES[card.id],
        IA_IMGHASH: { hamming: (a, b) => (a === b ? 0 : 64), MAX_DISTANCE: 5 },
        ocrExtractText: async () => { ocrCalls++; if (ocrCalls === 2) scanRef.setAbort(true); return null; },
      });
      scanRef = loadScanImageDuplicates(src, deps);
      const groups = await scanRef(new Set(), null);
      assert.strictEqual(ocrCalls, 2, "the OCR loop must stop the instant it's aborted, not continue through the remaining candidates");
      assert.deepStrictEqual(groups, [], "an aborted OCR pass must discard its result entirely -- a partial textByKey could otherwise hand back groups LARGER/less-confirmed than a full scan would");
    });

    await at(label + ": if the scan is already aborted by the time the OCR phase starts (aborted during hashing), the OCR phase spends ZERO calls, not one", async () => {
      const cards = [{ id: "a1" }, { id: "a2" }];
      let ocrCalls = 0, scanRef;
      const deps = Object.assign(baseDeps(cards), {
        computeCardHash: async (card) => { if (card.id === "a2") scanRef.setAbort(true); return "H1"; },
        IA_IMGHASH: { hamming: () => 0, MAX_DISTANCE: 5 },
        ocrExtractText: async () => { ocrCalls++; return null; },
      });
      scanRef = loadScanImageDuplicates(src, deps);
      const groups = await scanRef(new Set(), null);
      assert.strictEqual(ocrCalls, 0, "Tesseract load+recognize is real, non-trivial work -- an already-aborted scan must not spend even one OCR call, even though a real group WAS found by the hash phase");
      assert.deepStrictEqual(groups, [], "an aborted scan must return no groups");
    });
  }

  console.log((pass) + " passed, " + fail + " failed (cumulative)");
  process.exit(fail ? 1 : 0);
})();
