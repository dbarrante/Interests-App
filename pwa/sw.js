"use strict";

// Minimal service worker, Phase 2 scope: proxy /idb-img/<id> requests to the
// "images" IndexedDB object store. This exists because Store.imgUrl(id) must stay
// SYNCHRONOUS (index.html does `im.src = Store.imgUrl(id)` directly, mirroring the
// desktop's `/api/img/<id>` URL-string contract) while IndexedDB reads are async.
// Returning a same-origin URL and letting the browser's normal <img> fetch trigger
// this handler is the only way to bridge that gap without touching index.html.
//
// Full offline app-shell caching is out of scope here — that's Phase 5.

const DB_NAME = "interests-app-pwa";
const DB_VERSION = 2; // must always track pwa/idb.js's DB_VERSION

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
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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
