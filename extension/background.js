const FB_CAP_VERSION = "4.34";   // stamped into deliveries so the APP console shows which code is actually running
const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_DELAY_MS = 3000;
const MAX_QUEUE = 20;

let pendingRequest = null;
let pendingTimer = null;
let recentWatches = [];   // recently-opened card URLs, for unreachable-site detection
// serialize the actual screenshot — captureVisibleTab can only grab one visible
// tab at a time, even though batch page-loads run in parallel
let captureLock = Promise.resolve();
function withCaptureLock(fn) {
  const prev = captureLock;
  let release;
  captureLock = new Promise((r) => { release = r; });
  return prev.then(fn).finally(release);
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "").toLowerCase();
  } catch { return url.toLowerCase(); }
}

// ---- HTTP delivery to the Interests app (replaces writing into a localhost tab) ----
const IA_PORT_RANGE = [3456, 3457, 3458, 3459, 3460, 3461, 3462, 3463, 3464, 3465];
let iaCachedPort = null;

async function pingPort(port) {
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 600);
    let r;
    try { r = await fetch("http://127.0.0.1:" + port + "/api/ping", { signal: ctl.signal }); }
    finally { clearTimeout(tm); }
    if (!r || !r.ok) return false;
    const j = await r.json();
    return !!(j && j.app === "interests");
  } catch (e) { return false; }
}

// Find (and cache) the app's port. Revalidates the cached port; re-probes the
// whole range if it has gone silent. Returns null when the app is unreachable.
async function findAppPort() {
  if (iaCachedPort != null && (await pingPort(iaCachedPort))) return iaCachedPort;
  iaCachedPort = null;
  for (const p of IA_PORT_RANGE) {
    if (await pingPort(p)) { iaCachedPort = p; return p; }
  }
  return null;
}

// Push every queued capture (taken while the app was closed) once it's reachable.
async function flushQueue() {
  const port = await findAppPort();
  if (port == null) return;
  const stored = await chrome.storage.local.get("ia_capture_queue");
  let q = stored.ia_capture_queue || [];
  if (!Array.isArray(q) || !q.length) return;
  const remaining = [];
  for (const cap of q) {
    let ok = false;
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capture: cap }),
      });
      ok = !!(r && r.ok);
    } catch (e) { ok = false; }
    if (!ok) remaining.push(cap);
  }
  await chrome.storage.local.set({ ia_capture_queue: remaining });
  if (q.length !== remaining.length) log("Flushed " + (q.length - remaining.length) + " queued capture(s) to the app");
}

function log(msg) {
  console.log("[Interests Capture]", msg);
}

async function setStatus(message, ok) {
  try {
    await chrome.storage.local.set({ ia_last_status: { message, ok: !!ok, ts: Date.now() } });
  } catch (e) {}
}

function setBadge(text, ms) {
  chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  chrome.action.setBadgeText({ text });
  if (ms) setTimeout(() => chrome.action.setBadgeText({ text: "" }), ms);
}

// fire a desktop notification, swallowing the async rejection chrome throws when
// it "can't download" the icon ("Unable to download all specified images")
function notify(id, title, message) {
  try {
    const p = chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: title, message: message, silent: true,
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {}
}

// Deliver a capture to the app over HTTP (POST /api/captures). On failure (app
// closed/unreachable) stash it in chrome.storage.local so it's flushed on
// reconnect. Returns true if the app received it directly.
async function deliverToApp(capture) {
  const port = await findAppPort();
  if (port != null) {
    try {
      await flushQueue();   // drain any backlog first so order is roughly preserved
      const r = await fetch("http://127.0.0.1:" + port + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capture }),
      });
      if (r && r.ok) { log("Delivered capture to app on port " + port); return true; }
    } catch (e) { log("HTTP delivery failed: " + e.message); iaCachedPort = null; }
  }
  // app unreachable — queue it (dedupe by URL, cap the size)
  try {
    const stored = await chrome.storage.local.get("ia_capture_queue");
    let q = stored.ia_capture_queue || [];
    if (!Array.isArray(q)) q = [];
    if (capture && capture.url) q = q.filter((c) => normalizeUrl(c.url) !== normalizeUrl(capture.url));
    q.push(capture);
    if (q.length > MAX_QUEUE) q = q.slice(-MAX_QUEUE);
    await chrome.storage.local.set({ ia_capture_queue: q });
    log("App not reachable — queued capture (" + q.length + " pending)");
  } catch (e) {}
  return false;
}

// fetch a remote image and return it as a data URL. Extensions with host
// permissions bypass CORS, so this works for fbcdn/scontent images that a page
// script couldn't read. Returns "" on failure or if too large.
async function fetchAsDataUrl(url) {
  try {
    if (!/^https?:/.test(url || "")) return "";
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 6000);   // never let a hung fbcdn fetch stall the clip
    let r;
    try { r = await fetch(url, { credentials: "include", signal: ctl.signal }); }
    finally { clearTimeout(tm); }
    if (!r.ok) { log("fetchAsDataUrl HTTP " + r.status + " for " + url.slice(0, 80)); return ""; }
    const blob = await r.blob();
    if (!/^image\//.test(blob.type) || blob.size > 4000000) return "";
    return await blobToDataUrl(blob);
  } catch (e) { log("fetchAsDataUrl failed: " + e.message); return ""; }
}

// Fetch a Facebook permalink's RAW server HTML and pull out the og:image URL.
// The rendered SPA leaves og:image out of the live DOM (so the in-page engine
// can't see it), but the server HTML — the same thing that powers link previews —
// includes it, even for video posts that only show a spinner on screen. The
// worker has <all_urls> + the user's cookies, so this works for content they can see.
async function fetchFbOgImage(url) {
  if (!/^https?:/.test(url || "")) return "";
  const pats = [
    /<meta[^>]+(?:property|name)=["']og:image(?::secure_url|:url)?["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image/i,
  ];
  // LOGGED-OUT first: Facebook's public unfurl HTML carries og:image; the
  // logged-in (credentials:include) response is the app shell that omits it.
  const modes = ["omit", "include"];
  for (let i = 0; i < modes.length; i++) {
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 8000);
      let r;
      try { r = await fetch(url, { credentials: modes[i], signal: ctl.signal, redirect: "follow" }); }
      finally { clearTimeout(tm); }
      if (!r || !r.ok) continue;
      const html = await r.text();
      for (let j = 0; j < pats.length; j++) {
        const m = html.match(pats[j]);
        if (m && m[1]) {
          const u = m[1].replace(/&amp;/g, "&").replace(/\\\//g, "/").replace(/\\u0025/gi, "%").replace(/\\u003D/gi, "=");
          if (/scontent|fbcdn/i.test(u) && !/rsrc\.php|\/images\/|\/emoji/i.test(u)) { log("fetchFbOgImage ok via " + modes[i]); return u; }
        }
      }
    } catch (e) { /* try next mode */ }
  }
  log("fetchFbOgImage: no og:image for " + (url || "").slice(0, 70));
  return "";
}

