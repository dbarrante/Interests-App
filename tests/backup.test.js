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
const { openDb, upsertCard, upsertSaved, deleteCard, counts, setKV } = require("../core/db.js");
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
    assert.throws(() => backup.updateMirror(db, store), /image count collapsed/);
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
    assert.throws(() => backup.updateMirror(db, store), /image count collapsed/);
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

/* ---- third data-safety review (2026-07-26) ----
   The collapse guard's card-count escape hatch read its baseline ONLY from
   meta.json, which updateMirror deletes before mutating. With no baseline the
   fallback made the comparison `imageRatio > imageRatio + 0.25` -- false for
   every input -- so the guard was silently OFF for exactly the torn state it
   most needed to cover. Reproduced end-to-end: the mirror's images were wiped,
   updateMirror returned SUCCESS, and the result still passed verifyBackup. */
t("the collapse guard still fires when the mirror was left torn (no meta.json)", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "tr" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:tr" + i });
      images.putImg(store, "tr" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Exactly the state left by a run that threw after invalidating (WAL
    // checkpoint / db copy / rename retry exhaustion / verification), which the
    // pre-merge path now attempts ~480x a day rather than once.
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "meta.json"), { force: true });
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "meta.updating.json"), { force: true });
    for (let i = 0; i < 100; i++) fs.rmSync(path.join(store, "images", "tr" + i + ".jpg"), { force: true });

    assert.throws(() => backup.updateMirror(db, store), /image count collapsed/,
      "a torn mirror must not lose its collapse protection -- that is the moment it matters most");
    assert.strictEqual(
      fs.readdirSync(path.join(bdir, backup.MIRROR_NAME, "images")).filter(n => n.endsWith(".jpg")).length, 100,
      "the mirror's images must still be there");
    db.close();
  });
});
t("the collapse guard fails CLOSED when no card baseline exists anywhere", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 100; i++) {
      upsertCard(db, { id: "nb" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:nb" + i });
      images.putImg(store, "nb" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);

    // Strip EVERY source of a card baseline: the mirror's marker, its set-aside
    // sidecar, and the out-of-store lastcounts.json witness. The images on disk
    // still give prevImageCount >= 100, so the guard is armed but has nothing
    // to judge proportionality against. It must refuse rather than wave the
    // collapse through -- the pre-fix fallback resolved to `imageRatio`, making
    // the test `imageRatio > imageRatio + 0.25`, false for EVERY input, which
    // silently disabled the guard completely.
    const root = path.join(bdir, backup.MIRROR_NAME);
    fs.rmSync(path.join(root, "meta.json"), { force: true });
    fs.rmSync(path.join(root, "meta.updating.json"), { force: true });
    fs.rmSync(path.join(process.env.APPDATA, "Interests App", "lastcounts.json"), { force: true });
    for (let i = 0; i < 100; i++) fs.rmSync(path.join(store, "images", "nb" + i + ".jpg"), { force: true });

    assert.throws(() => backup.updateMirror(db, store), /image count collapsed/,
      "with no baseline to judge against, a >50% collapse must fail closed");
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
      /collapsed/, "the failure must still propagate — sync's fail-closed contract");
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
    assert.throws(() => backup.runBackup(db, store), /collapsed/,
      "a dated snapshot of a collapsed store verifies, unlocks rotation, and deletes a good backup");
    db.close();
  });
});
t("a TOTAL collapse is refused — the ratios alone cannot see it", () => {
  withBackupDir(function (bdir) {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 150; i++) {
      upsertCard(db, { id: "tc" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:tc" + i });
      images.putImg(store, "tc" + i, TINY_JPG);
    }
    const good = backup.runBackup(db, store);
    assert.strictEqual(good.counts.images, 150);

    // Store emptied in place (poisoned pointer, Dropbox rewind, selective
    // sync). BOTH ratios are 0, and `0 > 0 + 0.25` is false — so the
    // proportional arm waves through the single most destructive case while
    // correctly refusing milder partial ones. Left unguarded, the resulting
    // 0-image snapshot takes today's date-stamped name, DISPLACES the good
    // same-day backup, verifies (0 files matches 0 expected), and then unlocks
    // rotate() to age out older good ones.
    for (let i = 0; i < 150; i++) deleteCard(db, "tc" + i, Date.now());
    for (let i = 0; i < 150; i++) fs.rmSync(path.join(store, "images", "tc" + i + ".jpg"), { force: true });

    assert.throws(() => backup.runBackup(db, store), /card count collapsed/);
    const meta = JSON.parse(fs.readFileSync(path.join(bdir, good.name, "meta.json"), "utf8"));
    assert.strictEqual(meta._counts.images, 150, "the good same-day backup must be untouched");
    assert.strictEqual(backup.verifyBackup(good.name, meta._counts), true);
    db.close();
  });
});
t("a missing images dir is refused even with no image baseline (lastcounts carries cards only)", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 150; i++) upsertCard(db, { id: "nb" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i });
    backup.runBackup(db, store);           // seeds lastcounts.json (cards only, images 0)
    fs.rmSync(path.join(store, "images"), { recursive: true, force: true });

    // storeSanityBaseline's lastcounts branch has no image witness, so keying
    // the missing-dir arm purely off prevImages let a vanished images dir under
    // a large live card count sail straight through.
    assert.throws(() => backup.runBackup(db, store), /images dir is missing/);
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

    const ctx = { db: db, storeDir: store, reopen: function () { return openDb(store); } };
    const r = backup.restore(backup.MIRROR_NAME, ctx);
    assert.strictEqual(r.ok, false, "a corrupted mirror image must not be restored into the live store");
    assert.ok(/does not match the mirror's own manifest hash/.test(r.error || ""), "and must say why: " + r.error);
    try { ctx.db.close(); } catch (e) {}
  });
});
/* ---- the escape hatch (data-safety review 2026-07-26, BLOCKING) ----
   Five consecutive rounds of collapse-guard fixes each assumed an override
   existed; none of them ever executed it, and it turned out to be inert. The
   guards read the accepted baseline ONLY when their derived baselines were
   absent, and updateMirror always supplies a derived one — so accepting did
   nothing while the UI toasted "backups will resume". These tests execute the
   real code path and assert the next call SUCCEEDS. */
