// ONE SSRF-guarded fetch transport, extracted from the three near-identical copies that
// lived in linkcheck.js (probeUrl), contentcheck.js (fetchContent/readCapped) and
// capturemeta.js (_fetchHtml/_drainToBuffer). See docs/full-review-2026-07-02.md section E.
//
// What this unifies (transport ONLY — each caller keeps its own status/verdict semantics):
//   - AbortController + timeout per fetch;
//   - manual redirect loop that re-runs safeToFetch on EVERY hop (SSRF: a public url that
//     30x-redirects to an internal/loopback/metadata host is NOT followed);
//   - Connection: close (don't pool sockets across the thousands of hosts a sweep touches;
//     also sidesteps a Windows undici keep-alive teardown crash on exit);
//   - the drain-don't-cancel capped body reader (cancelling a not-fully-consumed undici body
//     leaves its parser paused and throws an uncatchable AssertionError on socket end that
//     crashes the Electron main process — v1.3.2 fix). We ship the MOST DEFENSIVE of the two
//     prior variants: capturemeta's _drainToBuffer, which returns a Buffer and additionally
//     falls back to arrayBuffer() then text() for stubs that don't expose a stream (contentcheck's
//     readCapped handled only stream + text). Callers that want a string do .toString("utf8").
//   - ONE shared worker-pool (three hand-rolled copies) and ONE User-Agent-ish base.
//
// safeToFetch is single-sourced in linkcheck.js. To avoid a require cycle at module load
// (linkcheck requires this module for runPool/UA), we require linkcheck LAZILY inside the
// call — by call time Node has fully initialized both modules. opts.safeToFetch can override
// (kept for symmetry; production/tests don't need it since opts.lookup already stubs DNS).
"use strict";

// Shared UA base. NOTE: linkcheck/contentcheck used the "...link-check" suffix and capturemeta
// used "...capture" — the suffix is passed per-call (see UA_LINKCHECK / UA_CAPTURE) so each
// module's exact outgoing User-Agent header is preserved byte-for-byte.
var UA_LINKCHECK = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp link-check";
var UA_CAPTURE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp capture";

function _safeToFetch() {
  // Lazy — avoids a load-time require cycle with linkcheck.
  return require("./linkcheck").safeToFetch;
}

// Drain a response body to a byte cap WITHOUT cancelling. Returns a Buffer. See the header
// note for why cancel() is fatal. Streams via res.body when present; falls back to
// arrayBuffer() then text() (test stubs / responses without a stream).
async function drainCapped(res, maxBytes) {
  if (res && res.body && typeof res.body.getReader === "function") {
    var reader = res.body.getReader();
    var chunks = [], kept = 0;
    // Read to `done` so the socket finishes cleanly; stop ACCUMULATING at the cap but keep
    // reading (drain) so undici's parser isn't left paused. Memory stays bounded.
    while (true) {
      var step = await reader.read();
      if (step.done) break;
      if (kept < maxBytes && step.value) {
        var chunk = Buffer.from(step.value);
        var room = maxBytes - kept;
        if (chunk.length > room) chunk = chunk.subarray(0, room);
        chunks.push(chunk);
        kept += chunk.length;
      }
      // else: past the cap — discard but keep reading so the socket drains cleanly.
    }
    return Buffer.concat(chunks);
  }
  if (res && typeof res.arrayBuffer === "function") {
    var b = Buffer.from(await res.arrayBuffer());
    return b.length > maxBytes ? b.subarray(0, maxBytes) : b;
  }
  if (res && typeof res.text === "function") {
    var b2 = Buffer.from(String((await res.text()) || ""), "utf8");
    return b2.length > maxBytes ? b2.subarray(0, maxBytes) : b2;
  }
  return Buffer.alloc(0);
}

