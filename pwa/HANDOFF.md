# Session Handoff — iPad PWA

**Latest update: 2026-07-14 — read this section first. Everything below it
(starting at "Where things stand") is the original Phases 1-4 handoff, kept
for its postmortem detail but otherwise historical/superseded.**

## Pick up here tomorrow

Phases 1-6 are complete and live: `https://dbarrante.github.io/Interests-App/`,
installed and verified via Add to Home Screen on a real iPhone. On top of
that, a **restore-from-desktop-backup** feature shipped this session (desktop
v1.12.20): the desktop's automatic backups now also write a portable
`snapshot.json`, and the PWA has a "Restore from Dropbox backup…" button
(Settings → Dropbox sync section) that pulls it directly — much faster than
the live peer-sync path for a first-time device pairing, and brings AI
provider keys along so a new install needs no manual key entry. Full detail:
`docs/superpowers/specs/2026-07-13-pwa-restore-from-desktop-backup-design.md`
and the matching plan under `docs/superpowers/plans/`. Commits `0733a81`
through `4f735c7` on `master`.

1. **Confirm the first real end-to-end restore result.** The user had just
   installed desktop v1.12.20, taken a fresh backup, and started a restore on
   the iPhone when the last session ended — the outcome was never confirmed.
   Ask directly: did the restore complete, do cards/saved/images show up, are
   the AI provider keys populated without manual entry?
2. **If it worked:** the feature is done. Loose ends, all low-priority:
   - `pwa/cf-worker/worker.js`'s CORS allow-list change still needs a manual
     redeploy to the user's Cloudflare account (status not reconfirmed since
     Phase 6 — the live Worker just keeps its old wildcard CORS meanwhile,
     harmless).
   - The cross-device Worker-config adoption via `pwa-config.json` (Task 2 of
     the restore-from-backup plan) was never manually verified end-to-end
     with a *second* device — worth confirming if that scenario matters soon.
3. **If it didn't work**, read these two gotchas *before* re-diagnosing from
   scratch — both were hit and fixed this session, and either could recur:
   - **PWA shell-cache bump discipline.** Any edit to `pwa/index.html` or an
     already-shipped `pwa/*.js` file needs `pwa/sw.js`'s `SHELL_CACHE` bumped,
     or already-installed PWAs (especially iOS home-screen installs) keep
     serving old code forever with no visible error — just a missing
     feature. Check whether the current `SHELL_CACHE` value was actually
     bumped for whatever changed most recently.
   - **The desktop app does not auto-update from `git pull`.** It's a
     separately built/installed Electron app. A code change only reaches the
     user after a `package.json` version bump is pushed to `master`
     (triggers `release.yml`'s installer build) *and* the user installs the
     new build. Check `package.json`'s version against what's actually
     installed before assuming a merged fix is live for the user.

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

## Phase 6 (done in code, not yet verified live)

GitHub Actions (`.github/workflows/deploy-pwa.yml`) deploys `pwa/` to GitHub
Pages on every push to `master` touching `pwa/**`, plus manual dispatch. The
default project-site URL for this repo is a subpath —
`https://dbarrante.github.io/Interests-App/`, not the origin root — which
would have broken three hardcoded-root-path assumptions (service worker
registration, `Store.imgUrl()`, the OAuth `redirectUri()`); all three are now
relative/scope-derived instead. The Cloudflare content-check Worker's CORS is
now an allow-list (`localhost:8080` + the Pages origin) instead of a
wildcard, so local dev testing keeps working alongside the deployed site.

**Three things still require a human, outside what an agent can do:**
1. Redeploy the updated `pwa/cf-worker/worker.js` to your Cloudflare account.
2. Add `https://dbarrante.github.io/Interests-App/` as a second registered
   OAuth redirect URI in the Dropbox App Console (keep
   `http://localhost:8080/` too, for continued local dev).
3. Verify Add to Home Screen on a real iPhone/iPad, confirm the icon renders,
   an offline reload works, and a full sync round-trip succeeds against a
   live desktop install.

## Recommended next steps

Superseded — see "Pick up here tomorrow" at the top of this file for the
current state and what to do next.
