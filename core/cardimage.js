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
// The response TYPE is decided by sniffing the bytes (sniffStrict below), not by the
// upstream's Content-Type header; the header allowlist is only a cheap early reject.
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

// Raster-only allowlist (review finding 1) — deliberately an allowlist of INERT RASTER
// types, not a broad `/^image\//i` test. A broad test also matches image/svg+xml, an
// active document format that can carry <script> — and this module's bytes get served
// back verbatim, from the app's own origin, by POST /api/fetch-card-image. The consumer
// (OCR, vision-model input, perceptual hashing) only ever decodes to a bitmap, so nothing
// here needs a vector/document format; svg (and any other +xml type) stays excluded on
// purpose.
//
// Includes nonstandard aliases real servers actually emit (image/jpg, image/x-png, etc.)
// alongside the registered types, all still inert raster formats. This isn't cosmetic:
// every failure in this route collapses to the same silent 404 (see server.js), so a
// rejected alias is indistinguishable from a broken pipeline — it silently reproduces the
// exact "AI title pipeline produces nothing" bug this whole feature exists to fix, with
// zero observability. Case-insensitive; the caller splits off any ";charset=..."
// parameter before comparing.
//
// This allowlist is only a CHEAP EARLY REJECT on the header. It does not decide the
// answer — sniffStrict (below) reads the bytes and is authoritative. The two are kept
// deliberately in agreement: every canonical type sniffStrict can return is in this set,
// and every raster type in this set is one sniffStrict can positively identify, so the
// header stage never lets through a type the byte stage then silently 404s.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/x-png", "image/apng",
  "image/gif", "image/webp", "image/avif", "image/bmp",
  "image/heic", "image/heif", "image/tiff", "image/x-icon", "image/vnd.microsoft.icon",
]);

// Decide the image type from the BYTES, never from the upstream's Content-Type header.
// Returns a single canonical type literal chosen HERE, or null for anything outside the
// raster set — and the caller refuses on null.
//
// Why sniff at all when the header is already allowlisted: the header is written by the
// origin server, which is attacker-influenced (cards come from captures/imports of
// arbitrary pages). An allowlist applied to the header still lets that server send SVG
// (or any document) bytes under an allowlisted Content-Type like image/png, which
// POST /api/fetch-card-image would otherwise echo back from our own origin. Sniffing
// makes the served type one WE derived from the bytes, and refuses a body that is not a
// recognised raster image regardless of what the header claimed.
//
// Deliberately NOT images.sniffImageType: that one defaults unknown bytes to "image/jpeg"
// (correct where it lives — typing a file the store already accepted — but wrong here,
// where it would relabel an SVG as a JPEG and launder it through as ok:true).
//
// The recognised set mirrors ALLOWED_IMAGE_TYPES' raster types exactly (see the invariant
// note above). APNG shares the PNG signature; the jpg/x-png/vnd.microsoft.icon header
// aliases normalise to their canonical sniffed type.
//
// DELIBERATELY NARROWER than a header-trusting gate for two rare byte-variants, both
// availability-only (they 404 instead of serving), both accepted knowingly: (1) BigTIFF
// ("II\x2b\0" / "MM\0\x2b") — a >4GB format, so any real one is already refused by the
// MAX_BYTES cap before this runs; (2) ISO-BMFF files whose major brand is outside the
// enumerated HEIF/AVIF set below. A survey of the library found zero of any of these
// formats, so the trade (a positive raster allowlist over a document-format denylist) is
// worth the lost breadth. If a real one ever shows up, widen here — never fall back to the
// header for a null sniff, which would re-admit an SVG body wearing an image/tiff header.
function sniffStrict(buf) {
  if (!buf || buf.length < 2) return null;
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG (and APNG, same signature): 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  // GIF: "GIF87a" / "GIF89a"
  if (buf.length >= 6 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
  // WEBP: "RIFF"????"WEBP"
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (buf.length >= 4 &&
      ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
       (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))) return "image/tiff";
  // ICO: 00 00 01 00 (CUR's 00 00 02 00 is deliberately excluded)
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "image/x-icon";
  // ISO-BMFF container (avif/heic/heif): bytes 4..7 = "ftyp", major brand at 8..11.
  // Any other ftyp brand (mp4/mov/…) is not an image we serve and returns null.
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString("latin1", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "heim" ||
        brand === "heis" || brand === "hevc" || brand === "hevx") return "image/heic";
    if (brand === "mif1" || brand === "msf1") return "image/heif";
    return null;
  }
  return null;
}

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

  // Fail CLOSED on an unresolvable name — unconditionally, by default. This is
  // NOT opt-in: resolve with the shared default resolver unless the caller
  // supplies opts.lookup, which is a test seam only — it changes WHICH
  // resolver answers the question, never WHETHER the question gets asked.
  // safeToFetch fails OPEN on a lookup error on purpose (so link-probing can
  // surface ENOTFOUND as "dead"); a byte fetch has no such need, so this block
  // does its own resolution first and refuses before any bytes move if the
  // name doesn't resolve. The same resolver is then handed to safeToFetch (as
  // opts.lookup below, via safeOpts) so the two checks — and the per-hop
  // redirect re-validation in followRedirects further down — all agree on
  // what the hostname resolves to. A security property that depends on a
  // caller remembering an optional argument isn't one; making this the
  // default is the fix for exactly that (a naive production HTTP route that
  // omits opts.lookup must still get the fail-closed behavior). The default
  // itself is linkcheck's shared module-level resolver (linkcheck._getLookup()),
  // not a fresh require("dns") lookup — that resolver is swappable in-process
  // via linkcheck._setLookup(), which is the seam HTTP endpoint tests rely on
  // when they cannot thread opts.lookup through a real request.
  const lookup = opts.lookup || linkcheck._getLookup();
  const safeOpts = { lookup };
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
  catch (e) { return { ok: false, reason: "blocked" }; }
  const isLiteralAddr = host.indexOf(":") >= 0 || /^[0-9.]+$/.test(host);
  if (!isLiteralAddr) {
    try { await lookup(host, { all: true }); }
    catch (e) { return { ok: false, reason: "blocked" }; }
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
  // Cheap early reject on the header — excludes image/svg+xml and non-image types
  // before we buffer or sniff. It does NOT decide the answer; the bytes below do.
  if (!ALLOWED_IMAGE_TYPES.has(ct.split(";")[0].trim().toLowerCase())) return { ok: false, reason: "not-an-image" };

  const buf = r.buffer || Buffer.alloc(0);
  if (!buf.length) return { ok: false, reason: "fetch-failed" };
  if (buf.length > MAX_BYTES) return { ok: false, reason: "too-large" };

  // Authoritative type from the bytes, never the header — sniff AFTER the length gates so
  // it never reads an empty or over-cap buffer. An upstream that declares image/png and
  // sends SVG is refused here rather than echoed back with a type of its choosing; same
  // "not-an-image" reason as a bad header, so the route's single generic 404 stays uniform.
  const sniffed = sniffStrict(buf);
  if (!sniffed) return { ok: false, reason: "not-an-image" };

  return { ok: true, contentType: sniffed, buffer: buf };
}

module.exports = { fetchCardImage, remoteImageUrlFor, sniffStrict, MAX_BYTES, TIMEOUT_MS, MAX_REDIRECTS };
