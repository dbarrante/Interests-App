// Pure parser for the user's Pinterest all-pins page: given raw HTML (or a
// Document, via parseSavedDoc), finds pin anchors and extracts
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
// never drift apart. (Mirrors extension/lib/saved-parse-ig.js.)
//
// Capture facts (2026-07-19, _livecapture/pinterest-saved.html): tile hrefs
// are RELATIVE ("/pin/<digits>/"), every distinct pin carries an in-anchor
// <img src="https://i.pinimg.com/...">, the anchor's aria-label is the best
// title BUT has a junk value "Untitled pin page", and the img alt is
// second-best after stripping its "This may contain: " / "This contains an
// image of: " prefixes. A pin can render as 2 anchors -- merge on the bare
// numeric id. i.pinimg.com is NOT a signed/expiring CDN: images pass through
// raw (the background layer's isExpiringCdnImage gate won't match them).
//
// Recognized URL shape (platformKey = the numeric pin id):
//   [https://<any>.pinterest.<tld>]/pin/<digits>
// Everything else (boards, profiles, /ideas/, /search/, nav, login links) is
// silently ignored -- the pattern whitelist IS the junk filter. Urls are
// always delivered CANONICAL: https://www.pinterest.com/pin/<id>/.
(function (root) {
  "use strict";

  var CAP = 100;

  var PATH_PATTERNS = [
    { type: "pin", re: /^(?:https?:\/\/(?:[a-z0-9-]+\.)?pinterest\.[a-z.]+)?\/pin\/(\d+)/i }
  ];
  function canonicalUrl(pat) {
    return "https://www.pinterest.com/pin/" + pat.id + "/";
  }

  // Pinterest's logged-out wall links /login/ (plus the shared form markers
  // kept from the FB/IG heuristic).
  var LOGIN_RE = /(?:\bid=["']loginform["'])|(?:\baction=["'][^"']*login[^"']*["'])|(?:href=["']\/login\/?["'])|(?:\/accounts\/login\/)/i;

  // Junk title sources (capture-tuned): the aria-label placeholder Pinterest
  // uses for caption-less pins, and the generated alt-text prefixes.
  var JUNK_TITLE_RE = /^untitled pin page$/i;
  var ALT_PREFIX_RE = /^this (?:may contain|contains an image of):?\s*/i;

  // Inline <script> hydration payloads (and <style> blocks) can carry literal
  // anchor markup as string data; strip both BEFORE any block/anchor walk.
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

  // "Enclosing element block" = the nearest <li>...</li> around an anchor
  // (fixture/legacy fallback only -- the live grid uses anonymous divs).
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
    // Pass 1: group every recognized anchor by bare pin id, in DOM order
    // (a pin can render as 2 anchors; first-encountered wins for position).
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

    // Pass 2: resolve each group. Title: first NON-JUNK aria-label, else
    // first prefix-stripped img alt, else inner text, else block aria-label
    // (fixture/legacy). Image: first <img> INSIDE any of the key's anchors,
    // else block-nearest <img>.
    var items = [];
    for (var i = 0; i < groups.length; i++) {
      var g2 = groups[i], j;
      var title = "";
      for (j = 0; j < g2.anchors.length && !title; j++) {
        if (g2.anchors[j].aria && !JUNK_TITLE_RE.test(g2.anchors[j].aria)) title = g2.anchors[j].aria;
      }
      for (j = 0; j < g2.anchors.length && !title; j++) {
        var a2 = g2.anchors[j].alt.replace(ALT_PREFIX_RE, "").trim();
        if (a2) title = a2;
      }
      for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].text;
      var block = blockFor(blocks, g2.firstIdx);
      var localIdx = block ? (g2.firstIdx - block.start) : 0;
      if (!title) title = decodeEntities(nearestPrecedingAriaLabel(block, localIdx)).trim();
      // Last resort (live-tuned): a caption-less pin has junk aria AND an
      // empty-after-prefix alt — "Untitled pin page" still beats a blank
      // title (the renderer would otherwise show the bare domain).
      for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].aria;
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
    // login-marker detection keeps the ORIGINAL html.
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
  if (root) root.IASavedParsePin = api;
})(typeof self !== "undefined" ? self : this);
