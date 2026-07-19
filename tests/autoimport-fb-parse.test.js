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
