// pwa/merge.js — verbatim copy of core/merge.js. Pure, no I/O, dual browser/Node
// by design (see its own header comment) — reused unmodified here rather than
// ported, per docs/iphone-sync-design.md's explicit recommendation. Re-copy if
// core/merge.js changes upstream.

// Pure multi-device merge (dual browser/Node, like web/route-capture.js).
// Newest updatedAt wins per item; tombstones prevent resurrect; images follow
// the winning item. NO I/O — fs paths are passed in (peer.dir) and echoed out.
(function (root) {
  "use strict";

  function _stable(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(_stable).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + _stable(v[k]); }).join(",") + "}";
  }
  // Compare two items for content equality, ignoring updatedAt.
  function sameContent(a, b) {
    if (!a || !b) return false;
    var ca = Object.assign({}, a); delete ca.updatedAt;
    var cb = Object.assign({}, b); delete cb.updatedAt;
    return _stable(ca) === _stable(cb);
  }
  function isIdbImage(item, kind) {
    var ref = kind === "card" ? (item && item.img) : (item && item.image);
    return typeof ref === "string" && ref.indexOf("idb:") === 0;
  }

  function mergeKind(kind, localMap, peers, localTombs, out) {
    var ids = {};
    Object.keys(localMap).forEach(function (id) { ids[id] = true; });
    peers.forEach(function (p) {
      (kind === "card" ? p.cards : p.saved).forEach(function (it) { if (it && it.id) ids[it.id] = true; });
      p.tombstones.forEach(function (t) { if (t.kind === kind) ids[t.id] = true; });
    });

    Object.keys(ids).forEach(function (id) {
      // winner = greatest updatedAt; local wins exact ties.
      var winner = localMap[id] ? { item: localMap[id], updatedAt: localMap[id].updatedAt || 0, source: "local", dir: null } : null;
      peers.forEach(function (p) {
        var list = kind === "card" ? p.cards : p.saved;
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (!it || it.id !== id) continue;
          var ua = it.updatedAt || 0;
          if (!winner || ua > winner.updatedAt) winner = { item: it, updatedAt: ua, source: p.deviceId, dir: p.dir, imageIds: p.imageIds };
        }
      });
      // newest tombstone across local + peers
      var tomb = localTombs[kind + ":" + id] || 0;
      peers.forEach(function (p) {
        p.tombstones.forEach(function (t) { if (t.kind === kind && t.id === id && t.deletedAt > tomb) tomb = t.deletedAt; });
      });

      if (tomb && (!winner || tomb > winner.updatedAt)) {
        // Carry the winning tombstone's ORIGINAL deletedAt on the delete entry so
        // applyMerge stamps it verbatim — without it, deleteCard/deleteSaved fall
        // back to Date.now(), and (addTombstone keeps the MAX) the delete would
        // look newer at every merge hop, able to swallow a legitimate re-add.
        if (localMap[id]) out.deletes.push({ kind: kind, id: id, deletedAt: tomb });
        out.tombstones.push({ id: id, kind: kind, deletedAt: tomb });
        return;
      }
      if (!winner || winner.source === "local") return;     // local already current
      if (localMap[id] && (winner.updatedAt <= (localMap[id].updatedAt || 0))) return;

      // `from` = the winning peer's deviceId — lets appliers attribute a
      // deferred upsert to its source peer, so ONE peer's missing images
      // can't block every other peer's watermark (per-peer clean gating).
      out.upserts.push({ kind: kind, item: winner.item, updatedAt: winner.updatedAt, from: winner.source });
      if (localMap[id] && !sameContent(localMap[id], winner.item)) out.conflicts++;
      if (isIdbImage(winner.item, kind) && winner.imageIds && winner.imageIds.indexOf(id) >= 0) {
        out.imageCopies.push({ id: id, fromDir: winner.dir });
      }
    });
  }

  function mergeSnapshots(local, peers) {
    local = local || {}; peers = peers || [];
    var out = { upserts: [], deletes: [], tombstones: [], imageCopies: [], conflicts: 0 };
    mergeKind("card", local.cards || {}, peers, local.tombstones || {}, out);
    mergeKind("saved", local.saved || {}, peers, local.tombstones || {}, out);
    // Settings: last-writer-wins by updatedAt. Emit out.settings ONLY when a peer's
    // settings are strictly newer than local — so a settings-only change from another
    // device propagates while equal/older peers never clobber local. (Secrets were
    // already stripped at publish time; applyMerge re-preserves local keys anyway.)
    var localUA = Number(local.settings && local.settings.updatedAt) || 0;
    var best = null, bestUA = localUA;
    peers.forEach(function (p) {
      var ps = p && p.settings;
      if (ps && ps.data && (Number(ps.updatedAt) || 0) > bestUA) { bestUA = Number(ps.updatedAt) || 0; best = ps; }
    });
    if (best) out.settings = { data: best.data, updatedAt: bestUA };
    return out;
  }

  // Apply-side merge for synced settings (2026-07-16 spec): `incoming` won
  // last-writer-wins at the blob level, but credentials merge per-field —
  // a device that has never held a key publishes an empty keys object before
  // its first receive, and must not wipe the fleet's keys. updateToken is a
  // desktop-local GitHub credential: never travels, never overwritten.
  function _nonEmptyStrings(obj) {
    var out = {};
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      Object.keys(obj).forEach(function (k) {
        if (typeof obj[k] === "string" && obj[k].trim()) out[k] = obj[k];
      });
    }
    return out;
  }
  function mergeSyncedSettings(local, incoming) {
    local = (local && typeof local === "object") ? local : {};
    incoming = (incoming && typeof incoming === "object") ? incoming : {};
    var merged = Object.assign({}, incoming);
    var localKeys = (local.keys && typeof local.keys === "object" && !Array.isArray(local.keys)) ? local.keys : {};
    merged.keys = Object.assign({}, localKeys, _nonEmptyStrings(incoming.keys));
    if (typeof incoming.oprKey === "string" && incoming.oprKey.trim()) merged.oprKey = incoming.oprKey;
    else if (local.oprKey != null) merged.oprKey = local.oprKey;
    else delete merged.oprKey;
    if (local.updateToken != null) merged.updateToken = local.updateToken;
    else delete merged.updateToken;
    return merged;
  }

  // Whether the union-merged blob carries sync-visible content the incoming
  // blob lacks (a local-only provider key, a preserved oprKey). If so, the
  // applier must RE-STAMP fresh instead of adopting the incoming stamp:
  // adopting it verbatim freezes the enrichment behind mergeSnapshots' strictly-
  // newer gate forever — a key entered on exactly one device would never
  // propagate outward (adversarial review 2026-07-16). updateToken is excluded:
  // it never syncs, so it must never trigger a re-stamp (that would oscillate).
  // Convergence: each publish carries the union, so what any device "lacks"
  // shrinks monotonically — re-stamping terminates once the fleet converges.
  function settingsEnrichedByLocal(merged, incoming) {
    var m = Object.assign({}, merged); delete m.updateToken;
    var i = mergeSyncedSettings({}, incoming); delete i.updateToken;
    return _stable(m) !== _stable(i);
  }

  // Deterministic signature over the aggregates that can affect a published
  // snapshot. Signature-equality ⇒ republishing would produce identical
  // content: every mutating path bumps one of these (edits stamp updatedAt,
  // deletes add tombstones with deletedAt, settings edits stamp
  // ia_settings_updatedAt). Used by both sides' publish-skip. "v1|" prefix so
  // a future field change can never alias an old signature.
  function contentSignature(agg) {
    agg = (agg && typeof agg === "object") ? agg : {};
    function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
    return "v1|" + n(agg.cards) + "|" + n(agg.saved) + "|" + n(agg.tombstones) + "|" +
      n(agg.maxCardUpdatedAt) + "|" + n(agg.maxSavedUpdatedAt) + "|" + n(agg.maxTombDeletedAt) + "|" + n(agg.settingsUpdatedAt);
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { mergeSnapshots: mergeSnapshots, mergeSyncedSettings: mergeSyncedSettings, settingsEnrichedByLocal: settingsEnrichedByLocal, _stable: _stable, contentSignature: contentSignature };
  if (root) { root.mergeSnapshots = mergeSnapshots; root.mergeSyncedSettings = mergeSyncedSettings; root.settingsEnrichedByLocal = settingsEnrichedByLocal; root._iaStable = _stable; root.contentSignature = contentSignature; }
})(typeof self !== "undefined" ? self : this);
