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
  // scanImageDuplicates calls groupByImageHash internally — both function
  // declarations must share the sandbox scope (same trap the cache-wiring
  // suite already documented for computeCardHash/isDegenerateHash): omitting
  // groupByImageHash here would throw a ReferenceError deep inside the call,
  // which is NOT swallowed (scanImageDuplicates has no its own try/catch
  // around that call), so this is a load-bearing inclusion, not decoration.
  const fnSrc = extractFn(src, "groupByImageHash") + "\n" + extractFn(src, "scanImageDuplicates");
  assert.ok(fnSrc, "scanImageDuplicates (or its groupByImageHash dependency) not found");
  const factory = new Function(
    "imported", "saved", "loadImgHashCache", "saveImgHashCache", "imgHashSrcKey", "computeCardHash",
    "IA_IMGHASH", "dupeGroupDismissed", "dupeMemberKey", "dupePrimary", "_imgScanAbort",
    fnSrc + "\nreturn scanImageDuplicates;"
  );
  return factory(
    deps.imported, deps.saved, deps.loadImgHashCache, deps.saveImgHashCache, deps.imgHashSrcKey,
    deps.computeCardHash, deps.IA_IMGHASH, deps.dupeGroupDismissed, deps.dupeMemberKey, deps.dupePrimary,
    deps._imgScanAbort
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
    _imgScanAbort: false,
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
  }

  console.log((pass) + " passed, " + fail + " failed (cumulative)");
  process.exit(fail ? 1 : 0);
})();
