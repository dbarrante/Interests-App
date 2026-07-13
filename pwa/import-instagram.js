// Parse an Instagram "Download your information" SAVED-posts export into import items.
// Pure (no DOM/I/O), dual browser/Node like web/route-capture.js. Returns [] for any
// non-saved shape (liked, null, garbage) so it's safe to try on every JSON file.
//
// Handles BOTH export shapes:
//   NEW (Meta format, 2024+): a top-level ARRAY of { timestamp, label_values:[...] };
//        the post URL is in a label_values entry labelled "URL" (.href/.value),
//        the saved date is the top-level `timestamp`, the caption is the "Caption" entry.
//   OLD: { saved_saved_media: [ { title, string_map_data:{ "Saved on":{ href, timestamp } } } ] }.
(function (root) {
  "use strict";

  function igUrl(u) { return (typeof u === "string" && /instagram\.com/i.test(u)) ? u : null; }
  function slugOf(u) { var m = (u || "").match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i); return m ? m[1] : ""; }
  function lvFind(label_values, name) {
    if (!Array.isArray(label_values)) return null;
    for (var i = 0; i < label_values.length; i++) {
      var lv = label_values[i];
      if (lv && lv.label === name) return lv;
    }
    return null;
  }

  // NEW Meta format: top-level array of saved-post records.
  function parseNewFormat(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e || typeof e !== "object") continue;
      var urlLv = lvFind(e.label_values, "URL");
      var url = urlLv ? (igUrl(urlLv.href) || igUrl(urlLv.value)) : null;
      if (!url) continue;
      var capLv = lvFind(e.label_values, "Caption");
      var caption = (capLv && typeof capLv.value === "string") ? capLv.value.trim() : "";
      var titleLv = lvFind(e.label_values, "Title");
      var titleVal = (titleLv && typeof titleLv.value === "string") ? titleLv.value.trim() : "";
      var slug = slugOf(url);
      var title = titleVal || caption || (slug ? "Instagram post " + slug : "Instagram post");
      var item = { title: title, url: url };
      if (typeof e.timestamp === "number" && e.timestamp) item.ts = e.timestamp;  // Unix seconds; normalized by clean()/normTs()
      if (caption && caption !== title) item.desc = caption;
      out.push(item);
    }
    return out;
  }

  // OLD format: { saved_saved_media: [ { title, string_map_data } ] }.
  function parseOldFormat(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (!e || typeof e !== "object") continue;
      var smap = e.string_map_data || {};
      // Prefer the "Saved on" key; IG localizes it, so fall back to the first
      // string_map_data value that carries an href.
      var node = smap["Saved on"];
      if (!node || !node.href) {
        node = null;
        for (var k in smap) { if (Object.prototype.hasOwnProperty.call(smap, k) && smap[k] && smap[k].href) { node = smap[k]; break; } }
      }
      var href = node && node.href;
      if (typeof href !== "string" || !/instagram\.com/i.test(href)) continue;
      var slug = slugOf(href);
      var title = (typeof e.title === "string" && e.title) ? e.title : (slug ? "Instagram post " + slug : "Instagram post");
      var item = { title: title, url: href };
      var ts = node && node.timestamp;            // Unix seconds; normalized downstream by clean()/normTs()
      if (ts != null) item.ts = ts;
      out.push(item);
    }
    return out;
  }

  function parseInstagramSaved(json) {
    if (Array.isArray(json)) return parseNewFormat(json);
    if (json && Array.isArray(json.saved_saved_media)) return parseOldFormat(json.saved_saved_media);
    return [];
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { parseInstagramSaved: parseInstagramSaved };
  if (root) root.parseInstagramSaved = parseInstagramSaved;
})(typeof self !== "undefined" ? self : this);
