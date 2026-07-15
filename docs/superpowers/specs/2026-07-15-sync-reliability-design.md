# PWA sync reliability — design

## Problem

Diagnosed live this session: the iPad PWA's "Sync now" reported "already up
to date" for two days straight while the underlying Dropbox connection was
actually dead — no data ever left the device. Root cause traced to three
places in `pwa/oauth.js` / `pwa/sync-pwa.js` that each independently trust
local state instead of surfacing what actually happened:

- `isConnected()` (`oauth.js`) only checks whether an access token string
  exists in `localStorage` — never whether it's still valid. A
  server-revoked token still reads as "Connected as `<email>`".
- `getAccessToken()` (`oauth.js`) returns the locally-cached token without
  validating it against Dropbox whenever the locally-stored `expiresAt`
  hasn't passed yet — a token revoked server-side (e.g. re-authorized
  elsewhere, manually revoked in the Dropbox App Console) still looks fine
  locally.
- `readPeers()` (`sync-pwa.js`) catches *any* failure from
  `Dbx.dbxListFolder`/`Dbx.readFullPeerSnapshot` — including a 401 from a
  dead token — and silently returns an empty peer list, identical in shape
  to "no peers have ever synced." `runSyncCycle()` then reports
  `{ok:true, changed:false, peersRead:0}`, which the UI renders as "Synced —
  already up to date."

None of Dropbox's own call sites currently attach the HTTP status code to
thrown errors, so no caller can distinguish "auth is dead, reconnect" from
"transient network blip" from "rate limited" (429 already has its own
handling in `fetchWithRetry`).

A temporary diagnostic build shipped this session (`alert()` popups showing
the raw sync result, plus `peerErrors`/`deviceIdsFound` fields) to prove this
out on-device without Safari devtools access. This plan replaces that
temporary instrumentation with the permanent fix and removes it.

## Scope

Fix the three silent-failure points above and make sync failures visible in
the UI. Explicitly **not** in scope: proactive/periodic connection health
checks (e.g. pinging Dropbox on app open) — failures surface reactively, the
next time a sync is attempted.

## Architecture

Every Dropbox network call already funnels through one shared layer in
`pwa/oauth.js` — `fetchWithRetry()` → `dbxApiCall()`/`dbxDownload()`/
`dbxDownloadBinary()`/`dbxUpload()` — which is also where the existing
429 rate-limit-cooldown fix lives (`rateLimitedUntil`, shared across
concurrent workers). This design extends that same choke point rather than
adding error handling at each of the ~6 call sites individually, so any
future Dropbox call site inherits correct 401 handling for free.

## Components

**`pwa/oauth.js`**

- A new pure function, `classifyDbxError(status)`, returns
  `{code: "AUTH_EXPIRED", message: "..."}` for `status === 401`, or
  `{code: "OTHER", message: null}` otherwise. Exported via the same dual
  browser/Node pattern `pwa/merge.js` already uses (`module.exports` when
  present, `root.classifyDbxError` otherwise) — this is what makes it
  unit-testable without a fetch/DOM shim.
- `fetchWithRetry`'s non-2xx, non-429, non-5xx early return (existing line:
  `if (res.status !== 429 && res.status < 500) return res;`) is unchanged —
  callers still get the `Response` back for that case. What changes is each
  caller (`dbxApiCall`, `dbxDownload`, `dbxDownloadBinary`, `dbxUpload`):
  before throwing, call `classifyDbxError(res.status)`; if `code ===
  "AUTH_EXPIRED"`, call `disconnect()` (already exists, clears all stored
  Dropbox tokens) and throw an `Error` with `.code = "AUTH_EXPIRED"` set;
  otherwise throw as today but with `.status = res.status` attached.
- `isConnected()` is unchanged (still a presence check) — it's *correct* as
  a presence check; the fix is that `disconnect()` now actually gets called
  when the token dies, so presence becomes accurate again instead of stale.

**`pwa/sync-pwa.js`**