t("accepting the baseline actually un-wedges the mirror AND runBackup", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 200; i++) {
      upsertCard(db, { id: "eh" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:eh" + i });
      images.putImg(store, "eh" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    backup.runBackup(db, store);

    // "Clear imported items" — a labeled button, not a hypothetical.
    for (let i = 0; i < 195; i++) {
      deleteCard(db, "eh" + i, Date.now());
      fs.rmSync(path.join(store, "images", "eh" + i + ".jpg"), { force: true });
    }
    assert.throws(() => backup.updateMirror(db, store), /collapsed/, "sanity: the guard fires");

    config.recordAcceptedBaseline({ cards: 5, saved: 0, images: 5 });

    // BOTH paths must clear. The mirror's own marker still says 200, and
    // storeSanityBaseline also falls through to the dated snapshot's meta —
    // an accepted baseline has to beat every derived source, not just fill in
    // when they are missing, or the refusal latches forever.
    const m = backup.updateMirror(db, store);
    assert.strictEqual(m.counts.imported, 5, "the mirror must update after an accept");
    const r = backup.runBackup(db, store);
    assert.strictEqual(r.counts.imported, 5, "dated backups must resume after an accept");
    db.close();
  });
});
t("accepting a baseline does not re-arm the image arm on a proportional drop", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 200; i++) {
      upsertCard(db, { id: "ra" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:ra" + i });
      images.putImg(store, "ra" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    for (let i = 0; i < 190; i++) {
      deleteCard(db, "ra" + i, Date.now());
      fs.rmSync(path.join(store, "images", "ra" + i + ".jpg"), { force: true });
    }
    config.recordAcceptedBaseline({ cards: 10, saved: 0, images: 10 });

    // Pinning prevCards to the accepted (current) value would force
    // cardRatio to 1.0, which exceeds imageRatio + 0.25 for any image drop --
    // so the IMAGE arm would then fire on a store whose cards and images fell
    // together, the exact case the proportional arm exists to permit. The
    // accepted baseline must only ever RELAX the test.
    const m = backup.updateMirror(db, store);
    assert.strictEqual(m.counts.images, 10);
    db.close();
  });
});
t("the guards stay armed after an accept — a NEW collapse is still refused", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 400; i++) {
      upsertCard(db, { id: "na" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:na" + i });
      images.putImg(store, "na" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    for (let i = 0; i < 200; i++) {
      deleteCard(db, "na" + i, Date.now());
      fs.rmSync(path.join(store, "images", "na" + i + ".jpg"), { force: true });
    }
    config.recordAcceptedBaseline({ cards: 200, saved: 0, images: 200 });
    assert.strictEqual(backup.updateMirror(db, store).counts.imported, 200, "the accepted drop goes through");

    // Accepting must not disarm the guards permanently — it re-baselines them
    // to the new, smaller size so a genuine future collapse is still caught.
    for (let i = 200; i < 400; i++) {
      deleteCard(db, "na" + i, Date.now());
      fs.rmSync(path.join(store, "images", "na" + i + ".jpg"), { force: true });
    }
    assert.throws(() => backup.updateMirror(db, store), /collapsed/,
      "a NEW collapse below the accepted baseline must still be refused");
    db.close();
  });
});
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
t("a routine backup does not overwrite the collapse witness with a collapsed count", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    for (let i = 0; i < 200; i++) {
      upsertCard(db, { id: "lw" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "idb:lw" + i });
      images.putImg(store, "lw" + i, TINY_JPG);
    }
    backup.updateMirror(db, store);
    assert.strictEqual(config.getLastCounts().cards, 200, "sanity: the witness starts healthy");

    // Cards gutted. The proportional (image-ratio) arm cannot see this, so the
    // cards arm must catch it — a total collapse leaves BOTH ratios at 0, and
    // `0 > 0 + 0.25` is false, which is how the single most destructive case
    // used to sail through the guard that correctly refused milder ones.
    for (let i = 0; i < 197; i++) deleteCard(db, "lw" + i, Date.now());
    assert.throws(() => backup.updateMirror(db, store), /card count collapsed/,
      "a gutted store must not overwrite the mirror");
    // ...and the witness must survive it either way: lastcounts.json is the only
    // thing config.evaluateStoreSafety has to detect a swapped/gutted store at
    // boot, so a routine backup must never erase the evidence of the collapse.
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
    const ok = backup.restore(backup.MIRROR_NAME, ctx);
    assert.strictEqual(ok.ok, true, "sanity: the mirror restore itself must succeed");
    assert.deepStrictEqual(
      fs.readdirSync(bdir).filter(n => /^interests-mirror-freeze-/.test(n)), [],
      "the freeze copy is a near-full image-library duplicate in the Dropbox-synced folder — it must not survive a successful restore");

    // And on a failure path: a torn mirror is refused before any copy is made.
    fs.rmSync(path.join(bdir, backup.MIRROR_NAME, "meta.json"), { force: true });
    const bad = backup.restore(backup.MIRROR_NAME, ctx);
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
    const r = backup.restore(backup.MIRROR_NAME, ctx);
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
    const r = backup.restore(backup.MIRROR_NAME, ctx);
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
  if (opts.db !== false) { const d = openDb(folder); upsertCard(d, { id: "fixture-" + date, url: "https://fixture/" + date }); d.close(); }
  const manifest = fs.readdirSync(path.join(folder, "images")).filter(n => n.endsWith(".jpg")).sort().map(n => {
    const file = path.join(folder, "images", n);
    return { name: n, size: fs.statSync(file).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  });
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ _counts: { imported: 1, saved: 0, images: opts.metaImages != null ? opts.metaImages : (opts.imgFiles || 0) }, _images: manifest, ts: 1 }));
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

