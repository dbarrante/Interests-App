// tests/backup.test.js — pure helpers + incremental selection + verify-before-rotate
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

// ISOLATE the config in a temp APPDATA *before* requiring core/backup (which
// loads core/config) — withBackupDir() mutates config.backupDir, and a killed
// run used to leave the REAL production backups pointed at a temp dir (root
// cause of "backups silently stopped 2026-07-14"). Same pattern as
// backup-dropbox-path.
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

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
t("changedImageIds: same-size content changes are selected", () => {
  const store = mkTmp("ia-store-");
  const imgs = path.join(store, "images");
  writeJpg(imgs, "a", 10);
  const destRoot = mkTmp("ia-dest-");
  const dest = path.join(destRoot, "images");
  writeJpg(dest, "a", 10);
  fs.writeFileSync(path.join(dest, "a.jpg"), Buffer.alloc(10, 9));
  assert.deepStrictEqual(backup.changedImageIds(store, dest), ["a"]);
});

/* ---- runBackup / listBackups / verifyBackup (integration over tmp dirs) ---- */
const { openDb, upsertCard, upsertSaved, deleteCard, counts, setKV, getKV } = require("../core/db.js");
const captureQueue = require("../core/capture-queue.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bk-store-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function withBackupDir(fn) {
  // point dropboxBackupDir() at a fresh tmp dir via a config override, restore after
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bk-dest-"));
  const orig = config.loadConfig();
  config.saveConfig(Object.assign({}, orig, { backupDir: bdir }));
  // lastcounts.json is a PROCESS-GLOBAL witness (%APPDATA%), so without this an
  // earlier test's 200-card store becomes the collapse baseline for the next
  // test's 3-card one and every subsequent backup is refused. Each withBackupDir
  // block is a distinct store, so it must start from a clean witness too.
  const lcPath = path.join(process.env.APPDATA, "Interests App", "lastcounts.json");
  const abPath = path.join(process.env.APPDATA, "Interests App", "accepted-baseline.json");
  try { fs.rmSync(lcPath, { force: true }); } catch (e) {}
  try { fs.rmSync(abPath, { force: true }); } catch (e) {}
  try { return fn(bdir); }
  finally {
    config.saveConfig(orig || {});
    try { fs.rmSync(lcPath, { force: true }); } catch (e) {}
    try { fs.rmSync(abPath, { force: true }); } catch (e) {}
  }
}

/* ---- incremental mirror ----
   The rolling mirror exists because sync called runBackup() before EVERY merge
   (runSync fires every 3 min), and runBackup writes every image to a staging
   path then renames -- ~12,000 Dropbox file operations per merge on a 6,000
   image library. The mirror updates in place so an unchanged library costs zero
   image writes. */
t("updateMirror writes everything on a cold run, then NOTHING when unchanged", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 5; i++) {
      upsertCard(db, { id: "m" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:m" + i });
      images.putImg(store, "m" + i, TINY_JPG);
    }
    const cold = backup.updateMirror(db, store);
    assert.strictEqual(cold.written, 5, "cold run must write every image");
    assert.strictEqual(backup.verifyBackup(backup.MIRROR_NAME, cold.counts), true, "mirror must verify");

    const noop = backup.updateMirror(db, store);
    assert.strictEqual(noop.written, 0, "an unchanged library must rewrite ZERO images -- the entire point of the mirror");
    assert.strictEqual(noop.removed, 0);
    assert.strictEqual(backup.verifyBackup(backup.MIRROR_NAME, noop.counts), true, "mirror must still verify after a no-op");
    db.close();
  });
});
t("updateMirror rewrites only changed images and drops ones the store no longer has", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 4; i++) {
      upsertCard(db, { id: "d" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:d" + i });
      images.putImg(store, "d" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Change d1's bytes on disk (the mirror compares content hashes, so any
    // differing content counts) and drop d2 from the store entirely.
    fs.writeFileSync(path.join(store, "images", "d1.jpg"), Buffer.from("different image bytes entirely"));
    fs.unlinkSync(path.join(store, "images", "d2.jpg"));
    const r = backup.updateMirror(db, store);
    assert.strictEqual(r.written, 1, "only the changed image is rewritten");
    assert.strictEqual(r.removed, 1, "the image dropped from the live store is removed from the mirror");
    assert.strictEqual(backup.verifyBackup(backup.MIRROR_NAME, r.counts), true);
    db.close();
  });
});
t("a torn mirror (no meta.json) fails verification, and re-running heals it", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "t1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:t1" });
    images.putImg(store, "t1", TINY_JPG);
    const r = backup.updateMirror(db, store);
    // Simulate a crash mid-update: meta.json is the completion marker and is
    // written LAST, so its absence must make the folder untrustworthy.
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "meta.json"), { force: true });
    assert.strictEqual(backup.verifyBackup(backup.MIRROR_NAME, r.counts), false, "a mirror with no completion marker must NOT verify");
    const again = backup.updateMirror(db, store);
    assert.strictEqual(backup.verifyBackup(backup.MIRROR_NAME, again.counts), true, "re-running must heal it");
    db.close();
  });
});
t("the mirror is offered for restore (listBackups) and passes the name allowlist", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "l1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:l1" });
    images.putImg(store, "l1", TINY_JPG);
    backup.updateMirror(db, store);
    const listed = backup.listBackups().find(function (b) { return b.name === backup.MIRROR_NAME; });
    assert.ok(listed, "the freshest recovery point must be visible for restore");
    assert.strictEqual(listed.mirror, true);
    db.close();
  });
});
t("ensureBackupBeforeMerge always refreshes the mirror but only makes a dated snapshot when the newest aged out", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "e1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:e1" });
    images.putImg(store, "e1", TINY_JPG);
    const WEEK = 7 * 24 * 3600 * 1000;

    const first = backup.ensureBackupBeforeMerge(db, store, { fullSnapshotIntervalMs: WEEK });
    assert.ok(first.full, "no dated snapshot exists yet -> one must be created");
    assert.ok(first.mirror, "mirror is always refreshed");

    const second = backup.ensureBackupBeforeMerge(db, store, { fullSnapshotIntervalMs: WEEK });
    assert.strictEqual(second.full, null, "a fresh dated snapshot exists -> must NOT write another full copy");
    assert.ok(second.mirror, "but the mirror is still refreshed, so the merge stays protected");

    const aged = backup.ensureBackupBeforeMerge(db, store, { fullSnapshotIntervalMs: 1 });
    assert.ok(aged.full, "once the newest dated snapshot ages out, a new full one is written");
    db.close();
  });
});
t("sync uses ensureBackupBeforeMerge, not a full runBackup, as its pre-merge gate", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "core", "sync.js"), "utf8");
  assert.ok(src.includes("backup.ensureBackupBeforeMerge(ctx.db, ctx.storeDir)"),
    "sync must use the incremental gate");
  assert.ok(!/backupFn = opts\.backupFn \|\| function \(\) \{ backup\.runBackup\(/.test(src),
    "sync must no longer default to a full runBackup on every merge");
});

/* ---- data-safety review fixes (2026-07-26) ----
   Found reviewing the mirror above: listImageIds silently returns [] for a
   MISSING images dir, which without a guard reads as "the library now has 0
   images" and the mirror's own delete-stale-images loop would wipe the
   freshest recovery point -- and still "verify" (0 manifest entries === 0
   expected), so it fails open rather than closed. */
t("updateMirror refuses to run when the live images dir is missing but the mirror previously had images", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "cg1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:cg1" });
    images.putImg(store, "cg1", TINY_JPG);
    backup.updateMirror(db, store); // establish a real, non-empty mirror

    fs.rmSync(path.join(store, "images"), { recursive: true, force: true });
    assert.throws(() => backup.updateMirror(db, store), /images dir is missing/,
      "must refuse rather than wipe the mirror's images to match a vanished source dir");

    // ...and it must CLEAR itself once the dir is back, rather than latching on
    // a stale baseline: this guard gates every sync merge, so a permanent throw
    // would silently stop all syncing (the BLOCKING-2 wedge class).
    fs.mkdirSync(path.join(store, "images"), { recursive: true });
    images.putImg(store, "cg1", TINY_JPG);
    assert.strictEqual(backup.updateMirror(db, store).counts.images, 1);
    db.close();
  });
});
t("updateMirror refuses to run when the live image count collapses by more than half", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "cc" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:cc" + i });
      images.putImg(store, "cc" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Simulate an offline-placeholder / not-yet-downloaded Dropbox folder, or a
    // botched store move: most images are just gone, but the db still
    // references them all.
    for (let i = 0; i < 60; i++) fs.rmSync(path.join(store, "images", "cc" + i + ".jpg"), { force: true });
    assert.throws(() => backup.updateMirror(db, store), /expects 100 images but only 40 are on disk/);
    db.close();
  });
});
t("updateMirror refuses when a large library's images dir is emptied in place but its cards remain", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "ce" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:ce" + i });
      images.putImg(store, "ce" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // The dir still EXISTS (so the missing-dir guard does not fire) but every
    // image is gone while all 100 cards remain — images vanishing out from
    // under a stable library, which must never be mirrored through.
    for (let i = 0; i < 100; i++) fs.rmSync(path.join(store, "images", "ce" + i + ".jpg"), { force: true });
    assert.throws(() => backup.updateMirror(db, store), /expects 100 images but only 0 are on disk/);
    db.close();
  });
});
t("updateMirror allows a large library's images to drop when its card count drops in step (real bulk cleanup)", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "cb" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:cb" + i });
      images.putImg(store, "cb" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // A genuine bulk cleanup: cards AND their images go together. Refusing this
    // would wedge the mirror — and every sync merge — permanently, because the
    // baseline can never advance past 100 while the guard throws.
    for (let i = 0; i < 90; i++) {
      deleteCard(db, "cb" + i, Date.now());
      fs.rmSync(path.join(store, "images", "cb" + i + ".jpg"), { force: true });
    }
    const r = backup.updateMirror(db, store);
    assert.strictEqual(r.counts.images, 10);
    db.close();
  });
});
t("updateMirror still works normally on a genuinely small (<100 image) library — the collapse guard has a floor", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "sm1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:sm1" });
    images.putImg(store, "sm1", TINY_JPG);
    backup.updateMirror(db, store);
    fs.unlinkSync(path.join(store, "images", "sm1.jpg")); // dropped the only image
    const r = backup.updateMirror(db, store); // must NOT throw — below the 100-image floor
    assert.strictEqual(r.counts.images, 0);
    db.close();
  });
});

/* ---- the store-sanity gate is SELF-RELATIVE ----
   It compares what the DB says should be on disk against what is on disk, both
   from the current store. Earlier versions judged against counts recorded in
   previous backups; since those are written BY the backups the gate guards, a
   refusal meant no baseline could ever advance and the gate latched forever
   (all backups AND all syncing stopped for a user who cleared imported items).
   Six review rounds produced five data-loss regressions chasing that shape. */
