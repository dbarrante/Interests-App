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

/* ---- runBackup / listBackups / verifyBackup (integration over tmp dirs) ---- */
const { openDb, upsertCard, upsertSaved, counts } = require("../core/db.js");
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
  try { return fn(bdir); }
  finally { config.saveConfig(orig || {}); }
}

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
  if (opts.db !== false) fs.writeFileSync(path.join(folder, "interests.db"), "x");
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ _counts: { imported: 1, saved: 0, images: opts.metaImages != null ? opts.metaImages : (opts.imgFiles || 0) }, ts: 1 }));
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