// Fallback for login-gated posts (profile /posts/pfbid…) that have NO og:image in
// the public HTML: fetch LOGGED-IN and pull the largest real photo URL out of the
// inline page data. Size-gated so it skips avatars/icons.
async function fetchFbInlineImage(url) {
  try {
    if (!/^https?:/.test(url || "")) return "";
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 9000);
    let r;
    try { r = await fetch(url, { credentials: "include", signal: ctl.signal, redirect: "follow" }); }
    finally { clearTimeout(tm); }
    if (!r || !r.ok) return "";
    let text = (await r.text()).replace(/\\\//g, "/").replace(/\\u0025/gi, "%").replace(/\\u003[dD]/g, "=").replace(/&amp;/g, "&");
    const re = /https:\/\/[a-z0-9.\-]*scontent[^"'\s)\\]+\.(?:jpg|jpeg|webp)[^"'\s)\\]*/gi;
    let best = "", bestScore = 0, m;
    while ((m = re.exec(text))) {
      const u = m[0];
      if (/static\.|rsrc\.php|\/emoji|safe_image|\/images\//i.test(u)) continue;
      const sz = u.match(/[sp](\d{3,4})x(\d{3,4})/i);
      let score = sz ? (+sz[1]) * (+sz[2]) : (/t39\.30808|t15\./.test(u) ? 90000 : 0);
      if (/t39\.30808/.test(u)) score *= 2;        // prefer the post-photo CDN path
      if (score < 40000) continue;                  // skip avatars/icons (< ~200x200)
      if (score > bestScore) { bestScore = score; best = u; }
    }
    if (best) log("fetchFbInlineImage found a photo for " + url.slice(0, 60));
    return best;
  } catch (e) { return ""; }
}

// One place that turns a Facebook permalink into a delivered card image via
// og:image (no tab, no rendering). Used by BOTH the batch and the single-card
// path. Returns true on success.
async function captureFbByOg(url, id) {
  try {
    let src = "og-fetch";
    let og = await fetchFbOgImage(url);
    if (!og) { await new Promise((r) => setTimeout(r, 2500)); og = await fetchFbOgImage(url); }   // FB sometimes serves a degraded page — retry once
    if (!og) { og = await fetchFbInlineImage(url); if (og) src = "inline"; }   // login-gated post: dig the photo out of the logged-in inline data
    if (!og) return false;
    const data = await fetchAsDataUrl(og);
    if (!data) return false;
    await deliverToApp({ url, id: id || "", screenshot: data, ts: Date.now(), force: false, recap: 1, capsrc: src, extv: FB_CAP_VERSION });
    log("FB og-capture v" + FB_CAP_VERSION + ": " + url.slice(0, 70) + " -> " + Math.round(data.length / 1024) + "KB");
    return true;
  } catch (e) { log("captureFbByOg error: " + e.message); return false; }
}

// helper: Uint8Array/blob -> data URL (no FileReader in the SW)
async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return "data:" + (blob.type || "image/jpeg") + ";base64," + btoa(bin);
}

// captureVisibleTab serialized through the capture lock + with the target tab
// activated first — otherwise a concurrent batch capture (which activates other
// tabs) can hand back a screenshot of the WRONG tab.
async function lockedCaptureVisible(tab, quality) {
  return withCaptureLock(async () => {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: quality || 70 });
  });
}

// Screenshot the visible tab and crop to a region (CSS-pixel rect from the page
// + its devicePixelRatio). Returns a data URL of just that area, or "" on fail.
async function cropScreenshot(tab, rect) {
  try {
    const shot = await lockedCaptureVisible(tab, 75);
    const blob = await (await fetch(shot)).blob();
    const bmp = await createImageBitmap(blob);
    const dpr = rect.dpr || 1;
    // crop the VISIBLE intersection of the post rect with the viewport. rect.x/y
    // can be negative (post scrolled above/left of the viewport) and rect.w/h can
    // exceed it; clamp each edge so we never grab the header/sidebars/next post.
    const vx = Math.max(0, rect.x), vy = Math.max(0, rect.y);
    const vr = Math.min(rect.x + rect.w, bmp.width / dpr);
    const vb = Math.min(rect.y + rect.h, bmp.height / dpr);
    let sx = Math.round(vx * dpr), sy = Math.round(vy * dpr);
    let sw = Math.round((vr - vx) * dpr), sh = Math.round((vb - vy) * dpr);
    sw = Math.min(sw, bmp.width - sx); sh = Math.min(sh, bmp.height - sy);
    if (sw < 40 || sh < 40) return "";   // too small / off-screen — let caller fall back
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    return await blobToDataUrl(out);
  } catch (e) { log("cropScreenshot failed: " + e.message); return ""; }
}

