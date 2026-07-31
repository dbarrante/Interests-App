// Core HTTP service for the Interests App.
// Phase 1 skeleton: serves the web/ UI statically and exposes GET /api/ping.
// createServer(ctx) is a pure factory (no listen) so it can be mounted on an
// ephemeral port in tests. startServer(ctx, port) binds with [3456..3465] fallback.
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const dbm = require("./db");
const { counts } = dbm;
const images = require("./images");
const { imageCount } = images;
const { importLegacyBackup } = require("./importer");
const backup = require("./backup");
const config = require("./config");
const sync = require("./sync");
const bookmarks = require("./bookmarks");
const linkcheck = require("./linkcheck");
const contentcheck = require("./contentcheck");
const safebrowse = require("./safebrowse");
const capturemeta = require("./capturemeta");
const news = require("./news");
const autoimport = require("./autoimport");
const captureQueue = require("./capture-queue");
const cardimage = require("./cardimage");

const WEB_DIR = path.join(__dirname, "..", "web");
const VERSION = require("../package.json").version;

const PORT_MIN = 3456;
const PORT_MAX = 3465;
const GLOBAL_JSON_BODY_CAP = 16 * 1024 * 1024;
const CAPTURE_BODY_CAP = 8 * 1024 * 1024;
const AUTOIMPORT_BODY_CAP = 1024 * 1024;
// Duplicate-review decisions are small metadata-only payloads; no reason to
// let them ride on the large image/import parser budget.
const NOT_DUPLICATE_BODY_CAP = 384 * 1024;

// Origins allowed to reach the local API. The app UI runs on the loopback
// address (http://127.0.0.1:<port> / http://localhost:<port>) and the Chrome
// extension sends an Origin of chrome-extension://<id>. Same-origin GETs the
// browser makes for the page itself carry NO Origin header, which is also
// allowed. A malicious web page the user visits would send its own (https://…)
// Origin, which is rejected — this is the CSRF / drive-by-API guard.
const ORIGIN_OK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/i;
function originAllowed(origin) {
  if (!origin) return true;                       // no Origin (navigation / same-origin) → allow
  if (origin === "null") return false;            // file:// / sandboxed pages are not trusted callers
  if (EXTENSION_ORIGIN.test(origin)) return true; // unpacked extension IDs are installation-specific
  return ORIGIN_OK.test(origin);
}

function jsonBodyVerify(req, res, buffer) {
  let cap = GLOBAL_JSON_BODY_CAP;
  if (req.path === "/api/captures" || req.path === "/api/captures/ack") cap = CAPTURE_BODY_CAP;
  else if (req.path === "/api/auto-import") cap = AUTOIMPORT_BODY_CAP;
  else if (req.path === "/api/duplicates/not-duplicate") cap = NOT_DUPLICATE_BODY_CAP;
  if (buffer.length > cap) {
    const error = new Error("request body too large");
    error.status = 413;
    error.type = "entity.too.large";
    throw error;
  }
}

// Host-header allowlist — closes the DNS-rebinding hole (review 2026-07-02 §3):
// with no Host check, an attacker page on evil.com whose DNS is rebound to
// 127.0.0.1 is fetched SAME-ORIGIN (so no Origin header is sent, sailing past
// the Origin guard) and could read the whole library. The defense is to pin the
// Host header to a loopback HOSTNAME.
//
// DELIBERATE DEVIATION from the plan's "any port in 3456-3465" wording: we match
// on the hostNAME only and IGNORE the port. Rationale — (1) what defeats DNS
// rebinding is the hostname: an attacker's rebound domain sends `Host: evil.com`
// regardless of which port it targets, so the port range adds no security; (2) a
// port allowlist would BREAK every test harness, which binds ephemeral ports
// (listen(0, …)) far outside 3456-3465 and sends `Host: 127.0.0.1:<ephemeral>`.
// So: accept host 127.0.0.1 / localhost / ::1 on ANY port; reject everything else.
// [::1]:port is bracketed, so strip the bracket form carefully before comparing.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader) return null;
  let h = hostHeader.trim().toLowerCase();
  if (h[0] === "[") {                 // IPv6 literal: [::1] or [::1]:port
    const close = h.indexOf("]");
    if (close === -1) return null;
    // Strict tail (reviewer minor #3): a bracketed Host is `[ipv6]` optionally
    // followed by `:port` and NOTHING else. Trailing junk like `[::1]junk` is
    // malformed and rejected rather than tolerated.
    const rest = h.slice(close + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return null;
    return h.slice(1, close);         // inside the brackets, port dropped
  }
  const colon = h.indexOf(":");       // hostname:port (single colon → IPv4/name)
  if (colon !== -1) h = h.slice(0, colon);
  return h;
}
// Loopback remote address (used only when the Host header is ABSENT — a raw
// same-machine client). Covers IPv4, IPv6, and IPv4-mapped-IPv6 loopback.
const LOOPBACK_REMOTE = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function hostAllowed(req) {
  const host = req.headers.host;
  if (host == null || host === "") {
    // No Host header: allow ONLY if the socket peer is loopback.
    const ra = req.socket && req.socket.remoteAddress;
    return LOOPBACK_REMOTE.has(ra);
  }
  const name = hostnameOf(host);
  return name != null && LOOPBACK_HOSTS.has(name);
}

// Content-Security-Policy for the served UI. The single-file web app relies on
// inline <script>/<style>, so 'unsafe-inline' is required for script-src and
// style-src — without it the app will not load. img-src allows data: URLs
// (legacy inline thumbnails) and https: (remote thumbnails); connect-src allows
// the loopback API ('self') and https: fetches the app makes.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https:"
].join("; ");

