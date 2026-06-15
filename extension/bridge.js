(function () {
  const REQUEST_KEY = "ia_capture_request";
  const QUEUE_KEY = "ia_captures";

  function log(msg) {
    console.log("[Interests Bridge]", msg);
  }

  function checkForRequest() {
    try {
      const raw = localStorage.getItem(REQUEST_KEY);
      if (!raw) return;
      const req = JSON.parse(raw);
      if (!req || !req.url) return;
      localStorage.removeItem(REQUEST_KEY);
      log("Forwarding capture request: " + req.url);
      chrome.runtime.sendMessage({ action: "captureRequest", data: req });
    } catch (e) {
      log("Error reading capture request: " + e.message);
    }
  }

  function pullCaptures() {
    try {
      chrome.runtime.sendMessage({ action: "getQueue" }, (resp) => {
        if (chrome.runtime.lastError) {
          log("getQueue error: " + chrome.runtime.lastError.message);
          return;
        }
        if (!resp || !resp.queue || !resp.queue.length) return;
        log("Received " + resp.queue.length + " capture(s) from extension");
        let existing = [];
        try {
          const raw = localStorage.getItem(QUEUE_KEY);
          if (raw) existing = JSON.parse(raw);
          if (!Array.isArray(existing)) existing = [];
        } catch (e) {}
        for (const cap of resp.queue) {
          existing.push(cap);
        }
        localStorage.setItem(QUEUE_KEY, JSON.stringify(existing));
        log("Wrote " + resp.queue.length + " capture(s) to app localStorage");
        chrome.runtime.sendMessage({ action: "clearQueue" });
      });
    } catch (e) {
      log("Error pulling captures: " + e.message);
    }
  }

  log("Bridge loaded on " + location.href);
  setInterval(checkForRequest, 500);
  setInterval(pullCaptures, 2000);
  checkForRequest();
  setTimeout(pullCaptures, 1000);
})();
