// tests/config-backup.test.js — payload gathering, AES-256-GCM encrypt/decrypt
// round-trip, and full-replace apply semantics for the password-protected
// configuration backup feature.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ISOLATE the config in a temp APPDATA *before* requiring anything that loads
// core/config — this project's established, non-negotiable convention (a
// killed test run previously poisoned the real production config.json).
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const { openDb, setKV, getKV } = require("../core/db.js");
const config = require("../core/config.js");
const cb = require("../core/config-backup.js");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); } }

function newDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cb-store-"));
  return openDb(dir);
}

t("buildConfigPayload strips updateToken but keeps everything else", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({ provider: "gemini", keys: { gemini: "gk" }, updateToken: "secret-device-token", itemCount: 12 }));
  const payload = cb.buildConfigPayload(db);
  assert.strictEqual(payload.settings.provider, "gemini");
  assert.strictEqual(payload.settings.keys.gemini, "gk");
  assert.strictEqual(payload.settings.itemCount, 12);
  assert.strictEqual(payload.settings.updateToken, undefined, "updateToken must never appear in the payload");
  db.close();
});

t("buildConfigPayload includes the current Notion token / parent page / Safe Browsing key", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({}));
  config.setNotionConfig({ token: "notion-tok", parentPageId: "page123" });
  config.setSafeBrowsingKey("sb-key");
  const payload = cb.buildConfigPayload(db);
  assert.strictEqual(payload.notionToken, "notion-tok");
  assert.strictEqual(payload.notionParentPageId, "page123");
  assert.strictEqual(payload.safeBrowsingKey, "sb-key");
  db.close();
});

t("encryptConfigBackup / decryptConfigBackup round-trip", () => {
  const payload = { v: 1, settings: { provider: "openai" }, notionToken: "", notionParentPageId: "", safeBrowsingKey: "" };
  const envelope = cb.encryptConfigBackup(payload, "correct horse battery staple");
  assert.strictEqual(envelope.v, 1);
  assert.ok(envelope.salt && envelope.iv && envelope.authTag && envelope.ciphertext);
  const roundTripped = cb.decryptConfigBackup(envelope, "correct horse battery staple");
  assert.deepStrictEqual(roundTripped, payload);
});

t("encryptConfigBackup throws without a password", () => {
  assert.throws(() => cb.encryptConfigBackup({ v: 1, settings: {} }, ""));
});

t("decryptConfigBackup throws on the wrong password", () => {
  const envelope = cb.encryptConfigBackup({ v: 1, settings: { a: 1 } }, "right-password");
  assert.throws(() => cb.decryptConfigBackup(envelope, "wrong-password"));
});

t("decryptConfigBackup throws on a tampered ciphertext (GCM integrity)", () => {
  const envelope = cb.encryptConfigBackup({ v: 1, settings: { a: 1 } }, "a-password");
  const tampered = Object.assign({}, envelope, { ciphertext: Buffer.from("not the real ciphertext").toString("base64") });
  assert.throws(() => cb.decryptConfigBackup(tampered, "a-password"));
});

t("two exports of the identical payload produce different salt/iv/ciphertext (randomness not reused)", () => {
  const payload = { v: 1, settings: { a: 1 } };
  const e1 = cb.encryptConfigBackup(payload, "pw");
  const e2 = cb.encryptConfigBackup(payload, "pw");
  assert.notStrictEqual(e1.salt, e2.salt);
  assert.notStrictEqual(e1.iv, e2.iv);
  assert.notStrictEqual(e1.ciphertext, e2.ciphertext);
});

t("applyConfigPayload full-replaces ia_settings but preserves the CURRENT device's updateToken", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({ provider: "groq", updateToken: "this-devices-own-token", itemCount: 99 }));
  const importedPayload = { v: 1, settings: { provider: "anthropic", itemCount: 5 }, notionToken: "", notionParentPageId: "", safeBrowsingKey: "" };
  cb.applyConfigPayload(db, importedPayload);
  const after = JSON.parse(getKV(db, "ia_settings"));
  assert.strictEqual(after.provider, "anthropic", "provider must come from the imported payload");
  assert.strictEqual(after.itemCount, 5, "itemCount must come from the imported payload");
  assert.strictEqual(after.updateToken, "this-devices-own-token", "updateToken must be preserved from THIS device, never from the import");
  db.close();
});

