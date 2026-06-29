// Pure helpers for the AI soft-dead confirmation tier (dual browser/Node, like
// web/route-capture.js). The AI call itself reuses index.html's provider dispatch;
// these only build the prompt, parse the reply, and build a recovery link.
(function (root) {
  "use strict";

  function buildDeadCheckPrompt(info) {
    info = info || {};
    var title = String(info.title || "").slice(0, 300);
    var snippet = String(info.snippet || "").slice(0, 1500);
    return [
      "You are checking whether a saved web link is DEAD (the original content is gone:",
      "removed, deleted, a 404/error page, a parked/for-sale domain, or a redirect to a generic homepage).",
      "A page that still shows its real content is ALIVE, even if it asks for login or shows ads.",
      "",
      "URL: " + String(info.url || ""),
      "Page title: " + title,
      "Page text (start): " + snippet,
      "",
      'Respond with ONLY a JSON object, no prose: {"dead": true or false, "reason": "<short reason>"}'
    ].join("\n");
  }

  function parseDeadVerdict(text) {
    var s = String(text || "");
    var m = s.match(/\{[\s\S]*\}/);   // first {...} block (handles code fences / prose)
    if (m) {
      try {
        var o = JSON.parse(m[0]);
        return { dead: o.dead === true, reason: typeof o.reason === "string" ? o.reason : "" };
      } catch (e) { /* fall through */ }
    }
    return { dead: false, reason: "" };
  }

  function waybackUrl(url) {
    return "https://web.archive.org/web/2/" + String(url || "");
  }

  var api = { buildDeadCheckPrompt: buildDeadCheckPrompt, parseDeadVerdict: parseDeadVerdict, waybackUrl: waybackUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.buildDeadCheckPrompt = buildDeadCheckPrompt; root.parseDeadVerdict = parseDeadVerdict; root.waybackUrl = waybackUrl; }
})(typeof self !== "undefined" ? self : this);
