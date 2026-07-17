"use strict";

// PWA replacement for web/storage.js's Store object. Same method names/signatures
// so web/index.html can eventually load this instead of the fetch-to-localhost
// version unmodified. Backed by IndexedDB (pwa/idb.js) instead of the desktop's
// Express + node:sqlite server.
//
// Scope decisions (see pwa/README.md):
// - Core data (kv, cards, saved, images, fp) is fully implemented here.
// - Dropbox sync (syncStatus/syncNow/etc.) is stubbed — Phase 3 wires these to
//   core/merge.js's ported logic + pwa/oauth.js's Dropbox transport.
// - Desktop-only features (import, capture bridge, bookmarks, link/content/safety
//   checks, News/Stumble RSS) are permanently out of scope per product decision —
//   they depend on the desktop's local server or local filesystem/browser-profile
//   access that an iPad doesn't have. Stubbed to resolve gracefully so index.html
//   never hits an unhandled rejection calling them.

(function () {
  const idb = window.IA_IDB;

  if (navigator.serviceWorker) {
    // updateViaCache: "none" stops the browser from ever serving sw.js itself out
    // of the HTTP cache when checking for updates — without this, a stale cached
    // sw.js can make the update check a no-op indefinitely on some WebKit builds,
    // which is how a home-screen PWA gets stuck on an old build even across
    // force-quits. The explicit update() call (each load) makes a fresh deploy
    // actually get installed on an already-installed device without any manual
    // cache-clearing.
    //
    // hadController distinguishes a genuine update (this tab already had an
    // active SW controlling it) from sw.js's activate handler simply calling
    // clients.claim() on a brand-new install (this tab had no controller yet) —
    // both fire "controllerchange", but only the former is a real update.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
      reg.update().catch(() => {});
      let sawFirst = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        const isFirst = !sawFirst;
        sawFirst = true;
        if (isFirst && !hadController) return; // fresh install taking control, not an update
        // Deliberately NOT auto-reloading: clients.claim() in sw.js's activate
        // handler takes control of every open tab of this app, not just this
        // one, and a forced reload here could discard unsaved state in another
        // tab (e.g. an in-progress card edit that only persists on explicit
        // save). The new worker is already in control and will serve the fresh
        // build on this page's next natural reload/navigation — just say so.
        if (typeof toast === "function") toast("An update is ready — it'll load next time you open the app.");
      });
    }).catch((e) => {
      console.error("Service worker registration failed (images will not load):", e);
    });
  }

  function dataUrlToBlob(dataUrl) {
    return fetch(dataUrl).then((r) => r.blob());
  }

  function nowStamp(row) {
    row.updatedAt = Date.now();
    return row;
  }

  // Content signature EXCLUDING updatedAt — mirrors core/db.js's cardSig intent.
  // Stable stringify (pwa/merge.js's _iaStable, resolved lazily at call time)
  // so key order can never fake a content change.
  function contentSig(row) {
    const c = Object.assign({}, row); delete c.updatedAt;
    return (window._iaStable || JSON.stringify)(c);
  }

  // Mirrors the desktop's mass-delete guard (see storage.js's `asOf`/`confirm`
  // comment): refuses a full-array PUT that looks like it would wipe more than
  // half the existing store, unless the caller explicitly confirms.
  function guardedReplace(storeName, arr, opts) {
    return idb.getAll(storeName).then((existing) => {
      const incoming = arr || [];
      const wipesHalf = existing.length >= 4 && incoming.length < existing.length / 2;
      if (wipesHalf && !(opts && opts.confirm)) {
        return Promise.reject(new Error(
          `Refusing to replace ${storeName}: ${existing.length} -> ${incoming.length} looks like a mass delete. Pass {confirm:true} if intentional.`
        ));
      }
      // Preserve updatedAt for content-identical rows — stamping unconditionally
      // let a freshly-synced device re-stamp its ENTIRE library newest and
      // steamroll the whole fleet via LWW (ROOT CAUSE of the 2026-07-16 event:
      // ~6,600 phantom re-stamps originated from one PWA full-array persist).
      // Mirrors core/db.js upsertCard's sig-compare stamping.
      const prior = {};
      existing.forEach((r) => { if (r && r.id != null) prior[r.id] = r; });
      const stamped = incoming.map((row) => {
        const p = prior[row.id];
        if (p && p.updatedAt != null && contentSig(p) === contentSig(row)) {
          const keep = Object.assign({}, row); keep.updatedAt = p.updatedAt; return keep;
        }
        return nowStamp(Object.assign({}, row));
      });
      return idb.clear(storeName).then(() => idb.putMany(storeName, stamped));
    });
  }

  const Store = {
    // --- kv ---
    kvGet(key) { return idb.kvGet(key); },
    kvSet(key, val) { return idb.kvSet(key, val); },

    // --- cards ---
    getCards() { return idb.getAll("cards"); },
    putCards(arr, opts) { return guardedReplace("cards", arr, opts).then(() => ({ ok: true })); },
    patchCard(card) { return idb.put("cards", nowStamp(Object.assign({}, card))).then(() => {}); },
    // A delete must also leave a tombstone (mirrors core/db.js's deleteCard) —
    // otherwise the next sync cycle sees "local doesn't have it, peer does" and
    // resurrects it as an upsert instead of propagating the delete.
    delCard(id) { return idb.delete("cards", id).then(() => idb.addTombstone("card", id)).then(() => {}); },

    // --- saved ---
    getSaved() { return idb.getAll("saved"); },
    putSaved(arr, opts) { return guardedReplace("saved", arr, opts).then(() => ({ ok: true })); },
    patchSaved(item) { return idb.put("saved", nowStamp(Object.assign({}, item))).then(() => {}); },
    delSaved(id) { return idb.delete("saved", id).then(() => idb.addTombstone("saved", id)).then(() => {}); },

    // --- images: /idb-img/<id> is served by sw.js's fetch handler ---
    imgUrl(id) { return "idb-img/" + encodeURIComponent(id); },
    imgPut(id, dataUrl) {
      return dataUrlToBlob(dataUrl).then((blob) => idb.put("images", { id, blob, type: blob.type })).then(() => {});
    },
    imgDel(id) { return idb.delete("images", id).then(() => {}); },
    imgHas(id) { return idb.get("images", id).then((row) => !!row); },
    // On-demand image fetch (spec 2026-07-17): resolves true when the image is
    // in idb (already or after fetching from a peer's Dropbox folder).
    ensureImage(id) { return window.IASync && window.IASync.ensureImage ? window.IASync.ensureImage(id) : Promise.resolve(false); },

    // --- fingerprints ---
    fpGet(id) { return idb.get("fp", id).then((row) => (row ? row.fp : null)); },
    fpSet(id, fp) { return idb.put("fp", { id, fp }).then(() => {}); },
    fpDel(id) { return idb.delete("fp", id).then(() => {}); },
    fpAll() {
      return idb.getAll("fp").then((rows) => {
        const out = {};
        rows.forEach((r) => { out[r.id] = r.fp; });
        return out;
      });
    },

    // --- capture bridge: N/A on iPad (no Chrome extension) ---
    drainCaptures: () => Promise.resolve([]),
    setCaptureRequest: () => Promise.resolve(),
    getBatchState: () => Promise.resolve(null),
    setBatchState: () => Promise.resolve(),
    setBatchProgress: () => Promise.resolve(),

    // --- backup / restore / store location / import: N/A on iPad — the sync
    // model itself is the backup/restore path (see docs/iphone-sync-design.md) ---
    backupNow: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — Dropbox sync is the backup." }),
    listBackups: () => Promise.resolve([]),
    restore: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — resync from Dropbox instead." }),
    storeLocation: () => Promise.resolve({ ok: true, path: "(browser IndexedDB)" }),
    moveStore: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad." }),
    health: () => Promise.resolve({ ok: true }),
    runImport: () => Promise.resolve({ ok: false, reason: "Import is desktop-only." }),

    // --- sync: wired to pwa/oauth.js (transport) + pwa/sync-pwa.js (merge cycle).
    // "folder" (setSyncFolder) has no PWA equivalent — the sync path is always
    // /Interests App/sync/ within whichever Dropbox account is connected, since
    // there's no local filesystem to point at a different folder. ---
    syncStatus() {
      return idb.kvGet("_pwa_sync_enabled").then((enabled) =>
        window.IASync.ensureDeviceIdentity().then(({ deviceId, deviceLabel }) => ({
          enabled: !!enabled,
          connected: window.IADropbox.isConnected(),
          deviceId, deviceLabel,
        }))
      );
    },
    setSyncEnabled(b) { return idb.kvSet("_pwa_sync_enabled", !!b).then(() => ({ ok: true })); },
    setSyncFolder: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — always /Interests App/sync/." }),
    setDeviceLabel(label) { return window.IASync.setDeviceLabel(label).then(() => ({ ok: true })); },
    // Reads back what syncNow() last persisted (see below) — lets the Settings
    // panel show "Last sync: succeeded/failed" any time it's opened, not only
    // right after tapping Sync. Desktop's web/storage.js has no equivalent;
    // callers must feature-detect (typeof Store.lastSyncResult === "function").
    lastSyncResult() { return idb.kvGet("_pwa_last_sync_result"); },
    // onProgress (optional): ({phase, done, total}) => void — called periodically
    // during a long sync so callers can show live status instead of a static
    // "Syncing..." that's indistinguishable from a hang for a large library.
    //
    // ALWAYS resolves (never rejects), and persists every outcome — not
    // connected, a thrown getAccessToken/runSyncCycle failure, or a normal
    // result — to idb's kv store via persist(), so lastSyncResult() above
    // always reflects the true last attempt regardless of how it ended.
    syncNow(onProgress) {
      const Dbx = window.IADropbox;
      const appKey = localStorage.getItem(Dbx.LS_KEYS.appKey);
      const persist = (result) => idb.kvSet("_pwa_last_sync_result", Object.assign({ at: Date.now() }, result))
        .then(() => result, (e) => { console.error("sync: failed to persist last sync result:", e && e.message); return result; });
      if (!appKey || !Dbx.isConnected()) {
        return persist({ ok: false, code: "AUTH_EXPIRED", reason: "Not connected to Dropbox." });
      }
      return Dbx.getAccessToken(appKey)
        .then((token) => window.IASync.runSyncCycle(token, { onProgress }))
        .then((result) => persist(Object.assign({ ok: true }, result)))
        .catch((e) => persist({ ok: false, code: (e && e.code) || "OTHER", reason: (e && e.message) || String(e) }));
    },

    // --- browser bookmarks / link / content / safety checks / news: desktop-only,
    // out of scope for iPad per product decision (see pwa/README.md) ---
    bookmarkSources: () => Promise.resolve([]),
    bookmarks: () => Promise.resolve([]),
    checkLinks: () => Promise.resolve([]),
    // Calls the Cloudflare Worker configured via worker-config.html (see
    // cf-worker/README.md). Falls back to resolving [] — same as before this
    // wiring existed — if no Worker is configured, so Stumble's verification
    // just fails closed (shows nothing) rather than throwing.
    checkContent(items) {
      const url = localStorage.getItem("ia_pwa_contentcheck_url");
      const token = localStorage.getItem("ia_pwa_contentcheck_token");
      console.log("Store.checkContent: called with " + (items ? items.length : 0) + " item(s)", items);
      if (!url) { console.log("Store.checkContent: no Worker URL configured, returning []"); return Promise.resolve([]); }
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Auth-Token": token || "" },
        body: JSON.stringify({ items: items || [] }),
      }).then((res) => {
        if (!res.ok) throw new Error("content-check worker: " + res.status);
        return res.json();
      }).then((j) => {
        const results = (j && j.results) || [];
        console.log("Store.checkContent: worker returned " + results.length + " result(s)", results);
        return results;
      }).catch((e) => { console.error("Store.checkContent failed:", e.message); return []; });
    },
    news: () => Promise.resolve([]),
    checkSafety: () => Promise.resolve([]),
    getSafeBrowsingKey: () => Promise.resolve(false),
    setSafeBrowsingKey: () => Promise.resolve({ ok: false }),
    verifySafeBrowsing: () => Promise.resolve("error"),
    captureMeta: () => Promise.resolve([]),

    // --- browser stumble bridge: N/A on iPad ---
    getBrowserStumbleRequest: () => Promise.resolve(null),
    clearBrowserStumbleRequest: () => Promise.resolve(),
    deliverBrowserStumbleResults: () => Promise.resolve(),
    drainBrowserStumbleFeedback: () => Promise.resolve([]),
  };

  window.Store = Store;
})();
