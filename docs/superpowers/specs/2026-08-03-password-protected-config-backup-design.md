# Password-protected configuration backup & restore — design

## Goal

Let a user export their app configuration (AI provider settings, API keys,
Notion/Safe-Browsing credentials, behavior preferences) to a single
password-protected file, and restore that file on **any** install of the
app — not tied to Dropbox, not tied to any particular machine. This closes
a real gap: the existing Dropbox settings-sync (`core/sync.js`) only
replicates settings between devices already connected to the *same*
Dropbox account, in plaintext, and a fresh install with no Dropbox
configured yet has no way to receive a saved configuration at all.

**Desktop (Electron) only** — same scope as the existing data backup/
restore system, which already depends on the local Core service. Not
built for the PWA/iPad build in this pass.

## What gets included / excluded

**Included** (everything a fresh install would otherwise need re-entered
by hand):
- The entire `S` settings blob (`ia_settings` kv key) — AI provider
  choice, all 6 provider API keys, model selections, weights, behavior
  toggles, `extraCats`/`hiddenBase`, everything currently in `DEFAULTS`
  (`web/index.html:872-901`) plus the two fields merged on afterward.
- The Notion integration token + parent page ID (`config.json`'s
  `notionToken`/`notionParentPageId`, via `core/config.js`'s
  `getNotionConfig()`).
