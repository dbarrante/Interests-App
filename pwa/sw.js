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
const SHELL_CACHE = "interests-pwa-shell-v38"; // bump on ANY edit to an already-cached
// file (index.html, any .js file, the manifest) — cache-first means existing
// installs keep serving the old content indefinitely otherwise. Adding a brand-new
// file needs no bump; it's simply cached the first time it's fetched.

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
  const m = url.pathname.match(/\/idb-img\/([^/]+)$/);
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
