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
const fs = require("fs");
const path = require("path");

function defaultBases() {
  const la = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  return { chrome: path.join(la, "Google", "Chrome", "User Data"), edge: path.join(la, "Microsoft", "Edge", "User Data") };
}
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
const PROFILE_RE = /^[A-Za-z0-9 ._-]+$/;

function listBrowserProfiles(basesOverride) {
  const bases = basesOverride || defaultBases();
  const out = [];
  ["chrome", "edge"].forEach(function (browser) {
    const base = bases[browser];
    if (!base) return;
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return; }  // missing base -> skip
    const ls = readJsonSafe(path.join(base, "Local State"));
    const nameCache = (ls && ls.profile && ls.profile.info_cache) || {};
    entries.forEach(function (ent) {
      if (!ent.isDirectory()) return;
      const profile = ent.name;
      const bookmarksPath = path.join(base, profile, "Bookmarks");
      let count = 0;
      try {
        if (!fs.statSync(bookmarksPath).isFile()) return;
        count = parseChromeBookmarks(readJsonSafe(bookmarksPath)).length;
      } catch (e) { return; }  // no Bookmarks file in this dir
      const name = (nameCache[profile] && nameCache[profile].name) || profile;
      out.push({ browser: browser, profile: profile, name: name, count: count });
    });
  });
  return out;
}
function badProfile(msg) { const e = new Error(msg || "BAD_PROFILE"); e.code = "BAD_PROFILE"; return e; }
function readProfileBookmarks(browser, profile, basesOverride) {
  if (browser !== "chrome" && browser !== "edge") throw badProfile("BAD_PROFILE: browser");
  if (typeof profile !== "string" || !PROFILE_RE.test(profile)) throw badProfile("BAD_PROFILE: profile");
  const ok = listBrowserProfiles(basesOverride).some(function (p) { return p.browser === browser && p.profile === profile; });
  if (!ok) throw badProfile("BAD_PROFILE: unknown");
  const bases = basesOverride || defaultBases();
  const bookmarksPath = path.join(bases[browser], profile, "Bookmarks");
  return parseChromeBookmarks(readJsonSafe(bookmarksPath));
}

module.exports = { parseChromeBookmarks: parseChromeBookmarks, listBrowserProfiles: listBrowserProfiles, readProfileBookmarks: readProfileBookmarks };
