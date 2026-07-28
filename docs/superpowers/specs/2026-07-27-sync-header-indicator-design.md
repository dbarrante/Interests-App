# Sync header indicator — design

## Goal

A single always-visible header element (`#syncIndicator`) that shows sync
freshness at a glance and animates while a sync is running. Replaces the
"only in Settings, absolute timestamp, refreshes only on panel re-render"
status with a live, friendly one — on both the desktop app (`web/`) and the
PWA (`pwa/`).

## States

| State | Content | Source |
|---|---|---|
| Synced (idle) | `✓ synced 2m ago` (relative, live) | last successful `lastSyncResult().at` |
| Syncing | `⟳ syncing…` (spin) + `images 240/1200` when reported | in-flight signal + last progress tick |
| Failed | `⚠ sync failed` | `lastSyncResult().ok === false` |
| Off / not connected | muted `sync off` (clickable) | `syncStatus().enabled` / `.connected` |

Clicking the chip → `showTab('settings')` and scrolls to the sync section.
The existing Settings "Last sync" line reuses the same relative formatter
(exact timestamp on hover via `title`).

## Detecting "a sync is running" (all three triggers)

1. **Manual "Sync now"** and **PWA auto-sync** — already set the in-page
   `_syncInFlight` promise. The indicator reads that directly (instant).
2. **Desktop background syncs** (Core service timers) — not UI-driven. Add an
   in-memory `ctx.syncRunning` flag set to `true` around every sync job in
   `core/synctimers.js` and the `/api/sync/now` route, exposed by
   `/api/sync-status` as `running`. The indicator polls `syncStatus()` every
   ~4s **only while the document is visible**; skipped on the PWA (no Core
   service, and its syncs are already covered by `_syncInFlight`).

`isSyncing = !!_syncInFlight || !!lastStatus.running`.

## Progress text

`syncNowClick` / `autoSync` already pass an `onProgress({phase,done,total})`
callback. Stash the latest tick in a module var (`_syncProgress`) and show
`phase done/total` while syncing; clear it when the cycle ends.

## Relative-time formatter

`relTime(ms)` → "just now" (<45s), "Nm ago" (<60m), "Nh ago" (<24h),
else the locale date. Pure, unit-testable. A ~30s interval re-renders the
indicator so "2m ago" advances without a sync.

## Components

- `web/index.html` + `pwa/index.html` (byte-identical shared fns, parity-tested):
  - header markup: `<button id="syncIndicator" class="sync-chip" onclick="syncChipClick()">`
  - `renderSyncIndicator()` — computes state from `_syncInFlight`, `_syncProgress`,
    `_lastSyncStatus`, and last-sync result; sets content + spin class.
  - `relTime(ms)`; `syncChipClick()`; a `startSyncIndicatorLoop()` (30s tick +
    visible-only ~4s desktop poll) started at boot.
  - `renderSyncStatus()` reuses `relTime` for the Settings line.
- `core/server.js` — `/api/sync-status` returns `running: !!ctx.syncRunning`.
- `core/synctimers.js` + `/api/sync/now` — set/clear `ctx.syncRunning` around the job.

## Testing

- `relTime` unit tests (boundaries: <45s, minutes, hours, days).
- `renderSyncIndicator` state selection (behavioral, extracted fn with injected
  deps): idle→"synced", in-flight→spin, running-poll→spin, failed→warn, off→chip.
- `/api/sync-status` returns `running` reflecting `ctx.syncRunning` (endpoint test).
- web/pwa parity for the shared functions; `SHELL_CACHE` bump.

## Non-goals

- No new persistent state / sync-protocol change. `ctx.syncRunning` is in-memory,
  advisory UI only.
- Desktop-background progress counts are best-effort (the timer path may not
  thread `onProgress`); the spin still shows via `running`.
