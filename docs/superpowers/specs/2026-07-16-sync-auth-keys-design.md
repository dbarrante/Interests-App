# Sync reliability v2 — auth resilience, PWA auto-sync, API-key sync

## Problem

Diagnosed live 2026-07-16 against the real Dropbox sync folder
(`/Interests App/sync`) and `pwa/oauth.js` / `pwa/sync-pwa.js` as of
`35508db`:

1. **"Dropbox keeps disconnecting."** Two code paths destroy the
   long-lived refresh token when they should not:
   - `dbxError()` (`pwa/oauth.js`): *any* 401 during a sync cycle calls
     `disconnect()` immediately, wiping BOTH tokens — it never attempts the
     refresh token first. Dropbox access tokens live ~4 hours; the token is
     fetched once per cycle and held as a plain string through the whole
     cycle. If iOS suspends the PWA mid-sync (tap Sync, lock the iPad) and
     resumes hours later, every remaining call 401s and the connection is
     nuked even though the refresh token was perfectly valid.
   - `refreshAccessToken()`: *any* non-2xx from the token endpoint —
     including a transient 429 or 5xx — also calls `disconnect()` and
     reports `AUTH_EXPIRED`. Only a definitive rejection of the refresh
     token itself justifies that.
2. **"Settings don't sync to mobile."** The settings pipe itself works
   (verified live: the iPhone's `snapshot.json` carries the laptop's
   2026-07-15 13:11 settings edit — `interests`, `extraCats`, `weights`,
   `provider` all present). Two real gaps remain:
   - **The PWA has no automatic sync at all** — `Store.syncNow()` is only
     reachable from the manual "Sync now" button. Desktop merges/publishes
     on timers (`core/synctimers.js`); mobile silently does nothing unless
     the user remembers to tap, and stays stale forever when a tap fails.
   - **API keys never sync — currently by design.** `stripSecrets()`
     (`pwa/sync-pwa.js`) / `settingsForSync()` (`core/db.js`) delete
     `keys` + `oprKey` + `updateToken` before publish, and both apply
     paths force-preserve local values. Every device needs keys re-typed,
     which reads as "settings don't sync."

Evidence snapshot (live Dropbox, 2026-07-16): `My Laptop` published 07-15
23:59; `iPhone` 07-15 14:30; `iPad` stale since **07-12** (matches the
disconnect complaint); `RADONLAPTOP` stale since 07-07 (app not running —
not a code issue). Three orphaned `ipad-*` folders contain `images/` only
(abandoned first syncs from earlier device resets) — manual cleanup,
outside this spec's code scope.

## Decisions (user-approved 2026-07-16)

- **API keys sync in plaintext** inside the existing synced settings blob
  in the user's own Dropbox (`keys`, `oprKey`). `updateToken` (GitHub
  update credential, desktop-only) stays device-local.
- **PWA auto-sync: on open + periodic** — app open/foreground with a
  5-minute cooldown, plus a 15-minute interval while open.
- Disconnect (token wipe) happens **only on definitive auth failure**.

## Design

### A. `pwa/oauth.js` — auth resilience

All Dropbox calls already funnel through `dbxApiCall` / `dbxDownload` /
`dbxDownloadBinary` / `dbxUpload` (+ `getCurrentAccount`, currently a raw
`fetch`). The fix extends that choke point; call sites elsewhere keep
their exact signatures.

1. **Fresh token per call.** Each of the five functions resolves its
   token internally at call time instead of trusting the string the
   caller fetched at cycle start:
   - New internal `resolveToken(fallbackToken)`: when a stored app key +
     refresh token exist, return `getAccessToken(appKey)` (cached-token
     fast path — no network unless within 60 s of expiry); otherwise
     return `fallbackToken` if provided (keeps `restore-from-backup.js`,
     `dropbox-connect.js`, `storage-pwa.js` working unmodified); otherwise
     throw `AUTH_EXPIRED`.
   - The `accessToken` parameter stays in every signature as that
     fallback. No caller changes required.
