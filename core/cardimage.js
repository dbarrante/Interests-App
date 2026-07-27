// core/cardimage.js — fetch a CARD's remote image, server-side.
//
// The unit of request is a CARD ID, never a URL. That is the load-bearing SSRF
// mitigation: a caller cannot name a destination, only ask for a re-fetch of a
// URL the library already stores. The address guards below are defense in
// depth, because a stored URL is still untrusted — imports and captures come
// from third-party pages.
//
// Everything here composes guards that already exist:
//   linkcheck.safeToFetch  — scheme allowlist, localhost/.local, numeric-host
//                            encodings, private/loopback/link-local ranges, and
//                            a resolve-ALL-records DNS check.
//   guardedfetch           — timeout, byte cap, per-hop redirect re-validation.
//
// KNOWN, UNFIXED (app-wide, pre-existing — do not let a review think it is
// handled here): safeToFetch validates by HOSTNAME and the HTTP client then
// re-resolves at connect time, so a resolver that flips between the two lookups
// can still land on loopback (TOCTOU). Closing it needs connect-time address
// pinning across every caller (linkcheck, capturemeta, this), not a local patch.
"use strict";
const linkcheck = require("./linkcheck");
const gf = require("./guardedfetch");
const dbm = require("./db");

const MAX_BYTES = 8 * 1024 * 1024;   // a card thumbnail is orders of magnitude smaller
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

function remoteImageUrlFor(db, id) {
  const card = dbm.getCard(db, id);
  if (card) return String(card.img || "");
  const item = dbm.getSaved(db, id);
  if (item) return String(item.image || "");
  return null;   // null = no such row; "" = row exists but has no remote image
}

async function fetchCardImage(db, id, opts) {
  opts = opts || {};
  const url = remoteImageUrlFor(db, id);
  if (url === null) return { ok: false, reason: "not-found" };
  // "" (no image at all) and an "idb:..." local-file pointer both fail this test —
  // that is the intended "no remote image" case, not a scheme problem.
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "no-remote-image" };
  // https only: a stored http:// URL is refused outright, never fetched in the
  // clear. safeToFetch's scheme allowlist accepts BOTH http and https (it exists
  // for dead-link probing, which doesn't care about transport security), so this
  // gate is enforced here, not inherited from safeToFetch.
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: "blocked" };

  // Fail CLOSED on an unresolvable name — but ONLY when the caller supplies its
  // own opts.lookup. safeToFetch fails OPEN on a lookup error on purpose (so
  // link-probing can surface ENOTFOUND as "dead"); this block exists to NOT
  // inherit that for a byte fetch. KNOWN GAP: a caller that omits opts.lookup
  // (e.g. an HTTP route that doesn't thread one through) gets NO fail-closed
  // check at all here and inherits safeToFetch's fail-open behavior via the
  // safeToFetch call below — the "must not fail open" property only holds when
  // the caller passes opts.lookup (even just the real dns.promises.lookup).
  // This isn't a style choice: this module's own tests (cardimage.test.js) use
  // an unstubbed, non-resolving hostname ("cdn.example.com") in several cases
  // and expect the fetch to PROCEED, which is only possible because the
  // fail-closed check is conditional. Making it unconditional (tried during
  // implementation) makes those cases block instead and breaks the test file
  // as given. Whoever wires the HTTP route in front of this (Task 3) MUST pass
  // opts.lookup explicitly to get the fail-closed behavior in production.
  const lookup = opts.lookup || null;
  const safeOpts = lookup ? { lookup } : {};
  if (lookup) {
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
    catch (e) { return { ok: false, reason: "blocked" }; }
    const isLiteralAddr = host.indexOf(":") >= 0 || /^[0-9.]+$/.test(host);
    if (!isLiteralAddr) {
      try { await lookup(host, { all: true }); }
      catch (e) { return { ok: false, reason: "blocked" }; }
    }
  }
  if (!(await linkcheck.safeToFetch(url, safeOpts))) return { ok: false, reason: "blocked" };

  // maxBytes: MAX_BYTES + 1, not MAX_BYTES — drainCapped (guardedfetch.js) stops
  // ACCUMULATING at the cap and returns a buffer whose length is at most the cap
  // it was given, so buf.length > MAX_BYTES below could never fire if capped at
  // exactly MAX_BYTES. Asking for one byte more makes an over-cap body detectable
  // instead of silently truncating and returning it as ok:true.
  const fetchFn = opts.fetchFn
    || function (target) { return gf.fetchOnceGuarded(target, { method: "GET", timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES + 1, ua: gf.UA_CAPTURE }); };

  let hop;
  try {
    hop = await gf.followRedirects(url, {
      maxRedirects: MAX_REDIRECTS,
      fetchFn: fetchFn,
      safeToFetch: function (next) { return linkcheck.safeToFetch(next, safeOpts); },
    });
  } catch (e) { return { ok: false, reason: "fetch-failed" }; }

  const r = hop && hop.result;
  if (!r || r.error) return { ok: false, reason: "fetch-failed" };
  if (hop.stopReason !== "terminal") return { ok: false, reason: "blocked" };
  if (!(r.status >= 200 && r.status < 300)) return { ok: false, reason: "fetch-failed" };

  const ct = (r.res && r.res.headers && typeof r.res.headers.get === "function")
    ? String(r.res.headers.get("content-type") || "") : "";
  if (!/^image\//i.test(ct)) return { ok: false, reason: "not-an-image" };

  const buf = r.buffer || Buffer.alloc(0);
  if (!buf.length) return { ok: false, reason: "fetch-failed" };
  if (buf.length > MAX_BYTES) return { ok: false, reason: "too-large" };

  return { ok: true, contentType: ct.split(";")[0].trim(), buffer: buf };
}

module.exports = { fetchCardImage, remoteImageUrlFor, MAX_BYTES, TIMEOUT_MS, MAX_REDIRECTS };
