# Interests App — iPad PWA

Companion web app for iPad (and any other browser), built as a Progressive Web App
rather than a native app, per `docs/iphone-sync-design.md`: the phone/tablet is
"just another Dropbox sync peer," not a client of the desktop's local server (which
is loopback-only and unreachable from another device). Zero cost: no Apple Developer
Program, no backend server — Dropbox is the entire sync transport, and the PWA will
eventually be hosted free on GitHub Pages.

## Phase 1 (done): prove the transport

`index.html` + `oauth.js` are a minimal, read-only harness that:
1. Runs Dropbox's OAuth2 PKCE flow (no client secret — safe for a static site)
2. Lists the existing `/Interests App/sync/<deviceId>/` folders your desktop app(s) already publish
3. Downloads each device's `meta.json` + `snapshot.json` and validates the same
   torn-write completion-marker check the desktop uses (`core/sync.js`'s
   `readSnapshot()`) — counts in `meta.json` must match the actual array lengths
   in `snapshot.json`, or the folder is still mid-sync and gets flagged.

Verified working against a real Dropbox account and real desktop sync folders.
Nothing was written to Dropbox in this phase — read-only by design.

## Phase 2 (done): local store, images, and AI generation

`idb.js` + `storage-pwa.js` + `sw.js` + `ai.js` (a verbatim copy of `web/ai.js`):
1. `storage-pwa.js` implements the same `Store` interface as `web/storage.js`,
   backed by IndexedDB instead of `fetch()`-to-`localhost:3456`. Core data (`kv`,
   `cards`, `saved`, images, fingerprints) is fully real; sync methods are stubbed
   pending Phase 3; desktop-only features (import, capture bridge, bookmarks,
   link/content/safety checks, News feed) are permanently stubbed to resolve
   gracefully — out of scope for the iPad app by product decision.
2. **Key finding:** `Store.imgUrl(id)` is called synchronously everywhere in
   `index.html`, but IndexedDB reads are async. Solved with `sw.js`, a service
   worker that intercepts `/idb-img/<id>` requests and serves the blob straight out
   of IndexedDB — `imgUrl()` stays a synchronous URL-string builder, matching the
   desktop's `/api/img/<id>` contract exactly, no changes needed to `index.html`.
3. **Key finding:** `web/ai.js` turned out to already be pure browser code with zero
   Electron/Node dependencies — every provider call is a plain `fetch()`, including
   Anthropic's via the documented `anthropic-dangerous-direct-browser-access`
   header. It ported into the PWA completely unmodified.

Verified end-to-end via `store-test.html`: kv/card/image roundtrips through
IndexedDB, image load through the service worker proxy, and a live AI call via
OpenRouter — all passing.

## Phase 3 (done): real Dropbox sync

`merge.js` (verbatim copy of `core/merge.js`) + `sync-pwa.js` (the orchestrator,
wiring `oauth.js`'s transport and `idb.js`'s local store together) + `sync-test.html`.

Verified against real production data: a full sync pulled in **5217 real cards/saved
items from 2 live desktop peers, 0 conflicts**, and published the iPad's own snapshot
back cleanly. A second sync immediately after confirmed the incremental case is fast
(nothing new to transfer, since both sides already match).

Three real bugs surfaced and fixed during this phase, all worth knowing about if this
code is touched again:

1. **IndexedDB version-bump hangs.** Bumping `idb.js`'s `DB_VERSION` (needed for the
   tombstones schema fix) can hang `indexedDB.open()` forever with *zero* events
   firing — not even `onblocked` — if a stale connection is held elsewhere (another
   tab, or a service worker that opened the DB at an older version and never noticed
   the bump). Fixed with `db.onversionchange = () => db.close()` on every successful
   connection (both `idb.js` and `sw.js` need this — they open the DB independently)
   plus a 5s watchdog that logs loudly instead of hanging silently.
