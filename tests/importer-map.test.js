const assert = require("assert");
const { mapLegacyKeys } = require("../core/importer");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("maps ia_imported -> cards (parsed array)", () => {
  const out = mapLegacyKeys({ keys: { ia_imported: JSON.stringify([{ id: "a", url: "u" }, { id: "b" }]) } });
  assert.deepStrictEqual(out.cards, [{ id: "a", url: "u" }, { id: "b" }]);
});

t("maps ia_saved -> saved (parsed array)", () => {
  const out = mapLegacyKeys({ keys: { ia_saved: JSON.stringify([{ id: "s1", url: "su" }]) } });
  assert.deepStrictEqual(out.saved, [{ id: "s1", url: "su" }]);
});

t("ia_settings goes into kv as the raw string", () => {
  const settingsStr = JSON.stringify({ dark: true });
  const out = mapLegacyKeys({ keys: { ia_settings: settingsStr } });
  assert.strictEqual(out.kv.ia_settings, settingsStr);
});

t("remaining ia_* keys go into kv as raw strings; not into cards/saved", () => {
  const out = mapLegacyKeys({ keys: {
    ia_imported: "[]",
    ia_saved: "[]",
    ia_settings: "{\"x\":1}",
    ia_feed: "[1,2,3]",
    ia_likes: "[\"a\"]",
    ia_hidden: "[]"
  } });
  assert.strictEqual(out.kv.ia_feed, "[1,2,3]");
  assert.strictEqual(out.kv.ia_likes, "[\"a\"]");
  assert.strictEqual(out.kv.ia_hidden, "[]");
  assert.strictEqual(out.kv.ia_settings, "{\"x\":1}");
  assert.strictEqual("ia_imported" in out.kv, false);
  assert.strictEqual("ia_saved" in out.kv, false);
});

t("missing keys default to [] / {} and never throw", () => {
  const out = mapLegacyKeys({});
  assert.deepStrictEqual(out.cards, []);
  assert.deepStrictEqual(out.saved, []);
  assert.deepStrictEqual(out.kv, {});
});

t("malformed ia_imported/ia_saved JSON -> [] (no throw)", () => {
  const out = mapLegacyKeys({ keys: { ia_imported: "{not json", ia_saved: "also broken" } });
  assert.deepStrictEqual(out.cards, []);
  assert.deepStrictEqual(out.saved, []);
});

t("ignores non-ia_ keys entirely", () => {
  const out = mapLegacyKeys({ keys: { ia_imported: "[]", junk: "x", other_thing: "y" } });
  assert.strictEqual("junk" in out.kv, false);
  assert.strictEqual("other_thing" in out.kv, false);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
