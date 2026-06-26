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
    import: function () { return "/api/import"; }
  };

  // Expose SE on the global (browser) so index.html can read /api/img/<id>.
  root.SE = SE;

  // CommonJS export for tests (no-op in the browser where module is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { SE: SE };
  }
})(typeof self !== "undefined" ? self : this);
