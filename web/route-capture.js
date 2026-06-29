// Pure capture-routing decision (dual browser/Node, like web/storage.js).
// Given a capture and current state, decide what to do — NO side effects.
// Data-safety: a clip never modifies an Imported card; a non-clip image
// capture only matches a confident, same-domain target.
(function (root) {
  "use strict";
  function find(arr, fn) { for (var i = 0; i < arr.length; i++) { if (fn(arr[i])) return arr[i]; } return null; }

  function routeCapture(cap, ctx) {
    ctx = ctx || {};
    var imported = ctx.imported || [];
    var lastOpened = ctx.lastOpened || null;
    var now = ctx.now || 0;
    var normalizeUrl = ctx.normalizeUrl || function (u) { return u || ""; };
    var domain = ctx.domain || function () { return ""; };

    if (!cap || !cap.url) return { action: "skip", reason: "no url" };
    if (cap.dead) return { action: "dead", reason: "extension reported dead/removed" };
    // A clip arriving while the user is actively recapturing a failed card (they clicked its
    // title in the failures modal within RECAP_WINDOW) heals THAT card instead of creating a new
    // Saved entry. The target is the explicit card they clicked, so the clip URL need NOT match
    // (handles redirects / random query params like fatpita's ?i=). One-shot: the renderer disarms
    // recapTarget after a picture lands.
    var RECAP_WINDOW = 15 * 60 * 1000;
    if (cap.clip && ctx.recapTarget && ctx.recapTarget.id && now - (ctx.recapTarget.ts || 0) < RECAP_WINDOW) {
      var rt = find(imported, function (it) { return it.id === ctx.recapTarget.id; });
      if (rt) return { action: "card-image", target: rt, reason: "recapture target (healing failed card)" };
    }
    if (cap.clip) return { action: "saved", reason: "clip -> Saved library (never modifies Imported)" };

    // Non-clip = an image fetched FOR an imported card (batch/auto-capture).
    var target = cap.id ? find(imported, function (it) { return it.id === cap.id; }) : null;
    if (!target) target = find(imported, function (it) { return it.url === cap.url; });
    if (!target) target = find(imported, function (it) { return it.url && normalizeUrl(it.url) === normalizeUrl(cap.url); });
    if (target) return { action: "card-image", target: target, reason: "matched imported card by id/url" };

    var ACTIVE_WINDOW = 10 * 60 * 1000;
    if (lastOpened && lastOpened.id && now - (lastOpened.ts || 0) < ACTIVE_WINDOW) {
      var c = find(imported, function (it) { return it.id === lastOpened.id; });
      if (c && c.url && cap.url) {
        var dc = domain(c.url), dcap = domain(cap.url);
        if (dc && dcap && dc === dcap) return { action: "card-image", target: c, reason: "active card (same domain)" };
      }
    }
    if (cap.force && !cap.id && !cap.blocked) return { action: "saved", reason: "manual capture, no card -> Saved" };
    return { action: "unmatched", reason: "no confident match" };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { routeCapture: routeCapture };
  if (root) root.routeCapture = routeCapture;
})(typeof self !== "undefined" ? self : this);
