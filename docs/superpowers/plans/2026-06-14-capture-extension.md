# Interests Capture Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome extension that captures screenshots and OG metadata from articles opened via the Interests App, and integrate a queue drainer into the app to populate imported card thumbnails and descriptions.

**Architecture:** The Interests App writes a capture request to `localStorage.ia_capture_request` when the user clicks an imported article. The extension detects this, waits for the article tab to finish loading, extracts OG metadata + captures a screenshot, writes the result to `localStorage.ia_captures`, and shows a brief visual indicator. The app drains this queue every 3 seconds, matching captures to imported items by URL.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JS, `chrome.tabs`, `chrome.scripting`, `chrome.action`, `captureVisibleTab`

---

## File Structure

| File | Responsibility |
|---|---|
| `extension/manifest.json` | Manifest V3 config: permissions, service worker, content script registration |
| `extension/background.js` | Service worker: listens for capture requests, orchestrates tab watching, screenshot capture, and queue writes |
| `extension/content.js` | Injected into article pages: extracts OG metadata, large images, sends back to background |
| `index.html` | Modified: add `ia_capture_request` write in `impOpen()`, add `drainCaptures()` + `normalizeUrl()`, start interval in init block |

---

### Task 1: Extension Manifest

**Files:**
- Create: `extension/manifest.json`

- [ ] **Step 1: Create manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Interests Capture",
  "version": "1.0",
  "description": "Captures screenshots and metadata for the Interests App",
  "permissions": ["activeTab", "scripting", "tabs", "storage"],
  "background": {
    "service_worker": "background.js"
  },
  "icons": {
    "48": "icon48.png",
    "128": "icon128.png"
  },
  "action": {
    "default_title": "Interests Capture (inactive)"
  }
}
```

- [ ] **Step 2: Create a simple placeholder icon**

Create a 48×48 and 128×128 PNG icon. Use any simple solid-color square with a camera emoji or letter "I" — these are placeholders. Save as `extension/icon48.png` and `extension/icon128.png`.

- [ ] **Step 3: Commit**

```bash
git add extension/manifest.json extension/icon48.png extension/icon128.png
git commit -m "feat: add extension manifest"
```

---

### Task 2: Content Script — OG Metadata Extraction

**Files:**
- Create: `extension/content.js`

- [ ] **Step 1: Write content.js**

This script is injected into article tabs by `background.js`. It extracts OG metadata and the first large content image, then returns the data.

```javascript
(function () {
  function getMeta(names) {
    for (const n of names) {
      const el = document.querySelector(
        `meta[property="${n}"],meta[name="${n}"]`
      );
      if (el && el.content) return el.content.trim();
    }
    return "";
  }

  function firstLargeImage() {
    const imgs = document.querySelectorAll("body img");
    for (const img of imgs) {
      if (img.naturalWidth > 200 && img.naturalHeight > 200) return img.src;
    }
    return "";
  }

  const data = {
    title: getMeta(["og:title", "twitter:title"]) || document.title || "",
    desc: getMeta(["og:description", "twitter:description", "description"]),
    ogImage: getMeta(["og:image", "twitter:image"]),
    contentImage: firstLargeImage(),
    url: document.location.href,
  };

  data;
})();
```

Note: This file is executed via `chrome.scripting.executeScript` with a return value — the last expression (`data`) is the result. It is NOT registered as a persistent content script in the manifest.

- [ ] **Step 2: Commit**

```bash
git add extension/content.js
git commit -m "feat: add content script for OG metadata extraction"
```

---

### Task 3: Background Service Worker

**Files:**
- Create: `extension/background.js`

- [ ] **Step 1: Write background.js — capture request listener**

The service worker polls for `ia_capture_request` on the app tab, watches for the article tab to finish loading, runs the content script, captures a screenshot, writes to the capture queue, and shows visual indicators.

```javascript
const APP_ORIGIN = "http://localhost:3456";
const QUEUE_KEY = "ia_captures";
const REQUEST_KEY = "ia_capture_request";
const MAX_QUEUE = 20;
const REQUEST_TIMEOUT_MS = 60000;

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

async function checkForRequest() {
  if (pendingRequest) return;
  const appTab = await findAppTab();
  if (!appTab) return;

  const req = await readAppLocalStorage(appTab.id, REQUEST_KEY);
  if (!req || !req.url) return;

  pendingRequest = { url: req.url, idx: req.idx, appTabId: appTab.id };
  await clearAppLocalStorage(appTab.id, REQUEST_KEY);

  chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
  chrome.action.setBadgeText({ text: "..." });

  pendingTimer = setTimeout(() => {
    console.warn("Capture request timed out:", pendingRequest.url);
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
  pendingRequest = null;

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
      url: tab.url,
      title: meta.title || "",
      desc: meta.desc || "",
      ogImage: meta.ogImage || "",
      contentImage: meta.contentImage || "",
      screenshot: screenshot,
      ts: Date.now(),
    };

    const appTab = await findAppTab();
    const writeTabId = appTab ? appTab.id : appTabId;
    let queue = (await readAppLocalStorage(writeTabId, QUEUE_KEY)) || [];
    queue = queue.filter((c) => normalizeUrl(c.url) !== normalizeUrl(capture.url));
    queue.push(capture);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    await writeAppLocalStorage(writeTabId, QUEUE_KEY, queue);

    chrome.action.setBadgeText({ text: "✓" });
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
      console.warn("Toast injection failed:", e);
    }

    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
  } catch (e) {
    console.error("Capture pipeline failed:", e);
    chrome.action.setBadgeText({ text: "" });
  }
});

