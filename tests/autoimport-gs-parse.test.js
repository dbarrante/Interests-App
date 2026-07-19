// Tests for extension/lib/saved-parse-gs.js — pure parser for Google's
// "All saved items" list (google.com/interests/saved/list/allsaves).
//
// FIXTURE HYGIENE (data-safety review 2026-07-19, HIGH): every domain, title,
// handle, and id below is INVENTED (.example hosts). Never transcribe strings
// from _livecapture/ captures into committed fixtures — those are the user's
// real saves. The LIVE replay test at the bottom reads the gitignored capture
// directly and skips cleanly where it's absent.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const GS = require("../extension/lib/saved-parse-gs.js");

let passed = 0, failed = 0;
function t(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.stack || e)); } }

// Shape modeled on the 2026-07-19 capture: each item is an anchor PAIR to the
// same target — thumbnail anchor (img, no aria) + title anchor (aria + inner
// text); most targets wrapped as google.com/url?q=…&usg=….
const SAMPLE = '<html><body>' +
  '<div id="nav"><a href="https://www.google.com/save?authuser=0">Saved</a>' +
  '<a href="https://www.google.com/intl/en/about/products">Google apps</a>' +
  '<a href="https://accounts.google.com/SignOutOptions?hl=en">Sign out</a>' +
  '<a href="./interests/saved/new-collection?hl=en">Create</a></div>' +
  '<div class="items">' +
  '<a href="https://www.google.com/url?q=https://gadget-week.example/rgb-toaster-review&amp;usg=AAA"><img src="https://lh3.googleusercontent.com/thumb1"></a>' +
  '<a href="https://www.google.com/url?q=https://gadget-week.example/rgb-toaster-review&amp;usg=AAA" aria-label="The RGB toaster nobody asked for, reviewed">The RGB toaster nobody asked for, reviewed</a>' +
  '<a href="https://www.google.com/url?q=https%3A%2F%2Fmakerforum.example%2Fthreads%2F42&amp;usg=BBB"><img src="https://lh3.googleusercontent.com/thumb2"></a>' +
  '<a href="https://www.google.com/url?q=https%3A%2F%2Fmakerforum.example%2Fthreads%2F42&amp;usg=BBB" aria-label="Threaded insert jig discussion">Threaded insert jig discussion</a>' +
  '<a href="https://videos.example/watch?v=FAKEvid0001" aria-label="A direct-linked saved video"><img src="https://thumbs.videos.example/FAKEvid0001.jpg"></a>' +
  '<a href="https://www.google.com/url?q=https://shop.example/a?utm_source=x%26keep=1&amp;usg=CCC" aria-label="Tracking-params item">Tracking-params item</a>' +
  '</div></body></html>';

/* ---------- extraction + merge ---------- */
t("extracts 4 items: anchor pairs merged per normalized target", () => {
  const r = GS.parseSavedHtml(SAMPLE);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.items.length, 4);
});
t("/url?q= wrapper unwrapped: url is the EXTERNAL target, title from the aria anchor, image from the thumb anchor", () => {
  const r = GS.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.url === "https://gadget-week.example/rgb-toaster-review");
  assert.ok(it, "unwrapped target url");
  assert.strictEqual(it.title, "The RGB toaster nobody asked for, reviewed");
  assert.strictEqual(it.image, "https://lh3.googleusercontent.com/thumb1", "image merged from the paired thumbnail anchor");
  assert.strictEqual(it.platformKey, "gadget-week.example/rgb-toaster-review");
});
t("percent-ENCODED q= target decodes", () => {
  const r = GS.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.url === "https://makerforum.example/threads/42");
  assert.ok(it, "decoded target present");
  assert.strictEqual(it.title, "Threaded insert jig discussion");
});
t("DIRECT external anchor with card evidence (aria/img) is an item", () => {
  const r = GS.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => i.url === "https://videos.example/watch?v=FAKEvid0001");
  assert.ok(it);
  assert.strictEqual(it.title, "A direct-linked saved video");
});
t("platformKey normalizes: utm params stripped, host lowercased", () => {
  const r = GS.parseSavedHtml(SAMPLE);
  const it = r.items.find(i => /shop\.example/.test(i.url));
  assert.ok(it);
  assert.strictEqual(it.platformKey, "shop.example/a?keep=1", "utm_source stripped, keep param kept");
});
t("REVIEW LOW: a normalized key longer than 120 chars is HASHED, never dropped (core caps platformKey at 128)", () => {
  const longPath = "/very/deep/path/" + "seg/".repeat(40) + "article";
  const r = GS.parseSavedHtml('<div><a href="https://www.google.com/url?q=https://longsite.example' + longPath + '&amp;usg=Z" aria-label="Deep item">t</a></div>');
  assert.strictEqual(r.items.length, 1);
  const key = r.items[0].platformKey;
  assert.ok(key.length <= 128, "fits the core cap: " + key.length);
  assert.ok(/^h:[0-9a-z]+$/.test(key), "stable hash form, got " + key);
  // determinism: same input -> same key
  const r2 = GS.parseSavedHtml('<div><a href="https://www.google.com/url?q=https://longsite.example' + longPath + '&amp;usg=Z" aria-label="Deep item">t</a></div>');
  assert.strictEqual(r2.items[0].platformKey, key);
});

