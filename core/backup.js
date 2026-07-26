// core/backup.js — backup/restore engine for the Core service.
// PURE helpers first (pickBackupsToDelete, backupCountsMatch) — ported verbatim
// from the legacy web app and covered by tests/backup.test.js.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { loadConfig, isTempPath, recordLastCounts, getLastCounts, appDataDir } = require("./config.js");
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

// A dated daily backup, or an undated pre-cleanup safety snapshot (never rotated).
const DATED_BACKUP_NAME = /^interests-backup-(\d{4}-\d{2}-\d{2})$/;
const SAFETY_BACKUP_NAME = /^interests-backup-before-cleanup-(\d+)-([a-f0-9]{12})$/;
const RESTORE_BACKUP_NAME = /^interests-backup-before-restore-\d+$/;
// The always-current incremental mirror. Stable name (never dated), updated
// IN PLACE so unchanged image files are never rewritten -- that is the whole
// point: Dropbox then syncs only the delta instead of re-uploading ~6,000
// files every time. Deliberately excluded from every rotation regex: it is a
// single rolling copy, not a point-in-time snapshot, so nothing may age it out.
const MIRROR_NAME = "interests-mirror";
// Where the mirror's completion marker is parked while an update is in flight.
const MIRROR_UPDATING_META = "meta.updating.json";
// How stale the newest dated point-in-time snapshot may get before a merge
// forces a fresh full one. The mirror covers "recover the latest good state";
// these cover "recover what it looked like N days ago".
const FULL_SNAPSHOT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Gate for every name that gets joined onto the backup root — keep it an
// allowlist. MIRROR_NAME is compared as an exact literal (not a pattern), so it
// adds no traversal surface, and it MUST be allowed: the mirror is the freshest
// recovery point, and without this both verifyBackup() and restore() would
// refuse it, making it unusable exactly when it matters.
function isValidBackupName(name) {
  const n = String(name || "");
  return DATED_BACKUP_NAME.test(n) || SAFETY_BACKUP_NAME.test(n) || n === MIRROR_NAME;
}

