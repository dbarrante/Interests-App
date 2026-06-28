"use strict";
const fs = require("fs");
const path = require("path");
const db = require("./db");
const images = require("./images");
const backup = require("./backup");
const config = require("./config");
const { mergeSnapshots } = require("./merge");

function defaultSyncDir() {
  const root = backup.detectDropboxRoot();
  return root ? path.join(root, "Interests App", "sync") : null;
}

// Other devices' folders inside syncDir (skip self + non-directories).
function peerDirs(syncDir, selfDeviceId) {
  let names = [];
  try { names = fs.readdirSync(syncDir); } catch (e) { return []; }
  return names
    .filter(function (n) { return n !== selfDeviceId; })
    .map(function (n) { return { deviceId: n, dir: path.join(syncDir, n) }; })
    .filter(function (p) { try { return fs.statSync(p.dir).isDirectory(); } catch (e) { return false; } });
}

// Atomic write: write to a .tmp sidecar then rename into place.
// On the same volume, rename is atomic — Dropbox never sees a torn file.
function _writeAtomic(file, text) {
  const tmpFile = file + ".tmp";
  fs.writeFileSync(tmpFile, text);
  fs.renameSync(tmpFile, file);
}

// Publish a snapshot of the local library into <syncDir>/<deviceId>/.
// Write order: images (incremental) → snapshot.json → meta.json (LAST).
// meta.json is the completion marker; its presence signals a full, trustworthy snapshot.
function publishSnapshot(ctx, syncDir, deviceId, deviceLabel) {
  const folder = path.join(syncDir, deviceId);
  const destImages = path.join(folder, "images");
  fs.mkdirSync(destImages, { recursive: true });

  // Flush WAL so serializeLibrary reflects the latest committed writes.
  try { ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}

  const lib = db.serializeLibrary(ctx.db);
  const c = db.counts(ctx.db);
  const counts = { cards: c.cards | 0, saved: c.saved | 0, images: images.imageCount(ctx.storeDir) | 0 };

  // 1) images first (incremental — only new/changed vs our own folder)
  const srcImages = images.imagesDir(ctx.storeDir);
  for (const id of backup.changedImageIds(ctx.storeDir, destImages)) {
    try { fs.copyFileSync(path.join(srcImages, id + ".jpg"), path.join(destImages, id + ".jpg")); } catch (e) {}
  }

  // 2) snapshot.json (atomic)
  const snapshot = {
    schemaVersion: db.SCHEMA_VERSION,
    deviceId: deviceId,
    deviceLabel: deviceLabel,
    publishedAt: Date.now(),
    cards: lib.cards,
    saved: lib.saved,
    fp: lib.fp,
    tombstones: lib.tombstones,
  };
  _writeAtomic(path.join(folder, "snapshot.json"), JSON.stringify(snapshot));

  // 3) meta.json LAST (the completion marker)
  _writeAtomic(path.join(folder, "meta.json"), JSON.stringify({
    schemaVersion: db.SCHEMA_VERSION,
    deviceId: deviceId,
    deviceLabel: deviceLabel,
    publishedAt: snapshot.publishedAt,
    counts: counts,
  }));

  return { name: deviceId, counts: counts };
}

