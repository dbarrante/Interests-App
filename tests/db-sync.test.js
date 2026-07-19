const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const db = require("../core/db");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-sync-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }

test("new card gets a fresh updatedAt", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  const t0 = Date.now();
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });
  const got = db.allCards(d).find(c => c.id === "c_1");
  assert.ok(got.updatedAt >= t0, "updatedAt set on insert");
  d.close();
});

test("re-upsert with identical content keeps updatedAt", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });
  const first = db.allCards(d)[0].updatedAt;
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });   // same content
  const second = db.allCards(d)[0].updatedAt;
  assert.strictEqual(first, second, "unchanged content must not bump updatedAt");
  d.close();
});

test("upsert with changed content bumps updatedAt", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCardSynced(d, { id: "c_1", url: "https://a.com", cat: "x" }, 1000);   // seed a known-old updatedAt (avoids same-ms flake vs Date.now())
  const first = db.allCards(d)[0].updatedAt;
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "DIFFERENT" });        // changed content -> stamps now
  const second = db.allCards(d)[0].updatedAt;
  assert.ok(second > first, "changed content must bump updatedAt");
  d.close();
});

test("upsertCardSynced sets updatedAt explicitly (merge path)", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCardSynced(d, { id: "c_1", url: "https://a.com" }, 1234567);
  assert.strictEqual(db.allCards(d)[0].updatedAt, 1234567);
  d.close();
});

test("addTombstone + allTombstones round-trip; delete writes a tombstone", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCard(d, { id: "c_1", url: "https://a.com" });
  db.deleteCard(d, "c_1");
  const tombs = db.allTombstones(d);
  assert.ok(tombs.some(t => t.id === "c_1" && t.kind === "card"), "delete leaves a tombstone");
  d.close();
});

test("addTombstone keeps the newest deletedAt (newest-wins)", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.addTombstone(d, "c_2", "card", 1000);
  db.addTombstone(d, "c_2", "card", 5000);   // newer wins
  assert.strictEqual(db.allTombstones(d).find(t => t.id === "c_2").deletedAt, 5000);
  d.close();
});

test("pruneTombstones 90-day retention: keeps recent, drops 100-day-old (32-bit overflow guard)", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  const now = Date.now();
  const recentDeletedAt = now;                         // just now — must survive
  const oldDeletedAt    = now - (100 * 24 * 60 * 60 * 1000);  // 100 days ago — must be pruned
  db.addTombstone(d, "t_recent", "card", recentDeletedAt);
  db.addTombstone(d, "t_old",    "card", oldDeletedAt);
  db.pruneTombstones(d, 90 * 24 * 60 * 60 * 1000);   // prune anything older than 90 days
  const remaining = db.allTombstones(d);
  assert.ok(remaining.some(t => t.id === "t_recent"), "recent tombstone must survive 90-day prune");
  assert.ok(!remaining.some(t => t.id === "t_old"),   "100-day-old tombstone must be pruned");
  d.close();
});

test("prune removes ancient tombstones and keeps recent ones", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  // Insert an ancient tombstone (deletedAt = 1 ms since epoch — always older than cutoff)
  db.addTombstone(d, "ancient", "card", 1);
  // Insert a recent tombstone using auto-stamp (no explicit deletedAt) → Date.now(), no truncation
  db.addTombstone(d, "recent", "saved");
  // Prune with olderThanMs = 1000 → cutoff = now-1000; "ancient" (deletedAt=1) < cutoff → deleted
  db.pruneTombstones(d, 1000);
  const remaining = db.allTombstones(d);
  assert.ok(!remaining.some(t => t.id === "ancient"), "ancient tombstone must be pruned");
  assert.ok(remaining.some(t => t.id === "recent"), "recent tombstone must survive prune");
  d.close();
});

test("delTombstone removes a specific (id,kind) entry", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.addTombstone(d, "x1", "card", 1000);
  db.addTombstone(d, "x1", "saved", 2000);
  db.delTombstone(d, "x1", "card");
  const tombs = db.allTombstones(d);
  assert.ok(!tombs.some(t => t.id === "x1" && t.kind === "card"), "card tombstone deleted");
  assert.ok(tombs.some(t => t.id === "x1" && t.kind === "saved"), "saved tombstone kept");
  d.close();
});

test("deleteSaved records a tombstone", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertSaved(d, { id: "s_1", url: "https://b.com" });
  db.deleteSaved(d, "s_1");
  const tombs = db.allTombstones(d);
  assert.ok(tombs.some(t => t.id === "s_1" && t.kind === "saved"), "deleteSaved leaves a tombstone");
  d.close();
});

