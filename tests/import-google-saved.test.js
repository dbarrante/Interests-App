const assert = require("assert");
const { parseGoogleSaved } = require("../web/import-google-saved");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

test("parses a Title,Note,URL Google Saved CSV with Note -> desc", () => {
  const csv = "Title,Note,URL\nGreat Recipe,Try this weekend,https://r.example.com/x\n";
  const r = parseGoogleSaved(csv);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "Great Recipe");
  assert.strictEqual(r[0].url, "https://r.example.com/x");
  assert.strictEqual(r[0].desc, "Try this weekend");
});
test("a YouTube subscriptions header (Channel*) -> [] (so parseCSV handles it)", () => {
  const csv = "Channel Id,Channel Url,Channel Title\nUC123,https://youtube.com/c/x,Some Channel\n";
  assert.deepStrictEqual(parseGoogleSaved(csv), []);
});
test("a quoted field containing a comma is parsed correctly", () => {
  const csv = 'Title,Note,URL\n"Cookies, Cakes & Pies","best, ever",https://b.example.com\n';
  const r = parseGoogleSaved(csv);
  assert.strictEqual(r[0].title, "Cookies, Cakes & Pies");
  assert.strictEqual(r[0].desc, "best, ever");
});
test("skips rows with no http url; empty/garbage -> []", () => {
  assert.deepStrictEqual(parseGoogleSaved("Title,URL\nNo Link,not-a-url\n"), []);
  ["", "no commas here", "\n\n", null, undefined].forEach(v => assert.deepStrictEqual(parseGoogleSaved(v), []));
});
test("works with no Note column (desc empty)", () => {
  const r = parseGoogleSaved("Title,URL\nThing,https://t.example.com\n");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].desc, "");
});
test("an exact URL column wins over an earlier substring match", () => {
  const csv = "Source Url,Title,URL\nbing,Thing,https://t.example.com\n";
  const r = parseGoogleSaved(csv);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "Thing");
  assert.strictEqual(r[0].url, "https://t.example.com");
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
