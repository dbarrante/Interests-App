// tests/settings-wiring.test.js — Settings backup/restore/move handlers use Store.*
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("backupNow calls Store.backupNow()", () => {
  assert.ok(/Store\.backupNow\s*\(/.test(html), "Store.backupNow() not referenced");
});
t("renderBackupList calls Store.listBackups()", () => {
  assert.ok(/Store\.listBackups\s*\(/.test(html), "Store.listBackups() not referenced");
});
t("restore handler calls Store.restore(", () => {
  assert.ok(/Store\.restore\s*\(/.test(html), "Store.restore() not referenced");
});
t("Move data location calls Store.moveStore(", () => {
  assert.ok(/Store\.moveStore\s*\(/.test(html), "Store.moveStore() not referenced");
});
t("File System Access showDirectoryPicker removed from index.html", () => {
  assert.ok(!/showDirectoryPicker/.test(html), "showDirectoryPicker still present");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
