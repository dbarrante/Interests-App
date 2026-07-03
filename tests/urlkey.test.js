// Tests for web/lib/urlkey.js — the four URL canonicalizers (feedKey/normUrl/
// dupeKey/clipKey). The expected values were PINNED by running the OLD index.html
// implementations in Node before the refactor (see task-4 report), so every case
// asserts byte-identical output to its predecessor — EXCEPT the two sanctioned
// dupeKey YouTube-shorts/youtu.be cases, which now align to clipKey's handling.
const assert = require("assert");
const { feedKey, normUrl, dupeKey, clipKey } = require("../web/lib/urlkey");
let passed = 0, failed = 0;
const queue = [];
function t(n, fn){ queue.push([n, fn]); }

// ---------------------------------------------------------------------------
// Transform matrix. Each row: input -> expected {feedKey, normUrl, dupeKey, clipKey}.
// Values marked with a trailing comment were the OLD outputs (behavior-equivalence).
// ---------------------------------------------------------------------------
const M = [
  ["https://www.YouTube.com/watch?v=abc123", {
    feedKey: "youtube.com/watch?v=abc123",   // keeps query, drops www, lowercases
    normUrl: "youtube.com/watch",             // drops query
    dupeKey: "youtube.com/watch?abc123",      // folds ?v id
    clipKey: "youtube.com/watch?abc123",
  }],
  ["https://youtube.com/shorts/XYZ789", {
    feedKey: "youtube.com/shorts/xyz789",
    normUrl: "youtube.com/shorts/xyz789",
    // SANCTIONED CHANGE: old dupeUrlKey => "youtube.com/shorts/xyz789" (no id folded);
    // now aligns to clipKey and folds the raw-case /shorts/<id> path id.
    dupeKey: "youtube.com/shorts/xyz789?XYZ789",
    clipKey: "youtube.com/shorts/xyz789?XYZ789",
  }],
  ["https://youtu.be/short44", {
    feedKey: "youtu.be/short44",
    normUrl: "youtu.be/short44",
    // SANCTIONED CHANGE: old dupeUrlKey => "youtu.be/short44"; now folds youtu.be/<id>.
    dupeKey: "youtu.be/short44?short44",
    clipKey: "youtu.be/short44?short44",
  }],
  ["http://www.example.com/path/", {
    feedKey: "example.com/path", normUrl: "example.com/path",
    dupeKey: "example.com/path", clipKey: "example.com/path",
  }],
  ["https://example.com/path#frag", {
    feedKey: "example.com/path#frag",   // feedKey KEEPS the hash
    normUrl: "example.com/path",         // normUrl DROPS it
    dupeKey: "example.com/path", clipKey: "example.com/path",
  }],
  ["https://example.com/a/b/?q=1&r=2", {
    feedKey: "example.com/a/b/?q=1&r=2", // feedKey keeps query+trailing-before-?
    normUrl: "example.com/a/b",
    dupeKey: "example.com/a/b", clipKey: "example.com/a/b",
  }],
  ["https://EXAMPLE.com/", {
    feedKey: "example.com", normUrl: "example.com",
    dupeKey: "example.com", clipKey: "example.com",
  }],
  ["https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Freal%3Fv%3D9&h=abc", {
    // FB l.php redirect unwrap: only normUrl + clipKey unwrap; feedKey/dupeKey do NOT.
    feedKey: "l.facebook.com/l.php?u=https%3a%2f%2fexample.com%2freal%3fv%3d9&h=abc",
    normUrl: "example.com/real",
    dupeKey: "l.facebook.com/l.php",
    clipKey: "example.com/real",
  }],
  ["https://facebook.com/watch?v=555&story_fbid=777", {
    feedKey: "facebook.com/watch?v=555&story_fbid=777",
    normUrl: "facebook.com/watch",
    dupeKey: "facebook.com/watch?555",   // dupeKey param priority: v first
    clipKey: "facebook.com/watch?777",    // clipKey FB priority: story_fbid first
  }],
  ["https://www.facebook.com/story.php?story_fbid=111&id=222", {
    feedKey: "facebook.com/story.php?story_fbid=111&id=222",
    normUrl: "facebook.com/story.php",
    dupeKey: "facebook.com/story.php?111",
    clipKey: "facebook.com/story.php?111",
  }],
  ["https://fb.watch/xY_z/", {
    feedKey: "fb.watch/xy_z", normUrl: "fb.watch/xy_z",
    dupeKey: "fb.watch/xy_z", clipKey: "fb.watch/xy_z",
  }],
  ["https://instagram.com/p/CODE123/", {
    feedKey: "instagram.com/p/code123", normUrl: "instagram.com/p/code123",
    dupeKey: "instagram.com/p/code123", clipKey: "instagram.com/p/code123",
  }],
  ["not a url", {
    feedKey: "not a url", normUrl: "not a url",
    dupeKey: "not a url", clipKey: "not a url",   // all fall back to lowercase
  }],
  ["", {
    feedKey: "", normUrl: "", dupeKey: "", clipKey: "",
  }],
  ["https://example.com/page?id=42", {
    feedKey: "example.com/page?id=42",
    normUrl: "example.com/page",
    dupeKey: "example.com/page?42",   // generic ?id folded by dupeKey only
    clipKey: "example.com/page",
  }],
  ["https://youtube.com/watch?v=abc123#t=30", {
    feedKey: "youtube.com/watch?v=abc123#t=30",
    normUrl: "youtube.com/watch",
    dupeKey: "youtube.com/watch?abc123",
    clipKey: "youtube.com/watch?abc123",
  }],
];

for (const [input, exp] of M) {
  t("feedKey(" + JSON.stringify(input) + ")", () => assert.strictEqual(feedKey(input), exp.feedKey));
  t("normUrl(" + JSON.stringify(input) + ")", () => assert.strictEqual(normUrl(input), exp.normUrl));
  t("dupeKey(" + JSON.stringify(input) + ")", () => assert.strictEqual(dupeKey(input), exp.dupeKey));
  t("clipKey(" + JSON.stringify(input) + ")", () => assert.strictEqual(clipKey(input), exp.clipKey));
}

// ---------------------------------------------------------------------------
// Cross-function disagreement cases: PIN the deliberate semantic differences so a
// future "simplification" can't silently merge them.
// ---------------------------------------------------------------------------
t("feedKey keeps query but normUrl/clipKey drop it (must NOT be merged)", () => {
  const u = "https://example.com/a?q=1";
  assert.strictEqual(feedKey(u), "example.com/a?q=1");
  assert.strictEqual(normUrl(u), "example.com/a");
  assert.notStrictEqual(feedKey(u), normUrl(u));
});
t("feedKey keeps hash; normUrl drops it (deliberate)", () => {
  const u = "https://example.com/a#x";
  assert.strictEqual(feedKey(u), "example.com/a#x");
  assert.strictEqual(normUrl(u), "example.com/a");
});
t("FB l.php unwrap: normUrl/clipKey unwrap, feedKey/dupeKey do not (deliberate)", () => {
  const u = "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fp&h=z";
  assert.strictEqual(normUrl(u), "example.com/p");
  assert.strictEqual(clipKey(u), "example.com/p");
  assert.notStrictEqual(dupeKey(u), "example.com/p");   // dupeKey sees the wrapper host
});
t("FB v vs story_fbid priority differs: dupeKey?555 vs clipKey?777 (deliberate)", () => {
  const u = "https://facebook.com/watch?v=555&story_fbid=777";
  assert.strictEqual(dupeKey(u), "facebook.com/watch?555");
  assert.strictEqual(clipKey(u), "facebook.com/watch?777");
  assert.notStrictEqual(dupeKey(u), clipKey(u));
});
t("clipKey folds YouTube ?v where normUrl collapses to the bare /watch (deliberate)", () => {
  const a = "https://youtube.com/watch?v=aaa", b = "https://youtube.com/watch?v=bbb";
  assert.strictEqual(normUrl(a), normUrl(b));                 // normUrl collapses distinct videos
  assert.notStrictEqual(clipKey(a), clipKey(b));              // clipKey keeps them distinct
});

// ---------------------------------------------------------------------------
// Sanctioned dupeKey shorts change: document old vs new behavior explicitly.
// ---------------------------------------------------------------------------
t("SANCTIONED: dupeKey now folds YouTube /shorts id (was: bare path) -> agrees with clipKey", () => {
  const u = "https://youtube.com/shorts/XYZ789";
  const OLD_dupeUrlKey = "youtube.com/shorts/xyz789";        // pre-refactor output
  assert.notStrictEqual(dupeKey(u), OLD_dupeUrlKey);          // behavior changed on purpose
  assert.strictEqual(dupeKey(u), "youtube.com/shorts/xyz789?XYZ789");
  assert.strictEqual(dupeKey(u), clipKey(u));                 // now agrees with clip-dedupe
});
t("SANCTIONED: dupeKey now folds youtu.be id (was: bare path) -> agrees with clipKey", () => {
  const u = "https://youtu.be/short44";
  assert.notStrictEqual(dupeKey(u), "youtu.be/short44");
  assert.strictEqual(dupeKey(u), clipKey(u));
});

// ---- run ----
for (const [n, fn] of queue) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log("FAIL " + n + ": " + (e && e.message)); }
}
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
