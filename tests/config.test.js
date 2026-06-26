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

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
