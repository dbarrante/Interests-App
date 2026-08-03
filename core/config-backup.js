// core/config-backup.js — password-protected export/import of app
// configuration (S settings blob + Notion token + Safe Browsing key),
// independent of and complementary to the plaintext Dropbox settings sync
// (core/sync.js / core/merge.js).
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const dbm = require("./db");
const config = require("./config");

const ENVELOPE_VERSION = 1;

// updateToken is deliberately stripped -- same "never leaves this device"
// rule core/db.js's settingsForSync and core/merge.js's mergeSyncedSettings
// already enforce for the Dropbox-sync path.
function buildConfigPayload(db) {
  let settings = {};
  try { settings = JSON.parse(dbm.getKV(db, "ia_settings") || "{}") || {}; } catch (e) { settings = {}; }
  const s = Object.assign({}, settings);
  delete s.updateToken;
  const notion = config.getNotionConfig();
  return {
    v: ENVELOPE_VERSION,
    settings: s,
    notionToken: notion.token,
    notionParentPageId: notion.parentPageId,
    safeBrowsingKey: config.getSafeBrowsingKey(),
  };
}

function encryptConfigBackup(payload, password) {
  if (!password) throw new Error("password required");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptConfigBackup(envelope, password) {
  if (!envelope || typeof envelope !== "object") throw new Error("invalid backup file");
  if (!password) throw new Error("password required");
  const salt = Buffer.from(envelope.salt || "", "base64");
  const iv = Buffer.from(envelope.iv || "", "base64");
  const authTag = Buffer.from(envelope.authTag || "", "base64");
  const ciphertext = Buffer.from(envelope.ciphertext || "", "base64");
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  // Throws on wrong password or tampered ciphertext (GCM auth-tag check) --
  // the single failure mode this feature relies on to "fail loudly, never
  // silently produce garbage settings."
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

// One overwritten, unencrypted, local-only "undo my last import" snapshot --
// not a rotated history, matching the risk (a rare, deliberate, already-
// confirmed action). Atomic write: tmp sidecar then rename into place (same
// pattern as core/config.js's saveConfig -- both write into appDataDir()). A
// torn write here would defeat the one purpose this file exists for: a
// trustworthy pre-import recovery copy.
function writeImportSafetySnapshot(db) {
  const snapshot = buildConfigPayload(db);
  fs.mkdirSync(config.appDataDir(), { recursive: true });
  const target = path.join(config.appDataDir(), "config-import-safety.json");
  const tmpFile = target + ".tmp." + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(snapshot, null, 2), "utf8");
  try {
    fs.renameSync(tmpFile, target);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    throw e;
  }
}

// Full replace, not a merge -- same semantics as the existing data
// /api/restore, deliberately different from the Dropbox settings-sync's
// merge semantics. updateToken is ALWAYS preserved from the current
// device, never taken from the payload (buildConfigPayload never includes
// one, but a hand-crafted file might -- this guards that too; unlike
// core/merge.js's mergeSyncedSettings, which DELETES the key when the local
// side has none, this always SETS it to "" in that case -- harmless since
// core/db.js's settingsForSync strips it again before any sync export, but
// not the same mechanism).
function applyConfigPayload(db, payload) {
  writeImportSafetySnapshot(db);
  let currentSettings = {};
  try { currentSettings = JSON.parse(dbm.getKV(db, "ia_settings") || "{}") || {}; } catch (e) { currentSettings = {}; }
  const merged = Object.assign({}, payload.settings || {}, { updateToken: currentSettings.updateToken || "" });
  dbm.setKV(db, "ia_settings", JSON.stringify(merged));
  // Bump the sync stamp (same convention as core/db.js's applySyncedSettings)
  // so this full-replace import isn't later judged "older" than a stale
  // peer's Dropbox sync blob and silently reverted on the next sync round.
  dbm.setKV(db, "ia_settings_updatedAt", String(Date.now()));
  config.setNotionConfig({ token: payload.notionToken || "", parentPageId: payload.notionParentPageId || "" });
  config.setSafeBrowsingKey(payload.safeBrowsingKey || "");
}

module.exports = { buildConfigPayload, encryptConfigBackup, decryptConfigBackup, applyConfigPayload, writeImportSafetySnapshot };
