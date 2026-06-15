(function () {
  const REQUEST_KEY = "ia_capture_request";
  const QUEUE_KEY = "ia_captures";
  const MAX_QUEUE = 20;

  function checkForRequest() {
    try {
      const raw = localStorage.getItem(REQUEST_KEY);
      if (!raw) return;
      const req = JSON.parse(raw);
      if (!req || !req.url) return;
      localStorage.removeItem(REQUEST_KEY);
      chrome.runtime.sendMessage({ action: "captureRequest", data: req });
    } catch (e) {
      console.warn("bridge: error reading capture request", e);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "captureResult" && msg.capture) {
      try {
        let queue = [];
        const raw = localStorage.getItem(QUEUE_KEY);
        if (raw) {
          try { queue = JSON.parse(raw); } catch (e) {}
        }
        if (!Array.isArray(queue)) queue = [];
        const norm = (u) => {
          try { const p = new URL(u); return (p.hostname.replace(/^www\./, "") + p.pathname).replace(/\/$/, "").toLowerCase(); }
          catch (e) { return u.toLowerCase(); }
        };
        queue = queue.filter((c) => norm(c.url) !== norm(msg.capture.url));
        queue.push(msg.capture);
        if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      } catch (e) {
        console.warn("bridge: error writing capture", e);
      }
    }
  });

  setInterval(checkForRequest, 500);
  checkForRequest();
})();
