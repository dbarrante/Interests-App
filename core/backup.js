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

// ---- orphaned RESTORE STAGE folders (next to the LIVE store) ---------------
// A restore stages the incoming backup into ".<storeBasename>.restage-<pid>-<ts>"
// as a SIBLING of the live store (see stageRestore), and swapInStagedRestore
// parks the displaced live content in that same name + ".old". Each is a
// near-full copy of the user's library — including an interests.db that holds
// ia_settings, i.e. the user's provider API key — sitting OUTSIDE the backup
// root, where sweepOrphanedArtifacts never looks.
//
// Three paths leave one behind permanently:
//   1. the staging worker DIES mid-copy (an OOM during the image copy is
//      realistic) — no JS catch ever runs in a dead thread, so stageRestore's
//      own cleanup never fires;
//   2. swapInStagedRestore's rollback path and
//   3. its reopen-failure path, both of which deliberately KEEP their folders
//      so a partial rollback stays recoverable by hand.
// (2) and (3) are correct at the moment they happen; the gap is that nothing
// ever swept them LATER, once the user had recovered. Same stale-mtime rule as
// sweepOrphanedArtifacts: only folders old enough that they cannot belong to a
// run still in flight.
function stageFolderPrefix(storeDir) { return "." + path.basename(storeDir) + ".restage-"; }
// Never delete near the LIVE store on a loose match (2026-07-19 near-miss
// discipline). A candidate qualifies only if it is a direct sibling of THIS
// exact storeDir and carries THIS exact store's stage prefix.
function isOwnStageFolder(candidate, storeDir) {
  if (typeof candidate !== "string" || !candidate || typeof storeDir !== "string" || !storeDir) return false;
  if (path.dirname(candidate) !== path.dirname(storeDir)) return false;
  return path.basename(candidate).indexOf(stageFolderPrefix(storeDir)) === 0;
}
function sweepOrphanedStageFolders(storeDir) {
  if (typeof storeDir !== "string" || !storeDir) return 0;
  const parent = path.dirname(storeDir);
  const prefix = stageFolderPrefix(storeDir);
  let names = [];
  try { names = fs.readdirSync(parent); } catch (e) { return 0; }
  const now = Date.now();
  let cleaned = 0;
  for (const n of names) {
    if (n.indexOf(prefix) !== 0) continue;   // scoped to this store's own stage folders (and their ".old" siblings)
    const full = path.join(parent, n);
    // The top folder's mtime stops advancing as soon as images/ exists, so a
    // long in-flight image copy would look stale by that mtime alone. Take the
    // NEWEST of the folder and its images/ subdir — the one an in-flight copy
    // keeps touching — so a running restore's own folder is never swept.
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch (e) { continue; }
    try { mtime = Math.max(mtime, fs.statSync(path.join(full, "images")).mtimeMs); } catch (e) {}
    if (now - mtime <= STALE_STAGING_MS) continue;
    try { fs.rmSync(full, { recursive: true, force: true }); cleaned++; } catch (e) {}
  }
  return cleaned;
}