t("applyConfigPayload preserves this device's updateToken even if a hand-crafted payload includes one", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({ updateToken: "real-local-token" }));
  cb.applyConfigPayload(db, { v: 1, settings: { updateToken: "sneaky-imported-token" }, notionToken: "", notionParentPageId: "", safeBrowsingKey: "" });
  const after = JSON.parse(getKV(db, "ia_settings"));
  assert.strictEqual(after.updateToken, "real-local-token");
  db.close();
});

t("applyConfigPayload is a true full replace for Notion/Safe Browsing config — an empty field in the payload clears the target", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({}));
  config.setNotionConfig({ token: "old-token-on-this-device", parentPageId: "old-page" });
  config.setSafeBrowsingKey("old-sb-key");
  cb.applyConfigPayload(db, { v: 1, settings: {}, notionToken: "", notionParentPageId: "", safeBrowsingKey: "" });
  const n = config.getNotionConfig();
  assert.strictEqual(n.token, "", "an empty token in the payload must CLEAR the target device's token (full replace, not merge)");
  assert.strictEqual(n.parentPageId, "");
  assert.strictEqual(config.getSafeBrowsingKey(), "");
  db.close();
});

t("applyConfigPayload bumps ia_settings_updatedAt to a fresh stamp (so a later Dropbox sync round can't judge the import stale and revert it)", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({ provider: "gemini" }));
  setKV(db, "ia_settings_updatedAt", "1");
  const before = Date.now();
  cb.applyConfigPayload(db, { v: 1, settings: { provider: "anthropic" }, notionToken: "", notionParentPageId: "", safeBrowsingKey: "" });
  const stamp = Number(getKV(db, "ia_settings_updatedAt"));
  assert.ok(!Number.isNaN(stamp) && stamp >= before, "ia_settings_updatedAt must be bumped to a fresh timestamp on import");
  db.close();
});

t("applyConfigPayload writes a pre-mutation safety snapshot before changing anything", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({ provider: "gemini", itemCount: 42 }));
  cb.applyConfigPayload(db, { v: 1, settings: { provider: "openai", itemCount: 1 }, notionToken: "", notionParentPageId: "", safeBrowsingKey: "" });
  const snapPath = path.join(config.appDataDir(), "config-import-safety.json");
  assert.ok(fs.existsSync(snapPath));
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  assert.strictEqual(snap.settings.provider, "gemini", "the safety snapshot must capture the PRE-import state, not the just-applied one");
  assert.strictEqual(snap.settings.itemCount, 42);
  db.close();
});

t("applyConfigPayload rolls ia_settings (and its stamp) back to pre-import values, and still re-throws, if a config.json write fails partway through", () => {
  const db = newDb();
  setKV(db, "ia_settings", JSON.stringify({ provider: "gemini", itemCount: 42, updateToken: "this-devices-token" }));
  setKV(db, "ia_settings_updatedAt", "1000");
  const origSetNotionConfig = config.setNotionConfig;
  config.setNotionConfig = () => { throw new Error("simulated config.json rename failure"); };
  try {
    assert.throws(
      () => cb.applyConfigPayload(db, { v: 1, settings: { provider: "openai", itemCount: 1 }, notionToken: "tok", notionParentPageId: "", safeBrowsingKey: "" }),
      /simulated config\.json rename failure/,
      "the original error must still propagate so the route reports failure"
    );
  } finally {
    config.setNotionConfig = origSetNotionConfig;
  }
  const after = JSON.parse(getKV(db, "ia_settings"));
  assert.strictEqual(after.provider, "gemini", "ia_settings must be rolled back to its pre-import value after a partial-write failure");
  assert.strictEqual(after.itemCount, 42);
  assert.strictEqual(after.updateToken, "this-devices-token");
  assert.strictEqual(getKV(db, "ia_settings_updatedAt"), "1000", "ia_settings_updatedAt must also be rolled back, not left bumped");
  const snapPath = path.join(config.appDataDir(), "config-import-safety.json");
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  assert.strictEqual(snap.settings.provider, "gemini", "the pre-import safety snapshot must still hold the correct pre-import state after a failed import -- this is what makes the failure recoverable rather than data loss");
  assert.strictEqual(snap.settings.itemCount, 42);
  db.close();
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
