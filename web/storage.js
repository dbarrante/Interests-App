/* web/storage.js — the ONLY browser-side code that talks to the Core REST API.
   Pure endpoint builders (SE) are factored out so they can be unit-tested in Node
   via require(); the browser path attaches them (and the Store adapter, added in a
   later step) to window. No bundler — this file is loaded by a plain <script> tag. */
(function (root) {
  "use strict";

  // ---- Pure endpoint builders (no I/O — safe to require() in tests) ----
  var SE = {
    imgUrl: function (id) { return "/api/img/" + id; },
    kv: function (key) { return "/api/kv/" + encodeURIComponent(key); },
    cards: function () { return "/api/cards"; },
    card: function (id) { return "/api/cards/" + encodeURIComponent(id); },
    saved: function () { return "/api/saved"; },
    savedItem: function (id) { return "/api/saved/" + encodeURIComponent(id); },
    fp: function () { return "/api/fp"; },
    fpItem: function (id) { return "/api/fp/" + encodeURIComponent(id); },
    captures: function () { return "/api/captures"; },
    captureAck: function () { return "/api/captures/ack"; },
    captureRequest: function () { return "/api/capture-request"; },
    batchState: function () { return "/api/batch-state"; },
    batchProgress: function () { return "/api/batch-progress"; },
    backup: function () { return "/api/backup"; },
    backups: function () { return "/api/backups"; },
    restore: function () { return "/api/restore"; },
    storeLocation: function () { return "/api/store-location"; },
    storeMove: function () { return "/api/store-location/move"; },
    health: function () { return "/api/health"; },
    import: function () { return "/api/import"; },
    syncStatus: function () { return "/api/sync-status"; },
    syncEnable: function () { return "/api/sync/enable"; },
    syncFolder: function () { return "/api/sync/folder"; },
    syncDeviceLabel: function () { return "/api/sync/device-label"; },
    syncNow: function () { return "/api/sync/now"; },
    checkLinks: function () { return "/api/check-links"; },
    checkContent: function () { return "/api/check-content"; },
    checkSafety: function () { return "/api/check-safety"; },
    safeBrowsingKey: function () { return "/api/safebrowsing-key"; },
    safebrowsingVerify: function () { return "/api/safebrowsing-verify"; },
    bookmarkSources: function () { return "/api/bookmark-sources"; },
    bookmarks: function (browser, profile) { return "/api/bookmarks?browser=" + encodeURIComponent(browser) + "&profile=" + encodeURIComponent(profile); },
    captureMeta: function () { return "/api/capture-meta"; }
    ,categories: function () { return "/api/categories"; }
    ,bstumbleRequest: function () { return "/api/bstumble/request"; }
    ,bstumbleResults: function () { return "/api/bstumble/results"; }
    ,bstumbleFeedback: function () { return "/api/bstumble/feedback"; }
    ,news: function (interests) { return "/api/news?interests=" + encodeURIComponent((interests || []).join(",")); }
    ,autoImportRequest: function () { return "/api/auto-import/request"; }
    ,autoImportStatus: function () { return "/api/auto-import/status"; }
    ,pairingToken: function () { return "/api/pairing-token"; }
    ,pairingConfig: function () { return "/api/pairing-config"; }
  };

  // Expose SE on the global (browser) so index.html can read /api/img/<id>.
  root.SE = SE;

  // ---- Async adapter over the Core REST API (browser-only; uses fetch) ----
  // Only attached when fetch exists (i.e. in the browser). Tests require() the
  // module purely for SE and must NOT see Store.
  if (typeof root.fetch === "function") {
    var jget = function (url) {
      return root.fetch(url).then(function (r) {
        if (!r.ok) throw new Error("GET " + url + " -> " + r.status);
        return r.json();
      });
    };
    var jsend = function (method, url, body) {
      return root.fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw new Error(method + " " + url + " -> " + r.status);
        return r.json();
      });
    };

    // A5: the "as-of" watermark for each full-array PUT — the moment the Store last
    // saw the server's authoritative array. Sent on every PUT so the server keeps
    // rows a background sync merge added after the client loaded (see core/db.js).
    var _asOfCards = 0, _asOfSaved = 0;

    // Reconcile hooks: the renderer sets these so that when a PUT preserves rows
    // via the server's asOf staleness branch (rows merged concurrently that the
    // client's array didn't have), those rows are folded back into the live
    // in-memory array BEFORE _asOf advances. Without this, the next full-array
    // PUT carries a newer asOf and tombstones exactly those rows — the
    // 2026-07-18 data-safety HIGH (and the same class as the 07-16 incident).
    // Called synchronously in the PUT's .then, so any later persist sees the
    // reconciled array. Default no-op keeps headless/test callers working.
    var _reconcileCards = null, _reconcileSaved = null;

    var Store = {
      setReconcileHooks: function (onCards, onSaved) { _reconcileCards = onCards; _reconcileSaved = onSaved; },
      // --- kv (replaces persistent ia_* localStorage) ---
      kvGet: function (key) {
        return jget(SE.kv(key)).then(function (j) {
          if (j == null || j.value == null) return null;
          try { return JSON.parse(j.value); } catch (e) { return j.value; }
        });
      },
      kvSet: function (key, val) {
        return jsend("PUT", SE.kv(key), { value: JSON.stringify(val) }).then(function () {});
      },

      // --- cards ---
      getCards: function () { return jget(SE.cards()).then(function (j) { _asOfCards = Date.now(); return (j && j.cards) || []; }); },
      putCards: function (arr, opts) {
        var body = { cards: arr || [], asOf: _asOfCards };
        if (opts && opts.confirm) body.confirm = true;
        return jsend("PUT", SE.cards(), body).then(function (j) {
          // Fold preserved (concurrently-merged) rows back into the live array
          // BEFORE advancing the clock — order is load-bearing (see above).
          if (j && j.preserved && j.preserved.length && _reconcileCards) { try { _reconcileCards(j.preserved); } catch (e) {} }
          _asOfCards = Date.now();
          return j;
        });
      },
      patchCard: function (card) { return jsend("PATCH", SE.card(card.id), { card: card }).then(function () {}); },
      delCard: function (id) { return jsend("DELETE", SE.card(id)).then(function () {}); },

      // --- saved ---
      getSaved: function () { return jget(SE.saved()).then(function (j) { _asOfSaved = Date.now(); return (j && j.saved) || []; }); },
      putSaved: function (arr, opts) {
        var body = { saved: arr || [], asOf: _asOfSaved };
        if (opts && opts.confirm) body.confirm = true;
        return jsend("PUT", SE.saved(), body).then(function (j) {
          if (j && j.preserved && j.preserved.length && _reconcileSaved) { try { _reconcileSaved(j.preserved); } catch (e) {} }
          _asOfSaved = Date.now();
          return j;
        });
      },
      patchSaved: function (item) { return jsend("PATCH", SE.savedItem(item.id), { item: item }).then(function () {}); },
      delSaved: function (id) { return jsend("DELETE", SE.savedItem(id)).then(function () {}); },

      // --- images: plain URLs for <img src>; no blob fetch, no in-memory cache ---
      imgUrl: function (id) { return SE.imgUrl(id); },
      imgPut: function (id, dataUrl) { return jsend("PUT", SE.imgUrl(id), { data: dataUrl }).then(function () {}); },
      imgDel: function (id) { return jsend("DELETE", SE.imgUrl(id)).then(function () {}); },
      imgHas: function (id) {
        return root.fetch(SE.imgUrl(id), { method: "GET" }).then(function (r) { return r.ok; }).catch(function () { return false; });
      },
      // Desktop images are service-backed and always present locally — the
      // shared renderer calls ensureImage unconditionally (spec 2026-07-17).
      ensureImage: function () { return Promise.resolve(true); },

      // --- fingerprints (placeholder detection; no image bytes) ---
      fpGet: function (id) { return jget(SE.fp()).then(function (j) { return ((j && j.fp) || {})[id] || null; }); },
      fpSet: function (id, fp) { return jsend("PUT", SE.fpItem(id), { value: fp }).then(function () {}); },
      fpDel: function (id) { return jsend("DELETE", SE.fpItem(id)).then(function () {}); },
      fpAll: function () { return jget(SE.fp()).then(function (j) { return (j && j.fp) || {}; }); },

      // --- capture bridge ---
      drainCaptures: function () { return jget(SE.captures()).then(function (j) { return (j && j.captures) || []; }); },
      ackCaptures: function (acks) { return jsend("POST", SE.captureAck(), { acks: acks || [] }).then(function () {}); },
      setCaptureRequest: function (req) { return jsend("POST", SE.captureRequest(), { request: req }).then(function () {}); },
      getBatchState: function () { return jget(SE.batchState()).then(function (j) { return (j && j.state) || null; }); },
      setBatchState: function (s) { return jsend("POST", SE.batchState(), { state: s }).then(function () {}); },
      setBatchProgress: function (p) { return jsend("POST", SE.batchProgress(), { progress: p }).then(function () {}); },

      // --- backup / restore / store location / import ---
      backupNow: function () { return jsend("POST", SE.backup()); },
      listBackups: function () { return jget(SE.backups()).then(function (j) { return (j && j.backups) || []; }); },
      restore: function (name) { return jsend("POST", SE.restore(), { name: name }); },
      recoveryStatus: function () { return Promise.resolve({ available: false, reason: "PWA-only recovery journal" }); },
      recoverLastMerge: function () { return Promise.resolve({ ok: false, reason: "PWA-only recovery journal" }); },
      getPairingToken: function () { return jget(SE.pairingToken()); },
      setPairingRequired: function (required) { return jsend("POST", SE.pairingConfig(), { required: !!required }); },
      storeLocation: function () { return jget(SE.storeLocation()); },
      moveStore: function (target) { return jsend("POST", SE.storeMove(), { target: target }); },
      health: function () { return jget(SE.health()); },
      runImport: function (srcDir) { return jsend("POST", SE.import(), { srcDir: srcDir }); },

      // --- sync ---
      syncStatus: function () { return jget(SE.syncStatus()); },
      setSyncEnabled: function (b) { return jsend("POST", SE.syncEnable(), { enabled: !!b }); },
      setSyncFolder: function (p) { return jsend("POST", SE.syncFolder(), { folder: p }); },
      setDeviceLabel: function (s) { return jsend("POST", SE.syncDeviceLabel(), { label: s }); },
      syncNow: function () { return jsend("POST", SE.syncNow()); },

      // --- browser bookmarks (read-only import source) ---
      bookmarkSources: function () { return jget(SE.bookmarkSources()).then(function (j) { return (j && j.sources) || []; }); },
      bookmarks: function (browser, profile) { return jget(SE.bookmarks(browser, profile)).then(function (j) { return (j && j.bookmarks) || []; }); },
      checkLinks: function (items, opts) { return jsend("POST", SE.checkLinks(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); },
      checkContent: function (items, opts) { return jsend("POST", SE.checkContent(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); },
      news: function (interests) { return jget(SE.news(interests)).then(function (j) { return (j && j.items) || []; }); },
      checkSafety: function (items, opts) { return jsend("POST", SE.checkSafety(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); },
      getSafeBrowsingKey: function () { return jget(SE.safeBrowsingKey()).then(function (j) { return !!(j && j.hasKey); }); },
      setSafeBrowsingKey: function (key) { return jsend("POST", SE.safeBrowsingKey(), { key: key || "" }); },
      verifySafeBrowsing: function () { return jget(SE.safebrowsingVerify()).then(function (j) { return (j && j.state) || "error"; }); },
      captureMeta: function (items, opts) { return jsend("POST", SE.captureMeta(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); },

      // --- browser stumble (renderer drains these; the extension owns the other side) ---
      getBrowserStumbleRequest: function () { return jget(SE.bstumbleRequest()).then(function (j) { return (j && j.request) || null; }); },
      clearBrowserStumbleRequest: function () { return jsend("POST", SE.bstumbleRequest(), { request: null }).then(function () {}); },
      deliverBrowserStumbleResults: function (items) { return jsend("POST", SE.bstumbleResults(), { items: items || [] }).then(function () {}); },
      drainBrowserStumbleFeedback: function () { return jget(SE.bstumbleFeedback()).then(function (j) { return (j && j.feedback) || []; }); },

      // --- FB/IG auto-import (desktop-only; core/autoimport.js) ---
      // Master/per-platform toggles live in ia_settings (kvSet("settings",...) — same
      // kv the extension's GET /api/auto-import/config reads) so no dedicated
      // endpoint is needed for those. Only the "Check now" request mailbox and the
      // last-run status readback are dedicated routes.
      setAutoImportRequest: function (req) { return jsend("POST", SE.autoImportRequest(), { request: req }).then(function () {}); },
      getAutoImportStatus: function () { return jget(SE.autoImportStatus()).then(function (j) { return j || { fb: null, ig: null }; }); }
    };

    root.Store = Store;
  }

  // CommonJS export for tests (no-op in the browser where module is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { SE: SE };
  }
})(typeof self !== "undefined" ? self : this);
