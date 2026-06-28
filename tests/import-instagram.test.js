const assert = require("assert");
const { parseInstagramSaved } = require("../web/import-instagram");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

const SAVED = (entries) => ({ saved_saved_media: entries });
const entry = (username, href, ts, key) => ({ title: username, string_map_data: { [key || "Saved on"]: { href: href, timestamp: ts } } });

test("parses a saved entry -> title/url/ts", () => {
  const r = parseInstagramSaved(SAVED([entry("natgeo", "https://www.instagram.com/p/ABC123/", 1700000000)]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "natgeo");
  assert.strictEqual(r[0].url, "https://www.instagram.com/p/ABC123/");
  assert.strictEqual(r[0].ts, 1700000000);
});
test("multiple entries; one without an instagram href is skipped", () => {
  const r = parseInstagramSaved(SAVED([
    entry("a", "https://www.instagram.com/p/A/", 1),
    entry("b", "https://example.com/x", 2),            // not instagram -> skip
    entry("c", "https://instagram.com/p/C/", 3),
  ]));
  assert.deepStrictEqual(r.map(i => i.title), ["a", "c"]);
});
test("a likes_media_likes object is NOT parsed -> []", () => {
  assert.deepStrictEqual(parseInstagramSaved({ likes_media_likes: [entry("x", "https://instagram.com/p/X/", 1)] }), []);
});
test("null / undefined / {} / [] / non-IG values -> [] (no throw)", () => {
  [null, undefined, {}, [], 5, "x", { foo: 1 }].forEach(v => assert.deepStrictEqual(parseInstagramSaved(v), []));
});
test("a localized string_map_data key with an href is still parsed", () => {
  const r = parseInstagramSaved(SAVED([entry("user", "https://www.instagram.com/p/L/", 9, "Enregistré le")]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, "https://www.instagram.com/p/L/");
});
test("a unicode-escaped username passes through without crashing", () => {
  const r = parseInstagramSaved(SAVED([entry("café_lover", "https://www.instagram.com/p/U/", 7)]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "café_lover");
});
test("an entry missing string_map_data (or null) is skipped, not fatal", () => {
  const r = parseInstagramSaved(SAVED([{ title: "x" }, null, entry("ok", "https://instagram.com/p/O/", 1)]));
  assert.deepStrictEqual(r.map(i => i.title), ["ok"]);
});

// ---- NEW Meta export format: top-level ARRAY of { timestamp, media, label_values, fbid } ----
// The post URL lives in a label_values entry labelled "URL" (.href/.value); the
// saved date is the top-level timestamp; the caption is the "Caption" entry.
const NEW = (url, caption, ts, titleVal) => ({
  timestamp: ts, media: [], fbid: "fb",
  label_values: [
    { label: "URL", value: url, href: url },
    { label: "Caption", value: caption == null ? "" : caption },
    { label: "Title", value: titleVal == null ? "" : titleVal },
  ],
});

test("NEW format: parses url from the 'URL' label + ts from top-level timestamp + caption as title", () => {
  const r = parseInstagramSaved([NEW("https://www.instagram.com/p/ABC123/", "Sunset over the bay", 1700000000)]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, "https://www.instagram.com/p/ABC123/");
  assert.strictEqual(r[0].ts, 1700000000);
  assert.strictEqual(r[0].title, "Sunset over the bay");
});
test("NEW format: empty caption -> title falls back to the post shortcode", () => {
  const r = parseInstagramSaved([NEW("https://www.instagram.com/reel/XY9/", "", 5)]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "Instagram post XY9");
});
test("NEW format: an explicit non-empty Title label wins over the caption (caption -> desc)", () => {
  const r = parseInstagramSaved([NEW("https://www.instagram.com/p/T/", "a caption", 1, "My Title")]);
  assert.strictEqual(r[0].title, "My Title");
  assert.strictEqual(r[0].desc, "a caption");
});
test("NEW format: a non-instagram URL label is skipped", () => {
  assert.deepStrictEqual(parseInstagramSaved([NEW("https://example.com/x", "cap", 1)]), []);
});
test("NEW format: two distinct posts with the SAME caption each survive (no collapse)", () => {
  const r = parseInstagramSaved([
    NEW("https://www.instagram.com/p/A/", "same caption", 1),
    NEW("https://www.instagram.com/p/B/", "same caption", 2),
  ]);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map(i => i.url).sort(), ["https://www.instagram.com/p/A/", "https://www.instagram.com/p/B/"]);
});
test("NEW format: an item with no 'URL' label (a collection folder) is skipped, not fatal", () => {
  const r = parseInstagramSaved([{ timestamp: 1, media: [], fbid: "x", label_values: [{ label: "Name", value: "My Collection" }] }]);
  assert.deepStrictEqual(r, []);
});
test("NEW format: href is used when value is absent", () => {
  const r = parseInstagramSaved([{ timestamp: 2, label_values: [{ label: "URL", href: "https://www.instagram.com/p/H/" }] }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, "https://www.instagram.com/p/H/");
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
