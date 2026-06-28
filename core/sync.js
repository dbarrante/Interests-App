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

module.exports = { defaultSyncDir, peerDirs, publishSnapshot, readSnapshot };
