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
      if (!raw) return;
      var req = JSON.parse(raw);
      if (!req || !req.url) return;
      localStorage.removeItem(REQUEST_KEY);
      log("Forwarding capture request: " + req.url);
      chrome.runtime.sendMessage({ action: "captureRequest", data: req }, function() {
        if (chrome.runtime.lastError) log("sendMessage error: " + chrome.runtime.lastError.message);
      });
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

  log("Bridge loaded on " + location.href);
  requestInterval = setInterval(checkForRequest, 500);
  pullInterval = setInterval(pullCaptures, 2000);
  checkForRequest();
  setTimeout(pullCaptures, 1000);
})();
