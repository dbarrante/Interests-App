const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_DELAY_MS = 3000;

let pendingRequest = null;
let pendingTimer = null;

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "").toLowerCase();
  } catch { return url.toLowerCase(); }
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title: "Interests Capture",
    message: message,
    silent: true,
  });
}

async function sendCaptureToApp(capture) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (/localhost|127\.0\.0\.1/.test(tab.url) || /^file:/.test(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "captureResult", capture });
        return true;
      } catch (e) {}
    }
  }
  await chrome.storage.local.set({ pendingCapture: capture });
  return false;
}

async function captureTab(tabId, tabUrl, delayMs) {
  const delay = typeof delayMs === "number" ? delayMs : DEFAULT_DELAY_MS;
  if (delay > 0) {
    chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
    chrome.action.setBadgeText({ text: "⏳" });
    await new Promise((r) => setTimeout(r, delay));
  }

  chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  chrome.action.setBadgeText({ text: "..." });

  try {
    let meta = {};
    try {
      const metaResults = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      meta = metaResults && metaResults[0] && metaResults[0].result
        ? metaResults[0].result
        : {};
    } catch (e) {
      console.warn("Metadata extraction failed:", e);
    }

    let screenshot = "";
    try {
      screenshot = await chrome.tabs.captureVisibleTab(null, {
        format: "jpeg",
        quality: 60,
      });
    } catch (e) {
      console.warn("Screenshot failed:", e);
    }

    const capture = {
      url: tabUrl,
      title: meta.title || "",
      desc: meta.desc || "",
      ogImage: meta.ogImage || "",
      contentImage: meta.contentImage || "",
      screenshot: screenshot,
      ts: Date.now(),
    };

    const sent = await sendCaptureToApp(capture);

    chrome.action.setBadgeText({ text: "✓" });
    notify(sent ? "Captured for Interests ✓" : "Captured — open app to sync");

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const d = document.createElement("div");
          d.textContent = "Captured for Interests ✓";
          d.style.cssText =
            "position:fixed;bottom:20px;right:20px;z-index:999999;background:rgba(0,0,0,.75);color:#fff;padding:10px 18px;border-radius:8px;font:14px/1 system-ui,sans-serif;transition:opacity .5s;opacity:1";
          document.body.appendChild(d);
          setTimeout(() => { d.style.opacity = "0"; }, 1500);
          setTimeout(() => d.remove(), 2100);
        },
      });
    } catch (e) {}

    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
    return true;
  } catch (e) {
    console.error("Capture pipeline failed:", e);
    chrome.action.setBadgeText({ text: "" });
    notify("Capture failed: " + (e.message || e));
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "captureRequest" && msg.data) {
    const req = msg.data;
    if (pendingRequest) return;
    pendingRequest = { url: req.url, idx: req.idx, delay: req.delay };

    chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
    chrome.action.setBadgeText({ text: "⏳" });

    pendingTimer = setTimeout(() => {
      console.warn("Capture request timed out:", pendingRequest?.url);
      pendingRequest = null;
      chrome.action.setBadgeText({ text: "" });
    }, REQUEST_TIMEOUT_MS);
  }

  if (msg.action === "manualCapture") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) {
          sendResponse({ ok: false, error: "Cannot capture this page" });
          return;
        }
        await captureTab(tab.id, tab.url, 0);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingRequest) return;
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  if (/^(chrome|chrome-extension|about|edge):/.test(tab.url)) return;

  const reqNorm = normalizeUrl(pendingRequest.url);
  const tabNorm = normalizeUrl(tab.url);
  if (reqNorm !== tabNorm) return;

  clearTimeout(pendingTimer);
  const delayMs = pendingRequest.delay;
  pendingRequest = null;

  await captureTab(tabId, tab.url, delayMs);
});
