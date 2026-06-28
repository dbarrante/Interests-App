// Verifies the store-path writability fallback (the "won't open on a Program
// Files install" fix). Isolated from the real user config via a temp %APPDATA%.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const origAppData = process.env.APPDATA;
const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ia-appdata-"));
process.env.APPDATA = tmpAppData;

const config = require("../core/config");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("isWritableDir: true for a creatable dir, false for a path under a file", () => {
  assert.strictEqual(config.isWritableDir(path.join(tmpAppData, "okdir")), true);
  const aFile = path.join(tmpAppData, "afile");
  fs.writeFileSync(aFile, "x");
  assert.strictEqual(config.isWritableDir(path.join(aFile, "sub")), false);
});

t("getStorePath uses a writable configured storePath as-is", () => {
  const want = path.join(tmpAppData, "mystore");
  config.setStorePath(want);
  const got = config.getStorePath();
  assert.strictEqual(got, want);
  assert.ok(fs.existsSync(path.join(got, "images")), "images/ created");
});

t("getStorePath falls back to %APPDATA%/Interests App/data when storePath is unwritable", () => {
  const aFile = path.join(tmpAppData, "afile2");
  fs.writeFileSync(aFile, "x");
  config.setStorePath(path.join(aFile, "store")); // cannot mkdir under a file
  const got = config.getStorePath();
  assert.strictEqual(got, config.fallbackStoreDir());
  assert.strictEqual(got, path.join(config.appDataDir(), "data"));
  assert.ok(fs.existsSync(path.join(got, "images")), "fallback images/ created");
  assert.strictEqual(config.loadConfig().storePath, got, "fallback persisted");
});

process.env.APPDATA = origAppData;
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
