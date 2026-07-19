// Pure parser for a Facebook "Saved" page: given raw HTML (or a Document, via
// parseSavedDoc), finds saved-post anchors and extracts
// { url, title, image, platformKey } for each. Reports a status so a login
// wall or an unrecognized page layout never silently delivers zero/garbage
// items as if it were a real empty result (global constraint: scrapers fail
// SOFT -- a login wall or a zero-entry parse reports a status, imports
// nothing, never partial garbage).
//
// No DOM dependency (NO jsdom): parseSavedHtml is a regex/string-walk over
// the raw markup -- this is the primary, fully-tested path. parseSavedDoc(doc)
// simply serializes doc.documentElement.outerHTML and delegates to
// parseSavedHtml: ONE implementation, so the DOM path and the string path can
// never drift apart.
//
// Recognized URL shapes (platformKey = the post id parsed from the href):
//   facebook.com/<page>/posts/<id>
//   facebook.com/reel/<id>
//   facebook.com/watch/?v=<id>
//   facebook.com/photo/?fbid=<id>          (photo.php also tolerated)
//   facebook.com/groups/<g>/posts/<id>
//   facebook.com/permalink.php?story_fbid=<id>&id=<n>   (key = story_fbid only)
// Everything else (profile links, hashtag/explore links, nav, login links)
// is silently ignored -- the pattern whitelist IS the junk filter.
//
// Title resolution order: the anchor's own aria-label, else its inner text,
// else the nearest preceding aria-label within the enclosing <li> block.
// Capped to 512 chars. Image: the nearest http(s) <img src> within the same
// block, passed through UNTOUCHED -- durableImage()/CDN-signing conversion
// happens in the extension's background layer, not here.
(function (root) {
  "use strict";

  var CAP = 100;

  var PATH_PATTERNS = [
    { type: "posts", re: /^https?:\/\/(?:www\.)?facebook\.com\/[^\/?#]+\/posts\/([^\/?#&]+)/i },
    { type: "reel", re: /^https?:\/\/(?:www\.)?facebook\.com\/reel\/([^\/?#&]+)/i },
    { type: "groupposts", re: /^https?:\/\/(?:www\.)?facebook\.com\/groups\/[^\/?#]+\/posts\/([^\/?#&]+)/i }
  ];
  var QUERY_PATTERNS = [
    { type: "watch", host: /^https?:\/\/(?:www\.)?facebook\.com\/watch\/?(?:[?#]|$)/i, param: "v" },
    { type: "photo", host: /^https?:\/\/(?:www\.)?facebook\.com\/photo(?:\.php)?\/?(?:[?#]|$)/i, param: "fbid" },
    { type: "permalink", host: /^https?:\/\/(?:www\.)?facebook\.com\/permalink\.php(?:[?#]|$)/i, param: "story_fbid" }
  ];

  // FB: name="login" / id="loginform" / action*="login". IG: class="loginForm" /
  // href*="/accounts/login/". Kept broad on purpose -- a shared, tested
  // heuristic beats two subtly-different ones drifting apart.
  var LOGIN_RE = /(?:\bname=["']login["'])|(?:\bid=["']loginform["'])|(?:\baction=["'][^"']*login[^"']*["'])|(?:\bclass=["'][^"']*loginform[^"']*["'])|(?:\/accounts\/login\/)/i;

  function decodeEntities(s) {
    return String(s == null ? "" : s)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  function stripTags(s) {
    return String(s == null ? "" : s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  function extractAttr(tag, name) {
    var m = new RegExp(name + '\\s*=\\s*"([^"]*)"', "i").exec(tag);
    if (m) return m[1];
    m = new RegExp(name + "\\s*=\\s*'([^']*)'", "i").exec(tag);
    return m ? m[1] : null;
  }
  function getQueryParam(url, name) {
    var m = new RegExp("[?&]" + name + "=([^&#]+)").exec(url);
    return m ? m[1] : null;
  }
  function matchPattern(url) {
    for (var i = 0; i < PATH_PATTERNS.length; i++) {
      var m = PATH_PATTERNS[i].re.exec(url);
      if (m) return { type: PATH_PATTERNS[i].type, id: m[1] };
    }
    for (var j = 0; j < QUERY_PATTERNS.length; j++) {
      if (QUERY_PATTERNS[j].host.test(url)) {
        var id = getQueryParam(url, QUERY_PATTERNS[j].param);
        if (id) return { type: QUERY_PATTERNS[j].type, id: id };
      }
    }
    return null;
  }

  // "Enclosing element block" = the nearest <li>...</li> around an anchor.
  // Our own fixtures (and the content-script capture that will feed this in
  // a later task) render each saved entry as one <li>; an anchor with no
  // enclosing <li> just falls back to its own tag for title/image.
  function findBlocks(html) {
    var blocks = [];
    var re = /<li\b[^>]*>[\s\S]*?<\/li>/gi;
    var m;
    while ((m = re.exec(html))) blocks.push({ start: m.index, end: m.index + m[0].length, content: m[0] });
    return blocks;
  }
  function blockFor(blocks, idx) {
    for (var i = 0; i < blocks.length; i++) if (idx >= blocks[i].start && idx < blocks[i].end) return blocks[i];
    return null;
  }
  function nearestPrecedingAriaLabel(block, localIdx) {
    if (!block) return "";
    var re = /aria-label\s*=\s*["']([^"']*)["']/gi;
    var m, best = "";
    while ((m = re.exec(block.content))) {
      if (m.index < localIdx) best = m[1]; else break;
    }
    return best;
  }
  function nearestImage(block, localIdx) {
    if (!block) return "";
    var re = /<img\b[^>]*>/gi;
    var m, bestSrc = "", bestDist = Infinity;
    while ((m = re.exec(block.content))) {
      var src = extractAttr(m[0], "src");
      if (!src || !/^https?:\/\//i.test(src)) continue;
      var dist = Math.abs(m.index - localIdx);
      if (dist < bestDist) { bestDist = dist; bestSrc = src; }
    }
    return decodeEntities(bestSrc);
  }

  function extractItems(html) {
    var items = [];
    var seen = Object.create(null);
    var blocks = findBlocks(html);
    var re = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      if (items.length >= CAP) break;
      var whole = m[0];
      var openTagMatch = /^<a\b[^>]*>/i.exec(whole);
      var openTag = openTagMatch ? openTagMatch[0] : "<a>";
      var hrefRaw = extractAttr(openTag, "href");
      if (!hrefRaw) continue;
      var href = decodeEntities(hrefRaw);
      var pat = matchPattern(href);
      if (!pat) continue;
      var key = pat.type + ":" + pat.id;
      if (seen[key]) continue;

      var block = blockFor(blocks, m.index);
      var localIdx = block ? (m.index - block.start) : 0;

      var title = decodeEntities(extractAttr(openTag, "aria-label") || "").trim();
      if (!title) {
        var innerMatch = /^<a\b[^>]*>([\s\S]*)<\/a>$/i.exec(whole);
        title = decodeEntities(stripTags(innerMatch ? innerMatch[1] : ""));
      }
      if (!title) title = decodeEntities(nearestPrecedingAriaLabel(block, localIdx)).trim();
      title = title.slice(0, 512);

      var image = nearestImage(block, localIdx);

      seen[key] = true;
      items.push({ url: href, title: title, image: image, platformKey: pat.id });
    }
    return items;
  }

  function parseSavedHtml(html) {
    html = String(html == null ? "" : html);
    var items = extractItems(html);
    if (items.length > 0) return { status: "ok", items: items };
    if (LOGIN_RE.test(html)) return { status: "login-required", items: [] };
    return { status: "parse-failed", items: [] };
  }

  function parseSavedDoc(doc) {
    var html = "";
    try { html = doc && doc.documentElement ? doc.documentElement.outerHTML : ""; } catch (e) { html = ""; }
    return parseSavedHtml(html);
  }

  var api = { parseSavedHtml: parseSavedHtml, parseSavedDoc: parseSavedDoc };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.IASavedParseFB = api;
})(typeof self !== "undefined" ? self : this);
