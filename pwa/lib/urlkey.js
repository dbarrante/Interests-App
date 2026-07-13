// One URL-canonicalization module (dual browser/Node, route-capture.js pattern).
// Four DELIBERATELY-different canonicalizers share internals here instead of four
// parallel copies in index.html. Their differences are load-bearing (the repo's
// "clipKey not normalizeUrl" data-loss lesson): feed dedupe, general normalization,
// duplicate-scan identity, and clip-dedupe identity each need their own semantics.
//
//   feedKey  (=old urlKey)      raw string strip: lowercase, drop scheme+www, drop
//                               trailing slashes. KEEPS query + hash. No URL parse.
//   normUrl  (=old normalizeUrl) FB l.php redirect unwrap, then host+path only:
//                               strip www, drop query, drop hash, drop trailing
//                               slash, lowercase. Falls back to url.toLowerCase().
//   dupeKey  (=old dupeUrlKey + sanctioned shorts alignment) host+path (as normUrl
//                               but NO FB unwrap) PLUS the identifying query id
//                               (?v / ?story_fbid / ?fbid / ?id) folded back on so
//                               distinct ?v= videos don't collapse. NOW ALSO folds
//                               the YouTube /shorts/<id> and youtu.be/<id> path id
//                               (previously it didn't — clip-dedupe did) so a
//                               duplicate scan groups shorts the same way clip
//                               dedupe does.
//   clipKey  (=old clipKey, unchanged) normUrl base PLUS FB post id (story_fbid /
//                               v / fbid) or YouTube id (?v / /shorts/<id> /
//                               youtu.be/<id>) folded back on.
(function (root) {
  "use strict";

  // host (www-stripped) + path, trailing slash dropped, lowercased. No query/hash.
  function hostPath(u) {
    return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "").toLowerCase();
  }

  // The YouTube video id for a parsed URL + its raw string: ?v=, else the /shorts/<id>
  // path segment, else youtu.be/<id>. Returns "" when none. Matches clipKey's original
  // extraction verbatim (NOTE: path/youtu.be ids keep their original case — the base is
  // lowercased but the folded id is not, preserving byte-identical clipKey output).
  function ytId(u, raw) {
    return u.searchParams.get("v")
      || (/\/shorts\/([^/?#]+)/.exec(u.pathname) || [])[1]
      || (/youtu\.be\/([^/?#]+)/.exec(raw || "") || [])[1]
      || "";
  }

  // feedKey (old urlKey): feed-item dedupe. Pure string transform, keeps query+hash.
  function feedKey(u) {
    return (u || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
  }

  // normUrl (old normalizeUrl): FB redirect unwrap + host+path canonical form.
  function normUrl(url) {
    try {
      var m = /[?&]u=([^&]+)/.exec(url);
      if (/l\.facebook\.com|lm\.facebook\.com/.test(url) && m) { url = decodeURIComponent(m[1]); }
      var u = new URL(url);
      return hostPath(u);
    } catch (e) { return String(url).toLowerCase(); }
  }

  // dupeKey (old dupeUrlKey + sanctioned YouTube-shorts alignment): duplicate-scan
  // identity. host+path plus the identifying query id; and now the YouTube path id
  // (shorts / youtu.be) so shorts group like clip-dedupe groups them.
  function dupeKey(url) {
    try {
      var u = new URL(url);
      var base = hostPath(u);
      var id = u.searchParams.get("v") || u.searchParams.get("story_fbid")
        || u.searchParams.get("fbid") || u.searchParams.get("id") || "";
      // SANCTIONED (review E 2.5): fold the YouTube /shorts/<id> and youtu.be/<id>
      // path id in — dupe-scan now agrees with clip-dedupe on shorts.
      if (!id && /youtube\.com|youtu\.be/i.test(u.hostname)) {
        id = (/\/shorts\/([^/?#]+)/.exec(u.pathname) || [])[1]
          || (/youtu\.be\/([^/?#]+)/.exec(url) || [])[1] || "";
      }
      return id ? base + "?" + id : base;
    } catch (e) { return (url || "").toLowerCase(); }
  }

  // clipKey (unchanged): clip-dedupe identity. normUrl base + FB/YouTube id fold.
  function clipKey(u) {
    var base = normUrl(u || "");
    try {
      var q = new URL(u);
      if (/facebook\.com|fb\.watch/i.test(q.hostname)) {
        var fid = q.searchParams.get("story_fbid") || q.searchParams.get("v") || q.searchParams.get("fbid");
        if (fid) return base + "?" + fid;
      }
      if (/youtube\.com|youtu\.be/i.test(q.hostname)) {
        var yid = ytId(q, u);
        if (yid) return base + "?" + yid;
      }
    } catch (e) {}
    return base;
  }

  var api = { feedKey: feedKey, normUrl: normUrl, dupeKey: dupeKey, clipKey: clipKey };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // Browser: attach the four names directly to root so index.html's bare calls
  // (clipKey(u), normUrl is used internally) keep working without an IA_URL.* rewrite.
  if (root) {
    root.feedKey = feedKey;
    root.normUrl = normUrl;
    root.dupeKey = dupeKey;
    root.clipKey = clipKey;
  }
})(typeof self !== "undefined" ? self : this);