2. **401 → refresh → retry once.** New internal
   `dbxAuthedFetch(fallbackToken, makeRequest)`:
   ```
   token = await resolveToken(fallbackToken)
   res = await makeRequest(token)          // fetchWithRetry inside
   if (res.status === 401 && canRefresh()) {
     token = await sharedRefresh()          // single-flight, see 3
     res = await makeRequest(token)         // exactly one retry
   }
   return res
   ```
   `canRefresh()` = stored app key + refresh token both present. If the
   retry still 401s, the existing `dbxError(401)` path runs (disconnect +
   `AUTH_EXPIRED`) — now correct, because a *fresh* token being rejected
   is definitive. If the refresh itself fails transiently, that OTHER
   error propagates and **tokens stay intact**.
3. **Single-flight refresh.** Module-level `_refreshPromise`: concurrent
   workers (4 image workers can all 401 at the same instant) share one
   refresh call instead of stampeding the token endpoint; cleared on
   settle (success or failure).
4. **`refreshAccessToken()` failure classification:**
   - No refresh token on file → `disconnect()` + `AUTH_EXPIRED`
     (definitive; unchanged).
   - Token endpoint returns **400 or 401** (Dropbox uses 400
     `invalid_grant` for a revoked/expired refresh token) →
     `disconnect()` + `AUTH_EXPIRED` (definitive; unchanged behavior for
     this case).
   - Token endpoint returns anything else (429, 5xx) or `fetch` itself
     throws (offline) → throw with `code: "OTHER"`, `.status` attached
     when available, **no `disconnect()`** — the next attempt retries
     with the same, still-valid refresh token.
5. `getCurrentAccount` moves onto `dbxAuthedFetch` so the Settings
   "Connected as …" check inherits the same refresh-retry instead of
   failing (and previously looking dead) on a stale access token.
6. `isConnected()` stays a pure presence check (unchanged semantics).

### B. `pwa/index.html` — auto-sync

New `autoSync(trigger)` plus wiring; manual `syncNowClick()` shares the
same in-flight guard.

- Constants: `AUTO_SYNC_COOLDOWN = 5 min`, `AUTO_SYNC_INTERVAL = 15 min`.
- Guard: module-level `_syncInFlight` promise. `autoSync` returns
  immediately if not `_booted`, a sync is in flight, sync is disabled or
  not connected (`Store.syncStatus()`), or the cooldown hasn't elapsed.
  `syncNowClick()` sets/clears the same `_syncInFlight` (manual taps are
  never blocked by the cooldown, only by an in-flight cycle).
- Triggers:
  - end of `bootData()` (after `_booted = true`) — fire-and-forget,
  - `visibilitychange` → visible,
  - `setInterval(..., AUTO_SYNC_INTERVAL)`.
- Outcomes (auto path):
  - `changed` → existing toast pattern: `"✨ Updates synced from your
    other devices — tap to refresh"`, click → `location.reload()`. Never
    force-reloads mid-use.
  - `AUTH_EXPIRED` → toast `"Dropbox connection expired — reconnect in
    Settings"` **once per disconnect** (module flag `_authToastShown`,
    reset by any subsequent successful sync), plus `renderSyncStatus()`.
  - other failures → `console.warn` only; the persisted "Last sync"
    line in Settings (already implemented) is the surface for these. No
    toast spam every 15 minutes on a flaky connection.
- Manual `syncNowClick()` behavior is unchanged (toasts + auto-reload on
  change) apart from the shared guard.
