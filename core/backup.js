// core/backup.js — backup/restore engine for the Core service.
// PURE helpers first (pickBackupsToDelete, backupCountsMatch) — ported verbatim
// from the legacy web app and covered by tests/backup.test.js.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { loadConfig, isTempPath, recordLastCounts, appDataDir } = require("./config.js");
const { listImageIds, imagesDir, imageCount } = require("./images.js");
const { counts, openDb, allCards, allSaved, allTombstones, getKV } = require("./db.js");
const { setStorePath } = require("./config.js");

// Find the user's real Dropbox root from Dropbox's own info.json, which records
// the actual location (it may be on any drive, e.g. D:\Dropbox — not necessarily
// under the user profile). Returns null if not found.
function detectDropboxRoot() {
  const files = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Dropbox", "info.json"),
    process.env.APPDATA && path.join(process.env.APPDATA, "Dropbox", "info.json"),
  ].filter(Boolean);
  for (const f of files) {
    try {
      const info = JSON.parse(fs.readFileSync(f, "utf8"));
      const p = (info.personal && info.personal.path) || (info.business && info.business.path);
      if (p && fs.existsSync(p)) return p;
    } catch (_) { /* not present / unreadable — try next */ }
  }
  return null;
}

// <dropbox>/Interests App/backups. Resolution order: explicit config.backupDir,
// then the real Dropbox root detected from info.json, then a <userprofile>\Dropbox
// fallback. (The fallback alone was wrong for Dropbox installs on another drive.)
function dropboxBackupDir() {
  const cfg = loadConfig() || {};
  // Sanity guard (2026-07-17 incident hardening): a killed test run once left
  // the REAL config's backupDir pointing into %TEMP%, and daily backups
  // silently landed in throwaway dirs for days. A temp backupDir in the real
  // %APPDATA% config is never legitimate — ignore the poisoned value (loudly)
  // and fall through to the real Dropbox root. BUT: when APPDATA itself is
  // under the temp dir we are inside an ISOLATED TEST SANDBOX, where a temp
  // backupDir is exactly right — honoring it is what keeps sandboxed tests
  // from ever touching the real Dropbox folder (live lesson 2026-07-19: the
  // first version of this guard redirected a sandboxed test's backup writes
  // INTO the real backups folder).
  const sandboxed = isTempPath(appDataDir());
  if (cfg.backupDir && !sandboxed && isTempPath(cfg.backupDir)) {
    console.error("backup: IGNORING configured backupDir under the OS temp dir (poisoned pointer?): " + cfg.backupDir);
  } else if (cfg.backupDir) return cfg.backupDir;
  const dbx = detectDropboxRoot();
  if (dbx) return path.join(dbx, "Interests App", "backups");
  const home = process.env.USERPROFILE || process.env.HOME || ".";
  return path.join(home, "Dropbox", "Interests App", "backups");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Image ids whose <id>.jpg is missing from destImagesDir or differs by content.
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
    try {
      if (sha256File(srcFile) !== sha256File(dstFile)) out.push(id);
    } catch (e) { out.push(id); }
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

function imageManifest(folder) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch (e) { return []; }
  return names.filter(function (n) { return /^.+\.jpg$/.test(n); }).sort().map(function (name) {
    const file = path.join(folder, name);
    const stat = fs.statSync(file);
    return { name: name, size: stat.size, sha256: sha256File(file) };
  });
}

function verifyBackupFolder(folder, expectedCounts) {
  if (!expectedCounts) return false;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")); } catch (e) { return false; }
  if (!meta || !backupCountsMatch(meta._counts, expectedCounts)) return false;

  let database;
  try {
    database = new DatabaseSync(path.join(folder, "interests.db"));
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (!integrity || integrity.integrity_check !== "ok") return false;
    const dc = counts(database);
    if ((dc.cards | 0) !== (expectedCounts.imported | 0) || (dc.saved | 0) !== (expectedCounts.saved | 0)) return false;
  } catch (e) { return false; }
  finally { if (database) { try { database.close(); } catch (e) {} } }

  let manifest;
  try { manifest = imageManifest(path.join(folder, "images")); } catch (e) { return false; }
  if (manifest.length !== (expectedCounts.images | 0)) return false;
  if (!Array.isArray(meta._images) || meta._images.length !== manifest.length) return false;
  const byName = new Map(meta._images.map(function (item) { return [item && item.name, item]; }));
  for (const item of manifest) {
    const recorded = byName.get(item.name);
    if (!recorded || recorded.size !== item.size || recorded.sha256 !== item.sha256) return false;
  }
  return true;
}

// Portable JSON snapshot for a new PWA install to restore from directly — a
// one-way pull, no re-publish needed (unlike the live peer-sync path in
// pwa/sync-pwa.js). Deliberately does NOT go through settingsForSync()'s
// stripping — this snapshot intentionally includes the raw settings blob
// (API keys, Open PageRank key included) so a brand-new install needs no
// manual setup beyond the Dropbox App key itself (which can never be
// auto-filled this way — see pwa/restore-from-backup.js's own header
// comment). See docs/superpowers/specs/2026-07-13-pwa-restore-from-desktop-
// backup-design.md's "Security" section for the tradeoff this represents.
function buildPortableSnapshot(db) {
  let settings = null;
  try { settings = JSON.parse(getKV(db, "ia_settings") || "null"); } catch (e) { settings = null; }
  return {
    cards: allCards(db),
    saved: allSaved(db),
    tombstones: allTombstones(db),
    settings,
  };
}

