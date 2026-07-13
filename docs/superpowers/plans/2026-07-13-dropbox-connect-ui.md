# Dropbox Connect UI (iPad PWA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `pwa/index.html`'s Settings panel a real, in-app "Connect to Dropbox" control, so a fresh browser or a real iPad no longer needs to visit a test-harness page (`dbx-test.html`/`sync-test.html`) to start the OAuth flow.

**Architecture:** A single new file, `pwa/dropbox-connect.js`, loaded as one more `<script>` tag in `pwa/index.html`. On `DOMContentLoaded` it injects a small "Connect to Dropbox" subsection into the existing Settings panel's Dropbox-sync block (found via `#syncToggle`'s `.sec` ancestor, not by DOM position), handles the OAuth redirect callback, and wires Connect/Disconnect. `index.html`'s own HTML and inline script are never edited.

**Tech Stack:** Vanilla browser JS, no build step, no bundler (matches the whole PWA stack per `pwa/README.md`/root `CLAUDE.md`). Backed by `pwa/oauth.js`'s existing PKCE OAuth implementation (`IADropbox` global).

## Global Constraints

- `pwa/index.html` must stay a byte-for-byte copy of `web/index.html` except for its `<script>` tags (documented in `pwa/README.md`'s Phase 4 section and `pwa/HANDOFF.md`) — no HTML or inline-script edits to `index.html` in this plan, only a new `<script src="dropbox-connect.js">` tag.
- No editable Redirect URI field — always auto-computed as `location.origin + "/"`.
- Leave the existing "Choose Dropbox folder…" button alone — out of scope (see spec).
- No automated test harness exists for `pwa/*.js` browser code (unlike `core/`, which has `tests/run.js` + `node:assert` scripts) — verification in this plan is manual, in a real browser, matching how the rest of `pwa/` was verified (see `pwa/README.md`'s Phase 1-4 write-ups).
- Design spec: `docs/superpowers/specs/2026-07-13-dropbox-connect-ui-design.md` — read it for the full rationale; this plan implements it task-by-task.

---

## File structure

- **Create** `pwa/dropbox-connect.js` — the entire feature: widget injection, status rendering, Connect/Disconnect wiring, OAuth redirect-callback handling.
- **Modify** `pwa/index.html` — add one `<script src="dropbox-connect.js"></script>` tag, after `storage-pwa.js` and before `ai.js` (line ~376-377), inside the existing `<head>` script block.

---

## Task 1: Inject the widget and render connection status (read-only)

**Files:**
- Create: `pwa/dropbox-connect.js`
- Modify: `pwa/index.html:376` (add script tag)

**Interfaces:**
- Consumes: `window.IADropbox` (`pwa/oauth.js`) — `LS_KEYS`, `isConnected()`, `getAccessToken(appKey)`, `getCurrentAccount(token)`.
- Produces (for Task 2 to extend): `$(id)`, `currentAppKey()`, `redirectUri()`, `setError(msg)`, `refreshStatus()`, `injectWidget()`, `init()` — all defined inside the same IIFE closure in `pwa/dropbox-connect.js`. DOM elements Task 2 will attach listeners to: `#dbxAppKey`, `#dbxConnectBtn`.

- [ ] **Step 1: Add the script tag**

In `pwa/index.html`, find this block (around line 372-377):

```html
<script src="idb.js"></script>
<script src="oauth.js"></script>
<script src="merge.js"></script>
<script src="sync-pwa.js"></script>
<script src="storage-pwa.js"></script>
<script src="ai.js"></script>
```

Change it to:

```html
<script src="idb.js"></script>
<script src="oauth.js"></script>
<script src="merge.js"></script>
<script src="sync-pwa.js"></script>
<script src="storage-pwa.js"></script>
<script src="dropbox-connect.js"></script>
<script src="ai.js"></script>
```

- [ ] **Step 2: Create `pwa/dropbox-connect.js` with widget injection + status rendering**

```javascript
"use strict";

// Closes the in-app Dropbox-connect gap noted in pwa/HANDOFF.md: index.html's
// Settings panel has the sync toggle/device-label/sync-now UI (built for
// desktop) but nothing that starts the OAuth flow itself — that only exists
// in dbx-test.html/sync-test.html today. This is a separate script, not an
// edit to index.html's HTML/inline script, because index.html is documented
// (pwa/README.md, Phase 4) as a byte-for-byte copy of web/index.html except
// for its <script> tags.
//
// Loaded from <head> alongside the rest of the PWA stack, so its DOM-touching
// code waits for DOMContentLoaded — the Settings panel's HTML doesn't exist
// yet when this file's own <script> tag runs.

(function () {
  const Dbx = window.IADropbox;

  function $(id) { return document.getElementById(id); }
  function currentAppKey() { return localStorage.getItem(Dbx.LS_KEYS.appKey) || ""; }
  function redirectUri() { return location.origin + "/"; }

  function setError(msg) {
    const el = $("dbxConnectError");
    if (el) el.textContent = msg || "";
  }

  async function refreshStatus() {
    const statusEl = $("dbxConnectStatus");
    const btn = $("dbxConnectBtn");
    if (!statusEl || !btn) return;

    if (!Dbx.isConnected()) {
      statusEl.textContent = "Not connected.";
      btn.textContent = "Connect to Dropbox";
      return;
    }

    btn.textContent = "Disconnect";
    try {
      const token = await Dbx.getAccessToken(currentAppKey());
      const account = await Dbx.getCurrentAccount(token);
      statusEl.textContent = "Connected as " + account.email;
    } catch (e) {
      statusEl.textContent = "Connected, but account check failed: " + e.message;
    }
  }

  function injectWidget() {
    const anchor = $("syncToggle");
    if (!anchor || $("dbxConnectBox")) return;
    const sec = anchor.closest(".sec");
    if (!sec) return;

    const box = document.createElement("div");
    box.id = "dbxConnectBox";
    box.style.marginBottom = "14px";
    box.style.paddingBottom = "14px";
    box.style.borderBottom = "1px solid var(--line)";
    box.innerHTML =
      '<label style="display:block">Dropbox App key</label>' +
      '<input type="text" id="dbxAppKey" style="width:auto;min-width:260px" placeholder="e.g. abc123def456">' +
      '<div style="margin-top:10px">' +
        '<button class="btn btn-ghost" id="dbxConnectBtn">Connect to Dropbox</button>' +
        '<span class="hint" id="dbxConnectStatus" style="margin-left:8px">Not connected.</span>' +
      '</div>' +
      '<div class="hint" id="dbxConnectError" style="margin-top:6px;color:#c0392b"></div>';

    const heading = sec.querySelector("h3");
    if (heading) heading.insertAdjacentElement("afterend", box);
    else sec.insertBefore(box, sec.firstChild);

    $("dbxAppKey").value = currentAppKey();
    $("dbxAppKey").addEventListener("change", (e) => {
      localStorage.setItem(Dbx.LS_KEYS.appKey, e.target.value.trim());
    });
  }

  async function init() {
    if (!Dbx) return; // oauth.js not loaded on this page
    injectWidget();
    await refreshStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
```

- [ ] **Step 3: Manually verify — disconnected state**

In a browser profile that has never connected to Dropbox (or after clearing site data for this origin):
1. `cd pwa && python -m http.server 8080`
2. Open `http://localhost:8080/` in a browser, log into the app if prompted, go to Settings.
3. Confirm a new "Dropbox App key" input and a "Connect to Dropbox" button appear at the top of the "Dropbox sync" section, above the existing "Share your library across machines…" text.
4. Confirm the status line reads "Not connected."

- [ ] **Step 4: Manually verify — connected state**

In a browser profile that already has Dropbox tokens from a prior `dbx-test.html` session (or reuse a browser that ran `dbx-test.html`'s Connect flow before):
1. Reload `http://localhost:8080/`, go to Settings.
2. Confirm the App-key field is pre-filled from `localStorage`.
3. Confirm the button reads "Disconnect" and the status line reads "Connected as `<your dropbox email>`" (fetched live via `IADropbox.getCurrentAccount`).

- [ ] **Step 5: Commit**

```bash
git add pwa/dropbox-connect.js pwa/index.html
git commit -m "feat(pwa): inject read-only Dropbox connection status into Settings"
```

---

## Task 2: Wire Connect/Disconnect and the OAuth redirect callback

**Files:**
- Modify: `pwa/dropbox-connect.js` (extends `injectWidget()` and `init()` from Task 1)

**Interfaces:**
- Consumes (from Task 1, same file): `$`, `currentAppKey()`, `redirectUri()`, `setError(msg)`, `refreshStatus()`, `injectWidget()`, `init()`.
- Consumes (from `pwa/oauth.js`): `Dbx.beginAuthorize(appKey, redirectUri)`, `Dbx.disconnect()`, `Dbx.handleRedirectCallback(appKey, redirectUri, logFn) → Promise<boolean>`, `Dbx.LS_KEYS.redirectUri`.
- Consumes (global, defined in `pwa/index.html`'s own inline script, may not exist on every page — guard with `typeof`): `renderSyncStatus()`.
- Produces: fully working Connect/Disconnect flow — no further tasks depend on this.

- [ ] **Step 1: Add the click handler inside `injectWidget()`**

In `pwa/dropbox-connect.js`, inside `injectWidget()`, immediately after the existing `$("dbxAppKey").addEventListener(...)` block, add:

```javascript
    $("dbxConnectBtn").addEventListener("click", async () => {
      if (Dbx.isConnected()) {
        Dbx.disconnect();
        setError("");
        await refreshStatus();
        if (typeof renderSyncStatus === "function") renderSyncStatus();
        return;
      }
      const appKey = $("dbxAppKey").value.trim();
      if (!appKey) { setError("Enter a Dropbox App key first."); return; }
      localStorage.setItem(Dbx.LS_KEYS.appKey, appKey);
      Dbx.beginAuthorize(appKey, redirectUri());
    });
```

So `injectWidget()`'s full body now reads:

```javascript
  function injectWidget() {
    const anchor = $("syncToggle");
    if (!anchor || $("dbxConnectBox")) return;
    const sec = anchor.closest(".sec");
    if (!sec) return;

    const box = document.createElement("div");
    box.id = "dbxConnectBox";
    box.style.marginBottom = "14px";
    box.style.paddingBottom = "14px";
    box.style.borderBottom = "1px solid var(--line)";
    box.innerHTML =
      '<label style="display:block">Dropbox App key</label>' +
      '<input type="text" id="dbxAppKey" style="width:auto;min-width:260px" placeholder="e.g. abc123def456">' +
      '<div style="margin-top:10px">' +
        '<button class="btn btn-ghost" id="dbxConnectBtn">Connect to Dropbox</button>' +
        '<span class="hint" id="dbxConnectStatus" style="margin-left:8px">Not connected.</span>' +
      '</div>' +
      '<div class="hint" id="dbxConnectError" style="margin-top:6px;color:#c0392b"></div>';

    const heading = sec.querySelector("h3");
    if (heading) heading.insertAdjacentElement("afterend", box);
    else sec.insertBefore(box, sec.firstChild);

    $("dbxAppKey").value = currentAppKey();
    $("dbxAppKey").addEventListener("change", (e) => {
      localStorage.setItem(Dbx.LS_KEYS.appKey, e.target.value.trim());
    });

    $("dbxConnectBtn").addEventListener("click", async () => {
      if (Dbx.isConnected()) {
        Dbx.disconnect();
        setError("");
        await refreshStatus();
        if (typeof renderSyncStatus === "function") renderSyncStatus();
        return;
      }
      const appKey = $("dbxAppKey").value.trim();
      if (!appKey) { setError("Enter a Dropbox App key first."); return; }
      localStorage.setItem(Dbx.LS_KEYS.appKey, appKey);
      Dbx.beginAuthorize(appKey, redirectUri());
    });
  }
```

- [ ] **Step 2: Replace `init()` to persist the redirect URI and handle the OAuth callback**

Replace the `init()` function from Task 1 with:

```javascript
  async function init() {
    if (!Dbx) return; // oauth.js not loaded on this page
    localStorage.setItem(Dbx.LS_KEYS.redirectUri, redirectUri());

    injectWidget();

    const wasCallback = await Dbx.handleRedirectCallback(currentAppKey(), redirectUri(), (msg) => {
      console.log(msg);
      if (/failed|mismatch/i.test(msg)) setError(msg);
    });

    await refreshStatus();
    if (wasCallback && typeof renderSyncStatus === "function") renderSyncStatus();
  }
```

- [ ] **Step 3: Manually verify — Disconnect**

In a browser profile that's currently connected:
1. Load `http://localhost:8080/`, go to Settings, confirm the button reads "Disconnect".
2. Click it. Confirm the status line reverts to "Not connected." and the button relabels to "Connect to Dropbox", with no page reload needed.

- [ ] **Step 4: Manually verify — Connect (real Dropbox OAuth round trip)**

Requires a real Dropbox App Console app already registered with `http://localhost:8080/` as an OAuth redirect URI (per `pwa/HANDOFF.md`'s environment checklist), scoped `files.metadata.read`, `files.content.read`, `files.content.write`, `account_info.read`.

1. In a disconnected browser profile, load `http://localhost:8080/`, go to Settings.
2. Enter the App key into the new "Dropbox App key" field.
3. Click "Connect to Dropbox" — confirm the browser navigates to `dropbox.com`'s OAuth consent screen.
4. Approve. Confirm it redirects back to `http://localhost:8080/`.
5. Confirm the page lands with the Settings panel showing "Connected as `<your dropbox email>`", the button now reads "Disconnect", and the existing sync section (`#syncStatus`, populated by the page's own `renderSyncStatus()`) shows updated peer/device info without a manual page reload.
6. Open DevTools → Application → Local Storage and confirm `ia_pwa_access_token`/`ia_pwa_refresh_token` are present (these are `IADropbox.LS_KEYS`' underlying key names, per `pwa/oauth.js`).

- [ ] **Step 5: Manually verify — bad App key surfaces an error, not a silent failure**

1. In a disconnected profile, leave the App-key field blank and click "Connect to Dropbox". Confirm the red error line reads "Enter a Dropbox App key first." and nothing navigates away.
2. Enter an intentionally wrong/garbage App key, click Connect, and go through the Dropbox consent screen if it lets you. Confirm that on redirect back, the red error line shows the token-exchange failure message (routed from `handleRedirectCallback`'s log callback) instead of the page silently showing "Not connected." with no explanation.

- [ ] **Step 6: Commit**

```bash
git add pwa/dropbox-connect.js
git commit -m "feat(pwa): wire Dropbox Connect/Disconnect and OAuth redirect callback"
```

---

## Self-review notes

- **Spec coverage:** App-key input (spec: self-service) → Task 1 Step 2. Auto-computed redirect URI, no field → Task 2 Step 2 (`redirectUri()` helper from Task 1, persisted in `init()`). Connect/Disconnect toggle + status line → Task 1 Step 2 (render) + Task 2 Step 1 (wire). OAuth redirect-callback handling + `renderSyncStatus()` refresh → Task 2 Step 2. Visible error line (since there's no `#log` panel like `dbx-test.html`) → Task 1 Step 2 (`setError`/`#dbxConnectError`) + Task 2 Step 2 (routes `handleRedirectCallback`'s log messages there). "Choose Dropbox folder…" left alone → no task touches it. `index.html` HTML/inline script untouched → confirmed, only a `<script>` tag added.
- **Placeholder scan:** none found — every step ships complete, runnable code and concrete manual-verification instructions.
- **Type/name consistency:** `injectWidget`, `refreshStatus`, `init`, `setError`, `currentAppKey`, `redirectUri`, and DOM ids (`dbxConnectBox`, `dbxAppKey`, `dbxConnectBtn`, `dbxConnectStatus`, `dbxConnectError`) are identical across both tasks — Task 2's full-function listings were diffed against Task 1's originals to confirm no drift.