function createServer(ctx) {
  const app = express();

  // Host allowlist FIRST (before the Origin guard) — DNS-rebinding defense.
  // Both this and the Origin guard run; a rebound attacker host is rejected here.
  app.use((req, res, next) => {
    if (!hostAllowed(req)) {
      return res.status(403).json({ ok: false, error: "forbidden host" });
    }
    next();
  });

  // Block cross-origin web pages from reaching the local API (before any route).
  app.use((req, res, next) => {
    if (!originAllowed(req.headers.origin)) {
      return res.status(403).json({ ok: false, error: "forbidden origin" });
    }
    next();
  });

  // DORMANT pairing-token gate. lanEnabled is read straight off the persisted
  // config (plain loadConfig().lanEnabled — not getSyncConfig, which is scoped to
  // Dropbox device identity and has no business owning a LAN-auth flag). Default
  // absent/false → next() untouched, so today every caller passes through and no
  // existing contract changes. When lanEnabled is true, a valid
  // `Authorization: Bearer <getPairingToken()>` is required, else 401.
  //
  // CONTRACT (do NOT half-flip this): the server bind address stays 127.0.0.1
  // UNCONDITIONALLY — startServer never reads lanEnabled. Actually serving the LAN
  // requires deliberate future work (change the bind, a TLS decision, and a
  // pairing UX). Flipping lanEnabled alone only arms this token check; it does not
  // expose the server off-loopback. A test asserts the bind stays loopback.
  function requireToken(ctx) {
    return function (req, res, next) {
      let cfg = {};
      try { cfg = config.loadConfig() || {}; } catch (e) {}
      const lanEnabled = !!cfg.lanEnabled;
      const extensionAuth = !!cfg.extensionPairingRequired && EXTENSION_ORIGIN.test(req.headers.origin || "");
      if (!lanEnabled && !extensionAuth) return next();
      if (extensionAuth && req.path === "/api/ping") return next();
      if (req.path === "/api/pair-status") return next();   // capability probe is exempt
      if (req.path === "/api/pairing-token" || req.path === "/api/pairing-config") return next();
      const auth = req.headers.authorization || "";
      const token = getPairingToken();
      // Constant-time compare (reviewer minor): a plain === short-circuits at the
      // first differing byte, leaking token prefixes via response timing. Check
      // lengths first — crypto.timingSafeEqual throws on unequal-length Buffers.
      if (token && auth.indexOf("Bearer ") === 0) {
        const presented = Buffer.from(auth.slice("Bearer ".length), "utf8");
        const expected = Buffer.from(token, "utf8");
        if (presented.length === expected.length &&
            require("crypto").timingSafeEqual(presented, expected)) return next();
      }
      return res.status(401).json({ ok: false, error: "unauthorized" });
    };
  }
  const { getPairingToken } = config;
  app.use(requireToken(ctx));

  // Capability probe for a future phone client: reports whether LAN mode is armed.
  // Exempt from the token requirement (it's how a client discovers it needs one).
  app.get("/api/pair-status", (req, res) => {
    let lan = false;
    try { lan = !!config.loadConfig().lanEnabled; } catch (e) { lan = false; }
    res.json({ ok: true, lan });
  });

  // Apply the CSP to every response (covers the served HTML and its assets).
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    next();
  });

  // The verifier applies tighter caps to specific high-volume or metadata-only
  // routes before JSON is accepted. The larger general cap preserves the
  // existing bulk-card contract without allowing an unbounded parser.
  app.use(express.json({ limit: GLOBAL_JSON_BODY_CAP, verify: jsonBodyVerify }));

  // Pairing is configured from the trusted loopback UI. Never disclose the
  // token to an extension origin or a non-loopback web page; the extension
  // receives it by an explicit copy/paste into its options page.
  app.get("/api/pairing-token", (req, res) => {
    const origin = req.headers.origin || "";
    if (origin && !ORIGIN_OK.test(origin)) return res.status(403).json({ ok: false, error: "loopback origin required" });
    const cfg = config.loadConfig() || {};
    res.json({ ok: true, token: config.ensurePairingToken(), required: !!cfg.extensionPairingRequired });
  });
  app.post("/api/pairing-config", (req, res) => {
    const origin = req.headers.origin || "";
    if (origin && !ORIGIN_OK.test(origin)) return res.status(403).json({ ok: false, error: "loopback origin required" });
    config.setPairingRequired(!!(req.body && req.body.required));
    const cfg = config.loadConfig() || {};
    res.json({ ok: true, required: !!cfg.extensionPairingRequired });
  });

  // NOTE: do NOT destructure ctx.db/ctx.storeDir into locals here — backup's
  // swapInStagedRestore() and moveStore() close and rebind ctx.db (and repoint ctx.storeDir) at
  // runtime, so every route/helper below must read ctx.db / ctx.storeDir fresh at
  // request time, not a value captured once at server-creation time.

  // Discovery endpoint — the extension probes [3456..3465] for this.
  app.get("/api/ping", (req, res) => {
    res.json({ app: "interests", version: VERSION });
  });

  // --- KV ---
  app.get("/api/kv/:key", (req, res) => {
    res.json({ value: dbm.getKV(ctx.db, req.params.key) });
  });
  app.put("/api/kv/:key", (req, res) => {
    dbm.setKV(ctx.db, req.params.key, String(req.body && req.body.value != null ? req.body.value : ""));
    res.json({ ok: true });
  });

  // --- Cards ---
  app.get("/api/cards", (req, res) => {
    res.json({ cards: dbm.allCards(ctx.db) });
  });
  app.put("/api/cards", (req, res) => {
    const cards = (req.body && req.body.cards) || [];
    const asOf = req.body && req.body.asOf;
    // A5: block a stale full-array PUT that would wipe most of the library unless the
    // client explicitly confirms. Read counts BEFORE mutating; no write on the 409 path.
    const existing = dbm.counts(ctx.db).cards;
    if (existing >= 20 && cards.length < existing / 2 && !(req.body && req.body.confirm)) {
      return res.status(409).json({ ok: false, error: "mass_delete_blocked", existing, incoming: cards.length });
    }
    ctx.syncDirty = true;
    const r = dbm.replaceCards(ctx.db, cards, { asOf });
    // `preserved` = rows kept via the asOf staleness branch (merged concurrently,
    // absent from this PUT). The client must fold these back into its in-memory
    // array before its next persist or it will delete them (data-safety HIGH).
    res.json({ ok: true, count: cards.length, preserved: (r && r.preserved) || [] });
  });
  app.patch("/api/cards/:id", (req, res) => {
    ctx.syncDirty = true;
    const card = (req.body && req.body.card) || {};
    card.id = req.params.id;
    dbm.upsertCard(ctx.db, card);
    res.json({ ok: true });
  });
  app.delete("/api/cards/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.deleteCard(ctx.db, req.params.id);
    res.json({ ok: true });
  });

  // Additive duplicate-review decision. This deliberately updates only the
  // marker on the server's CURRENT row instead of round-tripping the renderer's
  // whole library (or a potentially stale copy of the card).
  //
  // `key` is an opaque per-relationship tag (web/pwa index.html's
  // dupePeerTagsFor: "p:<scope>:<id>" of the OTHER card in a dismissed pair) --
  // stable (scope,id) identity only, never url/title. There is deliberately no
  // compare-and-swap against the row's current content here anymore: an
  // earlier version embedded the whole group's [scope,id,url,title] tuples in
  // the key and rejected a write if the row's current title/url didn't match
  // that snapshot (400 invalid_key / 409 row_changed). That existed only to
  // protect a key that was itself a function of mutable content -- once the
  // key carries no content, "the row changed" can no longer mean "the decision
  // is stale": marking A and B not-duplicates-of-each-other is an idempotent,
  // append-only assertion about two stable ids, true regardless of what either
  // card's title says now or later. See tests/service-data.test.js.
  app.post("/api/duplicates/not-duplicate", (req, res) => {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > 400) {
      return res.status(400).json({ ok: false, error: "invalid_entries" });
    }
    const parsed = [];
    for (const raw of entries) {
      const scope = raw && raw.scope, id = raw && String(raw.id || ""), key = raw && raw.key;
      if ((scope !== "imported" && scope !== "saved") || !id || id.length > 512 || typeof key !== "string" || !key || key.length > 600) {
        return res.status(400).json({ ok: false, error: "invalid_entry" });
      }
      parsed.push({ scope, id, key });
    }
    let changed = 0;
    ctx.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of parsed) {
        if (dbm.addNotDuplicateMarker(ctx.db, entry.scope, entry.id, entry.key)) changed++;
      }
      ctx.db.exec("COMMIT");
    } catch (e) {
      try { ctx.db.exec("ROLLBACK"); } catch (_) {}
      throw e;
    }
    if (changed) ctx.syncDirty = true;
    res.json({ ok: true, changed });
  });

  // --- Saved ---
  app.get("/api/saved", (req, res) => {
    res.json({ saved: dbm.allSaved(ctx.db) });
  });
  app.put("/api/saved", (req, res) => {
    const saved = (req.body && req.body.saved) || [];
    const asOf = req.body && req.body.asOf;
    const existing = dbm.counts(ctx.db).saved;
    if (existing >= 20 && saved.length < existing / 2 && !(req.body && req.body.confirm)) {
      return res.status(409).json({ ok: false, error: "mass_delete_blocked", existing, incoming: saved.length });
    }
    ctx.syncDirty = true;
    const r = dbm.replaceSaved(ctx.db, saved, { asOf });
    res.json({ ok: true, count: saved.length, preserved: (r && r.preserved) || [] });
  });
  app.patch("/api/saved/:id", (req, res) => {
    ctx.syncDirty = true;
    const item = (req.body && req.body.item) || {};
    item.id = req.params.id;
    dbm.upsertSaved(ctx.db, item);
    res.json({ ok: true });
  });
  app.delete("/api/saved/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.deleteSaved(ctx.db, req.params.id);
    res.json({ ok: true });
  });

  // --- Delta reads (phone-sync prep: poll instead of full-array GET) ---
  // Read-only: no ctx.syncDirty. `now` is captured BEFORE the queries run so a
  // concurrent write during the request window is still delivered on the NEXT
  // poll (at-least-once, never-miss) — see the boundary-operator comment on
  // cardsSince/savedSince/tombstonesSince in core/db.js for the full proof.
  app.get("/api/changes", (req, res) => {
    const since = req.query.since;
    const now = Date.now();
    const cards = dbm.cardsSince(ctx.db, since);
    const saved = dbm.savedSince(ctx.db, since);
    const tombstones = dbm.tombstonesSince(ctx.db, since);
    res.json({ ok: true, now, cards, saved, tombstones });
  });
  app.get("/api/tombstones", (req, res) => {
    const since = req.query.since;
    const now = Date.now();
    const tombstones = dbm.tombstonesSince(ctx.db, since);
    res.json({ ok: true, now, tombstones });
  });

  // --- Images ---
  // An invalid id (path-traversal attempt — see core/images.safeImgId) throws
  // INVALID_IMG_ID; map that to 400. A well-formed but absent image is 404.
  function isInvalidImgId(e) { return e && e.code === "INVALID_IMG_ID"; }

  // Manifest for a future phone client to diff which images it's missing
  // (review G gap 4 — listImageIds existed but was never exposed over HTTP).
  // Read-only: no ctx.syncDirty.
  app.get("/api/images", (req, res) => {
    res.json({ ok: true, images: images.imageManifest(ctx.storeDir) });
  });

  app.get("/api/img/:id", (req, res) => {
    let buf;
    try { buf = images.getImg(ctx.storeDir, req.params.id); }
    catch (e) { if (isInvalidImgId(e)) return res.status(400).json({ ok: false, error: "invalid image id" }); throw e; }
    if (!buf) { res.status(404).end(); return; }
    // Serve the SNIFFED content type rather than a hardcoded image/jpeg — some
    // stored images are PNG bytes under a .jpg filename (review G gap 4).
    // Backward-compatible: browsers already sniff image bytes regardless of
    // the declared Content-Type, so the renderer/extension are unaffected;
    // this only makes the contract honest for a future native client.
    res.type(images.sniffImageType(buf)).send(buf);
  });

  // Fetch a card's REMOTE image server-side, so the browser's CORS rules don't
  // block the AI title pipeline (Pinterest and friends serve images that render
  // in an <img> but refuse a fetch()). Takes a CARD ID, never a URL: a caller
  // cannot name a destination, only ask for a re-fetch of something already in
  // the library. See core/cardimage.js for the guard composition.
  app.post("/api/fetch-card-image", async (req, res) => {
    const id = req.body && req.body.id;
    if (!id || typeof id !== "string") return res.status(400).json({ ok: false, error: "id required" });
    let out;
    try { out = await cardimage.fetchCardImage(ctx.db, id); }
    catch (e) { console.error("fetch-card-image failed:", e); out = { ok: false, reason: "fetch-failed" }; }
    // ONE message for every failure reason. Distinguishable errors (or timings)
    // would turn this into a network scanner for whatever the service can reach.
    if (!out.ok) return res.status(404).json({ ok: false, error: "image unavailable" });
    // out.contentType is sniffed from the bytes by cardimage.js, never taken from the
    // upstream header — so it is one of a fixed set of literals we chose, not a string a
    // third-party server picked.
    res.set("Content-Type", out.contentType);
    res.set("Cache-Control", "no-store");
    // Belt-and-suspenders even though the type is now byte-sniffed (core/cardimage.js):
    // nosniff stops the browser from re-sniffing these bytes into something active
    // regardless of the declared type, and the sandboxed inert CSP makes the response
    // harmless even if it is ever navigated to directly.
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Security-Policy", "default-src 'none'; sandbox");
    res.send(out.buffer);
  });

  app.put("/api/img/:id", (req, res) => {
    ctx.syncDirty = true;
    try {
      const file = images.putImg(ctx.storeDir, req.params.id, String(req.body && req.body.data || ""));
      res.json({ ok: true, file });
    } catch (e) {
      if (isInvalidImgId(e)) return res.status(400).json({ ok: false, error: "invalid image id" });
      if (e && e.code === "EMPTY_IMAGE") return res.status(400).json({ ok: false, error: "empty image data" });
      throw e;
    }
  });
  app.post("/api/img/:id/copy", (req, res) => {
    try {
      const sourceId = req.body && req.body.sourceId;
      images.safeImgId(req.params.id);
      images.safeImgId(sourceId);
      if (!images.copyImg(ctx.storeDir, sourceId, req.params.id)) return res.status(404).json({ ok: false, error: "source_not_found" });
      res.json({ ok: true });
    } catch (e) {
      if (e && e.code === "INVALID_IMG_ID") return res.status(400).json({ ok: false, error: "invalid_id" });
      throw e;
    }
  });
  app.delete("/api/img/:id", (req, res) => {
    ctx.syncDirty = true;
    try {
      images.delImg(ctx.storeDir, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      if (isInvalidImgId(e)) return res.status(400).json({ ok: false, error: "invalid image id" });
      throw e;
    }
  });

  // --- Fingerprints ---
  app.get("/api/fp", (req, res) => {
    res.json({ fp: dbm.allFp(ctx.db) });
  });
  app.put("/api/fp/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.setFp(ctx.db, req.params.id, String(req.body && req.body.value != null ? req.body.value : ""));
    res.json({ ok: true });
  });
  app.delete("/api/fp/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.delFp(ctx.db, req.params.id);
    res.json({ ok: true });
  });

  // --- Capture queue (persisted in kv key ia_capture_queue) ---
  // GET claims a leased batch; it does not delete anything. The renderer ACKs
  // only after the resulting card write succeeds. An interrupted drain is
  // therefore retried after the lease expires instead of being lost.
  app.post("/api/captures", (req, res) => {
    const capture = req.body && req.body.capture;
    if (!capture || typeof capture !== "object") {
      return res.status(400).json({ ok: false, error: "missing capture" });
    }
    if (!captureQueue.validCapture(capture)) {
      return res.status(400).json({ ok: false, error: "invalid capture" });
    }
    try {
      captureQueue.enqueue(ctx.db, capture);
      ctx.syncDirty = true;
      res.json({ ok: true });
    } catch (e) {
      console.error("capture enqueue failed:", e);
      if (e && (e.code === "CAPTURE_INVALID" || e.code === "CAPTURE_QUEUE_LIMIT")) {
        return res.status(413).json({ ok: false, error: "capture queue limit" });
      }
      res.status(500).json({ ok: false, error: "capture enqueue failed" });
    }
  });

  app.get("/api/captures", (req, res) => {
    try {
      const captures = captureQueue.claim(ctx.db);
      if (captures.length) ctx.syncDirty = true;
      res.json({ captures });
    } catch (e) {
      console.error("capture claim failed:", e);
      res.status(500).json({ captures: [], error: "capture claim failed" });
    }
  });

  app.post("/api/captures/ack", (req, res) => {
    if (!req.body || !Array.isArray(req.body.acks)) {
      return res.status(400).json({ ok: false, error: "acks array required" });
    }
    const acks = req.body.acks;
    if (acks.length > 500 || acks.some(function (ack) {
      return !ack || typeof ack.id !== "string" || ack.id.length > 128
        || typeof ack.lease !== "string" || ack.lease.length > 128;
    })) {
      return res.status(400).json({ ok: false, error: "invalid acknowledgements" });
    }
    try {
      const acked = captureQueue.ack(ctx.db, acks);
      if (acked) ctx.syncDirty = true;
      res.json({ ok: true, acked });
    } catch (e) {
      console.error("capture ack failed:", e);
      res.status(500).json({ ok: false, error: "capture ack failed" });
    }
  });

  // --- Single capture request / batch driver state / batch progress ---
  // These three routes are byte-identical GET/POST kv pairs that differ only in
  // the URL segment, the kv storage key, and the request/response body field
  // name (request / state / progress). GET reads+JSON-parses the stored value
  // (null if absent/corrupt); POST stores JSON.stringify(value), or clears the
  // key to "" when value is null/undefined (mirrors the original per-route bodies).
  function readJsonKV(key) {
    const raw = dbm.getKV(ctx.db, key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function jsonKvEndpoints(app, route, kvKey, field) {
    app.get(route, (req, res) => {
      res.json({ [field]: readJsonKV(kvKey) });
    });
    app.post(route, (req, res) => {
      const value = req.body && req.body[field];
      if (value == null) dbm.setKV(ctx.db, kvKey, "");
      else dbm.setKV(ctx.db, kvKey, JSON.stringify(value));
      res.json({ ok: true });
    });
  }
  jsonKvEndpoints(app, "/api/capture-request", "ia_capture_request", "request");
  jsonKvEndpoints(app, "/api/batch-state", "ia_batch_state", "state");
  jsonKvEndpoints(app, "/api/batch-progress", "ia_batch_progress", "progress");

  // --- Platform auto-import (FB/IG saved-page daily scheduler; core/autoimport.js) ---
  // POST /api/auto-import — extension->core delivery (auth'd by the same
  // requireToken gate as everything else in this file; see app.use above).
  // jsonBodyVerify applies the 1MB cap before this handler runs.
  app.post("/api/auto-import", (req, res) => {
    let actualLen = 0;
    try { actualLen = Buffer.byteLength(JSON.stringify(req.body || {}), "utf8"); } catch (e) { actualLen = 0; }
    if (actualLen > AUTOIMPORT_BODY_CAP) {
      return res.status(413).json({ ok: false, error: "body too large" });
    }
    const result = autoimport.processBatch(ctx, req.body);
    if (result && result.status === "invalid") {
      return res.status(400).json({ ok: false, error: "invalid batch" });
    }
    ctx.syncDirty = true;   // survivors land in the same ia_capture_queue /api/captures feeds
    res.json(Object.assign({ ok: true }, result));
  });
  // GET /api/auto-import/config — extension polls before/around each scrape.
  app.get("/api/auto-import/config", (req, res) => {
    res.json(autoimport.getConfig(ctx));
  });
  // Request mailbox: renderer's "Check now" POSTs a truthy request; extension
  // polls GET then claims it with POST {request:null} — mirrors /api/capture-request.
  jsonKvEndpoints(app, "/api/auto-import/request", "ia_autoimport_request", "request");
  // GET /api/auto-import/status — renderer's Settings section reads both platforms' last-run records.
  app.get("/api/auto-import/status", (req, res) => {
    res.json(autoimport.getStatus(ctx));
  });

  // --- Browser Stumble (StumbleUpon-style discovery in the browser) ---------
  // Loopback mailboxes bridging the extension and the renderer. The extension
  // never writes app data directly: it POSTs a request / drains results /
  // POSTs feedback here, and the renderer (the only place the AI runs and app
  // state is written) drains them on a timer. No outbound network here.
  function readJsonArr(key) { const v = readJsonKV(key); return Array.isArray(v) ? v : []; }

  // Categories for the extension's interest picker (renderer publishes CATS at boot).
  app.get("/api/categories", (req, res) => {
    res.json({ categories: readJsonArr("ia_bstumble_cats") });
  });

  // Request mailbox: extension asks for pages in {interests, nonce}; renderer drains.
  jsonKvEndpoints(app, "/api/bstumble/request", "ia_bstumble_request", "request");

  // Results queue: renderer appends verified pages; extension GET returns + clears.
  app.post("/api/bstumble/results", (req, res) => {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: "items array required" });
    let q = readJsonArr("ia_bstumble_results").concat(items);
    if (q.length > 20) q = q.slice(-20);
    dbm.setKV(ctx.db, "ia_bstumble_results", JSON.stringify(q));
    res.json({ ok: true, count: q.length });
  });
  app.get("/api/bstumble/results", (req, res) => {
    const q = readJsonArr("ia_bstumble_results");
    if (q.length) dbm.setKV(ctx.db, "ia_bstumble_results", JSON.stringify([]));
    res.json({ results: q });
  });

  // Feedback queue: extension appends 👍/👎 votes; renderer GET returns + clears.
  app.post("/api/bstumble/feedback", (req, res) => {
    const vote = req.body && req.body.vote;
    if (!vote || typeof vote !== "object") return res.status(400).json({ ok: false, error: "missing vote" });
    let q = readJsonArr("ia_bstumble_feedback").concat([vote]);
    if (q.length > 50) q = q.slice(-50);
    dbm.setKV(ctx.db, "ia_bstumble_feedback", JSON.stringify(q));
    res.json({ ok: true, count: q.length });
  });
  app.get("/api/bstumble/feedback", (req, res) => {
    const q = readJsonArr("ia_bstumble_feedback");
    if (q.length) dbm.setKV(ctx.db, "ia_bstumble_feedback", JSON.stringify([]));
    res.json({ feedback: q });
  });

  // One-time legacy backup import. READ-ONLY on srcDir.
  app.post("/api/import", async (req, res) => {
    let srcDir = req.body && req.body.srcDir;
    if (!srcDir || typeof srcDir !== "string" || !path.isAbsolute(srcDir)) {
      return res.status(400).json({ error: "absolute srcDir required" });
    }
    srcDir = path.resolve(srcDir);
    // Reject an obviously invalid source before creating a safety snapshot;
    // the live store is untouched and callers keep the existing 400 contract.
    if (!fs.existsSync(path.join(srcDir, "data.json"))) {
      return res.status(400).json({ error: "import failed" });
    }
    try {
      // Legacy import replaces the live library. It is allowed to proceed only
      // after a fresh backup has been written and independently verified.
      // safety:true — a pre-destructive-op snapshot must capture whatever state
      // the store is in right now. Gating it on the store-sanity check would
      // refuse exactly the degraded store a user is most likely trying to
      // recover FROM by re-importing, and would do so with no override.
      let safety;
      try {
        const runner = (ctx.storeWorker && ctx.storeWorker.runBackup) ? ctx.storeWorker : { runBackup: (storeDir, opts) => Promise.resolve(backup.runBackup(ctx.db, storeDir, opts)) };
        safety = await runner.runBackup(ctx.storeDir, { safety: true });
      }
      catch (e) { e.code = "SAFETY_BACKUP_FAILED"; throw e; }
      if (!safety || !backup.verifyBackup(safety.name, safety.counts)) {
        return res.status(409).json({ error: "safety backup not verified" });
      }
      const out = importLegacyBackup(srcDir, ctx);
      ctx.syncDirty = true;
      res.json(out);
    } catch (e) {
      console.error("import failed:", e);
      if (e && e.code === "SAFETY_BACKUP_FAILED") return res.status(409).json({ error: "safety backup failed" });
      res.status(400).json({ error: "import failed" });
    }
  });

  // ---- backup / restore / health ----
  app.post("/api/backup", async (req, res) => {
    try {
      const safety = !!(req.body && req.body.safety);
      let keep = Number(req.body && req.body.keep);
      if (!Number.isFinite(keep) || keep < 1) keep = 3;
      keep = Math.min(Math.floor(keep), 30);
      const runner = (ctx.storeWorker && ctx.storeWorker.runBackup) ? ctx.storeWorker : { runBackup: (storeDir, opts) => Promise.resolve((function () {
        const out = backup.runBackup(ctx.db, storeDir, { safety: opts.safety });
        const verified = backup.verifyBackup(out.name, out.counts);
        if (verified && !opts.safety && opts.keep) backup.rotate(opts.keep);
        return { ok: true, verified, name: out.name, counts: out.counts };
      })()) };
      const out = await runner.runBackup(ctx.storeDir, { safety, keep });
      if (out && out.ok === false) {
        // The façade NEVER rejects (core/storeworker.js) — a worker-side
        // failure (e.g. the store-sanity refusal) resolves {ok:false, error}
        // instead of throwing, so it must be classified here exactly like the
        // direct path's catch below does. Without this, a genuine backup
        // failure silently returned HTTP 200 with {ok:false} and the one
        // backup failure a user can act on (see comment below) never reached
        // the client as the 409 it always used to be.
        console.error("backup failed:", out.error);
        const msg = out.error || "";
        if (/images dir is missing|expects \d+ images but only/.test(msg)) {
          return res.status(409).json({ ok: false, error: msg });
        }
        return res.status(500).json({ ok: false, error: "backup failed" });
      }
      res.json(out);
    } catch (e) {
      console.error("backup failed:", e);
      // The store-sanity refusal is the one backup failure a user can act on
      // (their images folder is incomplete — usually an undownloaded Dropbox
      // placeholder), so it reaches the client verbatim instead of as a generic
      // "backup failed". It clears itself once the images are back; there is
      // nothing to override and nothing to reset.
      const msg = (e && e.message) || "";
      if (/images dir is missing|expects \d+ images but only/.test(msg)) {
        return res.status(409).json({ ok: false, error: msg });
      }
      res.status(500).json({ ok: false, error: "backup failed" });
    }
  });

  app.get("/api/backups", (req, res) => {
    res.json({ backups: backup.listBackups() });
  });

  // A backup name must be a dated backup (interests-backup-YYYY-MM-DD) OR an
  // existing entry from listBackups() — never an arbitrary path. This blocks a
  // traversal name like '../../evil' from reaching backup.restore.
  const DATED_BACKUP = /^interests-backup-\d{4}-\d{2}-\d{2}$/;
  function isAllowedBackupName(name) {
    if (typeof name !== "string" || !name) return false;
    if (DATED_BACKUP.test(name)) return true;
    return backup.listBackups().some((b) => b.name === name);
  }

  // Two steps, deliberately split across threads. Staging (verify the backup,
  // safety-snapshot the live store, copy the incoming content aside) is the
  // slow part and touches no db handle, so it goes to the store worker. The
  // swap (close db, rename staged content into place, reopen) ALWAYS runs here
  // on the real ctx regardless of whether staging went through the worker: it
  // is cheap (renames, not copies) and it needs the actual live ctx.db /
  // ctx.reopen, which no worker call can provide.
  app.post("/api/restore", async (req, res) => {
    const name = req.body && req.body.name;
    if (!isAllowedBackupName(name)) {
      return res.status(400).json({ ok: false, error: "invalid backup name" });
    }
    try {
      // Flush the WAL into interests.db FIRST. stageRestore has no db handle by
      // design (that is what lets it run off-thread), so its pre-restore safety
      // snapshot copies the interests.db file as-is — and in WAL mode the most
      // recent committed writes are still in the -wal sidecar. Without this the
      // snapshot that exists to make a mistaken restore recoverable would
      // silently omit them. Same PRAGMA moveStore already uses before its copy.
      // A BUSY checkpoint does NOT throw — it returns {busy:1, checkpointed:0}
      // and leaves the frames in the sidecar, so exec()+catch would silently
      // hand stageRestore the same lagging file it is supposed to prevent.
      try {
        const cp = ctx.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        if (cp && cp.busy) console.error("restore: WAL checkpoint reported busy — the pre-restore safety snapshot may lag the live store", cp);
      } catch (e) { console.error("restore: WAL checkpoint failed:", (e && e.message) || e); }
      const usingWorker = !!(ctx.storeWorker && ctx.storeWorker.restore);
      const staged = usingWorker ? await ctx.storeWorker.restore(ctx.storeDir, name) : backup.stageRestore(name, ctx.storeDir);
      if (!staged.ok) return res.json(staged);
      const out = backup.swapInStagedRestore(staged.stageFolder, ctx);   // rebinds ctx.db
      res.json(out);
    } catch (e) {
      console.error("restore failed:", e);
      res.status(500).json({ ok: false, error: "restore failed" });
    }
  });

  app.get("/api/health", (req, res) => {
    const c = counts(ctx.db);
    const list = backup.listBackups();
    // list[0] can now be the rolling mirror (sorted by wall-clock time, so it
    // is routinely newer than the freshest dated snapshot). "Last backup"
    // should mean a real point-in-time recovery point, not a folder that gets
    // rewritten in place every few minutes — report the newest non-mirror
    // entry, with the mirror's own freshness reported alongside it.
    const lastDated = list.find(function (b) { return !b.mirror; }) || null;
    const mirrorEntry = list.find(function (b) { return b.mirror; }) || null;
    const lastBackup = lastDated ? { name: lastDated.name, counts: lastDated.counts } : null;
    const lastMirrorAt = mirrorEntry ? mirrorEntry.sortTs : null;
    // Store-safety flags (2026-07-17 incident hardening): a store dir under
    // %TEMP% (poisoned config pointer from a killed test run) or counts
    // collapsed vs the last-backup record persisted in config.json. Flags
    // only — main.js surfaces a boot dialog; nothing is auto-"healed".
    let safety = null;
    try {
      safety = config.evaluateStoreSafety({
        storeDir: ctx.storeDir,
        counts: { cards: c.cards | 0, saved: c.saved | 0 },
        lastCounts: config.getLastCounts(),
      });
    } catch (e) { safety = null; }
    res.json({
      storePath: ctx.storeDir,
      counts: { cards: c.cards | 0, saved: c.saved | 0, images: imageCount(ctx.storeDir) | 0 },
      lastBackup,
      lastMirrorAt,
      safety
    });
  });

  // ---- data location ----
  app.get("/api/store-location", (req, res) => {
    const c = counts(ctx.db);
    res.json({
      path: ctx.storeDir,
      counts: { cards: c.cards | 0, saved: c.saved | 0, images: imageCount(ctx.storeDir) | 0 }
    });
  });

  app.post("/api/store-location/move", async (req, res) => {
    let target = req.body && req.body.target;
    if (!target || typeof target !== "string" || !path.isAbsolute(target)) {
      return res.status(400).json({ ok: false, path: ctx.storeDir, error: "absolute target required" });
    }
    target = path.resolve(target);
    try {
      const usingWorker = !!(ctx.storeWorker && ctx.storeWorker.moveStore);
      const runner = usingWorker ? ctx.storeWorker : { moveStore: (storeDir, t) => Promise.resolve(backup.moveStore(t, ctx)) };
      const out = await runner.moveStore(ctx.storeDir, target);
      // The worker path's own internal ctx is a throwaway (closed inside the
      // worker thread) and never repoints anything — only the main thread's
      // real ctx can be safely repointed, so that happens here, once the
      // worker confirms success. The no-worker fallback calls
      // backup.moveStore(t, ctx) against the REAL ctx directly (exactly as
      // today) and already repoints it internally — guard against
      // double-repointing that path.
      if (usingWorker && out.ok) {
        ctx.setStorePath(target); ctx.storeDir = target; ctx.db = ctx.reopen();
        // The storeWorker object is the SAME one startSyncTimers holds (main.js
        // hands ctx.storeWorker and the timer's `sync` the identical reference)
        // and its runSync/publishSnapshot read an internal currentStoreDir, not
        // ctx.storeDir — without this repoint the next periodic sync tick would
        // silently keep targeting the OLD, abandoned store directory.
        if (ctx.storeWorker && ctx.storeWorker.setStoreDir) ctx.storeWorker.setStoreDir(target);
      }
      res.json({ ok: out.ok, path: ctx.storeDir });
    } catch (e) {
      console.error("store move failed:", e);
      res.status(500).json({ ok: false, path: ctx.storeDir, error: "move failed" });
    }
  });

  // ---- Dropbox sync ----
  app.get("/api/sync-status", (req, res) => {
    const sc = config.getSyncConfig();
    let defaultDir = null, dropboxFound = false;
    try { defaultDir = sync.defaultSyncDir(); dropboxFound = !!defaultDir; } catch (e) {}
    const syncDir = sc.dir || defaultDir;
    let peers = [];
    try { if (syncDir) peers = sync.readPeerSnapshots(syncDir, sc.deviceId).peers.map(function (p) { return { deviceLabel: p.deviceLabel, deviceId: p.deviceId, publishedAt: p.publishedAt }; }); } catch (e) {}
    let changedAt = 0; try { changedAt = +(dbm.getKV(ctx.db, "ia_sync_changed_at") || 0); } catch (e) {}
    // Sticky record of a pre-merge backup refusal. The timer path has no user
    // in the loop, so without this a merge that stops happening is invisible.
    let backupError = null;
    try {
      const raw = dbm.getKV(ctx.db, "ia_sync_backup_error");
      if (raw) backupError = JSON.parse(raw);
    } catch (e) { backupError = null; }
    res.json({
      enabled: sc.enabled, folder: syncDir, dropboxFound: dropboxFound,
      deviceId: sc.deviceId, deviceLabel: sc.deviceLabel,
      peers: peers, changedAt: changedAt, backupError: backupError,
      // Advisory UI-only flag: true while a merge cycle (timer or /api/sync/now)
      // is in flight, so the renderer's header indicator can spin during a
      // BACKGROUND sync the UI didn't itself trigger. In-memory, not persisted.
      running: !!ctx.syncRunning,
    });
  });

  app.post("/api/sync/enable", (req, res) => {
    config.setSyncConfig({ enabled: !!(req.body && req.body.enabled) });
    res.json({ ok: true });
  });

  app.post("/api/sync/folder", (req, res) => {
    let folder = req.body && req.body.folder;
    if (!folder || typeof folder !== "string" || !path.isAbsolute(folder)) {
      return res.status(400).json({ ok: false, error: "absolute folder required" });
    }
    folder = path.resolve(folder);
    config.setSyncConfig({ dir: folder });
    res.json({ ok: true, folder: folder });
  });

  app.post("/api/sync/device-label", (req, res) => {
    const label = req.body && req.body.label;
    if (!label || typeof label !== "string" || !label.trim()) return res.status(400).json({ ok: false, error: "label required" });
    config.setSyncConfig({ deviceLabel: label.trim().slice(0, 60) });
    res.json({ ok: true });
  });

  app.post("/api/sync/now", async (req, res) => {
    const sc = config.getSyncConfig();
    let defaultDir = null; try { defaultDir = sync.defaultSyncDir(); } catch (e) {}
    const syncDir = sc.dir || defaultDir;
    if (!sc.enabled || !syncDir) return res.status(400).json({ ok: false, error: "sync not enabled / no Dropbox" });
    ctx.syncRunning = true;   // advisory UI flag; cleared in finally so an error can't leave it stuck on
    try {
      // Prefer the worker-thread runner (ctx.storeWorker, set by main.js) so a
      // manual sync can't freeze the main process either; tests and headless
      // embedders without a runner keep the direct synchronous path.
      const runner = (ctx.storeWorker && ctx.storeWorker.runSync) ? ctx.storeWorker : sync;
      const r = await Promise.resolve(runner.runSync(ctx, { syncDir: syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true }));
      if (r && r.ok === false) { console.error("sync now failed:", r.error); return res.status(500).json({ ok: false, error: "sync failed" }); }
      if (r.changed) { try { dbm.setKV(ctx.db, "ia_sync_changed_at", String(Date.now())); } catch (e) { console.error("setKV ia_sync_changed_at failed:", e); } }
      res.json({ ok: true, changed: r.changed, conflicts: r.conflicts, backupError: r.backupError || null, peers: r.peers });
    } catch (e) { console.error("sync now failed:", e); res.status(500).json({ ok: false, error: "sync failed" }); }
    finally { ctx.syncRunning = false; }
  });

  // ---- browser bookmarks (read-only; reads ONLY the fixed Bookmarks file for a
  // validated, discovered Chrome/Edge profile — never a client-supplied path) ----
  app.get("/api/bookmark-sources", (req, res) => {
    try { res.json({ sources: bookmarks.listBrowserProfiles() }); }
    catch (e) { console.error("bookmark-sources failed:", e); res.status(500).json({ error: "failed" }); }
  });
  app.get("/api/bookmarks", (req, res) => {
    const browser = req.query.browser, profile = req.query.profile;
    try {
      res.json({ bookmarks: bookmarks.readProfileBookmarks(browser, profile) });
    } catch (e) {
      if (e && e.code === "BAD_PROFILE") return res.status(400).json({ error: "invalid browser/profile" });
      console.error("bookmarks read failed:", e);
      res.status(404).json({ error: "could not read bookmarks" });
    }
  });

  // ---- dead-link check (probes user card URLs server-side; conservative + SSRF-guarded;
  // social hosts skipped; never deletes — the renderer reviews results before removal) ----
  app.post("/api/check-links", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 8, 8));
      const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 8000, 20000));
      const results = await linkcheck.checkChunk(items, { concurrency: concurrency, timeoutMs: timeoutMs });
      res.json({ results: results });
    } catch (e) {
      console.error("check-links failed:", e);
      res.status(500).json({ error: "check failed" });
    }
  });

  // ---- content-aware "soft-dead" check (fetches the real page, runs free heuristics;
  // social/SSRF skipped; never deletes — renderer's AI tier confirms, then user reviews) ----
  app.post("/api/check-content", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 8000, 20000));
      const results = await contentcheck.checkContentChunk(items, { concurrency: 8, timeoutMs: timeoutMs });
      res.json({ results: results });
    } catch (e) {
      console.error("check-content failed:", e);
      res.status(500).json({ error: "check failed" });
    }
  });

  // ---- Electron-native "Capture missing": fetch each card's page server-side, extract its
  // preview image + title/description, store the image. Social/SSRF skipped. Read/writes images only.
  app.post("/api/capture-meta", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
      const found = await capturemeta.captureMetaChunk(items, {});
      const results = found.map((r) => {
        let hasImage = false;
        if (r && r.imageDataUrl) {
          try { images.putImg(ctx.storeDir, r.id, r.imageDataUrl); hasImage = true; }
          catch (e) { console.error("capture-meta putImg failed:", e && e.message); }
        }
        const imageUrl = (!hasImage && r && /^https?:\/\//i.test(r.imageUrl || "")) ? r.imageUrl : "";
        return { id: r && r.id, hasImage: hasImage, imageUrl: imageUrl, title: (r && r.title) || "", description: (r && r.description) || "", reason: (hasImage || imageUrl) ? "" : ((r && r.reason) || "unreachable") };
      });
      res.json({ results: results });
    } catch (e) {
      console.error("capture-meta failed:", e);
      res.status(500).json({ error: "capture failed" });
    }
  });

  // ---- link safety (Google Safe Browsing; server-side; key from config; read-only) ----
  app.post("/api/check-safety", async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      const key = config.getSafeBrowsingKey();
      if (!key) { res.json({ error: "no_key", results: [] }); return; }
      const urls = items.map((it) => (it && typeof it.url === "string") ? it.url : "").filter(Boolean);
      const found = await safebrowse.checkUrls(urls, key, {});
      const byUrl = {}; found.forEach((f) => { byUrl[f.url] = f.threat; });
      const results = items.map((it) => ({ id: it && it.id, threat: (it && byUrl[it.url]) || null }));
      res.json({ results: results });
    } catch (e) {
      console.error("check-safety failed:", e);
      res.status(500).json({ error: "check failed" });
    }
  });

  // ---- free interest-matched news for Stumble (Google News RSS via core/news; no key) ----
  app.get("/api/news", async (req, res) => {
    try {
      const raw = String(req.query.interests || "");
      const all = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const interests = all.slice(0, 8);
      if (all.length > 8) console.warn("news: capping " + all.length + " interests to 8");
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 40, 60));
      if (!interests.length) { res.json({ ok: true, now: Date.now(), items: [] }); return; }
      const items = await news.fetchNews(interests, { limit });
      res.json({ ok: true, now: Date.now(), items: items });
    } catch (e) {
      console.error("news failed:", e);
      res.status(500).json({ ok: false, error: "news failed" });
    }
  });

  app.get("/api/safebrowsing-key", (req, res) => {
    res.json({ hasKey: !!config.getSafeBrowsingKey() });
  });

  app.post("/api/safebrowsing-key", (req, res) => {
    const key = (req.body && typeof req.body.key === "string") ? req.body.key : "";
    config.setSafeBrowsingKey(key);
    res.json({ ok: true, hasKey: !!key });
  });

  app.get("/api/safebrowsing-verify", async (req, res) => {
    try {
      const key = config.getSafeBrowsingKey();
      if (!key) { res.json({ state: "none" }); return; }
      const v = await safebrowse.verifyKey(key, {});
      res.json({ state: v.status });
    } catch (e) {
      console.error("safebrowsing-verify failed:", e);
      res.json({ state: "error" });
    }
  });

  // Serve the existing web app.
  app.use(express.static(WEB_DIR));

  // 404 for unmatched API routes (static already returns 404 for missing files).
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // JSON error middleware — MUST be registered LAST. Catches anything that falls
  // through to Express's default handler (an uncaught throw in a route not already
  // wrapped in its own try/catch). Sanctioned behavior change: the response body
  // no longer leaks a stack trace — the real error is logged server-side only.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("unhandled route error:", err);
    if (res.headersSent) return next(err);
    // A body-parser payload-too-large (the per-route 1MB auto-import parser, or
    // any future capped parser) is a client error, not a server fault — surface
    // its own 413 rather than masking it as a 500. Everything else stays 500
    // with no stack leak.
    if (err && (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413)) {
      return res.status(413).json({ ok: false, error: "body too large" });
    }
    res.status(500).json({ ok: false, error: "internal" });
  });

  return app;
}

function startServer(ctx, preferredPort = PORT_MIN) {
  const appHandler = createServer(ctx);
  return new Promise((resolve, reject) => {
    function tryPort(port) {
      if (port > PORT_MAX) {
        reject(new Error("No free port in [" + PORT_MIN + ".." + PORT_MAX + "]"));
        return;
      }
      const server = http.createServer(appHandler);
      server.once("error", (err) => {
        if (err && err.code === "EADDRINUSE") {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        resolve({ server, port });
      });
    }
    tryPort(preferredPort);
  });
}

module.exports = { createServer, startServer };