t("the gate does not depend on the mirror's own marker (nothing to go stale)", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "tr" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:tr" + i });
      images.putImg(store, "tr" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Wipe every marker the old implementation derived its baseline from, then
    // break the store. The gate must still fire — its inputs are the live DB
    // and the live images dir, neither of which these files affect.
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "meta.json"), { force: true });
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "meta.updating.json"), { force: true });
    for (let i = 0; i < 100; i++) fs.rmSync(path.join(store, "images", "tr" + i + ".jpg"), { force: true });

    assert.throws(() => backup.updateMirror(db, store), /expects 100 images but only 0 are on disk/);
    assert.strictEqual(
      fs.readdirSync(path.join(bdir, backup.MIRROR_NAME, "images")).filter(n => n.endsWith(".jpg")).length, 100,
      "the mirror's images must still be there");
    db.close();
  });
});
t("an empty-reading source PRESERVES the mirror instead of overwriting it", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 150; i++) {
      upsertCard(db, { id: "pv" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:pv" + i });
      images.putImg(store, "pv" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    db.close();

    // The store's db is lost/replaced (config-pointer incident class, or a
    // pointer aimed at a fresh dir). openDb CREATEs the tables, so it reads as
    // a perfectly healthy EMPTY library -- expected 0, present 0, internally
    // consistent -- which the self-relative gate is correctly silent about.
    // In place, that would unlink all 150 mirror images and overwrite its db,
    // leaving a result that still verifies.
    fs.rmSync(path.join(store, "interests.db"), { force: true });
    for (const n of fs.readdirSync(path.join(store, "images"))) fs.rmSync(path.join(store, "images", n), { force: true });
    const db2 = openDb(store);
    const r = backup.updateMirror(db2, store);   // must NOT throw -- refusing is the latching shape
    assert.strictEqual(r.counts.imported, 0, "the mirror is rebuilt from the (empty) live store");

    const preserved = fs.readdirSync(bdir).filter(n => /^interests-backup-before-cleanup-/.test(n));
    assert.strictEqual(preserved.length, 1, "the pre-loss mirror must be preserved under a safety-snapshot name");
    const meta = JSON.parse(fs.readFileSync(path.join(bdir, preserved[0], "meta.json"), "utf8"));
    assert.strictEqual(meta._counts.images, 150, "with its images intact");
    assert.strictEqual(meta._counts.imported, 150, "and its card rows intact");
    assert.strictEqual(backup.verifyBackup(preserved[0], meta._counts), true, "and it must verify");

    // Self-limiting: the mirror folder was renamed away, so the next run has no
    // baseline and promotes nothing.
    backup.updateMirror(db2, store);
    assert.strictEqual(fs.readdirSync(bdir).filter(n => /^interests-backup-before-cleanup-/.test(n)).length, 1,
      "repeated empty runs must not accumulate promotions");
    db2.close();
  });
});
t("a lost db with images still on disk promotes ONCE, not on every merge", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 150; i++) {
      upsertCard(db, { id: "lo" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:lo" + i });
      images.putImg(store, "lo" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    db.close();

    // Variant (a): ONLY the database is lost — the images stay on disk. The
    // rebuilt mirror is then {cards:0, images:150}, so a card baseline that
    // falls back to the image count stays >=100 forever and re-promotes on
    // EVERY merge: one permanent full-library folder plus a full image rewrite
    // every 3 minutes, which is the churn this whole feature exists to remove.
    fs.rmSync(path.join(store, "interests.db"), { force: true });
    const db2 = openDb(store);

    const first = backup.updateMirror(db2, store);
    assert.strictEqual(first.counts.images, 150, "the images are still live, so the mirror keeps them");
    const after1 = fs.readdirSync(bdir).filter(n => /^interests-backup-before-cleanup-/.test(n));
    assert.strictEqual(after1.length, 1, "the pre-loss mirror is preserved once");
    const meta = JSON.parse(fs.readFileSync(path.join(bdir, after1[0], "meta.json"), "utf8"));
    assert.strictEqual(meta._counts.imported, 150, "and it holds the card rows the live store lost");

    for (let i = 0; i < 4; i++) {
      const r = backup.updateMirror(db2, store);
      assert.strictEqual(r.written, 0, "and later runs must not rewrite every image again");
    }
    assert.strictEqual(fs.readdirSync(bdir).filter(n => /^interests-backup-before-cleanup-/.test(n)).length, 1,
      "repeated merges must not accumulate a full-library copy each time");
    db2.close();
  });
});
t("a card-less newest snapshot cannot evict good older backups", () => {
  withBackupDir(function (bdir) {
    for (const d of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"]) mkBackupFolder(bdir, d, { imgFiles: 1, cards: 150 });

    // A store whose database was lost but whose images survive produces a
    // card-less snapshot that VERIFIES — its own file count matches its own
    // manifest — so "newest verifies" alone would unlock rotation and age out
    // genuinely good older backups.
    //
    // Deliberately a ROTATION gate, not a refusal to write: refusing is the
    // shape that latched this feature's guards through six revisions (a store
    // left with orphaned image files and no rows would be refused forever),
    // whereas declining to delete only ever preserves.
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 120; i++) images.putImg(store, "cl" + i, TINY_JPG);
    const bad = backup.runBackup(db, store);
    assert.strictEqual(bad.counts.imported, 0, "sanity: the snapshot really is card-less");
    assert.strictEqual(backup.verifyBackup(bad.name, bad.counts), true, "sanity: and it really does verify");

    backup.rotate(3);
    const dated = fs.readdirSync(bdir).filter(n => /^interests-backup-\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    assert.ok(dated.indexOf("interests-backup-2020-01-01") >= 0,
      "the oldest good backup must survive a collapsed newest: " + dated.join(", "));
    db.close();
  });
});
t("the gate CANNOT latch: a legitimate bulk delete clears it with no override", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 200; i++) {
      upsertCard(db, { id: "nl" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:nl" + i });
      images.putImg(store, "nl" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // "Clear imported items": cards AND their images go together, so expected
    // falls in the same operation as actual and the gate is silent by
    // construction. This is the case that permanently wedged every previous
    // implementation, and the reason this one needs no escape hatch.
    for (let i = 0; i < 195; i++) {
      deleteCard(db, "nl" + i, Date.now());
      fs.rmSync(path.join(store, "images", "nl" + i + ".jpg"), { force: true });
    }
    assert.strictEqual(backup.updateMirror(db, store).counts.imported, 5);
    assert.strictEqual(backup.updateMirror(db, store).counts.imported, 5, "and it stays clear on later runs");
    db.close();
  });
});
t("cards with http image URLs are not counted as expected local images", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    // 150 remote-thumbnail cards and no local images at all is a perfectly
    // normal library — img_file is null for them, so nothing is expected on
    // disk and the gate must stay silent.
    for (let i = 0; i < 150; i++) {
      upsertCard(db, { id: "ht" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "https://example.com/a.jpg" });
    }
    assert.strictEqual(backup.updateMirror(db, store).counts.images, 0);
    db.close();
  });
});
t("a run that throws after invalidating keeps its baseline, so the next run is still incremental", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 5; i++) {
      upsertCard(db, { id: "sc" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:sc" + i });
      images.putImg(store, "sc" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Simulate the torn state: marker moved aside, exactly as updateMirror does.
    const root = path.join(bdir, backup.MIRROR_NAME);
    fs.renameSync(path.join(root, "meta.json"), path.join(root, "meta.updating.json"));

    // Without the sidecar this would rewrite all 5 (prevByName empty) -- one
    // transient failure re-creating the very churn this feature removes.
    const r = backup.updateMirror(db, store);
    assert.strictEqual(r.written, 0, "the set-aside marker must still supply the skip-list");
    assert.strictEqual(fs.existsSync(path.join(root, "meta.updating.json")), false,
      "the sidecar must be cleared once the real marker is rewritten");
    db.close();
  });
});
t("updateMirror fails rather than reporting success when a stale image cannot be deleted", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 3; i++) {
      upsertCard(db, { id: "uf" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:uf" + i });
      images.putImg(store, "uf" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    fs.unlinkSync(path.join(store, "images", "uf2.jpg"));   // now stale in the mirror

    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = function (p) {
      if (String(p).endsWith("uf2.jpg")) { const e = new Error("EBUSY"); e.code = "EBUSY"; throw e; }
      return realUnlink.apply(fs, arguments);
    };
    try {
      // manifest.length and cnt.images both come from the SOURCE store, so they
      // agree with each other and cannot notice the leftover file. Only a real
      // count of the destination catches it -- otherwise updateMirror returns
      // success for a mirror that verifyBackup rejects, and /api/health keeps
      // reporting it fresh.
      assert.throws(() => backup.updateMirror(db, store), /verification failed/,
        "a mirror that cannot be restored from must not be reported as a successful update");
    } finally { fs.unlinkSync = realUnlink; }
    db.close();
  });
});
t("no interests.db tmp copy survives a failed mirror update", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "tm1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:tm1" });
    images.putImg(store, "tm1", TINY_JPG);
    backup.updateMirror(db, store);

    const realRename = fs.renameSync;
    const originalSleep = backup._timing.sleepSync;
    backup._timing.sleepSync = function () {};   // renameSyncWithRetry waits ~33s for real otherwise
    fs.renameSync = function (from, to) {
      if (String(to).endsWith("interests.db")) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; }
      return realRename.apply(fs, arguments);
    };
    try { backup.updateMirror(db, store); } catch (e) {} finally { fs.renameSync = realRename; backup._timing.sleepSync = originalSleep; }

    // Each leaked tmp is a FULL copy of the database, pid+timestamp unique so
    // they never self-overwrite, in the Dropbox-synced folder. Nothing else
    // collects them: sweepOrphanedArtifacts only scans the backup ROOT for
    // dot-prefixed names, and the image manifest only matches *.jpg.
    const leftovers = fs.readdirSync(path.join(bdir, backup.MIRROR_NAME)).filter(n => n.startsWith("interests.db.tmp."));
    assert.deepStrictEqual(leftovers, [], "a failed db copy must not leave a full database copy behind");
    db.close();
  });
});
t("ensureBackupBeforeMerge writes NO dated snapshot when the store itself is collapsed", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "wd" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:wd" + i });
      images.putImg(store, "wd" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    // Wedge the mirror: images gone, cards intact — the guard's throw case.
    for (let i = 0; i < 100; i++) fs.rmSync(path.join(store, "images", "wd" + i + ".jpg"), { force: true });

    assert.throws(() => backup.ensureBackupBeforeMerge(db, store, { fullSnapshotIntervalMs: 0 }),
      /only 0 are on disk/, "the failure must still propagate — sync's fail-closed contract");
    // The store is BROKEN here, so no dated snapshot may be written either. An
    // earlier version of this test asserted only that a snapshot EXISTED, which
    // passed just as happily on a 0-image one — and a 0-image dated snapshot is
    // actively dangerous: it VERIFIES (0 files matches 0 expected), becomes the
    // newest dated backup, unlocks rotate()'s "newest must verify" gate and
    // deletes a good older backup, and makes newestDatedSnapshotTime() report
    // today so the next real snapshot is suppressed for a week.
    const dated = fs.readdirSync(bdir).filter(n => /^interests-backup-\d{4}-\d{2}-\d{2}$/.test(n));
    assert.deepStrictEqual(dated, [], "a collapsed store must not be captured as a point-in-time snapshot");
    db.close();
  });
});
t("a healthy store still gets its overdue dated snapshot even when the mirror fails for an unrelated reason", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 3; i++) {
      upsertCard(db, { id: "hs" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:hs" + i });
      images.putImg(store, "hs" + i, TINY_JPG);
    }
    // Mirror fails on a transient rename, NOT on a store-sanity problem — the
    // store itself is fine, so the durable snapshot must still be taken.
    const realRename = fs.renameSync;
    const originalSleep = backup._timing.sleepSync;
    backup._timing.sleepSync = function () {};   // renameSyncWithRetry waits ~33s for real otherwise
    fs.renameSync = function (from, to) {
      if (String(to).endsWith("interests.db")) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; }
      return realRename.apply(fs, arguments);
    };
    try {
      assert.throws(() => backup.ensureBackupBeforeMerge(db, store, { fullSnapshotIntervalMs: 0 }));
    } finally { fs.renameSync = realRename; backup._timing.sleepSync = originalSleep; }

    const dated = fs.readdirSync(bdir).filter(n => /^interests-backup-\d{4}-\d{2}-\d{2}$/.test(n));
    assert.strictEqual(dated.length, 1, "losing the cheap recovery point must not also lose the durable one");
    const meta = JSON.parse(fs.readFileSync(path.join(bdir, dated[0], "meta.json"), "utf8"));
    assert.strictEqual(meta._counts.images, 3, "and the snapshot must actually contain the images");
    assert.strictEqual(backup.verifyBackup(dated[0], meta._counts), true);
    db.close();
  });
});
t("runBackup itself refuses a collapsed store, so POST /api/backup cannot publish one either", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "rb" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:rb" + i });
      images.putImg(store, "rb" + i, TINY_JPG);
    }
    backup.runBackup(db, store);   // establishes a good baseline
    for (let i = 0; i < 100; i++) fs.rmSync(path.join(store, "images", "rb" + i + ".jpg"), { force: true });

    // The guard belongs to the STORE, not to one backup format: the daily
    // client-driven POST /api/backup path reaches runBackup directly, never
    // through ensureBackupBeforeMerge, so guarding only the merge gate would
    // leave this hole wide open.
    assert.throws(() => backup.runBackup(db, store), /only 0 are on disk/,
      "a dated snapshot of an incomplete store verifies, unlocks rotation, and deletes a good backup");
    db.close();
  });
});
t("freezeMirrorForRestore refuses an image corrupted in place at the same byte length", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 3; i++) {
      upsertCard(db, { id: "fc" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:fc" + i });
      images.putImg(store, "fc" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Same length, different bytes: counts still match, so the count
    // cross-check passes, and the frozen copy re-hashes its OWN copied bytes —
    // self-referential, so it always verifies. Only the live marker's per-file
    // sha256 is an independent record of what the bytes should be.
    const img = path.join(bdir, backup.MIRROR_NAME, "images", "fc1.jpg");
    const orig = fs.readFileSync(img);
    const bad = Buffer.from(orig); bad[10] = bad[10] ^ 0xff;
    assert.strictEqual(bad.length, orig.length);
    fs.writeFileSync(img, bad);

    const r = backup.stageRestore(backup.MIRROR_NAME, store);
    assert.strictEqual(r.ok, false, "a corrupted mirror image must not be restored into the live store");
    assert.ok(/does not match the mirror's own manifest hash/.test(r.error || ""), "and must say why: " + r.error);
    assert.strictEqual(counts(db).cards, 3, "live store untouched by a refused stageRestore");
    try { db.close(); } catch (e) {}
  });
});
/* ---- the escape hatch (data-safety review 2026-07-26, BLOCKING) ----
   Five consecutive rounds of collapse-guard fixes each assumed an override
   existed; none of them ever executed it, and it turned out to be inert. The
   guards read the accepted baseline ONLY when their derived baselines were
   absent, and updateMirror always supplies a derived one — so accepting did
   nothing while the UI toasted "backups will resume". These tests execute the
   real code path and assert the next call SUCCEEDS. */
t("a collapsed store's safety snapshots do not evict good pre-collapse ones", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 150; i++) {
      upsertCard(db, { id: "se" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:se" + i });
      images.putImg(store, "se" + i, TINY_JPG);
    }
    const good1 = backup.runBackup(db, store, { safety: true });
    const good2 = backup.runBackup(db, store, { safety: true });

    // Safety snapshots are exempt from the sanity gate (correctly — they must
    // capture whatever state the store is in before a destructive op). But a
    // 0-image snapshot VERIFIES, so two destructive ops on a collapsed store
    // would otherwise evict every good pre-collapse snapshot.
    for (let i = 0; i < 150; i++) {
      deleteCard(db, "se" + i, Date.now());
      fs.rmSync(path.join(store, "images", "se" + i + ".jpg"), { force: true });
    }
    backup.runBackup(db, store, { safety: true });
    backup.runBackup(db, store, { safety: true });

    const names = fs.readdirSync(bdir);
    assert.ok(names.indexOf(good1.name) >= 0 && names.indexOf(good2.name) >= 0,
      "both healthy pre-collapse safety snapshots must survive");
    db.close();
  });
});

