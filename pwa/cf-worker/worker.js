// Cloudflare Worker: server-side content-check proxy for the iPad PWA's Stumble
// mode. Ports core/contentcheck.js's classification logic (decodeEntities,
// extractTitle, extractText, DEAD_PHRASES, CHALLENGE_PHRASES, classifyContent)
// as close to verbatim as the Workers runtime allows, so the browser-side
// `isVerifiedDiscoveryResult()` in web/lib/capture-state.js — which expects
// { id, finalUrl, status, title, snippet, verdict, reason, signals, ogImage }
// per item — works completely unmodified. A browser can't do this itself:
// almost no site sets CORS headers permissive enough for a page on a different
// origin to read its response status/body, so the fetch has to happen here,
// server-side, where CORS doesn't apply to outbound requests.
//
// Deploy via the Cloudflare dashboard's Worker quick-editor (paste this file,
// no build step, no wrangler CLI needed) — see ../README.md for the full
// walkthrough. Free tier: 100,000 requests/day, far more than a single-user
// Stumble feed will ever need.

const AUTH_HEADER = "x-auth-token"; // must match the AUTH_TOKEN secret set in the Worker's settings
const CONCURRENCY = 6;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5; // fetch() follows redirects itself; this just caps how many hops we'll accept before giving up

// ---- ported verbatim from core/contentcheck.js ----
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–" };
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => { const v = NAMED_ENTITIES[name.toLowerCase()]; return v != null ? v : m; });
}
function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}
function extractText(html, maxChars) {
  const max = maxChars || 4000;
  const s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}
const DEAD_PHRASES = [
  "page not found", "page can't be found",
  "404 not found", "error 404", "not found",
  "no longer available", "no longer exists", "isn't available",
  "is not available", "content unavailable", "this content isn't available",
  "doesn't exist", "does not exist",
  "has been removed", "been deleted", "this listing has ended",
  "item is no longer", "product is no longer", "sorry, this page",
  "the page you requested", "domain is for sale", "buy this domain",
  "not the page you're looking for", "not the page you are looking for",
  "sorry page not found", "page cannot be found", "page could not be found"
];
const CHALLENGE_PHRASES = [
  "just a moment", "attention required", "access is temporarily restricted",
  "performing security verification", "checking your browser", "verify you are human",
  "verifying you are human", "are you a robot", "enable javascript and cookies to continue",
  "security check to access", "detected unusual activity"
];
function pathOf(url) { try { return new URL(url).pathname || "/"; } catch (e) { return ""; } }
function hostOf(url) { try { return new URL(url).hostname || ""; } catch (e) { return ""; } }

function classifyContent(info) {
  info = info || {};
  const title = String(info.title || "");
  const text = String(info.text || "");
  const hay = decodeEntities(title + " " + text).toLowerCase().replace(/[‘’]/g, "'");
  let challenge = false;
  for (const phrase of CHALLENGE_PHRASES) { if (hay.indexOf(phrase) >= 0) { challenge = true; break; } }
  let signals = [];
  for (const phrase of DEAD_PHRASES) { if (hay.indexOf(phrase) >= 0) { signals.push("phrase:" + phrase); break; } }
  if (info.finalUrl) {
    const op = pathOf(info.originalUrl), fp = pathOf(info.finalUrl);
    const oh = hostOf(info.originalUrl), fh = hostOf(info.finalUrl);
    if (oh && oh === fh && op && op.replace(/\/+$/, "").length > 0 && (fp === "/" || fp === "")) signals.push("redirect-home");
  }
  if (text.trim().length < 40) signals.push("empty");
  if (challenge) signals = signals.filter((s) => s !== "empty");
  const reasonMap = { "redirect-home": "redirected to homepage", "empty": "page is nearly empty" };
  let reason = challenge ? "bot-challenge page" : "looks alive";
  if (signals.length) {
    const first = signals[0];
    reason = first.indexOf("phrase:") === 0 ? `page text says "${first.slice(7)}"` : (reasonMap[first] || "looks removed");
  }
  const verdict = signals.length ? "suspect" : "likely-alive";
  if (challenge) signals = signals.concat(["challenge"]);
  return { verdict, reason, signals };
}

// ---- SSRF guard (simplified vs. desktop's guardedfetch.js — no DNS-rebinding
// re-check per hop, since Workers don't expose a raw-socket/DNS API for that;
// this blocks the obvious cases: non-http(s) schemes and literal private/
// loopback/link-local hosts). Good enough for a personal single-user proxy,
// not a hardened public-internet SSRF shield — don't reuse this for a
// multi-tenant service without revisiting. ----
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const [a, b] = [parseInt(m4[1], 10), parseInt(m4[2], 10)];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}
function safeToFetch(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (isPrivateHost(u.hostname)) return false;
  return true;
}

async function fetchContent(url) {
  if (!safeToFetch(url)) return { finalUrl: url, status: 0, title: "", snippet: "", ogImage: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow", // fetch() itself caps redirects sanely; MAX_REDIRECTS is a documented intent, not separately enforced here
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; InterestsAppContentCheck/1.0)" },
    });
    const finalUrl = res.url || url;
    if (!safeToFetch(finalUrl)) return { finalUrl, status: 0, title: "", snippet: "", ogImage: "" }; // a redirect landed somewhere unsafe
    const reader = res.body ? res.body.getReader() : null;
    let bytes = new Uint8Array(0);
    if (reader) {
      let total = 0;
      while (total < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(bytes.length + value.length);
        merged.set(bytes); merged.set(value, bytes.length);
        bytes = merged; total += value.length;
      }
      try { reader.cancel(); } catch (e) {}
    }
    const body = new TextDecoder("utf-8").decode(bytes); // fatal:false, ignoreBOM:false are both already the defaults
    let ogImage = "";
    try {
      const ogm = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(body) ||
                  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(body);
      if (ogm) { const abs = new URL(ogm[1], finalUrl).href; if (/^https?:\/\//i.test(abs)) ogImage = abs; }
    } catch (e) { ogImage = ""; }
    return { finalUrl, status: res.status, title: extractTitle(body), snippet: extractText(body), ogImage };
  } catch (e) {
    return { finalUrl: url, status: 0, title: "", snippet: "", ogImage: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

function isSkippedHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    // Social/login-gated hosts a bare fetch can never meaningfully evaluate
    // (they always return a generic login-wall page, not the real content).
    return ["facebook.com", "www.facebook.com", "m.facebook.com", "instagram.com", "www.instagram.com"].some((d) => h === d || h.endsWith("." + d));
  } catch (e) { return true; }
}

async function checkContentChunk(items) {
  return runPool(items, CONCURRENCY, async (item) => {
    const url = item && item.url;
    if (typeof url !== "string" || isSkippedHost(url) || !safeToFetch(url)) {
      return { id: item && item.id, status: "skipped", verdict: "skipped", reason: "skipped", finalUrl: url || "", title: "", snippet: "", ogImage: "" };
    }
    const c = await fetchContent(url);
    const cls = classifyContent({ originalUrl: url, finalUrl: c.finalUrl, status: c.status, title: c.title, text: c.snippet });
    return { id: item.id, finalUrl: c.finalUrl, status: c.status, title: c.title, snippet: c.snippet, verdict: cls.verdict, reason: cls.reason, signals: cls.signals, ogImage: c.ogImage || "" };
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your GitHub Pages origin once deployed there (Phase 6)
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

    const token = request.headers.get(AUTH_HEADER);
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    let body;
    try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }); }
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []; // cap per-request batch size

    const results = await checkContentChunk(items);
    return new Response(JSON.stringify({ results }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  },
};
