"use strict";
const fs = require("fs");
const path = require("path");
const db = require("./db");
const images = require("./images");
const backup = require("./backup");
const config = require("./config");
const { mergeSnapshots, contentSignature } = require("./merge");

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
  let imageFailures = 0;
  const srcImages = images.imagesDir(ctx.storeDir);
  for (const id of backup.changedImageIds(ctx.storeDir, destImages)) {
    try { fs.copyFileSync(path.join(srcImages, id + ".jpg"), path.join(destImages, id + ".jpg")); } catch (e) { imageFailures++; }
  }

  // 2) snapshot.json (atomic)
  // NOTE: `fp` (placeholder fingerprints) is deliberately NOT published. It is
  // machine-local, re-derivable state that mergeSnapshots never consumes — writing
  // it was dead weight and an asymmetry (published but ignored on read). Old
  // snapshots that still carry an `fp` key remain readable and merge fine: readSnapshot
  // tolerates its absence and merge simply never looks at it (forward-compat additive
  // rule — see the schemaVersion gate in readPeerSnapshots). fp still lives in the DB
  // and is captured by DB-file backups; only the sync JSON drops it.
  const snapshot = {
    schemaVersion: db.SCHEMA_VERSION,
    deviceId: deviceId,
    deviceLabel: deviceLabel,
    publishedAt: Date.now(),
    cards: lib.cards,
    saved: lib.saved,
    tombstones: lib.tombstones,
    settings: lib.settings,   // {data:<no secrets>, updatedAt} — additive; older peers read null
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

  return { name: deviceId, counts: counts, imageFailures: imageFailures };
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
    settings: snap.settings || null,   // {data, updatedAt} — additive; older snapshots lack it (null)
    imageIds: imageIds,
  };
}

// Max clock skew we tolerate on a peer's meta.publishedAt before we distrust the
// whole snapshot. A peer whose clock is far in the FUTURE stamps every item's
// updatedAt in the future too, so it would win every LWW conflict and steamroll
// real edits from correctly-clocked devices (review §1.2). 24h absorbs ordinary
// timezone/DST/NTP wobble while still catching a genuinely broken clock.
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

// Returns { peers, skewSkipped }. A snapshot whose meta.publishedAt is more than
// 24h in the FUTURE (relative to our own now) is dropped WHOLE — snapshot-level
// gate only; we do NOT clamp individual item timestamps (too invasive for Phase 4).
// A MISSING publishedAt is treated as TRUSTED (not skipped): older snapshots
// predate the field, and absence is not evidence of a bad clock.
function readPeerSnapshots(syncDir, selfDeviceId, seenByDevice) {
  seenByDevice = seenByDevice || {};
  var skewSkipped = 0, peersSkipped = 0;
  var now = Date.now();
  var peers = [];
  peerDirs(syncDir, selfDeviceId).forEach(function (p) {
    // Peer-skip: meta.json is tiny and written LAST (the torn-write completion
    // marker), so an unchanged publishedAt proves the whole folder is unchanged
    // — the multi-MB snapshot read/parse is skipped. Watermarks only advance
    // after a CLEAN merge (see runSync), so deferrals always re-read next cycle.
    var seen = seenByDevice[p.deviceId];
    if (seen != null) {
      var meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(p.dir, "meta.json"), "utf8")); } catch (e) { meta = null; }
      if (meta && Number(meta.publishedAt) === Number(seen)) { peersSkipped++; return; }
    }
    // Thread the REAL on-disk folder path (p.dir) — NOT the snapshot's
    // self-asserted deviceId — so mergeSnapshots/applyMerge copy images from the
    // trustworthy folder we actually read, never a JSON-controlled redirection.
    var s = readSnapshot(p.dir);
    if (!s) return;
    s = Object.assign({}, s, { dir: p.dir });
    // FORWARD-COMPAT CONTRACT (schemaVersion gate): a peer at or below our
    // SCHEMA_VERSION is mergeable. Additive fields at the SAME version are always
    // safe — merge reads only the keys it knows and ignores the rest (e.g. an old
    // `fp` key). A BREAKING change (renamed/removed field, changed semantics) MUST
    // bump SCHEMA_VERSION and ship app-first: every peer must be running the new
    // app before any peer publishes the new version, so older peers cleanly skip
    // (schemaVersion > ours) rather than mis-merging.
    if ((s.schemaVersion | 0) > db.SCHEMA_VERSION) return;
    // Absent publishedAt (older snapshots) => trusted, keep.
    if (s.publishedAt != null && isFinite(s.publishedAt) && Number(s.publishedAt) - now > MAX_FUTURE_SKEW_MS) {
      skewSkipped++;
      console.error("sync: skipping future-skewed peer snapshot (clock skew) deviceId=" +
        s.deviceId + " dir=" + s.dir + " publishedAt=" + s.publishedAt + " now=" + now);
      return;
    }
    peers.push(s);
  });
  return { peers: peers, skewSkipped: skewSkipped, peersSkipped: peersSkipped };
}