// Read a peer/own snapshot folder.
// Returns null unless meta.json is present AND its counts match snapshot.json
// (guards against a half-synced Dropbox folder — a torn write must be rejected).
function readSnapshot(folder) {
  var meta, snap;
  try { meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")); } catch (e) { return null; }
  try { snap = JSON.parse(fs.readFileSync(path.join(folder, "snapshot.json"), "utf8")); } catch (e) { return null; }
  if (!meta || !snap || !meta.counts) return null;
  if ((snap.cards || []).length !== (meta.counts.cards | 0)) return null;
  if ((snap.saved || []).length !== (meta.counts.saved | 0)) return null;
  var imageIds = [];
  try {
    imageIds = fs.readdirSync(path.join(folder, "images"))
      .filter(function (n) { return n.endsWith(".jpg"); })
      .map(function (n) { return n.slice(0, -4); });
  } catch (e) { imageIds = []; }
  return {
    schemaVersion: snap.schemaVersion,
    deviceId: snap.deviceId,
    deviceLabel: snap.deviceLabel,
    publishedAt: snap.publishedAt,
    cards: snap.cards || [],
    saved: snap.saved || [],
    fp: snap.fp || {},
    tombstones: snap.tombstones || [],
    imageIds: imageIds,
  };
}

function readPeerSnapshots(syncDir, selfDeviceId) {
  return peerDirs(syncDir, selfDeviceId)
    // Thread the REAL on-disk folder path (p.dir) — NOT the snapshot's
    // self-asserted deviceId — so mergeSnapshots/applyMerge copy images from the
    // trustworthy folder we actually read, never a JSON-controlled redirection.
    .map(function (p) { var s = readSnapshot(p.dir); return s ? Object.assign({}, s, { dir: p.dir }) : null; })
    .filter(function (s) { return s && (s.schemaVersion | 0) <= db.SCHEMA_VERSION; });
}

function buildLocal(ctx) {
  const lib = db.serializeLibrary(ctx.db);
  const cards = {}, saved = {}, tombs = {};
  lib.cards.forEach(function (c) { cards[c.id] = c; });
  lib.saved.forEach(function (s) { saved[s.id] = s; });
  lib.tombstones.forEach(function (t) { tombs[t.kind + ":" + t.id] = t.deletedAt; });
  return { cards: cards, saved: saved, tombstones: tombs };
}

function applyMerge(ctx, plan) {
  // Index imageCopies by id so each upsert can pair with its (single) copy.
  const copyByeId = {};
  for (const ic of plan.imageCopies) copyByeId[ic.id] = ic;

  let upsertsApplied = 0, imageCopiesDone = 0;
  for (const u of plan.upserts) {
    // The id comes from a peer's (corrupt/hostile) snapshot.json and is used to
    // build fs/db paths. Validate it FIRST: an unsafe id is skipped (not written,
    // not stamped into the DB, no path built from it). Wrap the whole per-upsert
    // body so any single bad row is skipped + logged, never fatal to the cycle.
    try {
      const id = u.item && u.item.id;
      try { images.safeImgId(id); }
      catch (e) { console.error("sync: skipping item with unsafe id:", id); continue; }

      const ref = u.kind === "card" ? (u.item && u.item.img) : (u.item && u.item.image);
      // An idb: ref needs a local file images/<id>.jpg. Gate the upsert on it being
      // present locally — otherwise DEFER (skip) so a later cycle retries once the
      // image propagates (local keeps its lower updatedAt → self-heals).
      if (typeof ref === "string" && ref.indexOf("idb:") === 0) {
        const ic = copyByeId[id];
        if (ic) {
          try {
            fs.copyFileSync(path.join(ic.fromDir, "images", id + ".jpg"), path.join(images.imagesDir(ctx.storeDir), id + ".jpg"));
            imageCopiesDone++;
          } catch (e) {
            console.error("sync: image copy failed for " + id + ":", e && e.message);
          }
        }
        if (!images.hasImg(ctx.storeDir, id)) continue;   // DEFER: image not available locally yet
      }
      if (u.kind === "card") db.upsertCardSynced(ctx.db, u.item, u.updatedAt);
      else db.upsertSavedSynced(ctx.db, u.item, u.updatedAt);
      upsertsApplied++;
    } catch (e) {
      console.error("sync: skipping upsert that failed to apply:", (u.item && u.item.id), e && e.message);
    }
  }
  for (const d of plan.deletes) {
    // A delete id also comes from a peer; an unsafe id must be skipped before it
    // reaches delImg/deleteCard (delImg → imgPath → safeImgId would throw).
    try { images.safeImgId(d.id); }
    catch (e) { console.error("sync: skipping delete with unsafe id:", d.id); continue; }
    if (d.kind === "card") db.deleteCard(ctx.db, d.id); else db.deleteSaved(ctx.db, d.id);
    try { images.delImg(ctx.storeDir, d.id); } catch (e) {}
  }
  for (const t of plan.tombstones) db.addTombstone(ctx.db, t.id, t.kind, t.deletedAt);
  const changed = (upsertsApplied + plan.deletes.length + imageCopiesDone) > 0;
  return { changed: changed, upserts: upsertsApplied, deletes: plan.deletes.length };
}

// One full cycle. backupFn defaults to backup.runBackup; injectable for tests.
function runSync(ctx, opts) {
  opts = opts || {};
  const syncDir = opts.syncDir;
  const backupFn = opts.backupFn || function () { backup.runBackup(ctx.db, ctx.storeDir); };
  let changed = false, conflicts = 0;
  const peers = readPeerSnapshots(syncDir, opts.deviceId);
  if (peers.length) {
    const plan = mergeSnapshots(buildLocal(ctx), peers);
    if ((plan.upserts.length + plan.deletes.length + plan.imageCopies.length) > 0) {
      let backedUp = true;
      try { backupFn(); } catch (e) { backedUp = false; console.error("sync: safety backup failed, skipping merge this cycle:", e && e.message); }
      if (backedUp) {
        const r = applyMerge(ctx, plan);
        changed = r.changed; conflicts = plan.conflicts;
      }
    }
  }
  let publishedAt = null;
  if (opts.publish !== false) {
    fs.mkdirSync(syncDir, { recursive: true });
    const out = publishSnapshot(ctx, syncDir, opts.deviceId, opts.deviceLabel);
    publishedAt = Date.now();
    void out;
  }
  return { changed: changed, conflicts: conflicts, peers: peers.map(function (p) { return { deviceId: p.deviceId, deviceLabel: p.deviceLabel, publishedAt: p.publishedAt }; }), publishedAt: publishedAt };
}

module.exports = { defaultSyncDir, peerDirs, publishSnapshot, readSnapshot, readPeerSnapshots, buildLocal, applyMerge, runSync };
