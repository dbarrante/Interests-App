(function () {
  // Port-probe helpers come from bridge-probe.js (loaded before this file).
  var PORT_RANGE = (typeof self !== "undefined" && self.IA_PORT_RANGE) || [3456,3457,3458,3459,3460,3461,3462,3463,3464,3465];
  var probePorts = (typeof self !== "undefined" && self.IA_probePorts) || function () { return Promise.resolve(null); };

  var alive = true;
  var requestInterval, pullInterval;
  var cachedPort = null;

  function log(msg) { console.log("[Interests Bridge]", msg); }

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

  // Resolve (and cache) the app's port. Re-probes if a cached port goes silent.
  async function findPort() {
    if (cachedPort != null) {
      try {
        const r = await fetch("http://127.0.0.1:" + cachedPort + "/api/ping");
        if (r.ok) { const j = await r.json(); if (j && j.app === "interests") return cachedPort; }
      } catch (e) {}
      cachedPort = null;   // stale — fall through to a fresh probe
    }
    const p = await probePorts(PORT_RANGE, { fetchImpl: fetch });
    cachedPort = p;
    return p;
  }

  async function getJson(path) {
    const port = await findPort();
    if (port == null) return null;
    try {
      const r = await fetch("http://127.0.0.1:" + port + path);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { cachedPort = null; return null; }
  }

  async function postJson(path, body) {
    const port = await findPort();
    if (port == null) return false;
    try {
      const r = await fetch("http://127.0.0.1:" + port + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return !!(r && r.ok);
    } catch (e) { cachedPort = null; return false; }
  }

  // Deliver one capture over HTTP; on failure, stash it in chrome.storage.local
  // so it's flushed when the app is next reachable (the offline fallback).
  async function postCapture(capture) {
    const ok = await postJson("/api/captures", { capture: capture });
    if (!ok) {
      try {
        const stored = await chrome.storage.local.get("ia_capture_queue");
        let q = stored.ia_capture_queue || [];
        if (!Array.isArray(q)) q = [];
        q.push(capture);
        if (q.length > 200) q = q.slice(-200);
        await chrome.storage.local.set({ ia_capture_queue: q });
      } catch (e) {}
    }
    return ok;
  }

  // expose for background.js (it imports this page-context helper indirectly via
  // its own copy; here we publish for any same-context caller / tests)
  try { self.IA_BRIDGE = { findPort: findPort, getJson: getJson, postJson: postJson, postCapture: postCapture }; } catch (e) {}

  // ---- poll the app for a single capture request ----
  async function checkForRequest() {
    if (isDisconnected()) return;
    try {
      const j = await getJson("/api/capture-request");
      if (j && j.request && j.request.url) {
        await postJson("/api/capture-request", { request: null });   // claim it (clear server-side)
        const req = j.request;
        log("Forwarding capture request: " + req.url);
        chrome.runtime.sendMessage({ action: "captureRequest", data: req }, function () {
          if (chrome.runtime.lastError) log("sendMessage error: " + chrome.runtime.lastError.message);
        });
      }
      await driveBatch();
    } catch (e) {
      if (/invalidated|disconnected/i.test(e.message || "")) die(e.message);
      else log("checkForRequest error: " + (e.message || e));
    }
  }

  // ---- flush the background SW's offline queue into the app over HTTP ----
  async function pullCaptures() {
    if (isDisconnected()) return;
    const port = await findPort();
    if (port == null) return;   // app not reachable — hold the queue
    try {
      chrome.runtime.sendMessage({ action: "getQueue" }, async function (resp) {
        if (chrome.runtime.lastError) {
          if (/invalidated|disconnected/i.test(chrome.runtime.lastError.message)) die(chrome.runtime.lastError.message);
          return;
        }
        if (!resp || !resp.queue || !resp.queue.length) return;
        log("Flushing " + resp.queue.length + " queued capture(s) over HTTP");
        let allOk = true;
        for (let i = 0; i < resp.queue.length; i++) {
          const ok = await postJson("/api/captures", { capture: resp.queue[i] });
          if (!ok) { allOk = false; break; }
        }
        if (allOk) chrome.runtime.sendMessage({ action: "clearQueue" }, function () { if (chrome.runtime.lastError) {} });
      });
    } catch (e) {
      if (/invalidated|disconnected/i.test(e.message || "")) die(e.message);
    }
  }

  // ---- batch driver (loop lives here, in the stable page context) ----
  // Reads ia_batch_state from the app via /api/batch-state; reports progress via
  // /api/batch-progress; serializes captures through the background worker.
  var B = null, inFlight = 0;
  async function writeProg(done, total, active) {
    // Server route reads req.body.progress — wrap the payload (plan correction).
    await postJson("/api/batch-progress", { progress: { done: done, total: total, active: active, ts: Date.now() } });
  }
  async function saveState() {
    if (!B) return;
    await postJson("/api/batch-state", { state: { items: B.items, next: B.next, done: B.done, total: B.total, delay: B.delay, concurrency: B.conc, render: B.render, active: true } });
  }
  async function endBatch() {
    var done = B ? B.done : 0, total = B ? B.total : 0;
    B = null; inFlight = 0;
    await writeProg(done, total, false);
    await postJson("/api/batch-state", { state: null });
    try { chrome.runtime.sendMessage({ action: "cleanupBatch" }, function () {}); } catch (e) {}
    log("Batch finished " + done + "/" + total);
  }
  async function driveBatch() {
    if (isDisconnected()) return;
    if (!B) {
      const j = await getJson("/api/batch-state");
      const st = j && j.state;
      if (!st || !st.items || !st.items.length) return;
      var startAt = (typeof st.next === "number") ? st.next : (st.done || 0);
      if (startAt >= st.items.length) { await postJson("/api/batch-state", { state: null }); return; }
      B = { items: st.items, next: startAt, done: st.done || 0, total: st.items.length, delay: st.delay || 0, conc: Math.max(1, Math.min(10, st.concurrency || 1)), render: !!st.render };
      log("Batch start: " + B.total + " items, concurrency " + B.conc);
    }
    pump();
  }
  function pump() {
    if (!B) return;
    if (B.next >= B.items.length && inFlight === 0) { endBatch(); return; }
    while (B && inFlight < B.conc && B.next < B.items.length) {
      var item = B.items[B.next++];
      saveState();
      inFlight++;
      dispatch(item);
    }
  }
  function dispatch(item) {
    chrome.runtime.sendMessage({ action: "captureOneTab", data: { url: item.url, id: item.id, delay: B ? B.delay : 0, render: B ? B.render : false } }, function (resp) {
      if (chrome.runtime.lastError && /invalidated|disconnected/i.test(chrome.runtime.lastError.message)) { die(chrome.runtime.lastError.message); B = null; inFlight = 0; return; }
      inFlight--;
      if (B) { B.done++; saveState(); writeProg(B.done, B.total, true); }
      pump();
    });
  }

  log("HTTP bridge loaded on " + location.href);
  requestInterval = setInterval(checkForRequest, 800);
  pullInterval = setInterval(pullCaptures, 2500);
  checkForRequest();
  setTimeout(pullCaptures, 1000);
})();
