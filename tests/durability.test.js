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
t("empty / undefined input → []", () => {
  assert.deepStrictEqual(pickBackupsToDelete([], 3), []);
  assert.deepStrictEqual(pickBackupsToDelete(undefined, 3), []);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