t("a pre-cleanup safety snapshot is still allowed on a collapsed store", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "sf" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:sf" + i });
      images.putImg(store, "sf" + i, TINY_JPG);
    }
    backup.runBackup(db, store);
    for (let i = 0; i < 100; i++) fs.rmSync(path.join(store, "images", "sf" + i + ".jpg"), { force: true });

    // Its whole job is to preserve whatever state the store is in RIGHT NOW,
    // sane or not, before a destructive operation — refusing it would remove
    // the safety net exactly when the store is already in trouble.
    const r = backup.runBackup(db, store, { safety: true });
    assert.ok(r && r.name && /before-cleanup/.test(r.name), "the safety snapshot must not be blocked by the sanity gate");
    db.close();
  });
});
t("a routine backup does not overwrite the boot-time collapse witness", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 200; i++) {
      upsertCard(db, { id: "lw" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:lw" + i });
      images.putImg(store, "lw" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    assert.strictEqual(config.getLastCounts().cards, 200, "sanity: the witness starts healthy");

    // A gutted store. The store-sanity gate is deliberately SILENT here -- cards
    // and their images fall together, which is indistinguishable from the user
    // clearing their library, and refusing it is what latched every previous
    // implementation. This case is covered instead by config.evaluateStoreSafety's
    // boot-time prompt, which puts a human in the loop and cannot block a backup.
    // For that prompt to fire, the witness must survive the collapse.
    for (let i = 0; i < 197; i++) {
      deleteCard(db, "lw" + i, Date.now());
      fs.rmSync(path.join(store, "images", "lw" + i + ".jpg"), { force: true });
    }
    backup.updateMirror(db, store);   // must NOT throw
    assert.strictEqual(config.getLastCounts().cards, 200,
      "the witness must survive a collapse so the boot-time check still fires");
    const safety = config.evaluateStoreSafety({
      storeDir: store, counts: { cards: 3, saved: 0 }, lastCounts: config.getLastCounts(),
    });
    assert.ok(safety.collapsedCounts, "the boot-time collapse detector must still fire");
    db.close();
  });
});
t("restore leaves no interests-mirror-freeze-* folder behind, on success OR failure", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 3; i++) {
      upsertCard(db, { id: "fz" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:fz" + i });
      images.putImg(store, "fz" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    const ctx = { db: db, storeDir: store, reopen: function () { return openDb(store); } };
    const ok = backup.stageRestore(backup.MIRROR_NAME, store, backup.storeWitness(db, store));
    assert.strictEqual(ok.ok, true, "sanity: the mirror restore itself must succeed");
    assert.strictEqual(backup.swapInStagedRestore(ok, ctx).ok, true, "sanity: the swap must succeed too");
    assert.deepStrictEqual(
      fs.readdirSync(bdir).filter(n => /^interests-mirror-freeze-/.test(n)), [],
      "the freeze copy is a near-full image-library duplicate in the Dropbox-synced folder — it must not survive a successful restore");

    // And on a failure path: a torn mirror is refused before any copy is made.
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "meta.json"), { force: true });
    const bad = backup.stageRestore(backup.MIRROR_NAME, store);
    assert.strictEqual(bad.ok, false);
    assert.deepStrictEqual(
      fs.readdirSync(bdir).filter(n => /^interests-mirror-freeze-/.test(n)), [],
      "a failed restore must not leak a freeze folder either");
    try { ctx.db.close(); } catch (e) {}
  });
});

t("updateMirror self-heals an in-place-corrupted image (same byte length, different content)", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 5; i++) {
      upsertCard(db, { id: "sh" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:sh" + i });
      images.putImg(store, "sh" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Corrupt the MIRROR's own copy (not the source) at the exact same byte
    // length -- the size check alone can never catch this.
    const mirrorImg = path.join(bdir, backup.MIRROR_NAME, "images", "sh2.jpg");
    const original = fs.readFileSync(mirrorImg);
    const corrupted = Buffer.from(original); corrupted[10] = corrupted[10] ^ 0xff;
    assert.strictEqual(corrupted.length, original.length, "corruption must preserve byte length to test the size-check blind spot");
    fs.writeFileSync(mirrorImg, corrupted);

    // The test library is well under MIRROR_RECHECK_SLICE, so every "unchanged"
    // file gets its dest re-hashed on the very next run.
    const r = backup.updateMirror(db, store);
    assert.strictEqual(fs.readFileSync(mirrorImg).equals(original), true, "the corrupted copy must be rewritten from the live source");
    assert.ok(r.written >= 1, "the self-heal must count as a write");
    assert.strictEqual(backup.verifyBackup(backup.MIRROR_NAME, r.counts), true);
    db.close();
  });
});

t("rotate() is not frozen by an unrelated newer entry (the mirror) failing to verify", () => {
  withBackupDir(function (bdir) {
    // 4 healthy dated backups (mkBackupFolder creates each its own valid,
    // WAL-flushed db — the same helper the pre-existing rotate tests above
    // already rely on), so rotate(keep=3) has real work to do.
    for (const d of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"]) mkBackupFolder(bdir, d, { imgFiles: 1 });

    // A mirror that IS newest by sort order (meta.json exists with a fresh,
    // real `ts`, exactly like a real in-place update) but fails deeper
    // verification — an image the manifest claims to have is simply missing,
    // with meta.json left untouched, mimicking a mirror caught mid-write.
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "rf1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:rf1" });
    images.putImg(store, "rf1", TINY_JPG);
    backup.updateMirror(db, store);
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "images", "rf1.jpg"), { force: true });

    const list = backup.listBackups();
    assert.strictEqual(list[0].mirror, true, "sanity: the mirror really does sort first (fresh meta.json ts)");
    assert.strictEqual(backup.verifyBackup(backup.MIRROR_NAME, list[0].counts), false,
      "sanity: the mirror really is unverified (an image the manifest claims is now missing)");

    backup.rotate(3);
    const remainingDated = fs.readdirSync(bdir).filter(n => /^interests-backup-\d{4}-\d{2}-\d{2}$/.test(n));
    assert.strictEqual(remainingDated.length, 3, "dated rotation must proceed on its own merits, not freeze because an unrelated newer entry is broken");
    db.close();
  });
});

t("newestDatedSnapshotTime ignores a dated folder with no meta.json (not a real recovery point yet)", () => {
  withBackupDir(function (bdir) {
    const folder = path.join(bdir, "interests-backup-2099-01-01");
    fs.mkdirSync(path.join(folder, "images"), { recursive: true });
    // no meta.json written — an incomplete/corrupt folder
    assert.strictEqual(backup.newestDatedSnapshotTime(), 0, "a folder with no completion marker must not count as a fresh snapshot");
  });
});
t("newestDatedSnapshotTime ignores a future-dated folder (clock skew must never suppress the next real snapshot)", () => {
  withBackupDir(function (bdir) {
    const farFuture = "interests-backup-2099-01-01";
    const folder = path.join(bdir, farFuture);
    fs.mkdirSync(path.join(folder, "images"), { recursive: true });
    fs.writeFileSync(path.join(folder, "interests.db"), Buffer.from("not a real db"));
    fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ _counts: { imported: 0, saved: 0, images: 0 }, _images: [], ts: Date.now() }));
    assert.strictEqual(backup.newestDatedSnapshotTime(), 0, "a future-dated folder must not suppress a real full snapshot from being taken");
  });
});

t("restore(MIRROR_NAME) freezes the mirror first and restores correctly from the frozen copy", () => {
  withBackupDir(function () {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "rm1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:rm1" });
    images.putImg(store, "rm1", TINY_JPG);
    backup.updateMirror(db, store);

    // Mutate the live store AFTER the mirror snapshot, so a correct restore
    // must bring it back to 1 card, not 2.
    upsertCard(db, { id: "rm2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "" });
    assert.strictEqual(counts(db).cards, 2);

    const ctx = { db, storeDir: store, reopen: () => openDb(store) };
    const staged = backup.stageRestore(backup.MIRROR_NAME, store, backup.storeWitness(db, store));
    assert.strictEqual(staged.ok, true, "error: " + (staged.error || ""));
    const r = backup.swapInStagedRestore(staged, ctx);
    assert.strictEqual(r.ok, true, "error: " + (r.error || ""));
    assert.strictEqual(counts(ctx.db).cards, 1, "must restore to the mirror's 1-card state, not the mutated 2-card live state");
    ctx.db.close();
  });
});
t("restore(MIRROR_NAME) fails closed (does not touch the live store) when the mirror does not exist yet", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "nm1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:nm1" });
    const ctx = { db, storeDir: store, reopen: () => openDb(store) };
    const r = backup.stageRestore(backup.MIRROR_NAME, store);
    assert.strictEqual(r.ok, false, "no mirror has ever been written — restore must fail, not crash or touch the live store");
    assert.strictEqual(counts(ctx.db).cards, 1, "live store must be completely untouched");
    ctx.db.close();
  });
});

