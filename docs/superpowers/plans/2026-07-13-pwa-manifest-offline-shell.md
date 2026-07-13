# PWA Manifest + Offline App-Shell Caching (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the iPad PWA build a real web app manifest + home-screen icon, and extend its service worker so the app shell (HTML + JS) works fully offline after the first load — closing Phase 5 from `pwa/HANDOFF.md`.

**Architecture:** Two new files (`pwa/manifest.webmanifest`, `pwa/pwa-install.js`) plus one new `<script>` tag in `pwa/index.html` provide the manifest and a runtime-injected `apple-touch-icon`. `pwa/sw.js` gains a generic same-origin cache-first rule (not a hardcoded file list) so `index.html`, every `.js` file, and the manifest all get cached automatically the first time they're fetched.

**Tech Stack:** Vanilla browser JS, no build step (matches the whole PWA stack). Service Worker Cache Storage API.

## Global Constraints

- `pwa/index.html` must stay a byte-for-byte copy of `web/index.html` except for its `<script>` tags (documented in `pwa/README.md`/`pwa/HANDOFF.md`) — this plan adds exactly one new `<script src="pwa-install.js">` tag, no other HTML/inline-script edits.
- No raster (PNG) icons — no rasterization tooling available in this environment, and adding an npm dependency to generate them would break this project's zero-tooling convention. SVG data-URI only, reusing the existing root-manifest icon.
- No hardcoded shell-file list — the fetch handler's same-origin cache-first rule must stay generic (see spec's "Explicitly rejected alternative").
- No automated test harness exists for `pwa/*.js` browser code — verification in this plan is manual (`node --check` for syntax, real browser for behavior), matching how `pwa/dropbox-connect.js` was verified.
- Design spec: `docs/superpowers/specs/2026-07-13-pwa-manifest-offline-shell-design.md` — read it for full rationale; this plan implements it task-by-task.

---

## File structure

- **Create** `pwa/manifest.webmanifest` — web app manifest, identical content to the existing root `manifest.webmanifest`.
- **Create** `pwa/pwa-install.js` — injects an `apple-touch-icon` `<link>` at runtime.
- **Modify** `pwa/index.html` — add `<script src="pwa-install.js"></script>` as the first of the PWA-stack script tags (before `idb.js`), since it has no dependency on the data/sync stack.
- **Modify** `pwa/sw.js` — add `SHELL_CACHE` constant, extend the `fetch` handler with a same-origin cache-first branch, extend the `activate` handler to delete stale-named caches.

---

## Task 1: Web app manifest + apple-touch-icon

**Files:**
- Create: `pwa/manifest.webmanifest`
- Create: `pwa/pwa-install.js`
- Modify: `pwa/index.html` (add one script tag)

**Interfaces:**
- Produces: nothing consumed by other tasks — Task 2 (service worker changes) is independent of this task and doesn't reference `pwa-install.js` or the manifest.

- [ ] **Step 1: Create `pwa/manifest.webmanifest`**

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

- [ ] **Step 2: Create `pwa/pwa-install.js`**

```javascript
"use strict";

// Injects an apple-touch-icon link tag at runtime — iOS Safari's "Add to Home
// Screen" icon has historically relied on this tag rather than the web app
// manifest's `icons` array (SVG support there is inconsistent across iOS
// versions). Runtime injection, not a static <link> in index.html, because
// index.html is documented (pwa/README.md, pwa/HANDOFF.md) as a byte-for-byte
// copy of web/index.html except for its <script> tags.
//
// No DOMContentLoaded gating needed here (unlike pwa/dropbox-connect.js):
// this script tag lives in <head>, and document.head already exists as soon
// as the parser reaches any <script> inside <head> — unlike dropbox-connect.js,
// which needs elements from <body>, which hasn't been parsed yet at that point.
//
// KEEP IN SYNC with the icon in pwa/manifest.webmanifest's `icons[0].src` —
// same SVG, same orange "i" on a #c2410c rounded square.

(function () {
  const ICON_SVG_DATA_URI =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23c2410c'/%3E%3Ctext x='50' y='68' font-size='52' font-family='Segoe UI,Arial' font-weight='800' fill='white' text-anchor='middle'%3Ei%3C/text%3E%3C/svg%3E";

  if (!document.querySelector('link[rel="apple-touch-icon"]')) {
    const link = document.createElement("link");
    link.rel = "apple-touch-icon";
    link.href = ICON_SVG_DATA_URI;
    document.head.appendChild(link);
  }
})();
```

- [ ] **Step 3: Add the script tag to `pwa/index.html`**

Find this block (around line 372-378, after Task 1 of the Dropbox-connect-ui plan added `dropbox-connect.js`):

```html
<script src="idb.js"></script>
<script src="oauth.js"></script>
<script src="merge.js"></script>
<script src="sync-pwa.js"></script>
<script src="storage-pwa.js"></script>
<script src="dropbox-connect.js"></script>
<script src="ai.js"></script>
```

Change it to:

