// Tests for web/lib/capture-state.js — truth tables per predicate. Byte-equivalent
// logic is the binding requirement (Phase-1 B8: predicate drift = bulk actions on
// the wrong cards), so these pin each state and its boundary cases.
const assert = require("assert");
const CS = require("../web/lib/capture-state.js");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.stack||e)); } }

const WEB = "https://example.com/a";      // web-proxy-capturable url
const FB  = "https://www.facebook.com/x"; // login-walled

/* ---------- isFavicon ---------- */
t("isFavicon: favicon/touch-icon urls true; a real image false", () => {
  assert.ok(CS.isFavicon("https://x.com/favicon.ico"));
  assert.ok(CS.isFavicon("https://x.com/apple-touch-icon.png"));
  assert.ok(CS.isFavicon("https://icons.duckduckgo.com/ip3/x.com.ico"));
  assert.ok(!CS.isFavicon("https://x.com/real-photo.jpg"));
  assert.ok(!CS.isFavicon(""));
});

/* ---------- isBadImg (boundary: empty vs placeholder vs http img) ---------- */
t("isBadImg: empty -> bad", () => { assert.ok(CS.isBadImg("")); assert.ok(CS.isBadImg(undefined)); });
t("isBadImg: favicon -> bad", () => { assert.ok(CS.isBadImg("https://x.com/favicon.ico")); });
t("isBadImg: mshots/thum.io/microlink/webcache placeholders -> bad", () => {
  assert.ok(CS.isBadImg("https://s0.wp.com/mshots/v1/http%3A%2F%2Fx.com"));
  assert.ok(CS.isBadImg("https://thum.io/get/x.com"));
  assert.ok(CS.isBadImg("https://api.microlink.io/?url=x"));
  assert.ok(CS.isBadImg("https://webcache.googleusercontent.com/x"));
});
t("isBadImg: a real http(s) image -> good (false)", () => {
  assert.ok(!CS.isBadImg("https://cdn.example.com/photo.jpg"));
});
// Live bug 2026-07-15: 51 Instagram-imported cards from one capture batch (2026-07-04)
// landed on the raw signed scontent.cdninstagram.com og:image URL instead of a cached
// local copy. isBadImg didn't flag it (looked like "a real http(s) image"), so it never
// re-entered needsCapture/needsRetry -- and the signed "oe" expiry silently killed it
// ~10 days later with zero record anywhere that the card needed another try.
t("isBadImg: an expiring signed Facebook/Instagram CDN hotlink -> bad (must re-enter retry)", () => {
  assert.ok(CS.isBadImg("https://scontent.cdninstagram.com/v/t51.71878-15/705018096_1366937845281127_5734660294580020960_n.jpg?stp=cmp1_dst-jpg_e35_s640x640_tt6&_nc_cat=102&oh=00_AQC3erfV06LtnmBwtoebth_LoBqwzRS_iL75vcuB19--Ag&oe=6A48EDD6"));
  assert.ok(CS.isBadImg("https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/x.jpg?_nc_cat=1&oh=abc&oe=64ABCDEF"));
});
t("isBadImg: an idb: local cache ref or a non-social CDN URL with '?oe=' noise -> still good", () => {
  assert.ok(!CS.isBadImg("idb:c_mqyfkl7c_yk1dll"));            // the durable form -- never flagged
  assert.ok(!CS.isBadImg("https://cdn.example.com/photo.jpg?oe=123"));   // unrelated host, coincidental param
});

