# Password-Protected Configuration Backup & Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user export their app configuration (AI provider settings, keys, Notion/Safe-Browsing credentials, preferences) to a single password-protected file, and restore it on any desktop install — independent of Dropbox sync.

**Architecture:** A new core module (`core/config-backup.js`) gathers the payload and does the AES-256-GCM encryption/decryption (Node's built-in `crypto`, no new dependencies). Two new routes on `core/server.js` expose it over HTTP. `web/storage.js` gets two new `Store` adapter methods; `pwa/storage-pwa.js` gets matching no-op stubs (desktop-only feature, same pattern as the existing `backupNow` stub there). Two new UI modals in `web/index.html`/`pwa/index.html` (mirrored per this project's convention) drive export (password + confirm, triggers a browser file download — a new pattern for this codebase) and import (file picker + password, full-replace with a local safety snapshot taken first).

**Tech Stack:** Node.js (CommonJS) + Express (`core/server.js`), Node's built-in `crypto` module, vanilla JS client-side, plain `assert`-based tests, no build step.

## Global Constraints

- **Excluded from the payload:** `S.updateToken` (desktop auto-updater token — always preserved from the CURRENT device on import, never taken from the imported file, matching the existing precedent in `core/db.js`'s `settingsForSync`/`core/merge.js`'s `mergeSyncedSettings`), and every device-identity field in `config.json` (`storePath`, `syncEnabled`, `syncDir`, `deviceId`, `deviceLabel`, `pairingToken`, `extensionPairingRequired`).
- **Included:** the full `ia_settings` blob (minus `updateToken`), the Notion token + parent page ID, the Safe Browsing key.
- Import is a **full replace**, not a merge — matching the existing data `/api/restore`'s semantics, not the Dropbox settings-sync's merge semantics.
- A local, unencrypted, single (non-rotated) safety snapshot of the device's CURRENT config is written to `<appDataDir>/config-import-safety.json` immediately before an import applies anything.
- A wrong password or corrupted/tampered file must leave the live store completely untouched (decrypt-then-apply, never apply-while-decrypting) and must report a single, deliberately non-specific error: "Wrong password or a corrupted file — nothing was changed."
- This is desktop-only. `pwa/index.html` still gets the identical UI edit (per this project's standing web/pwa mirroring convention) but its `Store` calls resolve to `pwa/storage-pwa.js` stubs that always report not-available — same treatment as the existing `backupNow` stub.
- Tests: plain Node `assert` scripts. Any test touching `core/config.js` (directly or via `core/config-backup.js`) MUST isolate `process.env.APPDATA` to a fresh temp dir **before** the first `require` of any module that loads `core/config.js` — this project's established, non-negotiable convention (a killed test run previously poisoned the real production config; see this project's own incident history).
- This touches config/credential-handling code — every task's review, and the final review, must use the **data-safety-reviewer** agent, not a general-purpose reviewer.
- `node tests/run.js` must stay green after every task.

---

### Task 1: `core/config-backup.js` — payload, encrypt/decrypt, apply

**Files:**
- Create: `core/config-backup.js`
- Test: `tests/config-backup.test.js` (new)

