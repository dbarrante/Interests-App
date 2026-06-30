# Interests App — Backlog / To-Do

A running list of requested features and deferred items. Each entry has enough context to pick up cold
(brainstorm → spec → plan → build when started). Newest requests at the top.

## Requested 2026-06-30 (Dave)

- [ ] **Single-card "reader" view (full-page, one article at a time).** A page-sized view that shows ONE
  card at a time with **advance / retreat arrows** to move through the set, plus a **Remove card** button
  in the view. For focused reading/triage of one item at a time (vs. the grid). Open questions for
  brainstorm: which set does it page through (current filter/search result, or all Imported?); keyboard
  arrows too; what "remove" does (same backup-first delete as elsewhere); where the entry point lives.

- [ ] **"Open app in a browser session" button.** A button that opens the app in a real browser tab
  (the Core already serves the UI at `http://localhost:3456`). Note: when the app is open as a
  `localhost` Chrome tab, the extension's `bridge.js` content script runs there and can also drive
  capture — so this doubles as an alternate capture path. Brainstorm: open via `shell.openExternal`
  to the loopback URL; confirm the served UI works the same in a browser vs. the Electron window.

- [ ] **YouTube "Save" → auto-add the video to the app (integrate or confirm).** When you click **Save**
  on a YouTube video (add to a playlist / Watch Later), it should capture that video into the app
  automatically. **Likely already built** — the extension has a YouTube `saveTrigger` + `yt-save-trigger.js`
  (playlist-save, shipped ~v4.37): adding a video to any playlist fires a capture → Saved library.
  Action: **confirm it still works end-to-end** (reload ext, refresh a YouTube tab, Save a video to a
  playlist → check it lands in Saved with the real thumbnail); fix/extend if it doesn't.

## YouTube channel cards — decision needed

- [ ] **What to do with the 451 imported YouTube *channel* cards** (from a `youtube` subscriptions import;
  they open the creator's page, not a video). Options: (1) leave them (a followed channel is a valid
  interest signal); (2) give them a nicer picture (channel avatar/art via og:image instead of the current
  page screenshot); (3) replace with real videos by re-importing a video-bearing source (YouTube/Takeout
  watch-history / liked / playlists); (4) remove them. Real videos will also flow in going forward via the
  YouTube "Save" integration above.

## Deferred capture/UX niceties (offered, not yet built)

- [ ] **In-app Capture Log panel** (spec `2026-06-30-unified-sw-capture-driver-design.md`, Phase 3–4): a
  Settings view that tails the worker's capture trail (POST/GET `/api/log` ring buffer + SW mirroring),
  so capture issues are visible without DevTools / live queue grabbing.
- [ ] **Stuck-spinner timeout**: a per-card refresh that never lands should flip to "failed" after a
  timeout instead of spinning forever.
- [ ] **force on the localhost `bridge.js` batch path**: `bridge.js dispatch` doesn't pass `force`, so a
  Recapture run driven from a localhost browser tab won't overwrite good images (MINOR; the standalone
  app's SW driver already passes force).

## Older deferred (from earlier phases — see memory `interests-app-formal-app-phase.md`)

- [ ] **Notion connector**: token in Settings → Core fetches pages/databases → feed the profile analysis
  via the existing `extraSources` seam in `web/profile-analyze.js`.
- [ ] **Dropbox sync follow-ons (#5)**: settings-sync + content-addressed image pool (pays off once
  actively multi-device syncing).
- [ ] **Bounded scheduled extraction (#6)**: hands-off periodic capture from social saved lists
  (ToS/rate-limit caveats; must stay bounded + stoppable).
