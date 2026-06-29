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

module.exports = { classify: classify, isSkippedHost: isSkippedHost, isProbableHost: isProbableHost, SKIP_HOSTS: SKIP_HOSTS };