// A2-fix: epoch-ms timestamp coercion tests
test("upsertCardSynced preserves epoch-ms updatedAt without 32-bit truncation", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  const bigTs = 1782653743712;
  db.upsertCardSynced(d, { id: "c_big", url: "x" }, bigTs);
  const got = db.allCards(d).find(c => c.id === "c_big");
  assert.strictEqual(got.updatedAt, bigTs, "updatedAt must equal " + bigTs + " (not truncated to " + (bigTs | 0) + ")");
  d.close();
});

test("addTombstone preserves epoch-ms deletedAt without 32-bit truncation", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  const bigTs = 1782653743712;
  db.addTombstone(d, "t_big", "card", bigTs);
  const tomb = db.allTombstones(d).find(t => t.id === "t_big");
  assert.ok(tomb, "tombstone must exist");
  assert.strictEqual(tomb.deletedAt, bigTs, "deletedAt must equal " + bigTs + " (not truncated to " + (bigTs | 0) + ")");
  d.close();
});

// A3: replaceCards/replaceSaved — content-diff stamping + tombstone diff
test("replaceCards bumps updatedAt only for changed rows", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  // Seed both rows with a known-old updatedAt so the bump vs Date.now() is deterministic (no same-ms flake).
  db.upsertCardSynced(d, { id: "c_1", url: "https://a.com", cat: "x" }, 1000);
  db.upsertCardSynced(d, { id: "c_2", url: "https://b.com" }, 1000);
  const u1 = db.allCards(d).find(c => c.id === "c_1").updatedAt;
  // Re-persist the full array with c_1 unchanged, c_2 edited:
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com", cat: "x" }, { id: "c_2", url: "https://b-EDITED.com" }]);
  const after = db.allCards(d);
  assert.strictEqual(after.find(c => c.id === "c_1").updatedAt, u1, "unchanged card keeps updatedAt");
  assert.ok(after.find(c => c.id === "c_2").updatedAt > u1, "edited card bumps updatedAt");
  d.close();
});

test("replaceCards writes a tombstone for a removed card and clears it on re-add", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }, { id: "c_2", url: "https://b.com" }]);
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }]);                       // c_2 removed
  assert.ok(db.allTombstones(d).some(t => t.id === "c_2"), "removed card tombstoned");
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }, { id: "c_2", url: "https://b.com" }]); // re-added
  assert.ok(!db.allTombstones(d).some(t => t.id === "c_2"), "re-added card clears tombstone");
  d.close();
});

test("replaceSaved bumps updatedAt only for changed rows", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  // Seed both rows with a known-old updatedAt so the bump vs Date.now() is deterministic (no same-ms flake).
  db.upsertSavedSynced(d, { id: "s_1", url: "https://a.com", category: "x" }, 1000);
  db.upsertSavedSynced(d, { id: "s_2", url: "https://b.com" }, 1000);
  const u1 = db.allSaved(d).find(s => s.id === "s_1").updatedAt;
  // Re-persist the full array with s_1 unchanged, s_2 edited:
  db.replaceSaved(d, [{ id: "s_1", url: "https://a.com", category: "x" }, { id: "s_2", url: "https://b-EDITED.com" }]);
  const after = db.allSaved(d);
  assert.strictEqual(after.find(s => s.id === "s_1").updatedAt, u1, "unchanged saved keeps updatedAt");
  assert.ok(after.find(s => s.id === "s_2").updatedAt > u1, "edited saved bumps updatedAt");
  d.close();
});

test("replaceSaved writes a tombstone for a removed item and clears it on re-add", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.replaceSaved(d, [{ id: "s_1", url: "https://a.com" }, { id: "s_2", url: "https://b.com" }]);
  db.replaceSaved(d, [{ id: "s_1", url: "https://a.com" }]);                       // s_2 removed
  assert.ok(db.allTombstones(d).some(t => t.id === "s_2" && t.kind === "saved"), "removed saved tombstoned");
  db.replaceSaved(d, [{ id: "s_1", url: "https://a.com" }, { id: "s_2", url: "https://b.com" }]); // re-added
  assert.ok(!db.allTombstones(d).some(t => t.id === "s_2" && t.kind === "saved"), "re-added saved clears tombstone");
  d.close();
});

