# Session handoff — 2026-07-15, Instagram image reliability + release cut

Written by a concurrent Claude Code session so the other session working on
this repo right now can diff its own design/plan against what actually
shipped here, rather than assuming either session's view of `master` is
current. **Repo state as of this file: `master` at `ced6884`, pushed to
`origin/master`, in sync (no divergence). Released to desktop as v1.12.21
(GitHub Actions build succeeded, installer + `latest.yml` attached).**

## What this session actually did, in order

1. **Root-caused "no longer seeing pictures for Instagram cards."**
   `extension/background.js`'s `captureTab()` (the generic, non-Facebook
   capture path Instagram falls through to) shipped a page's `og:image`
   straight to the app as a **raw URL**, never converting it to a durable
   `data:`/`idb:`-cached image the way the Facebook-specific paths already
   do (`captureFbPost`/`captureFbByOg`/`clipCurrentPage`'s existing guard).
   Facebook/Instagram CDN URLs (`scontent.cdninstagram.com`,
   `*.fbcdn.net`) carry a signed, short-lived `oe` expiry param — the raw
   URL looks fine for ~10 days, then the signature times out and the image
   silently dies with zero record anywhere that the card needs a retry,
   because `isBadImg()` (`web/lib/capture-state.js`) didn't recognize a
   normal-looking `https://` URL as bad.
   - Fix: `extension/background.js` now converts a
     `scontent`/`cdninstagram`/`fbcdn` URL to a durable `data:` image
     before delivery (`durableImage()`/`isExpiringCdnImage()`, mirrors the
     existing FB guard pattern), falling back to the raw URL only if that
     fetch itself fails. `isBadImg()` in `web/lib/capture-state.js` +
     `pwa/lib/capture-state.js` now also flags an unconverted
     signed-CDN URL as bad, so anything that still slips through re-enters
     the existing retry/"Failed captures" tooling instead of dying
     silently forever.
   - Commit: `f0d911a`. Tests: `tests/durable-cdn-image.test.js` (new),
     4 new cases in `tests/capture-state.test.js`.
   - **Live data repair** (not a code change): queued the app's own
     `recaptureViaWorker()` (the existing "☑ Select → Recapture"
     mechanism) against the 51 already-broken cards found live (all one
     2026-07-04 import batch, id prefix `c_mqyfkl7c_`). Result: **48/51
     healed**, 3 (`iz8j1c`, `d99utw`, `a4sg0l`) still fail after a retry —
     most likely genuinely-gone content (deleted/private/region-locked),
     not a code bug; left as-is, not investigated further.

2. **Found and fixed a second, unrelated image bug while re-scanning:**
   Instagram serves a visually-identical "Sorry, we're having trouble
   displaying this video" error page for reels it currently won't play.
   `captureTab` still takes a **real** screenshot of that error page — a
   genuine `data:` image, not a raw hotlink — so neither `isBadImg` nor
   `imgFp` (exact-string placeholder match) catch it; it looks like a
   normal successful capture. Found live: 14 of 609 cached Instagram Reel
   screenshots were this exact error page (perceptual dHash cluster at
   Hamming distance 0–8 from two known instances; next-closest unrelated
   image was at distance 12; the bulk of real screenshots sit around
   distance ~27/64 — a clean, well-separated gap).
   - Fix: `dHashFromDataUrl()`/`isKnownJunkScreenshot()` in
     `web/index.html` + `pwa/index.html`, wired into `drainCaptures` next
     to the existing `_phFps` placeholder-rejection check.
     `hammingDist()` lives in `web/lib/capture-state.js` +
     `pwa/lib/capture-state.js` (Node-testable; the dHash extraction
     itself needs `OffscreenCanvas`, so it's browser-only).
   - Commit: `16a04ca`. Tests: `tests/junk-screenshot-detection.test.js`
     (new), 4 new cases in `tests/capture-state.test.js`. Also fixed a
     **pre-existing brittle fixed-7000-char-window source slice** in
     `tests/capture-wiring.test.js` that this insertion pushed a later
     assertion past — switched to the closing-brace scan already used
     elsewhere in that file.
   - **Live data fix**: cleared the 14 known-bad cards
     (`setCardImage(it,""); lastResult="fail"`) so they show an honest
     "couldn't capture" state instead of the misleading fake picture.
     Ids: `6zia77 t5i5r3 y6k4fi pd2x50 cl45a8 515bal 0wq2cq updfhr 8gnkwc
     nvza1b dwhfa0 mfply3 619wiz 4ts1sx` (all prefix `c_mqyfkl7d_`).

3. **Cut release v1.12.21** (commit `ced6884`, package.json
   `1.12.20`→`1.12.21`), which bundles everything above **plus** whatever
   else had already landed on `master` since v1.12.20 from other work
   today (reader view, mobile nav/filter toggle, decommissioned-features
   cleanup, and the PWA sync-diagnostics commits below) — this session did
   not author those, just included them in the version bump. GitHub
   Actions built and published the installer successfully; verified via
   `gh release view v1.12.21`.

## Specifically re: the PWA sync-reliability work (`docs/superpowers/specs/2026-07-15-sync-reliability-design.md`)

This session **did not touch `pwa/oauth.js` or `pwa/sync-pwa.js`** and did
not implement any part of that spec. What this session confirmed, in case
it's useful context for whoever picks that spec up:

- The temporary diagnostic `alert()` popups (commit `ec48f81`, "Remove once
  root-caused") are **still in place**, un-removed, as of `master` tip.
- **The desktop Electron app cannot see any of `pwa/` at all** —
  `electron-builder`'s `files` config (`package.json`) only bundles
  `main.js`, `preload.js`, `core/`, `web/`, `extension/`, `node_modules/`;
  `main.js` loads via `mainWindow.loadURL(origin + "/")` against the local
  Core server, which serves `web/index.html`, never `pwa/index.html`. So
  cutting v1.12.21 (which includes the still-active diagnostics) has **no
  effect on desktop users** — the diagnostics only ever reached the PWA
  (GitHub Pages), and were already live there before this session started,
  via `deploy-pwa.yml`'s auto-deploy-on-`pwa/**`-push.
- The spec's plan to remove the temporary `alert()`s and replace them with
  `classifyDbxError()` + `partialFailures` + a persisted "last sync result"
  line is, as far as this session can tell, **not yet implemented** — only
  the diagnostic-phase commits (`ec48f81`, `b3ce5f5`, `a975538`) are on
  `master`.

## Everything this session touched (file list, for merge-conflict awareness)

```
extension/background.js
web/index.html            pwa/index.html
web/lib/capture-state.js  pwa/lib/capture-state.js
pwa/sw.js                 (SHELL_CACHE v14 -> v15)
tests/durable-cdn-image.test.js          (new)
tests/junk-screenshot-detection.test.js  (new)
tests/capture-state.test.js
tests/capture-wiring.test.js
package.json               (version 1.12.20 -> 1.12.21)
```

Commits, in order: `f0d911a`, `16a04ca`, `ced6884`. All pushed. Also
noticed but did not touch: untracked `.agents/`, `.codex/`, `AGENTS.md`
(stale, pre-dates the current Electron architecture — see project memory),
`_loopstate/` in the working tree — none of these are committed.

## Open items this session did NOT resolve

- The 3 permanently-dead reel cards (`iz8j1c`, `d99utw`, `a4sg0l`) —
  probably deleted/private content, not investigated further.
- PWA sync reliability (see above) — spec written by the other session,
  not implemented by this one.
- Extension needs a manual `chrome://extensions` reload for the
  CDN-durability fix to apply to *future* captures (the desktop app's
  Core/web side needs an installed v1.12.21 for its half; the extension
  loads unpacked from this repo and just needs a reload, independent of
  any release).

`node tests/run.js`: ALL TEST FILES PASSED as of `ced6884`.