// ---- "Clip this page" — save the current page to the Interests app as a new
// Saved card. Used by the popup button and the right-click context menu.
// opts: { url, desc, title, image, noShot } — image is a preferred card picture
// (e.g. the original Facebook post photo); noShot skips the page screenshot.
// Extract a YouTube video id from a watch / shorts / youtu.be URL ("" if none).
function ytVideoId(u) {
  try {
    const q = new URL(u);
    const host = q.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return q.pathname.slice(1).split(/[/?#]/)[0] || "";
    if (/youtube\.com$/.test(host)) {
      if (q.pathname === "/watch") return q.searchParams.get("v") || "";
      const m = /\/shorts\/([^/?#]+)/.exec(q.pathname);
      if (m) return m[1];
    }
  } catch (e) {}
  return "";
}

async function clipCurrentPage(tab, opts = {}) {
  if (!tab || !tab.url || /^(chrome|chrome-extension|about|edge|view-source):/.test(tab.url)) {
    await setStatus("Cannot clip this page (browser page)", false);
    return { ok: false, error: "Cannot clip this page" };
  }
  // YouTube hijacks right-click on the player and a full-page screenshot is noisy.
  // Use the deterministic public thumbnail as the image instead of a screenshot or
  // the sometimes-missing og:image (that's what showed the thum.io "not authorized").
  const _u = opts.url || (tab && tab.url) || "";
  if (!opts.image) {
    const _yt = ytVideoId(_u);
    if (_yt) opts = Object.assign({}, opts, { image: "https://i.ytimg.com/vi/" + _yt + "/hqdefault.jpg", noShot: true });
  }
  // A right-clicked image on an EXPIRING CDN (Facebook/Instagram signed URLs) must be
  // fetched to a durable data: URL NOW — stored raw it rots in hours/days (the same
  // silent thumbnail-loss class as the saved-clip inline bug). i.ytimg/i.pinimg are
  // durable and left as URLs; fetchAsDataUrl returns "" on failure → keep the URL.
  if (opts.image && /^https?:/i.test(opts.image) && /scontent|cdninstagram|fbcdn/i.test(opts.image) && !/static\.|rsrc\.php/i.test(opts.image)) {
    const durable = await fetchAsDataUrl(opts.image);
    if (durable) opts = Object.assign({}, opts, { image: durable });
  }
  await setStatus("Clipping…", true);
  setBadge("📎");
  // page metadata (title / description / og image)
  let meta = {};
  try { const mr = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); meta = mr?.[0]?.result || {}; }
  catch (e) { log("clip meta failed: " + e.message); }
  // screenshot of the page you're looking at — skipped when we already have the
  // original image (e.g. a Facebook post photo), which avoids capturing the
  // greyed-out page behind the still-open Save menu.
  let shot = "";
  if (!opts.noShot) {
    if (opts.shotDelay) await new Promise((r) => setTimeout(r, opts.shotDelay));
    try { shot = await lockedCaptureVisible(tab, 60); }
    catch (e) { log("clip screenshot failed: " + e.message); }
  }
  const blocked = !!meta.blocked;
  const payload = {
    clip: true,
    url: opts.url || tab.url,
    title: opts.title || meta.title || tab.title || tab.url,
    desc: opts.desc || (blocked ? "" : (meta.desc || "")),
    clipImage: opts.image || "",
    ogImage: blocked ? "" : (meta.ogImage || ""),
    contentImage: blocked ? "" : (meta.contentImage || ""),
    screenshot: shot, ts: Date.now(),
  };
  const delivered = await deliverToApp(payload);
  setBadge(delivered ? "✓" : "…", 4000);
  await setStatus(delivered ? "Clipped to Interests ✓" : "Saved — opens when the Interests app is open", delivered);
  notify("clip-" + Date.now(), "Interests", (delivered ? "Clipped: " : "Saved (open the app): ") + (payload.title || payload.url).slice(0, 70));
  return { ok: true, delivered };
}

// Right-click → "Save to Interests" on any page/link/image/selection.
function ensureContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      chrome.contextMenus.create({
        id: "saveToInterests",
        title: "Save to Interests",
        contexts: ["page", "selection", "link", "image"],
      }, () => { void chrome.runtime.lastError; });   // swallow "duplicate id" when the SW re-creates it
    });
  } catch (e) { log("contextMenu setup failed: " + e.message); }
}
chrome.runtime.onInstalled.addListener(ensureContextMenu);
chrome.runtime.onStartup.addListener(ensureContextMenu);
chrome.runtime.onStartup.addListener(() => { flushQueue().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { flushQueue().catch(() => {}); });
ensureContextMenu();   // also run when the service worker spins up

// === SW-driven single-capture poller (v4.40 proof) ==========================
// The capture DRIVER historically lived in bridge.js, a content script Chrome
// injects ONLY into a localhost:3456 tab. The standalone desktop app is not a
// Chrome tab, so bridge.js never runs and automated capture requests are never
// drained. Drive them from the always-on background service worker instead:
// poll the app's single-capture mailbox and run the EXISTING handleCaptureRequest
// in-SW — the same path the popup already uses. Works whenever Chrome is open
// with the extension, no localhost tab required.
async function pollCaptureRequest() {
  // If the app IS open as a Chrome localhost tab, bridge.js drives it (faster, 800ms);
  // defer to it so we never double-claim/double-capture the same request.
  try { const lt = await chrome.tabs.query({ url: ["http://localhost/*", "http://127.0.0.1/*"] }); if (lt && lt.length) return; } catch (e) {}
  let port; try { port = await findAppPort(); } catch (e) { return; }
  if (port == null) return;
  let req = null;
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/api/capture-request");
    if (r && r.ok) { const j = await r.json(); req = j && j.request; }
  } catch (e) { return; }
  if (!req || !req.url) return;
  try { await fetch("http://127.0.0.1:" + port + "/api/capture-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request: null }) }); } catch (e) {}   // claim it
  if (req.capture === false) { log("SW poller: watch-only request, skipping capture"); return; }
  log("SW poller claimed capture request: " + req.url + (req.render ? " (render)" : "") + (req.force ? " (force/overwrite)" : ""));
  // Use captureOneTab (opens its OWN tab, tracks it by tab-id through redirects, captures, closes)
  // rather than handleCaptureRequest (which matched the app-opened tab by URL and hung on any
  // cross-domain redirect, e.g. dead typepad.com -> networksolutions.com). This is also the single
  // primitive the batch uses, so single + bulk converge on one redirect-safe path.
  // Pass req.force through: a ⟳ refresh sets force:true so the app OVERWRITES the existing image
  // (without force, drainCaptures only fills empty/bad images and the real screenshot is discarded).
  try { await captureOneTab(req.url, req.id || "", (req.delay || 0), !!req.render, !!req.force); }
  catch (e) { log("SW captureOneTab failed: " + (e && e.message)); }
}

// ---- Batch driver (bulk): drain /api/batch-state through captureOneTab so a bulk
// recapture works in the STANDALONE desktop app (no localhost tab). Mirrors the
// proven bridge.js driveBatch/pump loop, but runs in the always-on service worker
// and passes force through (a unified "Recapture" sets force so existing images
// are overwritten). Single (capture-request) + bulk (batch-state) now converge on
// the same redirect-safe, force-aware captureOneTab primitive. Defers to bridge.js
// when a localhost tab is open (same guard as the single poller) to avoid double-driving.
let batchDriving = false;   // re-entrancy guard: the 30s alarm must not start a 2nd loop
async function localhostTabOpen() {
  try { const lt = await chrome.tabs.query({ url: ["http://localhost/*", "http://127.0.0.1/*"] }); return !!(lt && lt.length); } catch (e) { return false; }
}
async function pollBatchState() {
  if (batchDriving) return;
  if (await localhostTabOpen()) return;   // a localhost tab is open → bridge.js drives it
  let port; try { port = await findAppPort(); } catch (e) { return; }
  if (port == null) return;
  const base = "http://127.0.0.1:" + port;
  const getState = async () => { try { const r = await fetch(base + "/api/batch-state"); if (r && r.ok) { const j = await r.json(); return j && j.state; } } catch (e) {} return undefined; };
  const postState = async (state) => { try { await fetch(base + "/api/batch-state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) }); } catch (e) {} };
  const getProg = async () => { try { const r = await fetch(base + "/api/batch-progress"); if (r && r.ok) { const j = await r.json(); return j && j.progress; } } catch (e) {} return undefined; };
  const postProg = async (done, total, active) => { try { await fetch(base + "/api/batch-progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ progress: { done, total, active, ts: Date.now() } }) }); } catch (e) {} };

  const st = await getState();
  if (!st || !st.items || !st.items.length || st.active === false || st.cancel) return;
  const total = st.items.length;
  // Resume cursor lives in PROGRESS (done), NOT in batch-state: the worker must never write
  // batch-state, otherwise a write could resurrect active:true and clobber the app's Stop.
  // The app clears progress (setBatchProgress(null)) when starting a new batch, so a stale
  // cursor can't leak across runs. Only count progress as ours if it matches this batch.
  let done = 0;
  const p0 = await getProg();
  if (p0 && p0.total === total && (p0.done || 0) <= total) done = p0.done || 0;
  let next = done;
  if (next >= total) { await postState(null); return; }

  batchDriving = true;
  log("SW batch driver: " + total + " item(s) from " + next + (st.force ? " (force/overwrite)" : ""));
  try {
    while (next < total) {
      // re-read state each item so the app's Stop (active:false/cancel) halts promptly,
      // and re-check for a localhost tab appearing mid-run (then defer to bridge.js).
      const cur = await getState();
      if (!cur || !cur.items || cur.active === false || cur.cancel) { log("SW batch driver: stopped by app"); break; }
      if (await localhostTabOpen()) { log("SW batch driver: localhost tab appeared — deferring to bridge.js"); break; }
      if (next >= cur.items.length) break;
      const it = cur.items[next] || {};
      const delay = (it.delay != null) ? it.delay : (cur.delay || 0);
      const render = (it.render != null) ? !!it.render : !!cur.render;
      const force = (it.force != null) ? !!it.force : !!cur.force;
      try { await captureOneTab(it.url, it.id || "", delay, render, force); }
      catch (e) { log("SW batch item failed: " + (e && e.message)); }
      next++; done++;
      // persist the cursor in PROGRESS only (never batch-state) so a SW suspension resumes here
      await postProg(done, total, true);
      if (delay && next < total) await new Promise((r) => setTimeout(r, delay));
    }
    if (next >= total) { await postState(null); log("SW batch driver finished " + done + "/" + total); }   // fully done → clear the mailbox
    await postProg(done, total, false);   // mark progress inactive (app owns batch-state's active/cancel on a Stop)
  } finally { batchDriving = false; }
}

function iaPollAll() { pollCaptureRequest().catch(() => {}); pollBatchState().catch(() => {}); }
try {
  chrome.alarms.create("iaCapturePoll", { periodInMinutes: 0.5 });   // 30s is the MV3 minimum period
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === "iaCapturePoll") iaPollAll(); });
} catch (e) { log("alarms unavailable: " + (e && e.message)); }
chrome.runtime.onStartup.addListener(iaPollAll);
chrome.runtime.onInstalled.addListener(iaPollAll);
iaPollAll();   // poll once on SW spin-up

log("background service worker loaded — FB capture v" + FB_CAP_VERSION);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "saveToInterests") return;
  let host = "";
  try { host = new URL(tab && tab.url).hostname; } catch (e) {}
  const isYouTube = /youtube\.com|youtu\.be/i.test(host);
  const genericClip = () => clipCurrentPage(tab, {
    url: info.linkUrl || info.pageUrl || (tab && tab.url),
    image: info.srcUrl || undefined,   // a directly right-clicked image, if any
    // Never full-page-screenshot YouTube — the YouTube branch in clipCurrentPage
    // derives the i.ytimg thumbnail from the URL (clean placeholder otherwise).
    noShot: !!info.srcUrl || isYouTube,
    desc: (info.selectionText || "").trim() || undefined,
  });
  // On capture-engine sites (Pinterest/FB/IG/YouTube), capture the POST under the
  // cursor the SAME way the native Save button does — the in-page engine finds the
  // pin/post/video + its photo + permalink — instead of a full-page screenshot.
  // Fall back to the generic page clip if no post can be identified there.
  if (/facebook\.com|instagram\.com|pinterest\.|youtube\.com/i.test(host)) {
    try {
      chrome.tabs.sendMessage(tab.id, { action: "captureCtxPost" }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) genericClip();
      });
    } catch (e) { genericClip(); }
    return;
  }
  genericClip();
});

