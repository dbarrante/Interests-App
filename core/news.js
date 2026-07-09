// core/news.js — free news source for Stumble. Fetches + parses Google News RSS per
// interest keyword. Dependency-free (string/regex parse; the repo avoids XML/native deps).
// Outbound fetches go through core/guardedfetch (timeouts, drain-don't-cancel). The fetch is
// injectable so tests never hit the real network.
"use strict";

var ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, function (m) { return ENTITIES[m]; })
    .trim();
}
function pick(seg, tag) {
  var m = seg.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? decodeEntities(m[1]) : "";
}
function pickSource(seg) {
  var m = seg.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  return m ? decodeEntities(m[1]) : "";
}

// Parse Google News RSS into [{title,url,source,ts}]. Pure; no network.
function parseNewsRss(xml) {
  if (!xml || typeof xml !== "string") return [];
  var out = [];
  var blocks = xml.split(/<item[\s>]/i).slice(1);
  for (var i = 0; i < blocks.length; i++) {
    var seg = blocks[i].split(/<\/item>/i)[0];
    var title = pick(seg, "title");
    var url = pick(seg, "link");
    if (!title || !url) continue;
    var source = pickSource(seg);
    var pub = pick(seg, "pubDate");
    var ts = pub ? Date.parse(pub) : NaN;
    if (source && title.length > source.length + 3 && title.slice(-(source.length + 3)) === " - " + source) {
      title = title.slice(0, -(source.length + 3));
    }
    out.push({ title: title, url: url, source: source, ts: isNaN(ts) ? 0 : ts });
  }
  return out;
}

module.exports = { parseNewsRss: parseNewsRss, decodeEntities: decodeEntities };
