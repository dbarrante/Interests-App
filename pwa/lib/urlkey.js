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

  // The Instagram post shortcode for a parsed URL: /p/<code>/, /reel/<code>/, or
  // /tv/<code>/ (IGTV). Instagram serves the SAME post under both /p/ and /reel/
  // (and sometimes /tv/) -- unlike FB/YouTube's query-param id, which is appended
  // to an already-shared base path, these three differ at the base-path level
  // itself, so folding just an id onto hostPath() wouldn't unify them. Case
  // preserved (matches ytId's convention) — only the host gets lowercased.
  function igId(u) {
    return (/\/(?:p|reel|tv)\/([^/?#]+)/.exec(u.pathname) || [])[1] || "";
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
      // Instagram: /p/<code>/ and /reel/<code>/ (and /tv/<code>/) are the SAME
      // post — fold straight to host+shortcode, bypassing hostPath()'s differing
      // base path entirely (see igId's comment).
      if (/instagram\.com/i.test(u.hostname)) {
        var igid0 = igId(u);
        if (igid0) return "instagram.com?" + igid0;
      }
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
      // Instagram: fold /p/<code>/ and /reel/<code>/ (and /tv/<code>/) to one
      // identity — see igId's comment on why this can't just append onto base.
      if (/instagram\.com/i.test(q.hostname)) {
        var igid = igId(q);
        if (igid) return "instagram.com?" + igid;
      }
    } catch (e) {}
    return base;
  }

  // isSpecificPostUrl: true when `url` identifies a single post/video, false for
  // a bare profile/category/feed page (e.g. instagram.com/natgeo, facebook.com/
  // watch). dupeKey groups by host+path when no query id is found, WITHOUT this
  // distinction -- fine for a human reviewing the Duplicates tab (scanDuplicates'
  // own comment already warns "a profile-PATH URL... can still group unrelated
  // posts an auto-import mis-stamped with it"), unsafe for anything that deletes
  // cards unattended (autoMergeLinkDuplicates, index.html). A clip taken while a
  // permalink can't be resolved is stamped with the page URL itself (see
  // extension/capture-core.js's isSpecificUrl fallback) -- three unrelated posts
  // clipped from the same profile grid would otherwise share one dupeKey and get
  // silently merged into one card, losing the other two.
  //
  // Deliberately STRICTER than the extension's fbIsSpecific/igIsSpecific
  // (capture-configs.js): those are a loose pre-filter before further
  // verification (findPermalink narrows it down further before ever using the
  // URL), so bare keywords like "watch" or "videos" are good enough there. Here
  // a false POSITIVE means an unattended delete of a real, distinct post, so
  // every path keyword below requires an actual id segment or query id to
  // follow it -- "facebook.com/watch" (the Watch home tab, no video) and
  // "facebook.com/user/videos" (a profile's videos TAB, no specific video) must
  // both be false; "facebook.com/watch?v=123" and ".../videos/456" must be true.
  function isSpecificPostUrl(url) {
    try {
      var u = new URL(url);
      var host = u.hostname.replace(/^www\./, "");
      var path = u.pathname;
      if (/instagram\.com/i.test(host)) return /\/(p|reel|reels|tv)\/[\w.-]+/.test(path);
      if (/facebook\.com|fb\.watch/i.test(host)) {
        if (/story_fbid=|[?&]fbid=|[?&]v=|[?&]id=/.test(u.search)) return true;
        // A trailing segment after the keyword rejects the TAB pages (.../videos,
        // .../photos with nothing after) -- but a follow-up review found it does
        // NOT reject a listing page one level deeper (.../photos/albums): "albums"
        // is a real word, not a post id. Require the segment to actually look like
        // one -- all-digits, a pfbid-prefixed token, or a long opaque token -- so a
        // real English word never qualifies.
        var pm = /\/(?:posts|permalink|videos|reel|reels|photos?|story\.php|share\/[pvr]|groups\/[^/]+\/(?:posts|permalink))\/([^/?#]+)/.exec(path);
        return !!(pm && /^(?:\d+|pfbid[\w-]+|[\w-]{10,})$/.test(pm[1]));
      }
      if (/youtube\.com|youtu\.be/i.test(host)) return !!(u.searchParams.get("v") || /\/shorts\/[^/?#]+/.test(path) || /youtu\.be\/[^/?#]+/i.test(url));
      if (/pinterest\./i.test(host)) return /\/pin\/[\w-]+/.test(path);
      // Generic fallback: any query id dupeKey itself would fold in.
      return !!(u.searchParams.get("v") || u.searchParams.get("story_fbid") || u.searchParams.get("fbid") || u.searchParams.get("id"));
    } catch (e) { return false; }
  }

  var api = { feedKey: feedKey, normUrl: normUrl, dupeKey: dupeKey, clipKey: clipKey, isSpecificPostUrl: isSpecificPostUrl };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // Browser: attach the four names directly to root so index.html's bare calls
  // (clipKey(u), normUrl is used internally) keep working without an IA_URL.* rewrite.
  if (root) {
    root.feedKey = feedKey;
    root.normUrl = normUrl;
    root.dupeKey = dupeKey;
    root.clipKey = clipKey;
    root.isSpecificPostUrl = isSpecificPostUrl;
  }
})(typeof self !== "undefined" ? self : this);