// One guarded fetch of ONE target (no redirect following). Applies AbortController+timeout
// and Connection: close. Reads the body capped+drained UNLESS readBody is false (probes that
// only need the status/location headers skip the body entirely, as probeUrl did with HEAD/GET).
// Returns { status, location, buffer, finalUrl, error } — never throws; on a network/timeout
// error returns { status:0, error:<Error>, ... }. Callers map error/status to their own codes.
async function fetchOnceGuarded(target, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || 8000;
  var method = opts.method || "GET";
  var ua = opts.ua || UA_LINKCHECK;
  var readBody = opts.readBody !== false;
  var maxBytes = opts.maxBytes || 256 * 1024;
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
  try {
    var res = await fetch(target, {
      method: method,
      redirect: "manual",
      signal: ac.signal,
      headers: Object.assign({ "User-Agent": ua, "Connection": "close" }, opts.headers || {})
    });
    var loc = (res.headers && typeof res.headers.get === "function") ? res.headers.get("location") : null;
    var buffer = null;
    if (readBody) {
      try { buffer = await drainCapped(res, maxBytes); } catch (e) { buffer = Buffer.alloc(0); }
    }
    return { status: res.status, location: loc, buffer: buffer, finalUrl: (res.url || target), res: res, error: null };
  } catch (e) {
    return { status: 0, location: null, buffer: readBody ? Buffer.alloc(0) : null, finalUrl: target, res: null, error: e };
  } finally {
    clearTimeout(timer);
  }
}

// Follow a redirect chain manually, re-validating EVERY hop with safeToFetch (SSRF). The
// per-hop fetch is done by fetchFn(target) so callers with special probe logic (HEAD-then-GET)
// can supply it; default is a single guarded fetch with the given opts. Returns the terminal
// hop's result plus { hops, followedTo } and a stopReason of:
//   "terminal"  -> a non-3xx (or 3xx with no Location) response was reached;
//   "blocked"   -> the next hop failed safeToFetch (SSRF) — result is the LAST 3xx;
//   "badloc"    -> Location couldn't be resolved to a URL — result is the last 3xx;
//   "maxhops"   -> hit maxRedirects — result is the last hop.
// This preserves each caller's "stop and report the 3xx" behavior for blocked/badloc/maxhops.
async function followRedirects(url, opts) {
  opts = opts || {};
  var maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 5;
  var safeToFetch = opts.safeToFetch || _safeToFetch();
  var fetchFn = opts.fetchFn || function (target) { return fetchOnceGuarded(target, opts); };
  var current = url;
  for (var hop = 0; hop < maxRedirects; hop++) {
    var r = await fetchFn(current);
    var isRedirect = r.status >= 300 && r.status < 400 && r.location;
    if (!isRedirect) return { result: r, current: current, hop: hop, stopReason: "terminal" };
    var nextUrl;
    try { nextUrl = new URL(r.location, current).href; }
    catch (e) { return { result: r, current: current, hop: hop, stopReason: "badloc" }; }
    if (!(await safeToFetch(nextUrl, opts))) return { result: r, current: current, hop: hop, stopReason: "blocked" };
    current = nextUrl;
  }
  return { result: null, current: current, hop: maxRedirects, stopReason: "maxhops" };
}

// Shared bounded worker pool. Runs workerFn(item, index) over items with at most `concurrency`
// in flight; results are placed by index. Mirrors the three hand-rolled index-cursor pools.
async function runPool(items, concurrency, workerFn) {
  var arr = Array.isArray(items) ? items : [];
  var results = new Array(arr.length);
  var next = 0;
  var n = Math.min(concurrency, arr.length);
  async function worker() {
    while (true) {
      var idx = next++;
      if (idx >= arr.length) return;
      results[idx] = await workerFn(arr[idx], idx);
    }
  }
  var pool = [];
  for (var w = 0; w < n; w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

module.exports = {
  UA_LINKCHECK: UA_LINKCHECK,
  UA_CAPTURE: UA_CAPTURE,
  drainCapped: drainCapped,
  fetchOnceGuarded: fetchOnceGuarded,
  followRedirects: followRedirects,
  runPool: runPool
};
