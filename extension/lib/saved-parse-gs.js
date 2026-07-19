// Pure parser for Google's saved-items list (google.com/interests/saved/list/
// allsaves — the flat "All saved items" view; the bare google.com/save page
// is the collections OVERVIEW and renders zero item links, capture-proven
// 2026-07-19). Given raw HTML (or a Document via parseSavedDoc), finds saved
// items and extracts { url, title, image, platformKey }. Reports a status so
// a login/consent wall or an unrecognized layout never silently delivers
// zero/garbage items (global constraint: scrapers fail SOFT).
//
// No DOM dependency (NO jsdom) — same single-implementation contract as
// extension/lib/saved-parse-{fb,ig,pin}.js.
//
// Capture facts (2026-07-19, "All saved items" Ctrl+S capture): each saved
// item renders as an anchor PAIR to the same target — a thumbnail anchor
// (img, no aria) and a title anchor (aria-label + inner text). ~97% of hrefs
// are Google redirect wrappers  google.<tld>/url?q=<external-url>&usg=… ;
// a few items link their external url DIRECTLY. Saved items are EXTERNAL
// content, so the delivered url is the UNWRAPPED target and platformKey is
// the normalized target (host lowercased, hash + utm_*/ref params stripped)
// — Google exposes no stable item id in the DOM.
//
// Junk filter: google-hosted links (nav, sign-out, products, collection
// tabs) never match — /url?q= unwrapping is the whitelist for wrapped items,
// and DIRECT external anchors only count when they look like an item card
// (aria-label or an inner <img>), which excludes bare footer text links.
(function (root) {
  "use strict";

  var CAP = 100;

  var URLQ_RE = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/url\?/i;
  var EXT_RE = /^https?:\/\//i;

  // accounts.google.com/ServiceLogin, /signin, consent.google.com
  var LOGIN_RE = /accounts\.google\.[a-z.]+\/(?:ServiceLogin|v3\/signin|signin)|consent\.google\.[a-z.]+/i;

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

  function isGoogleHost(url) {
    var m = /^https?:\/\/([^\/?#]+)/i.exec(url);
    if (!m) return false;
    var host = m[1].toLowerCase();
    return /(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)gstatic\.com$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host);
  }

  // Unwrap google.<tld>/url?q=<target>&usg=… → the external target url.
  function unwrapTarget(href) {
    if (!URLQ_RE.test(href)) return null;
    var m = /[?&]q=([^&]+)/.exec(href);
    if (!m) return null;
    var target = m[1];
    try { target = decodeURIComponent(target); } catch (e) { /* keep raw */ }
    return EXT_RE.test(target) && !isGoogleHost(target) ? target : null;
  }

  // Normalized external url = the dedup key (host lowercased, hash gone,
  // utm_*/ref tracking params stripped). Google exposes no stable item id.
  //
  // KNOWN LIMITATION (data-safety review 2026-07-19, accepted): hash-routed
  // SPA saves (site/#/a vs site/#/b) normalize to ONE key — the second is
  // permanently treated as a duplicate. Consequence of keying on the url;
  // acceptable because such saves are rare and nothing is deleted.
  //
  // Keys longer than the core's 128-char platformKey cap are HASHED (stable
  // djb2 hex, "h:" prefix), never dropped — an oversized key would fail
  // validItem and the item would silently retry-and-drop forever (review LOW).
  function djb2(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function keyFromUrl(u) {
    var m = /^(https?:\/\/)([^\/?#]+)([^#]*)/i.exec(u);
    if (!m) return "";
    var rest = m[3].replace(/([?&])(utm_[a-z]+|ref)=[^&]*/gi, "$1").replace(/[?&]+$/, "").replace(/\?&/, "?");
    var key = m[2].toLowerCase() + rest;
    // 120 leaves headroom under CAPS.platformKey=128; hash BOTH halves so two
    // long urls sharing a 120-char prefix still get distinct keys.
    if (key.length > 120) key = "h:" + djb2(key) + djb2(key.split("").reverse().join(""));
    return key;
  }

  function extractItems(html) {
    // Pass 1: group every item anchor by normalized target url, in DOM order
    // (each item renders as a thumbnail anchor + a title anchor — merge).
    var groups = [];
    var byKey = Object.create(null);
    var re = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
    var m;
    while ((m = re.exec(html))) {
      var whole = m[0];
      var openTagMatch = /^<a\b[^>]*>/i.exec(whole);
      var openTag = openTagMatch ? openTagMatch[0] : "<a>";
      var hrefRaw = extractAttr(openTag, "href");
      if (!hrefRaw) continue;
      var href = decodeEntities(hrefRaw);

      var innerMatch = /^<a\b[^>]*>([\s\S]*)<\/a>$/i.exec(whole);
      var inner = innerMatch ? innerMatch[1] : "";
      var imgTag = /<img\b[^>]*>/i.exec(inner);
      var aria = decodeEntities(extractAttr(openTag, "aria-label") || "").trim();

      var target = unwrapTarget(href);
      if (!target) {
        // Direct external anchors count ONLY when they look like an item
        // card (aria-label or inner img) — never bare footer/nav text links.
        if (EXT_RE.test(href) && !isGoogleHost(href) && (aria || imgTag)) target = href;
        else continue;
      }
      var key = keyFromUrl(target);
      if (!key) continue;

      var g = byKey[key];
      if (!g) {
        if (groups.length >= CAP) continue; // cap distinct items; later anchors of ALREADY-seen keys still merge
        g = byKey[key] = { key: key, url: target, anchors: [] };
        groups.push(g);
      }
      var imgSrc = imgTag ? extractAttr(imgTag[0], "src") : null;
      g.anchors.push({
        aria: aria,
        text: decodeEntities(stripTags(inner)),
        img: imgSrc && /^https?:\/\//i.test(imgSrc) ? decodeEntities(imgSrc) : ""
      });
    }

    // Pass 2: resolve each group. Title: first aria-label, else first inner
    // text. Image: first in-anchor http(s) <img> (favicons are tiny but a
    // thumb beats nothing; live DOM serves googleusercontent thumbs).
    var items = [];
    for (var i = 0; i < groups.length; i++) {
      var g2 = groups[i], j;
      var title = "";
      for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].aria;
      for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].text;
      title = title.slice(0, 512);
      var image = "";
      for (j = 0; j < g2.anchors.length && !image; j++) image = g2.anchors[j].img;
      items.push({ url: g2.url, title: title, image: image, platformKey: g2.key });
    }
    return items;
  }

  function parseSavedHtml(html) {
    html = String(html == null ? "" : html);
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
  if (root) root.IASavedParseGS = api;
})(typeof self !== "undefined" ? self : this);
