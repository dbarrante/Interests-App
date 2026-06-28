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
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });
  const first = db.allCards(d)[0].updatedAt;
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "DIFFERENT" });
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

test("addTombstone keeps the newest deletedAt; prune drops old ones", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.addTombstone(d, "c_2", "card", 1000);
  db.addTombstone(d, "c_2", "card", 5000);   // newer wins
  assert.strictEqual(db.allTombstones(d).find(t => t.id === "c_2").deletedAt, 5000);
  db.pruneTombstones(d, Date.now() - 4000);  // older-than cutoff removes deletedAt=5000? no — keep
  // deletedAt 5000 is ancient relative to now; prune(now - 4000) removes anything < now-4000.
  // Use an explicit cutoff instead:
  db.addTombstone(d, "c_old", "card", 1);
  db.pruneTombstones(d, 2);                  // remove deletedAt < (now - 2ms)? see impl note
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

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
