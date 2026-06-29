const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
// Isolate %APPDATA% BEFORE requiring config (never touch the real user config).
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sbcfg-"));
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("default key is empty string", () => {
  assert.strictEqual(config.getSafeBrowsingKey(), "");
});
t("set then get round-trips (trimmed)", () => {
  config.setSafeBrowsingKey("  abc123  ");
  assert.strictEqual(config.getSafeBrowsingKey(), "abc123");
});
t("set does not clobber other config keys", () => {
  config.saveConfig(Object.assign({}, config.loadConfig(), { storePath: "X:/keep" }));
  config.setSafeBrowsingKey("def456");
  assert.strictEqual(config.loadConfig().storePath, "X:/keep");
  assert.strictEqual(config.getSafeBrowsingKey(), "def456");
});
t("clear with empty string", () => {
  config.setSafeBrowsingKey("");
  assert.strictEqual(config.getSafeBrowsingKey(), "");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