/* ---- restore (safety snapshot then swap) ---- */
t("restore snapshots current store, swaps backup db+images in, keeps live store intact on missing backup", () => {
  withBackupDir(function (bdir) {
    // live store with ONE card + image
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "live", url: "https://x/live", platform: "fb", cat: "Saved", ts: 1, img: "idb:live" });
    images.putImg(store, "live", TINY_JPG);

    // a backup folder representing a DIFFERENT state (two cards, two images)
    const bkStore = newStore();
    let bdb = openDb(bkStore);
    upsertCard(bdb, { id: "a", url: "https://x/a", platform: "fb", cat: "Saved", ts: 1, img: "idb:a" });
    upsertCard(bdb, { id: "b", url: "https://x/b", platform: "fb", cat: "Saved", ts: 2, img: "idb:b" });
    images.putImg(bkStore, "a", TINY_JPG);
    images.putImg(bkStore, "b", TINY_JPG);
    bdb.close();
    const res = backup.runBackup(openDb(bkStore), bkStore); // writes interests-backup-<today>
    const backupName = res.name;

    // ctx with a reopen closure
    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: function () {},
      reopen: function () { return openDb(store); }
    };

    // missing-backup guard: live store untouched
    assert.deepStrictEqual(backup.restore("interests-backup-2099-01-01", ctx), { ok: false });
    assert.strictEqual(images.imageCount(store), 1, "live images untouched on bad restore");

    // real restore
    const out = backup.restore(backupName, ctx);
    assert.strictEqual(out.ok, true);
    // live db now has the backup's two cards
    assert.strictEqual(counts(ctx.db).cards, 2);
    assert.strictEqual(images.imageCount(store), 2, "backup images overlaid");
    // safety snapshot exists and is NOT a rotatable dated name
    const snaps = fs.readdirSync(bdir).filter(function (n) { return n.indexOf("interests-backup-before-restore-") === 0; });
    assert.strictEqual(snaps.length, 1, "one pre-restore safety snapshot");
    assert.strictEqual(backup.pickBackupsToDelete([snaps[0]], 0).length, 0, "snapshot never rotated");
    ctx.db.close();
  });
});

