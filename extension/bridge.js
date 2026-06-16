(function () {
  const REQUEST_KEY = "ia_capture_request";
  const QUEUE_KEY = "ia_captures";

  var alive = true;
  var requestInterval, pullInterval;

  function log(msg) {
    console.log("[Interests Bridge]", msg);
  }

  function die(reason) {
    if (!alive) return;
    alive = false;
    clearInterval(requestInterval);
    clearInterval(pullInterval);
    log("Stopped: " + reason + " — reload this page to reconnect");
  }

  function isDisconnected() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) { die("extension unloaded"); return true; }
      return false;
    } catch (e) { die(e.message); return true; }
  }

  function checkForRequest() {
    if (isDisconnected()) return;
    try {
      var raw = localStorage.getItem(REQUEST_KEY);
      if (raw) {
        var req = JSON.parse(raw);
        if (req && req.url) {
          localStorage.removeItem(REQUEST_KEY);
          log("Forwarding capture request: " + req.url);
          chrome.runtime.sendMessage({ action: "captureRequest", data: req }, function() {
            if (chrome.runtime.lastError) log("sendMessage error: " + chrome.runtime.lastError.message);
          });
        }
      }
      driveBatch();
    } catch (e) {
      if (/invalidated|disconnected/i.test(e.message)) die(e.message);
      else log("checkForRequest error: " + e.message);
    }
  }

  function pullCaptures() {
    if (isDisconnected()) return;
    try {
      chrome.runtime.sendMessage({ action: "getQueue" }, function(resp) {
        if (chrome.runtime.lastError) {
          if (/invalidated|disconnected/i.test(chrome.runtime.lastError.message)) die(chrome.runtime.lastError.message);
          return;
        }
        if (!resp || !resp.queue || !resp.queue.length) return;
        log("Received " + resp.queue.length + " capture(s)");
        var existing = [];
        try {
          var raw = localStorage.getItem(QUEUE_KEY);
          if (raw) existing = JSON.parse(raw);
          if (!Array.isArray(existing)) existing = [];
        } catch (e) {}
        for (var i = 0; i < resp.queue.length; i++) {
          existing.push(resp.queue[i]);
        }
        localStorage.setItem(QUEUE_KEY, JSON.stringify(existing));
        log("Synced to app localStorage");
        chrome.runtime.sendMessage({ action: "clearQueue" }, function() {
          if (chrome.runtime.lastError) {} // ignore
        });
      });
    } catch (e) {
      if (/invalidated|disconnected/i.test(e.message)) die(e.message);
    }
  }

  // ---- batch driver (the loop lives here, in the stable page context) ----
  // Runs up to `concurrency` captures at once: page loads happen in parallel,
  // the worker serializes the actual screenshots. State is held here + mirrored
  // to ia_batch_state so it survives a service-worker sleep / page reload.
  var B = null;            // active driver state {items,next,done,total,delay,conc}
  var inFlight = 0;
  function writeProg(done, total, active) {
    try { localStorage.setItem("ia_batch_progress", JSON.stringify({ done: done, total: total, active: active, ts: Date.now() })); } catch (e) {}
  }
  function saveState() { if (B) try { localStorage.setItem("ia_batch_state", JSON.stringify({ items: B.items, next: B.next, done: B.done, total: B.total, delay: B.delay, concurrency: B.conc, active: true })); } catch (e) {} }
  function endBatch() {
    var done = B ? B.done : 0, total = B ? B.total : 0;
    B = null; inFlight = 0;
    writeProg(done, total, false);
    try { localStorage.removeItem("ia_batch_state"); } catch (e) {}
    log("Batch finished " + done + "/" + total);
  }
  function driveBatch() {
    if (isDisconnected()) return;
    if (!B) {
      var st; try { st = JSON.parse(localStorage.getItem("ia_batch_state") || "null"); } catch (e) { return; }
      if (!st || !st.items || !st.items.length) return;
      var startAt = (typeof st.next === "number") ? st.next : (st.done || 0);
      if (startAt >= st.items.length) { try { localStorage.removeItem("ia_batch_state"); } catch (e) {} return; }
      B = { items: st.items, next: startAt, done: st.done || 0, total: st.items.length, delay: st.delay || 0, conc: Math.max(1, Math.min(10, st.concurrency || 1)) };
      log("Batch start: " + B.total + " items, concurrency " + B.conc);
    }
    pump();
  }
  function pump() {
    if (!B) return;
    if (localStorage.getItem("ia_batch_cancel")) { localStorage.removeItem("ia_batch_cancel"); return endBatch(); }
    // finished: all dispatched and all returned
    if (B.next >= B.items.length && inFlight === 0) return endBatch();
    while (B && inFlight < B.conc && B.next < B.items.length && !localStorage.getItem("ia_batch_cancel")) {
      var item = B.items[B.next++];
      saveState();
      inFlight++;
      dispatch(item);
    }
  }
  function dispatch(item, tries) {
    tries = tries || 0;
    chrome.runtime.sendMessage({ action: "captureOneTab", data: { url: item.url, id: item.id, delay: B ? B.delay : 0 } }, function (resp) {
      if (chrome.runtime.lastError) {
        if (/invalidated|disconnected/i.test(chrome.runtime.lastError.message)) { die(chrome.runtime.lastError.message); B = null; inFlight = 0; return; }
        if (tries < 5 && B && !localStorage.getItem("ia_batch_cancel")) { setTimeout(function () { dispatch(item, tries + 1); }, 1500); return; } // keep slot, retry same item
        inFlight--; if (B) { B.done++; saveState(); writeProg(B.done, B.total, true); } pump(); return;
      }
      inFlight--;
      if (B) { B.done++; saveState(); writeProg(B.done, B.total, true); }
      pump();
    });
  }

  log("Bridge loaded on " + location.href);
  requestInterval = setInterval(checkForRequest, 500);
  pullInterval = setInterval(pullCaptures, 2000);
  checkForRequest();
  setTimeout(pullCaptures, 1000);
})();