async function captureTab(tab, delayMs, force, cardId) {
  const tabId = tab.id;
  const tabUrl = tab.url;
  const windowId = tab.windowId;
  const delay = typeof delayMs === "number" ? delayMs : DEFAULT_DELAY_MS;
  log("Capturing " + tabUrl + " with " + delay + "ms delay" + (force ? " (force)" : ""));
  await setStatus("Capturing…", true);

  if (delay > 0) {
    setBadge("⏳");
    await new Promise((r) => setTimeout(r, delay));
  }

  setBadge("...");

  try {
    let meta = {};
    try {
      const metaResults = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      meta = metaResults?.[0]?.result || {};
      log("Metadata: title=" + (meta.title || "(none)") + " ogImage=" + (meta.ogImage ? "yes" : "no"));
    } catch (e) {
      log("Metadata extraction failed: " + e.message);
    }

    const blocked = !!meta.blocked;
    let screenshot = "";
    if (blocked) {
      log("Page is a block/challenge screen — skipping screenshot & metadata");
    } else {
      try {
        // serialize: only one tab can be the "visible" capture target at a time
        screenshot = await withCaptureLock(async () => {
          try { await chrome.windows.update(windowId, { focused: true }); } catch (e) {}
          try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
          await new Promise((r) => setTimeout(r, 150));
          // bound the capture so a stuck tab can never hang the pipeline
          return await Promise.race([
            chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 60 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("capture timeout")), 8000)),
          ]);
        });
        log("Screenshot captured (" + Math.round(screenshot.length / 1024) + "KB)");
      } catch (e) {
        log("Screenshot failed: " + e.message);
      }
    }

    // A blocked page still sends a (mostly empty) capture so the app can clear
    // any stale block-page image; otherwise report a failed attempt so the app
    // records it and won't auto-retry the card.
    if (!blocked && !meta.ogImage && !meta.contentImage && !screenshot) {
      setBadge("!", 5000);
      await setStatus("No image found (marked attempted)", false);
      await deliverToApp({ url: tabUrl, id: cardId || "", attempt: true, ok: false, ts: Date.now() });
      return false;
    }

    const capture = {
      url: tabUrl,
      title: blocked ? "" : (meta.title || ""),
      desc: blocked ? "" : (meta.desc || ""),
      ogImage: blocked ? "" : (meta.ogImage || ""),
      contentImage: blocked ? "" : (meta.contentImage || ""),
      screenshot,
      blocked,
      ts: Date.now(),
      force: !!force,
      id: cardId || "",
    };

    // Deliver over HTTP; deliverToApp owns the offline-queue fallback.
    const delivered = await deliverToApp(capture);

    setBadge(blocked ? "⚠" : "✓", 4000);
    const dest = delivered ? "sent to app" : "app closed — queued";
    if (blocked) {
      await setStatus("Site blocked the page — cleared bad image (" + dest + ")", true);
    } else {
      const shotKb = screenshot ? Math.round(screenshot.length / 1024) + "KB shot" : "no shot";
      await setStatus("Captured ✓ — " + dest + " (" + (meta.ogImage ? "og image" : shotKb) + ")", true);
    }

    notify("cap-" + Date.now(), "Interests Capture", blocked ? "Site blocked the page — cleared the bad image" : ("Captured: " + (meta.title || tabUrl).slice(0, 60)));

    if (!blocked) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const d = document.createElement("div");
            d.textContent = "✓ Captured for Interests";
            d.style.cssText =
              "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;padding:12px 20px;border-radius:10px;font:600 14px/1 system-ui,sans-serif;transition:opacity .5s;opacity:1;pointer-events:none";
            document.body.appendChild(d);
            setTimeout(() => { d.style.opacity = "0"; }, 2000);
            setTimeout(() => d.remove(), 2600);
          },
        });
      } catch (e) {}
    }

    return true;
  } catch (e) {
    log("Capture pipeline failed: " + e.message);
    setBadge("!", 5000);
    await setStatus("Failed: " + e.message, false);
    return false;
  }
}

