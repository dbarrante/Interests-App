// tests/backup.test.js — pure helpers + incremental selection + verify-before-rotate
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const backup = require("../core/backup.js");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); }
}

/* ---- pickBackupsToDelete (PURE) ---- */
t("keeps newest 3, deletes the rest (by date)", () => {
  const names = [
    "interests-backup-2026-06-18.json",
    "interests-backup-2026-06-21.json",
    "interests-backup-2026-06-19.json",
    "interests-backup-2026-06-20.json",
    "interests-backup-2026-06-17.json",
  ];
  const del = backup.pickBackupsToDelete(names, 3).sort();
  assert.deepStrictEqual(del, ["interests-backup-2026-06-17.json", "interests-backup-2026-06-18.json"]);
});
t("fewer than keep → delete nothing", () => {
  assert.deepStrictEqual(backup.pickBackupsToDelete(["interests-backup-2026-06-21.json"], 3), []);
});
t("ignores non-matching filenames", () => {
  const names = ["saves.json", "interests-snapshot-latest.json", "interests-backup-before-restore-123.json", "interests-backup-2026-06-21.json"];
  assert.deepStrictEqual(backup.pickBackupsToDelete(names, 3), []);
});
t("matches backup FOLDERS (no .json) and mixes with legacy files", () => {
  const names = [
    "interests-backup-2026-06-22",
    "interests-backup-2026-06-21",
    "interests-backup-2026-06-20.json",
    "interests-backup-2026-06-19",
    "interests-snapshot-latest.json",
    "interests-backup-before-restore-2026-06-22",
  ];
  const del = backup.pickBackupsToDelete(names, 2).sort();
  assert.deepStrictEqual(del, ["interests-backup-2026-06-19", "interests-backup-2026-06-20.json"]);
});
t("empty / undefined input → []", () => {
  assert.deepStrictEqual(backup.pickBackupsToDelete([], 3), []);
  assert.deepStrictEqual(backup.pickBackupsToDelete(undefined, 3), []);
});

/* ---- backupCountsMatch (PURE) ---- */
t("counts equal → true", () => {
  assert.strictEqual(backup.backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4301 }), true);
});
t("any count differs → false", () => {
  assert.strictEqual(backup.backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4300 }), false);
});
t("missing operand → false", () => {
  assert.strictEqual(backup.backupCountsMatch(null, { imported: 1, saved: 1, images: 1 }), false);
  assert.strictEqual(backup.backupCountsMatch({ imported: 1, saved: 1, images: 1 }, undefined), false);
});

/* ---- changedImageIds (incremental selection) ---- */
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJpg(dir, id, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".jpg"), Buffer.alloc(bytes, 1));
}

t("changedImageIds: dest missing → all source ids", () => {
  const store = mkTmp("ia-store-");
  const imgs = path.join(store, "images");
  writeJpg(imgs, "a", 10); writeJpg(imgs, "b", 20);
  const dest = path.join(mkTmp("ia-dest-"), "images"); // does not exist yet
  const got = backup.changedImageIds(store, dest).sort();
  assert.deepStrictEqual(got, ["a", "b"]);
});
t("changedImageIds: only new + size-changed ids selected", () => {
  const store = mkTmp("ia-store-");
  const imgs = path.join(store, "images");
  writeJpg(imgs, "a", 10);   // unchanged in dest
  writeJpg(imgs, "b", 20);   // size-changed in dest
  writeJpg(imgs, "c", 30);   // new (absent in dest)
  const destRoot = mkTmp("ia-dest-");
  const dest = path.join(destRoot, "images");
  writeJpg(dest, "a", 10);   // identical size → skip
  writeJpg(dest, "b", 5);    // different size → copy
  const got = backup.changedImageIds(store, dest).sort();
  assert.deepStrictEqual(got, ["b", "c"]);
});
t("changedImageIds: nothing changed → []", () => {
  const store = mkTmp("ia-store-");
  const imgs = path.join(store, "images");
  writeJpg(imgs, "a", 10);
  const destRoot = mkTmp("ia-dest-");
  const dest = path.join(destRoot, "images");
  writeJpg(dest, "a", 10);
  assert.deepStrictEqual(backup.changedImageIds(store, dest), []);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
