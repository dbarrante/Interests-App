// Tests for extension/lib/saved-parse-fb.js — pure regex/string-walk parser
// for a Facebook "Saved" page. No jsdom: fixtures are read as raw HTML and
// fed straight into parseSavedHtml, which is the primary tested path.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const FB = require("../extension/lib/saved-parse-fb.js");

let passed = 0, failed = 0;
function t(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.stack || e)); } }

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const SAMPLE = fixture("fb-saved-sample.html");
const LOGIN = fixture("fb-saved-login.html");

/* ---------- extraction ---------- */
t("extracts exactly 6 unique entries (7th li is a duplicate url)", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 6);
});

t("posts pattern: exact url/key/title/image", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "1122334455");
  assert.ok(it, "found posts entry");
  assert.strictEqual(it.url, "https://www.facebook.com/exampleplace/posts/1122334455");
  assert.strictEqual(it.title, "Sunset views at Example Place & Grill", "aria-label decoded");
  assert.strictEqual(it.image, "https://scontent.example.com/img1.jpg");
});

t("reel pattern: title falls back to inner text", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "998877665");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.facebook.com/reel/998877665");
  assert.strictEqual(it.title, "Watch this amazing reel about hiking");
  assert.strictEqual(it.image, "https://scontent.example.com/img2.jpg");
});

t("watch pattern: title falls back to nearest preceding aria-label in block", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "554433221");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.facebook.com/watch/?v=554433221");
  assert.strictEqual(it.title, "Live cooking demo video");
  assert.strictEqual(it.image, "https://scontent.example.com/img3.jpg");
});

t("photo pattern: exact key/url", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "334455667");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.facebook.com/photo/?fbid=334455667");
  assert.strictEqual(it.title, "Family photo from the reunion");
});

t("groups/<g>/posts/<id> pattern: exact key/url", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "778899001");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.facebook.com/groups/localhikers/posts/778899001");
  assert.strictEqual(it.title, "Trail conditions update for this weekend");
});

t("permalink.php pattern: key is story_fbid only (not the trailing id=)", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "445566778");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.facebook.com/permalink.php?story_fbid=445566778&id=100001234567890", "href entity-decoded");
  assert.strictEqual(it.title, "Community fundraiser announcement");
});

/* ---------- dedup ---------- */
t("dedup within one parse: duplicate url collapses to a single item", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const keys = r.items.map(i => i.platformKey);
  assert.strictEqual(new Set(keys).size, keys.length, "no repeated platformKey");
  assert.strictEqual(keys.filter(k => k === "1122334455").length, 1);
});

/* ---------- junk exclusion ---------- */
t("junk anchors (profile/hashtag/nav/login) never appear as items", () => {
  const r = FB.parseSavedHtml(SAMPLE);
  const urls = r.items.map(i => i.url);
  assert.ok(!urls.includes("https://www.facebook.com/exampleplace"), "profile link excluded");
  assert.ok(!urls.includes("https://www.facebook.com/hashtag/hiking"), "hashtag link excluded");
  assert.ok(!urls.includes("https://www.facebook.com/"), "nav link excluded");
  assert.ok(!urls.includes("https://www.facebook.com/friends/"), "nav link excluded");
  assert.ok(!urls.some(u => u.indexOf("login.php") >= 0), "login link excluded");
});

/* ---------- login detection ---------- */
t("login-required: login form markers + zero entries", () => {
  const r = FB.parseSavedHtml(LOGIN);
  assert.strictEqual(r.status, "login-required");
  assert.deepStrictEqual(r.items, []);
});

/* ---------- parse-failed ---------- */
t("parse-failed: loaded page, zero entries, no login markers", () => {
  const EMPTY = '<html><body><div id="saved-list-region"><ul class="saved-list"></ul></div>' +
    '<div id="nav"><a href="https://www.facebook.com/">Home</a></div></body></html>';
  const r = FB.parseSavedHtml(EMPTY);
  assert.strictEqual(r.status, "parse-failed");
  assert.deepStrictEqual(r.items, []);
});

/* ---------- caps ---------- */
t("caps at 100 items even with 300 recognized anchors", () => {
  let html = '<html><body><ul class="saved-list">';
  for (let i = 0; i < 300; i++) {
    html += '<li class="_saved-item"><a href="https://www.facebook.com/page' + i + '/posts/' + (1000000 + i) +
      '" aria-label="Post number ' + i + '">Post ' + i + '</a>' +
      '<img src="https://scontent.example.com/i' + i + '.jpg"></li>';
  }
  html += "</ul></body></html>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 100, "capped at 100 (all 300 are unique, so exactly 100)");
});

