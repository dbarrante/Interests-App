const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const dbm = require("../core/db");
const sync = require("../core/sync");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-ro-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function snapshotTree(dir){ const out = {}; (function walk(d, rel){ for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); const r = rel + "/" + n; if (st.isDirectory()) walk(p, r); else out[r] = st.mtimeMs + ":" + st.size; } })(dir, ""); return out; }

test("runSync never writes inside a peer's folder (read-only on peers)", () => {
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-dbx-"));
  // Peer B publishes a snapshot we will read.
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_B", url: "https://b.com" });
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  const before = snapshotTree(path.join(syncDir, "dev_B"));
  // Device A runs a sync.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  sync.runSync({ db: dA, storeDir: storeA }, { syncDir: syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  const after = snapshotTree(path.join(syncDir, "dev_B"));
  assert.deepStrictEqual(after, before, "peer folder must be untouched");
  dA.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