async function handleCaptureRequest(req) {
  if (pendingRequest) {
    log("Already have a pending request, ignoring");
    return;
  }

  // Facebook: capture via og:image fetch — no rendered page needed. If it works
  // we're done; close the tab the app opened for this URL (if any).
  if (req.capture !== false && /facebook\.com|fb\.watch/i.test(req.url || "")) {
    // render mode (single ↻ on a restricted post): open a focused popup window and
    // render-capture it like a manual Save. og is tried first inside renderCaptureFb.
    if (req.render) { await renderCaptureFb(req.url, req.id, req.delay); return; }
    if (await captureFbByOg(req.url, req.id)) {
      setBadge("✓", 3000); await setStatus("Facebook captured ✓ (no render needed)", true);
    } else {
      // no og:image (restricted) → mark attempted; never fall back to a tab/spinner
      await deliverToApp({ url: req.url, id: req.id || "", attempt: true, ok: false, ts: Date.now() });
      setBadge("!", 3000); await setStatus("Facebook: no og:image (restricted post) — left for manual", false);
    }
    // close the tab only if this was a ↻ refresh (closeAfter) — not a card you opened to read
    if (req.closeAfter) { try { const ts = await chrome.tabs.query({}); const t = ts.find(x => x.url && normalizeUrl(x.url) === normalizeUrl(req.url)); if (t) await closeTabSafe(t.id); } catch (e) {} }
    return;
  }

  log("Received capture request for: " + req.url + (req.force ? " (refresh)" : "") + (req.capture===false ? " (watch only)" : ""));
  pendingRequest = { url: req.url, delay: req.delay, id: req.id || "", force: !!req.force, capture: req.capture!==false, closeAfter: !!req.closeAfter };
  // remember recently-opened cards so a navigation error can be matched even if
  // it fires before/after the pending request is set
  recentWatches.push({ url: req.url, id: req.id || "", ts: Date.now() });
  recentWatches = recentWatches.filter(w => Date.now()-w.ts < 90000).slice(-12);
  setBadge("⏳");
  await setStatus("Waiting for page to load…", true);

  // already-loaded race: the page may have finished before this request arrived
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(t => t.url && !/^(chrome|chrome-extension|about|edge):/.test(t.url) && normalizeUrl(t.url) === normalizeUrl(req.url));
  if (tab && tab.status === "complete") {
    log("Matching tab already loaded: " + tab.id);
    await finishPending(tab);
    return;
  }

  log("Waiting for page load (webNavigation.onCompleted)...");
  pendingTimer = setTimeout(() => {
    log("Capture request timed out: " + pendingRequest?.url);
    pendingRequest = null;
    setBadge("", 0);
    setStatus("Timed out waiting for the page", false);
  }, REQUEST_TIMEOUT_MS);
}

// run the pending request against a now-loaded tab (capture, or finish watch-only)
async function finishPending(tab) {
  if (!pendingRequest) return;
  clearTimeout(pendingTimer);
  const { url, delay, id, force, capture, closeAfter } = pendingRequest;
  pendingRequest = null;
  if (capture) {
    // Facebook pages can't be screenshotted whole (chrome/login wall) — capture
    // the POST AREA via the in-page engine, exactly like the FB batch does.
    if (/facebook\.com|fb\.watch/i.test(url || tab.url || "")) await captureFbPost(tab, url, delay, id);
    else await captureTab(tab, delay, force, id);
  }
  else { setBadge("", 0); await setStatus("Page reached — nothing to capture", true); }
  // refresh requests ask us to close the page once we're done with it (the app
  // opened it via window.open, but chrome.tabs.remove is far more reliable than
  // a cross-origin window.close())
  if (closeAfter && tab && tab.id != null) await closeTabSafe(tab.id);
}

// onCompleted fires reliably when the document finishes loading (more robust
// than tab.status, which can stay "loading" on pages with open connections)
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!details.url || /^(chrome|chrome-extension|about|edge):/.test(details.url)) return;
  // batch capture: a tab we opened finished loading (match by tab identity,
  // not URL, so redirects don't stall it)
  if (pendings[details.tabId] && !pendings[details.tabId].settled) {
    await capturePending(details.tabId);
    return;
  }
  if (!pendingRequest) return;
  if (normalizeUrl(details.url) !== normalizeUrl(pendingRequest.url)) return;
  let tab; try { tab = await chrome.tabs.get(details.tabId); } catch (e) { return; }
  log("Page loaded for pending request: " + details.url);
  await finishPending(tab);
});

