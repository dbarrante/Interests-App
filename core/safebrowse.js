// Google Safe Browsing v4 lookup. PURE builder/parser + a batched API call (Task 2).
// Only outbound host is the fixed safebrowsing.googleapis.com (no SSRF surface).
"use strict";

var ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";
var THREAT_TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"];
var BATCH = 500;

function buildLookupBody(urls, clientId, clientVersion) {
  var list = Array.isArray(urls) ? urls : [];
  var entries = list.map(function (u) { return { url: String(u) }; });
  return {
    client: { clientId: clientId || "interests-app", clientVersion: clientVersion || "1.0" },
    threatInfo: {
      threatTypes: THREAT_TYPES,
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: entries
    }
  };
}

function parseLookupResponse(json) {
  var out = {};
  var matches = json && json.matches;
  if (Array.isArray(matches)) {
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      var u = m && m.threat && m.threat.url;
      if (u && !out[u]) out[u] = m.threatType || "THREAT";
    }
  }
  return out;
}

var UA = "Mozilla/5.0 InterestsApp SafeBrowse";

// Look up urls against Safe Browsing in batches of BATCH. Fail-open: a batch that errors
// returns its urls with threat:null + error:true (never a false "unsafe" on an API failure).
async function checkUrls(urls, apiKey, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var list = Array.isArray(urls) ? urls : [];

  async function lookup(slice) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      var res = await fetch(ENDPOINT + "?key=" + encodeURIComponent(apiKey), {
        method: "POST",
        signal: ac.signal,
        headers: { "Content-Type": "application/json", "User-Agent": UA, "Connection": "close" },
        body: JSON.stringify(buildLookupBody(slice))
      });
      if (!res.ok) return { map: {}, failed: true };
      return { map: parseLookupResponse(await res.json()), failed: false };
    } catch (e) {
      return { map: {}, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  var results = [];
  for (var i = 0; i < list.length; i += BATCH) {
    var slice = list.slice(i, i + BATCH);
    var r = await lookup(slice);
    for (var j = 0; j < slice.length; j++) {
      var u = slice[j];
      results.push({ url: u, threat: r.map[u] || null, error: r.failed ? true : undefined });
    }
  }
  return results;
}

// One benign-URL lookup to check the key is accepted by Google. Distinguishes a working key
// (200) from a rejected one (4xx) from a transient network failure (throw). Never returns/logs the key.
async function verifyKey(apiKey, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var ac = new AbortController(); var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
  try {
    var res = await fetch(ENDPOINT + "?key=" + encodeURIComponent(apiKey), {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", "Connection": "close" },
      body: JSON.stringify(buildLookupBody(["https://example.com/"]))
    });
    if (res.ok) return { ok: true, status: "active" };
    if (res.status >= 400 && res.status < 500) return { ok: false, status: "invalid" };
    return { ok: false, status: "error" };
  } catch (e) { return { ok: false, status: "error" }; }
  finally { clearTimeout(timer); }
}

module.exports = { buildLookupBody: buildLookupBody, parseLookupResponse: parseLookupResponse, THREAT_TYPES: THREAT_TYPES, ENDPOINT: ENDPOINT, BATCH: BATCH, checkUrls: checkUrls, verifyKey: verifyKey };
