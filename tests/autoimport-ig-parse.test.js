// Tests for extension/lib/saved-parse-ig.js — pure regex/string-walk parser
// for an Instagram "Saved" page. No jsdom: fixtures are read as raw HTML and
// fed straight into parseSavedHtml, which is the primary tested path.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const IG = require("../extension/lib/saved-parse-ig.js");

let passed = 0, failed = 0;
function t(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.stack || e)); } }

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const SAMPLE = fixture("ig-saved-sample.html");
const LOGIN = fixture("ig-saved-login.html");

/* ---------- extraction ---------- */
t("extracts exactly 4 unique entries (5th li is a duplicate url)", () => {
  const r = IG.parseSavedHtml(SAMPLE);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 4);
});

t("/p/<shortcode>/ pattern: title from own aria-label", () => {
  const r = IG.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "CabC123xyz");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.instagram.com/p/CabC123xyz/");
  assert.strictEqual(it.title, "A hike through the redwoods");
  assert.strictEqual(it.image, "https://scontent-ig.example.com/p1.jpg");
});

t("/reel/<shortcode>/ pattern: title falls back to nearest preceding aria-label in block", () => {
  const r = IG.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "DreelABC1");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.instagram.com/reel/DreelABC1/");
  assert.strictEqual(it.title, "A short clip from the coast trail");
  assert.strictEqual(it.image, "https://scontent-ig.example.com/p2.jpg");
});

t("/p/<shortcode>/ pattern: title falls back to inner text", () => {
  const r = IG.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "CxyzShort2");
  assert.ok(it);
  assert.strictEqual(it.title, "Best croissant in the city, hands down");
  assert.strictEqual(it.image, "https://scontent-ig.example.com/p3.jpg");
});

t("/reel/<shortcode>/ pattern: title from own aria-label", () => {
  const r = IG.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "DreelXYZ9");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.instagram.com/reel/DreelXYZ9/");
  assert.strictEqual(it.title, "Backyard garden tour reel");
  assert.strictEqual(it.image, "https://scontent-ig.example.com/p4.jpg");
});

/* ---------- dedup ---------- */
t("dedup within one parse: duplicate url collapses to a single item", () => {
  const r = IG.parseSavedHtml(SAMPLE);
  const keys = r.items.map(i => i.platformKey);
  assert.strictEqual(new Set(keys).size, keys.length, "no repeated platformKey");
  assert.strictEqual(keys.filter(k => k === "CabC123xyz").length, 1);
});

/* ---------- junk exclusion ---------- */
t("junk anchors (profile/explore/hashtag/nav/login) never appear as items", () => {
  const r = IG.parseSavedHtml(SAMPLE);
  const urls = r.items.map(i => i.url);
  assert.ok(!urls.includes("https://www.instagram.com/someuser/"), "profile link excluded");
  assert.ok(!urls.includes("https://www.instagram.com/explore/tags/travel/"), "hashtag/explore link excluded");
  assert.ok(!urls.includes("https://www.instagram.com/"), "nav link excluded");
  assert.ok(!urls.includes("https://www.instagram.com/accounts/login/"), "login link excluded");
});

/* ---------- login detection ---------- */
t("login-required: loginForm marker + /accounts/login/ + zero entries", () => {
  const r = IG.parseSavedHtml(LOGIN);
  assert.strictEqual(r.status, "login-required");
  assert.deepStrictEqual(r.items, []);
});

/* ---------- parse-failed ---------- */
t("parse-failed: loaded page, zero entries, no login markers", () => {
  const EMPTY = '<html><body><div id="saved-collection"><ul class="saved-grid"></ul></div>' +
    '<div id="nav"><a href="https://www.instagram.com/">Home</a></div></body></html>';
  const r = IG.parseSavedHtml(EMPTY);
  assert.strictEqual(r.status, "parse-failed");
  assert.deepStrictEqual(r.items, []);
});

/* ---------- caps ---------- */
t("caps at 100 items even with 300 recognized anchors", () => {
  let html = '<html><body><ul class="saved-grid">';
  for (let i = 0; i < 300; i++) {
    html += '<li class="_ig-item"><a href="https://www.instagram.com/p/Short' + i +
      'code/" aria-label="Post number ' + i + '">Post ' + i + '</a>' +
      '<img src="https://scontent-ig.example.com/i' + i + '.jpg"></li>';
  }
  html += "</ul></body></html>";
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 100, "capped at 100 (all 300 are unique, so exactly 100)");
});

