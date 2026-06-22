const assert = require("assert");
const { loadFns } = require("./_extract");
const { pickBackupsToDelete, backupCountsMatch } = loadFns(["pickBackupsToDelete", "backupCountsMatch"]);

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("keeps newest 3, deletes the rest (by date)", () => {
  const names = [
    "interests-backup-2026-06-18.json",
    "interests-backup-2026-06-21.json",
    "interests-backup-2026-06-19.json",
    "interests-backup-2026-06-20.json",
    "interests-backup-2026-06-17.json",
  ];
  const del = pickBackupsToDelete(names, 3).sort();
  assert.deepStrictEqual(del, ["interests-backup-2026-06-17.json", "interests-backup-2026-06-18.json"]);
});
t("fewer than keep → delete nothing", () => {
  assert.deepStrictEqual(pickBackupsToDelete(["interests-backup-2026-06-21.json"], 3), []);
});
t("ignores non-matching filenames", () => {
  const names = ["saves.json", "interests-snapshot-latest.json", "interests-backup-before-restore-123.json", "interests-backup-2026-06-21.json"];
  assert.deepStrictEqual(pickBackupsToDelete(names, 3), []);
});
t("matches backup FOLDERS (no .json) and mixes with legacy files", () => {
  const names = [
    "interests-backup-2026-06-22",        // new folder
    "interests-backup-2026-06-21",        // new folder
    "interests-backup-2026-06-20.json",   // legacy file
    "interests-backup-2026-06-19",        // new folder
    "interests-snapshot-latest.json",     // not a dated backup
    "interests-backup-before-restore-2026-06-22", // pre-restore safety, not rotated
  ];
  const del = pickBackupsToDelete(names, 2).sort();
  assert.deepStrictEqual(del, ["interests-backup-2026-06-19", "interests-backup-2026-06-20.json"]);
});
t("empty / undefined input → []", () => {
  assert.deepStrictEqual(pickBackupsToDelete([], 3), []);
  assert.deepStrictEqual(pickBackupsToDelete(undefined, 3), []);
});

t("counts equal → true", () => {
  assert.strictEqual(backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4301 }), true);
});
t("any count differs → false", () => {
  assert.strictEqual(backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4300 }), false);
});
t("missing operand → false", () => {
  assert.strictEqual(backupCountsMatch(null, { imported: 1, saved: 1, images: 1 }), false);
  assert.strictEqual(backupCountsMatch({ imported: 1, saved: 1, images: 1 }, undefined), false);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
