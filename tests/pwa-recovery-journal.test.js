const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const idb = fs.readFileSync(path.join(root, "pwa/idb.js"), "utf8");
const sync = fs.readFileSync(path.join(root, "pwa/sync-pwa.js"), "utf8");
const store = fs.readFileSync(path.join(root, "pwa/storage-pwa.js"), "utf8");
const web = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const pwa = fs.readFileSync(path.join(root, "pwa/index.html"), "utf8");

assert.match(idb, /const DB_VERSION = 3/);
assert.match(idb, /"recovery"/);
assert.match(idb, /replaceStores\(snapshot\)/);
assert.match(sync, /async function writeRecoveryJournal\(\)/);
assert.match(sync, /await idb\.put\("recovery", journal\)/);
assert.match(sync, /RECOVERY_JOURNAL_FAILED/);
assert.match(sync, /async function recoverLastMerge\(\)/);
assert.match(store, /recoveryStatus: \(\) => window\.IASync\.recoveryStatus\(\)/);
assert.match(store, /recoverLastMerge: \(\) => window\.IASync\.recoverLastMerge\(\)/);
assert.match(web, /function renderPwaRecoveryStatus\(\)/);
assert.match(pwa, /function renderPwaRecoveryStatus\(\)/);
assert.match(fs.readFileSync(path.join(root, "pwa/sw.js"), "utf8"), /DB_VERSION = 3/);
console.log("pwa-recovery-journal: passed");