// Create dropboxBackupDir()/interests-backup-YYYY-MM-DD/, copy interests.db + new/
// changed images, write meta.json LAST (presence signals a complete write).
function runBackup(db, storeDir) {
  const c = counts(db);
  const cnt = { imported: c.cards | 0, saved: c.saved | 0, images: imageCount(storeDir) | 0 };
  const name = "interests-backup-" + dateStamp();
  const destRoot = path.join(dropboxBackupDir(), name);
  const stageRoot = destRoot + ".staging-" + process.pid + "-" + Date.now();
  const stageImages = path.join(stageRoot, "images");
  fs.mkdirSync(stageImages, { recursive: true });

  // Flush WAL pages into interests.db so a backup taken while the live db is open
  // captures the most recent committed writes (the on-disk file lags the -wal sidecar).
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  catch (e) { throw new Error("backup WAL checkpoint failed: " + (e && e.message || e)); }

  // Reuse a verified same-day image set when possible, but never write into
  // the published folder. A failed run therefore leaves the prior good backup
  // untouched and the new folder is only published after verification.
  let reused = false;
  try {
    const oldMeta = readMeta(destRoot);
    reused = !!(oldMeta && verifyBackupFolder(destRoot, oldMeta._counts));
  } catch (e) { reused = false; }
  if (reused) fs.cpSync(destRoot, stageRoot, { recursive: true });

  // Copy the database into staging; the published same-day backup is never
  // overwritten in place.
  copyFileSync(path.join(storeDir, "interests.db"), path.join(stageRoot, "interests.db"));

  // incremental image copy
  const srcImages = imagesDir(storeDir);
  for (const id of changedImageIds(storeDir, stageImages)) {
    copyFileSync(path.join(srcImages, id + ".jpg"), path.join(stageImages, id + ".jpg"));
  }
  const sourceIds = new Set(listImageIds(storeDir).map(function (id) { return id + ".jpg"; }));
  for (const nameInStage of fs.readdirSync(stageImages)) {
    if (/\.jpg$/.test(nameInStage) && !sourceIds.has(nameInStage)) {
      fs.rmSync(path.join(stageImages, nameInStage), { force: true });
    }
  }

  // Portable snapshot BEFORE meta.json — meta.json's presence is the backup's
  // completion marker (see readMeta/verifyBackup below), so everything else
  // must be written first.
  fs.writeFileSync(path.join(stageRoot, "snapshot.json"), JSON.stringify(buildPortableSnapshot(db)));

  // meta.json LAST
  fs.writeFileSync(path.join(stageRoot, "meta.json"), JSON.stringify({ _counts: cnt, _images: imageManifest(stageImages), ts: Date.now() }));
  if (!verifyBackupFolder(stageRoot, cnt)) throw new Error("backup verification failed");

  // Publish after verification. If replacing the dated folder fails, restore
  // the displaced prior copy so an operational error never exposes a blank or
  // partial same-day backup.
  let displaced = null;
  try {
    if (fs.existsSync(destRoot)) {
      displaced = destRoot + ".previous-" + process.pid + "-" + Date.now();
      fs.renameSync(destRoot, displaced);
    }
    fs.renameSync(stageRoot, destRoot);
    if (displaced) { try { fs.rmSync(displaced, { recursive: true, force: true }); } catch (e) {} }
  } catch (e) {
    try { if (!fs.existsSync(destRoot) && displaced && fs.existsSync(displaced)) fs.renameSync(displaced, destRoot); } catch (restoreError) {}
    throw e;
  }
  // Record last-known-healthy counts OUTSIDE the store (config.json) so a
  // future boot can notice a collapsed/swapped store that can't vouch for
  // itself (2026-07-17 incident hardening; see config.evaluateStoreSafety).
  try { recordLastCounts({ cards: cnt.imported, saved: cnt.saved }); } catch (e) {}
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
  if (!/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(String(name || ""))) return false;
  const folder = path.join(dropboxBackupDir(), name);
  const meta = readMeta(folder);
  return !!meta && verifyBackupFolder(folder, expectedCounts || meta._counts);
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
  if (!/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(String(name || ""))) return { ok: false };
  const backupFolder = path.join(dropboxBackupDir(), name);
  let hasDb = false;
  try { hasDb = fs.statSync(path.join(backupFolder, "interests.db")).isFile(); } catch (e) { hasDb = false; }
  if (!hasDb) return { ok: false };
  const backupMeta = readMeta(backupFolder);
  if (!backupMeta || !verifyBackup(name, backupMeta._counts)) return { ok: false, error: "backup not verified" };

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
  try {
    fs.copyFileSync(path.join(backupFolder, "interests.db"), path.join(ctx.storeDir, "interests.db"));
    const liveImages = path.join(ctx.storeDir, "images");
    try { fs.rmSync(liveImages, { recursive: true, force: true }); } catch (e) {}
    overlayImages(path.join(backupFolder, "images"), liveImages);
  } catch (e) {
    // Swap failed (locked file, online-only placeholder, disk full). The live db
    // file is still intact on disk — reopen it so the service keeps serving.
    try { ctx.db = ctx.reopen(); } catch (e2) {}
    return { ok: false, error: "restore swap failed: " + (e && e.message) };
  }

  // 4) reopen
  ctx.db = ctx.reopen();
  // A restore is a DELIBERATE store transition — re-baseline the boot-guard's
  // last-known counts so restoring an intentionally smaller/older backup does
  // not trip the collapsed-counts dialog on next launch (false-positive
  // hardening; see config.evaluateStoreSafety).
  try { const rc = counts(ctx.db); recordLastCounts({ cards: rc.cards | 0, saved: rc.saved | 0 }); } catch (e) {}
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

module.exports = { detectDropboxRoot, pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate, restore, moveStore };