/* ---------- hammingDist (perceptual dHash comparison) ---------- */
// Live bug 2026-07-15 (follow-on): Instagram serves the same "trouble displaying this
// video" error page for reels it currently won't play, and captureTab dutifully
// screenshots it -- a REAL data: image, so isBadImg/imgFp both call it "fine". Found
// 14 of 609 cached Instagram Reel screenshots were this exact error page. The two
// reference hashes below are the actual computed dHashes of two of those cards
// (c_mqyfkl7d_6zia77 / c_mqyfkl7d_t5i5r3) -- verified live to be 3 bits apart from
// each other despite different account/follower-count chrome baked into each screenshot,
// and 12+ bits from the nearest unrelated real photo in the same library.
const IG_ERROR_HASH_A = "1011010010110100101101001011010010110100101101001011010010110110";
const IG_ERROR_HASH_B = "1011010010110100101101001011010010110100101001001010010010100110";
t("hammingDist: identical hashes -> 0", () => {
  assert.strictEqual(CS.hammingDist(IG_ERROR_HASH_A, IG_ERROR_HASH_A), 0);
});
t("hammingDist: the two live IG-error-page hashes are 3 bits apart (within threshold)", () => {
  assert.strictEqual(CS.hammingDist(IG_ERROR_HASH_A, IG_ERROR_HASH_B), 3);
});
t("hammingDist: mismatched length (a decode failure) -> max distance, never a false match", () => {
  assert.strictEqual(CS.hammingDist(IG_ERROR_HASH_A, "1011"), 64);
  assert.strictEqual(CS.hammingDist("", IG_ERROR_HASH_A), 64);
  assert.strictEqual(CS.hammingDist(IG_ERROR_HASH_A, ""), 64);
});
t("hammingDist: flipping 20 of 64 bits -> distance 20, well outside the rejection threshold", () => {
  const chars = IG_ERROR_HASH_A.split("");
  for (let i = 0; i < 20; i++) chars[i] = chars[i] === "1" ? "0" : "1";
  const farHash = chars.join("");
  assert.strictEqual(CS.hammingDist(IG_ERROR_HASH_A, farHash), 20);
});

/* ---------- captureable (web, not FB) ---------- */
t("captureable: web url + bad img + not capDone/blocked -> true", () => {
  assert.ok(CS.captureable({ url: WEB, img: "" }));
});
t("captureable: FB url -> false (that's the extension's job)", () => {
  assert.ok(!CS.captureable({ url: FB, img: "" }));
});
t("captureable: capDone/blocked/good-img/no-url -> false", () => {
  assert.ok(!CS.captureable({ url: WEB, img: "", capDone: true }));
  assert.ok(!CS.captureable({ url: WEB, img: "", blocked: true }));
  assert.ok(!CS.captureable({ url: WEB, img: "https://cdn/x.jpg" }));
  assert.ok(!CS.captureable({ url: "", img: "" }));
});

/* ---------- captureableFb (FB mirror) ---------- */
t("captureableFb: FB url + bad img -> true; web url -> false", () => {
  assert.ok(CS.captureableFb({ url: FB, img: "" }));
  assert.ok(!CS.captureableFb({ url: WEB, img: "" }));
});

/* ---------- needsCapture (captureable + never tried) ---------- */
t("needsCapture: never tried -> true", () => {
  assert.ok(CS.needsCapture({ url: WEB, img: "" }));
});
t("needsCapture: already tried (lastUpdate or captured) -> false", () => {
  assert.ok(!CS.needsCapture({ url: WEB, img: "", lastUpdate: 123 }));
  assert.ok(!CS.needsCapture({ url: WEB, img: "", captured: 123 }));
});

/* ---------- needsRetry (captureable + tried) ---------- */
t("needsRetry: tried but still no image -> true", () => {
  assert.ok(CS.needsRetry({ url: WEB, img: "", lastUpdate: 123 }));
  assert.ok(CS.needsRetry({ url: WEB, img: "", captured: 123 }));
});
t("needsRetry: never tried -> false", () => {
  assert.ok(!CS.needsRetry({ url: WEB, img: "" }));
});
t("needsCapture and needsRetry are mutually exclusive over captureable cards", () => {
  const tried = { url: WEB, img: "", lastUpdate: 1 };
  const fresh = { url: WEB, img: "" };
  assert.ok(CS.needsRetry(tried) && !CS.needsCapture(tried));
  assert.ok(CS.needsCapture(fresh) && !CS.needsRetry(fresh));
});

/* ---------- needsFbCapture ---------- */
t("needsFbCapture: FB + bad img + never tried -> true", () => {
  assert.ok(CS.needsFbCapture({ url: FB, img: "" }));
});
t("needsFbCapture: FB tried -> false; web url -> false", () => {
  assert.ok(!CS.needsFbCapture({ url: FB, img: "", lastUpdate: 1 }));
  assert.ok(!CS.needsFbCapture({ url: WEB, img: "" }));
});

/* ---------- fbMiss ---------- */
t("fbMiss: FB card that tried (fail/lastUpdate/captured) and still no image -> true", () => {
  assert.ok(CS.fbMiss({ url: FB, img: "", lastResult: "fail" }));
  assert.ok(CS.fbMiss({ url: FB, img: "", lastUpdate: 1 }));
  assert.ok(CS.fbMiss({ url: FB, img: "", captured: 1 }));
});
t("fbMiss: FB card never tried -> false; web card -> false; good img -> false", () => {
  assert.ok(!CS.fbMiss({ url: FB, img: "" }));
  assert.ok(!CS.fbMiss({ url: WEB, img: "", lastUpdate: 1 }));
  assert.ok(!CS.fbMiss({ url: FB, img: "https://cdn/x.jpg", lastUpdate: 1 }));
});

