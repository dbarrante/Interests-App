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
  "script-src 'self' 'unsafe-inline'",
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

  // NOTE: do NOT destructure ctx.db/ctx.storeDir into locals here — backup.restore()
  // and backup.moveStore() close and rebind ctx.db (and repoint ctx.storeDir) at
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
  app.post("/api/duplicates/not-duplicate", (req, res) => {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > 200) {
      return res.status(400).json({ ok: false, error: "invalid_entries" });
    }
    const parsed = [];
    let keyBytes = 0;
    for (const raw of entries) {
      const scope = raw && raw.scope, id = raw && String(raw.id || ""), key = raw && raw.key;
      if ((scope !== "imported" && scope !== "saved") || !id || id.length > 512 || typeof key !== "string" || !key || key.length > 131072) {
        return res.status(400).json({ ok: false, error: "invalid_entry" });
      }
      keyBytes += Buffer.byteLength(key, "utf8");
      if (keyBytes > 262144) return res.status(413).json({ ok: false, error: "entries_too_large" });
      parsed.push({ scope, id, key });
    }
    const groups = new Map();
    for (const entry of parsed) {
      if (!groups.has(entry.key)) groups.set(entry.key, []);
      groups.get(entry.key).push(entry);
    }
    const expectedByKey = new Map();
    for (const [key, groupEntries] of groups) {
      let members;
      try { members = JSON.parse(key); } catch (e) { members = null; }
      if (!Array.isArray(members) || members.length !== groupEntries.length || members.length > 200) {
        return res.status(400).json({ ok: false, error: "invalid_key" });
      }
      const requested = new Set(groupEntries.map(entry => entry.scope + "\n" + entry.id));
      if (requested.size !== groupEntries.length || members.some(member => !Array.isArray(member) || member.length !== 4 ||
          (member[0] !== "imported" && member[0] !== "saved") || typeof member[1] !== "string" ||
          typeof member[2] !== "string" || typeof member[3] !== "string" ||
          !requested.has(member[0] + "\n" + member[1]))) {
        return res.status(400).json({ ok: false, error: "invalid_key" });
      }
      const memberById = new Map(members.map(member => [member[0] + "\n" + member[1], member]));
      if (memberById.size !== members.length) return res.status(400).json({ ok: false, error: "invalid_key" });
      expectedByKey.set(key, memberById);
    }
    let changed = 0;
    ctx.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of parsed) {
        const item = entry.scope === "saved" ? dbm.getSaved(ctx.db, entry.id) : dbm.getCard(ctx.db, entry.id);
        const expected = expectedByKey.get(entry.key).get(entry.scope + "\n" + entry.id);
        const current = [entry.scope, String(item && item.id || ""), String(item && item.url || "").trim().toLowerCase(),
          String(item && item.title || "").trim().toLowerCase().replace(/\s+/g, " ")];
        if (!item || JSON.stringify(current) !== JSON.stringify(expected)) {
          ctx.db.exec("ROLLBACK");
          return res.status(409).json({ ok: false, error: "row_changed" });
        }
      }
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
  app.post("/api/import", (req, res) => {
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
      let safety;
      try { safety = backup.runBackup(ctx.db, ctx.storeDir); }
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
  app.post("/api/backup", (req, res) => {
    try {
      const safety = !!(req.body && req.body.safety);
      const out = backup.runBackup(ctx.db, ctx.storeDir, { safety });
      const verified = backup.verifyBackup(out.name, out.counts);
      if (verified && !safety) {
        // Client sends its ia_settings.backupRetainCount; clamp against a
        // client-controlled value the same way — never trust it blindly.
        let keep = Number(req.body && req.body.keep);
        if (!Number.isFinite(keep) || keep < 1) keep = 3;
        keep = Math.min(Math.floor(keep), 30);
        backup.rotate(keep); // cleanup snapshots are unique and never auto-rotated
      }
      res.json({ ok: true, verified, name: out.name, counts: out.counts });
    } catch (e) {
      console.error("backup failed:", e);
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

  app.post("/api/restore", (req, res) => {
    const name = req.body && req.body.name;
    if (!isAllowedBackupName(name)) {
      return res.status(400).json({ ok: false, error: "invalid backup name" });
    }
    try {
      const out = backup.restore(name, ctx);   // restore rebinds ctx.db on success
      res.json(out);
    } catch (e) {
      console.error("restore failed:", e);
      res.status(500).json({ ok: false, error: "restore failed" });
    }
  });

  app.get("/api/health", (req, res) => {
    const c = counts(ctx.db);
    const list = backup.listBackups();
    const lastBackup = list.length ? { name: list[0].name, counts: list[0].counts } : null;
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

  app.post("/api/store-location/move", (req, res) => {
    let target = req.body && req.body.target;
    if (!target || typeof target !== "string" || !path.isAbsolute(target)) {
      return res.status(400).json({ ok: false, path: ctx.storeDir, error: "absolute target required" });
    }
    target = path.resolve(target);
    try {
      const out = backup.moveStore(target, ctx);   // repoints ctx.db/ctx.storeDir on success
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
    res.json({
      enabled: sc.enabled, folder: syncDir, dropboxFound: dropboxFound,
      deviceId: sc.deviceId, deviceLabel: sc.deviceLabel,
      peers: peers, changedAt: changedAt,
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
    try {
      // Prefer the worker-thread runner (ctx.syncRunner, set by main.js) so a
      // manual sync can't freeze the main process either; tests and headless
      // embedders without a runner keep the direct synchronous path.
      const runner = (ctx.syncRunner && ctx.syncRunner.runSync) ? ctx.syncRunner : sync;
      const r = await Promise.resolve(runner.runSync(ctx, { syncDir: syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true }));
      if (r && r.ok === false) { console.error("sync now failed:", r.error); return res.status(500).json({ ok: false, error: "sync failed" }); }
      if (r.changed) { try { dbm.setKV(ctx.db, "ia_sync_changed_at", String(Date.now())); } catch (e) { console.error("setKV ia_sync_changed_at failed:", e); } }
      res.json({ ok: true, changed: r.changed, conflicts: r.conflicts, peers: r.peers });
    } catch (e) { console.error("sync now failed:", e); res.status(500).json({ ok: false, error: "sync failed" }); }
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
