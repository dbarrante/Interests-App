// Read Chrome/Edge bookmarks. parseChromeBookmarks is PURE; the fs helpers (added
// next) read ONLY the fixed Bookmarks file for a validated, discovered profile.
"use strict";
const ROOT_LABEL = { bookmark_bar: "Bookmarks bar", other: "Other bookmarks", synced: "Mobile bookmarks" };
const WEBKIT_EPOCH_MS = 11644473600000;  // ms between 1601-01-01 and 1970-01-01

function convertDateAdded(da) {
  if (da == null || da === "") return undefined;
  var ms = Math.round(Number(da) / 1000) - WEBKIT_EPOCH_MS;
  if (!isFinite(ms) || ms <= 9.46e11 || ms >= 4.1e12) return undefined;  // sane ~2000..2100
  return ms;
}
function walk(node, folderPath, out) {
  if (!node || typeof node !== "object") return;
  if (node.type === "url" && typeof node.url === "string" && /^https?:\/\//i.test(node.url)) {
    var item = { title: (typeof node.name === "string" && node.name) || node.url, url: node.url, folder: folderPath };
    var ts = convertDateAdded(node.date_added);
    if (ts !== undefined) item.ts = ts;
    out.push(item);
    return;
  }
  var children = node.children;
  if (Array.isArray(children)) {
    for (var i = 0; i < children.length; i++) walk(children[i], folderPath, out);
  }
}
function parseChromeBookmarks(json) {
  var out = [];
  var roots = json && json.roots;
  if (!roots || typeof roots !== "object") return out;
  for (var key in roots) {
    if (!Object.prototype.hasOwnProperty.call(roots, key)) continue;
    var root = roots[key];
    if (!root || typeof root !== "object") continue;
    var label = ROOT_LABEL[key] || (typeof root.name === "string" ? root.name : key);
    var kids = root.children;
    if (Array.isArray(kids)) for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child && child.type === "folder") walk(child, label + "/" + (child.name || "folder"), out);
      else walk(child, label, out);
    }
  }
  return out;
}
module.exports = { parseChromeBookmarks: parseChromeBookmarks };
