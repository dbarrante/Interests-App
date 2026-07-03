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

      out.upserts.push({ kind: kind, item: winner.item, updatedAt: winner.updatedAt });
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
    return out;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { mergeSnapshots: mergeSnapshots, _stable: _stable };
  if (root) { root.mergeSnapshots = mergeSnapshots; root._iaStable = _stable; }
})(typeof self !== "undefined" ? self : this);