function copyFileSync(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Overridable seam so tests can make retries instant (see tests/backup.test.js) —
// production always goes through the real Atomics.wait block.
const timing = {
  sleepSync: function (ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};

// Dropbox actively syncing the backups folder can hold a lock on the exact
// publish rename below (EPERM/EBUSY/EACCES). Live-measured against a
// production library, 2026-07-24: an initial 900ms retry budget (3 attempts,
// 300ms apart) still failed 2 of 5 real safety-snapshot publishes outright.
// Instrumenting a single failure end to end showed the lock cleared on its
// own after ~20s (32 attempts, ~600-750ms apart) — Dropbox's own sync
// bookkeeping over the just-written ~600MB/6000-image batch, not a real
// conflict — so the fix is a longer bounded wait, not a different mechanism.
// RENAME_RETRY_ATTEMPTS/DELAY give ~33s of headroom past that measurement.
// Non-transient errors (e.g. a genuinely missing path) still fail immediately.
const TRANSIENT_RENAME_CODES = { EPERM: 1, EBUSY: 1, EACCES: 1 };
const RENAME_RETRY_ATTEMPTS = 45;
const RENAME_RETRY_DELAY_MS = 750;
function renameSyncWithRetry(src, dst) {
  for (let attempt = 1; ; attempt++) {
    try { return fs.renameSync(src, dst); }
    catch (e) {
      if (attempt >= RENAME_RETRY_ATTEMPTS || !TRANSIENT_RENAME_CODES[e && e.code]) throw e;
      timing.sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
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

// Copy every live image into destDir, hashing each file from the SAME read used for
// the copy (one open/read per file) instead of copying-then-separately-re-reading it
// for a manifest. A 6,000-image/600MB+ library re-read 3-4x over (copy, manifest,
// stage-verify, post-publish-verify) is what made every duplicate-cleanup safety
// snapshot take tens of seconds to minutes — see 2026-07-22 perf incident.
function copyImagesAndBuildManifest(srcDir, destDir, ids) {
  fs.mkdirSync(destDir, { recursive: true });
  const manifest = ids.map(function (id) {
    const name = id + ".jpg";
    const bytes = fs.readFileSync(path.join(srcDir, name));
    fs.writeFileSync(path.join(destDir, name), bytes);
    return { name: name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  manifest.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  return manifest;
}

// Verify a database file's integrity and row counts WITHOUT touching images — used
// right after this process wrote the images itself (their hashes are already known
// from copyImagesAndBuildManifest, so re-reading and re-hashing every file again
// would be pure waste). Full image-content verification (verifyBackupFolder) is
// reserved for folders this process did NOT just write: a candidate recovered after
// a crash, or a backup read cold for restore/rotation.
function verifyDbOnly(dbPath, expectedCounts) {
  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (!integrity || integrity.integrity_check !== "ok") return false;
    const dc = counts(database);
    return (dc.cards | 0) === (expectedCounts.imported | 0) && (dc.saved | 0) === (expectedCounts.saved | 0);
  } catch (e) {
    return false;
  } finally {
    if (database) { try { database.close(); } catch (e) {} }
  }
}

function verifyBackupFolder(folder, expectedCounts) {
  if (!expectedCounts) return false;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")); } catch (e) { return false; }
  if (!meta || !backupCountsMatch(meta._counts, expectedCounts)) return false;

  let database;
  try {
    database = new DatabaseSync(path.join(folder, "interests.db"), { readOnly: true });
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

// Hidden per-publish sidecars — ".<name>.previous-<token>" (the copy displaced
// until its replacement verifies) and ".<name>.staging-<token>" (a not-yet-
// published build) — are meant to be deleted automatically right after publish.
// But Dropbox actively syncing the folder can hold a file open at that exact
// moment (EBUSY), silently failing the one-shot cleanup and leaving a
// near-full image-library copy behind forever (2026-07-23: 68 orphans, 27GB,
// found accumulating in the real backups folder). Retried on every later call.
const HIDDEN_PREVIOUS_RE = /^\.(.+)\.previous-[^.]+$/;
const HIDDEN_STAGING_RE = /^\.(.+)\.staging-[^.]+$/;
const STALE_STAGING_MS = 60 * 60 * 1000; // a live publish finishes in seconds
// Verifying a candidate before deleting it means re-hashing its whole image set —
// exactly the per-call cost the 2026-07-22 perf fix eliminated from the normal
// path. Cap how much of a large backlog gets verified+cleaned per call so
// catching up after this fix ships doesn't just relocate the slowdown; a
// backlog drains over a handful of calls instead of one giant one.
const MAX_CLEANUP_PER_CALL = 3;
function sweepOrphanedArtifacts(backupRoot) {
  let names = [];
  try { names = fs.readdirSync(backupRoot); } catch (e) { return 0; }
  const now = Date.now();
  let cleaned = 0;
  for (const n of names) {
    if (cleaned >= MAX_CLEANUP_PER_CALL) break;
    const prevMatch = HIDDEN_PREVIOUS_RE.exec(n);
    const stageMatch = !prevMatch && HIDDEN_STAGING_RE.exec(n);
    if (!prevMatch && !stageMatch) continue;
    const full = path.join(backupRoot, n);
    if (prevMatch) {
      // Safe once its replacement (the canonical name) exists and verifies —
      // that's proof the publish this copy was displaced FOR already
      // succeeded, so this is a confirmed-stale duplicate, not a fallback.
      const canonical = path.join(backupRoot, prevMatch[1]);
      const meta = readMeta(canonical);
      if (meta && verifyBackupFolder(canonical, meta._counts)) {
        try { fs.rmSync(full, { recursive: true, force: true }); cleaned++; } catch (e) {}
      }
    } else {
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (e) { continue; }
      if (now - mtime > STALE_STAGING_MS) {
        try { fs.rmSync(full, { recursive: true, force: true }); cleaned++; } catch (e) {}
      }
    }
  }
  return cleaned;
}

// Cleanup/restore safety snapshots use unique, non-daily names (see runBackup)
// specifically so a rotation pass never mistakes one for a stale dated backup —
// but that also means nothing else ever cleans them up, and each is a near-full
// image-library mirror. Keep only the newest `keep` VERIFIED ones (same
// never-delete-a-good-one-for-an-unverified-one rule as rotate()), capped per
// call for the same reason as sweepOrphanedArtifacts above.
function rotateNamedSnapshots(backupRoot, re, keep) {
  let names = [];
  try { names = fs.readdirSync(backupRoot); } catch (e) { return 0; }
  const candidates = names
    .map(function (n) { const m = re.exec(n); return m ? { name: n, ts: +m[1] || 0 } : null; })
    .filter(Boolean)
    .sort(function (a, b) { return b.ts - a.ts; });
  if (candidates.length <= keep) return 0;
  const newestFolder = path.join(backupRoot, candidates[0].name);
  const newestMeta = readMeta(newestFolder);
  if (!newestMeta || !verifyBackupFolder(newestFolder, newestMeta._counts)) return 0; // newest unverified → rotate nothing
  let cleaned = 0;
  for (let i = keep; i < candidates.length && cleaned < MAX_CLEANUP_PER_CALL; i++) {
    const folder = path.join(backupRoot, candidates[i].name);
    const meta = readMeta(folder);
    if (!meta || !verifyBackupFolder(folder, meta._counts)) continue; // don't delete an unverified one
    try { fs.rmSync(folder, { recursive: true, force: true }); cleaned++; } catch (e) {}
  }
  return cleaned;
}

// restore()'s before-restore snapshot is a bare db+images copy with no
// meta.json (it's written by a different, simpler path — see restore() below),
// so it can't be verified the way rotateNamedSnapshots verifies before-cleanup
// snapshots. Fall back to newest-`keep`-by-mtime; restore() itself already
// treats this snapshot as best-effort, not a long-term recovery point.
function rotateUnverifiedSnapshots(backupRoot, re, keep) {
  let names = [];
  try { names = fs.readdirSync(backupRoot); } catch (e) { return 0; }
  const candidates = names
    .filter(function (n) { return re.test(n); })
    .map(function (n) {
      let mtime = 0;
      try { mtime = fs.statSync(path.join(backupRoot, n)).mtimeMs; } catch (e) {}
      return { name: n, mtime: mtime };
    })
    .sort(function (a, b) { return b.mtime - a.mtime; });
  let cleaned = 0;
  for (let i = keep; i < candidates.length; i++) {
    try { fs.rmSync(path.join(backupRoot, candidates[i].name), { recursive: true, force: true }); cleaned++; } catch (e) {}
  }
  return cleaned;
}

// One-time (or on-demand) drain of the backlog rotate()/sweepOrphanedArtifacts
// leave behind between normal calls — each normal call caps its own cleanup at
// MAX_CLEANUP_PER_CALL so a large backlog doesn't relocate the per-call
// slowdown onto whichever backup happens to run first. This loops the same
// verified-before-delete passes until a full round makes no progress (or
// maxRounds is hit), for maintenance/manual "clean up now" use.
function drainBackupBacklog(maxRounds) {
  maxRounds = maxRounds == null ? 200 : maxRounds;
  const backupRoot = dropboxBackupDir();
  let totalCleaned = 0, rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    const cleaned = sweepOrphanedArtifacts(backupRoot)
      + rotateNamedSnapshots(backupRoot, SAFETY_BACKUP_NAME, 2)
      + rotateUnverifiedSnapshots(backupRoot, RESTORE_BACKUP_NAME, 2)
      // Defense in depth for freezeMirrorForRestore's throwaway output: restore()
      // cleans these up itself in a finally, but a hard process/power stop mid-
      // restore skips that entirely, same class of risk sweepOrphanedArtifacts
      // already exists for.
      + rotateUnverifiedSnapshots(backupRoot, MIRROR_FREEZE_NAME, 1);
    if (!cleaned) break;
    totalCleaned += cleaned;
  }
  return { cleaned: totalCleaned, rounds: rounds };
}

// A hard process/power stop can occur between the two publication renames.
// If the canonical name is absent, recover the newest verified displaced copy
// before beginning another backup. Hidden candidates are never auto-deleted.
function recoverInterruptedPublish(backupRoot, name) {
  const destRoot = path.join(backupRoot, name);
  if (fs.existsSync(destRoot)) return;
  let candidates = [];
  try {
    candidates = fs.readdirSync(backupRoot)
      .filter(function (n) { return n.indexOf("." + name + ".previous-") === 0; })
      .map(function (n) {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(backupRoot, n)).mtimeMs; } catch (e) {}
        return { name: n, mtime };
      })
      .sort(function (a, b) { return b.mtime - a.mtime; });
  } catch (e) { return; }
  for (const candidate of candidates) {
    // verifyBackupFolder (not verifyBackup) — these hidden ".name.previous-*"
    // candidates never match the public dated/safety naming pattern, so the
    // name-allowlisted verifyBackup would always reject them.
    const folder = path.join(backupRoot, candidate.name);
    const meta = readMeta(folder);
    if (!meta || !verifyBackupFolder(folder, meta._counts)) continue;
    fs.renameSync(folder, destRoot);
    return;
  }
}

// Build a fresh image-bearing snapshot in a hidden stage, verify it, then publish
// by same-parent rename. Cleanup snapshots use unique non-rotating names.
function runBackup(db, storeDir, opts) {
  opts = opts || {};
  const c = counts(db);
  const cnt = { imported: c.cards | 0, saved: c.saved | 0, images: imageCount(storeDir) | 0 };
  const name = opts.safety
    ? ("interests-backup-before-cleanup-" + Date.now() + "-" + crypto.randomBytes(6).toString("hex"))
    : ("interests-backup-" + dateStamp());
  const backupRoot = dropboxBackupDir();
  const destRoot = path.join(backupRoot, name);
  const token = process.pid + "-" + Date.now();
  const stageName = "." + name + ".staging-" + token;
  const previousName = "." + name + ".previous-" + token;
  const stageRoot = path.join(backupRoot, stageName);
  const previousRoot = path.join(backupRoot, previousName);
  const stageImages = path.join(stageRoot, "images");
  fs.mkdirSync(backupRoot, { recursive: true });
  recoverInterruptedPublish(backupRoot, name);
  // Opportunistic cleanup, retried on every call (cheap when there's nothing to
  // do) so a transient Dropbox-lock failure eventually self-heals instead of
  // accumulating forever — see sweepOrphanedArtifacts below. Rotating cleanup/
  // restore snapshots happens AFTER this call's own snapshot publishes (below),
  // not here — rotating before would always leave keep+1 around (the pruned
  // set plus the one this call is about to add).
  sweepOrphanedArtifacts(backupRoot);

  // Flush WAL pages into interests.db so a backup taken while the live db is open
  // captures the most recent committed writes (the on-disk file lags the -wal sidecar).
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  catch (e) { throw new Error("backup WAL checkpoint failed: " + (e && e.message || e)); }

  let displaced = false;
  try {
    // Build a fresh exact mirror. Never trust an older shard merely because its
    // id and byte length happen to match the live file. Each image is read and
    // hashed exactly once here (copyImagesAndBuildManifest) — the manifest this
    // produces IS the verification, so nothing below re-reads image content.
    copyFileSync(path.join(storeDir, "interests.db"), path.join(stageRoot, "interests.db"));
    const srcImages = imagesDir(storeDir);
    const liveIds = listImageIds(storeDir);
    const manifest = copyImagesAndBuildManifest(srcImages, stageImages, liveIds);

  // Portable snapshot BEFORE meta.json — meta.json's presence is the backup's
  // completion marker (see readMeta/verifyBackup below), so everything else
  // must be written first.
    fs.writeFileSync(path.join(stageRoot, "snapshot.json"), JSON.stringify(buildPortableSnapshot(db)));

    // meta.json LAST. _images carries a per-file sha256 manifest so a COLD read of
    // this folder later (restore/rotate/crash-recovery) can catch silent content
    // corruption, not just a count match.
    fs.writeFileSync(path.join(stageRoot, "meta.json"), JSON.stringify({ _counts: cnt, _images: manifest, ts: Date.now() }));
    if (manifest.length !== cnt.images || !verifyDbOnly(path.join(stageRoot, "interests.db"), cnt)) {
      throw new Error("staged backup verification failed");
    }

    // Publish by same-parent renames. Keep the displaced backup until the
    // canonical replacement has itself passed verification. A rename doesn't
    // touch file bytes, so re-checking image content here (verifyBackup's full
    // re-hash) would just re-verify what copyImagesAndBuildManifest already
    // proved above — confirm the db+meta.json landed intact instead.
    if (fs.existsSync(destRoot)) {
      renameSyncWithRetry(destRoot, previousRoot);
      displaced = true;
    }
    try {
      renameSyncWithRetry(stageRoot, destRoot);
      const publishedMeta = readMeta(destRoot);
      if (!publishedMeta || !backupCountsMatch(publishedMeta._counts, cnt) || !verifyDbOnly(path.join(destRoot, "interests.db"), cnt)) {
        throw new Error("published backup verification failed");
      }
    } catch (publishError) {
      if (displaced) {
        try { renameSyncWithRetry(destRoot, stageRoot); } catch (e) {}
        // The most safety-critical rename in this function: it restores the
        // prior known-good backup. Retried like every other rename here for
        // the same reason — a Dropbox lock at this exact moment is exactly as
        // plausible as at the publish rename it's cleaning up after.
        renameSyncWithRetry(previousRoot, destRoot);
        displaced = false;
      }
      throw publishError;
    }
    if (displaced) {
      fs.rmSync(previousRoot, { recursive: true, force: true });
      displaced = false;
    }
  } catch (e) {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (cleanupError) {}
    // Never remove previousRoot here: if rollback failed it is the only known
    // good copy and its hidden name keeps automatic rotation away from it.
    throw e;
  }
  // Record last-known-healthy counts OUTSIDE the store (config.json) so a
  // future boot can notice a collapsed/swapped store that can't vouch for
  // itself (2026-07-17 incident hardening; see config.evaluateStoreSafety).
  try { recordLastCounts({ cards: cnt.imported, saved: cnt.saved }); } catch (e) {}
  // Rotate cleanup safety snapshots AFTER this call's own snapshot is live, so
  // the count this converges to is exactly `keep`, not keep+1. (Restore
  // snapshots are rotated from within restore() itself — a separate path that
  // never calls runBackup — see rotateUnverifiedSnapshots there.)
  if (opts.safety) rotateNamedSnapshots(backupRoot, SAFETY_BACKUP_NAME, 2);
  return { name, counts: cnt };
}

function readMeta(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")); }
  catch (e) { return null; }
}

// The mirror's completion marker, set aside (not deleted) while an update is in
// flight. meta.json's ABSENCE is what marks the mirror torn -- that must not
// change -- but its CONTENT is also the only record of what the mirror held
// before this run, and losing that record is what let a torn mirror's collapse
// guard go inert and its incremental skip-list reset to a full rewrite. Renaming
// instead of deleting keeps torn-ness detectable and the history readable.
function readMirrorBaseline(folder) {
  return readMeta(folder) || (function () {
    try { return JSON.parse(fs.readFileSync(path.join(folder, MIRROR_UPDATING_META), "utf8")); }
    catch (e) { return null; }
  })();
}

// Scan dropboxBackupDir() for dated backup folders, newest first.
// Newest dated point-in-time snapshot, as an epoch ms (0 when none exists).
function newestDatedSnapshotTime() {
  const backupRoot = dropboxBackupDir();
  let names = [];
  try { names = fs.readdirSync(backupRoot); } catch (e) { return 0; }
  const now = Date.now();
  let best = 0;
  for (const n of names) {
    const m = DATED_BACKUP_NAME.exec(n);
    if (!m) continue;
    const t = Date.parse(m[1] + "T00:00:00Z");   // dateStamp() is UTC, parse to match
    if (!isFinite(t) || t > now) continue;   // clock-skew guard: a future-dated folder
                                              // must never suppress the next real snapshot
    // Only a cheap check (does meta.json exist and parse -- the completion
    // marker) — NOT a full verifyBackup, which re-hashes every image and would
    // be a real cost run every merge. A folder whose marker is missing/corrupt
    // isn't a confirmed recovery point yet and must not suppress a genuinely-
    // needed fresh snapshot; a folder with a valid marker but a corrupt db or
    // mismatched images is a narrower gap this cheap check accepts.
    const meta = readMeta(path.join(backupRoot, n));
    if (!meta) continue;
    if (t > best) best = t;
  }
  return best;
}

// Refresh the rolling mirror IN PLACE. Only images whose content actually
// changed are rewritten; images dropped from the live store are removed.
//
// Why in place rather than the stage+publish-rename dance runBackup uses: that
// dance is atomic, but it necessarily writes every file to a NEW path and then
// moves it, so Dropbox sees ~6,000 creations + ~6,000 deletions per run. Sync
// calls this before EVERY merge (runSync fires every 3 minutes), which is what
// made Dropbox churn continuously. Updating in place makes the common case --
// nothing or almost nothing changed -- cost close to zero files.
//
// The price is that this folder is not atomic while it is being written, so:
//   * meta.json (the completion marker readMeta/verifyBackup key off) is
//     DELETED first and rewritten LAST. A crash mid-update therefore leaves a
//     folder that fails verification rather than one that looks complete.
//   * the dated snapshots runBackup writes are untouched and stay atomic, so a
//     torn mirror never leaves you without an independent recovery point.
// Throws if the result does not verify -- callers (sync) treat a throw as
// "do not proceed with the destructive operation".
// How many previously-"unchanged" images get a full byte-for-byte re-hash of
// their DEST copy each run, on a rotating cursor persisted in meta.json. The
// normal skip path trusts the dest's recorded sha256 plus a size check — real,
// but it means a mirror file silently corrupted in place at the same byte
// length (bit rot, a bad Dropbox conflict resolution) is never caught or
// repaired. This makes the mirror self-heal within a bounded number of runs
// instead of staying silently wrong forever — data-safety review, 2026-07-26.
const MIRROR_RECHECK_SLICE = 25;

function updateMirror(db, storeDir) {
  const backupRoot = dropboxBackupDir();
  const destRoot = path.join(backupRoot, MIRROR_NAME);
  const destImages = path.join(destRoot, "images");
  const metaPath = path.join(destRoot, "meta.json");

  // Read the previous manifest BEFORE invalidating it: its per-file sha256 is
  // what lets us skip rewriting unchanged images, and its _counts are the
  // baseline the collapse guards below judge against.
  //
  // This reads through to the meta.updating.json sidecar, so BOTH survive a run
  // that threw after invalidating (WAL checkpoint, db copy, rename retry
  // exhaustion, verification -- four reachable throw sites, now attempted ~480x
  // a day rather than once). Losing them was a real defect, not a theoretical
  // one: with no _counts the card-ratio escape hatch below degraded to
  // `imageRatio > imageRatio + 0.25`, which is false for every input -- the
  // collapse guard was silently OFF for exactly the torn state it most needed
  // to cover -- and with no _images every image took the rewrite path, turning
  // one transient failure into the ~6,000-file churn this feature exists to
  // remove.
  const prevMeta = readMirrorBaseline(destRoot);
  const prevByName = Object.create(null);
  if (prevMeta && Array.isArray(prevMeta._images)) {
    for (const e of prevMeta._images) { if (e && e.name) prevByName[e.name] = e; }
  }
  // Belt and suspenders on top of the sidecar: fall back to the files actually
  // sitting in destImages, which is what the delete loop below operates on.
  let prevDiskCount = 0;
  try { prevDiskCount = fs.readdirSync(destImages).filter(function (n) { return n.endsWith(".jpg"); }).length; } catch (e) {}
  const prevImageCount = Math.max(prevMeta && prevMeta._counts ? (prevMeta._counts.images | 0) : 0, prevDiskCount);

  const srcImages = imagesDir(storeDir);
  const ids = listImageIds(storeDir);
  const c = counts(db);   // needed early: the >=100 guard's escape hatch below reads live card counts

  // Collapse guards (data-safety review, 2026-07-26): listImageIds silently
  // returns [] for a MISSING images dir (a poisoned store pointer, a store on
  // a not-yet-downloaded Dropbox placeholder, mid-restore, ...). Without a
  // guard that reads as "the library now has 0 images", every one of the
  // mirror's existing images gets deleted below, an empty result still
  // verifies (0 manifest entries === 0 expected), and the freshest recovery
  // point is destroyed with no error raised. Unlike runBackup (which would
  // just create an ADDITIONAL, separately-named bad dated folder), this
  // function overwrites the one and only mirror in place, so it must fail
  // closed here.
  //
  // A MISSING images dir is the crisp, unambiguous form of this failure, and
  // the only one refused unconditionally. It is directly checkable rather than
  // inferred from a ratio, and — critically — it clears itself the moment the
  // dir exists again, so refusing here cannot wedge the mirror the way a stale
  // count baseline can (the baseline can never advance while the guard throws,
  // and since ensureBackupBeforeMerge gates every merge, a permanent throw
  // here silently stops ALL syncing). An EMPTY-but-present dir is a real,
  // observed state, not a broken pointer, so it falls through to the
  // proportional guard below instead.
  if (!fs.existsSync(srcImages) && prevImageCount > 0) {
    throw new Error("mirror: live images dir is missing (mirror has " + prevImageCount + " images) — refusing to update the mirror");
  }
  // Everything short of a missing dir -- including an emptied one -- is judged
  // proportionally, and gets an escape hatch: a real bulk dedup/cleanup reduces
  // the store's own card count roughly in step with its image count, in the
  // same operation. Images vanishing while the card count stays put means the
  // images disappeared out from under a stable library -- a broken/incomplete
  // images dir, not a user action -- and that is exactly the case this guard
  // exists to catch. Without the escape hatch, a single legitimate large
  // cleanup would wedge the mirror (and, since ensureBackupBeforeMerge runs it
  // before every merge, every subsequent sync) permanently: prevImageCount can
  // never advance past the stale baseline once the guard starts throwing.
  //
  // The >=100 floor keeps small libraries out of this entirely -- at low counts
  // the ratios are too coarse to mean anything (dropping the only image of a
  // 1-image library is a 100% "collapse"), and the blast radius of being wrong
  // is correspondingly small.
  if (prevImageCount >= 100 && ids.length < prevImageCount * 0.5) {
    // The card baseline comes from the mirror's own marker (now sidecar-backed,
    // so a torn run keeps it), and falls back to lastcounts.json — an
    // out-of-store witness written on every backup/restore, so it survives even
    // the mirror folder being tampered with. It must NEVER fall back to a value
    // derived from imageRatio: that makes the comparison below `x > x + 0.25`,
    // false for every input, silently disabling the guard entirely.
    let prevCardCount = prevMeta && prevMeta._counts ? ((prevMeta._counts.imported | 0) + (prevMeta._counts.saved | 0)) : 0;
    if (prevCardCount <= 0) {
      const lc = getLastCounts();
      if (lc) prevCardCount = (lc.cards | 0) + (lc.saved | 0);
    }
    const curCardCount = (c.cards | 0) + (c.saved | 0);
    const imageRatio = ids.length / prevImageCount;
    // With no baseline at all, there is nothing to judge proportionality
    // against, and a >50% image collapse against a >=100-image mirror is not a
    // state to guess about — fail closed. Recoverable by hand (delete the
    // mirror folder and it rebuilds cold); silently wiping it is not.
    const cardRatio = prevCardCount > 0 ? (curCardCount / prevCardCount) : 1;
    if (cardRatio > imageRatio + 0.25) {
      throw new Error("mirror: live image count collapsed " + prevImageCount + " -> " + ids.length +
        " without a matching drop in card count (" + prevCardCount + " -> " + curCardCount + ") — refusing to update the mirror");
    }
  }

  fs.mkdirSync(destImages, { recursive: true });
  // Sweep tmp db copies left behind by earlier failed runs before adding
  // another. Each is a full copy of the database, they are pid+timestamp
  // unique so they never self-overwrite, and nothing else collects them:
  // sweepOrphanedArtifacts only scans the backup ROOT for dot-prefixed names,
  // and the image manifest only matches *.jpg.
  try {
    for (const n of fs.readdirSync(destRoot)) {
      if (n.startsWith("interests.db.tmp.")) { try { fs.rmSync(path.join(destRoot, n), { force: true }); } catch (e) {} }
    }
  } catch (e) {}
  // Invalidate first: meta.json's absence is what marks the mirror torn, so it
  // must go before any mutation. Moved aside rather than deleted so the run's
  // baseline survives -- see readMirrorBaseline.
  const updatingPath = path.join(destRoot, MIRROR_UPDATING_META);
  try { fs.renameSync(metaPath, updatingPath); }
  catch (e) { try { fs.rmSync(metaPath, { force: true }); } catch (e2) {} }

  // Flush WAL pages into interests.db first — the on-disk file lags the -wal
  // sidecar while the live db is open, so copying without this captures a stale
  // db whose row counts will not match `cnt` (exactly what runBackup does, and
  // omitting it here made verification fail outright).
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  catch (e) { throw new Error("mirror WAL checkpoint failed: " + (e && e.message || e)); }

  const cnt = { imported: c.cards | 0, saved: c.saved | 0, images: imageCount(storeDir) | 0 };
  // Write the db to a tmp file and rename into place (same directory, so the
  // rename is atomic) rather than overwriting interests.db directly. meta.json
  // is already gone at this point, so a crash mid-copy already failed
  // verification either way — but a raw overwrite can leave interests.db
  // itself torn, which invalidates every image that update WOULD have left
  // intact. The tmp+rename makes that one crash window harmless too. Goes
  // through the same retry wrapper as every other rename in this file — this
  // one lands inside the Dropbox-synced backups folder too, and now runs
  // every ~3 minutes via ensureBackupBeforeMerge, not just once a day.
  const dbTmp = path.join(destRoot, "interests.db.tmp." + process.pid + "." + Date.now());   // matches the existing *.tmp.* .gitignore convention
  try {
    copyFileSync(path.join(storeDir, "interests.db"), dbTmp);
    renameSyncWithRetry(dbTmp, path.join(destRoot, "interests.db"));
  } finally {
    // On success the rename consumed it; on ANY failure it must not be left
    // behind — it is a full copy of the database, in the Dropbox-synced folder.
    try { fs.rmSync(dbTmp, { force: true }); } catch (e) {}
  }

  const live = Object.create(null);
  const manifest = [];
  let written = 0;
  const recheckCursor = (prevMeta && Number.isFinite(prevMeta._recheckCursor)) ? prevMeta._recheckCursor : 0;
  const recheckStart = ids.length ? (recheckCursor % ids.length) : 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const name = id + ".jpg";
    live[name] = 1;
    const bytes = fs.readFileSync(path.join(srcImages, name));
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const prev = prevByName[name];
    // Content decides, not mtime: a same-size same-time file can still differ.
    let needWrite = !prev || prev.sha256 !== sha || prev.size !== bytes.length;
    if (!needWrite) {
      const destPath = path.join(destImages, name);
      // The manifest says it matches, but the file itself must actually be there
      // and the right size -- guards against an externally deleted/truncated copy.
      let destSize = -1;
      try { destSize = fs.statSync(destPath).size; } catch (e) {}
      if (destSize !== bytes.length) needWrite = true;
      else {
        // Rotating self-heal (see MIRROR_RECHECK_SLICE): same size is not proof
        // of same bytes. Re-hash a bounded slice of "unchanged" files each run
        // so in-place corruption is actually caught and repaired, not just
        // silently trusted forever.
        const offset = (i - recheckStart + ids.length) % ids.length;
        if (offset < MIRROR_RECHECK_SLICE) {
          try {
            const destSha = crypto.createHash("sha256").update(fs.readFileSync(destPath)).digest("hex");
            if (destSha !== sha) needWrite = true;
          } catch (e) { needWrite = true; }
        }
      }
    }
    if (needWrite) { fs.writeFileSync(path.join(destImages, name), bytes); written++; }
    manifest.push({ name: name, size: bytes.length, sha256: sha });
  }
  const nextRecheckCursor = ids.length ? (recheckStart + MIRROR_RECHECK_SLICE) % ids.length : 0;

  // Drop images the live store no longer has, so the mirror stays an exact copy
  // rather than an ever-growing union.
  let removed = 0, unlinkFailures = 0;
  try {
    for (const n of fs.readdirSync(destImages)) {
      if (!n.endsWith(".jpg") || live[n]) continue;
      try { fs.unlinkSync(path.join(destImages, n)); removed++; } catch (e) { unlinkFailures++; }
    }
  } catch (e) {}

  manifest.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  fs.writeFileSync(path.join(destRoot, "snapshot.json"), JSON.stringify(buildPortableSnapshot(db)));
  // Count what is ACTUALLY on disk, not just what we intended to write. Both
  // `manifest.length` and `cnt.images` are derived from the SOURCE store, so
  // comparing them to each other cannot notice a failed unlink (a locked or
  // in-use file) leaving a stale image behind — which makes verifyBackup false
  // while this function returns success, i.e. a mirror reported fresh that
  // cannot actually be restored from.
  let destCount = -1;
  try { destCount = fs.readdirSync(destImages).filter(function (n) { return n.endsWith(".jpg"); }).length; } catch (e) {}
  if (manifest.length !== cnt.images || destCount !== cnt.images || !verifyDbOnly(path.join(destRoot, "interests.db"), cnt)) {
    throw new Error("mirror verification failed (manifest " + manifest.length + ", on disk " + destCount +
      ", expected " + cnt.images + (unlinkFailures ? ", " + unlinkFailures + " stale image(s) could not be deleted" : "") + ")");
  }
  fs.writeFileSync(metaPath, JSON.stringify({ _counts: cnt, _images: manifest, ts: Date.now(), _recheckCursor: nextRecheckCursor }));
  // Confirmed last: the marker is back, so the set-aside copy is now redundant.
  try { fs.rmSync(updatingPath, { force: true }); } catch (e) {}
  // Out-of-store witness for the 2026-07-17-incident store-collapse detector
  // (config.evaluateStoreSafety) — runBackup and restore() both refresh this on
  // every write; the mirror must too, or the baseline goes stale for up to a
  // week under the new weekly-full-snapshot cadence.
  try { recordLastCounts({ cards: cnt.imported, saved: cnt.saved }); } catch (e) {}
  return { name: MIRROR_NAME, counts: cnt, written: written, removed: removed, total: ids.length };
}

// The pre-merge safety gate sync uses. Always refreshes the cheap mirror (the
// actual "roll back this merge" recovery point), and additionally forces a full
// dated snapshot when the newest one has aged past intervalMs. Throws if the
// mirror cannot be verified, so sync fails closed and skips the merge.
function ensureBackupBeforeMerge(db, storeDir, opts) {
  opts = opts || {};
  const intervalMs = opts.fullSnapshotIntervalMs == null ? FULL_SNAPSHOT_INTERVAL_MS : opts.fullSnapshotIntervalMs;
  const now = opts.now == null ? Date.now() : opts.now;
  // The dated snapshot goes FIRST, and a mirror failure must not cancel it.
  // Running the mirror first meant one wedged mirror suppressed *every* backup
  // — including the weekly point-in-time snapshots, which do not share the
  // mirror's failure modes (runBackup stages under a fresh name and leaves the
  // previous good backup untouched). Losing the cheap recovery point must not
  // also lose the durable one.
  let full = null, fullError = null;
  if ((now - newestDatedSnapshotTime()) >= intervalMs) {
    try { full = runBackup(db, storeDir); }
    catch (e) { fullError = e; }
  }
  // Still throws through: sync's contract is "backup threw ⇒ skip the merge",
  // and the mirror is the recovery point for the merge about to happen.
  const mirror = updateMirror(db, storeDir);
  if (fullError) throw fullError;
  return { mirror: mirror, full: full };
}

function listBackups() {
  const root = dropboxBackupDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  return names
    .map(function (n) {
      const dated = DATED_BACKUP_NAME.exec(n);
      const safety = SAFETY_BACKUP_NAME.exec(n);
      // The mirror is a real, verifiable backup folder -- it must be offered for
      // restore like any other, otherwise the freshest recovery point is invisible.
      const mirror = (n === MIRROR_NAME);
      if (!dated && !safety && !mirror) return null;
      let isDir = false;
      try { isDir = fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { isDir = false; }
      if (!isDir) return null;
      const meta = readMeta(path.join(root, n));
      let sortTs;
      if (mirror) sortTs = (meta && meta.ts) || 0;
      else if (safety) sortTs = (+safety[1] || 0);
      else sortTs = Date.parse(dated[1] + "T00:00:00Z");
      return { name: n, date: dated ? dated[1] : new Date(sortTs).toISOString(), counts: meta ? meta._counts : null, safety: !!safety, mirror: mirror, sortTs: sortTs };
    })
    .filter(Boolean)
    .sort(function (a, b) { return b.sortTs - a.sortTs; });
}

// True iff the named backup has an integrity-checked database with matching
// row counts, a byte-exact image set (per-file sha256, not just a count match),
// and matching completion metadata.
function verifyBackup(name, expectedCounts) {
  if (!isValidBackupName(name)) return false;
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
  const list = listBackups();                 // newest-first, mixed: dated + safety + mirror
  if (!list.length) return;
  // Verification re-hashes every image in a folder, so it is scored LAZILY and
  // memoized: eagerly verifying the whole list re-hashed the mirror's ~6,000
  // images on every POST /api/backup, on the express handler. Only the newest
  // dated backup and the actual deletion candidates are ever scored.
  const verifiedCache = new Array(list.length);
  function isVerified(i) {
    if (verifiedCache[i] === undefined) {
      const b = list[i];
      verifiedCache[i] = b.counts ? verifyBackup(b.name, b.counts) : false;
    }
    return verifiedCache[i];
  }
  // The "is the newest backup trustworthy" gate must be scored over the DATED
  // backups specifically — pickBackupsToDelete only ever selects dated names,
  // so that's the only thing this function can delete. Gating on list[0]
  // meant an unrelated newer entry (the mirror, or a safety snapshot — both
  // sorted by wall-clock time and routinely newer than today's dated backup)
  // could freeze dated-backup rotation indefinitely even when every dated
  // backup was perfectly healthy. Data-safety review, 2026-07-26.
  const datedIdx = [];
  for (let i = 0; i < list.length; i++) { if (DATED_BACKUP_NAME.test(list[i].name)) datedIdx.push(i); }
  if (!datedIdx.length) return;                       // nothing dated to rotate
  if (!isVerified(datedIdx[0])) return;                // newest DATED backup is unverified → rotate nothing
  const candidates = pickBackupsToDelete(list.map(function (b) { return b.name; }), keep);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (candidates.indexOf(b.name) < 0) continue;   // within the keep window
    if (!isVerified(i)) continue;                    // don't delete an unverified backup
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
// Pattern for freezeMirrorForRestore's throwaway output — matched only by its
// own cleanup pass below, never by rotate()/sweepOrphanedArtifacts, so it
// can't be confused with a real dated/safety snapshot.
const MIRROR_FREEZE_NAME = /^interests-mirror-freeze-\d+$/;

// The mirror is never atomic while live — the sync worker (a genuine separate
// thread) can rewrite it in place at any moment (see updateMirror). Reading it
// directly across restore()'s multi-step, multi-file swap would risk
// restoring a partially-rewritten mirror, or racing a write mid-copy. Freeze
// it into a throwaway, independently-verified copy FIRST — built and hashed
// fresh, the same way a normal backup's stage step is — and have restore()
// read from that instead of the live mirror.
//
// This does not eliminate the race (this copy pass itself still reads a
// moving target) but narrows the window from "the whole restore" to "one
// copy pass", and any inconsistency introduced during that pass is caught by
// the verify below rather than silently propagating into the live store.
// Data-safety review, 2026-07-26.
function freezeMirrorForRestore() {
  const backupRoot = dropboxBackupDir();
  const liveMirror = path.join(backupRoot, MIRROR_NAME);

  // Read the live mirror's OWN completion marker FIRST, before touching
  // anything — this is the only independent evidence of what the mirror is
  // supposed to contain. Its absence means the mirror is mid-update or was
  // left torn by a crash (updateMirror deletes meta.json first, rewrites it
  // last), and must be refused outright — restoring from a folder with no
  // completion marker was the ORIGINAL restore()'s behavior before the
  // freeze step existed; this preserves it rather than silently deriving
  // "verification" entirely from what this function just copied itself,
  // which would rubber-stamp exactly the torn state it's supposed to catch.
  const liveMeta = readMeta(liveMirror);
  if (!liveMeta || !liveMeta._counts) {
    throw new Error("mirror has no completion marker (mid-update or left torn by a crash) — refusing to restore from it");
  }

  // Random suffix as well as the timestamp — two restores in the same
  // millisecond would otherwise collide on one folder (matches runBackup).
  const freezeName = "interests-mirror-freeze-" + Date.now() + Math.floor(Math.random() * 1000);
  const freezeRoot = path.join(backupRoot, freezeName);
  const freezeImages = path.join(freezeRoot, "images");
  fs.mkdirSync(freezeImages, { recursive: true });
  copyFileSync(path.join(liveMirror, "interests.db"), path.join(freezeRoot, "interests.db"));
  const ids = listImageIds(liveMirror);
  const manifest = copyImagesAndBuildManifest(imagesDir(liveMirror), freezeImages, ids);
  let dbCounts;
  try {
    const database = new DatabaseSync(path.join(freezeRoot, "interests.db"), { readOnly: true });
    try { dbCounts = counts(database); } finally { try { database.close(); } catch (e2) {} }
  } catch (e) { throw new Error("frozen mirror copy: unreadable database — " + (e && e.message || e)); }
  const cnt = { imported: dbCounts.cards | 0, saved: dbCounts.saved | 0, images: manifest.length };

  // Cross-check against the INDEPENDENT reference read before any copying
  // started. The mirror can be rewritten in place by the sync worker (a
  // genuine separate thread) at any moment, including during the copy above —
  // if that happened, what got copied no longer matches what the mirror had
  // last confirmed about itself, and that must be treated as untrustworthy
  // rather than re-verified purely against its own just-copied content.
  if (!backupCountsMatch(cnt, liveMeta._counts)) {
    throw new Error("mirror changed while freezing it for restore (expected " + JSON.stringify(liveMeta._counts) +
      ", got " + JSON.stringify(cnt) + ") — refusing to restore from an inconsistent copy");
  }

  if (!verifyDbOnly(path.join(freezeRoot, "interests.db"), cnt)) {
    throw new Error("frozen mirror copy failed to verify");
  }
  fs.writeFileSync(path.join(freezeRoot, "meta.json"), JSON.stringify({ _counts: cnt, _images: manifest, ts: Date.now() }));
  if (!verifyBackupFolder(freezeRoot, cnt)) {
    throw new Error("frozen mirror copy failed independent verification");
  }
  return freezeName;
}

function restore(name, ctx) {
  if (!isValidBackupName(name)) return { ok: false };
  // The mirror is a moving target — never read it directly across a
  // multi-step restore. Freeze it first; restore from the frozen copy instead
  // (see freezeMirrorForRestore). `name` (used for messages/rotation intent)
  // stays MIRROR_NAME; only the folder actually read from changes.
  let effectiveName = name;
  let didFreeze = false;
  if (name === MIRROR_NAME) {
    try { effectiveName = freezeMirrorForRestore(); didFreeze = true; }
    catch (e) { return { ok: false, error: "mirror freeze failed: " + (e && e.message || e) }; }
  }
  // Every exit below this point must still clean up the freeze folder — it is
  // a throwaway, near-full image-library copy sitting in the Dropbox-synced
  // backups folder, and every early return before this fix leaked one
  // (freeze folders were only ever rotated after a FULLY successful restore).
  try {
    return restoreFromFolder(effectiveName, ctx);
  } finally {
    // Delete THIS restore's freeze folder outright rather than rotating to a
    // keep window: rotateUnverifiedSnapshots keeps the NEWEST, which is exactly
    // the one just created, so a keep of 1 left a near-full image-library copy
    // behind after every mirror restore. The live store is already whole at
    // this point (restoreFromFolder took its own before-restore safety
    // snapshot), so this copy has no remaining value.
    if (didFreeze) {
      try { fs.rmSync(path.join(dropboxBackupDir(), effectiveName), { recursive: true, force: true }); } catch (e) {}
      // Defense in depth: sweep any freeze folders orphaned by an earlier crash.
      try { rotateUnverifiedSnapshots(dropboxBackupDir(), MIRROR_FREEZE_NAME, 0); } catch (e) {}
    }
  }
}

function restoreFromFolder(effectiveName, ctx) {
  const backupFolder = path.join(dropboxBackupDir(), effectiveName);
  let hasDb = false;
  try { hasDb = fs.statSync(path.join(backupFolder, "interests.db")).isFile(); } catch (e) { hasDb = false; }
  if (!hasDb) return { ok: false };
  const backupMeta = readMeta(backupFolder);
  // Verify the FOLDER we are actually about to read (backupFolder), not a
  // name-derived re-lookup — verifyBackup(name, ...) re-joins `name` onto the
  // backup root itself, which for the mirror case is MIRROR_NAME again (the
  // live, still-mutable folder), silently undoing the freeze above.
  if (!backupMeta || !verifyBackupFolder(backupFolder, backupMeta._counts)) return { ok: false, error: "backup not verified" };

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
  // Keep only the newest 2 before-restore snapshots — each is a near-full
  // image-library mirror and nothing else ever cleans these up.
  try { rotateUnverifiedSnapshots(dropboxBackupDir(), RESTORE_BACKUP_NAME, 2); } catch (e) {}
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

module.exports = { updateMirror, ensureBackupBeforeMerge, newestDatedSnapshotTime, MIRROR_NAME, FULL_SNAPSHOT_INTERVAL_MS, detectDropboxRoot, pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate, restore, moveStore, drainBackupBacklog, _timing: timing };
