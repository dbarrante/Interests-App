"use strict";

// Phase 3: wires pwa/oauth.js's Dropbox transport + pwa/merge.js's ported (pure,
// unmodified) merge logic into the local IndexedDB store, mirroring core/sync.js's
// runSync() cycle (buildLocal -> mergeSnapshots -> applyMerge -> publishSnapshot)
// as closely as the browser environment allows.
//
// Deliberately depends on pwa/idb.js directly, NOT on storage-pwa.js's Store —
// Store.delCard/delSaved need this module's tombstone semantics (via idb.js), and
// this module needs kv access, which would be a circular dependency if it went
// through Store instead of idb.js directly.

(function () {
  const idb = window.IA_IDB;
  const Dbx = window.IADropbox;

  const SCHEMA_VERSION = 2; // must track core/db.js's SCHEMA_VERSION
  const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // see core/sync.js's own comment on this constant
  const SYNC_ROOT = "/Interests App/sync";

  function safeImgId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
  }

  // Ported from core/images.js's sniffImageType — the manifest/.jpg filename is
  // just a convention; always trust sniffed magic bytes over the extension.
  function sniffImageType(bytes) {
    const buf = new Uint8Array(bytes);
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
    if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
    return "image/jpeg";
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10,16).join("")}`;
  }

  async function ensureDeviceIdentity() {
    let deviceId = await idb.kvGet("_pwa_device_id");
    if (!deviceId) { deviceId = "ipad-" + uuid(); await idb.kvSet("_pwa_device_id", deviceId); }
    let deviceLabel = await idb.kvGet("_pwa_device_label");
    if (!deviceLabel) { deviceLabel = "iPad"; await idb.kvSet("_pwa_device_label", deviceLabel); }
    return { deviceId, deviceLabel };
  }

  function setDeviceLabel(label) {
    return idb.kvSet("_pwa_device_label", label);
  }

  // Mirrors core/db.js's settingsForSync: strip provider keys / Open PageRank key
  // / GitHub update token before anything derived from this leaves the device.
  function stripSecrets(s) {
    const clean = Object.assign({}, s);
    delete clean.keys;
    delete clean.oprKey;
    delete clean.updateToken;
    return clean;
  }

  async function buildLocal() {
    const [cardRows, savedRows, tombRows, settingsRaw, settingsUpdatedAt] = await Promise.all([
      idb.getAll("cards"), idb.getAll("saved"), idb.getAll("tombstones"),
      idb.kvGet("ia_settings"), idb.kvGet("ia_settings_updatedAt"),
    ]);
    const cards = {}, saved = {}, tombstones = {};
    cardRows.forEach((c) => { cards[c.id] = c; });
    savedRows.forEach((s) => { saved[s.id] = s; });
    tombRows.forEach((t) => { tombstones[t.kind + ":" + t.id] = t.deletedAt; });
    const settings = settingsRaw
      ? { data: stripSecrets(settingsRaw), updatedAt: Number(settingsUpdatedAt) || 0 }
      : { data: null, updatedAt: 0 };
    return { cards, saved, tombstones, settings };
  }

  async function readPeers(accessToken, selfDeviceId) {
    console.log("sync: readPeers — listing", SYNC_ROOT);
    let entries;
    try {
      entries = await Dbx.dbxListFolder(accessToken, SYNC_ROOT);
    } catch (e) {
      if (e && e.code === "AUTH_EXPIRED") throw e; // sync cannot proceed without a live connection
      // path/not_found is the normal, silent case for "nobody has ever synced
      // to this Dropbox account yet" — the sync root folder doesn't exist.
      // Anything else here used to be swallowed identically (the root cause
      // of a 2-day silent sync failure, see the design spec) — now it
      // propagates so the caller actually finds out.
      if (/path\/not_found/.test(e && e.message)) {
        console.log("sync: readPeers — no sync root yet (nobody has ever synced):", e.message);
        return { peers: [], skewSkipped: 0, partialFailures: [] };
      }
      throw e;
    }
    const deviceIds = entries.filter((e) => e[".tag"] === "folder").map((e) => e.name).filter((id) => id !== selfDeviceId);
    console.log("sync: readPeers — found device folders:", deviceIds);

    const now = Date.now();
    let skewSkipped = 0;
    const peers = [];
    const partialFailures = [];
    for (const deviceId of deviceIds) {
      console.log("sync: readPeers — reading peer", deviceId);
      let snap;
      try {
        snap = await Dbx.readFullPeerSnapshot(accessToken, deviceId);
      } catch (e) {
        if (e && e.code === "AUTH_EXPIRED") throw e; // a dead token kills the whole cycle, not just this peer
        console.error("sync: failed to read peer", deviceId, e.message);
        partialFailures.push({ deviceId, reason: (e && e.message) || String(e) });
        continue;
      }
      console.log("sync: readPeers — read peer", deviceId, "ok:", !!snap);
      if (!snap) { partialFailures.push({ deviceId, reason: "torn write (meta/snapshot count mismatch) — will retry next cycle" }); continue; }
      if ((snap.schemaVersion | 0) > SCHEMA_VERSION) continue; // ahead of us — forward-compat gate
      if (snap.publishedAt != null && isFinite(snap.publishedAt) && Number(snap.publishedAt) - now > MAX_FUTURE_SKEW_MS) {
        skewSkipped++;
        continue;
      }
      peers.push(snap);
    }
    console.log("sync: readPeers — done, peers=" + peers.length + " skewSkipped=" + skewSkipped + " partialFailures=" + partialFailures.length);
    return { peers, skewSkipped, partialFailures };
  }

  // Batches the actual IndexedDB writes into one transaction per store instead of
  // one transaction per item — with a real library this is hundreds/thousands of
  // items, and awaiting a separate transaction per item made a legitimate large
  // first-sync look identical to a hang. The per-item work that genuinely can't be
  // batched (checking/copying an idb: image, which needs a conditional network
  // fetch) stays in its own sequential loop; only the DB writes are deferred and
  // flushed in bulk at the end.
  // 8 concurrent workers tripped Dropbox's per-app rate limit (HTTP 429) almost
  // immediately against a real ~5000-image library. 4 plus oauth.js's retry-with-
  // backoff on 429 is a safer balance of speed vs. staying under the limit.
  const IMAGE_DOWNLOAD_CONCURRENCY = 4;

  async function applyMergeToLocal(plan, accessToken, onProgress) {
    const copyById = {};
    plan.imageCopies.forEach((ic) => { copyById[ic.id] = ic; });

    // Phase 1: classify synchronously (cheap) — split into items that can be
    // written immediately vs items that need an image downloaded first.
    const readyCards = [], readySaved = [];
    const needsImage = []; // [{ u, id }]
    let skippedNoItem = 0, skippedUnsafeId = 0;
    const unsafeIdSamples = [];
    for (const u of plan.upserts) {
      if (!u || !u.item) { skippedNoItem++; continue; }
      const id = u.item.id;
      if (!safeImgId(id)) {
        skippedUnsafeId++;
        if (unsafeIdSamples.length < 5) unsafeIdSamples.push(id);
        continue;
      }
      const ref = u.kind === "card" ? u.item.img : u.item.image;
      if (typeof ref === "string" && ref.indexOf("idb:") === 0 && copyById[id]) {
        needsImage.push({ u, id });
      } else {
        (u.kind === "card" ? readyCards : readySaved).push(u.item);
      }
    }

    // Phase 2: download needed images with a bounded CONCURRENT pool — doing this
    // one at a time (the original approach) meant thousands of sequential network
    // round-trips, which is legitimately slow enough to look identical to a hang.
    let imageCopiesDone = 0, imagesFailed = 0, nextIndex = 0;
    async function imageWorker() {
      while (nextIndex < needsImage.length) {
        const { u, id } = needsImage[nextIndex++];
        const ic = copyById[id];
        try {
          const bytes = await Dbx.dbxDownloadBinary(accessToken, `${ic.fromDir}/images/${id}.jpg`);
          await idb.put("images", { id, blob: new Blob([bytes]), type: sniffImageType(bytes) });
          imageCopiesDone++;
          (u.kind === "card" ? readyCards : readySaved).push(u.item);
        } catch (e) {
          imagesFailed++; // DEFER: image unavailable — local's lower updatedAt self-heals next cycle
        }
        const done = imageCopiesDone + imagesFailed;
        if (onProgress && done % 25 === 0) onProgress(done, needsImage.length);
      }
    }
    if (needsImage.length) {
      await Promise.all(Array.from({ length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, needsImage.length) }, imageWorker));
      if (onProgress) onProgress(needsImage.length, needsImage.length);
    }

    if (readyCards.length) await idb.putMany("cards", readyCards);
    if (readySaved.length) await idb.putMany("saved", readySaved);
    const upsertsApplied = readyCards.length + readySaved.length;
    console.log("sync: applyMerge — batched write done: cards=" + readyCards.length + " saved=" + readySaved.length +
      " | skipped(noItem)=" + skippedNoItem + " skipped(unsafeId)=" + skippedUnsafeId +
      " imagesCopied=" + imageCopiesDone + " imagesFailed/deferred=" + imagesFailed +
      (unsafeIdSamples.length ? " | unsafe id samples: " + JSON.stringify(unsafeIdSamples) : ""));

    const cardDeletes = [], savedDeletes = [], imageDeletes = [];
    for (const d of plan.deletes) {
      if (!safeImgId(d.id)) { console.error("sync: skipping delete with unsafe id:", d.id); continue; }
      (d.kind === "card" ? cardDeletes : savedDeletes).push(d.id);
      imageDeletes.push(d.id);
    }
    if (cardDeletes.length) await idb.deleteMany("cards", cardDeletes);
    if (savedDeletes.length) await idb.deleteMany("saved", savedDeletes);
    if (imageDeletes.length) await idb.deleteMany("images", imageDeletes); // no-op for ids that never had an image

    // Tombstones still need "keep the newest deletedAt per key" semantics, but that
    // can be resolved against one bulk read instead of a read-then-write per item.
    if (plan.tombstones.length) {
      const existingRows = await idb.getAll("tombstones");
      const existingByKey = {};
      existingRows.forEach((r) => { existingByKey[r.key] = r; });
      const tombRows = plan.tombstones.map((t) => {
        const key = t.kind + ":" + t.id;
        const ts = (t.deletedAt != null && isFinite(t.deletedAt)) ? Math.trunc(Number(t.deletedAt)) : Date.now();
        const prior = existingByKey[key];
        return { key, id: t.id, kind: t.kind, deletedAt: prior ? Math.max(prior.deletedAt, ts) : ts };
      });
      await idb.putMany("tombstones", tombRows);
    }

    let settingsApplied = false;
    if (plan.settings && plan.settings.data) {
      try {
        const local = (await idb.kvGet("ia_settings")) || {};
        const merged = Object.assign({}, plan.settings.data, { keys: local.keys, oprKey: local.oprKey, updateToken: local.updateToken });
        await idb.kvSet("ia_settings", merged);
        await idb.kvSet("ia_settings_updatedAt", Number(plan.settings.updatedAt) || Date.now());
        settingsApplied = true;
      } catch (e) {
        console.error("sync: applying synced settings failed:", e.message);
      }
    }

    const changed = (upsertsApplied + plan.deletes.length + imageCopiesDone) > 0 || settingsApplied;
    return { changed, upserts: upsertsApplied, deletes: plan.deletes.length, settings: settingsApplied };
  }

  async function publishSnapshot(accessToken, deviceId, deviceLabel, onProgress) {
    console.log("sync: publishSnapshot — starting for device", deviceId);
    const [cardRows, savedRows, tombRows] = await Promise.all([idb.getAll("cards"), idb.getAll("saved"), idb.getAll("tombstones")]);
    const settingsRaw = await idb.kvGet("ia_settings");
    const settingsUpdatedAt = await idb.kvGet("ia_settings_updatedAt");
    console.log("sync: publishSnapshot — local read done. cards=" + cardRows.length + " saved=" + savedRows.length);

    const counts = { cards: cardRows.length, saved: savedRows.length };

    // 1) images first, incrementally — diff local idb: image ids against what's
    //    already in this device's own Dropbox images/ folder (mirrors core/sync.js's
    //    changedImageIds diff, adapted since we can't stat a local folder here).
    const localImageIds = new Set(
      cardRows.map((c) => c.img).concat(savedRows.map((s) => s.image))
        .filter((v) => typeof v === "string" && v.indexOf("idb:") === 0)
        .map((v) => v.slice(4))
    );
    console.log("sync: publishSnapshot — listing existing remote images for", deviceId);
    const alreadyPublished = new Set(await Dbx.listDeviceImageIds(accessToken, deviceId));
    console.log("sync: publishSnapshot — image diff: local=" + localImageIds.size + " alreadyRemote=" + alreadyPublished.size);
    const toUpload = [...localImageIds].filter((id) => !alreadyPublished.has(id));
    let uploadedCount = 0, uploadIndex = 0;
    async function uploadWorker() {
      while (uploadIndex < toUpload.length) {
        const id = toUpload[uploadIndex++];
        const row = await idb.get("images", id);
        if (!row || !row.blob) continue;
        try {
          const bytes = await row.blob.arrayBuffer();
          await Dbx.dbxUpload(accessToken, `${SYNC_ROOT}/${deviceId}/images/${id}.jpg`, bytes);
        } catch (e) {
          console.error("sync: image upload failed for", id, e.message);
        }
        uploadedCount++;
        if (onProgress && uploadedCount % 25 === 0) onProgress(uploadedCount, toUpload.length);
      }
    }
    if (toUpload.length) {
      await Promise.all(Array.from({ length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, toUpload.length) }, uploadWorker));
      if (onProgress) onProgress(toUpload.length, toUpload.length);
    }
    console.log("sync: publishSnapshot — images done (" + toUpload.length + " uploaded), uploading snapshot.json");

    // 2) snapshot.json
    const publishedAt = Date.now();
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      deviceId, deviceLabel, publishedAt,
      cards: cardRows, saved: savedRows,
      tombstones: tombRows.map((t) => ({ id: t.id, kind: t.kind, deletedAt: t.deletedAt })),
      settings: settingsRaw ? { data: stripSecrets(settingsRaw), updatedAt: Number(settingsUpdatedAt) || 0 } : null,
    };
    await Dbx.dbxUpload(accessToken, `${SYNC_ROOT}/${deviceId}/snapshot.json`, JSON.stringify(snapshot));
    console.log("sync: publishSnapshot — snapshot.json uploaded, uploading meta.json");

    // 3) meta.json LAST — the completion marker (see docs/iphone-sync-design.md section 1)
    await Dbx.dbxUpload(accessToken, `${SYNC_ROOT}/${deviceId}/meta.json`, JSON.stringify({
      schemaVersion: SCHEMA_VERSION, deviceId, deviceLabel, publishedAt, counts,
    }));
    console.log("sync: publishSnapshot — meta.json uploaded, done");

    return { publishedAt, counts };
  }

  // One full cycle: read peers -> merge -> apply -> publish. Mirrors
  // core/sync.js's runSync(), minus the safety-backup-before-merge step (there's
  // nothing to back up to on an iPad — the peer snapshots themselves are the
  // recovery path if a merge ever needs to be undone).
  async function runSyncCycle(accessToken, opts) {
    console.log("sync: runSyncCycle — starting");
    opts = opts || {};
    const { deviceId, deviceLabel } = await ensureDeviceIdentity();
    console.log("sync: runSyncCycle — device identity ready:", deviceId, deviceLabel);

    let peers, skewSkipped, partialFailures;
    try {
      ({ peers, skewSkipped, partialFailures } = await readPeers(accessToken, deviceId));
    } catch (e) {
      console.error("sync: runSyncCycle — aborting, peer read failed:", e && e.message);
      return { ok: false, code: (e && e.code) || "OTHER", reason: (e && e.message) || String(e), deviceId, deviceLabel };
    }

    let changed = false, conflicts = 0, upserts = 0, deletes = 0;
    if (peers.length) {
      console.log("sync: runSyncCycle — building local snapshot for merge");
      const local = await buildLocal();
      const plan = mergeSnapshots(local, peers); // pwa/merge.js — global, no import needed
      console.log("sync: runSyncCycle — merge plan: upserts=" + plan.upserts.length + " deletes=" + plan.deletes.length + " imageCopies=" + plan.imageCopies.length);
      if (opts.onProgress) opts.onProgress({ phase: "merging", done: 0, total: plan.imageCopies.length });
      if (plan.upserts.length + plan.deletes.length + plan.imageCopies.length > 0 || plan.settings) {
        const r = await applyMergeToLocal(plan, accessToken, (done, total) => {
          if (opts.onProgress) opts.onProgress({ phase: "downloading images", done, total });
        });
        changed = r.changed; conflicts = plan.conflicts; upserts = r.upserts; deletes = r.deletes;
        console.log("sync: runSyncCycle — merge applied");
      }
    }

    let publishResult = null;
    try {
      if (opts.publish !== false) {
        publishResult = await publishSnapshot(accessToken, deviceId, deviceLabel, (done, total) => {
          if (opts.onProgress) opts.onProgress({ phase: "publishing images", done, total });
        });
      }
    } catch (e) {
      console.error("sync: runSyncCycle — publish failed:", e && e.message);
      return {
        ok: false, code: (e && e.code) || "OTHER", reason: (e && e.message) || String(e), deviceId, deviceLabel,
        changed, conflicts, upserts, deletes, peersRead: peers.length, skewSkipped, partialFailures,
      };
    }
    console.log("sync: runSyncCycle — done");

    return {
      ok: true,
      deviceId, deviceLabel, changed, conflicts, upserts, deletes,
      peersRead: peers.length, skewSkipped, partialFailures,
      published: !!publishResult, publishedAt: publishResult && publishResult.publishedAt,
    };
  }

  window.IASync = { ensureDeviceIdentity, setDeviceLabel, runSyncCycle };
})();
