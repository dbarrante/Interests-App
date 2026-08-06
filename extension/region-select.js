"use strict";
// Manual point-to-point capture overlay: drag a rectangle, preview the
// crop, then either deliver it (background.js owns the actual screenshot —
// content scripts cannot call chrome.tabs.captureVisibleTab) or cancel.
// Injected on demand via chrome.scripting.executeScript by background.js,
// either from the extension's "Point-to-point capture" context-menu item
// (standalone, any page) or from the app-triggered manual-recapture flow
// (pollCaptureRequest's req.manual branch). Self-contained — no dependency
// on capture-core.js/capture-configs.js.
(function () {
  if (window.__iaRegionSelectActive) return;   // a second injection on an already-active tab is a no-op
  window.__iaRegionSelectActive = true;

  const overlay = document.createElement("div");
  overlay.id = "__ia_region_select_overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.35);";
  document.documentElement.appendChild(overlay);

  const box = document.createElement("div");
  box.style.cssText = "position:fixed;border:2px solid #4da3ff;background:rgba(255,255,255,.08);display:none;pointer-events:none;";
  overlay.appendChild(box);

  let startX = 0, startY = 0, dragging = false;

  function cleanup() {
    window.__iaRegionSelectActive = false;
    try { overlay.remove(); } catch (e) {}
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("mouseup", onDocumentMouseUp);
    window.removeEventListener("blur", onWindowBlur);
  }

  function rectFromDrag(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  function showMessage(text) {
    let m = document.getElementById("__ia_region_select_msg");
    if (!m) {
      m = document.createElement("div");
      m.id = "__ia_region_select_msg";
      m.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:8px 16px;border-radius:8px;font:600 13px system-ui,sans-serif;z-index:2147483647;";
      overlay.appendChild(m);
    }
    m.textContent = text;
  }

  function showPreview(dataUrl) {
    const panel = document.createElement("div");
    panel.id = "__ia_region_select_preview";
    panel.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:12px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:2147483647;text-align:center;font-family:system-ui,sans-serif;";
    panel.innerHTML =
      '<img src="' + dataUrl + '" style="max-width:60vw;max-height:60vh;display:block;border-radius:4px;margin-bottom:10px">' +
      '<div style="display:flex;gap:10px;justify-content:center">' +
      '<button id="__ia_use_this" style="padding:8px 18px;border-radius:6px;border:none;background:#2f7ff2;color:#fff;font-weight:600;cursor:pointer">Use this</button>' +
      '<button id="__ia_redo" style="padding:8px 18px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer">Redo</button>' +
      "</div>";
    overlay.appendChild(panel);
    panel.querySelector("#__ia_use_this").addEventListener("click", () => {
      panel.remove();
      showMessage("Saving…");
      chrome.runtime.sendMessage({ action: "regionSelectFinalize" }, () => { cleanup(); });
    });
    panel.querySelector("#__ia_redo").addEventListener("click", () => {
      panel.remove();
      const m = document.getElementById("__ia_region_select_msg");
      if (m) m.remove();
    });
  }

  function onMouseDown(e) {
    if (e.button !== 0 || document.getElementById("__ia_region_select_preview")) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    box.style.display = "block";
    box.style.left = startX + "px"; box.style.top = startY + "px";
    box.style.width = "0px"; box.style.height = "0px";
  }
  function onMouseMove(e) {
    if (!dragging) return;
    const r = rectFromDrag(startX, startY, e.clientX, e.clientY);
    box.style.left = r.x + "px"; box.style.top = r.y + "px";
    box.style.width = r.w + "px"; box.style.height = r.h + "px";
  }
  function onMouseUp(e) {
    if (!dragging) return;
    dragging = false;
    const r = rectFromDrag(startX, startY, e.clientX, e.clientY);
    if (r.w < 8 || r.h < 8) { box.style.display = "none"; return; }   // too small to be deliberate — let them redraw
    box.style.display = "none";
    overlay.style.background = "transparent";   // hide the dimming before the real screenshot so it isn't captured
    chrome.runtime.sendMessage({ action: "regionSelectCrop", rect: r }, (resp) => {
      overlay.style.background = "rgba(0,0,0,.35)";
      if (!resp || !resp.ok) { showMessage("Couldn't capture that — try drawing again, or press Escape to cancel."); return; }
      showPreview(resp.dataUrl);
    });
  }
  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    chrome.runtime.sendMessage({ action: "regionSelectCancel" }, () => { cleanup(); });
  }
  function onDocumentMouseUp(e) {
    if (!dragging) return;   // only process if we're in an active drag
    dragging = false;
    const r = rectFromDrag(startX, startY, e.clientX, e.clientY);
    if (r.w < 8 || r.h < 8) { box.style.display = "none"; return; }   // too small — just abort, don't try to capture
    box.style.display = "none";
    overlay.style.background = "transparent";   // hide the dimming before the real screenshot so it isn't captured
    chrome.runtime.sendMessage({ action: "regionSelectCrop", rect: r }, (resp) => {
      overlay.style.background = "rgba(0,0,0,.35)";
      if (!resp || !resp.ok) { showMessage("Couldn't capture that — try drawing again, or press Escape to cancel."); return; }
      showPreview(resp.dataUrl);
    });
  }
  function onWindowBlur(e) {
    if (!dragging) return;   // only process if we're in an active drag
    dragging = false;
    box.style.display = "none";   // abort in-progress selection without trying to capture
  }

  overlay.addEventListener("mousedown", onMouseDown);
  overlay.addEventListener("mousemove", onMouseMove);
  overlay.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("mouseup", onDocumentMouseUp);
  window.addEventListener("blur", onWindowBlur);
})();