setInterval(checkForRequest, 1000);
```

- [ ] **Step 2: Commit**

```bash
git add extension/background.js
git commit -m "feat: add background service worker with capture pipeline"
```

---

### Task 4: App Integration — Capture Request + Queue Drainer

**Files:**
- Modify: `index.html:1602-1609` (impOpen function)
- Modify: `index.html:1883` (before closing `</script>`)

- [ ] **Step 1: Add capture request write to impOpen()**

In `index.html`, modify `impOpen()` to write a capture request to localStorage after opening the tab. Find this code:

```javascript
function impOpen(idx){
  const it=imported[idx]; if(!it||!it.url) return;
  clicks.push({title:it.title, category:guessCat(it.title), ts:Date.now()});
  if(clicks.length>60) clicks=clicks.slice(-60);
  _impScrollY = window.scrollY;
  persistAll();
  window.open(it.url,"_blank");
  if(!it.desc || !it.img) enrichOnOpen(it, idx);
}
```

Replace with:

```javascript
function impOpen(idx){
  const it=imported[idx]; if(!it||!it.url) return;
  clicks.push({title:it.title, category:guessCat(it.title), ts:Date.now()});
  if(clicks.length>60) clicks=clicks.slice(-60);
  _impScrollY = window.scrollY;
  persistAll();
  if(!it.img || !it.desc){
    try{ localStorage.setItem("ia_capture_request", JSON.stringify({url:it.url, idx:idx})); }catch(e){}
  }
  window.open(it.url,"_blank");
  if(!it.desc || !it.img) enrichOnOpen(it, idx);
}
```

- [ ] **Step 2: Add normalizeUrl() and drainCaptures() functions**

Add these functions before the `/* ============ init ============ */` comment in `index.html`:

```javascript
/* ============ extension capture drain ============ */
function normalizeUrl(url){
  try{ const u=new URL(url); return (u.hostname.replace(/^www\./,"")+u.pathname).replace(/\/$/,"").toLowerCase(); }
  catch(e){ return url.toLowerCase(); }
}
function drainCaptures(){
  let raw;
  try{ raw=localStorage.getItem("ia_captures"); }catch(e){ return; }
  if(!raw) return;
  let queue;
  try{ queue=JSON.parse(raw); }catch(e){ return; }
  if(!Array.isArray(queue)||!queue.length) return;
  let changed=false;
  const remaining=[];
  for(const cap of queue){
    if(!cap.url){ remaining.push(cap); continue; }
    let match=imported.find(it=>it.url===cap.url);
    if(!match) match=imported.find(it=>it.url && normalizeUrl(it.url)===normalizeUrl(cap.url));
    if(!match){ remaining.push(cap); continue; }
    if(!match.img){
      if(cap.ogImage) { match.img=cap.ogImage; changed=true; }
      else if(cap.contentImage) { match.img=cap.contentImage; changed=true; }
      else if(cap.screenshot) { match.img=cap.screenshot; changed=true; }
    }
    if(!match.desc && cap.desc){ match.desc=cap.desc; changed=true; }
    if(match.title && cap.title && /^saved\b|^from your\b/i.test(match.title)){ match.title=cap.title; changed=true; }
  }
  try{ localStorage.setItem("ia_captures", JSON.stringify(remaining)); }catch(e){}
  if(changed){
    save("imported", imported);
    writeSavesFile();
    if(curTab==="imported"){ renderImported(); window.scrollTo(0,_impScrollY); }
    toast("Updated cards from extension capture");
  }
}
```

- [ ] **Step 3: Start the drain interval in the init block**

In `index.html`, find the init block ending (just before `</script>`):

```javascript
save("settings", S);
updateCounts();
showTab(load("tab","feed"));
restoreFolder();
</script>
```

Add the interval before `</script>`:

```javascript
save("settings", S);
updateCounts();
showTab(load("tab","feed"));
restoreFolder();
setInterval(drainCaptures, 3000);
</script>
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: integrate extension capture queue into Interests App"
```

---

### Task 5: Manual Testing

- [ ] **Step 1: Load the extension in Chrome**

1. Open `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `extension/` folder
5. Verify the extension appears with the correct name and icon

- [ ] **Step 2: Start the Interests App on localhost**

```bash
cd "D:\Dropbox\Documents\Claude\Projects\Interests App"
python -m http.server 3456
```

Open `http://localhost:3456` in Chrome.

- [ ] **Step 3: Test capture flow**

1. Go to the Imported tab
2. Click on any imported article that is missing an image or description
3. Verify: extension badge shows "..." then "✓"
4. Verify: a toast "Captured for Interests ✓" appears briefly on the article page
5. Return to the app tab
6. Within 3 seconds, verify: the card updates with an image and/or description
7. Verify: a toast "Updated cards from extension capture" appears in the app

- [ ] **Step 4: Test inert behavior**

1. Browse to any website NOT opened via the app
2. Verify: no badge change, no toast, no capture in `localStorage.ia_captures`
3. Open DevTools on the app tab, run `localStorage.getItem("ia_capture_request")` — should be `null`

- [ ] **Step 5: Test timeout**

1. In DevTools on the app tab, run: `localStorage.setItem("ia_capture_request", JSON.stringify({url:"https://nonexistent-test-url-12345.example.com", idx:0}))`
2. Wait 60 seconds
3. Verify: badge clears, console shows "Capture request timed out"

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete Interests Capture extension with app integration"
```
