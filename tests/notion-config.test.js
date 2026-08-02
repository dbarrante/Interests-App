const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-notioncfg-"));
const config = require("../core/config");
let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

t("getNotionConfig returns empty strings when unset", () => {
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "");
  assert.strictEqual(c.parentPageId, "");
});
t("setNotionConfig persists both fields when both are present, trimmed", () => {
  config.setNotionConfig({ token: "  secret_abc123  ", parentPageId: "  page-id-xyz  " });
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "secret_abc123");
  assert.strictEqual(c.parentPageId, "page-id-xyz");
});
t("setNotionConfig with an omitted key leaves that stored value unchanged", () => {
  config.setNotionConfig({ token: "secret_1", parentPageId: "page_1" });
  config.setNotionConfig({ parentPageId: "page_2" });   // token key omitted entirely
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "secret_1", "omitted token must survive untouched");
  assert.strictEqual(c.parentPageId, "page_2");
});
t("setNotionConfig with a key present but empty string explicitly clears it", () => {
  config.setNotionConfig({ token: "secret_1", parentPageId: "page_1" });
  config.setNotionConfig({ token: "" });
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "", "present-and-empty must clear, not be ignored");
  assert.strictEqual(c.parentPageId, "page_1", "the other field is untouched");
});
t("setNotionConfig with a non-string value for a present key treats it as empty", () => {
  config.setNotionConfig({ token: "secret_1" });
  config.setNotionConfig({ token: null });
  assert.strictEqual(config.getNotionConfig().token, "");
});
t("setNotionConfig({}) or setNotionConfig() changes nothing", () => {
  config.setNotionConfig({ token: "secret_1", parentPageId: "page_1" });
  config.setNotionConfig({});
  config.setNotionConfig();
  const c = config.getNotionConfig();
  assert.strictEqual(c.token, "secret_1");
  assert.strictEqual(c.parentPageId, "page_1");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
