// Server-side dead-link checking. classify/isSkippedHost/isProbableHost are PURE.
// The probe (probeUrl/checkChunk) is added in the next task.
"use strict";

// Conservative: a link is "dead" ONLY on these. Everything else is "unknown" and is
// never offered for deletion. Avoids false-deleting login-walled / bot-blocked links.
const DEAD_STATUS = { 404: 1, 410: 1, 451: 1 };
const DEAD_CODES = { ENOTFOUND: 1, ECONNREFUSED: 1, ERR_NAME_NOT_RESOLVED: 1 };

function classify(httpStatus, errCode) {
  if (errCode) return DEAD_CODES[errCode] ? "dead" : "unknown";
  var s = Number(httpStatus);
  if (DEAD_STATUS[s]) return "dead";
  if (s >= 200 && s < 400) return "alive";
  return "unknown";
}

// Hosts whose conservative status is unreliable (login walls / SPA 200 for deleted /
// aggressive bot-blocking). Skipped by default — reported "skipped", never dead.
const SKIP_HOSTS = ["instagram.com", "facebook.com", "fb.watch", "threads.net", "youtube.com", "youtu.be"];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
}

function isSkippedHost(url, skipList) {
  var list = skipList || SKIP_HOSTS;
  var host = hostOf(url);
  if (!host) return false;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (host === d || host.slice(-(d.length + 1)) === "." + d) return true;
  }
  return false;
}

// SSRF guard: only public http(s) hosts may be probed. Rejects loopback/private/
// link-local IP literals, localhost, and .local — the prober must never be steerable
// at the Core's own port or internal services via a crafted card url.
function isProbableHost(url) {
  var u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  var host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");  // strip IPv6 brackets
  if (host === "localhost" || host === "::1") return false;
  if (/\.local$|\.localhost$/.test(host)) return false;
  if (/^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:/i.test(host)) return false;   // fc00::/7 (unique-local IPv6)
  var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    var a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  return true;
}

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp link-check";

// Probe ONE url. HEAD first (cheap); retry once with GET if HEAD is unsupported
// (405/501) or errored. redirect:"follow" so the FINAL status is classified (a moved
// page that 404s = dead; a redirect to a login page = 200 = alive = not flagged).
async function probeUrl(url, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || 8000;
  async function once(method) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      // Connection: close — don't pool sockets across the thousands of distinct hosts a
      // sweep touches (also sidesteps a Windows undici keep-alive teardown crash on exit).
      var res = await fetch(url, { method: method, redirect: "follow", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
      return { status: res.status, code: null };
    } catch (e) {
      // Node's fetch wraps the real DNS/connection error under e.cause; a timeout shows
      // up as an AbortError (whose numeric e.code must NOT be used as the error code).
      var code = "ERR";
      if (e) {
        if (e.name === "AbortError") code = "ETIMEDOUT";
        else if (e.cause && e.cause.code) code = e.cause.code;       // ECONNREFUSED / ENOTFOUND / ...
        else if (typeof e.code === "string") code = e.code;
      }
      return { status: 0, code: code };
    } finally {
      clearTimeout(timer);
    }
  }
  var r = await once("HEAD");
  if (r.status === 405 || r.status === 501 || r.status === 0) {
    var g = await once("GET");
    if (g.status !== 0) return g;          // GET reached the server — trust it
    return r.status !== 0 ? r : g;         // both failed — keep whichever has a status/code
  }
  return r;
}

// Probe a chunk of {id,url} with a concurrency cap. Non-probable (SSRF) or
// social-skip urls are reported "skipped" WITHOUT a network request.
async function checkChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 8, 8);
  var timeoutMs = opts.timeoutMs || 8000;
  var arr = Array.isArray(items) ? items : [];
  var results = new Array(arr.length);
  var next = 0;
  async function worker() {
    while (true) {
      var idx = next++;
      if (idx >= arr.length) return;
      var it = arr[idx] || {};
      var url = it.url;
      if (typeof url !== "string" || !isProbableHost(url) || isSkippedHost(url)) {
        results[idx] = { id: it.id, status: "skipped", code: null };
        continue;
      }
      var p = await probeUrl(url, { timeoutMs: timeoutMs });
      results[idx] = { id: it.id, status: classify(p.status, p.code), code: (p.code != null ? p.code : p.status) };
    }
  }
  var pool = [];
  for (var w = 0; w < Math.min(concurrency, arr.length); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

module.exports = { classify: classify, isSkippedHost: isSkippedHost, isProbableHost: isProbableHost, SKIP_HOSTS: SKIP_HOSTS, probeUrl: probeUrl, checkChunk: checkChunk };
