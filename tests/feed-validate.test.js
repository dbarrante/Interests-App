// The feed's link validator must use the app's OWN Core dead-link probe (Store.checkLinks),
// NOT the third-party api.allorigins.win proxy. Root cause of "feed shows nothing but 404s":
// validateItems checked links through allorigins, which returns HTTP 500 / is CORS-blocked from
// the app, and it FAILED OPEN (return true) on proxy error → every dead AI-suggested URL was shown.
// The Core probe (/api/check-links) is server-side, SSRF-guarded, conservative (404/410/451/DNS=dead,
// social=skipped, else unknown) and is the same one "Check links" uses.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

// Slice the whole validateItems function body (to its column-0 closing brace) so assertions
// see BOTH validation tiers, not just the first N chars.
function validateItemsBody(){
  const i = html.indexOf("async function validateItems(");
  assert.ok(i >= 0, "validateItems present");
  const end = html.indexOf("\n}", i);
  return html.slice(i, end + 2);
}

t("validateItems uses the Core dead-link probe (Store.checkLinks), not allorigins", () => {
  const body = validateItemsBody();
  assert.ok(body.indexOf("Store.checkLinks(") >= 0, "validateItems must call Store.checkLinks");
  assert.ok(body.indexOf("allorigins") < 0, "validateItems must NOT use the api.allorigins.win proxy");
});

t("validateItems admits only explicitly alive links and fails closed when tier 1 errors", () => {
  const body = validateItemsBody();
  assert.ok(/status\s*===\s*"alive"/.test(body), "only linkcheck status alive is admitted");
  // A recommendation is disposable: skipped/unknown is not proof that it is live.
  assert.ok(/catch\s*\([^)]*\)\s*\{[\s\S]*?return\s*\[\]/.test(body), "link-check failure returns no unverified cards");
});

t("validateItems requires clean 2xx content and fails closed when tier 2 errors", () => {
  const body = validateItemsBody();
  assert.ok(body.indexOf("Store.checkContent(") >= 0, "validateItems must run the tier-2 content check");
  // Empty/challenge/non-2xx results are rejected by the tested pure predicate.
  assert.ok(body.indexOf("isVerifiedDiscoveryResult(") >= 0, "strict pure predicate gates every result");
  const catches = body.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?return\s*\[\]/g) || [];
  assert.ok(catches.length >= 2, "both validation tiers fail closed");
});

t("validateItems no longer admits bot-challenged or non-2xx pages", () => {
  const body = validateItemsBody();
  assert.ok(body.indexOf("noshot=1") < 0 && body.indexOf("noshot = 1") < 0,
    "challenge pages are rejected rather than rendered without screenshots");
});

t("validateItems drops wrong-article URLs via titleMismatch (hallucinated IDs serving other pages)", () => {
  const body = validateItemsBody();
  assert.ok(body.indexOf("isVerifiedDiscoveryResult(") >= 0,
    "uses the strict predicate whose unit tests pin titleMismatch behavior");
});

t("imageChain never screenshot-proxies a noshot item", () => {
  const i = html.indexOf("function imageChain(");
  const body = html.slice(i, html.indexOf("\n}", i) + 2);
  assert.ok(/noshot/.test(body), "imageChain honors the noshot flag");
});

t("validateItems discards AI image guesses and keeps only live page-extracted og:image URLs", () => {
  const body = validateItemsBody();
  assert.ok(body.indexOf("ogImage") >= 0, "uses the content check's ogImage");
  assert.ok(/i\.image\s*=\s*null/.test(body), "AI-provided image is cleared first");
  assert.ok(body.indexOf("Store.checkLinks(") >= 0, "page-extracted image URLs get their own live check");
  assert.ok(/i\.image\s*=\s*i\.imageCandidate/.test(body), "only a verified page og:image is attached");
  assert.ok(/liveCheckedAt\s*=\s*Date\.now/.test(body), "accepted cards carry a freshness timestamp");
});

t("thum.io is banned — its free tier serves an 'Image not authorized' ERROR IMAGE with HTTP 200", () => {
  assert.ok(html.indexOf("image.thum.io/get") < 0, "no thum.io fetch URL may remain in index.html");
});