/* ---------- title cap ---------- */
t("title is capped at 512 chars", () => {
  const long = "X".repeat(600);
  const html = '<ul class="saved-list"><li><a href="https://www.facebook.com/p/posts/999" aria-label="' + long + '">t</a></li></ul>';
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title.length, 512);
  assert.strictEqual(r.items[0].title, long.slice(0, 512));
});

/* ---------- REVIEW FINDING 1: platformKey collision across URL shapes ---------- */
t("REGRESSION: same post id via two URL shapes collapses to ONE item (first wins)", () => {
  // Reviewer-reproduced: dedup keyed on type:id but platformKey exposed bare id,
  // so /posts/<id> + /permalink.php?story_fbid=<id> produced TWO items with the
  // SAME platformKey. Dedup must be on the bare id.
  const html = '<ul class="saved-list">' +
    '<li><a href="https://www.facebook.com/somepage/posts/5551112222" aria-label="First shape">a</a></li>' +
    '<li><a href="https://www.facebook.com/permalink.php?story_fbid=5551112222&amp;id=999" aria-label="Second shape">b</a></li>' +
    "</ul>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1, "equivalent shapes collapse");
  assert.strictEqual(r.items[0].platformKey, "5551112222");
  assert.strictEqual(r.items[0].url, "https://www.facebook.com/somepage/posts/5551112222", "first-encountered wins");
});

/* ---------- REVIEW FINDING 2: script/style bleed ---------- */
t("REGRESSION: a post anchor literal inside a <script> hydration payload is NOT extracted", () => {
  const html = '<html><body>' +
    '<script>var payload = {"html":"<a href=\\"https://www.facebook.com/ghost/posts/70707\\">Ghost</a>",' +
    ' plain: \'<a href="https://www.facebook.com/ghost2/posts/80808">Ghost2</a>\'};</script>' +
    '<style>.x{content:\'<a href="https://www.facebook.com/ghost3/posts/90909">g</a>\'}</style>' +
    '<ul class="saved-list"><li><a href="https://www.facebook.com/real/posts/12121" aria-label="Real post">r</a></li></ul>' +
    "</body></html>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1, "only the real markup anchor");
  assert.strictEqual(r.items[0].platformKey, "12121");
});
t("REGRESSION: a page whose ONLY post anchors live in <script> is parse-failed, not ok", () => {
  const html = '<html><body><script>var s = \'<a href="https://www.facebook.com/g/posts/1">x</a>\';</script>' +
    "<div>loaded page, no saved items</div></body></html>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.status, "parse-failed");
  assert.deepStrictEqual(r.items, []);
});

/* ---------- near-miss URL shapes ---------- */
t("near-miss: /watch/ URL WITHOUT a v= param does not match", () => {
  const html = '<ul class="saved-list"><li><a href="https://www.facebook.com/watch/" aria-label="Watch home">w</a></li></ul>';
  const r = FB.parseSavedHtml(html);
  assert.deepStrictEqual(r.items, []);
});
t("near-miss: a bare profile URL facebook.com/someuser does not match", () => {
  const html = '<ul class="saved-list"><li><a href="https://www.facebook.com/someuser" aria-label="Some User">p</a></li></ul>';
  const r = FB.parseSavedHtml(html);
  assert.deepStrictEqual(r.items, []);
});

/* ---------- LIVE TUNING 2026-07-19: real FB saved page is div-based, ----------
   3 anchors per card (thumbnail-img anchor + content-excerpt anchor + byline
   anchor), NO <li> wrappers. All fragments for one post must merge on key. */