t("runBackup copies db + images and verifyBackup confirms", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    upsertSaved(db, { id: "s1", url: "https://x/2", category: "Tips", clipped: 1, image: "idb:s1" });
    images.putImg(store, "c1", TINY_JPG);
    images.putImg(store, "s1", TINY_JPG);

    const res = backup.runBackup(db, store);
    assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(res.name), "dated folder name");
    assert.deepStrictEqual(res.counts, { imported: 1, saved: 1, images: 2 });

    const bdir = backup.dropboxBackupDir();
    assert.ok(fs.existsSync(path.join(bdir, res.name, "interests.db")), "db copied");
    assert.strictEqual(fs.readdirSync(path.join(bdir, res.name, "images")).filter(function (n) { return n.endsWith(".jpg"); }).length, 2, "2 images copied");

    assert.strictEqual(backup.verifyBackup(res.name, res.counts), true);
    assert.strictEqual(backup.verifyBackup(res.name, { imported: 1, saved: 1, images: 999 }), false);
    db.close();
  });
});

t("runBackup creates an exact same-day image mirror after live removals", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    images.putImg(store, "orphan", TINY_JPG);

    const first = backup.runBackup(db, store);
    assert.strictEqual(first.counts.images, 2);
    fs.rmSync(path.join(store, "images", "orphan.jpg"));
    const liveC1 = path.join(store, "images", "c1.jpg");
    const sameSize = fs.statSync(liveC1).size;
    fs.writeFileSync(liveC1, Buffer.alloc(sameSize, 7));

    const refreshed = backup.runBackup(db, store);
    const backupImages = path.join(backup.dropboxBackupDir(), refreshed.name, "images");
    assert.deepStrictEqual(fs.readdirSync(backupImages).filter(function (n) { return n.endsWith(".jpg"); }).sort(), ["c1.jpg"]);
    assert.deepStrictEqual(fs.readFileSync(path.join(backupImages, "c1.jpg")), fs.readFileSync(liveC1), "same-size changed bytes are refreshed");
    assert.strictEqual(backup.verifyBackup(refreshed.name, refreshed.counts), true);
    db.close();
  });
});

t("runBackup creates unique non-rotating cleanup safety snapshots", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const out = backup.runBackup(db, store, { safety: true });
    assert.match(out.name, /^interests-backup-before-cleanup-\d+-[a-f0-9]{12}$/);
    assert.strictEqual(backup.verifyBackup(out.name, out.counts), true);
    assert.strictEqual(backup.listBackups().some(function (b) { return b.name === out.name && b.safety; }), true);
    backup.rotate(0);
    assert.strictEqual(fs.existsSync(path.join(backup.dropboxBackupDir(), out.name)), true, "rotation ignores cleanup snapshots");
    db.close();
  });
});

t("cleanup safety snapshots remain distinct when timestamps collide", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const originalNow = Date.now;
    Date.now = function () { return 1700000000000; };
    let first, second;
    try {
      first = backup.runBackup(db, store, { safety: true });
      const liveFile = path.join(store, "images", "c1.jpg");
      fs.writeFileSync(liveFile, Buffer.alloc(fs.statSync(liveFile).size, 9));
      second = backup.runBackup(db, store, { safety: true });
    } finally {
      Date.now = originalNow;
    }
    assert.notStrictEqual(first.name, second.name);
    assert.strictEqual(backup.verifyBackup(first.name, first.counts), true);
    assert.strictEqual(backup.verifyBackup(second.name, second.counts), true);
    const root = backup.dropboxBackupDir();
    assert.notDeepStrictEqual(fs.readFileSync(path.join(root, first.name, "images", "c1.jpg")), fs.readFileSync(path.join(root, second.name, "images", "c1.jpg")));
    db.close();
  });
});

t("cleanup safety snapshots rotate to the newest 2 once a call exceeds the keep window", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const names = [];
    const originalNow = Date.now;
    let ts = 1700000000000;
    try {
      for (let i = 0; i < 4; i++) {
        Date.now = function () { return ts; };
        names.push(backup.runBackup(db, store, { safety: true }).name);
        ts += 1000;
      }
    } finally { Date.now = originalNow; }
    const root = backup.dropboxBackupDir();
    const present = names.filter(function (n) { return fs.existsSync(path.join(root, n)); });
    assert.strictEqual(present.length, 2, "only the newest `keep` (2) safety snapshots survive");
    assert.deepStrictEqual(present.sort(), [names[2], names[3]].sort(), "the two newest are the ones kept, not an arbitrary pair");
    db.close();
  });
});

t("drainBackupBacklog converges past the per-call cleanup cap in one call", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const first = backup.runBackup(db, store, { safety: true });
    const root = backup.dropboxBackupDir();
    // Simulate a large pre-existing backlog (more than MAX_CLEANUP_PER_CALL=3
    // beyond keep=2) by duplicating the one verified snapshot under distinct
    // safety-pattern names/timestamps — a single runBackup() call's own capped
    // rotation could not clear this in one pass.
    const meta = JSON.parse(fs.readFileSync(path.join(root, first.name, "meta.json"), "utf8"));
    for (let i = 0; i < 9; i++) {
      const name = "interests-backup-before-cleanup-" + (1700000000000 + i) + "-" + "abcdef012345";
      const folder = path.join(root, name);
      fs.cpSync(path.join(root, first.name), folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify(meta));
    }
    const before = fs.readdirSync(root).filter(function (n) { return /^interests-backup-before-cleanup-/.test(n); });
    assert.ok(before.length > 5, "backlog exceeds one call's cleanup cap");
    const result = backup.drainBackupBacklog();
    const after = fs.readdirSync(root).filter(function (n) { return /^interests-backup-before-cleanup-/.test(n); });
    assert.strictEqual(after.length, 2, "converges to keep=2 in a single drainBackupBacklog() call");
    assert.ok(result.cleaned >= before.length - 2, "reports how much it actually cleaned");
    db.close();
  });
});

t("a stale hidden .previous-* sidecar is swept once its replacement verifies", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const first = backup.runBackup(db, store); // dated backup, e.g. interests-backup-2026-...
    const root = backup.dropboxBackupDir();
    // Simulate a previously-failed cleanup: rename the (now-superseded, but here
    // there's nothing superseding it yet) folder's sidecar shape directly.
    const orphan = path.join(root, "." + first.name + ".previous-orphaned-token");
    fs.cpSync(path.join(root, first.name), orphan, { recursive: true });
    assert.ok(fs.existsSync(orphan), "orphan sidecar created for the test");
    // A later call (any runBackup) opportunistically sweeps stale sidecars whose
    // canonical replacement already verifies.
    backup.runBackup(db, store, { safety: true });
    assert.strictEqual(fs.existsSync(orphan), false, "the orphaned sidecar was cleaned up");
    db.close();
  });
});

t("verifyBackup rejects metadata counts not present in the copied database", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const out = backup.runBackup(db, store);
    const claimed = { imported: 2, saved: 0, images: 0 };
    const folder = path.join(backup.dropboxBackupDir(), out.name);
    fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ _counts: claimed, ts: Date.now() }));
    assert.strictEqual(backup.verifyBackup(out.name, claimed), false);
    db.close();
  });
});

t("runBackup preserves the prior verified backup when staged refresh fails", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    images.putImg(store, "prior", TINY_JPG);
    const first = backup.runBackup(db, store);
    const priorCounts = first.counts;
    const priorFolder = path.join(backup.dropboxBackupDir(), first.name);
    fs.rmSync(path.join(store, "images", "prior.jpg"));

    const originalCopy = fs.copyFileSync;
    fs.copyFileSync = function (src, dst) {
      if (src === path.join(store, "interests.db") && dst.indexOf(".staging-") >= 0) throw new Error("simulated staged write failure");
      return originalCopy.apply(fs, arguments);
    };
    try {
      assert.throws(function () { backup.runBackup(db, store); }, /simulated staged write failure/);
    } finally {
      fs.copyFileSync = originalCopy;
    }

    assert.strictEqual(backup.verifyBackup(first.name, priorCounts), true);
    assert.deepStrictEqual(fs.readdirSync(path.join(priorFolder, "images")).filter(function (n) { return n.endsWith(".jpg"); }).sort(), ["c1.jpg", "prior.jpg"]);
    db.close();
  });
});

t("runBackup rolls the prior verified backup back when publish rename fails", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    images.putImg(store, "prior", TINY_JPG);
    const first = backup.runBackup(db, store);
    const priorCounts = first.counts;
    fs.rmSync(path.join(store, "images", "prior.jpg"));

    const originalRename = fs.renameSync;
    fs.renameSync = function (src, dst) {
      if (src.indexOf(".staging-") >= 0 && dst === path.join(backup.dropboxBackupDir(), first.name)) throw new Error("simulated publish failure");
      return originalRename.apply(fs, arguments);
    };
    try {
      assert.throws(function () { backup.runBackup(db, store); }, /simulated publish failure/);
    } finally {
      fs.renameSync = originalRename;
    }

    assert.strictEqual(backup.verifyBackup(first.name, priorCounts), true);
    db.close();
  });
});

// RENAME_RETRY_ATTEMPTS in core/backup.js — kept in sync manually; a mismatch
// only makes the "gives up" test below assert the wrong count, not silently pass.
const EXPECTED_RENAME_RETRY_ATTEMPTS = 45;

t("runBackup retries the publish rename after a transient EPERM and succeeds", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);

    // Live-measured 2026-07-24 against a production library: Dropbox held the
    // publish-rename lock for ~20s (32 attempts) before clearing on its own —
    // not "a beat". core/backup.js's retry budget covers that with margin; this
    // test only proves the retry-then-succeed mechanics, so the mock sleep is
    // stubbed to instant (real timing is covered by the live measurement, not
    // re-asserted here — a 20s+ sleep has no place in a fast test suite).
    const originalSleep = backup._timing.sleepSync;
    backup._timing.sleepSync = function () {};
    let publishAttempts = 0;
    const originalRename = fs.renameSync;
    fs.renameSync = function (src, dst) {
      const isPublish = String(src).indexOf(".staging-") >= 0 && String(dst).indexOf(".staging-") < 0 && String(dst).indexOf(".previous-") < 0;
      if (isPublish) {
        publishAttempts++;
        if (publishAttempts < 3) { const e = new Error("simulated transient lock"); e.code = "EPERM"; throw e; }
      }
      return originalRename.apply(fs, arguments);
    };
    let out;
    try {
      out = backup.runBackup(db, store, { safety: true });
    } finally {
      fs.renameSync = originalRename;
      backup._timing.sleepSync = originalSleep;
    }

    assert.strictEqual(publishAttempts, 3, "should have retried the publish rename twice before succeeding on the 3rd attempt");
    assert.strictEqual(backup.verifyBackup(out.name, out.counts), true);
    db.close();
  });
});

t("runBackup gives up and rolls back after the publish rename keeps failing with a transient error", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const first = backup.runBackup(db, store);
    const priorCounts = first.counts;

    const originalSleep = backup._timing.sleepSync;
    backup._timing.sleepSync = function () {};
    let publishAttempts = 0;
    const originalRename = fs.renameSync;
    fs.renameSync = function (src, dst) {
      const isPublish = String(src).indexOf(".staging-") >= 0 && String(dst).indexOf(".staging-") < 0 && String(dst).indexOf(".previous-") < 0;
      if (isPublish) { publishAttempts++; const e = new Error("simulated persistent lock"); e.code = "EPERM"; throw e; }
      return originalRename.apply(fs, arguments);
    };
    try {
      assert.throws(function () { backup.runBackup(db, store); }, /simulated persistent lock/);
    } finally {
      fs.renameSync = originalRename;
      backup._timing.sleepSync = originalSleep;
    }

    assert.strictEqual(publishAttempts, EXPECTED_RENAME_RETRY_ATTEMPTS, "should retry exactly RENAME_RETRY_ATTEMPTS times before giving up");
    assert.strictEqual(backup.verifyBackup(first.name, priorCounts), true, "the prior verified backup must survive an exhausted-retry publish failure");
    db.close();
  });
});

