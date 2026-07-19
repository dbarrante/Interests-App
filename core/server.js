// Core HTTP service for the Interests App.
// Phase 1 skeleton: serves the web/ UI statically and exposes GET /api/ping.
// createServer(ctx) is a pure factory (no listen) so it can be mounted on an
// ephemeral port in tests. startServer(ctx, port) binds with [3456..3465] fallback.
const path = require("path");
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

const WEB_DIR = path.join(__dirname, "..", "web");
const VERSION = require("../package.json").version;

const PORT_MIN = 3456;
const PORT_MAX = 3465;

// Origins allowed to reach the local API. The app UI runs on the loopback
// address (http://127.0.0.1:<port> / http://localhost:<port>) and the Chrome
// extension sends an Origin of chrome-extension://<id>. Same-origin GETs the
// browser makes for the page itself carry NO Origin header, which is also
// allowed. A malicious web page the user visits would send its own (https://…)
// Origin, which is rejected — this is the CSRF / drive-by-API guard.
const ORIGIN_OK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;
function originAllowed(origin) {
  if (!origin) return true;                       // no Origin (navigation / same-origin) → allow
  if (origin === "null") return true;             // file:// / sandboxed → treat as no web origin
  if (origin.indexOf("chrome-extension://") === 0) return true;  // the capture extension
  return ORIGIN_OK.test(origin);
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
      let lanEnabled = false;
      try { lanEnabled = !!config.loadConfig().lanEnabled; } catch (e) { lanEnabled = false; }
      if (!lanEnabled) return next();
      if (req.path === "/api/pair-status") return next();   // capability probe is exempt
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

  app.use(express.json({ limit: "64mb" }));

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
    dbm.replaceCards(ctx.db, cards, { asOf });
    res.json({ ok: true, count: cards.length });
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
    dbm.replaceSaved(ctx.db, saved, { asOf });
    res.json({ ok: true, count: saved.length });
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
  // The app drains exactly like the old localStorage `ia_captures`: GET returns
  // the queued captures AND clears them, so each capture is delivered once.
  function readCaptureQueue() {
    const raw = dbm.getKV(ctx.db, "ia_capture_queue");
    if (!raw) return [];
    try { const q = JSON.parse(raw); return Array.isArray(q) ? q : []; }
    catch (e) { return []; }
  }

  app.post("/api/captures", (req, res) => {
    ctx.syncDirty = true;
    const capture = req.body && req.body.capture;
    if (!capture || typeof capture !== "object") {
      return res.status(400).json({ ok: false, error: "missing capture" });
    }
    const q = readCaptureQueue();
    q.push(capture);
    dbm.setKV(ctx.db, "ia_capture_queue", JSON.stringify(q));
    res.json({ ok: true });
  });

  app.get("/api/captures", (req, res) => {
    const q = readCaptureQueue();
    if (q.length) dbm.setKV(ctx.db, "ia_capture_queue", JSON.stringify([]));
    res.json({ captures: q });
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
    try {
      const out = importLegacyBackup(srcDir, { db: ctx.db, storeDir: ctx.storeDir });
      res.json(out);
    } catch (e) {
      console.error("import failed:", e);
      res.status(400).json({ error: "import failed" });
    }
  });

  // ---- backup / restore / health ----
  app.post("/api/backup", (req, res) => {
    try {
      const out = backup.runBackup(ctx.db, ctx.storeDir);
      const verified = backup.verifyBackup(out.name, out.counts);
      if (verified) backup.rotate(3);            // only rotate older backups once this one verifies
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
    res.json({
      storePath: ctx.storeDir,
      counts: { cards: c.cards | 0, saved: c.saved | 0, images: imageCount(ctx.storeDir) | 0 },
      lastBackup
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
