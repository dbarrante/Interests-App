// 2026-08-05: FB /watch/ and /reel/ recapture reported as "taking a long time and
// opening the page up multiple times before actually capturing". Root cause: these
// pages are FB's dedicated video-player layout, not a feed post — capture-core.js's
// findMainPost() requires [role="article"], which never exists there, so every
// render attempt was guaranteed to find nothing (confirmed live via the SW console:
// src=none on all 3 tries, every time, before falling back to the working
// captureFbByOg og:image fetch). renderCaptureFb's reload-retry loop (background.js)
// then burned ~5-6.5s per extra try reloading a tab that could never succeed, and
// capture-core.js's in-page loop burned a fixed 18s per try waiting for a post photo
// that could never lazy-load (there's no post). Fix: 1 render try instead of 3 for
// these URLs (still catches a deleted video via isUnavailable's body-text fallback),
// and 8s instead of 18s internal wait before giving up on that one try (an earlier
// version of this fix used 3s, but review found that also starved deleted-video
// detection, which shares the same deadline — see the margin test below). Plain
// source-assertion style (same as tests/ext-sw-driver.test.js) — no chrome.* mock
// harness exists for this extension.
const assert = require("assert");
const fs = require("fs"), path = require("path");

const extDir = path.join(__dirname, "..", "extension");
const bg = fs.readFileSync(path.join(extDir, "background.js"), "utf8");
const core = fs.readFileSync(path.join(extDir, "capture-core.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

t("background.js defines FB_NO_RETRY_RE matching /watch/ and /reel/ paths", () => {
  const m = bg.match(/const FB_NO_RETRY_RE = (\/[^\n]+\/[a-z]*);/);
  assert.ok(m, "FB_NO_RETRY_RE must be defined as a regex literal");
  const re = eval(m[1]);
  assert.ok(re.test("https://www.facebook.com/watch/?ref=saved&v=123"), "must match /watch/ URLs");
  assert.ok(re.test("https://www.facebook.com/reel/807887365685688/"), "must match /reel/ URLs");
  assert.ok(!re.test("https://www.facebook.com/wayne.kubeck/posts/pfbid123"), "must NOT match a normal post permalink");
});

t("renderCaptureFb caps retries at 1 for FB_NO_RETRY_RE URLs, RENDER_MAX_TRIES otherwise", () => {
  const start = bg.indexOf("async function renderCaptureFb");
  assert.ok(start >= 0, "renderCaptureFb not found");
  const body = bg.slice(start, start + 2600);
  assert.ok(/const maxTries = FB_NO_RETRY_RE\.test\(url\) \? 1 : RENDER_MAX_TRIES;/.test(body),
    "maxTries must be 1 for video-page URLs, RENDER_MAX_TRIES for everything else");
  assert.ok(/for \(let attempt = 1; attempt <= maxTries; attempt\+\+\)/.test(body),
    "the retry loop bound must use maxTries, not the RENDER_MAX_TRIES constant directly");
});

t("capture-core.js shortens the in-page wait for video pages (no post card can ever appear)", () => {
  const start = core.indexOf('if (!msg || msg.action !== "autoCaptureFB") return;');
  assert.ok(start >= 0, "autoCaptureFB handler not found");
  const body = core.slice(start, start + 1400);
  assert.ok(/const isVideoPage = \/\^\\\/\(watch\|reel\)/.test(body), "isVideoPage detection must be present");
  assert.ok(/const MAX_WAIT = isVideoPage \? \d+ : 18000;/.test(body), "MAX_WAIT must differ on video pages, stay 18000ms elsewhere");
});

// Regression (caught in review): an earlier version of this fix set the video-page
// MAX_WAIT to 3000ms. isUnavailable() is polled on every tick of the SAME loop that
// enforces MAX_WAIT (capture-core.js's autoCaptureFB handler), so shortening that
// deadline also shortens the window to detect a deleted video's "content isn't
// available" interstitial — which can take longer than 3s to paint. A miss falls
// through to captureFbByOg(), which has NO deletion check, silently keeping a dead
// card instead of removing it. This test extracts the real constants from source (so
// it can't drift from the code) and asserts a real margin exists between the
// isUnavailable gate and MAX_WAIT — not just that isUnavailable() is textually
// present (which was true even when the margin was too thin to matter).
t("video-page MAX_WAIT leaves deleted-post detection a real margin after its gate opens", () => {
  const mwMatch = core.match(/const MAX_WAIT = isVideoPage \? (\d+) : 18000;/);
  assert.ok(mwMatch, "MAX_WAIT ternary not found");
  const videoMaxWait = Number(mwMatch[1]);

  const gateMatch = core.match(/waited >= (\d+) && isUnavailable\(post\)/);
  assert.ok(gateMatch, "isUnavailable gate (waited >= N && isUnavailable(post)) not found");
  const deadGate = Number(gateMatch[1]);

  const margin = videoMaxWait - deadGate;
  assert.ok(margin >= 4000,
    `video-page MAX_WAIT (${videoMaxWait}ms) must leave the deleted-post interstitial at least 4s to paint after ` +
    `the isUnavailable gate opens at ${deadGate}ms — only got ${margin}ms (the regression found in review used ` +
    `MAX_WAIT=3000, a ${3000 - deadGate}ms margin)`);
});

t("dead/deleted-post detection still runs on the single video-page render try (isUnavailable unchanged)", () => {
  // isUnavailable() falls back to document.body.innerText when there's no post element,
  // so it still works even though findMainPost() always returns null on /watch/ + /reel/ —
  // this is what lets us safely cut retries to 1 without losing deletion detection.
  const start = core.indexOf("const isUnavailable = function (post) {");
  assert.ok(start >= 0, "isUnavailable not found");
  const body = core.slice(start, start + 400);
  assert.ok(/document\.body && document\.body\.innerText/.test(body),
    "isUnavailable must still fall back to document.body.innerText when post is null");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
