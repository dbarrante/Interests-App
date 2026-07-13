# Session Handoff — iPad PWA

Written at the end of the session that built Phases 1-4. Read this first; it's
oriented around "what does the next session need to know to keep going,"
`README.md` is the phase-by-phase technical log. Both are current as of commit
`927b54f` ("feat: iPad PWA — Dropbox sync, IndexedDB store, real UI (Phases 1-4)").

## Where things stand

**Phases 1-4 are done and verified against real production data**, not just test
fixtures: a full sync merged 5217 real cards/saved items from 2 live desktop
peers with 0 conflicts, images load through the service worker, saving from the
Imported tab persists correctly, and Stumble mode's AI-discovery + live-content
verification both work end-to-end (the latter via a Cloudflare Worker — see
below). `index.html` is the actual `web/index.html`, unmodified except for its
`<script>` tags, running against an IndexedDB + Dropbox-sync backend instead of
the desktop's local server.

**Not started:** Phase 5 (PWA manifest, full offline app-shell caching) and
Phase 6 (deploy to GitHub Pages). Deployment matters more than it might sound —
the local dev server can't be used from an iPhone/iPad at all (see below), so
until Phase 6 ships, this only runs on the same desktop machine's browser.

## The gap you'll hit immediately: no in-app Dropbox connection

**The real `index.html` has no UI to start the Dropbox OAuth flow.** Its
Settings panel has the sync toggle/device-label/sync-now button (all wired and
working), but those all assume a connection already exists. The OAuth
"Connect to Dropbox" flow only exists in the test harnesses (`dbx-test.html`,
`sync-test.html`). This session never hit this problem because testing
happened in a browser that had already connected via those harnesses, and
`Store.syncNow()` just reads the token straight out of that browser's
localStorage.

For a fresh browser or a real device, you'll need to either:
- Visit `dbx-test.html` or `sync-test.html` once to run the OAuth flow (tokens
  then persist in that browser's localStorage and `index.html` picks them up
  transparently), or
- Build a real "Connect to Dropbox" button into `index.html`'s Settings panel
  (this is the honest fix, and should probably happen before/during Phase 6 —
  a real user on a real iPhone won't know to visit a test harness page first).

## Environment reset checklist for a new session

- **Dev server**: `cd pwa && python -m http.server 8080` — it is NOT
  persistent; it died unexpectedly many times during the last session
  (background task got killed by the environment repeatedly, unrelated to any
  bug in the command itself) and needs restarting per session. Bind to
  `127.0.0.1` explicitly if you want to be strict about it, though the default
  already only listens on localhost.
- **Dropbox App key + Cloudflare Worker URL/token are per-browser
  localStorage** — they do not sync between Chrome/Edge/etc., and do not
  persist if a browser's site data gets cleared. Re-enter via
  `worker-config.html` (content-check Worker) and `dbx-test.html` (Dropbox) if
  starting fresh in a new browser profile.
- **IndexedDB version bumps require closing every other tab of the app** (or a
  full "Clear site data" from DevTools → Application → Storage) before they'll
  apply — see the postmortem below for why, and don't casually bump
  `idb.js`'s `DB_VERSION` again without also updating `sw.js`'s copy (they open
  the database independently and must stay in sync).
- **Redirect URI for OAuth must exactly match what's registered** in the
  Dropbox App Console (`http://localhost:8080/`, no path suffix) — test pages
  other than `index.html`/`dbx-test.html` default their redirect field to
  `location.origin + "/"` for this reason; don't "fix" that back to
  `location.href`.

## Postmortem: real bugs hit and fixed this session (read before touching sync code again)

1. **IndexedDB version-bump hangs with ZERO events firing** — not even
   `onblocked` — when a stale connection is held elsewhere. The service worker
   (`sw.js`) opens the same database independently of the page and had its own
   hardcoded `DB_VERSION` that went stale after a bump, which was the actual
   root cause the one time this got confusing (fixed a page-side "blocked tab"
   theory first; that wasn't it). Fix: `db.onversionchange = () => db.close()`
   on every successful connection, in *both* `idb.js` and `sw.js`, plus a 5s
   watchdog in `idb.js` that logs loudly instead of hanging silently.
2. **`dbxListFolder` didn't paginate** — Dropbox's `files/list_folder` caps
   entries per call; a real device had 5787 images in one folder, and the
   un-paginated version returned an empty list, indistinguishable from "this
   device has no images yet." This made every image-copy candidate defer as
   "missing" even though the images were right there on Dropbox. Fixed with a
   `files/list_folder/continue` loop until `has_more` is false.
3. **Concurrent workers thundering-herd on HTTP 429** — parallel image
   downloads/uploads trip Dropbox's rate limit against a library this size;
   independent per-call retries made it worse (all workers got rate-limited
   together and retried on the same schedule, colliding again). Fixed with a
   *shared* module-level cooldown (`rateLimitedUntil` in `oauth.js`) every
   call checks before firing, plus jitter on resume.
4. **Per-item IndexedDB transactions made a large sync look like a hang** —
   awaiting one transaction per item for 5000+ items is slow enough to be
   indistinguishable from stuck. Fixed by batching into one
   `putMany`/`deleteMany` transaction per store in `applyMergeToLocal`.
5. **`Store.delCard`/`delSaved` didn't write tombstones** — a local delete
   would have silently vanished and could have been resurrected by the next
   sync pulling in a peer's still-existing copy. Fixed to call
   `idb.addTombstone()`.
6. **Settings live under kv key `"ia_settings"`** (via `index.html`'s
   `save(k,v)` wrapper, which prefixes every key with `"ia_"`), not a bare
   `"settings"` key — an early test harness got this wrong; `sync-pwa.js` and
   `storage-pwa.js` use the correct prefixed key throughout. If you add new
   settings-adjacent code, use `idb.kvGet("ia_settings")`, not `"settings"`.
7. **Stumble mode's content-verification is a hard server-side dependency**,
   not an optional nice-to-have — stubbing `Store.checkContent` to `[]` made
   Stumble *always* report "couldn't find enough live ideas," because
   `isVerifiedDiscoveryResult()` in `lib/capture-state.js` drops any item it
   can't positively verify, and a browser can't read cross-origin response
   status/content itself (CORS). Fixed with `cf-worker/worker.js`, ported
   from `core/contentcheck.js`. `Store.checkLinks` (dead-link check for the
   Imported tab) has the same shape of dependency and is still stubbed —
   apply the same fix pattern if that turns out to matter.

## Recommended next steps, in order

1. Decide on the Dropbox-connection-UI gap above (probably: add a real
   "Connect to Dropbox" section to `index.html`'s Settings panel, reusing
   `oauth.js`'s `beginAuthorize`/`handleRedirectCallback`).
2. Phase 5: `manifest.webmanifest` + icons, extend `sw.js` beyond image
   proxying into full app-shell caching for offline/installability.
3. Phase 6: deploy `pwa/` to GitHub Pages. Before that ships:
   - Tighten `cf-worker/worker.js`'s `CORS_HEADERS` from `*` to the real
     GitHub Pages origin.
   - Add the GitHub Pages URL as a second registered redirect URI in the
     Dropbox App Console (alongside `http://localhost:8080/`).
   - Test Add to Home Screen on a real iPhone/iPad — this is the first point
     this project can actually be used on the device it was built for.
