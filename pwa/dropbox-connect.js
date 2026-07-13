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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