2. **`dbxListFolder` didn't paginate.** Dropbox's `files/list_folder` caps entries per
   call; a real device's `images/` folder had **5787 files**, and the un-paginated
   version silently returned an empty list for it (looked identical to "device has no
   images yet"). This made every image-copy candidate get skipped as "missing" even
   though the images were right there. Fixed by looping `files/list_folder/continue`
   until `has_more` is false.
3. **Concurrent workers thundering-herd on HTTP 429.** Downloading/uploading images
   with several workers in parallel trips Dropbox's rate limit fast against a ~5000-
   image library. An independent per-call retry loop made it worse: all workers got
   rate-limited at roughly the same moment and retried on roughly the same schedule,
   colliding again and again. Fixed with a **shared** module-level cooldown in
   `oauth.js` (`rateLimitedUntil`) that every call checks before firing — one 429
   pauses the whole pool, with jitter on the resume so they don't immediately
   resynchronize and trip it again.

Also fixed along the way: `applyMergeToLocal` originally awaited one IndexedDB
transaction per item, which made a large first sync (thousands of items) look
identical to a hang — batched into one `putMany`/`deleteMany` transaction per store
instead. `Store.delCard`/`delSaved` now correctly write a tombstone (they didn't
before Phase 3 — a local delete would have silently vanished and could have been
resurrected by the next sync pulling in a peer's still-existing copy).

## One-time setup: create a Dropbox API app

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**.
2. Choose **Scoped access**.
3. Choose **Full Dropbox** access (not "App folder") — the desktop app writes to
   `/Interests App/sync/...` in your real Dropbox root, which an App-folder-scoped
   app cannot see.
4. Give it any unique name (e.g. `interests-app-pwa-<yourname>`).
5. On the app's **Permissions** tab, enable:
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write` (not used yet, but Phase 2 will need it — avoids re-consenting later)
   - `account_info.read`
   Click **Submit** to save permissions.
6. On the **Settings** tab:
   - Copy the **App key** (this is the OAuth client ID — not secret, safe to put in a static page).
   - Under **OAuth 2 → Redirect URIs**, add `http://localhost:8080/` (matches the
     local dev server below). Add your GitHub Pages URL here too once Phase 2+ deploys it.

## Running Phase 1 locally

PKCE requires the Web Crypto API, which browsers only expose in a "secure context"
(`https://` or `localhost`) — opening `index.html` directly via `file://` won't work.
Serve it locally instead:

```bash
cd pwa
python -m http.server 8080
# or: npx serve -l 8080
```

Then open `http://localhost:8080/` in a browser:

1. Paste your **App key** and confirm the **Redirect URI** matches what you registered.
2. Click **Save config**.
3. Click **Connect to Dropbox** and authorize.
4. Once it shows "Connected as `<your email>`", click **List Sync Devices**.

You should see a row per desktop install that has ever synced, each with its label,
last-published timestamp, and card/saved/tombstone counts — pulled live over the
Dropbox HTTP API, not from any local file. A green "valid" means the torn-write
guard passed; a red mismatch means that device's folder is mid-write (rare, but the
whole point of the check).

## Phase 4 (done): the real app, running for real

`index.html` is now a full copy of `web/index.html` (all of `web/`'s other files —
`route-capture.js`, `lib/*.js`, `restore-legacy.js`, `deadcheck-ai.js`,
`profile-analyze.js`, `import-*.js`, `jszip.min.js` — copied in unchanged), with
only its `<script>` tags at the top edited to load the PWA stack (`idb.js`,
`oauth.js`, `merge.js`, `sync-pwa.js`, `storage-pwa.js`, `ai.js`) instead of
`storage.js`. The four `window.ia.*` call sites needed **zero changes** — already
feature-detected everywhere, exactly as predicted. The old Phase 1 harness moved to
`dbx-test.html` so it didn't collide with the real `index.html`.

Verified against your real library: cards render, images load, saving from the
Imported tab persists correctly, and the Settings panel's existing sync UI (built
for desktop) works against `storage-pwa.js` with no changes at all.

**One real gap found and fixed:** Stumble mode's safety check
(`isVerifiedDiscoveryResult` in `lib/capture-state.js`) requires server-side
fetching to verify an AI-suggested URL is actually live — a browser can't do this
itself (CORS blocks reading cross-origin response details from almost any site).
Stubbing `Store.checkContent` to `[]` made this check fail-closed for every single
candidate, so Stumble always reported "couldn't find enough live ideas." Fixed with
`cf-worker/worker.js`, a small Cloudflare Worker (free tier) that ports
`core/contentcheck.js`'s exact classification logic (same dead-phrase/bot-challenge
lists, same `{verdict, status, signals, title}` shape) and runs the fetch
server-side. Configured per-browser via `worker-config.html` (localStorage-based,
same pattern as the Dropbox App key) — remember this means Chrome and Edge (or any
two browsers) need the Worker URL/token entered separately; it doesn't carry over.
`Store.checkLinks` (a separate dead-link-checker for the Imported tab) is still
stubbed to `[]` — same fix pattern would apply if that turns out to matter too.

## What's next (not built yet)

- Phase 5: done — see `pwa/HANDOFF.md`.
- Phase 6: done in code — GitHub Actions deploys `pwa/` to GitHub Pages on every
  push to `master` (`.github/workflows/deploy-pwa.yml`), three origin-root-path
  assumptions were fixed to work under the Pages subpath, and the Cloudflare
  content-check Worker's CORS is now an allow-list (`localhost:8080` +
  `https://dbarrante.github.io`). **Three things remain manual, outside what an
  agent can do:** redeploy the updated `pwa/cf-worker/worker.js` to your actual
  Cloudflare account; add `https://dbarrante.github.io/Interests-App/` as a
  second registered redirect URI in the Dropbox App Console (alongside
  `http://localhost:8080/`); and verify Add to Home Screen on a real
  iPhone/iPad — the first point this project can actually be used on the
  device it was built for.
