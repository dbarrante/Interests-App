// Parse an Instagram "Download your information" SAVED-posts export into import items.
// Pure (no DOM/I/O), dual browser/Node like web/route-capture.js. Returns [] for any
// non-saved shape (liked, null, garbage) so it's safe to try on every JSON file.
(function (root) {
  "use strict";
  function parseInstagramSaved(json) {
    var out = [];
    var arr = json && json.saved_saved_media;
    if (!Array.isArray(arr)) return out;
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
      var item = { title: (typeof e.title === "string" && e.title) ? e.title : "Instagram post", url: href };
      var ts = node && node.timestamp;            // Unix seconds; normalized downstream by clean()/normTs()
      if (ts != null) item.ts = ts;
      out.push(item);
    }
    return out;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { parseInstagramSaved: parseInstagramSaved };
  if (root) root.parseInstagramSaved = parseInstagramSaved;
})(typeof self !== "undefined" ? self : this);
