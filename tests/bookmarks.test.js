const assert = require("assert");
const bm = require("../core/bookmarks");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

// Chrome date_added for 2023-11-14T22:13:20Z (= 1700000000 s since 1970):
// µs since 1601 = (1700000000000 + 11644473600000) * 1000.
const TS_2023 = "13344473600000000";
const urlNode = (name, url, da) => ({ type: "url", name: name, url: url, date_added: da });
const folderNode = (name, children) => ({ type: "folder", name: name, children: children });
const TREE = (bar) => ({ roots: { bookmark_bar: { type: "folder", name: "Bookmarks bar", children: bar } } });

test("parses url nodes with title/url/folder and converts date_added", () => {
  const r = bm.parseChromeBookmarks(TREE([ urlNode("Recipe Site", "https://recipes.example.com/x", TS_2023) ]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].title, "Recipe Site");
  assert.strictEqual(r[0].url, "https://recipes.example.com/x");
  assert.strictEqual(r[0].folder, "Bookmarks bar");
  assert.ok(r[0].ts > 9.46e11 && r[0].ts < 4.1e12, "ts in sane ms range");
  assert.ok(Math.abs(r[0].ts - Date.parse("2023-11-14T22:13:20Z")) < 2000, "ts ≈ the right date");
});
test("recurses into folders and builds the nested folder path", () => {
  const r = bm.parseChromeBookmarks(TREE([ folderNode("Recipes", [ urlNode("Bread", "https://b.example.com", TS_2023) ]) ]));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].folder, "Bookmarks bar/Recipes");
});
test("skips non-http(s) nodes (chrome://, javascript:, file:)", () => {
  const r = bm.parseChromeBookmarks(TREE([
    urlNode("settings", "chrome://settings", TS_2023),
    urlNode("js", "javascript:void(0)", TS_2023),
    urlNode("file", "file:///c:/x", TS_2023),
    urlNode("ok", "https://ok.example.com", TS_2023),
  ]));
  assert.deepStrictEqual(r.map(i => i.title), ["ok"]);
});
test("omits ts when date_added is absent or out of range", () => {
  const r = bm.parseChromeBookmarks(TREE([ { type: "url", name: "n", url: "https://n.example.com" } ]));
  assert.strictEqual(r.length, 1);
  assert.ok(!("ts" in r[0]) || r[0].ts === undefined);
});
test("includes the 'other' and 'synced' roots", () => {
  const json = { roots: {
    other: { type: "folder", name: "Other bookmarks", children: [ urlNode("o", "https://o.example.com", TS_2023) ] },
    synced: { type: "folder", name: "Mobile bookmarks", children: [ urlNode("m", "https://m.example.com", TS_2023) ] },
  } };
  const r = bm.parseChromeBookmarks(json);
  assert.deepStrictEqual(r.map(i => i.folder).sort(), ["Mobile bookmarks", "Other bookmarks"]);
});
test("returns [] for null / garbage / non-bookmarks object (no throw)", () => {
  [null, undefined, {}, [], 5, "x", { foo: 1 }].forEach(v => assert.deepStrictEqual(bm.parseChromeBookmarks(v), []));
});

// ---- A2: fs profile discovery + validated read ----
const os = require("os"), fs = require("fs"), path = require("path");
function seedProfile(base, profileDir, bookmarksObj, displayName) {
  const dir = path.join(base, profileDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Bookmarks"), JSON.stringify(bookmarksObj));
  if (displayName) {
    const ls = { profile: { info_cache: {} } };
    ls.profile.info_cache[profileDir] = { name: displayName };
    fs.writeFileSync(path.join(base, "Local State"), JSON.stringify(ls));
  }
}

test("listBrowserProfiles finds a seeded profile with count + display name", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ia-chrome-"));
  seedProfile(base, "Default", TREE([ urlNode("a", "https://a.example.com", TS_2023) ]), "Dave (work)");
  const list = bm.listBrowserProfiles({ chrome: base, edge: path.join(base, "nope") });
  const me = list.find(p => p.browser === "chrome" && p.profile === "Default");
  assert.ok(me, "Default profile discovered");
  assert.strictEqual(me.name, "Dave (work)");
  assert.strictEqual(me.count, 1);
});
test("readProfileBookmarks returns parsed items for a valid discovered profile", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ia-chrome-"));
  seedProfile(base, "Default", TREE([ urlNode("a", "https://a.example.com", TS_2023) ]));
  const r = bm.readProfileBookmarks("chrome", "Default", { chrome: base, edge: path.join(base, "nope") });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, "https://a.example.com");
});
test("readProfileBookmarks REJECTS a traversal/invalid profile and reads nothing", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ia-chrome-"));
  seedProfile(base, "Default", TREE([]));
  for (const bad of ["../evil", "a/b", "a\\b", "..", ""]) {
    assert.throws(() => bm.readProfileBookmarks("chrome", bad, { chrome: base, edge: base }), /BAD_PROFILE/, "rejects " + JSON.stringify(bad));
  }
  assert.throws(() => bm.readProfileBookmarks("firefox", "Default", { chrome: base, edge: base }), /BAD_PROFILE/);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