t("boot hygiene purges persisted thum.io error-image URLs from cards and clips", () => {
  assert.ok(html.indexOf('indexOf("image.thum.io")') >= 0, "one-time thum.io purge present in bootData");
});

// Feed module was removed in v1.11.0 — Stumble is now the home surface. The spool
// refill (stumbleFetch) is the sole path that fills the deal, and it MUST still run
// validateItems (+ rankFilter, dropAlreadySaved) before any card can be dealt.
t("stumbleFetch validates items before they enter the spool (refreshFeed is gone)", () => {
  assert.ok(html.indexOf("async function refreshFeed(") < 0, "refreshFeed must be removed");
  assert.ok(html.indexOf("function renderFeed(") < 0, "renderFeed must be removed");
  const i = html.indexOf("async function stumbleFetch(");
  assert.ok(i >= 0, "stumbleFetch present");
  const body = html.slice(i, html.indexOf("\n}", i) + 2);
  const drop = body.indexOf("dropAlreadySaved(");
  const validate = body.indexOf("validateItems(");
  const rank = body.indexOf("rankFilter(");
  assert.ok(drop >= 0, "stumbleFetch drops already-saved before spooling");
  assert.ok(rank >= 0 && rank < validate && validate < drop,
    "nested pipeline evaluates dropAlreadySaved, then validateItems, then rankFilter");
});

t("Stumble refill is bounded and reports a partially filled 2/4-card deal", () => {
  const ensure = html.slice(html.indexOf("async function ensureSpool("), html.indexOf("\n}", html.indexOf("async function ensureSpool(")) + 2);
  assert.ok(ensure.indexOf("attempts < 2") >= 0, "refill attempts are capped at two");
  const next = html.slice(html.indexOf("async function stumbleNext("), html.indexOf("\n}", html.indexOf("async function stumbleNext(")) + 2);
  assert.ok(next.indexOf("stDeal.length < need") >= 0, "partial deals show the not-enough-live-ideas message");
  const refill = html.slice(html.indexOf("async function stumbleRefill("), html.indexOf("\n}", html.indexOf("async function stumbleRefill(")) + 2);
  assert.ok(refill.indexOf("stumbleNext(true)") >= 0, "header New ideas forces a fresh spool refill");
});

t("Feed runtime surface is removed, including inline handlers", () => {
  assert.ok(html.indexOf('id="view-feed"') < 0, "Feed view is gone");
  assert.ok(!/\blet\s+feed\b/.test(html), "feed global is gone");
  assert.ok(!/onclick\s*=\s*["'][^"']*(?:renderFeed|refreshFeed)/.test(html), "no removed Feed handler remains");
  assert.ok(html.indexOf('data-tab="feed"') < 0, "Feed tab is gone");
});

t("Stumble saves user actions before awaiting replacement work", () => {
  ["stumbleVote", "stumbleSave"].forEach(name => {
    const start = html.indexOf("function "+name+"(");
    const body = html.slice(start, html.indexOf("\n}", start) + 2);
    const persist = body.indexOf("persistAll()");
    const refill = Math.max(body.indexOf("stumbleNext()"), body.indexOf("stumbleReplace(idx)"));
    assert.ok(persist >= 0 && refill > persist, name+" persists before asynchronous replacement");
  });
});

t("Stumble cards retain the v1.10.4 imageChain/noshot rendering path", () => {
  const start = html.indexOf("function stCardHTML(");
  const body = html.slice(start, html.indexOf("\n}", start) + 2);
  assert.ok(body.indexOf("imageChain(it)") >= 0, "Stumble renders through imageChain");
  assert.ok(body.indexOf("nextImg(") >= 0, "Stumble retains image fallback handling");
});

t("persisted Stumble cards are version-purged once and expire before dealing", () => {
  assert.ok(html.indexOf('load("stvalver"') >= 0, "strict-validation migration version is loaded");
  assert.ok(html.indexOf('save("stvalver"') >= 0, "strict-validation migration version is persisted");
  const start = html.indexOf("function usableSpool(");
  const body = html.slice(start, html.indexOf("\n}", start) + 2);
  assert.ok(body.indexOf("isFreshDiscoveryItem(") >= 0, "spool drops stale/unvalidated cards before dealing");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