function buildLocal(ctx) {
  const lib = db.serializeLibrary(ctx.db);
  const cards = {}, saved = {}, tombs = {};
  lib.cards.forEach(function (c) { cards[c.id] = c; });
  lib.saved.forEach(function (s) { saved[s.id] = s; });
  lib.tombstones.forEach(function (t) { tombs[t.kind + ":" + t.id] = t.deletedAt; });
  return { cards: cards, saved: saved, tombstones: tombs, settings: lib.settings || null };
}

function applyMerge(ctx, plan) {
  // Index imageCopies by id so each upsert can pair with its (single) copy.
  const copyById = {};
  for (const ic of plan.imageCopies) copyById[ic.id] = ic;

  // applyFailures counts TRANSIENT apply trouble (a thrown upsert, a thrown
  // settings apply) — it dirties the cycle alongside `deferred` so peer
  // watermarks don't advance past un-merged data (final review 2026-07-16,
  // Finding 1: with publish-skip freezing the peer's publishedAt, an advanced
  // watermark would hide the miss INDEFINITELY, not one cycle). Permanent
  // skips (unsafe id, oversized settings blob) are deliberately NOT counted —
  // they'd disable skipping forever.
  let upsertsApplied = 0, imageCopiesDone = 0, deferred = 0, applyFailures = 0;
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
        const ic = copyById[id];
        if (ic) {
          try {
            fs.copyFileSync(path.join(ic.fromDir, "images", id + ".jpg"), path.join(images.imagesDir(ctx.storeDir), id + ".jpg"));
            imageCopiesDone++;
          } catch (e) {
            console.error("sync: image copy failed for " + id + ":", e && e.message);
          }
        }
        if (!images.hasImg(ctx.storeDir, id)) { deferred++; continue; }   // DEFER: image not available locally yet
      }
      if (u.kind === "card") db.upsertCardSynced(ctx.db, u.item, u.updatedAt);
      else db.upsertSavedSynced(ctx.db, u.item, u.updatedAt);
      upsertsApplied++;
    } catch (e) {
      applyFailures++;
      console.error("sync: skipping upsert that failed to apply:", (u.item && u.item.id), e && e.message);
    }
  }
  for (const d of plan.deletes) {
    // A delete id also comes from a peer; an unsafe id must be skipped before it
    // reaches delImg/deleteCard (delImg → imgPath → safeImgId would throw).
    try { images.safeImgId(d.id); }
    catch (e) { console.error("sync: skipping delete with unsafe id:", d.id); continue; }
    if (d.kind === "card") db.deleteCard(ctx.db, d.id, d.deletedAt); else db.deleteSaved(ctx.db, d.id, d.deletedAt);
    try { images.delImg(ctx.storeDir, d.id); } catch (e) {}
  }
  for (const t of plan.tombstones) db.addTombstone(ctx.db, t.id, t.kind, t.deletedAt);
  // Settings LWW: overlay the winning peer's non-secret settings, keeping local keys.
  let settingsApplied = false;
  if (plan.settings && plan.settings.data) {
    try { db.applySyncedSettings(ctx.db, plan.settings.data, plan.settings.updatedAt); settingsApplied = true; }
    catch (e) { applyFailures++; console.error("sync: applying synced settings failed:", e && e.message); }
  }
  const changed = (upsertsApplied + plan.deletes.length + imageCopiesDone) > 0 || settingsApplied;
  return { changed: changed, upserts: upsertsApplied, deletes: plan.deletes.length, settings: settingsApplied, deferred: deferred, applyFailures: applyFailures };
}

