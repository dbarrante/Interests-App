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

t("validateItems drops only CONFIRMED-dead links from tier 1 (keeps alive/unknown/skipped-social)", () => {
  const body = validateItemsBody();
  assert.ok(/status\s*===\s*"dead"|"dead"/.test(body), "filters on the 'dead' status");
  // must NOT filter on the linkcheck 'skipped'/'unknown' STATUS values — those are kept
  assert.ok(body.indexOf('status==="skipped"') < 0 && body.indexOf('status==="unknown"') < 0, "only 'dead' status is dropped");
});

t("validateItems also runs the content check to drop SOFT-404s (200 OK but 'not found' body)", () => {
  const body = validateItemsBody();
  assert.ok(body.indexOf("Store.checkContent(") >= 0, "validateItems must run the tier-2 content check");
  // drops on the STRONG content signals only (dead phrase / redirect-home), never the weak 'empty'
  assert.ok(body.indexOf('"phrase:"') >= 0 && body.indexOf('"redirect-home"') >= 0, "drops on phrase / redirect-home signals");
  assert.ok(body.indexOf('"empty"') < 0, "must NOT drop on the weak 'empty' signal (would filter JS-heavy article pages)");
});

t("validateItems attaches the page's real og:image to kept items (replaces screenshot proxies)", () => {
  const body = validateItemsBody();
  assert.ok(body.indexOf("ogImage") >= 0, "uses the content check's ogImage");
  assert.ok(/i\.image\s*=/.test(body), "attaches it as the item's image");
});

t("thum.io is banned — its free tier serves an 'Image not authorized' ERROR IMAGE with HTTP 200", () => {
  assert.ok(html.indexOf("image.thum.io/get") < 0, "no thum.io fetch URL may remain in index.html");
});

t("boot hygiene purges persisted thum.io error-image URLs from cards and clips", () => {
  assert.ok(html.indexOf('indexOf("image.thum.io")') >= 0, "one-time thum.io purge present in bootData");
});

t("refreshFeed still runs validateItems before showing the feed", () => {
  const i = html.indexOf("async function refreshFeed(");
  assert.ok(i >= 0, "refreshFeed present");
  const body = html.slice(i, i + 1400);
  assert.ok(body.indexOf("validateItems(") >= 0, "refreshFeed validates items before rendering");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