/* ---------- title cap ---------- */
t("title is capped at 512 chars", () => {
  const long = "X".repeat(600);
  const html = '<ul class="saved-grid"><li><a href="https://www.instagram.com/p/CAP001/" aria-label="' + long + '">t</a></li></ul>';
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title.length, 512);
  assert.strictEqual(r.items[0].title, long.slice(0, 512));
});

/* ---------- REVIEW FINDING 1: platformKey collision across URL shapes ---------- */
t("REGRESSION: same shortcode via /p/ AND /reel/ collapses to ONE item (first wins)", () => {
  // Mirror of the FB finding: dedup keyed on type:id but platformKey exposed the
  // bare shortcode, so /p/<code>/ + /reel/<code>/ produced TWO items with the
  // SAME platformKey. Dedup must be on the bare shortcode.
  const html = '<ul class="saved-grid">' +
    '<li><a href="https://www.instagram.com/p/SameCode1/" aria-label="First shape">a</a></li>' +
    '<li><a href="https://www.instagram.com/reel/SameCode1/" aria-label="Second shape">b</a></li>' +
    "</ul>";
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1, "equivalent shapes collapse");
  assert.strictEqual(r.items[0].platformKey, "SameCode1");
  assert.strictEqual(r.items[0].url, "https://www.instagram.com/p/SameCode1/", "first-encountered wins");
});

/* ---------- REVIEW FINDING 2: script/style bleed ---------- */
t("REGRESSION: a post anchor literal inside a <script> hydration payload is NOT extracted", () => {
  const html = '<html><body>' +
    '<script>var payload = {"html":"<a href=\\"https://www.instagram.com/p/GhostAAA1/\\">Ghost</a>",' +
    ' plain: \'<a href="https://www.instagram.com/reel/GhostBBB2/">Ghost2</a>\'};</script>' +
    '<style>.x{content:\'<a href="https://www.instagram.com/p/GhostCCC3/">g</a>\'}</style>' +
    '<ul class="saved-grid"><li><a href="https://www.instagram.com/p/RealDDD4/" aria-label="Real post">r</a></li></ul>' +
    "</body></html>";
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1, "only the real markup anchor");
  assert.strictEqual(r.items[0].platformKey, "RealDDD4");
});
t("REGRESSION: a page whose ONLY post anchors live in <script> is parse-failed, not ok", () => {
  const html = '<html><body><script>var s = \'<a href="https://www.instagram.com/p/GhostX/">x</a>\';</script>' +
    "<div>loaded page, no saved items</div></body></html>";
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.status, "parse-failed");
  assert.deepStrictEqual(r.items, []);
});

/* ---------- near-miss URL shapes ---------- */
t("near-miss: /explore/p/<code>/ does not match", () => {
  const html = '<ul class="saved-grid"><li><a href="https://www.instagram.com/explore/p/NopeCode1/" aria-label="explore">e</a></li></ul>';
  const r = IG.parseSavedHtml(html);
  assert.deepStrictEqual(r.items, []);
});

/* ---------- LIVE TUNING 2026-07-19: real IG saved page uses RELATIVE ----------
   hrefs (/p/<code>/), one <a> per tile wrapping the <img>, caption in the
   img's alt attribute, and junk overlay inner text ("Clip") on video tiles. */
