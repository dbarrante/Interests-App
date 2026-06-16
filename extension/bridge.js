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
  var batchBusy = false;
  function writeProg(done, total, active) {
    try { localStorage.setItem("ia_batch_progress", JSON.stringify({ done: done, total: total, active: active, ts: Date.now() })); } catch (e) {}
  }
  function driveBatch() {
    if (batchBusy || isDisconnected()) return;
    var st; try { st = JSON.parse(localStorage.getItem("ia_batch_state") || "null"); } catch (e) { return; }
    if (!st || !st.items || !st.items.length || st.done >= st.items.length) return;
    batchBusy = true;
    runOne();
  }
  function endBatch(done, total) {
    batchBusy = false;
    writeProg(done, total, false);
    try { localStorage.removeItem("ia_batch_state"); } catch (e) {}
    log("Batch finished " + done + "/" + total);
  }
  function runOne() {
    var st; try { st = JSON.parse(localStorage.getItem("ia_batch_state") || "null"); } catch (e) { st = null; }
    if (!st || !st.items) { batchBusy = false; return; }
    if (localStorage.getItem("ia_batch_cancel")) { localStorage.removeItem("ia_batch_cancel"); return endBatch(st.done, st.items.length); }
    if (st.done >= st.items.length) return endBatch(st.done, st.items.length);
    var item = st.items[st.done];
    writeProg(st.done, st.items.length, true);
    chrome.runtime.sendMessage({ action: "captureOneTab", data: { url: item.url, id: item.id, delay: st.delay || 0 } }, function (resp) {
      if (chrome.runtime.lastError) {            // SW was waking/asleep — retry same item shortly
        if (/invalidated|disconnected/i.test(chrome.runtime.lastError.message)) { die(chrome.runtime.lastError.message); batchBusy = false; return; }
        setTimeout(runOne, 1500); return;
      }
      // advance (re-read state so a Stop mid-item is honored)
      var cur; try { cur = JSON.parse(localStorage.getItem("ia_batch_state") || "null"); } catch (e) { cur = st; }
      if (!cur) { batchBusy = false; return; }
      cur.done = (cur.done || 0) + 1;
      try { localStorage.setItem("ia_batch_state", JSON.stringify(cur)); } catch (e) {}
      writeProg(cur.done, cur.items.length, true);
      setTimeout(runOne, 400);
    });
  }

  log("Bridge loaded on " + location.href);
  requestInterval = setInterval(checkForRequest, 500);
  pullInterval = setInterval(pullCaptures, 2000);
  checkForRequest();
  setTimeout(pullCaptures, 1000);
})();
