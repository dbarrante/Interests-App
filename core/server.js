// Core HTTP service for the Interests App.
// Phase 1 skeleton: serves the web/ UI statically and exposes GET /api/ping.
// createServer(ctx) is a pure factory (no listen) so it can be mounted on an
// ephemeral port in tests. startServer(ctx, port) binds with [3456..3465] fallback.
const path = require("path");
const http = require("http");
const express = require("express");
const dbm = require("./db");
const images = require("./images");
const { importLegacyBackup } = require("./importer");
const backup = require("./backup.js");
const { counts } = require("./db.js");
const { imageCount } = require("./images.js");
const config = require("./config");
const sync = require("./sync");
const bookmarks = require("./bookmarks");
const linkcheck = require("./linkcheck");
const contentcheck = require("./contentcheck");
const safebrowse = require("./safebrowse");
const capturemeta = require("./capturemeta");

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

  // Block cross-origin web pages from reaching the local API (before any route).
  app.use((req, res, next) => {
    if (!originAllowed(req.headers.origin)) {
      return res.status(403).json({ ok: false, error: "forbidden origin" });
    }
    next();
  });

  // Apply the CSP to every response (covers the served HTML and its assets).
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    next();
  });

  app.use(express.json({ limit: "64mb" }));

  const { db, storeDir } = ctx;

  // Discovery endpoint — the extension probes [3456..3465] for this.
  app.get("/api/ping", (req, res) => {
    res.json({ app: "interests", version: VERSION });
  });

  // --- KV ---
  app.get("/api/kv/:key", (req, res) => {
    res.json({ value: dbm.getKV(db, req.params.key) });
  });
  app.put("/api/kv/:key", (req, res) => {
    dbm.setKV(db, req.params.key, String(req.body && req.body.value != null ? req.body.value : ""));
    res.json({ ok: true });
  });

  // --- Cards ---
  app.get("/api/cards", (req, res) => {
    res.json({ cards: dbm.allCards(db) });
  });
  app.put("/api/cards", (req, res) => {
    ctx.syncDirty = true;
    const cards = (req.body && req.body.cards) || [];
    dbm.replaceCards(db, cards);
    res.json({ ok: true, count: cards.length });
  });
  app.patch("/api/cards/:id", (req, res) => {
    ctx.syncDirty = true;
    const card = (req.body && req.body.card) || {};
    card.id = req.params.id;
    dbm.upsertCard(db, card);
    res.json({ ok: true });
  });
  app.delete("/api/cards/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.deleteCard(db, req.params.id);
    res.json({ ok: true });
  });

  // --- Saved ---
  app.get("/api/saved", (req, res) => {
    res.json({ saved: dbm.allSaved(db) });
  });
  app.put("/api/saved", (req, res) => {
    ctx.syncDirty = true;
    const saved = (req.body && req.body.saved) || [];
    dbm.replaceSaved(db, saved);
    res.json({ ok: true, count: saved.length });
  });
  app.patch("/api/saved/:id", (req, res) => {
    ctx.syncDirty = true;
    const item = (req.body && req.body.item) || {};
    item.id = req.params.id;
    dbm.upsertSaved(db, item);
    res.json({ ok: true });
  });
  app.delete("/api/saved/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.deleteSaved(db, req.params.id);
    res.json({ ok: true });
  });

  // --- Images ---
  // An invalid id (path-traversal attempt — see core/images.safeImgId) throws
  // INVALID_IMG_ID; map that to 400. A well-formed but absent image is 404.
  function isInvalidImgId(e) { return e && e.code === "INVALID_IMG_ID"; }
  app.get("/api/img/:id", (req, res) => {
    let buf;
    try { buf = images.getImg(storeDir, req.params.id); }
    catch (e) { if (isInvalidImgId(e)) return res.status(400).json({ ok: false, error: "invalid image id" }); throw e; }
    if (!buf) { res.status(404).end(); return; }
    res.type("image/jpeg").send(buf);
  });
  app.put("/api/img/:id", (req, res) => {
    ctx.syncDirty = true;
    try {
      const file = images.putImg(storeDir, req.params.id, String(req.body && req.body.data || ""));
      res.json({ ok: true, file });
    } catch (e) {
      if (isInvalidImgId(e)) return res.status(400).json({ ok: false, error: "invalid image id" });
      throw e;
    }
  });
  app.delete("/api/img/:id", (req, res) => {
    ctx.syncDirty = true;
    try {
      images.delImg(storeDir, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      if (isInvalidImgId(e)) return res.status(400).json({ ok: false, error: "invalid image id" });
      throw e;
    }
  });

  // --- Fingerprints ---
  app.get("/api/fp", (req, res) => {
    res.json({ fp: dbm.allFp(db) });
  });
  app.put("/api/fp/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.setFp(db, req.params.id, String(req.body && req.body.value != null ? req.body.value : ""));
    res.json({ ok: true });
  });
  app.delete("/api/fp/:id", (req, res) => {
    ctx.syncDirty = true;
    dbm.delFp(db, req.params.id);
    res.json({ ok: true });
  });

  // --- Capture queue (persisted in kv key ia_capture_queue) ---
  // The app drains exactly like the old localStorage `ia_captures`: GET returns
  // the queued captures AND clears them, so each capture is delivered once.
  function readCaptureQueue() {
    const raw = dbm.getKV(db, "ia_capture_queue");
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
    dbm.setKV(db, "ia_capture_queue", JSON.stringify(q));
    res.json({ ok: true });
  });

  app.get("/api/captures", (req, res) => {
    const q = readCaptureQueue();
    if (q.length) dbm.setKV(db, "ia_capture_queue", JSON.stringify([]));
    res.json({ captures: q });
  });

  // --- Single capture request (kv ia_capture_request) ---
  function readJsonKV(key) {
    const raw = dbm.getKV(db, key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  app.get("/api/capture-request", (req, res) => {
    res.json({ request: readJsonKV("ia_capture_request") });
  });
  app.post("/api/capture-request", (req, res) => {
    const request = req.body && req.body.request;
    if (request == null) dbm.setKV(db, "ia_capture_request", "");
    else dbm.setKV(db, "ia_capture_request", JSON.stringify(request));
    res.json({ ok: true });
  });

  // --- Batch driver state (kv ia_batch_state) ---
  app.get("/api/batch-state", (req, res) => {
    res.json({ state: readJsonKV("ia_batch_state") });
  });
  app.post("/api/batch-state", (req, res) => {
    const state = req.body && req.body.state;
    if (state == null) dbm.setKV(db, "ia_batch_state", "");
    else dbm.setKV(db, "ia_batch_state", JSON.stringify(state));
    res.json({ ok: true });
  });

  // --- Batch progress (kv ia_batch_progress) ---
  app.get("/api/batch-progress", (req, res) => {
    res.json({ progress: readJsonKV("ia_batch_progress") });
  });
  app.post("/api/batch-progress", (req, res) => {
    const progress = req.body && req.body.progress;
    if (progress == null) dbm.setKV(db, "ia_batch_progress", "");
    else dbm.setKV(db, "ia_batch_progress", JSON.stringify(progress));
    res.json({ ok: true });
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
    try { if (syncDir) peers = sync.readPeerSnapshots(syncDir, sc.deviceId).map(function (p) { return { deviceLabel: p.deviceLabel, deviceId: p.deviceId, publishedAt: p.publishedAt }; }); } catch (e) {}
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

  app.post("/api/sync/now", (req, res) => {
    const sc = config.getSyncConfig();
    let defaultDir = null; try { defaultDir = sync.defaultSyncDir(); } catch (e) {}
    const syncDir = sc.dir || defaultDir;
    if (!sc.enabled || !syncDir) return res.status(400).json({ ok: false, error: "sync not enabled / no Dropbox" });
    try {
      const r = sync.runSync(ctx, { syncDir: syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true });
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
          try { images.putImg(storeDir, r.id, r.imageDataUrl); hasImage = true; }
          catch (e) { console.error("capture-meta putImg failed:", e && e.message); }
        }
        return { id: r && r.id, hasImage: hasImage, title: (r && r.title) || "", description: (r && r.description) || "", reason: hasImage ? "" : ((r && r.reason) || "unreachable") };
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