t("LIVE: relative /p/ href + alt caption + in-anchor img — url absolutized", () => {
  const html = '<div><a class="x1i" href="/p/DaB0Live1/" role="link" tabindex="0">' +
    '<div><div style="padding-bottom: 133.333%;">' +
    '<img alt="Woah.. my room looks like outer space 🌌 #galaxy" crossorigin="anonymous" src="https://scontent-x.cdninstagram.com/v/t51/live1.jpg"></div></div></a></div>';
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 1);
  const it = r.items[0];
  assert.strictEqual(it.platformKey, "DaB0Live1");
  assert.strictEqual(it.url, "https://www.instagram.com/p/DaB0Live1/", "relative href absolutized");
  assert.strictEqual(it.title, "Woah.. my room looks like outer space 🌌 #galaxy");
  assert.strictEqual(it.image, "https://scontent-x.cdninstagram.com/v/t51/live1.jpg");
});
t("LIVE: junk 'Clip' overlay inner text is beaten by the img alt caption", () => {
  const html = '<div><a href="/p/DVid22Code/" role="link">' +
    '<img alt="Polishing basics for 3D prints" src="https://scontent-x.cdninstagram.com/v/vid22.jpg">' +
    "<span>Clip</span></a></div>";
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title, "Polishing basics for 3D prints", "alt beats overlay text");
});
t("LIVE: relative /reel/ href also matches and absolutizes", () => {
  const html = '<div><a href="/reel/DReelLive3/"><img alt="A reel caption" src="https://scontent-x.cdninstagram.com/r3.jpg"></a></div>';
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].url, "https://www.instagram.com/reel/DReelLive3/");
  assert.strictEqual(r.items[0].platformKey, "DReelLive3");
});
t("LIVE: tile with EMPTY alt falls back to inner text", () => {
  const html = '<div><a href="/p/DNoAlt44/"><img alt="" src="https://scontent-x.cdninstagram.com/n44.jpg">Fallback text</a></div>';
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title, "Fallback text");
  assert.strictEqual(r.items[0].image, "https://scontent-x.cdninstagram.com/n44.jpg");
});
t("REGRESSION: username-prefixed profile-grid hrefs (/saved/p/…, /someuser/p/…) do NOT match", () => {
  // 2026-07-19 incident: instagram.com/saved/ is the PROFILE of a real
  // account named @saved, whose grid renders "/saved/p/<code>/" links — a
  // parser that accepted a "/saved" prefix imported @saved's OWN posts as if
  // they were the user's saves. Profile-grid links (any "/<username>/p/…")
  // must never match; only viewer-context "/p/…" and "/reel/…" tiles do.
  const html = '<div>' +
    '<a href="/saved/p/ClhZzI0uH8W/"><img alt="Photo by SAVED" src="https://scontent-x.cdninstagram.com/sp.jpg"></a>' +
    '<a href="/saved/reel/CuvYouwLExQ/"><img alt="Reel by SAVED" src="https://scontent-x.cdninstagram.com/sr.jpg"></a>' +
    '<a href="/someuser/p/CxOther111/"><img alt="Someone else" src="https://scontent-x.cdninstagram.com/su.jpg"></a>' +
    "</div>";
  const r = IG.parseSavedHtml(html);
  assert.deepStrictEqual(r.items, [], "profile-grid posts are not the viewer's saves");
});
t("LIVE: canonical url delivered for plain /p/ and /reel/ hrefs", () => {
  const html = '<div><a href="/p/ClhZzI0uH8W/"><img alt="mine" src="https://scontent-x.cdninstagram.com/m.jpg"></a></div>';
  const r = IG.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].url, "https://www.instagram.com/p/ClhZzI0uH8W/", "canonical form");
});
t("LIVE near-miss: relative /explore/p/ and profile hrefs do not match", () => {
  const html = '<div><a href="/explore/p/NopeRel1/">e</a><a href="/someuser/">u</a><a href="/reels/">r</a></div>';
  const r = IG.parseSavedHtml(html);
  assert.deepStrictEqual(r.items, []);
});

/* ---------- parseSavedDoc delegation ---------- */
t("parseSavedDoc(doc) serializes documentElement.outerHTML and delegates to parseSavedHtml", () => {
  const stubDoc = { documentElement: { outerHTML: SAMPLE } };
  const viaDoc = IG.parseSavedDoc(stubDoc);
  const viaHtml = IG.parseSavedHtml(SAMPLE);
  assert.deepStrictEqual(viaDoc, viaHtml);
});
t("parseSavedDoc handles a missing/null doc without throwing", () => {
  const r = IG.parseSavedDoc(null);
  assert.strictEqual(r.status, "parse-failed");
});

/* ---------- dual export ---------- */
t("dual export: module.exports has both functions", () => {
  assert.strictEqual(typeof IG.parseSavedHtml, "function");
  assert.strictEqual(typeof IG.parseSavedDoc, "function");
});

console.log("autoimport-ig-parse.test.js: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