// Detect genuinely unreachable sites (DNS failure, connection refused, etc.)
// and tell the app to remove that card. Only hard network errors — not 404s
// (those "load" fine) and not user-side issues (offline, aborted).
const HARD_ERR = /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_SSL_PROTOCOL_ERROR|ERR_CERT_/i;
// "Dead post" notices are ordinary capture objects (cap.dead) — deliver them the
// same way, with the same HTTP + offline-queue fallback.
async function deliverDead(dead) {
  return await deliverToApp(dead);
}
// close a browser tab, but never the app tab (localhost) or a browser page
async function closeTabSafe(tabId){
  if (typeof tabId !== "number" || tabId < 0) return;
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t || !t.url) return;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(t.url)) return;
    if (/^(chrome|chrome-extension|about|edge):/.test(t.url)) return;
    await chrome.tabs.remove(tabId);
    log("Closed tab for removed card: " + t.url);
  } catch (e) {}
}
async function reportDead(url, reason, tabId){
  const match = recentWatches.find(w => normalizeUrl(w.url) === normalizeUrl(url));
  if (!match) return;                                 // only cards the user just opened
  log("Dead (" + reason + "): " + url);
  recentWatches = recentWatches.filter(w => w !== match);
  if (pendingRequest && normalizeUrl(pendingRequest.url) === normalizeUrl(url)) { clearTimeout(pendingTimer); pendingRequest = null; }
  setBadge("✕", 5000);
  await setStatus("Removing card + closing tab — " + reason, false);
  await deliverDead({ url: match.url, id: match.id, dead: true, error: reason, ts: Date.now() });
  await closeTabSafe(tabId);
  // settle the in-flight batch item for this tab (dead links are removed + counted)
  settlePending(tabId, "dead");
}
/* ============ batch capture (one item per call) ============
   The LOOP is driven by the page-side bridge (a stable context). The service
   worker handles ONE captureOneTab per message — short enough to finish before
   the SW can be suspended. Up to `concurrency` run at once; `pendings` tracks
   each in-flight tab so onCompleted/reportDead settle the right one. */
