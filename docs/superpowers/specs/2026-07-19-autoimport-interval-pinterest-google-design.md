# Auto-import: configurable check interval + Pinterest & Google-saves platforms — design

**Date:** 2026-07-19 · **Status:** approved (user, 2026-07-19) · **Target release:** v1.12.30

Two independent extensions to the FB/IG platform auto-import shipped in
v1.12.26–29 (spec `2026-07-17-platform-auto-import-design.md`, live-tuning
outcomes in `docs/BACKLOG.md` 2026-07-18 entry). Everything here reuses that
pipeline's contracts; nothing changes for existing FB/IG behavior beyond the
shared interval.

## Part 1 — Configurable check interval

**User decision:** one GLOBAL interval for all platforms; dropdown options
`1 day (default) / 12 / 8 / 4 / 2 / 1 hours`, "1 day" the top entry.

- **Setting:** `S.autoImportEvery` (hours, number, default `24`) in DEFAULTS,
  persisted via the normal `save("settings",S)` pipeline into the same
  `ia_settings` kv that `core/autoimport.getConfig()` already reads. Desktop
  Settings only (PWA hides `secAutoImport` already).
- **UI:** a `<select id="autoImportEvery">` row inside `secAutoImport`,
  wired like the existing toggles (onchange → save). Label: "Check every".
- **Config endpoint:** `GET /api/auto-import/config` adds
  `intervalHours` (number; absent/garbage clamps to 24 extension-side;
  accepted range 1–24).
- **Extension:** `pollAutoImportRequest` (already fires every 30s via the
  `iaCapturePoll` alarm and already resolves the port) additionally fetches
  the config and calls `ensureAutoImportAlarm(intervalHours)`: compares
  against `chrome.storage.local.ia_autoimport_interval`; when changed,
  re-creates `AUTOIMPORT_ALARM` with `periodInMinutes = hours*60`,
  `delayInMinutes = min(30, hours*60)`, and stores the applied value. A
  dropdown change takes effect within ~30s with no extension reload. The
  alarm path's `autoImportOn` gate and per-platform checks are unchanged.
- **Clamp rule:** extension clamps `intervalHours` to `[1, 24]` — a garbage
  or missing value behaves exactly like today (daily).

## Part 2 — Pinterest and Google-saves platforms

**User decisions:** Pinterest = ALL the user's pins (not per-board);
Google = `google.com/save` (Google's Saved collections from
Search/Images/Maps), NOT Chrome bookmarks (already covered elsewhere).

Same architecture as FB/IG, end to end:

### Parsers (pure, capture-first)

`extension/lib/saved-parse-pin.js` and `extension/lib/saved-parse-gs.js`,
mirroring the FB/IG parser contract exactly:

- `parseSavedHtml(html)` / `parseSavedDoc(doc)` → `{status, items}` where
  `status ∈ ok | login-required | parse-failed` and items are
  `{url, title, image, platformKey}` (title ≤512, CAP 100 items,
  script/style stripped before the anchor walk, merge-all-anchors-per-key,
  fail SOFT: zero-parse or login wall delivers a status and NO items).
- **Pinterest key:** the numeric pin id from `/pin/<id>/` anchors
  (relative or absolute); canonical url `https://www.pinterest.com/pin/<id>/`.
  Images come from in-anchor `<img>` (i.pinimg.com is not a signed/expiring
  CDN → passed through raw, never credential-fetched; the isExpiringCdnImage
  gate simply won't match).
- **Google-saves key:** items are EXTERNAL links (like FB link-shares).
  Exact anchor shape, title source, and key derivation are set from the
  live capture (`_livecapture/google-saved.html`) — the working rule is the
  normalized external URL as `platformKey` unless the capture exposes a
  stable internal item id. This is the one deliberately-open point in this
  spec; it is bounded by the parser contract above and closed during
  capture-tuning (the build step cannot start without the captures).
- **Both parsers are written against real captures** the user takes BEFORE
  parser code (2026-07-19 lesson: blind fixtures cost a full live-debugging
  round — @saved-profile trap, /saved/ context prefixes, notif dropdowns).

### Extension scheduler

- `AUTOIMPORT_URLS` gains `pin` and `gs`. Pinterest tries
  `https://www.pinterest.com/me/pins/` first (verified against the capture
  round); if `/me/` doesn't resolve to the profile, IG-style discovery from
  the logged-in home nav. Google: `https://www.google.com/save`.
- `runAutoImportCheck` iterates `["fb","ig","pin","gs"]` sequentially, one
  inactive tab at a time, growth-based scroll polling, tab always closed in
  `finally` — all existing machinery.
- Delivery unchanged: `durableThumb` only for signed-CDN images (F1 gate),
  850KB batch budget, 250KB per-field ceiling.

### Core

- `core/autoimport.js`: platform whitelist `fb|ig|pin|gs`; ledgers
  `ia_autoimport_seen_pin` / `_gs`; status records `ia_autoimport_last_pin`
  / `_gs`. Validation/caps/dedup logic is already platform-parameterized.
- `core/server.js` config endpoint: `platforms` gains `pin`/`gs` from
  `S.autoImportPin` / `S.autoImportGs` (default true, consulted only when
  the master `autoImportOn` is on — same as FB/IG).

### Renderer

- `web/route-capture.js` + `pwa/route-capture.js`: `source: "pin-auto" |
  "gs-auto"` join the import-auto decision, which stays resolved BEFORE
  every other branch (the linchpin precedence tests extend to both).
- `autoImportItemFromCap`: maps `pin-auto → src:"pinterest"`,
  `gs-auto → src:"google"` (existing source values — icons and source
  pills work unchanged), desc "Saved from Pinterest"/"Saved from Google".
- Settings: Pinterest + Google checkboxes (`autoImportPin`/`autoImportGs`,
  default true) + status rows, same markup pattern.

### Testing & rollout

- Parser test files mirror `autoimport-{fb,ig}-parse.test.js` (fixtures
  synthesized from the captures, anonymized; regression tests for every
  capture-tuning finding).
- `autoimport-core.test.js` widens platform cases; `autoimport-ext-wiring`,
  `autoimport-ui-wiring`, `route-capture` tests extend.
- Data-safety review gate applies (ledger/import surface); electron-security
  review if the bridge surface changes (it doesn't — same endpoints).
- Live validation: Check now with SW-console diag (permanent breadcrumbs
  already log per-platform status/items).
- Ship: v1.12.30 release + one extension reload. SHELL_CACHE bump for any
  pwa/ edits.

### Explicit non-goals

- No per-board Pinterest selection; no per-platform intervals; no Chrome
  bookmark changes; no PWA-side scraping (desktop extension only, as today).

## Build order

1. Part 1 (interval) — independent, no captures needed.
2. Part 2 parsers + pipeline — BLOCKED on `_livecapture/pinterest-saved.html`
   and `_livecapture/google-saved.html`, then capture-tune → implement →
   review gates → release v1.12.30.