**Interfaces:**
- Produces:
  - `buildConfigPayload(db) -> {v, settings, notionToken, notionParentPageId, safeBrowsingKey}` — reads `ia_settings` via `db.js`'s `getKV`, strips `updateToken`, reads Notion/SafeBrowsing config via `core/config.js`'s `getNotionConfig()`/`getSafeBrowsingKey()`.
  - `encryptConfigBackup(payload, password) -> {v, salt, iv, authTag, ciphertext}` (all four crypto fields base64-encoded strings) — throws if `password` is falsy.
  - `decryptConfigBackup(envelope, password) -> payload` — throws (GCM auth-tag failure) on wrong password or tampered ciphertext; throws if `password` is falsy or `envelope` isn't an object.
  - `applyConfigPayload(db, payload)` — writes the safety snapshot first (`writeImportSafetySnapshot`), then full-replaces `ia_settings` (preserving the CURRENT device's `updateToken`), then calls `setNotionConfig`/`setSafeBrowsingKey` unconditionally with the payload's values (this is a full replace — an empty field in the payload correctly clears the target field, not "leaves it alone"; this is deliberately different from `setNotionConfig`'s own presence-based partial-update contract, which exists for a different caller with a different need).
  - `writeImportSafetySnapshot(db)` — writes the CURRENT (pre-mutation) `buildConfigPayload(db)` result, unencrypted, to `<appDataDir>/config-import-safety.json`, overwriting any previous snapshot.

- [ ] **Step 1: Write the failing tests**

Create `tests/config-backup.test.js`:

```js
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

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/config-backup.test.js`
Expected: FAIL — `Cannot find module '../core/config-backup.js'`.

- [ ] **Step 3: Implement `core/config-backup.js`**

```js
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
// confirmed action).
function writeImportSafetySnapshot(db) {
  const snapshot = buildConfigPayload(db);
  fs.mkdirSync(config.appDataDir(), { recursive: true });
  fs.writeFileSync(path.join(config.appDataDir(), "config-import-safety.json"), JSON.stringify(snapshot, null, 2), "utf8");
}

// Full replace, not a merge -- same semantics as the existing data
// /api/restore, deliberately different from the Dropbox settings-sync's
// merge semantics. updateToken is ALWAYS preserved from the current
// device, never taken from the payload (buildConfigPayload never includes
// one, but a hand-crafted file might -- this guards that too).
function applyConfigPayload(db, payload) {
  writeImportSafetySnapshot(db);
  let currentSettings = {};
  try { currentSettings = JSON.parse(dbm.getKV(db, "ia_settings") || "{}") || {}; } catch (e) { currentSettings = {}; }
  const merged = Object.assign({}, payload.settings || {}, { updateToken: currentSettings.updateToken || "" });
  dbm.setKV(db, "ia_settings", JSON.stringify(merged));
  config.setNotionConfig({ token: payload.notionToken || "", parentPageId: payload.notionParentPageId || "" });
  config.setSafeBrowsingKey(payload.safeBrowsingKey || "");
}

module.exports = { buildConfigPayload, encryptConfigBackup, decryptConfigBackup, applyConfigPayload, writeImportSafetySnapshot };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/config-backup.test.js`
Expected: all tests pass.

- [ ] **Step 5: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 6: Commit**

```bash
git add core/config-backup.js tests/config-backup.test.js
git commit -m "feat: add core/config-backup.js (payload build, AES-256-GCM encrypt/decrypt, full-replace apply)"
```

---

### Task 2: `POST /api/config-backup/export` and `/import` routes

**Files:**
- Modify: `core/server.js` (add `const configBackup = require("./config-backup");` near the top requires; add two new routes near the existing `/api/notion-config`/`/api/safebrowsing-key` routes, `core/server.js:1101-1129`)
- Test: `tests/server-config-backup-int.test.js` (new, following the established `tests/server-backup-int.test.js` HTTP-integration pattern)

**Interfaces:**
- Consumes: `core/config-backup.js`'s `buildConfigPayload`, `encryptConfigBackup`, `decryptConfigBackup`, `applyConfigPayload` (Task 1).
- Produces:
  - `POST /api/config-backup/export` — body `{password}`. `400` with `{ok:false,error:"password required"}` if empty/missing. Success: `{ok:true, envelope:{v,salt,iv,authTag,ciphertext}}`.
  - `POST /api/config-backup/import` — body `{password, envelope}`. `400` with `{ok:false,error:"password required"}` if password empty; `400` with `{ok:false,error:"no backup file provided"}` if `envelope` missing/not an object; `400` with `{ok:false,error:"Wrong password or a corrupted file — nothing was changed."}` if decrypt throws (live store untouched in this case — `applyConfigPayload` is only ever called AFTER a successful decrypt). Success: `{ok:true}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/server-config-backup-int.test.js`:

```js
// tests/server-config-backup-int.test.js — POST /api/config-backup/export
// and /import over real HTTP, against a real Core service instance.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const { createServer } = require("../core/server.js");
const { openDb, setKV, getKV } = require("../core/db.js");
const config = require("../core/config.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cbsrv-store-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise(function (res) {
    const srv = http.createServer(app).listen(0, "127.0.0.1", function () {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}

(async function () {
  const store = newStore();
  let db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: () => store, setStorePath: () => {}, reopen: () => openDb(ctx.storeDir) };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("POST /api/config-backup/export requires a password (400, not 500)", async () => {
    const r = await fetch(base + "/api/config-backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.strictEqual(j.ok, false);
  });

  setKV(ctx.db, "ia_settings", JSON.stringify({ provider: "gemini", keys: { gemini: "super-secret-key" }, updateToken: "device-A-token", itemCount: 7 }));
  config.setNotionConfig({ token: "notion-secret", parentPageId: "page-1" });
  config.setSafeBrowsingKey("sb-secret");

  let envelope;
  await run("POST /api/config-backup/export returns an envelope whose ciphertext does not contain the plaintext key", async () => {
    const r = await (await fetch(base + "/api/config-backup/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse" }),
    })).json();
    assert.strictEqual(r.ok, true);
    assert.ok(r.envelope && r.envelope.ciphertext);
    assert.ok(r.envelope.ciphertext.indexOf("super-secret-key") === -1, "the raw key must never appear in the ciphertext blob");
    envelope = r.envelope;
  });

  await run("POST /api/config-backup/import with the WRONG password leaves ia_settings byte-for-byte unchanged", async () => {
    const before = getKV(ctx.db, "ia_settings");
    const r = await fetch(base + "/api/config-backup/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "totally-wrong", envelope }),
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.strictEqual(j.ok, false);
    assert.ok(/wrong password/i.test(j.error));
    assert.strictEqual(getKV(ctx.db, "ia_settings"), before, "a failed decrypt must never touch the live store");
  });

  // Simulate "restoring onto a DIFFERENT device": that device's own settings
  // (including its OWN updateToken) are different from what was exported above.
  setKV(ctx.db, "ia_settings", JSON.stringify({ provider: "openai", updateToken: "device-B-own-token", itemCount: 1 }));

  await run("POST /api/config-backup/import with the RIGHT password full-replaces settings but preserves THIS device's updateToken", async () => {
    const r = await (await fetch(base + "/api/config-backup/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse", envelope }),
    })).json();
    assert.strictEqual(r.ok, true);
    const after = JSON.parse(getKV(ctx.db, "ia_settings"));
    assert.strictEqual(after.provider, "gemini", "provider must come from the imported (device A's) settings");
    assert.strictEqual(after.keys.gemini, "super-secret-key");
    assert.strictEqual(after.itemCount, 7);
    assert.strictEqual(after.updateToken, "device-B-own-token", "updateToken must stay THIS device's own, never device A's (it wasn't even in the export)");
  });

  await run("Notion token / parent page / Safe Browsing key round-trip through the same import", async () => {
    const n = config.getNotionConfig();
    assert.strictEqual(n.token, "notion-secret");
    assert.strictEqual(n.parentPageId, "page-1");
    assert.strictEqual(config.getSafeBrowsingKey(), "sb-secret");
  });

  await run("A pre-import safety snapshot was written before the import applied", async () => {
    const snapPath = path.join(config.appDataDir(), "config-import-safety.json");
    assert.ok(fs.existsSync(snapPath));
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    assert.strictEqual(snap.settings.provider, "openai", "must capture device B's PRE-import state, not device A's just-applied settings");
  });

  await run("POST /api/config-backup/import with no envelope is a 400, not a 500", async () => {
    const r = await fetch(base + "/api/config-backup/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse" }),
    });
    assert.strictEqual(r.status, 400);
  });

  await new Promise((res) => srv.close(res));
  try { ctx.db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  await new Promise((res) => setTimeout(res, 50));
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/server-config-backup-int.test.js`
Expected: FAIL — every request 404s (routes don't exist yet).

- [ ] **Step 3: Add the routes to `core/server.js`**

Add the new require near the top, after `const config = require("./config");`:

```js
const configBackup = require("./config-backup");
```

Add the two new routes near the existing `/api/notion-config`/`/api/safebrowsing-key` routes (`core/server.js:1101-1129`), anywhere in that same "config" route group:

```js
  app.post("/api/config-backup/export", (req, res) => {
    try {
      const password = (req.body && typeof req.body.password === "string") ? req.body.password : "";
      if (!password) return res.status(400).json({ ok: false, error: "password required" });
      const payload = configBackup.buildConfigPayload(ctx.db);
      const envelope = configBackup.encryptConfigBackup(payload, password);
      res.json({ ok: true, envelope: envelope });
    } catch (e) {
      console.error("config-backup export failed:", e);
      res.status(500).json({ ok: false, error: "export failed" });
    }
  });

  app.post("/api/config-backup/import", (req, res) => {
    try {
      const password = (req.body && typeof req.body.password === "string") ? req.body.password : "";
      const envelope = req.body && req.body.envelope;
      if (!password) return res.status(400).json({ ok: false, error: "password required" });
      if (!envelope || typeof envelope !== "object") return res.status(400).json({ ok: false, error: "no backup file provided" });
      let payload;
      try {
        payload = configBackup.decryptConfigBackup(envelope, password);
      } catch (e) {
        return res.status(400).json({ ok: false, error: "Wrong password or a corrupted file — nothing was changed." });
      }
      configBackup.applyConfigPayload(ctx.db, payload);
      res.json({ ok: true });
    } catch (e) {
      console.error("config-backup import failed:", e);
      res.status(500).json({ ok: false, error: "import failed" });
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/server-config-backup-int.test.js`
Expected: all tests pass.

- [ ] **Step 5: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 6: Commit**

```bash
git add core/server.js tests/server-config-backup-int.test.js
git commit -m "feat: add POST /api/config-backup/export and /import routes"
```

---

### Task 3: `Store` adapter methods + PWA stubs

**Files:**
- Modify: `web/storage.js` (add two `SE` endpoint builders near `SE.backup`/`SE.backups`, and two `Store` methods near `Store.backupNow`)
- Modify: `pwa/storage-pwa.js` (add two matching stub methods near the existing `backupNow` stub)
- Test: append to `tests/storage-adapter.test.js` (web) and a new small regex-based test for the pwa stub

**Interfaces:**
- Produces: `SE.configBackupExport() -> "/api/config-backup/export"`, `SE.configBackupImport() -> "/api/config-backup/import"`; `Store.exportConfigBackup(password) -> Promise<{ok,envelope}|{ok:false,error}>`; `Store.importConfigBackup(password, envelope) -> Promise<{ok}|{ok:false,error}>`. PWA stubs: `Store.exportConfigBackup`/`Store.importConfigBackup` both resolve `{ok:false, reason:"Not applicable on iPad — configuration backup is desktop-only."}`, ignoring their arguments — same shape convention as `pwa/storage-pwa.js`'s existing `backupNow` stub.

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage-adapter.test.js`, inside its existing `(async function () { ... })();` IIFE, after the last existing `await run(...)` call and before its closing `})();`:

```js
  await run("Store.exportConfigBackup POSTs /api/config-backup/export with the password", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, envelope: { v: 1, salt: "s", iv: "i", authTag: "a", ciphertext: "c" } })));
    const r = await Store.exportConfigBackup("my-password");
    assert.ok(calls[0].url.endsWith("/api/config-backup/export"));
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.strictEqual(JSON.parse(calls[0].opts.body).password, "my-password");
    assert.strictEqual(r.envelope.v, 1);
  });

  await run("Store.importConfigBackup POSTs /api/config-backup/import with the password and envelope", async () => {
    calls = [];
    const envelope = { v: 1, salt: "s", iv: "i", authTag: "a", ciphertext: "c" };
    const Store = loadStoreWithFetch(stub(() => ({ ok: true })));
    const r = await Store.importConfigBackup("my-password", envelope);
    assert.ok(calls[0].url.endsWith("/api/config-backup/import"));
    const sentBody = JSON.parse(calls[0].opts.body);
    assert.strictEqual(sentBody.password, "my-password");
    assert.deepStrictEqual(sentBody.envelope, envelope);
    assert.strictEqual(r.ok, true);
  });
