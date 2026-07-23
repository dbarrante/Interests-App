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
  const RECOVERY_KEY = "pre-merge";

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

  // Mirrors core/db.js's settingsForSync: provider keys + the Open PageRank key
  // SYNC as of the 2026-07-16 spec (user decision — plaintext inside the user's
  // own Dropbox). Only updateToken (desktop auto-updater GitHub credential,
  // meaningless on an iPad anyway) stays behind.
  function stripSecrets(s) {
    const clean = Object.assign({}, s);
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

  // PWA data has no filesystem snapshot equivalent. Before a peer merge, keep
  // one complete local journal entry in IndexedDB, including image Blobs. The
  // journal is local-only and is never published to Dropbox.
  async function writeRecoveryJournal() {
    const [cards, saved, kv, fp, tombstones, images] = await Promise.all([
      idb.getAll("cards"), idb.getAll("saved"), idb.getAll("kv"), idb.getAll("fp"),
      idb.getAll("tombstones"), idb.getAll("images"),
    ]);
    const journal = { key: RECOVERY_KEY, version: 1, createdAt: Date.now(), cards, saved, kv, fp, tombstones, images };
    await idb.put("recovery", journal);
    return journal;
  }

  async function recoveryStatus() {
    const journal = await idb.get("recovery", RECOVERY_KEY);
    return journal ? { available: true, createdAt: journal.createdAt, counts: {
      cards: journal.cards.length, saved: journal.saved.length, images: journal.images.length,
    } } : { available: false };
  }

  async function recoverLastMerge() {
    const journal = await idb.get("recovery", RECOVERY_KEY);
    if (!journal) return { ok: false, reason: "No PWA recovery journal is available." };
    await idb.replaceStores(journal);
    return { ok: true, createdAt: journal.createdAt, counts: {
      cards: journal.cards.length, saved: journal.saved.length, images: journal.images.length,
    } };
  }

  async function bumpMutationRevision() {
    const current = Number(await idb.kvGet("_pwa_mutation_revision")) || 0;
    await idb.kvSet("_pwa_mutation_revision", current + 1);
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
        return { peers: [], skewSkipped: 0, partialFailures: [], peersSkipped: 0, selfFolderPresent: false };
      }
      throw e;
    }
    const deviceIds = entries.filter((e) => e[".tag"] === "folder").map((e) => e.name).filter((id) => id !== selfDeviceId);
    // Free signal for the publish-skip existence guard (final review Finding
    // 2b): if our own folder vanished from the listing (remote wipe/rewind),
    // publish-skip must be refused so the snapshot gets re-created.
    const selfFolderPresent = entries.some((e) => e[".tag"] === "folder" && e.name === selfDeviceId);
    console.log("sync: readPeers — found device folders:", deviceIds);

    const now = Date.now();
    let skewSkipped = 0;
    let peersSkipped = 0;
    const peers = [];
    const partialFailures = [];
    for (const deviceId of deviceIds) {
      console.log("sync: readPeers — reading peer", deviceId);

      // Peer-skip: meta.json is tiny and written LAST (the torn-write completion
      // marker) — an unchanged publishedAt proves the folder is unchanged, so the
      // multi-MB snapshot download and the peer's images listing are skipped.
      // Watermarks only advance after a CLEAN cycle (see runSyncCycle), so any
      // deferral re-reads the peer next cycle. kv errors ⇒ treat as never-seen.
      let seen = null;
      try { seen = await idb.kvGet("_pwa_peer_seen_" + deviceId); } catch (e) { seen = null; }
      if (seen != null) {
        let meta = null;
        try {
          meta = JSON.parse(await Dbx.dbxDownload(accessToken, `${SYNC_ROOT}/${deviceId}/meta.json`));
        } catch (e) {
          if (e && e.code === "AUTH_EXPIRED") throw e; // dead token kills the cycle here too
          meta = null; // unreadable meta ⇒ fall through to the full read (which has its own handling)
        }
        if (meta && Number(meta.publishedAt) === Number(seen)) { peersSkipped++; continue; }
      }

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
    console.log("sync: readPeers — done, peers=" + peers.length + " skewSkipped=" + skewSkipped + " partialFailures=" + partialFailures.length + " peersSkipped=" + peersSkipped);
    return { peers, skewSkipped, partialFailures, peersSkipped, selfFolderPresent };
  }

  // Batches the actual IndexedDB writes into one transaction per store instead of
  // one transaction per item — with a real library this is hundreds/thousands of
  // items, and awaiting a separate transaction per item made a legitimate large
  // first-sync look identical to a hang.
  // 8 concurrent workers tripped Dropbox's per-app rate limit (HTTP 429) almost
  // immediately against a real ~5000-image library. 4 plus oauth.js's retry-with-
  // backoff on 429 is a safer balance of speed vs. staying under the limit — used
  // by publishSnapshot's image uploads below (images no longer download in-cycle
  // here; see the on-demand fetcher's own cap further down, spec 2026-07-17).
  const IMAGE_DOWNLOAD_CONCURRENCY = 4;

  async function applyMergeToLocal(plan, accessToken, onProgress) {
    try {
      await writeRecoveryJournal();
    } catch (e) {
      const error = new Error("PWA recovery journal could not be written; merge aborted safely");
      error.code = "RECOVERY_JOURNAL_FAILED";
      error.cause = e;
      throw error;
    }
    // Phase 1: classify synchronously (cheap) — every safe-id upsert applies
    // immediately; images are no longer downloaded during sync (spec
    // 2026-07-17 — on-demand images: the renderer fetches via ensureImage()
    // on first view, gated by the _pwa_image_sources map runSyncCycle refreshes
    // below). imagesFailed/imagesReused stay in the return shape as 0 — nothing
    // downloads here anymore, so nothing can fail or be reused.
    const readyCards = [], readySaved = [];
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
      (u.kind === "card" ? readyCards : readySaved).push(u.item);
    }
    const imagesFailed = 0; // shape stability — see comment above

    if (readyCards.length) await idb.putMany("cards", readyCards);
    if (readySaved.length) await idb.putMany("saved", readySaved);
    const upsertsApplied = readyCards.length + readySaved.length;
    console.log("sync: applyMerge — batched write done: cards=" + readyCards.length + " saved=" + readySaved.length +
      " | skipped(noItem)=" + skippedNoItem + " skipped(unsafeId)=" + skippedUnsafeId +
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

    let settingsApplied = false, applyFailures = 0;
    if (plan.settings && plan.settings.data) {
      try {
        // Mirror core/db.js applySyncedSettings' oversized-blob rejection: settings
        // drive network destinations (provider/localUrl), so an absurdly large peer
        // blob is rejected before it touches the store. Unstringifiable counts as
        // oversized (fail closed).
        let oversized = true;
        try { oversized = JSON.stringify(plan.settings.data).length > 262144; } catch (e2) {}
        if (oversized) {
          console.error("sync: ignoring oversized settings blob");
        } else {
          const local = (await idb.kvGet("ia_settings")) || {};
          const merged = mergeSyncedSettings(local, plan.settings.data); // pwa/merge.js — global, like mergeSnapshots
          await idb.kvSet("ia_settings", merged);
          // Fresh stamp when local enriched the union, else adopt the incoming
          // stamp — see core/merge.js settingsEnrichedByLocal for why.
          await idb.kvSet("ia_settings_updatedAt", settingsEnrichedByLocal(merged, plan.settings.data) ? Date.now() : (Number(plan.settings.updatedAt) || Date.now()));
          settingsApplied = true;
        }
      } catch (e) {
        // TRANSIENT apply failure (e.g. idb quota) — must dirty the cycle so the
        // winning peer's watermark doesn't advance past unapplied settings
        // (final review 2026-07-16, Finding 1 / data-safety F1). The oversized-
        // blob rejection above is a PERMANENT condition and deliberately does
        // not count (it would disable skipping forever).
        applyFailures++;
        console.error("sync: applying synced settings failed:", e.message);
      }
    }

    const changed = (upsertsApplied + plan.deletes.length) > 0 || settingsApplied;
    if (changed) await bumpMutationRevision();
    return { changed, upserts: upsertsApplied, deletes: plan.deletes.length, settings: settingsApplied, imagesFailed: imagesFailed, applyFailures: applyFailures };
  }

  // ---- on-demand images (spec 2026-07-17) ----
  // Sync no longer downloads images; the renderer fetches each image on first
  // view via ensureImage(). _pwa_image_sources maps every image id to a peer
  // folder + size, refreshed each cycle from the listings readFullPeerSnapshot
  // already makes. Missing entry ⇒ renderer placeholder (doubt bias).
  const _IMG_FETCH_LIMIT = 4;
  let _imgFetchActive = 0;
  const _imgFetchQueue = [];
  const _imgInFlight = {}; // id -> Promise<boolean>: coalesce duplicate requests

  function _imgSlot() {
    if (_imgFetchActive < _IMG_FETCH_LIMIT) { _imgFetchActive++; return Promise.resolve(); }
    return new Promise((r) => _imgFetchQueue.push(r));
  }
  function _imgRelease() {
    const next = _imgFetchQueue.shift();
    if (next) next(); else _imgFetchActive--;
  }

  async function ensureImage(id) {
    if (!safeImgId(id)) return false;
    if (_imgInFlight[id]) return _imgInFlight[id];
    const p = (async () => {
      try {
        const row = await idb.get("images", id);
        if (row && row.blob) return true;
        const sources = (await idb.kvGet("_pwa_image_sources")) || {};
        const srcInfo = sources[id];
        if (!srcInfo || !srcInfo.dir) return false;
        await _imgSlot();
        try {
          const bytes = await Dbx.dbxDownloadBinary(null, `${srcInfo.dir}/images/${id}.jpg`);
          await idb.put("images", { id, blob: new Blob([bytes]), type: sniffImageType(bytes) });
          return true;
        } finally {
          _imgRelease();
        }
      } catch (e) {
        return false; // 404/offline/auth — placeholder now, retried on a later view
      }
    })();
    _imgInFlight[id] = p;
    p.finally(() => { delete _imgInFlight[id]; });
    return p;
  }

  async function publishSnapshot(accessToken, deviceId, deviceLabel, onProgress, mergeChanged) {
    console.log("sync: publishSnapshot — starting for device", deviceId);
    const [cardRows, savedRows, tombRows, mutationRevision] = await Promise.all([idb.getAll("cards"), idb.getAll("saved"), idb.getAll("tombstones"), idb.kvGet("_pwa_mutation_revision")]);
    const settingsRaw = await idb.kvGet("ia_settings");
    const settingsUpdatedAt = await idb.kvGet("ia_settings_updatedAt");
    console.log("sync: publishSnapshot — local read done. cards=" + cardRows.length + " saved=" + savedRows.length);

    const counts = { cards: cardRows.length, saved: savedRows.length };

    // Publish-skip: identical content already published cleanly ⇒ zero network.
    // Gate on mergeChanged too (belt and braces — an applied merge always moves
    // the signature). kv errors ⇒ publish fully (doubt bias).
    const agg = {
      cards: cardRows.length, saved: savedRows.length, tombstones: tombRows.length,
      maxCardUpdatedAt: cardRows.reduce((m, r) => Math.max(m, Number(r.updatedAt) || 0), 0),
      maxSavedUpdatedAt: savedRows.reduce((m, r) => Math.max(m, Number(r.updatedAt) || 0), 0),
      maxTombDeletedAt: tombRows.reduce((m, r) => Math.max(m, Number(r.deletedAt) || 0), 0),
      settingsUpdatedAt: Number(settingsUpdatedAt) || 0,
      mutationRevision: Number(mutationRevision) || 0,
    };
    const sig = contentSignature(agg); // pwa/merge.js — global, like mergeSnapshots
    let lastSig = null, lastClean = false;
    try { lastSig = await idb.kvGet("_pwa_last_publish_sig"); lastClean = (await idb.kvGet("_pwa_last_publish_clean")) === true; } catch (e) {}
    if (!mergeChanged && sig === lastSig && lastClean) {
      console.log("sync: publishSnapshot — content unchanged since last clean publish, skipping");
      return { skipped: true };
    }

    // 1) images first, incrementally — diff local idb: image ids against what's
    //    already in this device's own Dropbox images/ folder (mirrors core/sync.js's
    //    changedImageIds diff, adapted since we can't stat a local folder here).
    const localImageIds = new Set(
      cardRows.map((c) => c.img).concat(savedRows.map((s) => s.image))
        .filter((v) => typeof v === "string" && v.indexOf("idb:") === 0)
        .map((v) => v.slice(4))
    );
    console.log("sync: publishSnapshot — resolving existing remote images for", deviceId);
    // Own-published-images cache — NAMESPACED BY deviceId (data-safety F5b: a
    // regenerated device identity publishes to a fresh empty folder and must
    // never inherit the old identity's cache). Revalidated against a REAL
    // listing after any dirty publish and every 20th publish regardless
    // (final review Finding 2a: out-of-band remote deletion — Dropbox rewind,
    // manual cleanup — would otherwise suppress a needed re-upload forever).
    const cacheKey = "_pwa_published_imgids_" + deviceId;
    let cachedIds = null, pubN = 0;
    try { cachedIds = await idb.kvGet(cacheKey); pubN = (await idb.kvGet("_pwa_pubcache_n_" + deviceId)) | 0; } catch (e) { cachedIds = null; }
    const reseed = !Array.isArray(cachedIds) || !lastClean || pubN % 20 === 0;
    if (reseed) console.log("sync: publishSnapshot — reseeding published-images cache from a full listing");
    const alreadyPublished = reseed
      ? new Set(await Dbx.listDeviceImageIds(accessToken, deviceId))
      : new Set(cachedIds);
    try { await idb.kvSet("_pwa_pubcache_n_" + deviceId, pubN + 1); } catch (e) {}
    console.log("sync: publishSnapshot — image diff: local=" + localImageIds.size + " alreadyRemote=" + alreadyPublished.size);
    const toUpload = [...localImageIds].filter((id) => !alreadyPublished.has(id));
    let uploadedCount = 0, uploadIndex = 0, uploadFailures = 0;
    async function uploadWorker() {
      while (uploadIndex < toUpload.length) {
        const id = toUpload[uploadIndex++];
        const row = await idb.get("images", id);
        if (!row || !row.blob) continue;
        try {
          const bytes = await row.blob.arrayBuffer();
          await Dbx.dbxUpload(accessToken, `${SYNC_ROOT}/${deviceId}/images/${id}.jpg`, bytes);
          alreadyPublished.add(id);
        } catch (e) {
          uploadFailures++;
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
    console.log("sync: publishSnapshot — images done (" + toUpload.length + " uploaded, " + uploadFailures + " failed), uploading snapshot.json");

    // Persist the cache after the wave: successful ids stick even if the cycle
    // fails later. A stale/missing entry only ever costs one redundant upload
    // (Dropbox overwrite mode is idempotent) — never a missing file.
    try { await idb.kvSet(cacheKey, [...alreadyPublished]); } catch (e) {}

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

    try {
      await idb.kvSet("_pwa_last_publish_sig", sig);
      await idb.kvSet("_pwa_last_publish_clean", uploadFailures === 0);
    } catch (e) {}
    return { publishedAt, counts, uploadFailures };
  }

  function classifySyncError(e) {
    return { code: (e && e.code) || "OTHER", reason: (e && e.message) || String(e) };
  }

  // One full cycle: read peers -> merge -> apply -> publish. Mirrors
  // core/sync.js's runSync(), minus the safety-backup-before-merge step (there's
  // nothing to back up to on an iPad — the peer snapshots themselves are the
  // recovery path if a merge ever needs to be undone).
  async function runSyncCycle(accessToken, opts) {
    console.log("sync: runSyncCycle — starting");
    opts = opts || {};
    let deviceId, deviceLabel;
    try {
      ({ deviceId, deviceLabel } = await ensureDeviceIdentity());
      console.log("sync: runSyncCycle — device identity ready:", deviceId, deviceLabel);

      let peers, skewSkipped, partialFailures, peersSkipped = 0, selfFolderPresent = false;
      try {
        ({ peers, skewSkipped, partialFailures, peersSkipped, selfFolderPresent } = await readPeers(accessToken, deviceId));
      } catch (e) {
        console.error("sync: runSyncCycle — aborting, peer read failed:", e && e.message);
        return Object.assign({ ok: false, deviceId, deviceLabel }, classifySyncError(e));
      }

      let changed = false, conflicts = 0, upserts = 0, deletes = 0, imagesFailed = 0, applyFailures = 0;
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
          imagesFailed = r.imagesFailed | 0; applyFailures = r.applyFailures | 0;
          console.log("sync: runSyncCycle — merge applied");
        }
      }

      // Advance peer watermarks ONLY after a clean cycle (no deferred images,
      // no transient apply failures, no per-peer read failures) — a dirty
      // cycle must re-read its peers (final review 2026-07-16, Finding 1).
      if (imagesFailed === 0 && applyFailures === 0 && partialFailures.length === 0) {
        for (const p of peers) {
          if (p.publishedAt != null && isFinite(p.publishedAt)) {
            try { await idb.kvSet("_pwa_peer_seen_" + p.deviceId, Number(p.publishedAt)); } catch (e) {}
          }
        }
      }

      // Refresh the on-demand image source map: each read peer's entries fully
      // replace its own prior entries; skipped peers' stored entries stay valid
      // (their folders provably didn't change). kv errors ⇒ keep the old map.
      if (peers.length) {
        try {
          const sources = (await idb.kvGet("_pwa_image_sources")) || {};
          for (const p of peers) {
            for (const iid of Object.keys(sources)) {
              if (sources[iid] && sources[iid].dir === p.dir) delete sources[iid];
            }
            const sizes = p.imageSizes || {};
            for (const iid of (p.imageIds || [])) {
              if (safeImgId(iid)) sources[iid] = { dir: p.dir, size: sizes[iid] };
            }
          }
          await idb.kvSet("_pwa_image_sources", sources);
        } catch (e) { console.warn("sync: image source map refresh failed:", e && e.message); }
      }

      let publishResult = null;
      try {
        if (opts.publish !== false) {
          // `changed || !selfFolderPresent` forces a real publish when our own
          // folder vanished from the sync root (remote wipe — Finding 2b);
          // sig+clean would otherwise skip re-creating a snapshot that no
          // longer exists.
          publishResult = await publishSnapshot(accessToken, deviceId, deviceLabel, (done, total) => {
            if (opts.onProgress) opts.onProgress({ phase: "publishing images", done, total });
          }, changed || !selfFolderPresent);
        }
      } catch (e) {
        console.error("sync: runSyncCycle — publish failed:", e && e.message);
        return Object.assign(
          { ok: false, deviceId, deviceLabel, changed, conflicts, upserts, deletes, peersRead: peers.length, skewSkipped, partialFailures },
          classifySyncError(e)
        );
      }
      console.log("sync: runSyncCycle — done");

      return {
        ok: true,
        deviceId, deviceLabel, changed, conflicts, upserts, deletes,
        peersRead: peers.length, skewSkipped, partialFailures,
        peersSkipped: peersSkipped | 0, publishSkipped: !!(publishResult && publishResult.skipped),
        published: !!(publishResult && publishResult.publishedAt), publishedAt: publishResult && publishResult.publishedAt,
      };
    } catch (e) {
      // Safety net for anything NOT already handled above — ensureDeviceIdentity,
      // buildLocal, mergeSnapshots, and applyMergeToLocal's uncaught IndexedDB
      // writes have no dedicated try/catch of their own. The inner try/catches
      // for readPeers/publishSnapshot always return before reaching here, so
      // this only ever fires for the segments that don't have their own
      // handling. Without this, runSyncCycle could still reject despite its
      // documented "always resolves" contract (found in task review: 3 of 5
      // throwable segments were previously unwrapped).
      console.error("sync: runSyncCycle — unexpected failure:", e && e.message);
      return Object.assign({ ok: false, deviceId, deviceLabel }, classifySyncError(e));
    }
  }

  window.IASync = { ensureDeviceIdentity, setDeviceLabel, runSyncCycle, ensureImage, recoveryStatus, recoverLastMerge };
})();