// One full cycle. backupFn defaults to backup.runBackup; injectable for tests.
function runSync(ctx, opts) {
  opts = opts || {};
  const syncDir = opts.syncDir;
  const backupFn = opts.backupFn || function () { backup.runBackup(ctx.db, ctx.storeDir); };
  let changed = false, conflicts = 0;
  // Peer watermarks: last fully-merged publishedAt per peer (kv). Unreadable ⇒
  // absent ⇒ full read (safety bias: when in doubt, don't skip).
  const seenByDevice = {};
  try {
    peerDirs(syncDir, opts.deviceId).forEach(function (p) {
      const v = db.getKV(ctx.db, "ia_peer_seen_" + p.deviceId);
      if (v != null && v !== "") seenByDevice[p.deviceId] = Number(v);
    });
  } catch (e) {}
  const rp = readPeerSnapshots(syncDir, opts.deviceId, seenByDevice);
  const peers = rp.peers;
  const skewSkipped = rp.skewSkipped;
  let mergeClean = true;
  if (peers.length) {
    const plan = mergeSnapshots(buildLocal(ctx), peers);
    if ((plan.upserts.length + plan.deletes.length + plan.imageCopies.length) > 0 || plan.settings) {
      let backedUp = true;
      try { backupFn(); } catch (e) { backedUp = false; console.error("sync: safety backup failed, skipping merge this cycle:", e && e.message); }
      if (backedUp) {
        const r = applyMerge(ctx, plan);
        changed = r.changed; conflicts = plan.conflicts;
        mergeClean = (r.deferred | 0) === 0 && (r.applyFailures | 0) === 0;
      } else {
        mergeClean = false;
      }
    }
  }
  // Advance watermarks for the peers actually read this cycle ONLY when the
  // merge was clean — a deferral must re-read its peer next cycle (the
  // "self-heals next cycle" contract). Skipped peers keep their watermark.
  if (mergeClean) {
    peers.forEach(function (p) {
      if (p.publishedAt != null && isFinite(p.publishedAt)) {
        try { db.setKV(ctx.db, "ia_peer_seen_" + p.deviceId, String(p.publishedAt)); } catch (e) {}
      }
    });
  }
  let publishedAt = null, publishSkipped = false;
  if (opts.publish !== false) {
    let lastSig = null, lastClean = false;
    try { lastSig = db.getKV(ctx.db, "ia_last_publish_sig"); lastClean = db.getKV(ctx.db, "ia_last_publish_clean") === "1"; } catch (e) {}
    const sig = contentSignature(db.signatureAggregates(ctx.db));
    // The existsSync guard (final review Finding 2b): if the remote folder was
    // wiped out-of-band (Dropbox rewind, manual delete), sig+clean still match —
    // never skip re-creating a snapshot that no longer exists.
    if (sig === lastSig && lastClean && !changed && fs.existsSync(path.join(syncDir, opts.deviceId, "meta.json"))) {
      publishSkipped = true;   // identical content already published cleanly — zero writes
    } else {
      fs.mkdirSync(syncDir, { recursive: true });
      const pub = publishSnapshot(ctx, syncDir, opts.deviceId, opts.deviceLabel);
      publishedAt = Date.now();
      try {
        // Recompute AFTER the publish so the stored sig matches exactly what
        // was serialized (the merge above may have been the change).
        db.setKV(ctx.db, "ia_last_publish_sig", contentSignature(db.signatureAggregates(ctx.db)));
        db.setKV(ctx.db, "ia_last_publish_clean", (pub.imageFailures | 0) === 0 ? "1" : "0");
      } catch (e) {}
    }
  }
  return { changed: changed, conflicts: conflicts, skewSkipped: skewSkipped, peersSkipped: rp.peersSkipped, publishSkipped: publishSkipped, peers: peers.map(function (p) { return { deviceId: p.deviceId, deviceLabel: p.deviceLabel, publishedAt: p.publishedAt }; }), publishedAt: publishedAt };
}

module.exports = { defaultSyncDir, peerDirs, publishSnapshot, readSnapshot, readPeerSnapshots, buildLocal, applyMerge, runSync };