// titleMismatch: the feed uses this to drop AI-hallucinated article IDs that resolve to a
// DIFFERENT real article (live case 2026-07-03: thekitchn.com/how-to-meal-prep-229363 serves
// "How To Make Braided Pesto Bread"). Conservative: only fires on ZERO content-word overlap
// with enough signal on both sides.
t("titleMismatch: wrong article (zero content-word overlap) -> true", () => {
  assert.ok(CS.titleMismatch("How to Meal Prep Like a Pro", "How To Make Braided Pesto Bread | The Kitchn"));
});
t("titleMismatch: matching/related titles -> false", () => {
  assert.ok(!CS.titleMismatch("Building Your Own 3D Printer from Scratch", "How I built a 3D printer from scratch - Make:"));
  assert.ok(!CS.titleMismatch("The Future of Remote Work: Trends and Predictions", "Remote work is the future, report predicts"));
});
t("titleMismatch: too little signal (short/generic titles) -> false (never over-drop)", () => {
  assert.ok(!CS.titleMismatch("Meal Prep", "The Kitchn"));          // <2 content words on a side
  assert.ok(!CS.titleMismatch("How to Meal Prep Like a Pro", ""));  // no page title
});

/* ---------- strict Stumble validation ---------- */
const LIVE_PAGE = { status: 200, verdict: "likely-alive", signals: [], title: "A Real Woodworking Project" };

t("isVerifiedDiscoveryResult: requires a clean 2xx content result", () => {
  assert.ok(CS.isVerifiedDiscoveryResult(
    { url: "https://example.com/projects/woodworking", title: "A Real Woodworking Project" },
    LIVE_PAGE));
  [0, 403, 404, 500].forEach(status => {
    assert.ok(!CS.isVerifiedDiscoveryResult(
      { url: "https://example.com/projects/woodworking", title: "A Real Woodworking Project" },
      Object.assign({}, LIVE_PAGE, { status })), "HTTP "+status+" must not enter Stumble");
  });
});

t("isVerifiedDiscoveryResult: rejects suspect, empty, challenge, and wrong-article pages", () => {
  const item = { url: "https://www.theverge.com/2020/1/1/21078720/the-power-of-habit-review", title: "The Power of Habit" };
  assert.ok(!CS.isVerifiedDiscoveryResult(item,
    { status:404, verdict:"suspect", signals:["phrase:page not found"], title:"404 Not Found | The Verge" }));
  assert.ok(!CS.isVerifiedDiscoveryResult(item,
    { status:200, verdict:"suspect", signals:["empty"], title:"" }));
  assert.ok(!CS.isVerifiedDiscoveryResult(item,
    { status:200, verdict:"likely-alive", signals:["challenge"], title:"Just a moment..." }));
  assert.ok(!CS.isVerifiedDiscoveryResult(
    { url:"https://example.com/articles/meal-prep", title:"How to Meal Prep Like a Pro" },
    { status:200, verdict:"likely-alive", signals:[], title:"How To Make Braided Pesto Bread" }));
});

t("isVerifiedDiscoveryResult: allows a verified homepage even when its broad title differs", () => {
  assert.ok(CS.isVerifiedDiscoveryResult(
    { url:"https://gretchenrubin.com/", title:"The Happiness Project" },
    { status:200, verdict:"likely-alive", signals:[], title:"Gretchen Rubin | Author and Podcaster" }));
});

t("isFreshDiscoveryItem: only recently live-checked cards remain dealable", () => {
  const now = 1_000_000, ttl = 30_000;
  assert.ok(CS.isFreshDiscoveryItem({ liveCheckedAt: now-ttl }, now, ttl));
  assert.ok(!CS.isFreshDiscoveryItem({ liveCheckedAt: now-ttl-1 }, now, ttl));
  assert.ok(!CS.isFreshDiscoveryItem({}, now, ttl));
  assert.ok(!CS.isFreshDiscoveryItem({ liveCheckedAt: now+1 }, now, ttl));
});

console.log("capture-state.test.js: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
