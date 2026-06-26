// Pure port-probe helper shared by bridge.js (browser) and tests (Node).
// Tries each port's GET /api/ping; resolves to the first that answers
// {app:"interests"}, or null if none do. No `chrome`/DOM references.
async function probePorts(ports, opts) {
  const f = (opts && opts.fetchImpl) || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return null;
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    try {
      const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const tm = ctl ? setTimeout(() => ctl.abort(), 600) : null;
      let r;
      try { r = await f("http://127.0.0.1:" + port + "/api/ping", ctl ? { signal: ctl.signal } : undefined); }
      finally { if (tm) clearTimeout(tm); }
      if (!r || !r.ok) continue;
      const j = await r.json();
      if (j && j.app === "interests") return port;
    } catch (e) { /* port not listening / not us — try next */ }
  }
  return null;
}

const PORT_RANGE = [3456, 3457, 3458, 3459, 3460, 3461, 3462, 3463, 3464, 3465];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { probePorts, PORT_RANGE };
}

// When loaded as a browser content script, expose to the page-context global so
// bridge.js can pick it up (content scripts share one isolated-world `self`).
if (typeof self !== "undefined") {
  self.IA_probePorts = probePorts;
  self.IA_PORT_RANGE = PORT_RANGE;
}