let pendings = {};   // tabId -> pending
function settlePending(tabId, why) {
  const p = pendings[tabId];
  if (!p || p.settled) return;
  p.settled = true; clearTimeout(p.fb); clearTimeout(p.wd); delete pendings[tabId];
  p.resolve(why);
}
// Batch capture for a Facebook post: the page's own screenshot would grab FB's
// chrome/sidebars (or a login wall), so instead ask the in-page capture engine
// to find + measure the MAIN post, then build a durable card image from it (the
// post's own photo, or a crop of the post area). Delivered tagged with the card
// id so drainCaptures updates the existing imported card (not a new clip).
async function captureFbPost(tab, cardUrl, delayMs, cardId, suppressFail) {
  const tabId = tab.id, tabUrl = tab.url || cardUrl;
  // give the in-page content script time to load + the post time to render before
  // we message it (the engine then polls until the post is actually present)
  const delay = Math.max(typeof delayMs === "number" ? delayMs : DEFAULT_DELAY_MS, 1500);
  log("FB post capture: " + (cardUrl || tabUrl) + " (delay " + delay + ")");
  await setStatus("Capturing Facebook post…", true);
  // Make the tab genuinely VISIBLE + its window FOCUSED before we wait. Facebook
  // lazy-loads the post photo only when the tab is actually being viewed; an
  // unfocused/background tab serves just the loading spinner (the auto-capture
  // bug — manual works because YOU have the post focused when you click Save).
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
  try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
  setBadge("⏳");
  await new Promise((r) => setTimeout(r, delay));
  setBadge("...");
  let info = null;
  for (let attempt = 0; attempt < 2 && !(info && (info.ok || info.dead)); attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1800));   // content script not ready yet — wait & retry once
    try { info = await chrome.tabs.sendMessage(tabId, { action: "autoCaptureFB" }); }
    catch (e) { log("autoCaptureFB message failed (try " + (attempt + 1) + "): " + e.message); info = null; }
  }
  // Deleted / restricted post ("This content isn't available") → REMOVE the card
  // (drainCaptures handles cap.dead); the batch then moves on to the next.
  if (info && info.dead) {
    await deliverToApp({ url: cardUrl || tabUrl, id: cardId || "", dead: true, error: "content unavailable", ts: Date.now() });
    setBadge("✕", 4000);
    await setStatus("Facebook post unavailable/deleted — removed the card", false);
    return "dead";
  }
  let imgData = "", capsrc = "none";
  if (info && info.ok) {
    if (info.image) { imgData = await fetchAsDataUrl(info.image); if (imgData) capsrc = info.imgSrc || "photo"; }   // post photo / video thumbnail (og:image), full-res, durable
    if (!imgData && info.rect && info.rect.w > 40 && info.rect.h > 40) {
      // No photo URL → crop the POST area (e.g. a text/quote post on a gradient). But
      // a still-loading photo post shows an ANIMATED spinner; crop twice ~1.2s apart
      // and keep it ONLY if byte-identical (static = a real text post; different =
      // spinner → reject, leave the card for a manual Save). This is what stops the
      // gradient-blob spinner from being captured.
      const cropA = await cropScreenshot(tab, info.rect);
      await new Promise((r) => setTimeout(r, 1200));
      const cropB = await cropScreenshot(tab, info.rect);
      if (cropA && cropB && cropA === cropB) { imgData = cropA; capsrc = "crop"; }
      else { log("FB crop unstable (animating/spinner) — skipping: " + (cardUrl || tabUrl)); }
    }
  }
  log("FB capture: " + (cardUrl || tabUrl) + " -> src=" + capsrc + " size=" + (imgData ? Math.round(imgData.length / 1024) + "KB" : "0"));
  if (!imgData) {
    // suppressFail: caller will retry — don't mark the card attempted yet (that's
    // delivered once, after the final try, by renderCaptureFb).
    if (!suppressFail) {
      await deliverToApp({ url: cardUrl || tabUrl, id: cardId || "", attempt: true, ok: false, ts: Date.now() });
      setBadge("!", 4000);
      await setStatus("Facebook post — no image found (marked attempted; stay logged in / a group member)", false);
    }
    return false;
  }
  await deliverToApp({
    url: cardUrl || tabUrl, id: cardId || "",
    title: (info && info.title) || "", desc: (info && (info.text || info.author)) || "",
    screenshot: imgData, ts: Date.now(), force: false, recap: 1, capsrc: capsrc, extv: FB_CAP_VERSION,   // deliberate re-capture: overwrite even a non-"bad" stored image (e.g. an old spinner)
  });
  setBadge("✓", 4000);
  await setStatus("Facebook post captured ✓", true);
  return true;
}
// resolve once a tab finishes loading (or after a timeout — captureFbPost then
// waits + polls on its own, so a slow tab still gets a fair shot)
function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {} resolve(); };
    function onUpd(tid, info) { if (tid === tabId && info.status === "complete") finish(); }
    try { chrome.tabs.onUpdated.addListener(onUpd); } catch (e) {}
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === "complete") finish(); }).catch(() => {});
    setTimeout(finish, timeoutMs || 30000);
  });
}
// Automated version of the manual "Refresh → Save to Interests" flow for a
// restricted Facebook post: open the permalink in a real foreground TAB (FB only
// renders the post photo into a visible tab — a hidden tab serves the spinner),
// run the in-page capture engine (captureFbPost), deliver the image tagged with
// the card id, then close the tab. Renders FIRST so deleted/unavailable posts are
// detected + removed (og-fetch alone can't tell); og:image is only a fallback when
// render finds no photo. Retries up to 3× (wait 5s + reload) then moves on. Serialized.
const RENDER_MAX_TRIES = 3;
const RENDER_RETRY_WAIT_MS = 5000;
let fbRenderBusy = false;
async function renderCaptureFb(url, id, delayMs) {
  // a render is already in flight (e.g. a single ↻ racing the batch) — leave the
  // card untouched (still pending / in the retry set), never mark it failed.
  if (fbRenderBusy) return "busy";
  fbRenderBusy = true;
  let tabId = null;
  try {
    // RENDER FIRST — do NOT trust og-fetch first. Only the rendered page reveals a
    // deleted/unavailable post; og-fetch can return a stale/generic image and falsely
    // "capture" a dead post (the "captured ✓ no render needed" bug). captureFbPost
    // detects FB's "content isn't available" interstitial and returns "dead" → remove.
    let tab = null;
    try { tab = await chrome.tabs.create({ url, active: true }); } catch (e) { /* fall back to og below */ }
    if (tab && tab.id != null) {
      tabId = tab.id;
      batchTabs.add(tabId);   // safety-net sweep at end of run
      try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (e) {}
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}   // load it VISIBLY so the photo lazy-loads
      await waitTabComplete(tabId, (delayMs || 0) + 30000);
      // Up to RENDER_MAX_TRIES, RELOAD + wait 5s between tries; stop the moment one
      // lands an image or the post is detected deleted. captureFbPost never crops a spinner.
      for (let attempt = 1; attempt <= RENDER_MAX_TRIES; attempt++) {
        if (attempt > 1) {
          await new Promise((r) => setTimeout(r, RENDER_RETRY_WAIT_MS));   // wait 5s before re-attempting (per request)
          try { await chrome.tabs.reload(tabId); } catch (e) {}
          await new Promise((r) => setTimeout(r, 1500));   // let the reload flip to "loading" before we wait for "complete"
          await waitTabComplete(tabId, (delayMs || 0) + 30000);
        }
        let res = false;
        try { const t = await chrome.tabs.get(tabId); res = await captureFbPost(t, url, delayMs, id, true); }   // suppressFail: don't mark attempted between tries
        catch (e) { res = false; }
        if (res === "dead") return "dead";        // deleted/unavailable interstitial → card removed
        if (res) return "captured";               // got a real image
        log("FB render try " + attempt + "/" + RENDER_MAX_TRIES + " — no image yet: " + url);
      }
    }
    // Render found no image AND the post isn't a dead interstitial → try the fast
    // og:image fetch as a last resort (covers live posts whose photo won't render).
    if (await captureFbByOg(url, id)) return "captured";
    await deliverToApp({ url, id, attempt: true, ok: false, ts: Date.now() });   // truly nothing → leave for a manual Save
    return "done";
  } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (e) {} batchTabs.delete(tabId); }
    fbRenderBusy = false;
    await focusAppTab();   // hand focus back to the app between captures
  }
}
async function capturePending(tabId) {   // capture whatever's loaded, then settle
  const p = pendings[tabId];
  if (!p || p.settled) return;
  p.settled = true; clearTimeout(p.fb); clearTimeout(p.wd);
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && !/^(chrome|chrome-extension|about|edge):/.test(t.url || "")) {
      if (/facebook\.com|fb\.watch/i.test(p.url || t.url || "")) await captureFbPost(t, p.url, p.delay, p.id);
      else await captureTab(t, p.delay, !!p.force, p.id);   // honor the request's force flag (⟳ refresh = overwrite)
    }
  } catch (e) {}
  delete pendings[tabId];
  p.resolve("captured");
}
const batchTabs = new Set();   // every tab the batch opens — swept at end as a safety net
async function captureOneTab(url, id, delay, render, force) {
  // Facebook FIRST: pull og:image from the raw server HTML and fetch it — NO tab.
  // This avoids the cold-render spinner entirely (the rendered page never paints
  // the photo, esp. for videos), keeps the app focused, and is fast. Falls through
  // to opening a tab only if there's no og:image (e.g. a private post).
  if (/facebook\.com|fb\.watch/i.test(url || "")) {
    // render mode (Couldn't-capture retry): og first, then a focused popup window
    // render-capture for the restricted posts og can't reach.
    if (render) return await renderCaptureFb(url, id, delay);
    if (await captureFbByOg(url, id)) return "captured";   // no tab — fetch og:image directly
    // No og:image (restricted/login-gated post) → mark attempted and STOP. Never
    // open a tab for FB: the rendered page only shows a spinner placeholder, which
    // is worse than leaving the card clean for a manual save.
    await deliverToApp({ url, id, attempt: true, ok: false, ts: Date.now() });
    return "captured";
  }
  let tab;
  // FOREGROUND tab. Non-FB pages need it to screenshot; FB needs it too because
  // Facebook only loads the post photo when the tab is visible (a hidden tab
  // serves just the loading spinner). The app regains focus between captures /
  // during the auto pause. autoDiscardable:false keeps it alive while we work.
  try { tab = await chrome.tabs.create({ url, active: true }); }
  catch (e) { await deliverToApp({ url, id, attempt: true, ok: false, ts: Date.now() }); return "tab-fail"; }
  const tabId = tab.id;
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (e) {}  // belt & suspenders: never discard mid-capture
  batchTabs.add(tabId);
  recentWatches.push({ url, id, ts: Date.now() });
  recentWatches = recentWatches.filter(w => Date.now() - w.ts < 180000).slice(-60);
  const outcome = await new Promise((resolve) => {
    pendings[tabId] = {
      url, id, delay: delay || 0, force: !!force, settled: false, resolve,
      fb: setTimeout(() => { capturePending(tabId); }, (delay || 0) + 15000),   // page never fired load → grab what's there
      wd: setTimeout(() => settlePending(tabId, "watchdog"), (delay || 0) + 45000),  // hard give-up
    };
  });
  try { await chrome.tabs.remove(tabId); batchTabs.delete(tabId); } catch (e) { /* removal failed — leave it for the end-of-run sweep */ }
  if (outcome === "watchdog") await deliverToApp({ url, id, attempt: true, ok: false, ts: Date.now() });  // never loaded → mark attempted
  return outcome;
}
// bring the Interests app tab back to the front (after a batch, so the user lands
// on the app during the pause rather than on a leftover capture tab)
async function focusAppTab() {
  try {
    const tabs = await chrome.tabs.query({});
    const app = tabs.find((t) => t.url && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(t.url));
    if (app) { try { await chrome.windows.update(app.windowId, { focused: true }); } catch (e) {} await chrome.tabs.update(app.id, { active: true }); }
  } catch (e) {}
}
// close any tabs the batch opened but didn't manage to close (e.g. the worker
// was suspended between capturing and removing a heavy page like YouTube)
async function sweepBatchTabs() {
  for (const tid of [...batchTabs]) { try { await chrome.tabs.remove(tid); } catch (e) {} batchTabs.delete(tid); }
}