/* ---------- junk exclusion ---------- */
t("google-hosted nav/sign-out/product links never import", () => {
  const r = GS.parseSavedHtml(SAMPLE);
  assert.ok(r.items.every(i => !/google\.com|accounts\.google/.test(i.url)), "no google-host items");
});
t("a bare external footer TEXT link (no aria, no img) does not import", () => {
  const r = GS.parseSavedHtml('<div class="items"><a href="https://policies.example.com/terms">Terms</a>' +
    '<a href="https://www.google.com/url?q=https://real.example.com/item&amp;usg=X" aria-label="Real item">Real item</a></div>');
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].url, "https://real.example.com/item");
});
t("a /url?q= wrapper whose target is itself google-hosted is ignored", () => {
  const r = GS.parseSavedHtml('<div><a href="https://www.google.com/url?q=https://www.google.com/maps/place/x&amp;usg=Y" aria-label="maps">m</a></div>');
  assert.deepStrictEqual(r.items, []);
});

/* ---------- login/consent + parse-failed ---------- */
t("login-required: accounts.google ServiceLogin / consent wall", () => {
  const r = GS.parseSavedHtml('<html><body><a href="https://accounts.google.com/ServiceLogin?continue=x">Sign in</a></body></html>');
  assert.strictEqual(r.status, "login-required");
  const r2 = GS.parseSavedHtml('<html><body>redirecting to <a href="https://consent.google.com/m?continue=x">consent</a></body></html>');
  assert.strictEqual(r2.status, "login-required");
});
t("parse-failed: loaded page, zero items, no login markers", () => {
  const r = GS.parseSavedHtml('<html><body><div class="items"></div></body></html>');
  assert.strictEqual(r.status, "parse-failed");
});

/* ---------- caps + script bleed ---------- */
t("caps at 100 distinct items", () => {
  let html = "<div>";
  for (let i = 0; i < 300; i++) html += '<a href="https://www.google.com/url?q=https://ex.example/p' + i + '&amp;usg=Z" aria-label="Item ' + i + '">t</a>';
  html += "</div>";
  const r = GS.parseSavedHtml(html);
  assert.strictEqual(r.items.length, 100);
});
t("title capped at 512", () => {
  const long = "X".repeat(600);
  const r = GS.parseSavedHtml('<div><a href="https://www.google.com/url?q=https://ex.example/l&amp;usg=Z" aria-label="' + long + '">t</a></div>');
  assert.strictEqual(r.items[0].title.length, 512);
});
t("REGRESSION: item markup inside <script> payloads is NOT extracted", () => {
  const r = GS.parseSavedHtml('<html><body><script>var s=\'<a href="https://www.google.com/url?q=https://ghost.example.com/x&usg=G" aria-label="ghost">g</a>\';</script><div>none</div></body></html>');
  assert.strictEqual(r.status, "parse-failed");
});

/* ---------- LIVE capture replay (local-only; skipped when absent) ---------- */
t("LIVE capture replays: >=80 items, external urls only, titles resolved", () => {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, "..", "_livecapture", "All saved items.html"), "utf8"); }
  catch (e) { return; }   // personal capture is gitignored — skip on other machines
  const r = GS.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.ok(r.items.length >= 80, "found " + r.items.length);
  assert.ok(r.items.every(i => !/(^|\.)google\./.test((i.url.split("/")[2] || ""))), "no google-host urls");
  const titled = r.items.filter(i => i.title).length;
  assert.ok(titled >= r.items.length * 0.9, "titles on " + titled + "/" + r.items.length);
});

/* ---------- delegation + exports ---------- */
t("parseSavedDoc(doc) delegates; null doc safe", () => {
  assert.deepStrictEqual(GS.parseSavedDoc({ documentElement: { outerHTML: SAMPLE } }), GS.parseSavedHtml(SAMPLE));
  assert.strictEqual(GS.parseSavedDoc(null).status, "parse-failed");
});

console.log("autoimport-gs-parse: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
