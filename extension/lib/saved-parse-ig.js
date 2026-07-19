// Pure parser for an Instagram "Saved" page: given raw HTML (or a Document,
// via parseSavedDoc), finds saved-post anchors and extracts
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
// never drift apart. (Mirrors extension/lib/saved-parse-fb.js.)
//
// Recognized URL shapes (platformKey = the shortcode):
//   instagram.com/p/<shortcode>/
//   instagram.com/reel/<shortcode>/
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

  // Live-tuning 2026-07-19 (real captured /<username>/saved/all-posts/ page):
  // IG renders saved-grid tile hrefs RELATIVE ("/p/<code>/"), so the host
  // part is optional. The pattern still anchors the path at ^ (after the
  // optional host), so /explore/p/<code>/, profile paths, AND
  // username-prefixed profile-grid links ("/<username>/p/<code>/" — e.g.
  // "/saved/p/…" from the account literally named @saved) can never match:
  // a profile grid is someone ELSE'S posts, not the viewer's saves. Matched
  // urls are always delivered in CANONICAL form
  // (https://www.instagram.com/<p|reel>/<code>/) — stable, shareable, and
  // what later capture-enrichment expects.
  var PATH_PATTERNS = [
    { type: "p", re: /^(?:https?:\/\/(?:www\.)?instagram\.com)?\/p\/([A-Za-z0-9_-]+)/i },
    { type: "reel", re: /^(?:https?:\/\/(?:www\.)?instagram\.com)?\/reel\/([A-Za-z0-9_-]+)/i }
  ];
  function canonicalUrl(pat) {
    return "https://www.instagram.com/" + pat.type + "/" + pat.id + "/";
  }

  // FB: name="login" / id="loginform" / action*="login". IG: class="loginForm" /
  // href*="/accounts/login/". Kept broad on purpose -- a shared, tested
  // heuristic beats two subtly-different ones drifting apart.
  var LOGIN_RE = /(?:\bname=["']login["'])|(?:\bid=["']loginform["'])|(?:\baction=["'][^"']*login[^"']*["'])|(?:\bclass=["'][^"']*loginform[^"']*["'])|(?:\/accounts\/login\/)/i;

  // Review Finding 2 fix: inline <script> hydration payloads (and <style>
  // blocks) can carry literal anchor markup as string data; a raw scan over
  // the full page would extract those as real items. Strip both regions
  // BEFORE any block/anchor walk. Single linear regex pass, lazy per-block.
  function stripScriptStyle(html) {
    return String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  }

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
  function matchPattern(url) {
    for (var i = 0; i < PATH_PATTERNS.length; i++) {
      var m = PATH_PATTERNS[i].re.exec(url);
      if (m) return { type: PATH_PATTERNS[i].type, id: m[1] };
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

  // Live-tuning 2026-07-19 (real captured /saved/all-posts/ page): each tile
  // is ONE <a> wrapping the <img>; the caption lives in the img's alt
  // attribute, and video tiles carry a junk "Clip" overlay as inner text —
  // so the in-anchor alt outranks inner text. Anchors are still grouped by
  // bare shortcode (mirrors saved-parse-fb.js) so a post reached via both
  // /p/ and /reel/ shapes merges its fragments into ONE item.
  function extractItems(html) {
    // Pass 1: group every recognized anchor by bare shortcode, in DOM order.
    // Review Finding 1 fix: grouping on the BARE shortcode (first-encountered
    // url wins), not type:id — the same post reached via /p/<code>/ AND
    // /reel/<code>/ must collapse to ONE item, since platformKey exposes
    // only the bare shortcode.
    var groups = [];
    var byKey = Object.create(null);
    var blocks = findBlocks(html);
    var re = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      var whole = m[0];
      var openTagMatch = /^<a\b[^>]*>/i.exec(whole);
      var openTag = openTagMatch ? openTagMatch[0] : "<a>";
      var hrefRaw = extractAttr(openTag, "href");
      if (!hrefRaw) continue;
      var href = decodeEntities(hrefRaw);
      var pat = matchPattern(href);
      if (!pat) continue;
      var g = byKey[pat.id];
      if (!g) {
        if (groups.length >= CAP) continue; // cap distinct items; later anchors of ALREADY-seen keys still merge
        g = byKey[pat.id] = { key: pat.id, url: canonicalUrl(pat), firstIdx: m.index, anchors: [] };
        groups.push(g);
      }
      var innerMatch = /^<a\b[^>]*>([\s\S]*)<\/a>$/i.exec(whole);
      var inner = innerMatch ? innerMatch[1] : "";
      var imgTag = /<img\b[^>]*>/i.exec(inner);
      var imgSrc = imgTag ? extractAttr(imgTag[0], "src") : null;
      g.anchors.push({
        aria: decodeEntities(extractAttr(openTag, "aria-label") || "").trim(),
        alt: imgTag ? decodeEntities(extractAttr(imgTag[0], "alt") || "").trim() : "",
        text: decodeEntities(stripTags(inner)),
        img: imgSrc && /^https?:\/\//i.test(imgSrc) ? decodeEntities(imgSrc) : ""
      });
    }

    // Pass 2: resolve each group. Title: first aria-label, else first
    // in-anchor img alt (the IG caption — beats the "Clip" overlay text),
    // else first inner text, else nearest preceding aria-label in the
    // enclosing <li> block (fixture/legacy layout). Image: first <img>
    // INSIDE any of the key's anchors, else block-nearest <img>.
    var items = [];
    for (var i = 0; i < groups.length; i++) {
      var g2 = groups[i], j;
      var title = "";
      for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].aria;
      for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].alt;
      for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].text;
      var block = blockFor(blocks, g2.firstIdx);
      var localIdx = block ? (g2.firstIdx - block.start) : 0;
      if (!title) title = decodeEntities(nearestPrecedingAriaLabel(block, localIdx)).trim();
      title = title.slice(0, 512);

      var image = "";
      for (j = 0; j < g2.anchors.length && !image; j++) image = g2.anchors[j].img;
      if (!image) image = nearestImage(block, localIdx);

      items.push({ url: g2.url, title: title, image: image, platformKey: g2.key });
    }
    return items;
  }

  function parseSavedHtml(html) {
    html = String(html == null ? "" : html);
    // Anchor/image extraction runs on script/style-stripped markup only;
    // login-marker detection keeps the ORIGINAL html (a login form rendered
    // by inline script markers must still be recognized).
    var items = extractItems(stripScriptStyle(html));
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
  if (root) root.IASavedParseIG = api;
})(typeof self !== "undefined" ? self : this);
