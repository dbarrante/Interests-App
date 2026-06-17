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

// Write the capture straight into the app tab's localStorage (we hold
// <all_urls>, so this works on localhost/127.0.0.1). Returns true if at
// least one app tab received it.
async function deliverToApp(capture) {
  const tabs = await chrome.tabs.query({});
  let delivered = false;
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(tab.url)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (cap) => {
          function norm(u){ try{ const p=new URL(u); return (p.hostname.replace(/^www\./,"")+p.pathname).replace(/\/$/,"").toLowerCase(); }catch(e){ return u.toLowerCase(); } }
          let q = [];
          try { const r = localStorage.getItem("ia_captures"); if (r) q = JSON.parse(r); } catch (e) {}
          if (!Array.isArray(q)) q = [];
          q = q.filter((c) => norm(c.url) !== norm(cap.url));
          q.push(cap);
          localStorage.setItem("ia_captures", JSON.stringify(q));
        },
        args: [capture],
      });
      delivered = true;
      log("Delivered capture to app tab " + tab.id);
    } catch (e) {
      log("Delivery to tab " + tab.id + " failed: " + e.message);
    }
  }
  return delivered;
}

// ---- "Clip this page" — save the current page to the Interests app as a new
// Saved card. Used by the popup button and the right-click context menu.
// opts: { url, desc, title } override the page defaults (e.g. a right-clicked
// link's URL, or selected text as the description).
async function clipCurrentPage(tab, opts = {}) {
  if (!tab || !tab.url || /^(chrome|chrome-extension|about|edge|view-source):/.test(tab.url)) {
    await setStatus("Cannot clip this page (browser page)", false);
    return { ok: false, error: "Cannot clip this page" };
  }
  await setStatus("Clipping…", true);
  setBadge("📎");
  // page metadata (title / description / og image)
  let meta = {};
  try { const mr = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); meta = mr?.[0]?.result || {}; }
  catch (e) { log("clip meta failed: " + e.message); }
  // screenshot of the page you're looking at (it's the active/foreground tab)
  let shot = "";
  try { shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 }); }
  catch (e) { log("clip screenshot failed: " + e.message); }
  const blocked = !!meta.blocked;
  const payload = {
    clip: true,
    url: opts.url || tab.url,
    title: opts.title || meta.title || tab.title || tab.url,
    desc: opts.desc || (blocked ? "" : (meta.desc || "")),
    ogImage: blocked ? "" : (meta.ogImage || ""),
    contentImage: blocked ? "" : (meta.contentImage || ""),
    screenshot: shot, ts: Date.now(),
  };
  const delivered = await deliverToApp(payload);
  if (!delivered) {
    // app tab isn't open — stash for the bridge to sync when it next loads
    const stored = await chrome.storage.local.get("ia_capture_queue");
    let queue = stored.ia_capture_queue || [];
    queue.push(payload);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    await chrome.storage.local.set({ ia_capture_queue: queue });
  }
  setBadge(delivered ? "✓" : "…", 4000);
  await setStatus(delivered ? "Clipped to Interests ✓" : "Saved — opens when the Interests app is open", delivered);
  try {
    chrome.notifications.create("clip-" + Date.now(), {
      type: "basic", iconUrl: "icon128.png", title: "Interests",
      message: (delivered ? "Clipped: " : "Saved (open the app): ") + (payload.title || payload.url).slice(0, 70),
      silent: true,
    });
  } catch (e) {}
  return { ok: true, delivered };
}

