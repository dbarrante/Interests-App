// Plan a legacy single-file restore (dual browser/Node, like web/route-capture.js).
// A legacy backup's `keys` object holds full localStorage-style key names
// (ia_imported, ia_saved, ia_settings, ia_fcat, …) mapped to their string
// (usually JSON-stringified) values. The app migrated OFF localStorage to the
// Core service, so restoring must write cards/saved/kv through the store — NOT
// localStorage. This pure module decides WHERE each key goes; it has NO side
// effects. The caller (doRestoreCore) performs the store writes.
//
// Routing:
//   ia_imported            -> plan.cards  (JSON-parsed if a string)
//   ia_saved               -> plan.saved  (JSON-parsed if a string)
//   ia_capture_queue,
//   ia_batch_state,
//   ia_batch_progress,
//   ia_capture_request     -> plan.skipped  (machine-local; never restored)
//   ia_theme               -> plan.theme  (localStorage-only key; the app reads
//                             it via localStorage.getItem("ia_theme"), NOT the
//                             store — the caller applies it with
//                             localStorage.setItem. Stored raw ("dark"/"light"),
//                             never JSON-encoded, so it is NOT decode()d.)
//   everything else (ia_*) -> plan.kv  [{ key, value }]
//
// Value encoding: localStorage values were strings (usually JSON-stringified).
// Store.kvSet(key, val) JSON.stringifies into the body and kvGet JSON.parses on
// read, so we hand back the PARSED value when it parses (keeping round-trip
// fidelity with what load() expects) and the RAW string otherwise.
//
// Key naming (verified against web/index.html): save(k,v) calls
// Store.kvSet("ia_"+k, v) and load(k) calls Store.kvGet("ia_"+k) — the store
// layer (web/storage.js) uses the key verbatim in /api/kv/<key> and does NOT
// prefix internally. So kv entries MUST keep their full "ia_" prefix; the caller
// writes Store.kvSet(e.key, e.value) with the prefix intact.
(function (root) {
  "use strict";

  var MACHINE_LOCAL = ["ia_capture_queue", "ia_batch_state", "ia_batch_progress", "ia_capture_request"];

  // Parse a legacy value: JSON-parse a string when it parses; keep it raw
  // (the plain string) otherwise. Non-string values (already parsed) pass through.
  function decode(v) {
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch (e) { return v; }
  }

  function planLegacyRestore(keys) {
    var plan = { cards: null, saved: null, kv: [], skipped: [], theme: null };
    if (!keys || typeof keys !== "object") return plan;
    var names = Object.keys(keys);
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      if (k === "ia_imported") { plan.cards = decode(keys[k]); continue; }
      if (k === "ia_saved") { plan.saved = decode(keys[k]); continue; }
      // ia_theme is a localStorage-only key (the app never reads it from the
      // store). Keep the raw string value — setTheme stores it verbatim.
      if (k === "ia_theme") { plan.theme = keys[k]; continue; }
      if (MACHINE_LOCAL.indexOf(k) !== -1) { plan.skipped.push(k); continue; }
      plan.kv.push({ key: k, value: decode(keys[k]) });
    }
    return plan;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { planLegacyRestore: planLegacyRestore };
  if (root) root.planLegacyRestore = planLegacyRestore;
})(typeof self !== "undefined" ? self : this);
