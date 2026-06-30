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

t("validateItems uses the Core dead-link probe (Store.checkLinks), not allorigins", () => {
  const i = html.indexOf("async function validateItems(");
  assert.ok(i >= 0, "validateItems present");
  const body = html.slice(i, i + 900);
  assert.ok(body.indexOf("Store.checkLinks(") >= 0, "validateItems must call Store.checkLinks");
  assert.ok(body.indexOf("allorigins") < 0, "validateItems must NOT use the api.allorigins.win proxy");
});

t("validateItems drops only CONFIRMED-dead links (keeps alive/unknown/skipped-social)", () => {
  const i = html.indexOf("async function validateItems(");
  const body = html.slice(i, i + 900);
  assert.ok(/status\s*===\s*"dead"|"dead"/.test(body), "filters on the 'dead' status");
  // must NOT filter on 'skipped' (social hosts) or 'unknown' — those are kept
  assert.ok(body.indexOf('"skipped"') < 0 && body.indexOf('"unknown"') < 0, "only 'dead' is dropped, not skipped/unknown");
});

t("refreshFeed still runs validateItems before showing the feed", () => {
  const i = html.indexOf("async function refreshFeed(");
  assert.ok(i >= 0, "refreshFeed present");
  const body = html.slice(i, i + 1400);
  assert.ok(body.indexOf("validateItems(") >= 0, "refreshFeed validates items before rendering");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