```html
<script src="pwa-install.js"></script>
<script src="idb.js"></script>
<script src="oauth.js"></script>
<script src="merge.js"></script>
<script src="sync-pwa.js"></script>
<script src="storage-pwa.js"></script>
<script src="dropbox-connect.js"></script>
<script src="ai.js"></script>
```

- [ ] **Step 4: Syntax-check**

Run: `node --check pwa/pwa-install.js`
Expected: no output (valid syntax). Also run `node -e "JSON.parse(require('fs').readFileSync('pwa/manifest.webmanifest','utf8'))"` to confirm the manifest is valid JSON — expected: no output (no exception thrown).

- [ ] **Step 5: Manually verify in a browser**

1. `cd pwa && python -m http.server 8080`
2. Open `http://localhost:8080/` in a browser.
3. DevTools → Application → Manifest: confirm "Interests — AI Discovery Feed" / "Interests" / theme color `#c2410c` / the orange "i" icon all display correctly, with no manifest errors listed.
4. DevTools → Elements: confirm `<head>` contains a `<link rel="apple-touch-icon" href="data:image/svg+xml,...">` tag.
5. Confirm no new console errors on load.

- [ ] **Step 6: Commit**

```bash
git add pwa/manifest.webmanifest pwa/pwa-install.js pwa/index.html
git commit -m "feat(pwa): add web app manifest and apple-touch-icon (Phase 5)"
```

---

## Task 2: Offline app-shell caching in the service worker

**Files:**
- Modify: `pwa/sw.js`

**Interfaces:**
- Consumes: none from Task 1 — independent.
- Produces: `SHELL_CACHE` constant (for reference only; no other file reads it).

- [ ] **Step 1: Update the file header comment**

Replace `pwa/sw.js`'s current header comment:

```javascript
"use strict";

// Minimal service worker, Phase 2 scope: proxy /idb-img/<id> requests to the
// "images" IndexedDB object store. This exists because Store.imgUrl(id) must stay
// SYNCHRONOUS (index.html does `im.src = Store.imgUrl(id)` directly, mirroring the
// desktop's `/api/img/<id>` URL-string contract) while IndexedDB reads are async.
// Returning a same-origin URL and letting the browser's normal <img> fetch trigger
// this handler is the only way to bridge that gap without touching index.html.
//
// Full offline app-shell caching is out of scope here — that's Phase 5.
```

with:

```javascript
"use strict";

// Service worker: proxies /idb-img/<id> requests to the "images" IndexedDB object
// store (Phase 2 — see below), and caches every other same-origin GET request for
// full offline app-shell support (Phase 5).
//
// The /idb-img proxy exists because Store.imgUrl(id) must stay SYNCHRONOUS
// (index.html does `im.src = Store.imgUrl(id)` directly, mirroring the desktop's
// `/api/img/<id>` URL-string contract) while IndexedDB reads are async. Returning
// a same-origin URL and letting the browser's normal <img> fetch trigger this
// handler is the only way to bridge that gap without touching index.html.
//
// The app-shell cache is a generic same-origin cache-first rule, not a hardcoded
// file list — index.html, every .js file, and manifest.webmanifest all get cached
// the first time they're fetched, so there's nothing to remember to update when a
// new script tag is added. Cross-origin requests (Dropbox API, AI providers,
// thum.io/mshots, etc.) always go straight to network, untouched.
```

- [ ] **Step 2: Add the `SHELL_CACHE` constant**

Directly below the existing `DB_VERSION` line:

```javascript
const DB_NAME = "interests-app-pwa";
const DB_VERSION = 2; // must always track pwa/idb.js's DB_VERSION
const SHELL_CACHE = "interests-pwa-shell-v1"; // bump when a cached file's behavior
// changes in a way old clients must not keep serving stale. Routine additions of
// new files need no bump — they're cached the first time they're fetched.
```

- [ ] **Step 3: Extend the `activate` handler**

Replace:

```javascript
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
```

with:

```javascript
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));
```

- [ ] **Step 4: Extend the `fetch` handler**

Replace the entire existing `fetch` listener:

```javascript
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(/^\/idb-img\/(.+)$/);
  if (!m) return; // not ours — let the browser handle it normally

  const id = decodeURIComponent(m[1]);
  event.respondWith(
    getImage(id).then((row) => {
      if (!row || !row.blob) return new Response("not found", { status: 404 });
      return new Response(row.blob, { headers: { "Content-Type": row.type || "image/jpeg" } });
    }).catch(() => new Response("error reading image store", { status: 500 }))
  );
});
```

with:

```javascript
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(/^\/idb-img\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    event.respondWith(
      getImage(id).then((row) => {
        if (!row || !row.blob) return new Response("not found", { status: 404 });
        return new Response(row.blob, { headers: { "Content-Type": row.type || "image/jpeg" } });
      }).catch(() => new Response("error reading image store", { status: 500 }))
    );
    return;
  }

  // Phase 5: generic same-origin app-shell cache. Cross-origin requests (Dropbox
  // API, AI providers, thum.io/mshots, Pinterest widgets, microlink, noembed,
  // openpagerank, the Cloudflare content-check Worker) and non-GET requests are
  // left untouched — always network, exactly as before this branch existed.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    })
  );
});
```