t("runBackup does not fail when removing the displaced previous backup hits a transient lock (live-testing regression 2026-07-31)", () => {
  // The new backup is already published and verified by the time this cleanup
  // runs — a transient Dropbox lock (EPERM/EBUSY/EACCES) on removing the now-
  // redundant displaced copy must not fail the whole call and must not be
  // reported to the user as "backup failed" when the backup itself succeeded.
  // sweepOrphanedArtifacts (already exercised by the reconcile test below)
  // picks up any leftover on the next call, so this is pure cleanup, not
  // safety-critical to do synchronously here.
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const first = backup.runBackup(db, store);   // creates today's dated backup

    let rmAttempted = false;
    const originalRm = fs.rmSync;
    fs.rmSync = function (target) {
      if (String(target).indexOf(".previous-") >= 0) {
        rmAttempted = true;
        const e = new Error("simulated Dropbox sync lock"); e.code = "EPERM"; throw e;
      }
      return originalRm.apply(fs, arguments);
    };
    let second;
    try {
      second = backup.runBackup(db, store);   // same dateStamp -> displaces `first`, cleanup hits the mocked lock
    } finally {
      fs.rmSync = originalRm;
    }

    assert.ok(rmAttempted, "the mocked rmSync on the displaced previous backup must actually have been exercised");
    assert.strictEqual(backup.verifyBackup(second.name, second.counts), true, "the NEW backup must still be published and verified even though its old-copy cleanup failed");
    assert.strictEqual(first.name, second.name, "sanity: both calls landed the same dateStamp'd backup name, so the second really did displace the first");

    const root = backup.dropboxBackupDir();
    const leftoverBefore = fs.readdirSync(root).filter((n) => n.indexOf(".previous-") >= 0);
    assert.strictEqual(leftoverBefore.length, 1, "the failed cleanup must actually have left the orphan on disk (not silently no-op'd)");

    backup.runBackup(db, store);   // a real (unmocked) third call — sweepOrphanedArtifacts must self-heal the leftover
    const leftoverAfter = fs.readdirSync(root).filter((n) => n.indexOf(".previous-") >= 0);
    assert.strictEqual(leftoverAfter.length, 0, "the orphan left by the failed cleanup must be swept once its replacement re-verifies on the next call");
    db.close();
  });
});

t("runBackup reconciles a verified backup displaced by an interrupted publish", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const first = backup.runBackup(db, store);
    const root = backup.dropboxBackupDir();
    const hidden = "." + first.name + ".previous-interrupted";
    fs.renameSync(path.join(root, first.name), path.join(root, hidden));

    const refreshed = backup.runBackup(db, store);
    assert.strictEqual(backup.verifyBackup(refreshed.name, refreshed.counts), true);
    assert.strictEqual(fs.existsSync(path.join(root, hidden)), false, "verified displaced folder was reconciled");
    db.close();
  });
});

t("runBackup writes a portable snapshot.json with unstripped settings", () => {
  withBackupDir(function () {
    const store = newStore();
    const dbHandle = openDb(store);
    upsertCard(dbHandle, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    upsertSaved(dbHandle, { id: "s1", url: "https://x/2", category: "Tips", clipped: 1, image: "idb:s1" });
    setKV(dbHandle, "ia_settings", JSON.stringify({ about: "me", keys: { anthropic: "SECRET_KEY" }, oprKey: "OPR_SECRET" }));

    const res = backup.runBackup(dbHandle, store);
    const bdir = backup.dropboxBackupDir();
    const snapPath = path.join(bdir, res.name, "snapshot.json");
    assert.ok(fs.existsSync(snapPath), "snapshot.json written");

    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    assert.strictEqual(snap.cards.length, 1);
    assert.strictEqual(snap.cards[0].id, "c1");
    assert.strictEqual(snap.saved.length, 1);
    assert.strictEqual(snap.saved[0].id, "s1");
    assert.deepStrictEqual(snap.tombstones, []);
    // Unstripped — unlike settingsForSync(), the API key must survive here.
    assert.strictEqual(snap.settings.keys.anthropic, "SECRET_KEY");
    assert.strictEqual(snap.settings.oprKey, "OPR_SECRET");
    dbHandle.close();
  });
});

t("runBackup refreshes a same-day backup without retaining deleted images", () => {
  withBackupDir(function () {
    const store = newStore();
    const database = openDb(store);
    upsertCard(database, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const first = backup.runBackup(database, store);

    fs.unlinkSync(path.join(store, "images", "c1.jpg"));
    const second = backup.runBackup(database, store);
    const folder = path.join(backup.dropboxBackupDir(), second.name);
    assert.strictEqual(second.name, first.name, "same-day backup is refreshed in place semantically");
    assert.strictEqual(backup.verifyBackup(second.name, second.counts), true, "refreshed backup verifies");
    assert.strictEqual(fs.readdirSync(path.join(folder, "images")).filter(function (n) { return n.endsWith(".jpg"); }).length, 0, "deleted image is removed");
    database.close();
  });
});

t("listBackups lists dated folders newest-first with counts", () => {
  withBackupDir(function (bdir) {
    // hand-create two dated folders with meta.json
    for (const d of ["2026-06-20", "2026-06-22"]) {
      const f = path.join(bdir, "interests-backup-" + d);
      fs.mkdirSync(path.join(f, "images"), { recursive: true });
      fs.writeFileSync(path.join(f, "interests.db"), "x");
      fs.writeFileSync(path.join(f, "meta.json"), JSON.stringify({ _counts: { imported: 2, saved: 0, images: 0 }, ts: 1 }));
    }
    const list = backup.listBackups();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].name, "interests-backup-2026-06-22", "newest first");
    assert.strictEqual(list[1].name, "interests-backup-2026-06-20");
    assert.deepStrictEqual(list[0].counts, { imported: 2, saved: 0, images: 0 });
  });
});

/* ---- rotate (verify-before-delete) ---- */
function mkBackupFolder(bdir, date, opts) {
  // opts: {imgFiles, metaImages, db: bool} — build a backup folder we control
  const folder = path.join(bdir, "interests-backup-" + date);
  fs.mkdirSync(path.join(folder, "images"), { recursive: true });
  for (let i = 0; i < (opts.imgFiles || 0); i++) fs.writeFileSync(path.join(folder, "images", "img" + i + ".jpg"), Buffer.alloc(4, 1));
  const nCards = opts.cards != null ? opts.cards : 1;
  if (opts.db !== false) {
    const d = openDb(folder);
    for (let i = 0; i < nCards; i++) upsertCard(d, { id: "fixture-" + date + "-" + i, url: "https://fixture/" + date + "/" + i });
    d.close();
  }
  const manifest = fs.readdirSync(path.join(folder, "images")).filter(n => n.endsWith(".jpg")).sort().map(n => {
    const file = path.join(folder, "images", n);
    return { name: n, size: fs.statSync(file).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  });
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ _counts: { imported: nCards, saved: 0, images: opts.metaImages != null ? opts.metaImages : (opts.imgFiles || 0) }, _images: manifest, ts: 1 }));
  return folder;
}

t("rotate keeps newest `keep`, deletes verified older ones", () => {
  withBackupDir(function (bdir) {
    for (const d of ["2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"]) mkBackupFolder(bdir, d, { imgFiles: 1 });
    backup.rotate(2);
    const left = fs.readdirSync(bdir).filter(function (n) { return n.startsWith("interests-backup-"); }).sort();
    assert.deepStrictEqual(left, ["interests-backup-2026-06-20", "interests-backup-2026-06-21"]);
  });
});

t("rotate does NOT delete an older good backup when the newest is unverified", () => {
  withBackupDir(function (bdir) {
    // newest is BROKEN: meta claims 5 images but folder has 0 → verifyBackup false
    mkBackupFolder(bdir, "2026-06-18", { imgFiles: 1 });           // good, older
    mkBackupFolder(bdir, "2026-06-19", { imgFiles: 1 });           // good, older
    mkBackupFolder(bdir, "2026-06-20", { imgFiles: 0, metaImages: 5 }); // BROKEN newest
    backup.rotate(2);
    const left = fs.readdirSync(bdir).filter(function (n) { return n.startsWith("interests-backup-"); }).sort();
    // keep=2 would normally delete 06-18, but the newest is unverified → nothing deleted
    assert.deepStrictEqual(left, ["interests-backup-2026-06-18", "interests-backup-2026-06-19", "interests-backup-2026-06-20"]);
  });
});

t("rotate keeps an older backup that itself fails verification (never delete a good one for a bad one)", () => {
  withBackupDir(function (bdir) {
    mkBackupFolder(bdir, "2026-06-18", { imgFiles: 0, metaImages: 9 }); // BROKEN older — must NOT be deleted
    mkBackupFolder(bdir, "2026-06-19", { imgFiles: 1 });               // good
    mkBackupFolder(bdir, "2026-06-20", { imgFiles: 1 });               // good newest
    backup.rotate(2);
    const left = fs.readdirSync(bdir).filter(function (n) { return n.startsWith("interests-backup-"); }).sort();
    // 06-18 is a rotation candidate but it doesn't verify → leave it (a bad backup is
    // not a safe thing to delete; only delete a backup that is provably complete)
    assert.deepStrictEqual(left, ["interests-backup-2026-06-18", "interests-backup-2026-06-19", "interests-backup-2026-06-20"]);
  });
});
/* ---- restore (stage off-thread, then a fast main-thread swap) ----
   restore(name, ctx) used to be ONE synchronous call that verified, safety-
   snapshotted, and overwrote the live store in place while ctx.db was closed —
   inherently main-thread-blocking for the whole copy. It is now split: the slow,
   ctx-free, path-only work (verify + safety snapshot + stage) lives in
   stageRestore(name, storeDir) and can run in a worker; only the fast rename
   swap (swapInStagedRestore) needs the real ctx. The safety properties asserted
   here are the SAME ones the old single-call tests asserted. */
t("stageRestore verifies the source backup and stages it next to the live store, without touching ctx.db", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const made = backup.runBackup(db1, store);
    db1.close();

    // Change the live store after the backup, so we can tell restore actually
    // staged the OLD (backed-up) content, not the current live content.
    const db2 = openDb(store);
    upsertCard(db2, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2 });

    // missing-backup guard: a well-formed but nonexistent name stages nothing
    // and reports failure with no error string (the route relays this verbatim).
    assert.deepStrictEqual(backup.stageRestore("interests-backup-2099-01-01", store), { ok: false });
    assert.strictEqual(images.imageCount(store), 1, "live images untouched on a bad restore");

    // stageRestore's caller contract: flush the WAL first. It holds no db
    // handle by design, so an unflushed live store would have its most recent
    // writes (in WAL mode, on a new store, its whole schema) sitting in the
    // -wal sidecar where the safety snapshot's plain file copy cannot see them.
    db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const staged = backup.stageRestore(made.name, store);
    assert.strictEqual(staged.ok, true, "stageRestore must succeed: " + (staged.error || ""));
    assert.ok(fs.existsSync(path.join(staged.stageFolder, "interests.db")), "staged db present");
    assert.ok(fs.existsSync(path.join(staged.stageFolder, "images", "c1.jpg")), "staged image present");
    // Staged NEXT TO the live store, not inside the Dropbox-synced backups
    // folder — that is what makes the swap a same-volume rename.
    assert.strictEqual(path.dirname(staged.stageFolder), path.dirname(store), "staged on the store's own volume");

    // The live store must be completely untouched by stageRestore.
    const liveCounts = counts(db2);
    assert.strictEqual(liveCounts.cards, 2, "live store unchanged by stageRestore");
    assert.ok(fs.existsSync(path.join(store, "interests.db")), "live db still in place");
    assert.strictEqual(images.imageCount(store), 1, "live images still in place");

    // The pre-restore safety snapshot of the CURRENT live store is taken by
    // stageRestore itself, BEFORE anything can overwrite the live store, and
    // carries a name rotation can never age out.
    const snaps = fs.readdirSync(bdir).filter(function (n) { return n.indexOf("interests-backup-before-restore-") === 0; });
    assert.strictEqual(snaps.length, 1, "one pre-restore safety snapshot");
    assert.strictEqual(backup.pickBackupsToDelete([snaps[0]], 0).length, 0, "snapshot never rotated");
    const snapDb = openDb(path.join(bdir, snaps[0]));
    assert.strictEqual(counts(snapDb).cards, 2, "the safety snapshot captured the PRE-restore live state (both cards)");
    snapDb.close();

    db2.close();
    fs.rmSync(staged.stageFolder, { recursive: true, force: true });
  });
});