t("restore ABORTS before overwriting the live store if the safety snapshot fails", () => {
  withBackupDir(function (bdir) {
    // A valid backup folder to restore FROM (two cards/images).
    const bkStore = newStore();
    let bdb = openDb(bkStore);
    upsertCard(bdb, { id: "a", url: "https://x/a", platform: "fb", cat: "Saved", ts: 1, img: "idb:a" });
    upsertCard(bdb, { id: "b", url: "https://x/b", platform: "fb", cat: "Saved", ts: 2, img: "idb:b" });
    images.putImg(bkStore, "a", TINY_JPG);
    images.putImg(bkStore, "b", TINY_JPG);
    bdb.close();
    const backupName = backup.runBackup(openDb(bkStore), bkStore).name;

    // ctx whose storeDir has NO interests.db on disk → copying the live db for the
    // safety snapshot throws ENOENT. restore must abort before swapping anything in.
    const liveStore = newStore();  // images/ exists, but no interests.db file
    fs.writeFileSync(path.join(liveStore, "images", "sentinel.jpg"), "keep");
    const ctx = {
      db: { close: function () {}, exec: function () {} },
      storeDir: liveStore,
      getStorePath: function () { return liveStore; },
      setStorePath: function () {},
      reopen: function () { throw new Error("reopen must NOT be called on aborted restore"); }
    };

    const out = backup.restore(backupName, ctx);
    assert.deepStrictEqual(out, { ok: false, error: "safety snapshot failed" });
    // live store NOT overwritten: no restored interests.db, sentinel image intact,
    // backup's images NOT copied in.
    assert.strictEqual(fs.existsSync(path.join(liveStore, "interests.db")), false, "live db not created by aborted restore");
    assert.strictEqual(fs.existsSync(path.join(liveStore, "images", "sentinel.jpg")), true, "live images untouched");
    assert.strictEqual(images.imageCount(liveStore), 1, "no backup images overlaid");
  });
});

t("restore recovers ctx.db to a live handle when the swap step throws mid-restore", () => {
  withBackupDir(function (bdir) {
    // live store with ONE card + image
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "live", url: "https://x/live", platform: "fb", cat: "Saved", ts: 1, img: "idb:live" });
    images.putImg(store, "live", TINY_JPG);

    // a valid backup folder to restore FROM (must stay VALID — restore() validates
    // isFile() on the backup's interests.db before doing anything else, so a
    // corrupted backup would abort at that guard and never reach the swap step).
    const bkStore = newStore();
    let bdb = openDb(bkStore);
    upsertCard(bdb, { id: "a", url: "https://x/a", platform: "fb", cat: "Saved", ts: 1, img: "idb:a" });
    images.putImg(bkStore, "a", TINY_JPG);
    bdb.close();
    const backupName = backup.runBackup(openDb(bkStore), bkStore).name;
    const backupDbPath = path.join(bdir, backupName, "interests.db");

    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: function () {},
      reopen: function () { return openDb(store); }
    };

    // Simulate a locked/online-only file at the EXACT line of step 3 (the swap):
    // temporarily wrap fs.copyFileSync so it throws only when copying FROM the
    // backup folder (the swap copy), leaving every other copyFileSync call
    // (safety snapshot, runBackup, etc.) unaffected. Always restore the original.
    const origCopyFileSync = fs.copyFileSync;
    fs.copyFileSync = function (src, dst) {
      if (src === backupDbPath) throw new Error("simulated locked/online-only file");
      return origCopyFileSync.apply(fs, arguments);
    };
    let out;
    try {
      out = backup.restore(backupName, ctx);
    } finally {
      fs.copyFileSync = origCopyFileSync;
    }

    assert.strictEqual(out.ok, false, "restore reports failure, does not throw");
    // ctx.db must be a LIVE handle again (not left closed) — routes read ctx.db
    // at request time (Task 1), so a reopened handle is all that's needed to recover.
    const row = ctx.db.prepare("SELECT COUNT(*) n FROM cards").get();
    assert.ok(row && typeof row.n === "number", "ctx.db usable after failed restore");
    ctx.db.close();
  });
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
