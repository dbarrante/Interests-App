const assert = require("assert");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const manifest = require("./surface-parity-manifest");

const root = path.join(__dirname, "..");
const web = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const pwa = fs.readFileSync(path.join(root, "pwa/index.html"), "utf8");
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); }
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
}

manifest.exactPairs.forEach(([left, right]) => {
  t("exact parity: " + left + " = " + right, () => {
    assert.strictEqual(digest(left), digest(right), "required mirrored files drifted");
  });
});

manifest.indexContracts.forEach((name) => {
  t("index contract mirrored: " + name, () => {
    assert.ok(web.indexOf("function " + name + "(") >= 0 || web.indexOf("async function " + name + "(") >= 0, "web contract missing");
    assert.ok(pwa.indexOf("function " + name + "(") >= 0 || pwa.indexOf("async function " + name + "(") >= 0, "pwa contract missing");
  });
});

t("PWA cache version is present for cached-file invalidation", () => {
  assert.match(fs.readFileSync(path.join(root, "pwa/sw.js"), "utf8"), /SHELL_CACHE = "interests-pwa-shell-v\d+"/);
});

console.log("surface-parity: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