So the full file (for reference, confirming nothing else changes) should read:

```javascript
"use strict";

// Service worker: proxies /idb-img/<id> requests to the "images" IndexedDB object
// store (Phase 2 — see below), and caches every other same-origin GET request for
// full offline app-shell support (Phase 5).
//
// The /idb-img proxy exists because Store.imgUrl(id) must stay SYNCHRONOUS
// (index.html does `im.src = Store.imgUrl(id)` directly, mirroring the desktop's
// `/api/img/<id>` URL-string contract) while IndexedDB reads are async. Returning
// a same-origin URL and letting the browser's normal <img> fetch trigger this
// handler is the only way to bridge that gap without touching index.html.
//
// The app-shell cache is a generic same-origin cache-first rule, not a hardcoded
// file list — index.html, every .js file, and manifest.webmanifest all get cached
// the first time they're fetched, so there's nothing to remember to update when a
// new script tag is added. Cross-origin requests (Dropbox API, AI providers,
// thum.io/mshots, etc.) always go straight to network, untouched.

const DB_NAME = "interests-app-pwa";
const DB_VERSION = 2; // must always track pwa/idb.js's DB_VERSION
const SHELL_CACHE = "interests-pwa-shell-v1"; // bump when a cached file's behavior
// changes in a way old clients must not keep serving stale. Routine additions of
// new files need no bump — they're cached the first time they're fetched.

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Service workers outlive every tab — without this, a stale open connection
    // here silently blocks any page's version upgrade forever, with no error
    // visible anywhere a normal page reload would surface it. See pwa/idb.js's
    // openDb() for the matching page-side half of this fix.
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

async function getImage(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("images", "readonly").objectStore("images").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(/^\/idb-img\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    event.respondWith(
      getImage(id).then((row) => {
        if (!row || !row.blob) return new Response("not found", { status: 404 });
        return new Response(row.blob, { headers: { "Content-Type": row.type || "image/jpeg" } });
      }).catch(() => new Response("error reading image store", { status: 500 }))
    );
    return;
  }

  // Phase 5: generic same-origin app-shell cache. Cross-origin requests (Dropbox
  // API, AI providers, thum.io/mshots, Pinterest widgets, microlink, noembed,
  // openpagerank, the Cloudflare content-check Worker) and non-GET requests are
  // left untouched — always network, exactly as before this branch existed.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    })
  );
});
```

- [ ] **Step 5: Syntax-check**

Run: `node --check pwa/sw.js`
Expected: no output (valid syntax).

- [ ] **Step 6: Manually verify — shell caches and survives offline**

1. `cd pwa && python -m http.server 8080` (if not already running).
2. Open `http://localhost:8080/` in a browser profile with an existing IndexedDB library (or one synced via the Dropbox-connect UI from the prior phase). Reload the page once (the SW's `fetch` handler only controls requests from the *second* load onward — this is expected, not a bug).
3. DevTools → Application → Cache Storage: confirm a cache named `interests-pwa-shell-v1` exists and contains `index.html`, `idb.js`, `oauth.js`, `merge.js`, `sync-pwa.js`, `storage-pwa.js`, `dropbox-connect.js`, `ai.js`, `pwa-install.js`, `manifest.webmanifest`, and the other script files loaded by the page.
4. DevTools → Network tab → set to "Offline". Reload the page.
5. Confirm the page still renders (cards, Settings, etc. — all backed by IndexedDB, unaffected by this change) rather than showing the browser's offline error page.
6. Still offline, click "Sync now" in Settings. Confirm it fails gracefully with a toast (existing error-handling path in `storage-pwa.js`/`oauth.js` — this plan doesn't change that), not a page crash.
7. Set Network back to "Online" before continuing normal use.

- [ ] **Step 7: Commit**

```bash
git add pwa/sw.js
git commit -m "feat(pwa): cache same-origin app shell for offline support (Phase 5)"
```

---

## Self-review notes

- **Spec coverage:** manifest file with the same icon as the root manifest → Task 1 Step 1. Runtime-injected apple-touch-icon, no `index.html` HTML edit beyond the one script tag → Task 1 Steps 2-3. Generic same-origin cache-first rule (not a hardcoded file list) → Task 2 Step 4. Versioned cache name + activate-time cleanup → Task 2 Steps 2-3. Cross-origin/non-GET requests untouched → Task 2 Step 4's guard clause. `/idb-img/` proxy behavior unchanged → Task 2 Step 4 keeps that branch verbatim, just adds an early `return`. No raster icons, no new dependencies → neither task introduces any.
- **Placeholder scan:** none found — every step ships complete, runnable code and concrete manual-verification instructions.
- **Type/name consistency:** `SHELL_CACHE` used identically in Task 2 Steps 2-4. `ICON_SVG_DATA_URI` string is byte-identical between Task 1 Step 1 (manifest `icons[0].src`) and Step 2 (`pwa-install.js`) — both copy-pasted from the same source (the existing root `manifest.webmanifest`), confirmed matching character-for-character.
