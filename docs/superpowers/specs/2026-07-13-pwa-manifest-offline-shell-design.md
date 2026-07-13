# PWA manifest + offline app-shell caching (Phase 5) — design

Closes Phase 5 from `pwa/HANDOFF.md`'s recommended next steps: "`manifest.
webmanifest` + icons, extend `sw.js` beyond image proxying into full
app-shell caching for offline/installability." This is the step before Phase
6 (deploy to GitHub Pages, the first point the app can run on a real iPad).

## Starting state

`pwa/index.html`'s `<head>` (shared verbatim with `web/index.html`) already
contains:

```html
<meta name="theme-color" content="#c2410c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Interests">
<link rel="manifest" href="manifest.webmanifest">
```

No HTML edit is needed for the manifest link itself. But `pwa/` is served
from its own directory root (`python -m http.server 8080` inside `pwa/`), so
that relative link resolves to `pwa/manifest.webmanifest` — which doesn't
exist. A root-level `manifest.webmanifest` already exists for the desktop
build, using an inline SVG data-URI icon (orange "i" on a `#c2410c` rounded
square, `sizes:"any"`).

`pwa/sw.js` currently only proxies `/idb-img/<id>` requests to IndexedDB
(Phase 2 scope, documented in its own header comment as leaving "full offline
app-shell caching" for Phase 5 — this design).

The repo has three inconsistent icon assets: the root manifest's orange "i",
the browser extension's pink bookmark+sparkle (`extension/icon.svg`), and the
Electron build's `.ico`. Decision: reuse the root manifest's orange "i" for
consistency with the desktop app's existing identity, and because it's
already a self-contained data URI (no new binary asset, no rasterization
tooling needed — none is available in this environment: no ImageMagick,
Inkscape, or sharp, and adding an npm dependency just to generate PNGs would
break this project's zero-tooling convention).

## Components

**`pwa/manifest.webmanifest`** (new file) — identical content to the
existing root `manifest.webmanifest`, physically placed in `pwa/` so the
already-present `<link rel="manifest">` resolves correctly:

```json
{
  "name": "Interests — AI Discovery Feed",
  "short_name": "Interests",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#f6f5f3",
  "theme_color": "#c2410c",
  "icons": [
    {
      "src": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23c2410c'/%3E%3Ctext x='50' y='68' font-size='52' font-family='Segoe UI,Arial' font-weight='800' fill='white' text-anchor='middle'%3Ei%3C/text%3E%3C/svg%3E",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ]
}
```

**`pwa/pwa-install.js`** (new file) — injects
`<link rel="apple-touch-icon" href="data:image/svg+xml,...">` into `<head>`
at runtime, using the exact same SVG data URI as the manifest icon (kept in
sync via a comment, matching this codebase's existing `DB_VERSION`
duplication-with-a-must-track-comment precedent between `idb.js`/`sw.js`).
This exists because iOS Safari's "Add to Home Screen" icon has historically
relied on a real `apple-touch-icon` link tag rather than the manifest's
`icons` array (support for SVG there is inconsistent across iOS versions;
modern iPadOS 16.4+ has decent support, and worst case it's ignored and iOS
falls back to its default screenshot-based icon — no worse than not adding
it at all). Needs one new `<script>` tag in `index.html` — the one kind of
diff this file is allowed (see `pwa/HANDOFF.md`'s and `pwa/README.md`'s
documented byte-for-byte-except-`<script>`-tags constraint, already used for
`dropbox-connect.js`).

**`pwa/sw.js`** (modified) — extends the existing service worker with a
generic same-origin cache-first strategy:

- `const SHELL_CACHE = "interests-pwa-shell-v1";` — a hardcoded version
  string, bumped by hand whenever a cached file's behavior changes in a way
  old clients must not keep serving stale. Routine additions of new files
  need no bump — they get cached the first time they're fetched.
- `fetch` handler: after the existing `/idb-img/` proxy check (unchanged,
  returns early), any same-origin GET request is served cache-first — check
  `SHELL_CACHE` first; on a miss, fetch from network, cache the response only
  if `res.ok`, then return it. Cross-origin requests (Dropbox API, AI
  providers, thum.io/mshots, Pinterest widgets, microlink, noembed,
  openpagerank, the Cloudflare content-check Worker) and non-GET requests are
  completely untouched — always network, exactly as today.
- `activate` handler: extended to delete any cache not named `SHELL_CACHE`
  before calling the existing `self.clients.claim()`.

Explicitly rejected alternative: a hardcoded `SHELL_FILES` array precached
via `cache.addAll()` at install time. Same versioning/invalidation mechanism,
but requires remembering to update the list every time a script tag is added
to `index.html` — the generic same-origin rule is self-maintaining and
covers `manifest.webmanifest` and every current/future script automatically.

## Data flow

Cross-origin calls and `/idb-img/` image loads are unaffected by this
change — both paths are checked/excluded before the new same-origin logic
runs.

Same-origin shell files (`index.html`, every `.js` file, `manifest.
webmanifest`) get cached opportunistically starting from the **second** page
load. This is standard service-worker behavior, not a limitation of this
design: the very first navigation that registers a service worker is never
itself controlled by it, so nothing from that load is interceptable — no
explicit precache step changes this. In practice, the app is expected to be
reloaded/reopened normally soon after first install, at which point the
shell cache populates and offline reloads after that serve instantly from
cache.

IndexedDB data (cards/saved/images) already works offline today via existing
`idb.js`/`storage-pwa.js` code and is untouched by this design.

## Error handling

- `cache.put()` is only called when `res.ok` — a 404/500 response is never
  cached as if it were good content, so a transient server error can't get
  "stuck" as the offline copy until the cache version is bumped.
- A resource with no cache entry and no network reachable fails normally —
  the fetch rejection propagates as an ordinary browser network error for
  that sub-resource. No new error-hiding behavior is introduced.
- No changes to the existing `/idb-img/` proxy's error handling, or to
  `idb.js`'s `onversionchange`/watchdog logic from the earlier IndexedDB
  postmortem (`pwa/HANDOFF.md` item 1) — this design doesn't touch
  `DB_VERSION` or the image-proxy code at all.

## Explicitly out of scope

- Real raster (PNG) icons — no rasterization tooling is available in this
  environment, and adding an npm dependency to generate them would break
  this project's zero-tooling convention. SVG-only for this phase.
- A fixed/enumerated shell-file precache list (see rejected alternative
  above).
- Any change to `web/index.html`, `core/`, or the Electron build.
- Phase 6 (GitHub Pages deploy, real HTTPS, registering a second OAuth
  redirect URI) — separate, later phase per `pwa/README.md`.

## Testing

Manual verification only, matching the rest of `pwa/` (no automated test
harness exists for `pwa/*.js` browser code): load the app once online (so
the shell cache populates), then go offline (DevTools → Network → Offline)
and reload — confirm the app shell still renders and IndexedDB-backed data
(cards/saved/images, Settings) still works; confirm cross-origin actions
(e.g. Sync Now) fail gracefully as they already do when genuinely offline,
rather than the whole page breaking. Also check DevTools → Application →
Manifest to confirm the icon/name are read correctly and "Add to Home
Screen" is offered.
