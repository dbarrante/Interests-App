const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_DELAY_MS = 3000;
const MAX_QUEUE = 20;

let pendingRequest = null;
let pendingTimer = null;
let recentWatches = [];   // recently-opened card URLs, for unreachable-site detection

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
        // focus the window/tab first so captureVisibleTab grabs the right surface
        try { await chrome.windows.update(windowId, { focused: true }); } catch (e) {}
        try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
        await new Promise((r) => setTimeout(r, 150));
        // bound the capture so a stuck tab can never hang the (batch) pipeline
        screenshot = await Promise.race([
          chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 60 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("capture timeout")), 8000)),
        ]);
        log("Screenshot captured (" + Math.round(screenshot.length / 1024) + "KB)");
      } catch (e) {
        log("Screenshot failed: " + e.message);
      }
    }

    // A blocked page still sends a (mostly empty) capture so the app can clear
    // any stale block-page image; otherwise abort if nothing usable was found.
    if (!blocked && !meta.ogImage && !meta.contentImage && !screenshot) {
      setBadge("!", 5000);
      await setStatus("No image or metadata could be captured", false);
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
  pendingRequest = { url: req.url, delay: req.delay, id: req.id || "", force: !!req.force, capture: req.capture!==false };
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
  const { delay, id, force, capture } = pendingRequest;
  pendingRequest = null;
  if (capture) await captureTab(tab, delay, force, id);
  else { setBadge("", 0); await setStatus("Page reached — nothing to capture", true); }
}

// onCompleted fires reliably when the document finishes loading (more robust
// than tab.status, which can stay "loading" on pages with open connections)
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!details.url || /^(chrome|chrome-extension|about|edge):/.test(details.url)) return;
  // batch capture: a tab we opened for an item finished loading (match by tab
  // identity, not URL, so redirects don't stall the run)
  if (batchPending && !batchPending.done && details.tabId === batchPending.tabId) {
    const bp = batchPending; bp.done = true; clearTimeout(bp.fallback); batchPending = null;
    let tab; try { tab = await chrome.tabs.get(details.tabId); } catch (e) { bp.resolve("gone"); return; }
    await captureTab(tab, batchDelay, false, bp.id);
    bp.resolve("captured");
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
  // settle the batch item (dead links are removed and counted as processed)
  if (batchPending && !batchPending.done && normalizeUrl(batchPending.url) === normalizeUrl(url)) { const bp = batchPending; bp.done = true; clearTimeout(bp.fallback); batchPending = null; bp.resolve("dead"); }
}
/* ============ batch capture ============
   Open each card's URL in turn, capture it, close the tab. Cancellable.
   Outcome per item is settled by webNavigation.onCompleted (captured),
   reportDead (dead/removed), or a timeout. */
let batchItems = [], batchActive = false, batchPending = null, batchDone = 0, batchTotal = 0, batchDelay = 0;
// write progress into the app AND read back the cancel flag in the same call,
// so Stop works even if the bridge isn't relaying messages. Returns true if
// the user asked to cancel.
async function pushBatchProgress() {
  const prog = { active: batchActive, done: batchDone, total: batchTotal };
  let cancelled = false;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(t.url)) continue;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: (p) => { localStorage.setItem("ia_batch_progress", JSON.stringify(p)); var c = localStorage.getItem("ia_batch_cancel"); if (c) localStorage.removeItem("ia_batch_cancel"); return c === "1"; },
          args: [prog],
        });
        if (res && res[0] && res[0].result) cancelled = true;
      } catch (e) {}
    }
  } catch (e) {}
  return cancelled;
}
async function startBatch(items, delay) {
  if (batchActive) { log("batch already running"); return; }
  batchItems = (items || []).slice(); batchTotal = batchItems.length; batchDone = 0;
  batchDelay = typeof delay === "number" ? delay : DEFAULT_DELAY_MS;
  if (!batchTotal) return;
  batchActive = true;
  log("Batch start: " + batchTotal + " items");
  await pushBatchProgress();
  runBatchNext();
}
function cancelBatch() { if (batchActive) { log("batch cancelled"); batchActive = false; batchItems = []; if (batchPending) { batchPending.resolve("cancel"); } } }
async function runBatchNext() {
  if (!batchActive) { await pushBatchProgress(); return; }
  if (!batchItems.length) { batchActive = false; setBadge("✓", 4000); await setStatus("Batch done: " + batchDone + "/" + batchTotal, true); await pushBatchProgress(); return; }
  // honor a Stop requested between items (read directly from the app)
  if (await pushBatchProgress()) { cancelBatch(); await setStatus("Batch stopped at " + batchDone + "/" + batchTotal, false); await pushBatchProgress(); return; }
  if (!batchActive) { await pushBatchProgress(); return; }
  const item = batchItems.shift();
  recentWatches.push({ url: item.url, id: item.id, ts: Date.now() });
  recentWatches = recentWatches.filter(w => Date.now() - w.ts < 180000).slice(-40);
  setBadge("" + (batchDone + 1), 0);
  await setStatus("Batch capture " + (batchDone + 1) + "/" + batchTotal, true);
  let tab;
  try { tab = await chrome.tabs.create({ url: item.url, active: true }); }
  catch (e) { batchDone++; return runBatchNext(); }
  // Settle this item by: (a) onCompleted/reportDead via batchPending, (b) a
  // fallback that captures whatever's loaded if no load event fires, and
  // (c) a hard watchdog so a hung captureTab can never freeze the loop.
  await new Promise((resolve) => {
    let settled = false;
    const done = (why) => { if (settled) return; settled = true; if (batchPending && batchPending.tabId === tab.id) { batchPending.done = true; clearTimeout(batchPending.fallback); batchPending = null; } resolve(why); };
    batchPending = {
      url: item.url, id: item.id, tabId: tab.id, done: false,
      resolve: (why) => done(why),
      // capture whatever has loaded if the page never fires onCompleted
      fallback: setTimeout(async () => {
        if (!batchPending || batchPending.done || batchPending.tabId !== tab.id) return;
        batchPending.done = true; batchPending = null;
        try { const t = await chrome.tabs.get(tab.id); if (t && !/^(chrome|chrome-extension|about|edge):/.test(t.url || "")) await captureTab(t, 0, false, item.id); } catch (e) {}
        done("fallback");
      }, (batchDelay || 0) + 12000),
    };
    // absolute last resort — always advance even if captureTab itself hangs
    setTimeout(() => done("watchdog"), (batchDelay || 0) + 30000);
  });
  try { await chrome.tabs.remove(tab.id); } catch (e) {}
  batchDone++;
  if (await pushBatchProgress()) cancelBatch();   // user hit Stop during this item
  if (batchActive) setTimeout(runBatchNext, 500); else { await setStatus("Batch stopped at " + batchDone + "/" + batchTotal, false); await pushBatchProgress(); }
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

  if (msg.action === "batchCapture" && msg.data) {
    startBatch(msg.data.items, msg.data.delay);
  }
  if (msg.action === "cancelBatch") {
    cancelBatch();
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
