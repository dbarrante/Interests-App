// tests/pwa-config-backup-stub.test.js — pwa/storage-pwa.js's Store gets
// no-op stubs for the desktop-only config-backup feature, matching the
// existing backupNow stub's pattern exactly.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("exportConfigBackup stub resolves {ok:false} with a desktop-only reason", () => {
  assert.match(src, /exportConfigBackup:\s*\(\)\s*=>\s*Promise\.resolve\(\{\s*ok:\s*false,\s*reason:/);
});
t("importConfigBackup stub resolves {ok:false} with a desktop-only reason", () => {
  assert.match(src, /importConfigBackup:\s*\(\)\s*=>\s*Promise\.resolve\(\{\s*ok:\s*false,\s*reason:/);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
