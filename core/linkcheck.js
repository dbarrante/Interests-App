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

// Classify a NUMERIC IP literal (v4 dotted-quad or v6, no brackets) as private. Covers
// loopback/unspecified/RFC1918/link-local/ULA/site-local, incl. IPv4-mapped v6. Returns
// false for a genuine public address or any non-literal string. Used both for IP literals
// embedded in a url (isProbableHost) and for addresses returned by DNS (safeToFetch).
function isPrivateAddr(ip) {
  var h = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h.indexOf(":") >= 0) {  // IPv6
    if (/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(h)) {  // IPv4-mapped -> test the v4
      return isPrivateAddr(h.replace(/^::ffff:/, ""));
    }
    if (/^::/.test(h)) return true;                       // ::1, ::, ::ffff:<hex> (compat/mapped)
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;        // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;        // fe80::/10 link-local
    if (/^fec[0-9a-f]:/.test(h)) return true;             // fec0::/10 site-local (deprecated)
    return false;
  }
  var m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    var a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  return false;
}

// SSRF guard (synchronous, string-level): only public http(s) hosts may be probed. Rejects
// loopback/private/link-local IP literals, localhost, and .local — the prober must never be
// steerable at the Core's own port or internal services via a crafted card url. NOTE: this
// validates the hostname STRING only; safeToFetch() additionally resolves DNS to catch a
// public-looking name that points at a private IP (rebinding).
function isProbableHost(url) {
  var u;
  try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  var host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");  // strip IPv6 brackets
  if (host === "localhost") return false;
  if (/\.local$|\.localhost$/.test(host)) return false;
  if (host.indexOf(":") >= 0) return !isPrivateAddr(host);     // IPv6 literal (URL canonicalizes it)
  // IPv4 dotted-quad literal — validate against the private ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !isPrivateAddr(host);
  // Gap: any other all-numeric host is a non-standard IPv4 literal (bare-integer
  // "2130706433", octal "0177.0.0.1", hex "0x7f000001"). WHATWG URL canonicalizes most such
  // forms to a dotted-quad above, but reject any that slip through on other runtimes — a real
  // domain always contains a non-numeric label.
  if (/^(0x[0-9a-f]+|[0-9.]+)$/.test(host)) return false;
  return true;
}

// Module-level resolver, settable so in-process tests (e.g. the HTTP endpoint tests, which
// can't pass opts through the request) can stub DNS — mirrors the global.fetch stub pattern.
// Production never calls setLookup, so it stays the real OS resolver.
var moduleLookup = require("dns").promises.lookup;
function setLookup(fn) { moduleLookup = fn || require("dns").promises.lookup; }

// SSRF guard (async, resolution-level): isProbableHost PLUS a DNS check. For a domain host
// it resolves all addresses and blocks if ANY is private/loopback/link-local (DNS rebinding —
// a public-looking name that points inside). A LITERAL IP needs no lookup (isProbableHost
// already validated it). On a resolution FAILURE it returns true on purpose: we don't block,
// we let the real fetch run and surface the genuine error (ENOTFOUND => "dead"), so genuine
// dead links are still detected. opts.lookup overrides the resolver (tests inject a stub —
// no real DNS). Re-check on every redirect hop by passing each next url through here.
async function safeToFetch(url, opts) {
  opts = opts || {};
  if (!isProbableHost(url)) return false;
  var host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch (e) { return false; }
  if (host.indexOf(":") >= 0 || /^[0-9.]+$/.test(host)) return true;  // literal IP: already validated
  var lookup = opts.lookup || moduleLookup;
  var addrs;
  try { addrs = await lookup(host, { all: true }); } catch (e) { return true; }  // unresolved -> let fetch surface it
  if (!Array.isArray(addrs)) return true;
  for (var i = 0; i < addrs.length; i++) {
    if (isPrivateAddr(addrs[i] && addrs[i].address)) return false;
  }
  return true;
}

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp link-check";

// Probe ONE url. HEAD first (cheap); retry once with GET if HEAD is unsupported
// (405/501) or errored. Redirects are followed MANUALLY (redirect:"manual") so each
// hop's host is re-validated by isProbableHost — a public url that 30x-redirects to an
// internal/loopback/metadata host is NOT followed (SSRF guard), and its 3xx (=alive) is
// returned. On a probable host we follow to the final status (a moved page that 404s = dead).
var MAX_HOPS = 5;
async function probeUrl(url, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || 8000;
  async function fetchOnce(target, method) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      // Connection: close — don't pool sockets across the thousands of distinct hosts a
      // sweep touches (also sidesteps a Windows undici keep-alive teardown crash on exit).
      var res = await fetch(target, { method: method, redirect: "manual", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
      var loc = (res.headers && typeof res.headers.get === "function") ? res.headers.get("location") : null;
      return { status: res.status, code: null, location: loc };
    } catch (e) {
      // Node's fetch wraps the real DNS/connection error under e.cause; a timeout shows
      // up as an AbortError (whose numeric e.code must NOT be used as the error code).
      var code = "ERR";
      if (e) {
        if (e.name === "AbortError") code = "ETIMEDOUT";
        else if (e.cause && e.cause.code) code = e.cause.code;       // ECONNREFUSED / ENOTFOUND / ...
        else if (typeof e.code === "string") code = e.code;
      }
      return { status: 0, code: code, location: null };
    } finally {
      clearTimeout(timer);
    }
  }
  async function probeOnce(target) {
    var r = await fetchOnce(target, "HEAD");
    if (r.status === 405 || r.status === 501 || r.status === 0) {
      var g = await fetchOnce(target, "GET");
      if (g.status !== 0) return g;          // GET reached the server — trust it
      return r.status !== 0 ? r : g;         // both failed — keep whichever has a status/code
    }
    return r;
  }
  var current = url;
  for (var hop = 0; hop < MAX_HOPS; hop++) {
    var r = await probeOnce(current);
    if (!(r.status >= 300 && r.status < 400) || !r.location) return { status: r.status, code: r.code };
    var nextUrl;
    try { nextUrl = new URL(r.location, current).href; } catch (e) { return { status: r.status, code: r.code }; }
    // SSRF: never follow a redirect to a non-public host (string guard) OR to a host that
    // RESOLVES to a private IP (rebinding) — stop and report the 3xx (=> "alive", never
    // "dead": conservative, never flagged for deletion).
    if (!(await safeToFetch(nextUrl, opts))) return { status: r.status, code: r.code };
    current = nextUrl;
  }
  return { status: 308, code: null };        // redirect loop / too many hops -> treat as alive (never dead)
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
      // String guard + social-skip are cheap; the DNS rebinding check (safeToFetch) only runs
      // for urls that pass them — a domain that resolves private is skipped without a request.
      if (typeof url !== "string" || !isProbableHost(url) || isSkippedHost(url) || !(await safeToFetch(url, opts))) {
        results[idx] = { id: it.id, status: "skipped", code: null };
        continue;
      }
      var p = await probeUrl(url, { timeoutMs: timeoutMs, lookup: opts.lookup });
      results[idx] = { id: it.id, status: classify(p.status, p.code), code: (p.code != null ? p.code : p.status) };
    }
  }
  var pool = [];
  for (var w = 0; w < Math.min(concurrency, arr.length); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

module.exports = { classify: classify, isSkippedHost: isSkippedHost, isProbableHost: isProbableHost, isPrivateAddr: isPrivateAddr, safeToFetch: safeToFetch, _setLookup: setLookup, SKIP_HOSTS: SKIP_HOSTS, probeUrl: probeUrl, checkChunk: checkChunk };
