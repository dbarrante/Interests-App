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
  // Captured in memory, pre-mutation, as the RAW row values (not a
  // parse+restringify) -- reused below to roll ia_settings back byte-for-byte
  // if a later step in this function throws, no re-read needed. Restringifying
  // a re-parsed object would be lossy: a missing row (null) would round-trip
  // to the string "{}" (creating a row that didn't exist), and malformed JSON
  // already in the row would round-trip to "{}" too (destroying the original
  // bytes on a FAILED import, the one case where nothing must change).
  const prevSettingsRaw = dbm.getKV(db, "ia_settings");
  const prevUpdatedAt = dbm.getKV(db, "ia_settings_updatedAt");
  let currentSettings = {};
  try { currentSettings = JSON.parse(prevSettingsRaw || "{}") || {}; } catch (e) { currentSettings = {}; }
  const merged = Object.assign({}, payload.settings || {}, { updateToken: currentSettings.updateToken || "" });
  try {
    dbm.setKV(db, "ia_settings", JSON.stringify(merged));
    // Bump the sync stamp (same convention as core/db.js's applySyncedSettings)
    // so this full-replace import isn't later judged "older" than a stale
    // peer's Dropbox sync blob and silently reverted on the next sync round.
    dbm.setKV(db, "ia_settings_updatedAt", String(Date.now()));
    config.setNotionConfig({ token: payload.notionToken || "", parentPageId: payload.notionParentPageId || "" });
    config.setSafeBrowsingKey(payload.safeBrowsingKey || "");
  } catch (e) {
    // config.setNotionConfig / config.setSafeBrowsingKey write config.json
    // atomically (tmp + rename) and THROW if that rename fails -- a real,
    // previously-seen failure mode (see commit 3ee6e4b). If either throws
    // here, ia_settings above has *already* committed to SQLite, which would
    // otherwise leave a mixed A/B configuration: imported settings/keys in
    // the live store, but the original device's Notion/Safe-Browsing config
    // still on disk (or partially written). Roll ia_settings (and its stamp)
    // back to their pre-import values so the live store ends up completely
    // unchanged, matching a fully-failed import -- then re-throw so the
    // route still reports failure honestly. We deliberately do NOT try to
    // roll config.json back here: if setNotionConfig/setSafeBrowsingKey are
    // what's failing, retrying a write to the same broken path isn't
    // productive. The complete pre-import state (including config.json)
    // remains recoverable from the safety snapshot written above.
    if (prevSettingsRaw === null || prevSettingsRaw === undefined) dbm.delKV(db, "ia_settings");
    else dbm.setKV(db, "ia_settings", prevSettingsRaw);
    if (prevUpdatedAt === null || prevUpdatedAt === undefined) dbm.delKV(db, "ia_settings_updatedAt");
    else dbm.setKV(db, "ia_settings_updatedAt", prevUpdatedAt);
    throw e;
  }
}

module.exports = { buildConfigPayload, encryptConfigBackup, decryptConfigBackup, applyConfigPayload, writeImportSafetySnapshot };