// Cards+saved in a backup's recorded counts — the "how much library is in here"
// number the collapsed-newest guards compare.
function countsSize(c) { return c ? ((c.imported | 0) + (c.saved | 0)) : 0; }

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
  // Safety snapshots are (correctly) exempt from the store-sanity gate — their
  // whole job is to capture whatever state the store is in before a destructive
  // op. But that means a COLLAPSED store still produces them, and a 0-image
  // snapshot verifies (0 files matches 0 expected), so without this an emptied
  // store's two newest snapshots would evict every good pre-collapse one. The
  // 5-minute throttle means two destructive ops are enough. Never let a
  // materially SMALLER snapshot delete a materially larger one.
  const newestSize = countsSize(newestMeta._counts);
  let cleaned = 0;
  for (let i = keep; i < candidates.length && cleaned < MAX_CLEANUP_PER_CALL; i++) {
    const folder = path.join(backupRoot, candidates[i].name);
    const meta = readMeta(folder);
    if (!meta || !verifyBackupFolder(folder, meta._counts)) continue; // don't delete an unverified one
    const thisSize = countsSize(meta._counts);
    if (thisSize >= 100 && newestSize < thisSize * 0.1) continue;   // a collapsed newest must not evict a healthy older one
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
      // keep=0: a freeze folder is throwaway by construction and has no keep
      // window. rotateUnverifiedSnapshots keeps the NEWEST, so keep=1 here
      // guaranteed one near-full image-library copy survived every cleanup.
      + rotateUnverifiedSnapshots(backupRoot, MIRROR_FREEZE_NAME, 0);
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
  // Refuse to capture a visibly-incomplete store. A 0-image snapshot VERIFIES
  // (0 files matches 0 expected), becomes the newest dated backup, and thereby
  // unlocks rotate()'s "newest must verify" gate — deleting a genuinely good
  // older backup — while also making newestDatedSnapshotTime() report today,
  // suppressing the next real snapshot for a week. Skipped for the pre-cleanup
  // safety snapshot, whose entire job is to preserve whatever state the store is
  // in right now, sane or not, before a destructive op.
  if (!opts.safety) {
    assertStoreLooksSane({ db: db, storeDir: storeDir, what: "backup", curImages: cnt.images });
  }
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
  // Same idea, different location: restore stage folders live next to the LIVE
  // store, not in the backup root, so the sweep above cannot see them. This is
  // the recurring sweep that eventually collects a stage folder abandoned by a
  // worker that died mid-copy or by a rolled-back swap; runBackup already runs
  // off the main process (core/storeworker.js) and already has storeDir here.
  try { sweepOrphanedStageFolders(storeDir); } catch (e) {}

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
      // The new backup already published and verified above — removing the
      // displaced old copy is pure cleanup, not safety-critical. A transient
      // Dropbox lock here (EPERM/EBUSY/EACCES, the same class documented on
      // renameSyncWithRetry above) must not fail the whole backup call when
      // the backup itself already succeeded: swallow it and let
      // sweepOrphanedArtifacts's own next-call check (it already verifies the
      // canonical replacement before deleting) pick this exact leftover up.
      try { fs.rmSync(previousRoot, { recursive: true, force: true }); }
      catch (e) { console.warn("backup: displaced-copy cleanup deferred to next sweep (" + (e && e.code) + ")"); }
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
  recordLastCountsIfNotACollapse(cnt);
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

// Store-sanity gate for any path that copies the live store into a backup.
//
// SELF-RELATIVE by design: it compares what the DATABASE says should be on disk
// against what IS on disk, both read from the store as it exists right now. It
// keeps no historical baseline.
//
// That is the whole point. Earlier versions judged the store against the counts
// recorded in previous backups (the mirror's marker, the newest dated snapshot,
// lastcounts.json). Every one of those is written BY the backups this gate
// guards, so the moment it started refusing, none of them could advance and the
// refusal latched forever -- a user who clicked "Clear imported items" had all
// backups AND all syncing stopped permanently. Six review rounds produced five
// distinct data-loss regressions chasing that shape, including two attempts at
// an escape hatch that were themselves defective. A check with no history to go
// stale cannot latch, so it needs no escape hatch at all.
//
// What it catches: images vanishing out from under a library that still expects
// them -- a poisoned store pointer, an undownloaded Dropbox placeholder, a
// half-finished move. The mirror deletes destination images to match the source,
// so mirroring that state through would destroy the freshest recovery point.
//
// What it deliberately does NOT catch: a store legitimately emptied by the user,
// and a wholesale store swap. Both drop expected and actual together, so this
// gate is silent by construction. They are covered, with a human in the loop, by
// config.evaluateStoreSafety's boot check plus recordLastCountsIfNotACollapse
// below -- neither of which can block a backup, so neither can wedge anything.
//
// Throws on refusal; returns silently when the store looks sane.
function assertStoreLooksSane(o) {
  const what = o.what || "backup";
  const expected = expectedLocalImageCount(o.db);
  const actual = o.curImages | 0;
  // A missing images dir is the same failure in its crispest form. Checked
  // separately because listImageIds() reports [] for it, which is
  // indistinguishable from an empty dir by count alone.
  if (!fs.existsSync(imagesDir(o.storeDir)) && expected > 0) {
    throw new Error(what + ": live images dir is missing but the library expects " + expected +
      " images — refusing to write a backup");
  }
  // The >=100 floor keeps small libraries out: at low counts the ratio is too
  // coarse to mean anything, and the blast radius is correspondingly small.
  if (expected < 100 || actual >= expected * 0.5) return;
  throw new Error(what + ": the library expects " + expected + " images but only " + actual +
    " are on disk — refusing to write a backup (the store looks incomplete rather than intentionally emptied)");
}

// How many cards/saved items carry a LOCAL image file. img_file is non-null
// exactly when the item has one (core/db.js sets it from an "idb:" pointer), so
// this is the store's own statement of what images/ should contain -- http-hosted
// thumbnails correctly don't count.
function expectedLocalImageCount(db) {
  if (!db) return 0;
  let n = 0;
  try { n += db.prepare("SELECT COUNT(*) n FROM cards WHERE img_file IS NOT NULL").get().n | 0; } catch (e) {}
  try { n += db.prepare("SELECT COUNT(*) n FROM saved WHERE img_file IS NOT NULL").get().n | 0; } catch (e) {}
  return n;
}

// Refresh the out-of-store lastcounts.json witness, but NEVER let a routine
// backup overwrite it with a value that would itself have tripped the boot-time
// collapse detector (config.evaluateStoreSafety: cards under 10% of a >=100-card
// record). That detector is the only thing that catches a swapped or gutted
// store at startup, and the mirror now refreshes on every merge -- so without
// this, a cards-collapsed store silently erased the very evidence of the
// collapse within one sync cycle, and took the collapse guard's own card
// baseline down with it. Leaving the witness stale is the safe direction: it
// can only cause an extra prompt, never a missed one.
//
// Deliberately NOT used by restore(), where a large count change is the point.
function recordLastCountsIfNotACollapse(cnt) {
  try {
    const prev = getLastCounts();
    const nowCards = cnt.imported | 0;
    if (prev && (prev.cards | 0) >= 100 && nowCards < (prev.cards | 0) * 0.1) {
      console.error("backup: NOT refreshing lastcounts.json — cards collapsed " +
        (prev.cards | 0) + " -> " + nowCards + "; leaving the witness intact so the boot-time check still fires");
      return;
    }
    recordLastCounts({ cards: nowCards, saved: cnt.saved | 0 });
  } catch (e) {}
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
    // A totally empty snapshot is not a recovery point, and treating it as one
    // suppresses the next real snapshot for a full interval — so a store that
    // was briefly unreadable would go a week without a durable backup after it
    // healed. It verifies (0 files matches 0 expected), so only the counts
    // themselves distinguish it.
    const mc = meta._counts;
    if (mc && ((mc.imported | 0) + (mc.saved | 0) + (mc.images | 0)) === 0) continue;
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
  const c = counts(db);

  // Store-sanity gate: refuses when the live store's images are incomplete
  // relative to what its own database expects. See assertStoreLooksSane.
  assertStoreLooksSane({ db: db, storeDir: storeDir, what: "mirror", curImages: ids.length });

  // The gate above is self-relative, so it is silent when the store reads as
  // wholly EMPTY -- zero expected, zero present, internally consistent. That is
  // correct for a user who cleared their library, and indistinguishable from it
  // by counts alone. But it is also what a lost/replaced interests.db or a store
  // pointer aimed at a fresh directory looks like (openDb CREATEs the tables, so
  // any openable directory reads as a healthy empty library), and this function
  // mutates the ONE mirror IN PLACE -- it would unlink every image and overwrite
  // the db, leaving a result that still verifies and is byte-for-byte
  // indistinguishable from a healthy mirror. Master had no mirror to lose and
  // re-took a full dated backup every merge; here the next durable copy can be
  // up to FULL_SNAPSHOT_INTERVAL_MS old.
  //
  // So PRESERVE rather than refuse. Refusing is the shape that latched the
  // mirror in six earlier revisions of this guard; promoting always lets the
  // update proceed, so it cannot wedge anything. The displaced copy lands under
  // the pre-cleanup safety name, which rotate() can never select and
  // rotateNamedSnapshots keeps 2 of (with its own guard against a collapsed
  // newest evicting a healthy older one).
  //
  // Self-limiting: after the rename the mirror folder is gone, so the next run
  // sees no baseline and promotes nothing.
  // The card baseline must be a KNOWN number, not a fallback to the image count.
  // When the store's db is lost but its images remain, the rebuilt mirror is
  // {cards:0, images:N}: `prevImageCount` stays >= 100 forever, so falling back
  // to it re-promotes on EVERY merge — one permanent full-library folder plus a
  // full image rewrite every 3 minutes, i.e. exactly the churn this feature
  // removes, now unbounded. Fall back to the image count ONLY when _counts is
  // absent altogether (a torn baseline), where it is the only signal available.
  const prevKnownCards = prevMeta && prevMeta._counts
    ? ((prevMeta._counts.imported | 0) + (prevMeta._counts.saved | 0)) : null;
  const prevMirrorCards = prevKnownCards === null ? 0 : prevKnownCards;
  const worthPreserving = prevKnownCards === null ? (prevImageCount >= 100) : (prevKnownCards >= 100);
  if (((c.cards | 0) + (c.saved | 0)) === 0 && worthPreserving) {
    const promoted = path.join(backupRoot, "interests-backup-before-cleanup-" + Date.now() + "-" + crypto.randomBytes(6).toString("hex"));
    try {
      renameSyncWithRetry(destRoot, promoted);
      console.error("backup: live store reads empty but the mirror held " + prevMirrorCards + " cards / " +
        prevImageCount + " images — preserved it as " + path.basename(promoted) + " before rebuilding the mirror");
    } catch (e) {
      // Could not preserve it, so do NOT overwrite it either.
      throw new Error("mirror: live store reads empty but the mirror holds " + prevMirrorCards +
        " cards / " + prevImageCount + " images, and it could not be preserved (" + (e && e.message || e) + ")");
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
  recordLastCountsIfNotACollapse(cnt);
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
    catch (e) {
      fullError = e;
      // Logged here, not only rethrown: if updateMirror ALSO throws below, its
      // error is the one that propagates and this one would vanish silently.
      console.error("backup: overdue dated snapshot failed:", (e && e.message) || e);
    }
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
  // ...and a COLLAPSED newest must not evict good older ones either. A snapshot
  // of a store whose database was lost (no rows, images still on disk) verifies
  // perfectly well — its own file count matches its own manifest — so "newest
  // verifies" alone would unlock rotation and age out genuinely good backups.
  // Same guard rotateNamedSnapshots already applies to safety snapshots.
  //
  // Deliberately a ROTATION gate rather than a refusal to WRITE the snapshot:
  // refusing is the shape that latched this feature's guards through six
  // revisions (a store left with orphaned image files and no rows would be
  // refused forever, with no override), whereas declining to delete only ever
  // preserves and needs no escape hatch.
  const newestSize = countsSize(list[datedIdx[0]].counts);
  const candidates = pickBackupsToDelete(list.map(function (b) { return b.name; }), keep);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (candidates.indexOf(b.name) < 0) continue;   // within the keep window
    if (!isVerified(i)) continue;                    // don't delete an unverified backup
    const thisSize = countsSize(b.counts);
    if (thisSize >= 100 && newestSize < thisSize * 0.1) continue;   // never drop a healthy backup for a collapsed newest
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
  // ...and the CONTENT half of the same cross-check. Counts alone cannot see an
  // image corrupted in place at the same byte length: the copy reproduces the
  // bad bytes faithfully, hashes them into its own manifest, and then verifies
  // against that manifest — self-referential, so it always passes. The live
  // marker's per-file sha256 is the only independent record of what those bytes
  // are supposed to be. (updateMirror's rolling recheck slice also catches this,
  // but it only runs when updateMirror runs, which on a sync-off install is
  // never.) copyImagesAndBuildManifest already hashed every byte, so this costs
  // a map lookup per file, not another pass over the data.
  if (Array.isArray(liveMeta._images) && liveMeta._images.length) {
    const liveByName = Object.create(null);
    for (const e of liveMeta._images) { if (e && e.name) liveByName[e.name] = e; }
    for (const m of manifest) {
      const ref = liveByName[m.name];
      if (!ref) {
        throw new Error("frozen mirror copy contains an image the mirror's manifest does not list (" + m.name + ") — refusing to restore");
      }
      if (ref.sha256 && ref.sha256 !== m.sha256) {
        throw new Error("mirror image " + m.name + " does not match the mirror's own manifest hash (corrupted in place?) — refusing to restore from it");
      }
    }
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

// ---- restore write-witness ------------------------------------------------
// "Has the live store been written to since staging began?" Captured from the
// LIVE handle at the instant staging starts, re-checked against the live handle
// in the same synchronous block as the swap. A mismatch means the app took a
// write (a capture, an auto-import, an edit) while the restore was being
// prepared; swapping would delete it from the live store, and — because the
// pre-restore safety snapshot was taken BEFORE the write too — it would survive
// in no copy anywhere. So a mismatch aborts (see swapInStagedRestore).
//
// WHY NOT `PRAGMA data_version`, SQLite's purpose-built "did another connection
// change this database" counter — verified empirically under node:sqlite +
// Node 25 + WAL, not assumed:
//   * It is readable (db.prepare("PRAGMA data_version").get() → {data_version:N};
//     db.exec runs it but yields no value), so availability was never the issue.
//   * It deliberately does NOT change for commits made on the reading connection
//     itself (measured: 2 → 2 across the connection's own INSERT). Every
//     interleaved write we must catch arrives through ctx.db — the very handle
//     that would be doing the checking — so data_version is blind to exactly
//     the writes F1 is about.
//   * Its value is not comparable across connections (measured: one connection
//     reporting 3 while a fresh connection on the same file reports 2), and
//     stageRestore holds no connection at all, by design.
// getKV/counts on that same handle have the mirror-image property: they see the
// connection's own commits immediately. The primitive works precisely where
// SQLite's fails here.
//
// `rev` is core/db.js's durable ia_mutation_revision, bumped inside the writing
// transaction by every card/saved/tombstone/settings mutation path
// (upsertCard, upsertCardSynced, replaceCards, deleteCard, addTombstone,
// addNotDuplicateMarker, upsert/replace/deleteSaved, setKV for settings).
// Card/saved counts are belt-and-braces on top of it. `images` is a COUNT of
// the image files, so it catches image ADDITIONS and DELETIONS made by the
// standalone image routes (PUT/POST/DELETE /api/img/:id), which write files
// with no db mutation at all and so never move `rev`. It does NOT catch an
// in-place overwrite of an existing id (same count, different bytes) — a known,
// accepted blind spot; hashing the whole library on every restore is not worth
// it, and an in-place overwrite is in practice paired with a card write that
// moves `rev` anyway.
//
// ---- WITNESSED KV KEYS ------------------------------------------------------
// `rev` only moves for card/saved/tombstone writes and for the two SETTINGS kv
// keys (see core/db.js setKV). Every OTHER kv write is invisible to it, and some
// of those rows are durable, non-self-healing user data — a reproduced case of
// the same F1 loss shape. So the witness also watches this TARGETED list.
//
// It is deliberately NOT "did any kv row change". Several kv keys are pure
// operational churn — ia_health (stamps a fresh ts on every check), the sync
// status keys, auto-import's ledger/last keys, ia_batch_progress/ia_batch_state,
// and derived caches like ia_imghash / ia_imgocr / ia_ph_fps. Watching those
// would make a restore abort perpetually while the app is merely open, turning
// a data-loss bug into a liveness failure where a restore can never succeed.
//
// THE LOAD-BEARING PROPERTY: this compares kv rows BY VALUE, not by "was this
// row written". core/capture-queue.js writes the mailbox row on every idle
// drain poll whenever the queue is non-empty, and web/index.html's persistAll()
// re-saves all eight of its arrays on every user action whether or not they
// changed. A write-EVENT trigger would abort spuriously on both.
//
// Value alone is not enough for the mailbox, though — see captureQueueDigest.
//
// Included, and why each is durable user data with no self-heal:
//   ia_capture_queue — the extension capture mailbox. Captures sitting undrained
//     at the instant of the check exist NOWHERE else, so a swap destroys them.
//     This is also the funnel every platform auto-import run's real items pass
//     through (core/autoimport.js writes survivors here), which is why
//     auto-import's own ia_autoimport_seen_* / ia_autoimport_last_* keys are NOT
//     listed: only a zero-yield run leaves them unwitnessed, and those genuinely
//     do self-heal (the items are re-scraped on the next run).
//   ia_hidden / ia_clicks / ia_likes / ia_disliked / ia_shown / ia_seen /
//     ia_spool — the taste signals persistAll() writes. Core learned state;
//     re-deriving them would mean the user re-rating everything.
//
// Deliberately excluded despite being written by that same persistAll():
//   ia_stdeal — the current stumble deck, regenerable, and excluding it costs
//     nothing: any persistAll() that changed a real taste signal trips the
//     witness on that signal regardless.
const WITNESSED_KV_KEYS = [
  "ia_capture_queue", "ia_bstumble_feedback",
  "ia_hidden", "ia_clicks", "ia_likes", "ia_disliked", "ia_shown", "ia_seen", "ia_spool",
  "ia_tabs",
];
// ia_tabs is the user's custom tab definitions — durable, user-CREATED, written
// only by tab CRUD (web/index.html's save("tabs", …)), and not self-healing:
// a tab lost to a swap is gone. ia_bstumble_feedback is the extension's 👍/👎
// vote mailbox — the same drain-on-read class as ia_capture_queue (POST
// appends, the renderer's GET returns AND clears), so a vote that lands during
// staging is destroyed by the swap with no copy anywhere.
//
// ia_bstumble_feedback is witnessed by its RAW value, not by a payload-identity
// digest: unlike ia_capture_queue it carries NO lease metadata, so nothing
// churns the row on its own. web/index.html's drainBrowserFeedback runs every
// 3s, but /api/bstumble/feedback's GET only writes when the queue is NON-empty
// (`if (q.length) setKV(…, "[]")`) — an empty mailbox is byte-stable across
// every poll, and a drain of a non-empty one IS a real state change (the votes
// move into ia_likes/ia_hidden, themselves witnessed). It also self-clears:
// once drained the row is "[]" and stays put, so this cannot wedge a restore
// the way an unconditional re-lease could.
// ia_capture_queue is digested by PAYLOAD IDENTITY (queueId + the capture
// itself) rather than by the raw row, because the row carries lease metadata
// that churns without any data being at risk. captureQueue.claim() — which
// web/index.html runs every 3s — assigns a FRESH random leaseId to every entry
// that is unleased or whose lease expired, so the raw row is byte-identical
// only while ALL entries are leased and unexpired. Measured: a claim over one
// just-enqueued capture changes the row; the next claim does not.
//
// Without this, a capture merely PENDING at witness-capture time would abort
// every restore on the next 3s poll, and one the UI claims but never acks would
// re-lease every 5 minutes and abort restores indefinitely — the "restore can
// never succeed" liveness failure this targeted list exists to avoid. Such a
// capture predates staging, so it IS in the pre-restore safety snapshot; it is
// exactly the content the user asked the restore to replace, not the
// arrived-during-staging write F1 is about.
//
// What still trips it: a new enqueue (a new queueId appears) and an ack (a
// queueId disappears) — both real changes to what is in the mailbox.
// Anything unparseable or not in the envelope shape falls back to the raw
// value, which is the stricter compare, so a corrupt or legacy mailbox stays
// fail-closed.
function captureQueueDigest(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!Array.isArray(parsed)) return null;
  const parts = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || item._queueEntry !== 1 || typeof item.queueId !== "string") return null;
    try { parts.push(item.queueId + ":" + JSON.stringify(item.capture)); } catch (e) { return null; }
  }
  return parts.join("\n");
}
// A digest rather than the raw values: the witness crosses the worker boundary
// by structured clone, and ia_capture_queue alone is allowed up to 64MB.
// Absent (no row) and present-but-empty are distinguished — jsonKvEndpoints
// writes a literal "" to clear a key, which is a real state change.
function kvWitness(db) {
  const out = {};
  for (const key of WITNESSED_KV_KEYS) {
    const raw = getKV(db, key);
    if (raw == null) { out[key] = "-"; continue; }
    let material = String(raw);
    if (key === "ia_capture_queue") {
      const identity = captureQueueDigest(material);
      if (identity !== null) material = "id\n" + identity;
    }
    out[key] = "h" + crypto.createHash("sha1").update(material).digest("hex");
  }
  return out;
}
function storeWitness(db, storeDir) {
  const c = counts(db);
  return {
    rev: Number(getKV(db, "ia_mutation_revision") || 0) || 0,
    cards: c.cards | 0,
    saved: c.saved | 0,
    images: imageCount(storeDir) | 0,
    kv: kvWitness(db),
  };
}
function witnessMatches(a, b) {
  if (!a || !b) return false;
  if (a.rev !== b.rev || a.cards !== b.cards || a.saved !== b.saved || a.images !== b.images) return false;
  // Fail CLOSED on a witness that predates the kv dimension (or lost it crossing
  // a boundary): an absent kv map means we cannot prove the kv rows are unchanged.
  if (!a.kv || !b.kv || typeof a.kv !== "object" || typeof b.kv !== "object") return false;
  for (const key of WITNESSED_KV_KEYS) { if (a.kv[key] !== b.kv[key]) return false; }
  return true;
}

// Stage a restore off the main thread: freeze the mirror if needed, verify the
// source backup, take the pre-restore safety snapshot of the CURRENT live
// store, and stage the incoming backup's db+images into a scratch folder next
// to storeDir.
//
// This is ALL of the slow work, and it is deliberately PURE, PATH-BASED I/O:
// it takes a storeDir string, never a ctx, and never opens, reads, writes or
// closes a live database handle. That is what makes it safe to run inside a
// worker thread (see core/storeworker.js) — restore used to do the copy
// synchronously on the Electron main process with ctx.db closed throughout,
// which froze the native window for the whole image-library copy.
//
// Nothing here mutates the live store. If any step fails, the live store is
// exactly as it was and the caller simply never gets a stageFolder to swap in.
//
// CALLER CONTRACT: flush the live db's WAL (PRAGMA wal_checkpoint(TRUNCATE))
// before calling this. Having no db handle is exactly what makes this safe to
// run off-thread, but it also means the pre-restore safety snapshot below can
// only copy what is IN the interests.db file — in WAL mode recent writes (and,
// on a freshly created store, the schema itself) live in the -wal sidecar, so
// an unflushed snapshot silently under-captures the state it exists to
// preserve. core/server.js's /api/restore route does the checkpoint.
//
// `witness` is storeWitness(ctx.db, storeDir), captured by the CALLER from the
// live handle just before staging begins (right after that checkpoint), and
// merely CARRIED through here — stageRestore cannot capture it itself precisely
// because it holds no db handle. Carrying it in the staged result is what makes
// swapInStagedRestore structurally unable to run without one; it crosses the
// worker boundary as a plain object of numbers.
function stageRestore(name, storeDir, witness) {
  if (!isValidBackupName(name)) return { ok: false };
  // The mirror is a moving target — never read it directly across a
  // multi-step restore. Freeze it first; restore from the frozen copy instead
  // (see freezeMirrorForRestore). `name` (used for messages/rotation intent)
  // stays MIRROR_NAME; only the folder actually read from changes.
  let effectiveName = name;
  let didFreeze = false;
  let stagedSoFar = null;   // set once the stage folder exists; see the catch below
  if (name === MIRROR_NAME) {
    try { effectiveName = freezeMirrorForRestore(); didFreeze = true; }
    catch (e) { return { ok: false, error: "mirror freeze failed: " + (e && e.message || e) }; }
  }
  // Every exit below this point must still clean up the freeze folder — it is
  // a throwaway, near-full image-library copy sitting in the Dropbox-synced
  // backups folder, and every early return before this fix leaked one
  // (freeze folders were only ever rotated after a FULLY successful restore).
  try {
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
    // If snapshotting the live db FAILS, abort BEFORE staging anything — a
    // restore that can't first preserve current data must not proceed at all.
    // It lives here, not on the main thread, because it does its own
    // full-image-library copy exactly like the staging copy below does.
    const snapName = "interests-backup-before-restore-" + Date.now();
    const snapFolder = path.join(dropboxBackupDir(), snapName);
    fs.mkdirSync(path.join(snapFolder, "images"), { recursive: true });
    try {
      fs.copyFileSync(path.join(storeDir, "interests.db"), path.join(snapFolder, "interests.db"));
    } catch (e) {
      return { ok: false, error: "safety snapshot failed" };
    }
    overlayImages(path.join(storeDir, "images"), path.join(snapFolder, "images"));

    // 2) stage the incoming backup on LOCAL disk next to the live store (not
    // inside the Dropbox-synced backups folder) so the swap step is a fast
    // same-volume rename, not a slow cross-location copy, and is immune to the
    // Dropbox-sync lock class documented on renameSyncWithRetry above. A dot
    // prefix keeps it out of the way; pid+timestamp keeps two concurrent
    // attempts (or a leftover from a crash) from colliding.
    //
    // Clear a genuinely-orphaned stage folder from an earlier crashed run
    // BEFORE staging a new one — a worker killed mid-copy leaves one that no
    // catch in this function can ever reach. Best-effort and never allowed to
    // fail the restore: a Dropbox/AV lock (EBUSY) on a leftover copy must not
    // block a legitimate restore, and the stale-mtime rule inside the sweep
    // keeps it away from anything a run still in flight could own.
    try { sweepOrphanedStageFolders(storeDir); } catch (e) {}
    const token = process.pid + "-" + Date.now();
    const stageFolder = path.join(path.dirname(storeDir), stageFolderPrefix(storeDir) + token);
    // Deliberately NOT {recursive:true} at the top level: recursive mkdir
    // silently ADOPTS whatever is already at this guessable (pid+ms) path —
    // including a pre-planted directory or an NTFS junction pointing somewhere
    // else entirely. Plain mkdirSync fails closed with EEXIST instead. A
    // same-pid-same-millisecond leftover is not a realistic false failure.
    fs.mkdirSync(stageFolder);
    // Only ours to clean up once WE are the ones who created it — an EEXIST
    // above must not send the catch below into rm'ing a folder we refused.
    stagedSoFar = stageFolder;
    fs.mkdirSync(path.join(stageFolder, "images"));
    fs.copyFileSync(path.join(backupFolder, "interests.db"), path.join(stageFolder, "interests.db"));
    // Copy exactly the images the backup's own verified manifest lists.
    // verifyBackupFolder above already proved the folder's on-disk .jpg set is
    // exactly _images (same names, sizes and hashes), so this is equivalent to
    // the old blanket overlayImages sweep, minus the re-read.
    const ids = (backupMeta._images || []).map(function (m) { return String(m.name || "").replace(/\.jpg$/, ""); });
    const manifest = copyImagesAndBuildManifest(imagesDir(backupFolder), path.join(stageFolder, "images"), ids);
    // 3) verify the STAGED copy before it is allowed anywhere near the live
    // store. Anything short of a complete, integrity-checked stage is thrown
    // away here rather than swapped in.
    if (manifest.length !== (backupMeta._counts.images | 0) || !verifyDbOnly(path.join(stageFolder, "interests.db"), backupMeta._counts)) {
      try { fs.rmSync(stageFolder, { recursive: true, force: true }); } catch (e) {}
      return { ok: false, error: "staged restore failed to verify" };
    }
    stagedSoFar = null;   // handed to the caller — no longer ours to clean up
    // snapshotFolder travels with the result ONLY so an aborted swap can clear
    // this restore attempt's now-pointless safety snapshot (see
    // swapInStagedRestore). Failure returns deliberately stay bare {ok:false} —
    // the route relays them verbatim and callers match on that exact shape.
    //
    // storeDir travels with the result so swapInStagedRestore can prove it is
    // applying this content to the store it was staged FROM (see there). Only
    // on the SUCCESS object — failures stay bare {ok:false}, which is the shape
    // /api/restore relays to the client, so no path is added to a response.
    return { ok: true, stageFolder: stageFolder, snapshotFolder: snapFolder, witness: witness, storeDir: storeDir };
  } catch (e) {
    // A stage folder abandoned mid-copy is a near-full copy of the user's
    // library (db + images) sitting next to the live store where NOTHING
    // sweeps it — sweepOrphanedArtifacts only scans the backup root. Clean it
    // up on the throw path too, not just the verify-failure path above.
    if (stagedSoFar) { try { fs.rmSync(stagedSoFar, { recursive: true, force: true }); } catch (e2) {} }
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    // Delete THIS restore's freeze folder outright rather than rotating to a
    // keep window: rotateUnverifiedSnapshots keeps the NEWEST, which is exactly
    // the one just created, so a keep of 1 left a near-full image-library copy
    // behind after every mirror restore. The live store is untouched and the
    // before-restore safety snapshot is already written at this point, so this
    // copy has no remaining value.
    if (didFreeze) {
      try { fs.rmSync(path.join(dropboxBackupDir(), effectiveName), { recursive: true, force: true }); } catch (e) {}
      // Defense in depth: sweep any freeze folders orphaned by an earlier crash.
      try { rotateUnverifiedSnapshots(dropboxBackupDir(), MIRROR_FREEZE_NAME, 0); } catch (e) {}
    }
  }
}

// The ONLY main-thread-only step: close ctx.db, swap the already-verified
// staged content into place via fast directory renames (not copies — the slow
// work already happened in stageRestore), reopen ctx.db. The displaced OLD
// live content is renamed aside and kept until the swap is confirmed (the same
// "keep the displaced copy until the replacement verifies" posture runBackup's
// own publish step uses), so a failure here rolls the live store back to
// exactly what it was and leaves ctx.db a live, usable handle.
//
// Takes the WHOLE result object returned by stageRestore (not a bare folder
// path) so the write-witness captured at staging time travels with the staged
// content and this step cannot be run without one.
function swapInStagedRestore(staged, ctx) {
  const stageFolder = staged && staged.stageFolder;
  const before = staged && staged.witness;
  // Fail CLOSED: without a stage folder and a witness there is nothing safe to
  // do, so refuse rather than swap unverified. ctx.db is untouched here.
  if (typeof stageFolder !== "string" || !stageFolder || !before) {
    return { ok: false, error: "restore swap refused: the staged result is missing its stage folder or its write-witness" };
  }
  // The staged content must belong to the store we are about to apply it TO.
  // /api/restore and /api/store-location/move share the worker's exclusive()
  // queue, but only the WORKER halves serialize — each route's main-thread
  // continuation runs on its own, so a move that repoints ctx.storeDir between
  // a restore's staging and its swap would otherwise have this apply content
  // staged for the OLD directory onto the NEW one. That is benign today only
  // because moveStore leaves the two directories content-identical — an
  // incidental property of moveStore, not a guarantee this function makes.
  // Make it one. Raw === is right: ctx.storeDir is the very string that was
  // passed into staging, so any difference means it was repointed.
  if (staged.storeDir !== ctx.storeDir) {
    return { ok: false, error: "restore swap refused: the staged content was prepared for a different data folder than the one now in use (the store was moved while the restore was being prepared) — nothing was changed, please run the restore again" };
  }

  // ---- WRITE-WITNESS RE-CHECK (F1) ----------------------------------------
  // Staging now happens off-thread and can take minutes on a large image
  // library, so the event loop is free the whole time and the app keeps taking
  // writes through ctx.db. Anything written in that window is NOT in the staged
  // content and NOT in the pre-restore safety snapshot (both predate it), so
  // swapping would destroy it with no copy left anywhere. Abort instead.
  //
  // EVERYTHING from here to the rename sequence below must stay in ONE
  // synchronous block — no await, no async, no callback boundary. That is the
  // only thing that makes the check meaningful: another HTTP handler is just
  // more main-thread JS and cannot interleave with straight-line code. This
  // holds for the kv dimension too: storeWitness -> kvWitness is plain
  // getKV + crypto.createHash, both synchronous, with no worker round-trip.
  let now = null;
  try { now = storeWitness(ctx.db, ctx.storeDir); } catch (e) { now = null; }   // unreadable → treat as changed
  if (!witnessMatches(before, now)) {
    // Live store completely untouched: no close, no reopen, no rename has run.
    // ctx.db is still the same live, usable handle it was on entry.
    //
    // These two rmSyncs are deliberately SYNCHRONOUS even though each can be a
    // near-full image-library copy. A fire-and-forget async rm would make the
    // abort's "nothing is left behind" property racy and unobservable, which is
    // exactly the weaker guarantee F3 was raised to close, and a
    // rename-to-be-swept scheme needs a sweeper next to the live store that does
    // not exist (auto-deleting near the store is its own design pass). This
    // runs at the tail of a user-initiated restore that has already spent
    // minutes staging — not on the launch path this refactor exists to unblock.
    //
    // Name-guarded exactly like the snapshot delete below it: this one deletes
    // a folder sitting NEXT TO THE LIVE STORE, so it must be provably one
    // stageRestore itself created (same 2026-07-19 discipline).
    if (isOwnStageFolder(stageFolder, ctx.storeDir)) {
      try { fs.rmSync(stageFolder, { recursive: true, force: true }); } catch (e) {}
    }
    // Drop this attempt's safety snapshot too: the live store was never
    // modified, so it protects nothing, and leaving it would both look like a
    // completed restore and burn one of the two slots rotation keeps for real
    // ones. Name-guarded before deleting — this path deletes inside the
    // Dropbox-synced backup root, so it must be provably scoped to a folder
    // stageRestore itself created (2026-07-19 near-miss discipline). A failed
    // delete never changes the outcome.
    const snap = staged.snapshotFolder;
    if (typeof snap === "string" && RESTORE_BACKUP_NAME.test(path.basename(snap))) {
      try { fs.rmSync(snap, { recursive: true, force: true }); } catch (e) {}
    }
    return { ok: false, error: "restore aborted: the app wrote to your library while the restore was being prepared (a new capture, an edit, or a rating), and applying it now would discard that — nothing was changed, please run the restore again" };
  }

  // close the live db so the file can be replaced (Windows holds an exclusive handle)
  try { ctx.db.close(); } catch (e) {}
  // also drop WAL/SHM sidecars so the restored db isn't shadowed by stale WAL pages
  for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(path.join(ctx.storeDir, "interests.db" + ext), { force: true }); } catch (e) {} }
  // A store with no images/ dir yet is legitimate (nothing has been captured).
  // Without this the rename below would hit a non-transient ENOENT and refuse
  // an otherwise perfectly good restore; the old copy-based swap tolerated it.
  try { fs.mkdirSync(path.join(ctx.storeDir, "images"), { recursive: true }); } catch (e) {}

  // Renaming the live content aside (rather than deleting it) is what makes the
  // failure path recoverable: until the very last rename lands, the original
  // db + images are one rename away from being back.
  const oldAside = stageFolder + ".old";
  try {
    // Non-recursive for the same reason as the stage folder itself: this path
    // is guessable (it is the stage token + ".old"), and a recursive mkdir
    // would silently adopt a pre-existing directory or junction and then
    // rename the user's live db+images INTO it. EEXIST here lands in the catch
    // below, which rolls back and leaves the live store exactly as it was.
    fs.mkdirSync(oldAside);
    renameSyncWithRetry(path.join(ctx.storeDir, "interests.db"), path.join(oldAside, "interests.db"));
    renameSyncWithRetry(path.join(ctx.storeDir, "images"), path.join(oldAside, "images"));
    renameSyncWithRetry(path.join(stageFolder, "interests.db"), path.join(ctx.storeDir, "interests.db"));
    renameSyncWithRetry(path.join(stageFolder, "images"), path.join(ctx.storeDir, "images"));
  } catch (e) {
    // Roll the ORIGINAL live content back into place. rename replaces an
    // existing destination on both Windows and POSIX, so this is correct even
    // if the staged db already landed before the staged images failed.
    try { renameSyncWithRetry(path.join(oldAside, "interests.db"), path.join(ctx.storeDir, "interests.db")); } catch (e2) {}
    try { renameSyncWithRetry(path.join(oldAside, "images"), path.join(ctx.storeDir, "images")); } catch (e2) {}
    // Deliberately leave stageFolder and oldAside on disk: if the rollback
    // itself was partial, they are the only remaining copies of that content.
    try { ctx.db = ctx.reopen(); } catch (e2) {}
    return { ok: false, error: "restore swap failed: " + (e && e.message) };
  }
  // Reopen BEFORE discarding the displaced originals. If reopening throws (an
  // AV scanner or a transient EBUSY on the just-renamed file), deleting first
  // would have thrown away the only copies of the pre-restore store while
  // leaving ctx.db closed. Keep both holding folders in that case so the state
  // is still recoverable by hand, and report it rather than throwing.
  try {
    ctx.db = ctx.reopen();
  } catch (e) {
    return { ok: false, error: "restore swapped in but reopening the store failed (pre-restore content kept at " + oldAside + "): " + ((e && e.message) || e) };
  }
  // Confirmed: the live store is now an exact copy of the backup (the old
  // images went aside wholesale, so no orphan from the replaced db survives).
  // Both are next to the live store, so both take the same name guard as the
  // abort path above (they always pass — each is derived from stageFolder,
  // which the precondition already tied to ctx.storeDir — which is exactly
  // what makes the guard free to apply consistently).
  if (isOwnStageFolder(oldAside, ctx.storeDir)) {
    try { fs.rmSync(oldAside, { recursive: true, force: true }); } catch (e) {}
  }
  if (isOwnStageFolder(stageFolder, ctx.storeDir)) {
    try { fs.rmSync(stageFolder, { recursive: true, force: true }); } catch (e) {}
  }

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
//
// opts.persistPointer (default TRUE — the direct, main-thread path in
// core/server.js keeps behaving exactly as it always has) controls step 3.
// Pass FALSE when running inside core/storeworker.js's worker thread: the ctx
// there is a THROWAWAY built per-run and closed when the thread exits, but
// setStorePath writes the app's ONE durable %APPDATA% store pointer, which is
// process-wide, not ctx-scoped. Persisting it from the worker meant a move
// whose ctx.reopen() then threw (a transient EBUSY/AV lock on the just-written
// db) resolved {ok:false} — the route correctly declined to repoint the REAL
// ctx, so the running app kept serving the OLD store, while the durable
// pointer already said `target`: the next launch silently opened the new store
// and every write made in between was gone. With persistPointer:false the
// route is the SOLE writer of that pointer (core/server.js's
// /api/store-location/move), and only after the new location has proven it
// opens.
//
// NOTE: the copy+verify above step 3 is unaffected — verification still opens
// the target db and compares counts, so `false` only skips the repoint.
function moveStore(target, ctx, opts) {
  const persistPointer = !opts || opts.persistPointer !== false;
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

  // 3) verified → repoint + reopen; OLD store files are left on disk.
  // Skipped entirely under persistPointer:false — the caller (the route, on the
  // main thread) owns both the durable pointer and the real ctx in that mode.
  if (!persistPointer) return { ok: true, path: target };
  try { ctx.db.close(); } catch (e) {}
  setStorePath(target);
  ctx.storeDir = target;
  ctx.db = ctx.reopen();
  return { ok: true, path: target };
}

// witnessMatches is exported for /api/store-location/move: the move's
// write-witness re-check happens in the ROUTE (the only place holding the real
// ctx.db), exactly as restore's happens inside swapInStagedRestore.
module.exports = { updateMirror, ensureBackupBeforeMerge, newestDatedSnapshotTime, MIRROR_NAME, FULL_SNAPSHOT_INTERVAL_MS, detectDropboxRoot, pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate, storeWitness, witnessMatches, stageRestore, swapInStagedRestore, moveStore, drainBackupBacklog, sweepOrphanedStageFolders, _timing: timing };