function liveCard(id, img, excerpt, byline, dur) {
  // Mirrors the captured structure: anonymous divs, no aria-labels, the same
  // post URL appearing as three separate anchors.
  var u = "https://www.facebook.com/somepage/posts/" + id;
  return '<div class="x1a2b3c"><div role="none">' +
    '<a class="xq" href="' + u + '">' + (dur ? dur : "") +
    (img ? '<img class="xl1" alt="image" src="' + img + '">' : "") + "</a>" +
    '<a class="xq" href="' + u + '"><span>' + excerpt + "</span></a>" +
    '<a class="xq" href="' + u + '"><span>' + byline + "</span></a>" +
    "</div></div>";
}
t("LIVE: 3-anchor div card merges to ONE item with excerpt title + in-anchor image", () => {
  const html = "<html><body>" +
    liveCard("111222333", "https://scontent.example.com/live1.jpg",
      "Most AI agent setups fail because of architecture", "Success Steps's post") +
    "</body></html>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 1, "three anchors, one item");
  const it = r.items[0];
  assert.strictEqual(it.platformKey, "111222333");
  assert.strictEqual(it.title, "Most AI agent setups fail because of architecture", "excerpt beats byline");
  assert.strictEqual(it.image, "https://scontent.example.com/live1.jpg", "img inside a sibling anchor of the same key");
});
t("LIVE: video-duration inner text (00:52) is demoted — excerpt from sibling anchor wins", () => {
  const html = "<html><body>" +
    liveCard("444555666", "https://scontent.example.com/live2.jpg",
      "Bare Board. Orange Robot. Real Personality.", "AIPI's post", "00:52") +
    "</body></html>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title, "Bare Board. Orange Robot. Real Personality.");
});
t("LIVE: duration is still used as a LAST-resort title when nothing else exists", () => {
  const html = '<div><a href="https://www.facebook.com/reel/777888999">00:19</a></div>';
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title, "00:19");
});
t("LIVE: image-less card still yields item with excerpt title and empty image", () => {
  const html = "<html><body>" +
    liveCard("121212121", "", "A text-only saved post", "Someone's post") +
    "</body></html>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title, "A text-only saved post");
  assert.strictEqual(r.items[0].image, "");
});
t("LIVE: merge does not leak fragments ACROSS different keys", () => {
  const html = "<html><body>" +
    liveCard("101010101", "https://scontent.example.com/a.jpg", "First post excerpt", "Page A's post") +
    liveCard("202020202", "https://scontent.example.com/b.jpg", "Second post excerpt", "Page B's post") +
    "</body></html>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].image, "https://scontent.example.com/a.jpg");
  assert.strictEqual(r.items[1].image, "https://scontent.example.com/b.jpg");
  assert.strictEqual(r.items[0].title, "First post excerpt");
  assert.strictEqual(r.items[1].title, "Second post excerpt");
});

t("LIVE: /groups/<g>/permalink/<id>/ shape merges with /groups/<g>/posts/<id>/ (same card)", () => {
  // Real captured layout: the thumbnail + excerpt anchors use /permalink/,
  // only the byline anchor uses /posts/ — all three are ONE saved post.
  const html = '<div>' +
    '<a href="https://www.facebook.com/groups/471504135904363/permalink/962083820179723/">' +
    '<img alt="image" src="https://scontent.example.com/grp.jpg"></a>' +
    '<a href="https://www.facebook.com/groups/471504135904363/permalink/962083820179723/"><span>Your brain is not broken.</span></a>' +
    '<a href="https://www.facebook.com/groups/471504135904363/posts/962083820179723/"><span>The Therapeutic Bookshelf\'s post</span></a>' +
    "</div>";
  const r = FB.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1, "permalink + posts shapes collapse on the bare id");
  assert.strictEqual(r.items[0].platformKey, "962083820179723");
  assert.strictEqual(r.items[0].title, "Your brain is not broken.");
  assert.strictEqual(r.items[0].image, "https://scontent.example.com/grp.jpg");
});

/* ---------- parseSavedDoc delegation ---------- */
t("parseSavedDoc(doc) serializes documentElement.outerHTML and delegates to parseSavedHtml", () => {
  const stubDoc = { documentElement: { outerHTML: SAMPLE } };
  const viaDoc = FB.parseSavedDoc(stubDoc);
  const viaHtml = FB.parseSavedHtml(SAMPLE);
  assert.deepStrictEqual(viaDoc, viaHtml);
});
t("parseSavedDoc handles a missing/null doc without throwing", () => {
  const r = FB.parseSavedDoc(null);
  assert.strictEqual(r.status, "parse-failed");
});

/* ---------- dual export ---------- */
t("dual export: module.exports has both functions", () => {
  assert.strictEqual(typeof FB.parseSavedHtml, "function");
  assert.strictEqual(typeof FB.parseSavedDoc, "function");
});

console.log("autoimport-fb-parse.test.js: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