t("swapInStagedRestore closes db, swaps in the staged content, reopens db", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const made = backup.runBackup(db1, store);
    db1.close();

    const db2 = openDb(store);
    upsertCard(db2, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "idb:c2" });
    images.putImg(store, "c2", TINY_JPG);
    const ctx = { db: db2, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    const staged = backup.stageRestore(made.name, store, backup.storeWitness(db2, store));
    assert.strictEqual(staged.ok, true);
    const swapped = backup.swapInStagedRestore(staged, ctx);
    assert.strictEqual(swapped.ok, true, "swap must succeed: " + (swapped.error || ""));
    const restoredCounts = counts(ctx.db);
    assert.strictEqual(restoredCounts.cards, 1, "live store now reflects the restored (backed-up) content, not the pre-restore c2 card");
    // The live store ends up an EXACT copy of the backup, not a union with the
    // stale c2 image the replaced db no longer references.
    assert.strictEqual(images.imageCount(store), 1, "orphan image from the replaced db must not survive the swap");
    assert.ok(fs.existsSync(path.join(store, "images", "c1.jpg")), "the backup's image is in the live store");
    // Neither the staged scratch folder nor the displaced-old holding folder
    // may survive a SUCCESSFUL swap (each is a near-full image-library copy).
    assert.strictEqual(fs.existsSync(staged.stageFolder), false, "stage folder cleaned up on success");
    assert.strictEqual(fs.existsSync(staged.stageFolder + ".old"), false, "displaced-old folder cleaned up on success");
    ctx.db.close();
  });
});

t("restore ABORTS before overwriting the live store if stageRestore's safety snapshot fails", () => {
  withBackupDir(function () {
    // A valid backup folder to restore FROM (two cards + images), built in its
    // own store so the live store below can be a distinct, incomplete one.
    const bkStore = newStore();
    const bdb = openDb(bkStore);
    upsertCard(bdb, { id: "a", url: "https://x/a", platform: "fb", cat: "Saved", ts: 1, img: "idb:a" });
    upsertCard(bdb, { id: "b", url: "https://x/b", platform: "fb", cat: "Saved", ts: 2, img: "idb:b" });
    images.putImg(bkStore, "a", TINY_JPG);
    images.putImg(bkStore, "b", TINY_JPG);
    const made = backup.runBackup(bdb, bkStore);
    bdb.close();

    // Live store whose interests.db copy will fail: stageRestore must abort
    // BEFORE staging anything, and must never touch the live store.
    const store = newStore();
    const db2 = openDb(store);
    upsertCard(db2, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    fs.writeFileSync(path.join(store, "images", "sentinel.jpg"), "keep");

    const originalCopy = fs.copyFileSync;
    let copyCalls = 0;
    fs.copyFileSync = function (src, dst) {
      // Fail specifically on the pre-restore safety-snapshot copy (the FIRST
      // copyFileSync call inside stageRestore), not the later staging copy.
      copyCalls++;
      if (copyCalls === 1) throw new Error("simulated disk full");
      return originalCopy.apply(fs, arguments);
    };
    let staged;
    try {
      staged = backup.stageRestore(made.name, store);
    } finally {
      fs.copyFileSync = originalCopy;
    }
    assert.strictEqual(staged.ok, false);
    assert.match(staged.error, /safety snapshot failed/);
    assert.strictEqual(staged.stageFolder, undefined, "nothing may be staged when the safety snapshot fails");
    const liveCounts = counts(db2);
    assert.strictEqual(liveCounts.cards, 1, "live store untouched when the safety snapshot fails");
    assert.strictEqual(fs.existsSync(path.join(store, "images", "sentinel.jpg")), true, "live images untouched");
    assert.strictEqual(fs.existsSync(path.join(store, "images", "a.jpg")), false, "no backup images overlaid");
    // Scoped to THIS store's own basename: every newStore() lives directly in
    // os.tmpdir(), so an unscoped sweep also picks up other tests' (and earlier
    // runs') stage folders.
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(store)).filter(function (n) { return n.indexOf("." + path.basename(store) + ".restage-") === 0; }), [],
      "no stage folder left behind next to the live store");
    db2.close();
  });
});

t("swapInStagedRestore recovers ctx.db to a live handle when the swap step throws mid-restore", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const made = backup.runBackup(db1, store);
    db1.close();
    const db2 = openDb(store);
    // A card + image written AFTER the backup: the ORIGINAL live content,
    // which a failed swap must put back exactly as it was. The image matters —
    // an existsSync() on images/ alone cannot tell "rolled back with every
    // image" apart from "rolled back empty".
    upsertCard(db2, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "idb:c2" });
    images.putImg(store, "c2", TINY_JPG);
    db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const ctx = { db: db2, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };
    const staged = backup.stageRestore(made.name, store, backup.storeWitness(db2, store));
    assert.strictEqual(staged.ok, true);

    // Fail ONLY the "rename staged content into place" step: the source must be
    // INSIDE the stage folder. Deliberately NOT a match on the displaced-old
    // holding folder (stageFolder + ".old"), whose renames are the rollback —
    // breaking those too would let this test pass while the live store was left
    // gutted, which is exactly the failure it exists to catch.
    const originalRename = fs.renameSync;
    fs.renameSync = function (src, dst) {
      if (String(src).indexOf(staged.stageFolder + path.sep) === 0) {
        throw new Error("simulated rename failure");
      }
      return originalRename.apply(fs, arguments);
    };
    let swapped;
    try {
      swapped = backup.swapInStagedRestore(staged, ctx);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(swapped.ok, false);
    assert.ok(ctx.db && typeof ctx.db.prepare === "function", "ctx.db must be a live, usable handle after a failed swap, not left closed");
    // The whole point of staging: a failed swap leaves the ORIGINAL live store,
    // not a half-swapped one.
    assert.strictEqual(counts(ctx.db).cards, 2, "the ORIGINAL live content must be back in place after a failed swap");
    assert.ok(fs.existsSync(path.join(store, "images", "c2.jpg")),
      "the rollback must bring the original IMAGES back, not just recreate an empty images dir");
    ctx.db.close();
  });
});

t("stageRestore cleans up its own stage folder when the staging copy throws mid-way", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    for (let i = 0; i < 3; i++) {
      upsertCard(db1, { id: "sc" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:sc" + i });
      images.putImg(store, "sc" + i, TINY_JPG);
    }
    const made = backup.runBackup(db1, store);
    db1.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // Blow up DURING the staging image copy — after the stage folder exists.
    // An abandoned stage folder is a near-full copy of the user's library (db
    // + images) sitting next to the live store, and NOTHING sweeps it:
    // sweepOrphanedArtifacts only scans the backup root.
    // Hook the WRITE side, not the read: verifyBackupFolder re-hashes every
    // backup image through fs.readFileSync first, so a read-side hook fires
    // during verification instead — before any stage folder exists — and the
    // test would pass without ever exercising the cleanup it exists to check.
    const originalWriteFile = fs.writeFileSync;
    fs.writeFileSync = function (p) {
      if (String(p).indexOf(".restage-") >= 0 && String(p).indexOf("sc1.jpg") >= 0) throw new Error("EIO simulated mid-copy");
      return originalWriteFile.apply(fs, arguments);
    };
    let staged;
    try {
      staged = backup.stageRestore(made.name, store);
    } finally {
      fs.writeFileSync = originalWriteFile;
    }

    assert.strictEqual(staged.ok, false, "a mid-copy failure must not report success");
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(store)).filter(function (n) { return n.indexOf("." + path.basename(store) + ".restage-") === 0; }), [],
      "the half-written stage folder must not be left next to the live store");
    assert.strictEqual(counts(db1).cards, 3, "live store untouched");
    db1.close();
  });
});

/* F1 (data-safety review 2026-07-31, BLOCKING regression).
   Before restore was split into stage+swap the route was synchronous, so the
   single-threaded event loop made an interleaved write impossible. Staging now
   runs off-thread for as long as the image library takes, leaving the loop free
   to serve captures and auto-imports through ctx.db — and anything written in
   that window is in NEITHER the staged content NOR the pre-restore safety
   snapshot (both predate it). Applying the swap destroyed it outright, with no
   copy left anywhere.

   This test performs a REAL live-store write (card + image, the exact shape a
   capture writes) from inside the staging image copy, then runs the swap. The
   data assertions come FIRST deliberately: against pre-fix code they are what
   goes red, and they go red by reporting the interleaved card MISSING — proof
   this closes F1, not merely that an abort branch exists. */
t("swapInStagedRestore ABORTS when the live store took a write while staging (F1)", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 3; i++) {
      upsertCard(db, { id: "rc" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:rc" + i });
      images.putImg(store, "rc" + i, TINY_JPG);
    }
    const made = backup.runBackup(db, store);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const ctx = { db: db, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    // Captured exactly where /api/restore captures it: from the LIVE handle,
    // after the checkpoint, immediately before staging starts.
    const witness = backup.storeWitness(ctx.db, store);

    // Interleave the write mid-staging, hooked on the WRITE side of the staging
    // image copy (a read-side hook fires during backup verification instead,
    // before staging has even begun — see the stage-cleanup test above).
    let injected = false;
    const originalWriteFile = fs.writeFileSync;
    fs.writeFileSync = function (p) {
      if (!injected && String(p).indexOf(".restage-") >= 0 && String(p).indexOf("rc1.jpg") >= 0) {
        injected = true;   // set BEFORE the nested writes so putImg cannot re-enter
        upsertCard(ctx.db, { id: "during", url: "https://x/during", platform: "fb", cat: "Saved", ts: 9, img: "idb:during" });
        images.putImg(store, "during", TINY_JPG);
      }
      return originalWriteFile.apply(fs, arguments);
    };
    let staged;
    try { staged = backup.stageRestore(made.name, store, witness); }
    finally { fs.writeFileSync = originalWriteFile; }

    assert.strictEqual(injected, true, "the mid-staging write must actually have fired, or this test proves nothing");
    assert.strictEqual(staged.ok, true, "staging itself still succeeds — refusing is the swap's job: " + (staged.error || ""));
    const snapFolder = staged.snapshotFolder;
    assert.strictEqual(path.dirname(snapFolder), bdir,
      "the snapshot the abort deletes must be inside the SANDBOXED backup root — this test deletes in the backups folder");
    assert.strictEqual(fs.existsSync(snapFolder), true, "sanity: the safety snapshot exists before the abort");

    const swapped = backup.swapInStagedRestore(staged, ctx);

    // ---- the data, first ----
    assert.ok(ctx.db && typeof ctx.db.prepare === "function", "ctx.db must still be a live, usable handle after an abort");
    assert.ok(ctx.db.prepare("SELECT 1 FROM cards WHERE id=?").get("during"),
      "the card written DURING staging must still be in the live store");
    assert.strictEqual(fs.existsSync(path.join(store, "images", "during.jpg")), true,
      "the image written DURING staging must still be in the live store");
    assert.strictEqual(counts(ctx.db).cards, 4, "the live store must be exactly as it was — nothing restored, nothing discarded");
    assert.strictEqual(images.imageCount(store), 4, "live images untouched");

    // ---- then the outcome + cleanup ----
    assert.strictEqual(swapped.ok, false, "the swap MUST abort rather than discard the interleaved write");
    assert.match(swapped.error, /would discard/, "and must tell the caller why, and to retry: " + swapped.error);
    assert.strictEqual(fs.existsSync(staged.stageFolder), false, "the stage folder must be cleaned up by the abort");
    assert.strictEqual(fs.existsSync(staged.stageFolder + ".old"), false, "no displaced-old folder — the swap never started");
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(store)).filter(function (n) { return n.indexOf("." + path.basename(store) + ".restage-") === 0; }), [],
      "no stage folder left next to the live store");
    assert.strictEqual(fs.existsSync(snapFolder), false,
      "the aborted attempt's safety snapshot must go too — the live store was never modified, so it protects nothing and would burn one of the two slots rotation keeps");
    ctx.db.close();
  });
});