- The Google Safe Browsing API key (`config.json`'s `safeBrowsingKey`, via
  `core/config.js`'s `getSafeBrowsingKey()`).

**Excluded** (device-identity fields that would be actively harmful to
transplant onto another machine):
- `S.updateToken` — already has a "never leaves this device" precedent
  coded twice in this repo (`core/db.js:545`'s `settingsForSync`,
  `core/merge.js:115-116`'s `mergeSyncedSettings`); this feature follows
  the same rule.
- `config.json`'s `storePath`, `syncEnabled`/`syncDir`/`deviceId`/
  `deviceLabel`, `pairingToken`, `extensionPairingRequired` — all
  inherently per-machine/per-identity, meaningless or actively wrong to
  copy onto a different install.

## Encryption

Node's built-in `crypto` module, no new dependencies (this codebase
already uses it elsewhere for hashing — `core/backup.js`,
`core/capture-queue.js` — but never yet for encryption; this is the first
use of `createCipheriv`/`createDecipheriv`/`scrypt` in the repo).

- **Key derivation:** `crypto.scryptSync(password, salt, 32)` — a fresh
  random 16-byte `salt` (`crypto.randomBytes(16)`) per export, Node's
  default cost parameters (`N=16384, r=8, p=1`). This is sized for
  protecting a locally-stored/emailed file against casual access, not for
  resisting a dedicated nation-state attacker — an appropriate bar for
  this feature, not a bank-vault requirement.
- **Cipher:** AES-256-GCM (`crypto.createCipheriv("aes-256-gcm", key,
  iv)`), a fresh random 12-byte `iv` (`crypto.randomBytes(12)`) per
  export. GCM is authenticated — decrypting with the wrong password (or a
  corrupted/tampered file) fails the auth-tag check and throws, which is
  exactly the "fail loudly, not silently produce garbage settings"
  behavior this needs. The single resulting error is reported to the user
  as "wrong password or corrupted file" — deliberately not distinguishing
  which (GCM structurally can't tell you, and telling you which would leak
  information to an attacker with an intercepted file).
- **Envelope format** — the downloaded file's content is itself a small
  versioned JSON document (human-inspectable shape, even though its
  content is unreadable base64):
  ```json
  {
    "v": 1,
    "salt": "<base64>",
    "iv": "<base64>",
    "authTag": "<base64>",
    "ciphertext": "<base64>"
  }
  ```
  A version field from day one means a future format change can branch on
  `v` without breaking old exported files.
- All of this runs **server-side only**, inside `core/`, in a new
  `core/config-backup.js` module (mirroring this project's one-concern-
  per-file convention — `core/notion.js`, `core/backup.js` are the
  existing examples). The browser never sees a plaintext key or password
  beyond what it typed into the form and POSTed once per operation.

## Server (`core/config-backup.js`, new module)

```js
function buildConfigPayload(db) { ... }   // gathers S (ia_settings, updateToken stripped) + Notion token/parentPageId + safeBrowsingKey into one plain object
function encryptConfigBackup(payload, password) { ... }   // -> the {v,salt,iv,authTag,ciphertext} envelope object
function decryptConfigBackup(envelope, password) { ... }   // -> the original payload object, or throws on bad password/corruption
function applyConfigPayload(db, payload) { ... }   // writes ia_settings (with updateToken preserved from the CURRENT device, never taken from the imported payload — same asymmetric-preserve rule mergeSyncedSettings already uses), calls setNotionConfig/setSafeBrowsingKey for the fields present in the payload
```

`applyConfigPayload` takes one explicit data-safety step before writing
anything: it snapshots the device's CURRENT `ia_settings` +
Notion/SafeBrowsing config (plain, unencrypted JSON — this is a local-only
undo point, not something leaving the machine) to
`path.join(appDataDir(), "config-import-safety.json")`, overwriting any
previous safety snapshot from an earlier import. This is a "recover from
my own mistake" safety net, not a rotated history — a single snapshot
matches the risk (a rare, deliberate, already-confirmed action) without
over-building.

`applyConfigPayload`'s writes only happen after a successful decrypt — a
wrong password never touches the live store at all, so there is no
partial-failure state to reason about.

## Routes (`core/server.js`)

Two new routes, following this project's existing route-per-concern shape
(not folded into the generic `/api/kv/:key` route, since that route has no
awareness that `ia_settings` contains credentials — same reasoning that
already justified dedicated `/api/notion-config`/`/api/safebrowsing-key`
routes instead of routing those through generic kv):

- **`POST /api/config-backup/export`** — body `{password}`. Builds the
  payload, encrypts it, responds with the envelope JSON directly (the
  client turns that into a downloadable file — see below). A missing/
  empty password is a 400, not a 500 — this is a user-input validation
  case, not a server error.
- **`POST /api/config-backup/import`** — body `{password, envelope}`
  (`envelope` is the parsed JSON object the client read from the picked
  file). Decrypts; on failure, responds 400 with a message the client
  displays verbatim ("Wrong password or a corrupted file — nothing was
  changed."); on success, calls `applyConfigPayload` and responds
  `{ok:true}`.

## Client (`web/index.html`, mirrored in `pwa/index.html` per this
project's standing convention, even though this feature is desktop-only —
see below)

Two new buttons in the existing "Backup & restore" Settings section
(`web/index.html:764-799`), clearly labeled as a distinct, portable thing
from the existing local data-backup controls right above them:

- **"Export configuration…"** — opens a new in-page modal (this project's
  `window.prompt()` is broken under Electron's `sandbox:true`, confirmed
  in this project's own conventions — every free-text input already uses
  an in-page modal, e.g. `#tabNameModal`/`#getpicModal`/`#healthModal`;
  this feature follows the same pattern, never `prompt()`). The modal asks
  for a password **and** a confirm-password field (a typo here would
  silently produce a backup file the user can never decrypt — worth one
  extra field to catch it). On submit: `POST /api/config-backup/export`,
  then turn the JSON response into a downloadable file using `Blob` +
  `URL.createObjectURL` + a temporary `<a download>` click — a pattern
  this codebase doesn't have yet (confirmed: no existing
  `createObjectURL`/`<a download>` usage anywhere) and is being
  introduced here. Filename: `interests-config-backup-<YYYY-MM-DD>.iaconfig`
  (a distinct extension rather than `.json`, so it doesn't invite someone
  to open it expecting readable settings, while the content is still
  plain JSON underneath).