- `readPeers()`: remove the silent catch-and-return-empty around
  `dbxListFolder`. In that catch block, check `e.code === "AUTH_EXPIRED"`
  first — propagate it unchanged. Otherwise, check
  `/path\/not_found/.test(e.message)` — the same string-match already
  established in `listDeviceImageIds` (`oauth.js`) for "nobody has ever
  synced, the folder doesn't exist yet," a legitimate non-error state — and
  keep that one case as a soft empty-peers return. Any other error (not
  auth, not path/not_found — network failure, a genuine bug) now propagates
  instead of being silently swallowed, which is the actual fix: today ALL
  three cases return identically empty. Per-peer read failures inside the
  loop still `continue` past that
  one peer (unrelated peers shouldn't block the whole cycle) but now push a
  descriptive entry onto a `partialFailures` array returned alongside
  `peers` — this is the permanent replacement for this session's temporary
  `errors`/`deviceIdsFound` diagnostic fields, not an addition on top of
  them.
- `runSyncCycle()`: wraps the peer-read phase in try/catch. On a caught
  error with `.code === "AUTH_EXPIRED"`, returns
  `{ok:false, code:"AUTH_EXPIRED", reason:"..."}` immediately (sync cannot
  proceed without a live connection). Any other caught error returns
  `{ok:false, code:"OTHER", reason:"<message>"}`. `partialFailures` (peers
  that individually failed to read but didn't kill the whole cycle) is
  included in the success-path return too, so a partial degradation is
  still visible even when the overall cycle nominally succeeds.

**`pwa/index.html`**

- `syncNowClick()`: branches on the returned `code`:
  - `AUTH_EXPIRED` → toast "Dropbox connection expired — reconnect in
    Settings", and re-renders the sync status panel (below) so it flips to
    "Not connected" immediately rather than waiting for the user to
    navigate to Settings.
  - `OTHER` → toast "Sync failed: `<reason>`" (this is Finding #3's fix,
    already landed — this plan keeps it, just removes the temporary
    `alert()` calls that currently sit alongside it).
  - success → existing "Synced — new items merged in" /
    "already up to date" toasts, unchanged.
- Settings sync-status panel (`renderSyncStatus()`, `#syncStatus`): add a
  persisted "Last sync" line — `succeeded <time>` / `failed: <reason>
  <time>`. Written to `idb.kvSet("_pwa_last_sync_result", {...})` at the end
  of every `syncNowClick()` call (success or failure), read back in
  `renderSyncStatus()` so it's visible any time Settings is opened, not only
  right after tapping Sync.
- Remove: the temporary `alert("Sync result:\n"...)`,
  `alert("Sync threw:\n"...)`, and the `peerErrors`/`deviceIdsFound` fields
  from `runSyncCycle`'s return (superseded by `partialFailures` above).

## Data flow

```
syncNowClick()
  -> Store.syncNow()
    -> Dbx.getAccessToken(appKey)         // unchanged: local expiry check only
    -> IASync.runSyncCycle(token, ...)
      -> readPeers(token, deviceId)
        -> Dbx.dbxListFolder(...)          // throws {code:"AUTH_EXPIRED"} on 401
        -> per-peer: Dbx.readFullPeerSnapshot(...)  // failure -> partialFailures[], continue
      -> (peers.length ? merge+apply : skip)
      -> publishSnapshot(...)              // same classifyDbxError path on any call
      -> return {ok, code, reason, changed, partialFailures, ...}
  -> branch on code -> toast + persist "last sync result" to kv
```

## Error handling

A 401 anywhere in a sync cycle — peer listing, snapshot/meta download, image
download, image upload, snapshot/meta upload — surfaces identically as
"reconnect to Dropbox," because they all pass through the same
`classifyDbxError` call in `oauth.js`. Non-auth errors (network failure,
429 exhausted after retries, a malformed peer snapshot) surface as a
generic retryable failure with the underlying message, without forcing a
reconnect for what might just be a bad moment.

## Explicitly out of scope

- Proactive/periodic health checks (see Scope).
- Any change to the 429 rate-limit retry logic — untouched, already correct.
- Any change to `isConnected()`'s presence-check semantics.
- Desktop (`core/sync.js`) — this is a Dropbox-OAuth-specific concern that
  only exists for the PWA; the desktop app talks to the local filesystem
  directly and has no token to expire.

## Testing

- New `tests/pwa-oauth-classify.test.js` (plain Node, no shim needed):
  unit tests for `classifyDbxError()` against 401, 400, 404, 429, 500 —
  confirms 401 is the only status classified `AUTH_EXPIRED`.
- Manual verification (matching this codebase's established convention for
  `pwa/index.html`-adjacent UI work — see
  `docs/superpowers/specs/2026-07-13-dropbox-connect-ui-design.md`): revoke
  the app's Dropbox access from the Dropbox App Console, tap Sync now,
  confirm the "reconnect" toast appears and Settings flips to "Not
  connected"; then reconnect and confirm a normal sync still works and the
  "Last sync: succeeded" line appears in Settings.
- `node tests/run.js` must stay clean throughout.
