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
    if (/^ff[0-9a-f]{2}:/.test(h)) return true;           // ff00::/8 multicast
    // 6to4 (2002:AABB:CCDD::/48) and NAT64 (64:ff9b::/96) embed an IPv4 address in fixed
    // hextet positions. "::" compression elides any all-zero hextet -- including an
    // embedded octet-pair that happens to be zero (e.g. "2002:7f00::" wraps 127.0.0.0) --
    // so expand to the full 8 hextets FIRST and read by position, rather than regex-matching
    // the compressed text (which silently misses those all-zero cases and reports "public").
    var hx = _v6Hextets(h);
    if (hx) {
      if (_hxNum(hx[0]) === 0x2002) return isPrivateAddr(_v4FromHextets(hx[1], hx[2]));
      if (_hxNum(hx[0]) === 0x64 && _hxNum(hx[1]) === 0xff9b &&
          _hxNum(hx[2]) === 0 && _hxNum(hx[3]) === 0 && _hxNum(hx[4]) === 0 && _hxNum(hx[5]) === 0) {
        return isPrivateAddr(_v4FromHextets(hx[6], hx[7]));
      }
    }
    return false;
  }
  var m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    var a = +m[1], b = +m[2], c = +m[3];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64/10 CGNAT
    if (a === 192 && b === 0 && c === 0) return true;     // 192.0.0.0/24 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true;                            // 224/4 multicast + 240/4 reserved + 255.255.255.255
    return false;
  }
  return false;
}

// "7f00","0001" -> "127.0.0.1". Used to unwrap 6to4 / NAT64 IPv6 forms.
function _v4FromHextets(hi, lo) {
  var a = parseInt(hi, 16) || 0, b = parseInt(lo, 16) || 0;
  return [(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join(".");
}

// One hextet -> number, for positional 6to4/NAT64 prefix comparisons below. Garbage
// (non-hex text) parses to 0 -- the guard's over-block bias is intentional here.
function _hxNum(s) { return parseInt(s, 16) || 0; }

// Expand an IPv6 address (already lowercased, no brackets) to its 8 hextets, resolving
// any "::" compression positionally so a 6to4/NAT64 embedded IPv4 can be read by fixed
// index regardless of where zeros were elided. Returns null for a malformed address
// (more than one "::", too many hextets, or a fully-written address that isn't exactly
// 8 hextets). The final tail hextet may be a dotted-quad (legal IPv6 text, e.g.
// "64:ff9b::8.8.8.8") -- normalized to its two hex hextets before counting.
function _v6Hextets(h) {
  var parts = h.split("::");
  if (parts.length > 2) return null;                // "a::b::c" -- more than one "::"
  var head = parts[0] ? parts[0].split(":") : [];
  var tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  // A dotted-quad can stand in for the last two hextets (legal IPv6 text, e.g.
  // "64:ff9b::8.8.8.8" or a fully-written "...:0:8.8.8.8") -- it's always the final
  // group of whichever side actually has one. Normalize it in place before counting.
  var last = tail.length ? tail : head;
  if (last.length && last[last.length - 1].indexOf(".") >= 0) {
    var q = last[last.length - 1].match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!q || +q[1] > 255 || +q[2] > 255 || +q[3] > 255 || +q[4] > 255) return null;
    var hi = ((+q[1] << 8) | +q[2]).toString(16), lo = ((+q[3] << 8) | +q[4]).toString(16);
    last.splice(last.length - 1, 1, hi, lo);
  }
  if (parts.length === 1) return head.length === 8 ? head : null;  // no "::": must already be full
  var zeros = 8 - head.length - tail.length;
  if (zeros < 0) return null;                       // more hextets than fit -- invalid
  var mid = [];
  for (var i = 0; i < zeros; i++) mid.push("0");
  return head.concat(mid, tail);
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
function getLookup() { return moduleLookup; }

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

var gf = require("./guardedfetch");
var UA = gf.UA_LINKCHECK;

// Probe ONE url. HEAD first (cheap); retry once with GET if HEAD is unsupported
// (405/501) or errored. Redirects are followed MANUALLY (via guardedfetch.followRedirects)
// so each hop's host is re-validated by safeToFetch — a public url that 30x-redirects to an
// internal/loopback/metadata host is NOT followed (SSRF guard), and its 3xx (=alive) is
// returned. On a probable host we follow to the final status (a moved page that 404s = dead).
var MAX_HOPS = 5;
async function probeUrl(url, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || 8000;
  // One guarded fetch (status + Location only; no body — probes don't read bodies). Maps the
  // guardedfetch error object to linkcheck's error CODE (timeout -> ETIMEDOUT, else e.cause.code).
  async function fetchOnce(target, method) {
    var r = await gf.fetchOnceGuarded(target, { method: method, timeoutMs: timeoutMs, ua: UA, readBody: false });
    if (!r.error) return { status: r.status, code: null, location: r.location };
    // Node's fetch wraps the real DNS/connection error under e.cause; a timeout shows up as an
    // AbortError (whose numeric e.code must NOT be used as the error code).
    var e = r.error, code = "ERR";
    if (e) {
      if (e.name === "AbortError") code = "ETIMEDOUT";
      else if (e.cause && e.cause.code) code = e.cause.code;         // ECONNREFUSED / ENOTFOUND / ...
      else if (typeof e.code === "string") code = e.code;
    }
    return { status: 0, code: code, location: null };
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
  // Follow redirects with the per-hop SSRF re-check; probeOnce is the caller-specific
  // (HEAD-then-GET) fetch. On blocked/badloc/maxhops we report the last 3xx (=> "alive").
  var walk = await gf.followRedirects(url, {
    maxRedirects: MAX_HOPS, lookup: opts.lookup, fetchFn: probeOnce, safeToFetch: safeToFetch
  });
  if (walk.stopReason === "maxhops") return { status: 308, code: null };  // loop/too many hops -> alive
  return { status: walk.result.status, code: walk.result.code };
}

// Probe a chunk of {id,url} with a concurrency cap. Non-probable (SSRF) or
// social-skip urls are reported "skipped" WITHOUT a network request.
async function checkChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 8, 8);
  var timeoutMs = opts.timeoutMs || 8000;
  var arr = Array.isArray(items) ? items : [];
  return gf.runPool(arr, concurrency, async function (item) {
    var it = item || {};
    var url = it.url;
    // String guard + social-skip are cheap; the DNS rebinding check (safeToFetch) only runs
    // for urls that pass them — a domain that resolves private is skipped without a request.
    if (typeof url !== "string" || !isProbableHost(url) || isSkippedHost(url) || !(await safeToFetch(url, opts))) {
      return { id: it.id, status: "skipped", code: null };
    }
    var p = await probeUrl(url, { timeoutMs: timeoutMs, lookup: opts.lookup });
    return { id: it.id, status: classify(p.status, p.code), code: (p.code != null ? p.code : p.status) };
  });
}

module.exports = { classify: classify, isSkippedHost: isSkippedHost, isProbableHost: isProbableHost, isPrivateAddr: isPrivateAddr, safeToFetch: safeToFetch, _setLookup: setLookup, _getLookup: getLookup, SKIP_HOSTS: SKIP_HOSTS, probeUrl: probeUrl, checkChunk: checkChunk };
