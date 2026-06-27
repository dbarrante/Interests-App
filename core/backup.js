// core/backup.js — backup/restore engine for the Core service.
// PURE helpers first (pickBackupsToDelete, backupCountsMatch) — ported verbatim
// from the legacy web app and covered by tests/backup.test.js.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config.js");
const { listImageIds, imagesDir, imageCount } = require("./images.js");
const { counts, openDb } = require("./db.js");
const { setStorePath } = require("./config.js");

// <userprofile>/Dropbox/Interests App/backups, overridable via config.backupDir.
function dropboxBackupDir() {
  const cfg = loadConfig() || {};
  if (cfg.backupDir) return cfg.backupDir;
  const home = process.env.USERPROFILE || process.env.HOME || ".";
  return path.join(home, "Dropbox", "Interests App", "backups");
}

// Image ids whose <id>.jpg is missing from destImagesDir or differs in size.
// If destImagesDir does not exist, every source id is "changed". Drives the
// incremental image copy in runBackup so 600MB+ libraries back up fast.
function changedImageIds(storeDir, destImagesDir) {
  const ids = listImageIds(storeDir);
  const srcDir = imagesDir(storeDir);
  let destExists = false;
  try { destExists = fs.statSync(destImagesDir).isDirectory(); } catch (e) { destExists = false; }
  if (!destExists) return ids.slice();
  const out = [];
  for (const id of ids) {
    const srcFile = path.join(srcDir, id + ".jpg");
    const dstFile = path.join(destImagesDir, id + ".jpg");
    let srcSize = -1, dstSize = -2;
    try { srcSize = fs.statSync(srcFile).size; } catch (e) { srcSize = -1; }
    try { dstSize = fs.statSync(dstFile).size; } catch (e) { dstSize = -2; }
    if (srcSize !== dstSize) out.push(id);
  }
  return out;
}

// Given backup names, return the ones to delete (all but the newest `keep` by the
// embedded date). Matches a backup FOLDER (new) or a legacy single-file .json ONLY,
// so snapshots / saves.json / before-restore copies are never selected.
function pickBackupsToDelete(names, keep) {
  const re = /^interests-backup-(\d{4}-\d{2}-\d{2})(\.json)?$/;
  const dated = (names || [])
    .map(function (n) { const m = re.exec(n); return m ? { name: n, date: m[1] } : null; })
    .filter(Boolean)
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return dated.slice(Math.max(0, keep)).map(function (d) { return d.name; });
}

// True when two counts objects agree on imported/saved/images. Used to verify a
// freshly-written backup before older ones are rotated away.
function backupCountsMatch(a, b) {
  if (!a || !b) return false;
  return (a.imported | 0) === (b.imported | 0)
    && (a.saved | 0) === (b.saved | 0)
    && (a.images | 0) === (b.images | 0);
}

function dateStamp() { return new Date().toISOString().slice(0, 10); }

function copyFileSync(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Create dropboxBackupDir()/interests-backup-YYYY-MM-DD/, copy interests.db + new/
// changed images, write meta.json LAST (presence signals a complete write).
function runBackup(db, storeDir) {
  const c = counts(db);
  const cnt = { imported: c.cards | 0, saved: c.saved | 0, images: imageCount(storeDir) | 0 };
  const name = "interests-backup-" + dateStamp();
  const destRoot = path.join(dropboxBackupDir(), name);
  const destImages = path.join(destRoot, "images");
  fs.mkdirSync(destImages, { recursive: true });

  // Flush WAL pages into interests.db so a backup taken while the live db is open
  // captures the most recent committed writes (the on-disk file lags the -wal sidecar).
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}

  // db copy (overwrites a prior same-day backup so it can't go stale)
  copyFileSync(path.join(storeDir, "interests.db"), path.join(destRoot, "interests.db"));

  // incremental image copy
  const srcImages = imagesDir(storeDir);
  for (const id of changedImageIds(storeDir, destImages)) {
    copyFileSync(path.join(srcImages, id + ".jpg"), path.join(destImages, id + ".jpg"));
  }

  // meta.json LAST
  fs.writeFileSync(path.join(destRoot, "meta.json"), JSON.stringify({ _counts: cnt, ts: Date.now() }));
  return { name, counts: cnt };
}

function readMeta(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")); }
  catch (e) { return null; }
}

// Scan dropboxBackupDir() for dated backup folders, newest first.
function listBackups() {
  const root = dropboxBackupDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  const re = /^interests-backup-(\d{4}-\d{2}-\d{2})$/;
  return names
    .map(function (n) {
      const m = re.exec(n);
      if (!m) return null;
      let isDir = false;
      try { isDir = fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { isDir = false; }
      if (!isDir) return null;
      const meta = readMeta(path.join(root, n));
      return { name: n, date: m[1], counts: meta ? meta._counts : null };
    })
    .filter(Boolean)
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
}

// True iff the named backup has interests.db, an images/ file count equal to
// expectedCounts.images, and meta._counts matching expectedCounts.
function verifyBackup(name, expectedCounts) {
  const folder = path.join(dropboxBackupDir(), name);
  try {
    if (!fs.statSync(path.join(folder, "interests.db")).isFile()) return false;
  } catch (e) { return false; }
  let imgFiles = 0;
  try {
    imgFiles = fs.readdirSync(path.join(folder, "images")).filter(function (n) { return n.endsWith(".jpg"); }).length;
  } catch (e) { imgFiles = 0; }
  if (imgFiles !== (expectedCounts.images | 0)) return false;
  const meta = readMeta(folder);
  return !!meta && backupCountsMatch(meta._counts, expectedCounts);
}

// Keep the newest `keep` dated backups. A candidate is deleted ONLY when it itself
// verifies (so we never delete an incomplete backup we can't trust) AND the NEWEST
// backup also verifies (so an incomplete newest never causes a good older one to be
// dropped). The sharded-backup lesson: never delete a good backup for a bad one.
function rotate(keep) {
  keep = (keep == null) ? 3 : keep;
  const list = listBackups();                 // newest-first, each {name,date,counts}
  if (!list.length) return;
  const verified = list.map(function (b) {
    return b.counts ? verifyBackup(b.name, b.counts) : false;
  });
  if (!verified[0]) return;                          // newest is unverified → rotate nothing
  const candidates = pickBackupsToDelete(list.map(function (b) { return b.name; }), keep);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (candidates.indexOf(b.name) < 0) continue;   // within the keep window
    if (!verified[i]) continue;                      // don't delete an unverified backup
    try { fs.rmSync(path.join(dropboxBackupDir(), b.name), { recursive: true, force: true }); } catch (e) {}
  }
}

