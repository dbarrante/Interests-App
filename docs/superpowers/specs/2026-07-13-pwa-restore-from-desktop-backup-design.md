# Restore a new PWA install from the desktop's Dropbox backup — design

## Problem

A brand-new device pairing today only has one path to get data: the live
peer-to-peer Dropbox sync (`pwa/sync-pwa.js`'s `runSyncCycle`). For a real
production-scale library (thousands of cards/images), this is legitimately
very slow on a first pairing — it downloads+merges peer data, then
immediately re-uploads the device's *entire* image library back to its own
Dropbox publish folder before the "Sync now" button's promise ever resolves,
with zero progress feedback shown in the UI. A user watching the app on a
real iPhone reasonably concludes it's broken rather than just slow.

This design adds a second, faster path: restore directly from the desktop
app's regular, already-automatic Dropbox backups
(`<dropbox>/Interests App/backups/interests-backup-YYYY-MM-DD/`), which
requires only a one-way download — no re-publish step — and can also carry
over API keys and PWA-specific config so a new install needs no manual
setup at all, per explicit user request.

## Starting state

- The desktop's `core/backup.js` (`runBackup()`) already writes
  `interests.db` (raw SQLite) + `images/` + `meta.json` into
  `<dropbox>/Interests App/backups/interests-backup-YYYY-MM-DD/` on every
  backup, automatically. The PWA has no SQL engine to read `interests.db`
  client-side.
- The PWA's existing restore UI (`Store.restore`/`listBackups`, "Restore
  latest backup") is stubbed out entirely for the PWA build
  (`storage-pwa.js`: `listBackups` always resolves `[]`).
- A separate, working import path already exists: `applyRestore`/
  `doRestoreCore` (shared in `index.html`'s inline script) imports a
  single-file legacy JSON format (`{keys, _exported, _counts, images}`) via
  `Store.putCards`/`putSaved`/`kvSet`/`imgPut` — all of which **are**
  implemented on the PWA build. The current desktop app has no feature that
  produces this legacy format anymore (it's import-only, for files from an
  old, pre-SQLite app version).
- `core/db.js`'s `settingsForSync()` deliberately strips `keys` (AI provider
  API keys), `oprKey` (Open PageRank key), and `updateToken` (GitHub update
  token) before anything leaves the device via the existing peer-sync path —
  documented as "never sync." This design intentionally does NOT reuse that
  function for the new backup snapshot; see "Security" below.
- The Dropbox App key (`pwa/oauth.js`'s `LS_KEYS.appKey`, localStorage key
  `ia_pwa_app_key`) and the Cloudflare content-check Worker's URL/token
  (`storage-pwa.js`, localStorage keys `ia_pwa_contentcheck_url` /
  `ia_pwa_contentcheck_token`) are PWA-only concepts — the desktop app has
  neither (it syncs via the local Dropbox client, not OAuth, and runs
  content-checks directly in Node via `core/contentcheck.js`, no Worker
  needed). The desktop's new snapshot can never carry these; only an
  already-configured PWA can.

## Architecture

**1. `core/backup.js`'s `runBackup()`** gets one more file written per
backup, alongside the existing `interests.db`/`images/`/`meta.json`:

`snapshot.json` — cards, saved, tombstones, and settings, serialized the
same way `serializeLibrary(db)` already does for peer-sync, **except**
settings are NOT run through `settingsForSync`'s stripping — the raw
`ia_settings` blob (including `keys`, `oprKey`) is included as-is, per
explicit user choice (see Security). This is a pure addition; nothing about
the existing `interests.db`/`images/`/`meta.json` backup changes, so
existing desktop restore-from-backup continues to work unmodified.

**2. `pwa/dropbox-connect.js`** publishes this PWA's own bootstrap config
immediately after a successful connect: uploads
`/Interests App/pwa-config.json` = `{ appKey, contentcheckUrl,
contentcheckToken }`, overwriting on every successful (re)connect so it
stays current. Deliberately excludes the redirect URI — that must always be
derived from whichever device is loading the page (`new URL(".",
location.href).href`), never copied from another device's URL, since two
installs could be served from different origins (localhost vs. GitHub
Pages).

**3. New "Restore from Dropbox backup" control in the PWA's Settings
panel**, injected at runtime (same pattern as `pwa/dropbox-connect.js` and
`pwa/pwa-install.js` — no `index.html` HTML edits). On click:
- Lists `/Interests App/backups/` via the already-connected `Dbx.dbxListFolder`,
  picks the newest `interests-backup-YYYY-MM-DD` folder by date string.
- Downloads that folder's `snapshot.json`, confirms with the user (reusing
  `doRestoreCore`'s existing confirm-dialog + safety-backup-first pattern),
  then writes cards/saved/settings via the same `Store.putCards`/`putSaved`/
  `kvSet` calls `doRestoreCore` already uses successfully today.
- Downloads images from that backup's `images/` folder using the same
  bounded-concurrency pattern (4 concurrent workers, `onProgress` callback)
  already proven in `sync-pwa.js`'s `applyMergeToLocal` — reusing the
  pattern, not the peer-sync code path itself.
- Also attempts to download `/Interests App/pwa-config.json`; if present
  AND this device doesn't already have its own Dropbox App key configured,
  auto-fills the App key + Worker URL/token so a second/future PWA install
  needs zero manual entry for those either. Never overwrites an already-set,
  deliberately-different local config.

Critically, this path **never re-publishes anything** — it's a strict
one-way pull from an existing backup, which is what makes it meaningfully
faster than the live peer-sync path for a first-time device setup (that
path's slowness comes specifically from the mandatory "re-upload your whole
library to become a peer" step this path skips entirely). The device can
still run a normal "Sync now" later, in the background, to become a real
sync peer going forward — by then the user already has their data, so that
one-time cost no longer blocks anything user-visible.

## Data flow

Desktop backup runs (automatic or manual, unchanged trigger) → writes
`snapshot.json` alongside the existing backup files, no behavior change to
existing consumers. PWA connects to Dropbox → publishes `pwa-config.json`.
New PWA install → user taps "Restore from Dropbox backup" → reads
`snapshot.json` (small, text-only) → writes cards/saved/settings/keys
immediately → downloads images in the background with visible progress →
optionally auto-fills App key/Worker config from `pwa-config.json`.

## Security

Explicit, informed tradeoff (confirmed with the user): `snapshot.json` will
contain live AI provider API keys (Anthropic/OpenAI/Gemini/Groq/OpenRouter/
local endpoint) and the Open PageRank key — the same fields
`settingsForSync()` has deliberately stripped from every other synced
artifact in this codebase to date. `pwa-config.json`'s Worker token is a
real bearer secret (it's what stops a stranger from calling the user's
Cloudflare Worker for free). Both now live in the user's own Dropbox
alongside their card library — the same account trust boundary already
extended to their personal data, but a real step up in sensitivity: a
compromised or accidentally-shared Dropbox folder now also leaks billable
API keys and the Worker's access token, not just reading-list content.
Nothing about *how* these secrets are transmitted changes (still direct
HTTPS to each provider; this app has no server of its own to leak through).
The Settings UI should say this plainly once, so it isn't a silent surprise
later — not gate the feature, since it was explicitly requested.

## Error handling

- No backup folder / no `snapshot.json` found → a clear message ("No
  desktop backup found in Dropbox yet — back up from the desktop app
  first"), not a silent no-op.
- No `pwa-config.json` found → restore proceeds for library/settings only;
  App key/Worker config are simply left for manual entry, exactly like
  today's first-ever PWA setup.
- Reuses `doRestoreCore`'s existing pattern: confirm dialog stating this
  replaces everything currently in the app, a safety backup taken first,
  and a partial-failure toast that's explicit about what did and didn't
  land (mirrors the existing legacy-import UX rather than inventing new
  error handling).

## Explicitly out of scope

- Encrypting `snapshot.json`/`pwa-config.json` — not requested; the user's
  explicit choice was to prioritize zero-setup over reducing this specific
  exposure.
- Any change to the existing `interests.db`/`images/`/`meta.json` backup
  format or the desktop's own restore-from-backup flow.
- Any change to the live peer-sync path (`sync-pwa.js`'s `runSyncCycle`) —
  restore-from-backup is an additional, independent path, not a replacement.
- Reading `interests.db` directly (the rejected SQLite-in-browser
  alternative).

## Testing

Manual only, matching every other phase of this project (no automated test
harness for `pwa/*.js` browser code, and `core/backup.js` already has
`tests/backup.test.js` coverage for its existing behavior that must keep
passing unmodified). Concretely: run a desktop backup, confirm
`snapshot.json` appears alongside the existing files with the right shape;
from a fresh/incognito PWA profile, use "Restore from Dropbox backup,"
confirm cards/saved/settings/keys populate and images download with visible
progress; confirm a second fresh PWA install auto-fills App key/Worker
config from `pwa-config.json` if the first PWA already published it.
