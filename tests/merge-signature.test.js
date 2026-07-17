// tests/merge-signature.test.js — contentSignature(): the publish-skip's equality
// oracle. Signature-equality must imply "republishing would produce identical
// content", so every aggregate field must be independently visible in the string.
// Runs against BOTH core/merge.js and pwa/merge.js (verbatim-copy lock lives in
// tests/merge-settings.test.js; here we just require both exports exist).
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

const BASE = { cards: 10, saved: 3, tombstones: 2, maxCardUpdatedAt: 111, maxSavedUpdatedAt: 222, maxTombDeletedAt: 333, settingsUpdatedAt: 444 };

for (const [label, m] of [["core", require("../core/merge.js")], ["pwa", require("../pwa/merge.js")]]) {
  const sig = m.contentSignature;
  run(label + ": exports contentSignature; deterministic", () => {
    assert.strictEqual(typeof sig, "function");
    assert.strictEqual(sig(BASE), sig(Object.assign({}, BASE)));
    assert.ok(/^v1\|/.test(sig(BASE)), "versioned prefix so future field changes can never alias old signatures");
  });
  run(label + ": every aggregate field independently changes the signature", () => {
    for (const k of Object.keys(BASE)) {
      const changed = Object.assign({}, BASE); changed[k] = BASE[k] + 1;
      assert.notStrictEqual(sig(changed), sig(BASE), "field " + k + " must be visible in the signature");
    }
  });
  run(label + ": garbage coerces to 0, never throws", () => {
    assert.doesNotThrow(() => sig(null));
    assert.doesNotThrow(() => sig({ cards: "x", maxCardUpdatedAt: NaN }));
    assert.strictEqual(sig(null), sig({}));
    assert.strictEqual(sig({ cards: NaN }), sig({ cards: 0 }));
  });
}

// db.signatureAggregates against a real store (pattern of tests/sync-settings.test.js)
const db = require("../core/db.js");
function newDb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sig-")); fs.mkdirSync(path.join(dir, "images"), { recursive: true }); return db.openDb(dir); }
run("signatureAggregates: empty store → all zeros; each mutation moves its aggregate", () => {
  const d = newDb();
  const a0 = db.signatureAggregates(d);
  assert.deepStrictEqual(a0, { cards: 0, saved: 0, tombstones: 0, maxCardUpdatedAt: 0, maxSavedUpdatedAt: 0, maxTombDeletedAt: 0, settingsUpdatedAt: 0 });
  db.upsertCard(d, { id: "c1", url: "u", ts: 1 });
  const a1 = db.signatureAggregates(d);
  assert.strictEqual(a1.cards, 1);
  assert.ok(a1.maxCardUpdatedAt > 0, "card upsert stamps updatedAt");
  db.addTombstone(d, "c9", "card", 777);
  const a2 = db.signatureAggregates(d);
  assert.strictEqual(a2.tombstones, 1);
  assert.strictEqual(a2.maxTombDeletedAt, 777);
  db.setKV(d, "ia_settings_updatedAt", "999");
  assert.strictEqual(db.signatureAggregates(d).settingsUpdatedAt, 999);
});

console.log("merge-signature: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