- **"Restore configuration…"** — opens a second in-page modal: a file
  picker (`<input type="file" accept=".iaconfig,.json">`), a password
  field, and an explicit warning that this **replaces** this device's
  current configuration (this is a full-replace operation, matching how
  the existing data `/api/restore` is also a full replace, not a merge —
  "restore my saved configuration" is a different action from "sync,"
  which already exists separately). On submit: read the picked file via
  `FileReader.readAsText` + `JSON.parse` (same idiom the existing legacy
  `restoreData()` already uses at `web/index.html:1639-1650`, the one
  precedent this codebase has for "read a JSON file the user picked"),
  `POST /api/config-backup/import`. On success: `location.reload()` — the
  simplest, safest way to guarantee every piece of `S`-dependent client
  state (cached provider choice, key availability, weights, etc.) is
  re-derived consistently, rather than auditing every read site of `S`.
  On failure (400 from the route): toast the server's message verbatim,
  modal stays open so the user can retry with the right password.

**Why mirror into `pwa/index.html` even though this is desktop-only:**
this project's standing convention is that every function touched in
`web/index.html` gets the identical edit in `pwa/index.html`, including
functions that are inert there (the same pattern already used for
`doBackup`/`maybeAutoBackup`, which are real on desktop and effectively
no-ops against `pwa/storage-pwa.js`'s stub `backupNow`). The two new
buttons stay visible in the PWA UI too — same treatment as the existing
"Back up now" button, which is also shown on PWA despite being a no-op
there. Clicking either on PWA surfaces a clear "not available" failure
(there is no `/api/config-backup/*` route to call — those routes only
exist in `core/server.js`, the desktop service), not a silent no-op and
not a crash. This is a deliberate, final decision, matching the existing
precedent in this exact Settings section rather than adding a new
PWA-hides-desktop-only-features pattern this codebase doesn't otherwise
have.

## Out of scope (this pass)

- PWA/iPad support (would need a client-side `SubtleCrypto` implementation
  with no existing pattern to build on — a separate, later scoping
  exercise if ever needed).
- Any password-recovery mechanism — this is a locally-held secret with no
  server-side storage of it anywhere; a forgotten password means the
  backup file is unrecoverable, by design (the confirm-password field on
  export is the mitigation).
- Rotating/keeping a history of config-import safety snapshots — one
  overwritten snapshot per import, not a series.
- Any change to the existing Dropbox settings-sync system
  (`core/sync.js`/`core/merge.js`) — this is a new, independent,
  file-based mechanism alongside it, not a replacement.

## Testing

- `core/config-backup.js` unit tests (plain `require()`, no HTTP):
  `buildConfigPayload` excludes `updateToken`/device-identity fields and
  includes everything else; `encryptConfigBackup`/`decryptConfigBackup`
  round-trip correctly; decrypting with the wrong password throws;
  decrypting a tampered ciphertext/authTag throws (GCM integrity); two
  exports of the identical payload produce different ciphertext/salt/iv
  (proving randomness isn't reused); `applyConfigPayload` preserves the
  CURRENT device's `updateToken` rather than taking one from the payload
  (there won't be one in the payload, but this guards against a
  hand-crafted file that includes one); `applyConfigPayload` writes the
  pre-import safety snapshot before mutating anything.
- `core/server.js` HTTP-integration tests (this project's established
  `createServer()` + real `fetch` pattern, per `tests/server-backup-int.test.js`):
  export → import round-trip over real HTTP produces the original `S`
  content (minus `updateToken`) on the "other" side; wrong password on
  import returns 400 and leaves the live store's `ia_settings` byte-for-
  byte unchanged (the core data-safety property); missing password on
  export returns 400, not 500.
- `web/index.html`/`pwa/index.html` UI-wiring tests (this project's
  `tests/_extract.js` `extractFn()` pattern): the export modal collects
  password+confirm and rejects a mismatch before ever calling the route;
  the import modal shows the replace-warning copy; the Blob/download
  construction happens with the right filename pattern and MIME type.
- Byte-identity check between `web/index.html` and `pwa/index.html` for
  every touched function, per this project's standing convention.
- This touches config/credential-handling code — the implementation must
  go through the **data-safety-reviewer** agent before merge, per this
  project's conventions.
