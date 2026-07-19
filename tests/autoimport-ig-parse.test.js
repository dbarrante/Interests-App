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