/* F1, second shape (data-safety review round 2, 2026-07-31).
   The first witness was {rev, cards, saved, images}, and `rev`
   (ia_mutation_revision) only moves for card/saved/tombstone writes and the two
   SETTINGS kv keys — see core/db.js setKV. So a write to ANY OTHER kv row was
   invisible to it, and two of those rows are durable, non-self-healing user
   data: the extension capture mailbox (ia_capture_queue) and the taste signals
   (ia_hidden and friends). Both reproduced the exact F1 loss shape — the swap
   returned ok:true and the write was gone from the live store AND absent from
   the pre-restore safety snapshot.

   This drives the reviewer's exact pair: a real captureQueue.enqueue() plus a
   real ia_hidden write, fired from inside the staging image copy on the WRITE
   side. It asserts up front that every pre-existing witness dimension is
   UNCHANGED by those writes, so the test is provably exercising the gap and not
   riding on the rev/counts check that was already there. The data assertions
   come first: against a witness without the kv dimension they go red by
   reporting the capture and the taste signal MISSING. */
t("swapInStagedRestore ABORTS when a capture-queue / taste-signal kv row was written while staging (F1, kv shape)", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 3; i++) {
      upsertCard(db, { id: "kv" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:kv" + i });
      images.putImg(store, "kv" + i, TINY_JPG);
    }
    // Pre-existing taste history, so the interleaved write CHANGES a row rather
    // than creating one (the harder case for a value compare to notice).
    setKV(db, "ia_hidden", JSON.stringify([{ title: "before", ts: 1 }]));
    const made = backup.runBackup(db, store);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const ctx = { db: db, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    const witness = backup.storeWitness(ctx.db, store);

    let injected = false;
    const originalWriteFile = fs.writeFileSync;
    fs.writeFileSync = function (p) {
      if (!injected && String(p).indexOf(".restage-") >= 0 && String(p).indexOf("kv1.jpg") >= 0) {
        injected = true;
        // The extension capture mailbox: an undrained capture at this instant
        // exists nowhere else on disk.
        captureQueue.enqueue(ctx.db, { url: "https://x/pending-capture", title: "arrived mid-restore" });
        // A taste signal, exactly as web/index.html's persistAll() writes it.
        setKV(ctx.db, "ia_hidden", JSON.stringify([{ title: "before", ts: 1 }, { title: "during", ts: 2 }]));
      }
      return originalWriteFile.apply(fs, arguments);
    };
    let staged;
    try { staged = backup.stageRestore(made.name, store, witness); }
    finally { fs.writeFileSync = originalWriteFile; }

    assert.strictEqual(injected, true, "the mid-staging kv write must actually have fired, or this test proves nothing");
    assert.strictEqual(staged.ok, true, "staging itself still succeeds — refusing is the swap's job: " + (staged.error || ""));

    // The gap, stated as an assertion: NONE of the original witness dimensions
    // moved. If this ever fails, the test has stopped covering the kv shape and
    // is passing on the rev/counts check instead.
    const after = backup.storeWitness(ctx.db, store);
    assert.strictEqual(after.rev, witness.rev, "ia_mutation_revision must NOT move for these writes — that is the gap under test");
    assert.strictEqual(after.cards, witness.cards, "no card was written");
    assert.strictEqual(after.saved, witness.saved, "no saved item was written");
    assert.strictEqual(after.images, witness.images, "no image file was written");

    const snapFolder = staged.snapshotFolder;
    assert.strictEqual(path.dirname(snapFolder), bdir,
      "the snapshot the abort deletes must be inside the SANDBOXED backup root — this test deletes in the backups folder");

    const swapped = backup.swapInStagedRestore(staged, ctx);

    // ---- the data, first ----
    assert.ok(ctx.db && typeof ctx.db.prepare === "function", "ctx.db must still be a live, usable handle after an abort");
    const queued = captureQueue.read(ctx.db);
    assert.strictEqual(queued.length, 1, "the capture queued DURING staging must still be in the live store");
    assert.strictEqual(queued[0].capture.url, "https://x/pending-capture", "and it must be that capture, unaltered");
    const hidden = JSON.parse(getKV(ctx.db, "ia_hidden") || "[]");
    assert.strictEqual(hidden.length, 2, "the taste signal written DURING staging must still be in the live store");
    assert.strictEqual(hidden[1].title, "during", "and it must be the interleaved entry");

    // ---- then the outcome + cleanup ----
    assert.strictEqual(swapped.ok, false, "the swap MUST abort rather than discard the interleaved kv writes");
    assert.match(swapped.error, /would discard/, "and must tell the caller why, and to retry: " + swapped.error);
    assert.strictEqual(fs.existsSync(staged.stageFolder), false, "the stage folder must be cleaned up by the abort");
    assert.strictEqual(fs.existsSync(staged.stageFolder + ".old"), false, "no displaced-old folder — the swap never started");
    assert.strictEqual(fs.existsSync(snapFolder), false, "the aborted attempt's safety snapshot must go too");
    ctx.db.close();
  });
});

/* The other half of the same property: the witness must not fire on kv rows it
   does NOT watch, or a restore could never succeed while the app is open.
   ia_health restamps a fresh ts on every health check, and the sync/auto-import
   status keys churn on their own timers — a blanket "did any kv row change"
   check would abort here. */
t("swapInStagedRestore still SUCCEEDS when only operational kv rows churned during staging", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 2; i++) {
      upsertCard(db, { id: "op" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:op" + i });
      images.putImg(store, "op" + i, TINY_JPG);
    }
    const made = backup.runBackup(db, store);
    upsertCard(db, { id: "extra", url: "https://x/extra", platform: "fb", cat: "Saved", ts: 9 });   // so the restore is a real change
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const ctx = { db: db, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    const witness = backup.storeWitness(ctx.db, store);

    let injected = false;
    const originalWriteFile = fs.writeFileSync;
    fs.writeFileSync = function (p) {
      if (!injected && String(p).indexOf(".restage-") >= 0 && String(p).indexOf("op1.jpg") >= 0) {
        injected = true;
        setKV(ctx.db, "ia_health", JSON.stringify({ folder: "connected", ts: Date.now() }));
        setKV(ctx.db, "ia_sync_changed_at", String(Date.now()));
        setKV(ctx.db, "ia_batch_progress", JSON.stringify({ done: 7 }));
        setKV(ctx.db, "ia_autoimport_last_fb", String(Date.now()));
      }
      return originalWriteFile.apply(fs, arguments);
    };
    let staged;
    try { staged = backup.stageRestore(made.name, store, witness); }
    finally { fs.writeFileSync = originalWriteFile; }

    assert.strictEqual(injected, true, "the operational kv churn must actually have fired, or this test proves nothing");
    const swapped = backup.swapInStagedRestore(staged, ctx);
    assert.strictEqual(swapped.ok, true, "operational churn must NOT abort a restore: " + (swapped.error || ""));
    assert.strictEqual(counts(ctx.db).cards, 2, "and the restore must actually have applied");
    ctx.db.close();
  });
});

/* The mailbox's own liveness half. captureQueue.claim() — which web/index.html
   runs every 3 seconds — assigns a FRESH random leaseId to every entry that is
   unleased or whose lease expired, so the RAW kv row changes on an idle poll
   whenever a capture is merely PENDING. Digesting that row by value would abort
   every restore started with a non-empty mailbox, and a capture the UI claims
   but never acks would re-lease every 5 minutes and abort restores forever.
   Such a capture predates staging and IS in the pre-restore safety snapshot; it
   is content the user asked the restore to replace, not the arrived-during-
   staging write F1 is about. Hence the payload-identity digest. */
t("swapInStagedRestore still SUCCEEDS when the drain poll merely re-leases a capture pending since before staging", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 2; i++) {
      upsertCard(db, { id: "ls" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:ls" + i });
      images.putImg(store, "ls" + i, TINY_JPG);
    }
    const made = backup.runBackup(db, store);
    upsertCard(db, { id: "extra", url: "https://x/extra", platform: "fb", cat: "Saved", ts: 9 });   // so the restore is a real change
    // Pending BEFORE the witness is captured — this is the case that must not abort.
    captureQueue.enqueue(db, { url: "https://x/pending-before", title: "waiting to be drained" });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const ctx = { db: db, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    const witness = backup.storeWitness(ctx.db, store);
    const rawBefore = getKV(ctx.db, "ia_capture_queue");

    let injected = false, rawAfter = null;
    const originalWriteFile = fs.writeFileSync;
    fs.writeFileSync = function (p) {
      if (!injected && String(p).indexOf(".restage-") >= 0 && String(p).indexOf("ls1.jpg") >= 0) {
        injected = true;
        captureQueue.claim(ctx.db);   // exactly what the 3s drainCaptures poll does
        rawAfter = getKV(ctx.db, "ia_capture_queue");
      }
      return originalWriteFile.apply(fs, arguments);
    };
    let staged;
    try { staged = backup.stageRestore(made.name, store, witness); }
    finally { fs.writeFileSync = originalWriteFile; }

    assert.strictEqual(injected, true, "the mid-staging claim must actually have fired, or this test proves nothing");
    assert.notStrictEqual(rawAfter, rawBefore,
      "the claim must actually have CHANGED the raw kv row (a fresh leaseId) — otherwise a raw-value witness would pass this test vacuously");

    const swapped = backup.swapInStagedRestore(staged, ctx);
    assert.strictEqual(swapped.ok, true, "a lease renewal carries no new data and must NOT abort the restore: " + (swapped.error || ""));
    assert.strictEqual(counts(ctx.db).cards, 2, "and the restore must actually have applied");
    ctx.db.close();
  });
});

t("swapInStagedRestore fails closed when handed no write-witness", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "nw1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const ctx = { db: db, storeDir: store, reopen: function () { return openDb(store); } };
    // The legacy call shape (a bare stage-folder string) must be REFUSED, not
    // silently swapped in unverified.
    const r = backup.swapInStagedRestore("/tmp/some-stage-folder", ctx);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /write-witness/);
    assert.strictEqual(counts(ctx.db).cards, 1, "live store untouched by a refused swap");
    assert.ok(ctx.db && typeof ctx.db.prepare === "function", "ctx.db must be left live");
    ctx.db.close();
  });
});

/* ---- F-1: orphaned stage folders next to the LIVE store (security review 2026-07-31)
   stageRestore stages into ".<store>.restage-<pid>-<ts>" AS A SIBLING of the
   live store, and the swap parks the displaced live content in that name +
   ".old". Each holds a full interests.db — which carries ia_settings, i.e. the
   user's provider API key — plus most of the image library, OUTSIDE the backup
   root where sweepOrphanedArtifacts never looks. stageRestore's own cleanup is
   in-process only, so three paths leak forever: a staging worker KILLED
   mid-copy (no JS catch runs in a dead thread), the swap's rollback path, and
   its reopen-failure path. The reviewer's PoC killed a worker mid-image-copy
   and read the API key back out of the orphan. Simulating the exact on-disk
   artifact pins the same behaviour without a flaky real kill. */
