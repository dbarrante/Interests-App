const assert = require("assert");
const { loadFns } = require("./_extract");
const { pickBackupsToDelete } = loadFns(["pickBackupsToDelete"]);

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

// backupCountsMatch's web-side (index.html) copy was a dead orphan (zero callers —
// the live copy is core/backup.js, exercised by tests/backup.test.js) and was
// removed in the v1.9.0 Task 7 deferred-minors sweep. Its cases lived here too;
// they're covered by tests/backup.test.js now, so they're not duplicated here.

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
