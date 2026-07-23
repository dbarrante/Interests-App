// tests/settings-wiring.test.js — Settings backup/restore/move handlers use Store.*
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

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

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": backupRetainCount default is 3", () => {
    assert.match(src, /backupRetainCount:3,/, "DEFAULTS.backupRetainCount missing");
  });
  t(label + ": Backups-to-retain number input exists with a sane range", () => {
    assert.match(src, /<input type="number" id="backupRetainCount" min="1" max="30"/, "input element missing or range changed");
  });
  t(label + ": backupRetainCount input clamps 1-30 and persists", () => {
    assert.match(src, /S\.backupRetainCount=Math\.max\(1,Math\.min\(30,\+e\.target\.value\|\|3\)\); save\("settings",S\);/,
      "oninput handler missing or no longer clamps/saves");
  });
  t(label + ": manual/auto/safety-gate backups all pass the configured retain count", () => {
    const sites = [
      /doBackup\(manual\)\{\s*try\{\s*const res = await Store\.backupNow\(\{keep: S\.backupRetainCount\|\|3\}\)/,
      /verifiedSafetyBackup\(action\)\{\s*try\{\s*const res = await Store\.backupNow\(\{keep: S\.backupRetainCount\|\|3\}\)/,
      /snapshotBeforeDestructive\(\)\{\s*try\{ Store\.backupNow\(\{keep: S\.backupRetainCount\|\|3\}\)/,
    ];
    for (const re of sites) assert.match(src, re, "a Store.backupNow() call site isn't passing {keep: S.backupRetainCount}");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
