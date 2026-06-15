const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_DELAY_MS = 3000;
const MAX_QUEUE = 20;

let pendingRequest = null;
let pendingTimer = null;

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

    let screenshot = "";
    try {
      // focus the window/tab first so captureVisibleTab grabs the right surface
      try { await chrome.windows.update(windowId, { focused: true }); } catch (e) {}
      try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
      await new Promise((r) => setTimeout(r, 150));
      screenshot = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 60,
      });
      log("Screenshot captured (" + Math.round(screenshot.length / 1024) + "KB)");
    } catch (e) {
      log("Screenshot failed: " + e.message);
    }

    if (!meta.ogImage && !meta.contentImage && !screenshot) {
      setBadge("!", 5000);
      await setStatus("No image or metadata could be captured", false);
      return false;
    }

    const capture = {
      url: tabUrl,
      title: meta.title || "",
      desc: meta.desc || "",
      ogImage: meta.ogImage || "",
      contentImage: meta.contentImage || "",
      screenshot,
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

    setBadge("✓", 4000);
    const shotKb = screenshot ? Math.round(screenshot.length / 1024) + "KB shot" : "no shot";
    const dest = delivered ? "sent to app" : "app closed — queued";
    await setStatus("Captured ✓ — " + dest + " (" + (meta.ogImage ? "og image" : shotKb) + ")", true);

    try {
      chrome.notifications.create("cap-" + Date.now(), {
        type: "basic",
        iconUrl: "icon128.png",
        title: "Interests Capture",
        message: "Captured: " + (meta.title || tabUrl).slice(0, 60),
        silent: true,
      });
    } catch (e) {
      log("Notification failed: " + e.message);
    }

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

  log("Received capture request for: " + req.url);
  pendingRequest = { url: req.url, delay: req.delay, id: req.id || "" };
  setBadge("⏳");
  await setStatus("Waiting for page to load…", true);

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) continue;
    if (normalizeUrl(tab.url) === normalizeUrl(req.url) && tab.status === "complete") {
      log("Found matching tab already loaded: " + tab.id);
      clearTimeout(pendingTimer);
      const cid = pendingRequest.id;
      pendingRequest = null;
      await captureTab(tab, req.delay, false, cid);
      return;
    }
  }

  log("Tab not loaded yet, waiting for onUpdated...");
  pendingTimer = setTimeout(() => {
    log("Capture request timed out: " + pendingRequest?.url);
    pendingRequest = null;
    setBadge("", 0);
    setStatus("Timed out waiting for the page", false);
  }, REQUEST_TIMEOUT_MS);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingRequest) return;
  if (changeInfo.status !== "complete") return;
  if (!tab.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) return;

  if (normalizeUrl(tab.url) !== normalizeUrl(pendingRequest.url)) return;

  log("Tab loaded for pending request: " + tab.url);
  clearTimeout(pendingTimer);
  const delayMs = pendingRequest.delay;
  const cid = pendingRequest.id;
  pendingRequest = null;

  await captureTab(tab, delayMs, false, cid);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "captureRequest" && msg.data) {
    handleCaptureRequest(msg.data);
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
