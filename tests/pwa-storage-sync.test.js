// tests/pwa-storage-sync.test.js — Store.syncNow() used to reject if
// Dbx.getAccessToken threw, and never recorded a "last sync result" anywhere
// the Settings panel could show without the user tapping Sync again. This
// locks in: syncNow always resolves (never rejects), and every outcome
// (not connected / getAccessToken failure / runSyncCycle ok:false / success)
// is persisted to idb's kv store.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

const syncNowIdx = src.indexOf("syncNow(onProgress) {");
const syncNowEnd = src.indexOf("\n    },", syncNowIdx);
const syncNowBody = src.slice(syncNowIdx, syncNowEnd);

t("syncNow persists every outcome via a shared persist() helper", () => {
  assert.ok(/idb\.kvSet\("_pwa_last_sync_result"/.test(syncNowBody), "must write to the _pwa_last_sync_result kv key");
});

t("syncNow's not-connected path is tagged AUTH_EXPIRED for consistent UI branching", () => {
  assert.ok(/code:\s*"AUTH_EXPIRED"/.test(syncNowBody), "the not-connected early return must carry code: AUTH_EXPIRED");
});

t("syncNow catches a thrown getAccessToken/runSyncCycle failure instead of rejecting", () => {
  assert.ok(/\.catch\(/.test(syncNowBody), "must have a .catch() on the getAccessToken->runSyncCycle chain");
});

t("Store exposes lastSyncResult() reading the same kv key", () => {
  assert.ok(/lastSyncResult\(\)\s*\{\s*return idb\.kvGet\("_pwa_last_sync_result"\);\s*\}/.test(src),
    "lastSyncResult() must read _pwa_last_sync_result via idb.kvGet");
});

t("persist() swallows its own idb.kvSet failure instead of propagating it (regression: syncNow must never reject even if the kv write itself fails)", () => {
  assert.ok(/\.then\(\(\) => result, \(e\) => \{/.test(syncNowBody),
    "persist's .then must have a rejection handler (second argument) that still resolves with result, not just a bare .then(() => result)");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
