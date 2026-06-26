// core/backup.js — backup/restore engine for the Core service.
// PURE helpers first (pickBackupsToDelete, backupCountsMatch) — ported verbatim
// from the legacy web app and covered by tests/backup.test.js.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config.js");
const { listImageIds, imagesDir, imageCount } = require("./images.js");
const { counts } = require("./db.js");

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

module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup };
