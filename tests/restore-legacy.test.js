const assert = require("assert");
const { planLegacyRestore } = require("../web/restore-legacy.js");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

// Helper: does the kv array contain an entry deep-equal to {key, value}?
function containsKv(kv, key, value) {
  return kv.some(function (e) {
    try { assert.deepStrictEqual(e, { key: key, value: value }); return true; } catch (x) { return false; }
  });
}

t("routes cards, saved, kv, and skips machine-local keys", () => {
  const plan = planLegacyRestore({
    ia_imported: JSON.stringify([{ id: "c1", title: "T" }]),
    ia_saved: [{ id: "s1" }],                       // already-parsed form
    ia_settings: JSON.stringify({ dark: true }),
    ia_fcat: "food",                                 // plain string value
    ia_capture_queue: "[]",                          // machine-local: skip
  });
  assert.deepStrictEqual(plan.cards, [{ id: "c1", title: "T" }]);
  assert.deepStrictEqual(plan.saved, [{ id: "s1" }]);
  assert.ok(containsKv(plan.kv, "ia_settings", { dark: true }), "kv should contain ia_settings parsed");
  assert.ok(containsKv(plan.kv, "ia_fcat", "food"), "kv should contain ia_fcat as string");
  assert.ok(plan.skipped.indexOf("ia_capture_queue") !== -1, "ia_capture_queue should be skipped");
  // cards/saved must NOT leak into kv
  assert.ok(!plan.kv.some(function (e) { return e.key === "ia_imported" || e.key === "ia_saved"; }), "cards/saved not in kv");
});

t("tolerates malformed JSON by passing the raw string through", () => {
  const plan = planLegacyRestore({ ia_settings: "{oops" });
  assert.ok(containsKv(plan.kv, "ia_settings", "{oops"), "malformed JSON kept as raw string");
});

t("empty / non-object input → empty plan, no cards/saved", () => {
  const a = planLegacyRestore(null);
  assert.strictEqual(a.cards, null);
  assert.strictEqual(a.saved, null);
  assert.deepStrictEqual(a.kv, []);
  assert.deepStrictEqual(a.skipped, []);
  const b = planLegacyRestore({});
  assert.strictEqual(b.cards, null);
  assert.deepStrictEqual(b.kv, []);
});

t("skips all machine-local keys", () => {
  const plan = planLegacyRestore({
    ia_capture_queue: "[]",
    ia_batch_state: "{}",
    ia_batch_progress: "0",
    ia_capture_request: "null",
    ia_settings: "{}",
  });
  ["ia_capture_queue", "ia_batch_state", "ia_batch_progress", "ia_capture_request"].forEach(function (k) {
    assert.ok(plan.skipped.indexOf(k) !== -1, k + " should be skipped");
    assert.ok(!plan.kv.some(function (e) { return e.key === k; }), k + " should not be in kv");
  });
  assert.ok(containsKv(plan.kv, "ia_settings", {}), "ia_settings still routed to kv");
});

t("cards already-parsed array is passed through unchanged", () => {
  const plan = planLegacyRestore({ ia_imported: [{ id: "x" }] });
  assert.deepStrictEqual(plan.cards, [{ id: "x" }]);
});

t("kv keys keep their full ia_ prefix (round-trips with load())", () => {
  const plan = planLegacyRestore({ ia_ph_fps: JSON.stringify(["a", "b"]) });
  assert.ok(containsKv(plan.kv, "ia_ph_fps", ["a", "b"]), "prefix preserved");
});

t("routes ia_theme to plan.theme (localStorage-only key), NOT plan.kv", () => {
  const plan = planLegacyRestore({ ia_theme: "dark" });
  assert.strictEqual(plan.theme, "dark", "theme routed to plan.theme");
  assert.ok(!plan.kv.some(function (e) { return e.key === "ia_theme"; }), "ia_theme must not leak into kv");
});

t("ia_theme defaults to null when absent; other keys unaffected", () => {
  const plan = planLegacyRestore({ ia_settings: JSON.stringify({ dark: true }) });
  assert.strictEqual(plan.theme, null, "theme is null when ia_theme absent");
  assert.ok(containsKv(plan.kv, "ia_settings", { dark: true }), "ia_settings still routed to kv");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
