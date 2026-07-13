// Parse a Google Takeout "Saved" CSV (Title/Note/URL) into import items. Pure,
// dual browser/Node like web/route-capture.js. Returns [] for anything that isn't
// a Google-Saved CSV (incl. YouTube Takeout CSVs, which have Channel*/Video Id cols).
(function (root) {
  "use strict";
  function splitCsvLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; } continue; }
      if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function parseGoogleSaved(text) {
    var out = [];
    if (typeof text !== "string" || text.indexOf(",") < 0) return out;
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return out;
    var head = splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase(); });
    if (head.some(function (h) { return h.indexOf("video id") >= 0 || h.indexOf("channel") >= 0; })) return out;  // YouTube -> let parseCSV handle
    // Prefer an exact column-name match across the whole header before falling
    // back to a substring match, so e.g. "Source Url,Title,URL" binds to "URL".
    function findIdx(exact, sub) {
      for (var i = 0; i < head.length; i++) if (head[i] === exact) return i;
      for (var i = 0; i < head.length; i++) if (sub(head[i])) return i;
      return -1;
    }
    var titleIdx = findIdx("title", function (h) { return h.indexOf("title") >= 0; });
    var urlIdx = findIdx("url", function (h) { return h.indexOf("url") >= 0; });
    var noteIdx = findIdx("note", function (h) { return h.indexOf("note") >= 0; });
    if (titleIdx < 0 || urlIdx < 0) return out;
    for (var r = 1; r < lines.length; r++) {
      var cols = splitCsvLine(lines[r]);
      var title = cols[titleIdx] || "", url = cols[urlIdx] || "";
      if (!title || !/^https?:\/\//i.test(url)) continue;
      out.push({ title: title, url: url, desc: (noteIdx >= 0 ? (cols[noteIdx] || "") : "") });
    }
    return out;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { parseGoogleSaved: parseGoogleSaved };
  if (root) root.parseGoogleSaved = parseGoogleSaved;
})(typeof self !== "undefined" ? self : this);
