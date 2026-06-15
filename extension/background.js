const APP_ORIGIN = "http://localhost:3456";
const QUEUE_KEY = "ia_captures";
const REQUEST_KEY = "ia_capture_request";
const MAX_QUEUE = 20;
const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_DELAY_MS = 3000;

let pendingRequest = null;
let pendingTimer = null;

async function findAppTab() {
  const tabs = await chrome.tabs.query({ url: APP_ORIGIN + "/*" });
  return tabs.length ? tabs[0] : null;
}

async function readAppLocalStorage(tabId, key) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (k) => localStorage.getItem(k),
    args: [key],
  });
  return results && results[0] && results[0].result
    ? JSON.parse(results[0].result)
    : null;
}

async function writeAppLocalStorage(tabId, key, value) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
    args: [key, value],
  });
}

async function clearAppLocalStorage(tabId, key) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (k) => localStorage.removeItem(k),
    args: [key],
  });
}

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

async function captureTab(tabId, tabUrl, appTabId, delayMs) {
  const delay = typeof delayMs === "number" ? delayMs : DEFAULT_DELAY_MS;
  if (delay > 0) {
    await new Promise((r) => setTimeout(r, delay));
  }

  chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  chrome.action.setBadgeText({ text: "..." });

  try {
    const metaResults = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    const meta = metaResults && metaResults[0] && metaResults[0].result
      ? metaResults[0].result
      : {};

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

    const appTab = await findAppTab();
    const writeTabId = appTab ? appTab.id : appTabId;
    if (!writeTabId) {
      await chrome.storage.local.set({ pendingCapture: capture });
      notify("Captured — will sync when app is open");
      chrome.action.setBadgeText({ text: "1" });
      return;
    }

    let queue = (await readAppLocalStorage(writeTabId, QUEUE_KEY)) || [];
    queue = queue.filter((c) => normalizeUrl(c.url) !== normalizeUrl(capture.url));
    queue.push(capture);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    await writeAppLocalStorage(writeTabId, QUEUE_KEY, queue);

    chrome.action.setBadgeText({ text: "✓" });
    notify("Captured for Interests ✓");

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
    } catch (e) {
      console.warn("Toast injection failed (CSP?):", e);
    }

    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
  } catch (e) {
    console.error("Capture pipeline failed:", e);
    chrome.action.setBadgeText({ text: "" });
    notify("Capture failed: " + (e.message || e));
  }
}

async function checkForRequest() {
  if (pendingRequest) return;
  const appTab = await findAppTab();
  if (!appTab) return;

  const req = await readAppLocalStorage(appTab.id, REQUEST_KEY);
  if (!req || !req.url) return;

  pendingRequest = { url: req.url, idx: req.idx, appTabId: appTab.id, delay: req.delay };
  await clearAppLocalStorage(appTab.id, REQUEST_KEY);

  chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  chrome.action.setBadgeText({ text: "⏳" });

  pendingTimer = setTimeout(() => {
    console.warn("Capture request timed out:", pendingRequest?.url);
    pendingRequest = null;
    chrome.action.setBadgeText({ text: "" });
  }, REQUEST_TIMEOUT_MS);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!pendingRequest) return;
  if (changeInfo.status !== "complete") return;
  if (!tab.url) return;
  if (/^(chrome|chrome-extension|about|edge):/.test(tab.url)) return;

  const reqNorm = normalizeUrl(pendingRequest.url);
  const tabNorm = normalizeUrl(tab.url);
  if (reqNorm !== tabNorm) return;

  clearTimeout(pendingTimer);
  const appTabId = pendingRequest.appTabId;
  const delayMs = pendingRequest.delay;
  pendingRequest = null;

  await captureTab(tabId, tab.url, appTabId, delayMs);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "manualCapture") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) {
          sendResponse({ ok: false, error: "Cannot capture this page" });
          return;
        }
        const appTab = await findAppTab();
        await captureTab(tab.id, tab.url, appTab ? appTab.id : null, 0);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

setInterval(checkForRequest, 1000);
