const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

// Isolate %APPDATA% into a throwaway temp dir so the test never touches the real one.
const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ia-appdata-"));
process.env.APPDATA = tmpAppData;

// Fresh require AFTER setting APPDATA.
const cfg = require("../core/config.js");

t("appDataDir() = %APPDATA%\\Interests App", () => {
  assert.strictEqual(cfg.appDataDir(), path.join(tmpAppData, "Interests App"));
});

t("configPath() = appDataDir()/config.json", () => {
  assert.strictEqual(cfg.configPath(), path.join(cfg.appDataDir(), "config.json"));
});

t("loadConfig() -> {} when absent", () => {
  assert.deepStrictEqual(cfg.loadConfig(), {});
});

t("saveConfig/loadConfig round-trips and creates appDataDir", () => {
  cfg.saveConfig({ hello: "world" });
  assert.ok(fs.existsSync(cfg.configPath()), "config.json should exist");
  assert.deepStrictEqual(cfg.loadConfig(), { hello: "world" });
});

t("defaultStoreDir() = resolve('data') in dev (no Electron)", () => {
  assert.strictEqual(cfg.defaultStoreDir(), path.resolve("data"));
});

t("getStorePath() defaults to defaultStoreDir() and creates dir + images", () => {
  // Ensure no storePath is configured.
  cfg.saveConfig({});
  const sp = cfg.getStorePath();
  assert.strictEqual(sp, cfg.defaultStoreDir());
  assert.ok(fs.existsSync(sp), "store dir should exist");
  assert.ok(fs.existsSync(path.join(sp, "images")), "images dir should exist");
});

t("setStorePath persists and getStorePath honors it + creates images", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-store-"));
  cfg.setStorePath(target);
  assert.strictEqual(cfg.loadConfig().storePath, target);
  const sp = cfg.getStorePath();
  assert.strictEqual(sp, target);
  assert.ok(fs.existsSync(path.join(target, "images")), "images dir should exist under configured store");
});

t("setStorePath merges, does not clobber other config keys", () => {
  cfg.saveConfig({ keepme: 1 });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-store2-"));
  cfg.setStorePath(target);
  const c = cfg.loadConfig();
  assert.strictEqual(c.keepme, 1);
  assert.strictEqual(c.storePath, target);
});

// Task 5 / M4: saveConfig must write atomically (tmp + rename), same pattern as
// core/sync.js _writeAtomic — a torn write on the real config.json would make the
// app forget its configured storePath ("all my data is gone"). Assert end-state:
// no leftover tmp sidecars after a save, and the file parses.
t("saveConfig leaves no *.tmp* sidecar in the config dir after a save", () => {
  cfg.saveConfig({ a: 1 });
  const dir = cfg.appDataDir();
  const leftovers = fs.readdirSync(dir).filter(n => n.indexOf(".tmp") !== -1);
  assert.deepStrictEqual(leftovers, [], "no tmp sidecars should remain");
  assert.deepStrictEqual(cfg.loadConfig(), { a: 1 }, "config.json parses to the saved value");
});

t("saveConfig writes via a tmp file next to configPath() then renames over it", () => {
  const seenTmp = [];
  const origRename = fs.renameSync;
  fs.renameSync = function (src, dest) {
    seenTmp.push(src);
    return origRename(src, dest);
  };
  try {
    cfg.saveConfig({ b: 2 });
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(seenTmp.length, 1, "renameSync called exactly once");
  assert.ok(seenTmp[0].indexOf(cfg.configPath()) === 0, "tmp file lives next to the real config path");
  assert.notStrictEqual(seenTmp[0], cfg.configPath(), "tmp file is a distinct path from the real one");
  assert.deepStrictEqual(cfg.loadConfig(), { b: 2 });
});

t("saveConfig round-trip still works after a simulated torn write is overwritten", () => {
  // Simulate a torn write directly on the real config path...
  fs.writeFileSync(cfg.configPath(), "{not json", "utf8");
  assert.deepStrictEqual(cfg.loadConfig(), {}, "existing behavior: unparsable config -> {}");
  // ...then a fresh saveConfig must cleanly replace it (atomic rename overwrites torn file).
  cfg.saveConfig({ c: 3 });
  assert.deepStrictEqual(cfg.loadConfig(), { c: 3 });
  const dir = cfg.appDataDir();
  const leftovers = fs.readdirSync(dir).filter(n => n.indexOf(".tmp") !== -1);
  assert.deepStrictEqual(leftovers, [], "no tmp sidecars left after recovering from a torn write");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