function plantOrphanStage(store, suffix, ageMs) {
  const folder = path.join(path.dirname(store), "." + path.basename(store) + ".restage-9999-1" + (suffix || ""));
  fs.mkdirSync(path.join(folder, "images"), { recursive: true });
  // The db an orphan actually contains: a real store db holding a settings row
  // with an API key, exactly what the reviewer read back off disk.
  const odb = openDb(folder);
  setKV(odb, "ia_settings", JSON.stringify({ apiKey: "sk-ant-LEAKED-SECRET" }));
  odb.close();
  fs.writeFileSync(path.join(folder, "images", "x.jpg"), "img");
  if (ageMs) backdateStage(folder, ageMs);
  return folder;
}
// Backdate images/ too — the sweep takes the NEWEST of the two so an in-flight
// copy (which only advances images/) is never swept. Must be the LAST thing
// done to the folder: even opening its db writes -wal/-shm and refreshes it.
function backdateStage(folder, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(folder, "images"), when, when);
  fs.utimesSync(folder, when, when);
}
const TWO_HOURS = 2 * 60 * 60 * 1000;   // > STALE_STAGING_MS (1h) in core/backup.js

t("F-1: an orphan stage folder left by a DEAD staging worker is swept (and its API key with it)", () => {
  const store = newStore();
  const orphan = plantOrphanStage(store, "", 0);
  // Precondition: the leak is real — the key is readable straight off disk.
  const leaked = openDb(orphan);
  assert.match(String(getKV(leaked, "ia_settings")), /sk-ant-LEAKED-SECRET/, "precondition: the orphan holds the provider API key");
  leaked.close();
  backdateStage(orphan, TWO_HOURS);   // AFTER the read above, which refreshes the folder's mtime

  assert.strictEqual(backup.sweepOrphanedStageFolders(store), 1, "the stale orphan must be swept");
  assert.strictEqual(fs.existsSync(orphan), false, "the orphan folder (db + images) must be gone");
  fs.rmSync(store, { recursive: true, force: true });
});

t("F-1: the swap's displaced-old ('.restage-*.old') holding folder is swept too", () => {
  // The rollback and reopen-failure paths deliberately KEEP their folders so a
  // partial rollback stays recoverable by hand. That is right at the moment it
  // happens; the gap is that nothing swept them LATER. A prefix match (not an
  // anchored .restage-<token>$ regex) is what makes the ".old" sibling visible.
  const store = newStore();
  const orphan = plantOrphanStage(store, ".old", TWO_HOURS);
  assert.strictEqual(backup.sweepOrphanedStageFolders(store), 1, "the displaced-old holding folder must be swept once stale");
  assert.strictEqual(fs.existsSync(orphan), false);
  fs.rmSync(store, { recursive: true, force: true });
});

t("F-1: an IN-FLIGHT restore's own stage folder is NEVER swept (stale-mtime rule)", () => {
  const store = newStore();
  const fresh = plantOrphanStage(store, "", 0);             // just created — a run still in flight
  assert.strictEqual(backup.sweepOrphanedStageFolders(store), 0, "a fresh stage folder must survive");
  assert.strictEqual(fs.existsSync(fresh), true, "an in-flight restore's staged content must not be deleted under it");

  // And the load-bearing half of that rule: during a long image copy only
  // images/ keeps being touched, so the TOP folder's mtime alone would look
  // stale. The sweep takes the newest of the two.
  const old = new Date(Date.now() - TWO_HOURS);
  fs.utimesSync(fresh, old, old);
  assert.strictEqual(backup.sweepOrphanedStageFolders(store), 0,
    "a long in-flight image copy (stale top folder, live images/) must not be swept");
  assert.strictEqual(fs.existsSync(fresh), true);
  fs.rmSync(store, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
});

t("F-1: the sweep never touches a folder belonging to a DIFFERENT store in the same parent", () => {
  // Every newStore() lands directly in os.tmpdir(), so a loosely scoped sweep
  // would delete other stores' (and other tests') stage folders. Same
  // never-delete-near-the-live-store-on-a-loose-match discipline as the
  // 2026-07-19 near-miss.
  const store = newStore();
  const otherStore = newStore();
  const otherOrphan = plantOrphanStage(otherStore, "", TWO_HOURS);
  const unrelated = path.join(path.dirname(store), "." + path.basename(store) + ".NOTrestage-9999-1");
  fs.mkdirSync(unrelated, { recursive: true });
  const oldT = new Date(Date.now() - TWO_HOURS);
  fs.utimesSync(unrelated, oldT, oldT);

  assert.strictEqual(backup.sweepOrphanedStageFolders(store), 0, "nothing of THIS store's is orphaned");
  assert.strictEqual(fs.existsSync(otherOrphan), true, "another store's stage folder must survive this store's sweep");
  assert.strictEqual(fs.existsSync(unrelated), true, "a sibling that merely starts with the store name must not match");
  fs.rmSync(store, { recursive: true, force: true });
  fs.rmSync(otherStore, { recursive: true, force: true });
  fs.rmSync(otherOrphan, { recursive: true, force: true });
  fs.rmSync(unrelated, { recursive: true, force: true });
});

t("F-1: stageRestore clears a stale orphan before staging a new restore", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "o1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:o1" });
    images.putImg(store, "o1", TINY_JPG);
    const made = backup.runBackup(db, store);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const orphan = plantOrphanStage(store, "", TWO_HOURS);
    const staged = backup.stageRestore(made.name, store, backup.storeWitness(db, store));
    assert.strictEqual(staged.ok, true, "the restore must still stage normally: " + (staged.error || ""));
    assert.strictEqual(fs.existsSync(orphan), false, "the prior run's orphan must be cleared before a new stage begins");
    // The NEW stage folder is of course still there — it is in flight.
    assert.strictEqual(fs.existsSync(staged.stageFolder), true, "this run's own stage folder must survive its own pre-stage sweep");
    fs.rmSync(staged.stageFolder, { recursive: true, force: true });
    db.close();
  });
});

t("F-1: runBackup sweeps stale stage folders next to the live store", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "rb1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:rb1" });
    images.putImg(store, "rb1", TINY_JPG);
    const orphan = plantOrphanStage(store, "", TWO_HOURS);
    backup.runBackup(db, store);
    assert.strictEqual(fs.existsSync(orphan), false, "the recurring backup pass must collect orphans next to the live store");
    db.close();
  });
});

t("F-1: main.js sweeps orphaned stage folders at startup, off the launch path", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(src, /sweepOrphanedStageFolders\(ctx\.storeDir\)/, "main.js must sweep at boot");
  // A recursive rm of an image-library-sized folder must not run on the boot
  // tick — that is the launch-freeze class this whole branch exists to remove.
  const idxWindow = src.indexOf("createWindow(port);");
  const idxSweep = src.indexOf("sweepOrphanedStageFolders(ctx.storeDir)");
  assert.ok(idxWindow > 0 && idxSweep > idxWindow, "the boot sweep must run AFTER createWindow, not before it");
  assert.match(src.slice(idxWindow, idxSweep), /setTimeout\(/, "the boot sweep must be deferred off the boot tick");
});

/* ---- F-2: the stage folder and the displaced-old folder must fail closed on a
   pre-existing path. Both live at a GUESSABLE location (pid + "-" + Date.now()),
   and mkdirSync({recursive:true}) silently ADOPTS whatever is already there —
   a planted directory, or an NTFS junction pointing somewhere else entirely. */
t("F-2: stageRestore fails closed if something already occupies its stage path", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "f2a", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:f2a" });
    images.putImg(store, "f2a", TINY_JPG);
    const made = backup.runBackup(db, store);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // Occupy the EXACT path stageRestore is about to use. The token is
    // pid + "-" + Date.now(), both knowable, so this is the attacker's shot.
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = function () { return frozen; };
    const planted = path.join(path.dirname(store), "." + path.basename(store) + ".restage-" + process.pid + "-" + frozen);
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "planted.txt"), "attacker content");
    let staged;
    try { staged = backup.stageRestore(made.name, store, backup.storeWitness(db, store)); }
    finally { Date.now = realNow; }

    assert.strictEqual(staged.ok, false, "staging into an already-occupied path must be refused, not adopted");
    assert.match(String(staged.error), /EEXIST/i, "it must fail on EEXIST specifically: " + staged.error);
    assert.strictEqual(fs.existsSync(path.join(planted, "planted.txt")), true,
      "the refused folder is not ours — the failure path must not delete it either");
    assert.strictEqual(fs.existsSync(path.join(planted, "interests.db")), false, "nothing may have been staged into it");
    assert.strictEqual(counts(db).cards, 1, "live store untouched");
    fs.rmSync(planted, { recursive: true, force: true });
    db.close();
  });
});

t("F-2: the swap fails closed (and rolls back) if something already occupies the displaced-old path", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "f2b", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:f2b" });
    images.putImg(store, "f2b", TINY_JPG);
    const made = backup.runBackup(db1, store);
    db1.close();

    const db2 = openDb(store);
    upsertCard(db2, { id: "f2c", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "idb:f2c" });
    images.putImg(store, "f2c", TINY_JPG);
    db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const ctx = { db: db2, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    const staged = backup.stageRestore(made.name, store, backup.storeWitness(db2, store));
    assert.strictEqual(staged.ok, true, "sanity: staging must succeed");
    // Occupy stageFolder + ".old" — the folder the live db+images get renamed INTO.
    const oldAside = staged.stageFolder + ".old";
    fs.mkdirSync(oldAside, { recursive: true });
    fs.writeFileSync(path.join(oldAside, "planted.txt"), "attacker content");

    const r = backup.swapInStagedRestore(staged, ctx);
    assert.strictEqual(r.ok, false, "the swap must refuse rather than rename the live store into an adopted folder");
    assert.strictEqual(fs.existsSync(path.join(oldAside, "interests.db")), false,
      "the live db must NOT have been renamed into the pre-existing folder");
    assert.strictEqual(counts(ctx.db).cards, 2, "the live store must be exactly as it was, on a live handle");
    assert.ok(fs.existsSync(path.join(store, "images", "f2c.jpg")), "live images still in place");
    ctx.db.close();
    fs.rmSync(oldAside, { recursive: true, force: true });
    fs.rmSync(staged.stageFolder, { recursive: true, force: true });
  });
});

/* ---- F-3: the swap must confirm it is applying staged content to the store it
   was staged FROM. /api/restore and /api/store-location/move share the worker's
   exclusive() queue, but only the WORKER halves serialize — each route's
   main-thread continuation runs on its own, so a move that repoints
   ctx.storeDir between a restore's staging and its swap would otherwise have
   the swap apply content staged for the OLD directory onto the NEW one. */
t("F-3: swapInStagedRestore refuses when the store was repointed after staging", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "f3a", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:f3a" });
    images.putImg(store, "f3a", TINY_JPG);
    const made = backup.runBackup(db1, store);
    db1.close();

    const db2 = openDb(store);
    upsertCard(db2, { id: "f3b", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2 });
    db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const staged = backup.stageRestore(made.name, store, backup.storeWitness(db2, store));
    assert.strictEqual(staged.ok, true, "sanity: staging must succeed");
    assert.strictEqual(staged.storeDir, store, "the staged result must carry the store it was staged from");
    db2.close();

    // A store move landed in between: ctx now points somewhere else entirely,
    // with its own content. Applying the OTHER directory's staged content here
    // would silently replace this store's library.
    const moved = newStore();
    const mdb = openDb(moved);
    upsertCard(mdb, { id: "moved1", url: "https://x/m", platform: "fb", cat: "Saved", ts: 3 });
    const ctx = { db: mdb, storeDir: moved, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    const r = backup.swapInStagedRestore(staged, ctx);
    assert.strictEqual(r.ok, false, "the swap must refuse staged content prepared for a different data folder");
    assert.match(r.error, /different data folder/);
    assert.strictEqual(counts(ctx.db).cards, 1, "the repointed store must be untouched");
    assert.ok(ctx.db && typeof ctx.db.prepare === "function", "ctx.db must be left live");
    assert.strictEqual(fs.existsSync(staged.stageFolder), true,
      "and it must not delete a stage folder belonging to a different store");
    ctx.db.close();
    fs.rmSync(staged.stageFolder, { recursive: true, force: true });
  });
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
