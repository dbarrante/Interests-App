// Tests for extension/lib/saved-parse-pin.js — pure regex/string-walk parser
// for the user's Pinterest all-pins page. No jsdom: fixtures are read as raw
// HTML and fed straight into parseSavedHtml, which is the primary tested path.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const PIN = require("../extension/lib/saved-parse-pin.js");

let passed = 0, failed = 0;
function t(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.stack || e)); } }

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const SAMPLE = fixture("pin-saved-sample.html");
const LOGIN = fixture("pin-saved-login.html");

/* ---------- extraction ---------- */
t("extracts exactly 4 unique pins (5th tile is a duplicate render)", () => {
  const r = PIN.parseSavedHtml(SAMPLE);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 4);
});
t("relative /pin/<id>/ href: canonical url, aria-label title, in-anchor image", () => {
  const r = PIN.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "559361216246804721");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.pinterest.com/pin/559361216246804721/");
  assert.strictEqual(it.title, "a black cat sitting in a washing machine");
  assert.strictEqual(it.image, "https://i.pinimg.com/236x/58/56/f2/cat.jpg");
});
t("junk aria 'Untitled pin page' demoted: title from prefix-stripped img alt", () => {
  const r = PIN.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "353743745729203600");
  assert.ok(it);
  assert.strictEqual(it.title, "a wooden desk with drawers", "'This contains an image of: ' prefix stripped");
});
t("absolute https://www.pinterest.com/pin/<id>/ href also matches, canonicalized", () => {
  const r = PIN.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "309411436921923858");
  assert.ok(it);
  assert.strictEqual(it.url, "https://www.pinterest.com/pin/309411436921923858/");
  assert.strictEqual(it.title, "40 Genius Garage Organization Ideas");
});
t("junk aria + EMPTY alt falls through to inner text", () => {
  const r = PIN.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.platformKey === "4610349116298537856");
  assert.ok(it);
  assert.strictEqual(it.title, "Fallback inner text title");
});

/* ---------- dedup + junk exclusion ---------- */
t("dedup: duplicate pin renders collapse to a single item", () => {
  const r = PIN.parseSavedHtml(SAMPLE);
  const keys = r.items.map(i => i.platformKey);
  assert.strictEqual(new Set(keys).size, keys.length);
});
t("junk anchors (nav/ideas/search/profile/boards) never appear as items", () => {
  const r = PIN.parseSavedHtml(SAMPLE);
  const urls = r.items.map(i => i.url);
  assert.ok(urls.every(u => /\/pin\/\d+\/$/.test(u)), "only /pin/<id>/ urls");
});
t("near-miss: a board url /someuser/board-name/ does not match", () => {
  const r = PIN.parseSavedHtml('<div><a href="/someuser/woodworking-ideas/">board</a></div>');
  assert.deepStrictEqual(r.items, []);
});

/* ---------- login / parse-failed ---------- */
t("login-required: /login/ wall + zero pins", () => {
  const r = PIN.parseSavedHtml(LOGIN);
  assert.strictEqual(r.status, "login-required");
  assert.deepStrictEqual(r.items, []);
});
t("parse-failed: loaded page, zero pins, no login markers", () => {
  const r = PIN.parseSavedHtml('<html><body><div class="grid"></div><a href="/ideas/">Ideas</a></body></html>');
  assert.strictEqual(r.status, "parse-failed");
  assert.deepStrictEqual(r.items, []);
});

/* ---------- caps ---------- */
t("caps at 100 items even with 300 recognized anchors", () => {
  let html = "<div>";
  for (let i = 0; i < 300; i++) html += '<a href="/pin/' + (1000000 + i) + '/" aria-label="Pin ' + i + '"><img alt="" src="https://i.pinimg.com/x/i' + i + '.jpg"></a>';
  html += "</div>";
  const r = PIN.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 100);
});
t("title is capped at 512 chars", () => {
  const long = "X".repeat(600);
  const r = PIN.parseSavedHtml('<div><a href="/pin/999/" aria-label="' + long + '">t</a></div>');
  assert.strictEqual(r.items[0].title.length, 512);
});

/* ---------- script/style bleed ---------- */
t("REGRESSION: a pin anchor literal inside a <script> hydration payload is NOT extracted", () => {
  const html = '<html><body>' +
    '<script>var p = \'<a href="/pin/70707/">Ghost</a>\';</script>' +
    '<div><a href="/pin/12121/" aria-label="Real pin"><img alt="" src="https://i.pinimg.com/x/r.jpg"></a></div>' +
    "</body></html>";
  const r = PIN.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].platformKey, "12121");
});
t("REGRESSION: a page whose ONLY pin anchors live in <script> is parse-failed, not ok", () => {
  const r = PIN.parseSavedHtml('<html><body><script>var s = \'<a href="/pin/1/">x</a>\';</script><div>no pins</div></body></html>');
  assert.strictEqual(r.status, "parse-failed");
});

/* ---------- LIVE capture replay (local-only; skipped when absent) ---------- */
t("LIVE capture replays: >=17 pins, canonical urls, every pin has an image", () => {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, "..", "_livecapture", "pinterest-saved.html"), "utf8"); }
  catch (e) { return; }   // personal capture is gitignored — skip on other machines
  const r = PIN.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.ok(r.items.length >= 17, "found " + r.items.length);
  r.items.forEach(i => assert.ok(/^https:\/\/www\.pinterest\.com\/pin\/\d+\/$/.test(i.url), i.url));
  assert.ok(r.items.every(i => i.image), "every live pin tile carries its img");
  assert.ok(r.items.every(i => i.title), "every live pin resolved a title");
});

/* ---------- parseSavedDoc delegation + exports ---------- */
t("parseSavedDoc(doc) delegates to parseSavedHtml", () => {
  const viaDoc = PIN.parseSavedDoc({ documentElement: { outerHTML: SAMPLE } });
  assert.deepStrictEqual(viaDoc, PIN.parseSavedHtml(SAMPLE));
});
t("parseSavedDoc handles a null doc without throwing", () => {
  assert.strictEqual(PIN.parseSavedDoc(null).status, "parse-failed");
});
t("dual export present", () => {
  assert.strictEqual(typeof PIN.parseSavedHtml, "function");
  assert.strictEqual(typeof PIN.parseSavedDoc, "function");
});

console.log("autoimport-pin-parse: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