// Copy every *.jpg from srcImages over dstImages (overlay, never deletes extras).
function overlayImages(srcImages, dstImages) {
  let names = [];
  try { names = fs.readdirSync(srcImages); } catch (e) { return; }
  fs.mkdirSync(dstImages, { recursive: true });
  for (const n of names) {
    if (!n.endsWith(".jpg")) continue;
    try { fs.copyFileSync(path.join(srcImages, n), path.join(dstImages, n)); } catch (e) {}
  }
}

// Restore a named backup: safety-snapshot the CURRENT store first (so a mistaken
// restore is recoverable), then swap the backup's db + images into the live store
// and reopen. Old/live data is never destroyed without a snapshot first.
function restore(name, ctx) {
  const backupFolder = path.join(dropboxBackupDir(), name);
  let hasDb = false;
  try { hasDb = fs.statSync(path.join(backupFolder, "interests.db")).isFile(); } catch (e) { hasDb = false; }
  if (!hasDb) return { ok: false };

  // 1) safety snapshot of the live store (non-dated name → never auto-rotated).
  // If snapshotting the live db FAILS, abort BEFORE overwriting the live store —
  // a restore that can't first preserve current data must not destroy it.
  const snapName = "interests-backup-before-restore-" + Date.now();
  const snapFolder = path.join(dropboxBackupDir(), snapName);
  fs.mkdirSync(path.join(snapFolder, "images"), { recursive: true });
  try {
    fs.copyFileSync(path.join(ctx.storeDir, "interests.db"), path.join(snapFolder, "interests.db"));
  } catch (e) {
    return { ok: false, error: "safety snapshot failed" };
  }
  overlayImages(path.join(ctx.storeDir, "images"), path.join(snapFolder, "images"));

  // 2) close the live db so the file can be replaced (Windows holds an exclusive handle)
  try { ctx.db.close(); } catch (e) {}
  // also drop WAL/SHM sidecars so the restored db isn't shadowed by stale WAL pages
  for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(path.join(ctx.storeDir, "interests.db" + ext), { force: true }); } catch (e) {} }

  // 3) swap backup db + images into the live store. The live state is already
  // safety-snapshotted above, so clear the live images/ first (drop orphans from the
  // replaced db) and then overlay the backup's images — the live store ends up an
  // exact copy of the backup, not a union with stale images.
  fs.copyFileSync(path.join(backupFolder, "interests.db"), path.join(ctx.storeDir, "interests.db"));
  const liveImages = path.join(ctx.storeDir, "images");
  try { fs.rmSync(liveImages, { recursive: true, force: true }); } catch (e) {}
  overlayImages(path.join(backupFolder, "images"), liveImages);

  // 4) reopen
  ctx.db = ctx.reopen();
  return { ok: true };
}

// Move the live store to `target`: copy db + images, VERIFY counts at the target,
// and only then repoint the %APPDATA% pointer + reopen. The old copy is left intact
// until (and after) verification, so an interrupted/failed move never loses data.
function moveStore(target, ctx) {
  const c = counts(ctx.db);
  const srcCounts = { imported: c.cards | 0, saved: c.saved | 0, images: imageCount(ctx.storeDir) | 0 };

  // 1) copy db + images into target
  let tdb = null;
  try {
    fs.mkdirSync(path.join(target, "images"), { recursive: true });
    // Flush WAL pages into interests.db so the copied file captures the most recent
    // committed writes (the on-disk file lags the -wal sidecar in WAL mode).
    try { ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}
    fs.copyFileSync(path.join(ctx.storeDir, "interests.db"), path.join(target, "interests.db"));
    const srcImages = imagesDir(ctx.storeDir);
    for (const id of listImageIds(ctx.storeDir)) {
      fs.copyFileSync(path.join(srcImages, id + ".jpg"), path.join(target, "images", id + ".jpg"));
    }
    // 2) verify at the target by opening its db + counting its images
    tdb = openDb(target);
    const tc = counts(tdb);
    const targetCounts = { imported: tc.cards | 0, saved: tc.saved | 0, images: imageCount(target) | 0 };
    tdb.close(); tdb = null;
    if (!backupCountsMatch(srcCounts, targetCounts)) return { ok: false, path: ctx.storeDir };
  } catch (e) {
    if (tdb) { try { tdb.close(); } catch (e2) {} }
    return { ok: false, path: ctx.storeDir };
  }

  // 3) verified → repoint + reopen; OLD store files are left on disk
  try { ctx.db.close(); } catch (e) {}
  setStorePath(target);
  ctx.storeDir = target;
  ctx.db = ctx.reopen();
  return { ok: true, path: target };
}

module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate, restore, moveStore };