// A4: serializeLibrary
test("serializeLibrary returns cards, saved, fp, tombstones", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCard(d, { id: "c_1", url: "https://a.com" });
  db.upsertSaved(d, { id: "s_1", url: "https://s.com" });
  db.upsertSaved(d, { id: "s_2", url: "https://s2.com" });
  db.setFp(d, "c_1", "fp123");
  db.deleteSaved(d, "s_1");
  const lib = db.serializeLibrary(d);
  assert.ok(Array.isArray(lib.cards) && lib.cards[0].updatedAt > 0);
  assert.ok(Array.isArray(lib.saved) && lib.saved.some(s => s.id === "s_2") && !lib.saved.some(s => s.id === "s_1"), "saved excludes the deleted s_1, includes s_2");
  assert.ok(lib.fp.c_1 === "fp123");
  assert.ok(lib.tombstones.some(t => t.id === "s_1" && t.kind === "saved"));
  d.close();
});

// --- asOf staleness-preserve reconcile (2026-07-18 data-safety HIGH) ---------
// A background merge adds a row the client hasn't seen; the client's next
// full-array PUT (asOf < the merge time) must PRESERVE it AND report it so the
// renderer can fold it back in — otherwise the *following* PUT (asOf advanced)
// deletes it. This models the exact worker-merge-interleaves-with-persist race.
test("replaceCards returns preserved rows kept via the asOf staleness branch", () => {
  const d = db.openDb(tmpStore());
  db.setKV(d, "_", "_");
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }]);   // client's known set
  const clientAsOf = Date.now();
  // background merge lands c_X AFTER the client loaded
  const later = clientAsOf + 5000;
  db.upsertCardSynced(d, { id: "c_X", url: "https://x.com" }, later);
  // client persists its stale array (only c_1) with asOf < later
  const r = db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }], { asOf: clientAsOf });
  assert.ok(r && Array.isArray(r.preserved), "returns {preserved:[]}");
  assert.deepStrictEqual(r.preserved.map(x => x.id), ["c_X"], "c_X preserved + reported");
  assert.ok(db.allCards(d).some(c => c.id === "c_X"), "c_X still in the store");
  d.close();
});

test("LAUNDER GUARD: after folding the preserved row back in, the next PUT does NOT delete it", () => {
  const d = db.openDb(tmpStore());
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }]);
  const clientAsOf = Date.now();
  db.upsertCardSynced(d, { id: "c_X", url: "https://x.com" }, clientAsOf + 5000);
  const r = db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }], { asOf: clientAsOf });
  // renderer folds r.preserved back into its array (what the reconcile hook does)
  const reconciled = [{ id: "c_1", url: "https://a.com" }].concat(r.preserved);
  // next PUT with an ADVANCED asOf (post-merge) — the exact step that used to delete c_X
  db.replaceCards(d, reconciled, { asOf: Date.now() });
  assert.ok(db.allCards(d).some(c => c.id === "c_X"), "c_X survives the advanced-asOf PUT (was the data-loss)");
  const lib = db.serializeLibrary(d);
  assert.ok(!lib.tombstones.some(t => t.id === "c_X"), "no tombstone for c_X");
  d.close();
});

test("COUNTER-SCENARIO: a genuine user delete of an edited row still tombstones (freeze would have broken this)", () => {
  const d = db.openDb(tmpStore());
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }, { id: "c_Y", url: "https://y.com" }]);
  const asOf1 = Date.now();
  // user EDITS c_Y (content change bumps its updatedAt to ~now, > asOf1)
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }, { id: "c_Y", url: "https://y-EDITED.com" }], { asOf: asOf1 });
  // user then DELETES c_Y — next full PUT omits it, asOf advanced to now
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }], { asOf: Date.now() });
  assert.ok(!db.allCards(d).some(c => c.id === "c_Y"), "the real delete of the edited row went through");
  const lib = db.serializeLibrary(d);
  assert.ok(lib.tombstones.some(t => t.id === "c_Y" && t.kind === "card"), "c_Y tombstoned");
  d.close();
});

test("replaceSaved mirrors: preserves + reports a concurrently-merged saved row", () => {
  const d = db.openDb(tmpStore());
  db.replaceSaved(d, [{ id: "s_1", url: "https://a.com" }]);
  const asOf = Date.now();
  db.upsertSavedSynced(d, { id: "s_X", url: "https://x.com" }, asOf + 5000);
  const r = db.replaceSaved(d, [{ id: "s_1", url: "https://a.com" }], { asOf });
  assert.deepStrictEqual(r.preserved.map(x => x.id), ["s_X"]);
  d.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