- `pollSyncChanged()` stays as-is (desktop-only mechanism; PWA
  `syncStatus()` has no `changedAt`, so it's a no-op there).

### C. API-key sync (desktop `core/` + PWA)

- **Publish side** — `core/db.js settingsForSync()` and
  `pwa/sync-pwa.js stripSecrets()`: stop deleting `keys` and `oprKey`;
  keep deleting `updateToken`.
- **Apply side** — replace blanket "preserve local keys" with a shared
  pure merge, `mergeSyncedSettings(localSettings, incomingData)`:
  - Start from `incoming` (it won LWW).
  - `keys`: per-provider union — `Object.assign({}, local.keys,
    pickNonEmpty(incoming.keys))`, where `pickNonEmpty` drops
    empty/whitespace/non-string values. A brand-new device that edits a
    preference before receiving keys publishes an empty `keys` and must
    not wipe the fleet's keys. Trade-off accepted: deleting a key on one
    device doesn't delete it elsewhere (safe direction).
  - `oprKey`: incoming non-empty string wins, else local preserved.
  - `updateToken`: always local (never travels; never overwritten).
  - Implemented once in `core/merge.js` (exported) and ported verbatim to
    `pwa/merge.js` (same dual browser/Node export pattern already used by
    `mergeSnapshots`), so both are unit-testable in plain Node.
  - `core/db.js applySyncedSettings()` and
    `pwa/sync-pwa.js applyMergeToLocal()` call it. The 256 KiB
    oversized-blob rejection in `applySyncedSettings` stays.
- **Back-compat:** older peers (≤ v1.12.21) publish snapshots without
  keys — union merge means nothing is lost. Older desktops receiving a
  new snapshot force-preserve their local keys (old behavior) — harmless.
- **Docs:** update the privacy claims in `CLAUDE.md` ("keys never sent
  anywhere except the chosen AI provider") and `README` to state that,
  when Dropbox sync is connected, provider keys are included in the
  synced settings inside the user's own Dropbox.

## Error handling

- A 401 anywhere now means: refresh once (shared), retry once; only a
  fresh-token 401 or a definitive refresh rejection clears tokens and
  surfaces `AUTH_EXPIRED`. Transient failures (network, 429, 5xx —
  including at the token endpoint) surface as retryable `OTHER` with
  tokens intact.
- Auto-sync never throws to the page: `Store.syncNow()` already always
  resolves and persists every outcome to `_pwa_last_sync_result`.

## Testing

Plain Node `assert` scripts per house convention; `node tests/run.js`
stays green throughout.

- **Update `tests/pwa-oauth-classify.test.js`** — `refreshAccessToken`
  assertions change: definitive paths (no refresh token; 400/401) still
  disconnect + tag `AUTH_EXPIRED`; new assertions that the transient path
  does NOT call `disconnect()` and tags `OTHER`.
- **New `tests/pwa-oauth-authretry.test.js`** — source-extraction (same
  `grab()` technique): `dbxAuthedFetch` exists and retries exactly once on
  401; single-flight `_refreshPromise`; all five call sites route through
  it; `resolveToken` fallback order.
- **New `tests/pwa-autosync-wiring.test.js`** — source-scan of
  `pwa/index.html`: `autoSync` exists; wired to boot, `visibilitychange`,
  and interval; in-flight guard shared with `syncNowClick`; cooldown
  constant; AUTH_EXPIRED once-per-transition flag.
- **Rewrite `tests/sync-settings.test.js`** — keys/oprKey now travel;
  `updateToken` never travels; union merge (peer key arrives, local-only
  key survives, empty incoming value doesn't clobber); end-to-end A→B
  publish/merge including keys.
- **New `tests/merge-settings.test.js`** (or added cases) —
  `mergeSyncedSettings` unit tests against BOTH `core/merge.js` and
  `pwa/merge.js` to keep the port in lockstep.
- Manual on-device verification after deploy: revoke app access in the
  Dropbox App Console → next auto-sync toasts reconnect exactly once;
  reconnect → keys + settings appear on iPad without re-typing.

## Deployment

- Bump `pwa/sw.js` `SHELL_CACHE` v20 → v21 (installed PWAs stay stale
  otherwise).
- PWA half auto-deploys via `deploy-pwa.yml` on push to `master`.
- Desktop half (core/db.js, core/merge.js) requires cutting **v1.12.22**
  and reinstalling on both laptops (installed Electron app does not
  follow git).

## Explicitly out of scope

- Encrypted key sync (user chose plaintext-in-own-Dropbox).
- Proactive connection health pings.
- Desktop auto-sync cadence changes (`core/synctimers.js` untouched).
- Deleting the three orphaned `ipad-*` Dropbox folders (manual cleanup,
  offered separately).