// Right-click → "Save to Interests" on any page/link/image/selection.
function ensureContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "saveToInterests",
        title: "Save to Interests",
        contexts: ["page", "selection", "link", "image"],
      });
    });
  } catch (e) { log("contextMenu setup failed: " + e.message); }
}
chrome.runtime.onInstalled.addListener(ensureContextMenu);
chrome.runtime.onStartup.addListener(ensureContextMenu);
ensureContextMenu();   // also run when the service worker spins up
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "saveToInterests") return;
  // a right-clicked link saves that link; selected text becomes the description
  clipCurrentPage(tab, {
    url: info.linkUrl || info.pageUrl || (tab && tab.url),
    desc: (info.selectionText || "").trim() || undefined,
  });
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

    // Primary path: write straight into the open app tab's localStorage.
    const delivered = await deliverToApp(capture);
    // Fallback: if the app isn't open, stash for the bridge to pick up later.
    if (!delivered) {
      const stored = await chrome.storage.local.get("ia_capture_queue");
      let queue = stored.ia_capture_queue || [];
      queue = queue.filter((c) => normalizeUrl(c.url) !== normalizeUrl(capture.url));
      queue.push(capture);
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      await chrome.storage.local.set({ ia_capture_queue: queue });
      log("App not open — stashed capture (" + queue.length + " in queue)");
    }

    setBadge(blocked ? "⚠" : "✓", 4000);
    const dest = delivered ? "sent to app" : "app closed — queued";
    if (blocked) {
      await setStatus("Site blocked the page — cleared bad image (" + dest + ")", true);
    } else {
      const shotKb = screenshot ? Math.round(screenshot.length / 1024) + "KB shot" : "no shot";
      await setStatus("Captured ✓ — " + dest + " (" + (meta.ogImage ? "og image" : shotKb) + ")", true);
    }

    try {
      chrome.notifications.create("cap-" + Date.now(), {
        type: "basic",
        iconUrl: "icon128.png",
        title: "Interests Capture",
        message: blocked ? "Site blocked the page — cleared the bad image" : ("Captured: " + (meta.title || tabUrl).slice(0, 60)),
        silent: true,
      });
    } catch (e) {
      log("Notification failed: " + e.message);
    }

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
  const { delay, id, force, capture, closeAfter } = pendingRequest;
  pendingRequest = null;
  if (capture) await captureTab(tab, delay, force, id);
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
async function deliverDead(dead){
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(tab.url)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (d) => {
          let q=[]; try{ const r=localStorage.getItem("ia_captures"); if(r) q=JSON.parse(r); }catch(e){}
          if(!Array.isArray(q)) q=[];
          q.push(d);
          localStorage.setItem("ia_captures", JSON.stringify(q));
        },
        args: [dead],
      });
      return true;
    } catch (e) {}
  }
  await chrome.storage.local.set({ pendingCapture: dead });
  return false;
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
async function capturePending(tabId) {   // capture whatever's loaded, then settle
  const p = pendings[tabId];
  if (!p || p.settled) return;
  p.settled = true; clearTimeout(p.fb); clearTimeout(p.wd);
  try { const t = await chrome.tabs.get(tabId); if (t && !/^(chrome|chrome-extension|about|edge):/.test(t.url || "")) await captureTab(t, p.delay, false, p.id); } catch (e) {}
  delete pendings[tabId];
  p.resolve("captured");
}
const batchTabs = new Set();   // every tab the batch opens — swept at end as a safety net
async function captureOneTab(url, id, delay) {
  let tab;
  // Load in the FOREGROUND (active:true). Background tabs get throttled and can be
  // discarded by Chrome — that silently breaks executeScript (no og:image) AND
  // captureVisibleTab (no screenshot) on heavy SPA pages like YouTube/Pinterest,
  // so the capture lands as a "no image" failure and the card never fills. A
  // foreground tab renders + persists exactly like a manual capture, which is the
  // one path that has always worked. Tabs still open/close automatically.
  try { tab = await chrome.tabs.create({ url, active: true }); }
  catch (e) { await deliverToApp({ url, id, attempt: true, ok: false, ts: Date.now() }); return "tab-fail"; }
  const tabId = tab.id;
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (e) {}  // belt & suspenders: never discard mid-capture
  batchTabs.add(tabId);
  recentWatches.push({ url, id, ts: Date.now() });
  recentWatches = recentWatches.filter(w => Date.now() - w.ts < 180000).slice(-60);
  const outcome = await new Promise((resolve) => {
    pendings[tabId] = {
      url, id, delay: delay || 0, settled: false, resolve,
      fb: setTimeout(() => { capturePending(tabId); }, (delay || 0) + 15000),   // page never fired load → grab what's there
      wd: setTimeout(() => settlePending(tabId, "watchdog"), (delay || 0) + 45000),  // hard give-up
    };
  });
  try { await chrome.tabs.remove(tabId); batchTabs.delete(tabId); } catch (e) { /* removal failed — leave it for the end-of-run sweep */ }
  if (outcome === "watchdog") await deliverToApp({ url, id, attempt: true, ok: false, ts: Date.now() });  // never loaded → mark attempted
  return outcome;
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
      try { const outcome = await captureOneTab(msg.data.url, msg.data.id, msg.data.delay); sendResponse({ ok: true, outcome }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.action === "cleanupBatch") {
    (async () => { await sweepBatchTabs(); sendResponse({ ok: true }); })();
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

  if (msg.action === "clipFacebookPost" && msg.data) {
    (async () => {
      try {
        const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        const d = msg.data;
        const res = await clipCurrentPage(tab, {
          url: d.url || d.pageUrl,
          title: d.title,
          desc: (d.text || d.author || "").trim() || undefined,
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
