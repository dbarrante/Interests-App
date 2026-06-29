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

module.exports = { buildLookupBody: buildLookupBody, parseLookupResponse: parseLookupResponse, THREAT_TYPES: THREAT_TYPES, ENDPOINT: ENDPOINT, BATCH: BATCH };