```

Create a new small test file `tests/pwa-config-backup-stub.test.js`:

```js
// tests/pwa-config-backup-stub.test.js — pwa/storage-pwa.js's Store gets
// no-op stubs for the desktop-only config-backup feature, matching the
// existing backupNow stub's pattern exactly.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("exportConfigBackup stub resolves {ok:false} with a desktop-only reason", () => {
  assert.match(src, /exportConfigBackup:\s*\(\)\s*=>\s*Promise\.resolve\(\{\s*ok:\s*false,\s*reason:/);
});
t("importConfigBackup stub resolves {ok:false} with a desktop-only reason", () => {
  assert.match(src, /importConfigBackup:\s*\(\)\s*=>\s*Promise\.resolve\(\{\s*ok:\s*false,\s*reason:/);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/storage-adapter.test.js` and `node tests/pwa-config-backup-stub.test.js`
Expected: FAIL — the new `Store`/`SE` methods and pwa stubs don't exist yet.

- [ ] **Step 3: Add the `SE`/`Store` methods to `web/storage.js`**

Add to the `SE` object, near `backup`/`backups`:
```js
    configBackupExport: function () { return "/api/config-backup/export"; },
    configBackupImport: function () { return "/api/config-backup/import"; },
```

Add to the `Store` object, near `backupNow`/`listBackups`:
```js
      exportConfigBackup: function (password) { return jsend("POST", SE.configBackupExport(), { password: password }); },
      importConfigBackup: function (password, envelope) { return jsend("POST", SE.configBackupImport(), { password: password, envelope: envelope }); },
```

- [ ] **Step 4: Add the stubs to `pwa/storage-pwa.js`**

Add near the existing `backupNow`/`listBackups` stubs:
```js
    exportConfigBackup: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — configuration backup is desktop-only." }),
    importConfigBackup: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — configuration backup is desktop-only." }),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/storage-adapter.test.js` and `node tests/pwa-config-backup-stub.test.js`
Expected: all pass.

- [ ] **Step 6: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 7: Commit**

```bash
git add web/storage.js pwa/storage-pwa.js tests/storage-adapter.test.js tests/pwa-config-backup-stub.test.js
git commit -m "feat: add Store.exportConfigBackup/importConfigBackup (web) + desktop-only stubs (pwa)"
```

---

### Task 4: Export UI (modal + password confirm + file download)

**Files:**
- Modify: `web/index.html` — CSS near `:345-346` (add `#configBackupModal` rules), modal markup near `:835` (add `#configBackupModal` div, next to `#tabNameModal`), Settings "Backup & restore" section (`:792-798`, add the trigger button + new sub-section), new JS functions near the `tabNameModal` functions (`:3605-3636`)
- Mirror identically in `pwa/index.html`
- Test: `tests/config-backup-export-ui.test.js` (new)

**Interfaces:**
- Consumes: `Store.exportConfigBackup` (Task 3).
- Produces: `openConfigBackupExport()`, `closeConfigBackupModal()`, `submitConfigBackupExport()`. `_cfgBackupMode` (module-level state, shared with Task 5's import modal — both tasks write to the same `#configBackupModal`/`#configBackupModalBody` pair, mode-switched, matching this project's existing `#tabNameModal` create/rename pattern).

- [ ] **Step 1: Write the failing tests**

Create `tests/config-backup-export-ui.test.js`:

```js
// tests/config-backup-export-ui.test.js — the export modal's password/confirm
// validation and the Blob-download construction, sandboxed with stubbed
// Blob/URL/document/Store (this project's established extractFn() pattern;
// see tests/enrichOnOpen-style sandboxes elsewhere for the stub-DOM technique).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function makeDom() {
  const body = { innerHTML: "", value: "", textContent: "" };
  const els = {
    configBackupModalBody: body,
    cfgBackupPw1: { value: "", focus: () => {} },
    cfgBackupPw2: { value: "" },
    cfgBackupErr: { textContent: "" },
    configBackupModal: { classList: { add: () => {}, remove: () => {} } },
  };
  const anchor = { href: "", download: "", click: () => { anchor.clicked = true; } };
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => (tag === "a" ? anchor : {}),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  return { document, els, anchor };
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": submitConfigBackupExport refuses an empty password without calling Store", async () => {
    const { document, els } = makeDom();
    els.cfgBackupPw1.value = ""; els.cfgBackupPw2.value = "";
    let called = false;
    const Store = { exportConfigBackup: async () => { called = true; return { ok: true, envelope: {} }; } };
    const factory = new Function(
      "document", "Store", "Blob", "URL", "toast", "closeConfigBackupModal",
      extractFn(src, "submitConfigBackupExport") + "\nreturn submitConfigBackupExport;"
    );
    const submitConfigBackupExport = factory(document, Store, function () {}, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, () => {}, () => {});
    await submitConfigBackupExport();
    assert.strictEqual(called, false);
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupExport refuses mismatched passwords without calling Store", async () => {
    const { document, els } = makeDom();
    els.cfgBackupPw1.value = "abc123"; els.cfgBackupPw2.value = "different";
    let called = false;
    const Store = { exportConfigBackup: async () => { called = true; return { ok: true, envelope: {} }; } };
    const factory = new Function(
      "document", "Store", "Blob", "URL", "toast", "closeConfigBackupModal",
      extractFn(src, "submitConfigBackupExport") + "\nreturn submitConfigBackupExport;"
    );
    const submitConfigBackupExport = factory(document, Store, function () {}, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, () => {}, () => {});
    await submitConfigBackupExport();
    assert.strictEqual(called, false);
    assert.match(els.cfgBackupErr.textContent, /match/i);
  });

  await t(label + ": submitConfigBackupExport with matching passwords calls Store, closes the modal, and triggers a download", async () => {
    const { document, els, anchor } = makeDom();
    els.cfgBackupPw1.value = "abc123"; els.cfgBackupPw2.value = "abc123";
    let sentPassword = null, modalClosed = false;
    const Store = { exportConfigBackup: async (pw) => { sentPassword = pw; return { ok: true, envelope: { v: 1, salt: "s" } }; } };
    let blobContent = null;
    function FakeBlob(parts) { blobContent = parts[0]; }
    const factory = new Function(
      "document", "Store", "Blob", "URL", "toast", "closeConfigBackupModal",
      extractFn(src, "submitConfigBackupExport") + "\nreturn submitConfigBackupExport;"
    );
    const submitConfigBackupExport = factory(document, Store, FakeBlob, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, () => {}, () => { modalClosed = true; });
    await submitConfigBackupExport();
    assert.ok(modalClosed, "a successful export must close the modal");
    assert.strictEqual(sentPassword, "abc123");
    assert.ok(anchor.clicked, "the download must actually be triggered via a.click()");
    assert.ok(/\.iaconfig$/.test(anchor.download), "download filename must end in .iaconfig");
    assert.ok(JSON.parse(blobContent).v === 1, "the Blob content must be the envelope JSON");
  });

  await t(label + ": the Settings section has Export/Restore configuration buttons", () => {
    assert.match(src, /onclick="openConfigBackupExport\(\)"/);
    assert.match(src, /onclick="openConfigBackupImport\(\)"/);
  });

  await t(label + ": #configBackupModal markup and CSS exist", () => {
    assert.match(src, /id="configBackupModal"/);
    assert.match(src, /#configBackupModal\{/);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/config-backup-export-ui.test.js`
Expected: FAIL — none of the new functions/markup exist yet.

- [ ] **Step 3: Add the CSS (`web/index.html`, near `:345-346`)**

Right after the existing `#tabNameModal`/`#tabNameModal.open` rules:
```css
#configBackupModal{display:none;position:fixed;inset:0;background:rgba(31,29,26,.5);z-index:96;align-items:center;justify-content:center;padding:16px}
#configBackupModal.open{display:flex}
```

- [ ] **Step 4: Add the modal markup (`web/index.html`, near `:835`)**

Right after the `#tabNameModal` div:
```html
<div id="configBackupModal" onclick="if(event.target===this)closeConfigBackupModal()"><div class="tnm-box" id="configBackupModalBody"></div></div>
```

- [ ] **Step 5: Add the trigger buttons (`web/index.html`, inside the "Backup & restore" `.sec`, right before its closing `</div>` at `:799`)**

```html
<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
  <label style="font-weight:600">Configuration backup</label>
  <div class="hint" style="margin:4px 0 8px">A separate, password-protected export of your AI provider settings, keys, and preferences — a portable file you can restore on any install, not tied to Dropbox.</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <button class="btn btn-primary" onclick="openConfigBackupExport()">Export configuration…</button>
    <button class="btn btn-ghost" onclick="openConfigBackupImport()">Restore configuration…</button>
  </div>
</div>
```

(`openConfigBackupImport()` is Task 5's function — safe to reference here now since Task 5 adds it to the same `web/index.html` before this branch is done; the button existing one task early does not break anything, it just isn't clickable-to-success until Task 5 lands.)

- [ ] **Step 6: Add the export JS (`web/index.html`, near the `tabNameModal` functions, `:3605-3636`)**

```js
let _cfgBackupMode = "export";   // "export" | "import" -- set by Task 5's openConfigBackupImport too
function openConfigBackupExport(){
  _cfgBackupMode = "export";
  document.getElementById("configBackupModalBody").innerHTML =
    `<h3 style="margin:0 0 12px">Export configuration</h3>`+
    `<div class="hint" style="margin-bottom:10px">Downloads a password-protected file with your AI provider settings, keys, and preferences — restore it on any install of the app.</div>`+
    `<input id="cfgBackupPw1" type="password" placeholder="Password" autocomplete="new-password">`+
    `<input id="cfgBackupPw2" type="password" placeholder="Confirm password" autocomplete="new-password" style="margin-top:8px">`+
    `<div id="cfgBackupErr" class="hint" style="color:#b3261e;min-height:1.2em;margin-top:6px"></div>`+
    `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">`+
    `<button class="btn btn-ghost" onclick="closeConfigBackupModal()">Cancel</button>`+
    `<button class="btn btn-primary" onclick="submitConfigBackupExport()">Export</button>`+
    `</div>`;
  document.getElementById("configBackupModal").classList.add("open");
  const inp = document.getElementById("cfgBackupPw1");
  inp.focus();
  inp.onkeydown = e=>{ if(e.key==="Enter") submitConfigBackupExport(); else if(e.key==="Escape") closeConfigBackupModal(); };
}
function closeConfigBackupModal(){ document.getElementById("configBackupModal").classList.remove("open"); }
async function submitConfigBackupExport(){
  const pw1 = document.getElementById("cfgBackupPw1").value;
  const pw2 = document.getElementById("cfgBackupPw2").value;
  const err = document.getElementById("cfgBackupErr");
  if(!pw1){ err.textContent = "Enter a password."; return; }
  if(pw1 !== pw2){ err.textContent = "Passwords don't match."; return; }
  err.textContent = "";
  try{
    const res = await Store.exportConfigBackup(pw1);
    if(!res || res.ok===false){ err.textContent = (res&&(res.error||res.reason)) || "Export failed."; return; }
    const blob = new Blob([JSON.stringify(res.envelope)], {type:"application/octet-stream"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "interests-config-backup-"+new Date().toISOString().slice(0,10)+".iaconfig";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    closeConfigBackupModal();
    toast("Configuration exported.");
  }catch(e){ err.textContent = "Export failed: "+(e&&e.message||e); }
}
```

- [ ] **Step 7: Copy every edit from Steps 3-6 identically to `pwa/index.html`**

Same CSS, same modal div, same buttons (placed in the PWA build's equivalent Settings "Backup & restore" section), same JS functions. Verify with:

```bash
diff <(sed -n '/^let _cfgBackupMode/,/^}$/p' web/index.html | sed -n '/^async function submitConfigBackupExport/,/^}$/p') <(sed -n '/^let _cfgBackupMode/,/^}$/p' pwa/index.html | sed -n '/^async function submitConfigBackupExport/,/^}$/p')
grep -c '#configBackupModal{' web/index.html pwa/index.html
```

Expected: no diff output; both grep counts equal `1`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node tests/config-backup-export-ui.test.js`
Expected: all tests pass.

- [ ] **Step 9: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 10: Commit**

```bash
git add web/index.html pwa/index.html tests/config-backup-export-ui.test.js
git commit -m "feat: add Export configuration UI (password+confirm modal, file download)"
```

---

### Task 5: Import UI (modal + file picker + full-replace warning + reload)

**Files:**
- Modify: `web/index.html` — new JS functions near Task 4's export functions
- Mirror identically in `pwa/index.html`
- Test: `tests/config-backup-import-ui.test.js` (new)

**Interfaces:**
- Consumes: `Store.importConfigBackup` (Task 3), `_cfgBackupMode`/`#configBackupModal`/`#configBackupModalBody` (Task 4).
- Produces: `openConfigBackupImport()`, `submitConfigBackupImport()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/config-backup-import-ui.test.js`:

```js
// tests/config-backup-import-ui.test.js — the import modal's file-read +
// password flow, sandboxed with a stubbed FileReader/document/Store.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

// A FileReader stand-in that resolves with a preset text result (or errors)
// as soon as readAsText is called — mirrors this project's existing
// restoreData()-testing shape for the same "read a picked file" idiom.
function makeFileReader(readResult, shouldError) {
  return function FakeFileReader() {
    this.readAsText = () => {
      if (shouldError) { if (this.onerror) this.onerror(); return; }
      this.result = readResult;
      if (this.onload) this.onload();
    };
  };
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": submitConfigBackupImport requires a file", async () => {
    const els = { cfgRestoreFile: { files: [] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(document, { importConfigBackup: async () => { throw new Error("must not be called"); } }, makeFileReader("{}"), () => {}, { reload: () => {} });
    submitConfigBackupImport();
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport requires a password", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(document, { importConfigBackup: async () => { throw new Error("must not be called"); } }, makeFileReader("{}"), () => {}, { reload: () => {} });
    submitConfigBackupImport();
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport rejects a file that isn't valid JSON, without calling Store", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let called = false;
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(document, { importConfigBackup: async () => { called = true; } }, makeFileReader("not json{{{"), () => {}, { reload: () => {} });
    submitConfigBackupImport();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(called, false);
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport on success calls Store.importConfigBackup and defers the reload (doesn't reload synchronously)", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "my-pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let sentPw = null, sentEnvelope = null, reloaded = false;
    const envelope = { v: 1, salt: "s", iv: "i", authTag: "a", ciphertext: "c" };
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(
      document,
      { importConfigBackup: async (pw, env) => { sentPw = pw; sentEnvelope = env; return { ok: true }; } },
      makeFileReader(JSON.stringify(envelope)),
      () => {},
      { reload: () => { reloaded = true; } }
    );
    submitConfigBackupImport();
    await new Promise((r) => setTimeout(r, 10));   // let the async onload handler run (well short of the real 800ms reload delay)
    assert.strictEqual(sentPw, "my-pw");
    assert.deepStrictEqual(sentEnvelope, envelope);
    assert.strictEqual(reloaded, false, "the reload must be deliberately deferred (800ms, so the toast is visible first), not synchronous");
  });

  await t(label + ": the import modal warns this replaces the device's current configuration", () => {
    assert.match(src, /replaces this device's current/i);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/config-backup-import-ui.test.js`
Expected: FAIL — `submitConfigBackupImport`/`openConfigBackupImport` don't exist yet.

- [ ] **Step 3: Add the import JS (`web/index.html`, right after Task 4's export functions)**

```js
function openConfigBackupImport(){
  _cfgBackupMode = "import";
  document.getElementById("configBackupModalBody").innerHTML =
    `<h3 style="margin:0 0 12px">Restore configuration</h3>`+
    `<div class="hint" style="margin-bottom:10px;color:#b3261e">This replaces this device's current AI provider settings, keys, and preferences. A local, unencrypted safety copy of your current settings is kept in case you need to undo this.</div>`+
    `<input id="cfgRestoreFile" type="file" accept=".iaconfig,.json">`+
    `<input id="cfgBackupPw1" type="password" placeholder="Password" autocomplete="current-password" style="margin-top:8px">`+
    `<div id="cfgBackupErr" class="hint" style="color:#b3261e;min-height:1.2em;margin-top:6px"></div>`+
    `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">`+
    `<button class="btn btn-ghost" onclick="closeConfigBackupModal()">Cancel</button>`+
    `<button class="btn btn-primary" onclick="submitConfigBackupImport()">Restore</button>`+
    `</div>`;
  document.getElementById("configBackupModal").classList.add("open");
  const inp = document.getElementById("cfgBackupPw1");
  inp.onkeydown = e=>{ if(e.key==="Enter") submitConfigBackupImport(); else if(e.key==="Escape") closeConfigBackupModal(); };
}
function submitConfigBackupImport(){
  const fileInput = document.getElementById("cfgRestoreFile");
  const pw = document.getElementById("cfgBackupPw1").value;
  const err = document.getElementById("cfgBackupErr");
  const file = fileInput.files && fileInput.files[0];
  if(!file){ err.textContent = "Choose a file."; return; }
  if(!pw){ err.textContent = "Enter the password."; return; }
  err.textContent = "";
  const reader = new FileReader();
  reader.onerror = function(){ err.textContent = "Couldn't read that file."; };
  reader.onload = async function(){
    let envelope;
    try{ envelope = JSON.parse(reader.result); }catch(e){ err.textContent = "That doesn't look like a valid configuration backup file."; return; }
    try{
      const res = await Store.importConfigBackup(pw, envelope);
      if(!res || res.ok===false){ err.textContent = (res&&(res.error||res.reason)) || "Restore failed."; return; }
      toast("Configuration restored — reloading…");
      setTimeout(()=>location.reload(), 800);
    }catch(e){ err.textContent = "Restore failed: "+(e&&e.message||e); }
  };
  reader.readAsText(file);
}
```

- [ ] **Step 4: Copy identically to `pwa/index.html`**

Verify with:
```bash
diff <(sed -n '/^function openConfigBackupImport/,/^}$/p' web/index.html) <(sed -n '/^function openConfigBackupImport/,/^}$/p' pwa/index.html)
diff <(sed -n '/^function submitConfigBackupImport/,/^}$/p' web/index.html) <(sed -n '/^function submitConfigBackupImport/,/^}$/p' pwa/index.html)
```
Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/config-backup-import-ui.test.js`
Expected: all tests pass.

- [ ] **Step 6: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/config-backup-import-ui.test.js
git commit -m "feat: add Restore configuration UI (file picker, full-replace warning, reload)"
```

---

### Task 6: Parity manifest + full verification

**Files:**
- Modify: `tests/surface-parity-manifest.js` (`indexContracts` array)

- [ ] **Step 1: Register the new top-level `index.html` functions**

Add to `indexContracts` in `tests/surface-parity-manifest.js`:
```js
    "openConfigBackupExport",
    "closeConfigBackupModal",
    "submitConfigBackupExport",
    "openConfigBackupImport",
    "submitConfigBackupImport",
```

- [ ] **Step 2: Run the full test suite**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 3: Manual byte-identity spot-check**

```bash
for fn in openConfigBackupExport closeConfigBackupModal submitConfigBackupExport openConfigBackupImport submitConfigBackupImport; do
  echo "-- $fn --"
  diff <(sed -n "/^\(async \)\?function $fn(/,/^}/p" web/index.html) <(sed -n "/^\(async \)\?function $fn(/,/^}/p" pwa/index.html)
done
grep -n '#configBackupModal{' web/index.html pwa/index.html
grep -n 'id="configBackupModal"' web/index.html pwa/index.html
```

Expected: no output under any `-- $fn --` header; both `grep -n` calls show one match per file.

- [ ] **Step 4: Commit**

```bash
git add tests/surface-parity-manifest.js
git commit -m "test: register config-backup UI functions in the surface-parity manifest"
```
