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
    bookmarkSources: function () { return "/api/bookmark-sources"; },
    bookmarks: function (browser, profile) { return "/api/bookmarks?browser=" + encodeURIComponent(browser) + "&profile=" + encodeURIComponent(profile); },
    captureMeta: function () { return "/api/capture-meta"; }
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

    var Store = {
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
      getCards: function () { return jget(SE.cards()).then(function (j) { return (j && j.cards) || []; }); },
      putCards: function (arr) { return jsend("PUT", SE.cards(), { cards: arr || [] }); },
      patchCard: function (card) { return jsend("PATCH", SE.card(card.id), { card: card }).then(function () {}); },
      delCard: function (id) { return jsend("DELETE", SE.card(id)).then(function () {}); },

      // --- saved ---
      getSaved: function () { return jget(SE.saved()).then(function (j) { return (j && j.saved) || []; }); },
      putSaved: function (arr) { return jsend("PUT", SE.saved(), { saved: arr || [] }); },
      patchSaved: function (item) { return jsend("PATCH", SE.savedItem(item.id), { item: item }).then(function () {}); },
      delSaved: function (id) { return jsend("DELETE", SE.savedItem(id)).then(function () {}); },

      // --- images: plain URLs for <img src>; no blob fetch, no in-memory cache ---
      imgUrl: function (id) { return SE.imgUrl(id); },
      imgPut: function (id, dataUrl) { return jsend("PUT", SE.imgUrl(id), { data: dataUrl }).then(function () {}); },
      imgDel: function (id) { return jsend("DELETE", SE.imgUrl(id)).then(function () {}); },
      imgHas: function (id) {
        return root.fetch(SE.imgUrl(id), { method: "GET" }).then(function (r) { return r.ok; }).catch(function () { return false; });
      },

      // --- fingerprints (placeholder detection; no image bytes) ---
      fpGet: function (id) { return jget(SE.fp()).then(function (j) { return ((j && j.fp) || {})[id] || null; }); },
      fpSet: function (id, fp) { return jsend("PUT", SE.fpItem(id), { value: fp }).then(function () {}); },
      fpDel: function (id) { return jsend("DELETE", SE.fpItem(id)).then(function () {}); },
      fpAll: function () { return jget(SE.fp()).then(function (j) { return (j && j.fp) || {}; }); },

      // --- capture bridge ---
      drainCaptures: function () { return jget(SE.captures()).then(function (j) { return (j && j.captures) || []; }); },
      setCaptureRequest: function (req) { return jsend("POST", SE.captureRequest(), { request: req }).then(function () {}); },
      getBatchState: function () { return jget(SE.batchState()).then(function (j) { return (j && j.state) || null; }); },
      setBatchState: function (s) { return jsend("POST", SE.batchState(), { state: s }).then(function () {}); },
      setBatchProgress: function (p) { return jsend("POST", SE.batchProgress(), { progress: p }).then(function () {}); },

      // --- backup / restore / store location / import ---
      backupNow: function () { return jsend("POST", SE.backup()); },
      listBackups: function () { return jget(SE.backups()).then(function (j) { return (j && j.backups) || []; }); },
      restore: function (name) { return jsend("POST", SE.restore(), { name: name }); },
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
      checkSafety: function (items, opts) { return jsend("POST", SE.checkSafety(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); },
      getSafeBrowsingKey: function () { return jget(SE.safeBrowsingKey()).then(function (j) { return !!(j && j.hasKey); }); },
      setSafeBrowsingKey: function (key) { return jsend("POST", SE.safeBrowsingKey(), { key: key || "" }); },
      captureMeta: function (items, opts) { return jsend("POST", SE.captureMeta(), Object.assign({ items: items || [] }, opts || {})).then(function (j) { return (j && j.results) || []; }); }
    };

    root.Store = Store;
  }

  // CommonJS export for tests (no-op in the browser where module is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { SE: SE };
  }
})(typeof self !== "undefined" ? self : this);
