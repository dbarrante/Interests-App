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

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
