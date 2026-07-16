// tests/merge-settings.test.js — mergeSyncedSettings(): the apply-side merge for
// synced settings. `incoming` won LWW at the blob level, but credentials union
// per-field so a device that never held a key can't wipe it fleet-wide, and the
// desktop-local GitHub updateToken never travels or gets overwritten.
// Runs against BOTH core/merge.js and pwa/merge.js — the pwa file is a verbatim
// copy and must stay in lockstep (also asserted here byte-for-byte).
const assert = require("assert");
const fs = require("fs"), path = require("path");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

const impls = [["core", require("../core/merge.js")], ["pwa", require("../pwa/merge.js")]];

for (const [label, m] of impls) {
  const mergeSyncedSettings = m.mergeSyncedSettings;

  run(label + ": exports mergeSyncedSettings", () => {
    assert.strictEqual(typeof mergeSyncedSettings, "function");
  });

  run(label + ": incoming wins non-credential fields (it won LWW)", () => {
    const out = mergeSyncedSettings({ about: "old", interests: "x" }, { about: "new", weights: { personal: 8 } });
    assert.strictEqual(out.about, "new");
    assert.deepStrictEqual(out.weights, { personal: 8 });
    assert.ok(!("interests" in out), "blob-level LWW: fields absent from incoming are absent from result");
  });

  run(label + ": keys union — incoming provider wins, local-only provider survives", () => {
    const out = mergeSyncedSettings(
      { keys: { openrouter: "LOCAL_OR", groq: "LOCAL_GROQ" } },
      { keys: { openrouter: "INCOMING_OR" } }
    );
    assert.strictEqual(out.keys.openrouter, "INCOMING_OR");
    assert.strictEqual(out.keys.groq, "LOCAL_GROQ");
  });

  run(label + ": empty/whitespace/non-string incoming key values never clobber local", () => {
    const out = mergeSyncedSettings(
      { keys: { openrouter: "LOCAL_OR", groq: "LOCAL_GROQ", gemini: "LOCAL_GEM" } },
      { keys: { openrouter: "", groq: "   ", gemini: 42 } }
    );
    assert.strictEqual(out.keys.openrouter, "LOCAL_OR");
    assert.strictEqual(out.keys.groq, "LOCAL_GROQ");
    assert.strictEqual(out.keys.gemini, "LOCAL_GEM");
  });

  run(label + ": a fresh device's missing/empty keys object can't wipe the fleet", () => {
    const out = mergeSyncedSettings({ keys: { openrouter: "LOCAL_OR" } }, { about: "fresh device edit" });
    assert.strictEqual(out.keys.openrouter, "LOCAL_OR");
  });

  run(label + ": oprKey — incoming non-empty wins, empty/missing keeps local", () => {
    assert.strictEqual(mergeSyncedSettings({ oprKey: "L" }, { oprKey: "I" }).oprKey, "I");
    assert.strictEqual(mergeSyncedSettings({ oprKey: "L" }, { oprKey: "" }).oprKey, "L");
    assert.strictEqual(mergeSyncedSettings({ oprKey: "L" }, {}).oprKey, "L");
    assert.ok(!("oprKey" in mergeSyncedSettings({}, {})), "absent on both sides stays absent");
  });

  run(label + ": updateToken NEVER travels and is never overwritten", () => {
    const out = mergeSyncedSettings({ updateToken: "LOCAL_GH" }, { updateToken: "ATTACKER_OR_STALE" });
    assert.strictEqual(out.updateToken, "LOCAL_GH");
    assert.ok(!("updateToken" in mergeSyncedSettings({}, { updateToken: "X" })), "no local token -> none in result");
  });

  run(label + ": settingsEnrichedByLocal — true only when local contributed sync-visible content", () => {
    const enriched = m.settingsEnrichedByLocal;
    assert.strictEqual(typeof enriched, "function");
    // local-only key survives the union -> the blob is richer than incoming -> must re-stamp
    assert.strictEqual(enriched(
      mergeSyncedSettings({ keys: { groq: "LOCAL_ONLY" } }, { about: "x", keys: { openrouter: "OR" } }),
      { about: "x", keys: { openrouter: "OR" } }
    ), true, "local-only key must trigger a fresh stamp (else it never propagates outward)");
    // incoming is a superset -> nothing local contributed -> adopt incoming stamp
    assert.strictEqual(enriched(
      mergeSyncedSettings({ keys: { openrouter: "OR" } }, { about: "x", keys: { openrouter: "OR", groq: "G" } }),
      { about: "x", keys: { openrouter: "OR", groq: "G" } }
    ), false, "incoming superset must NOT re-stamp (would ping-pong stamps forever)");
    // updateToken alone must never trigger a re-stamp — it never syncs
    assert.strictEqual(enriched(
      mergeSyncedSettings({ updateToken: "GH" }, { about: "x" }),
      { about: "x" }
    ), false, "updateToken is sync-invisible and must not oscillate stamps");
    // preserved local oprKey against an incoming blob lacking it -> enriched
    assert.strictEqual(enriched(
      mergeSyncedSettings({ oprKey: "OPR" }, { about: "x" }),
      { about: "x" }
    ), true, "preserved oprKey must propagate outward");
    // identical content -> not enriched
    assert.strictEqual(enriched(
      mergeSyncedSettings({}, { about: "x", keys: { a: "1" } }),
      { about: "x", keys: { a: "1" } }
    ), false);
  });

  run(label + ": garbage inputs don't throw", () => {
    assert.doesNotThrow(() => mergeSyncedSettings(null, null));
    assert.doesNotThrow(() => mergeSyncedSettings(undefined, { keys: null }));
    assert.doesNotThrow(() => mergeSyncedSettings({ keys: "not-an-object" }, { keys: ["arr"] }));
    const out = mergeSyncedSettings(null, { about: "x" });
    assert.strictEqual(out.about, "x");
  });
}

run("pwa/merge.js is still a verbatim copy of core/merge.js (below its header)", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "core", "merge.js"), "utf8").replace(/\r\n/g, "\n");
  const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "merge.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(pwa.indexOf(core) >= 0, "pwa/merge.js must contain core/merge.js verbatim — re-copy it");
});

console.log("merge-settings: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