// network-level failure (DNS, connection refused/reset/timeout, cert)
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;                  // main frame only
  if (!HARD_ERR.test(details.error || "")) return;    // only definitive "can't reach" errors
  reportDead(details.url, details.error, details.tabId);
});
// HTTP-level "page gone" — 404 Not Found / 410 Gone (page loads, so the
// navigation API can't see it; webRequest exposes the status code)
const DEAD_STATUS = new Set([404, 410]);
chrome.webRequest.onCompleted.addListener((details) => {
  if (details.type !== "main_frame") return;
  if (!DEAD_STATUS.has(details.statusCode)) return;
  reportDead(details.url, "HTTP " + details.statusCode, details.tabId);
}, { urls: ["<all_urls>"], types: ["main_frame"] });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "captureRequest" && msg.data) {
    handleCaptureRequest(msg.data);
  }

  if (msg.action === "captureOneTab" && msg.data) {
    (async () => {
      try { const outcome = await captureOneTab(msg.data.url, msg.data.id, msg.data.delay, msg.data.render); sendResponse({ ok: true, outcome }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.action === "cleanupBatch") {
    (async () => { await sweepBatchTabs(); await focusAppTab(); sendResponse({ ok: true }); })();   // land back on the app after the batch
    return true;
  }

  if (msg.action === "manualCapture") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) {
          await setStatus("Cannot capture this page (browser page)", false);
          sendResponse({ ok: false, error: "Cannot capture this page" });
          return;
        }
        const ok = await captureTab(tab, 0, true);
        sendResponse({ ok });
      } catch (e) {
        await setStatus("Failed: " + e.message, false);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "clipPage") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const res = await clipCurrentPage(tab);
        sendResponse(res);
      } catch (e) {
        await setStatus("Clip failed: " + e.message, false);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if ((msg.action === "clipFacebookPost" || msg.action === "clipSocialPost") && msg.data) {
    (async () => {
      try {
        const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        const d = msg.data;
        // YouTube: the deterministic public thumbnail beats a scraped tile image.
        if (/youtube\.com|youtu\.be/i.test(d.url || "")) { const _yt = ytVideoId(d.url); if (_yt) d.image = "https://i.ytimg.com/vi/" + _yt + "/hqdefault.jpg"; }
        // Build the card image, ordered by the config's strategy. All results
        // are durable data URLs (CDN URLs expire, so we never store them raw).
        //   "photo"  (Facebook): the post's own photo first — ignores the
        //            "Save To" dialog floating over the post; crop is fallback.
        //   "region" (default): crop the post rectangle first.
        const tryPhoto = function () { return d.image ? fetchAsDataUrl(d.image) : Promise.resolve(""); };
        const tryCrop = function () { return (d.rect && d.rect.w > 40 && d.rect.h > 40) ? cropScreenshot(tab, d.rect) : Promise.resolve(""); };
        let imgData = "";
        if (d.strategy === "photo") { imgData = await tryPhoto(); if (!imgData) imgData = await tryCrop(); }
        else { imgData = await tryCrop(); if (!imgData) imgData = await tryPhoto(); }
        const res = await clipCurrentPage(tab, {
          url: d.url || d.pageUrl,
          title: d.title,
          desc: (d.text || d.author || "").trim() || undefined,
          image: imgData,                 // post-area crop (or photo) as a data URL
          noShot: !!imgData,              // got an image, skip the full screenshot
          shotDelay: imgData ? 0 : 700,   // none: let the menu close, then screenshot
        });
        sendResponse(res);
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.action === "removeCard") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = (tab && tab.url) || "";
        // remove the card matching this page's URL, or fall back to the
        // last-opened ("active") card in the app
        await deliverDead({ url, id: "", dead: true, removeActive: true, error: "removed by user", ts: Date.now() });
        await setStatus("Removed card from Interests + closing tab", true);
        sendResponse({ ok: true });
        if (tab && tab.id != null) await closeTabSafe(tab.id);   // close the page tab
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "getQueue") {
    (async () => {
      const stored = await chrome.storage.local.get("ia_capture_queue");
      sendResponse({ queue: stored.ia_capture_queue || [] });
    })();
    return true;
  }

  if (msg.action === "getStatus") {
    (async () => {
      const stored = await chrome.storage.local.get(["ia_capture_queue", "ia_last_status"]);
      sendResponse({
        queue: (stored.ia_capture_queue || []).length,
        status: stored.ia_last_status || null,
      });
    })();
    return true;
  }

  if (msg.action === "clearQueue") {
    chrome.storage.local.set({ ia_capture_queue: [] });
    log("Queue cleared by app");
  }
});
