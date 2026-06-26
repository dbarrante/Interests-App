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

const WEB_DIR = path.join(__dirname, "..", "web");
const VERSION = require("../package.json").version;

const PORT_MIN = 3456;
const PORT_MAX = 3465;

function createServer(ctx) {
  const app = express();
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
    const cards = (req.body && req.body.cards) || [];
    dbm.replaceCards(db, cards);
    res.json({ ok: true, count: cards.length });
  });
  app.patch("/api/cards/:id", (req, res) => {
    const card = (req.body && req.body.card) || {};
    card.id = req.params.id;
    dbm.upsertCard(db, card);
    res.json({ ok: true });
  });
  app.delete("/api/cards/:id", (req, res) => {
    dbm.deleteCard(db, req.params.id);
    res.json({ ok: true });
  });

  // --- Saved ---
  app.get("/api/saved", (req, res) => {
    res.json({ saved: dbm.allSaved(db) });
  });
  app.put("/api/saved", (req, res) => {
    const saved = (req.body && req.body.saved) || [];
    dbm.replaceSaved(db, saved);
    res.json({ ok: true, count: saved.length });
  });
  app.patch("/api/saved/:id", (req, res) => {
    const item = (req.body && req.body.item) || {};
    item.id = req.params.id;
    dbm.upsertSaved(db, item);
    res.json({ ok: true });
  });
  app.delete("/api/saved/:id", (req, res) => {
    dbm.deleteSaved(db, req.params.id);
    res.json({ ok: true });
  });

  // --- Images ---
  app.get("/api/img/:id", (req, res) => {
    const buf = images.getImg(storeDir, req.params.id);
    if (!buf) { res.status(404).end(); return; }
    res.type("image/jpeg").send(buf);
  });
  app.put("/api/img/:id", (req, res) => {
    const file = images.putImg(storeDir, req.params.id, String(req.body && req.body.data || ""));
    res.json({ ok: true, file });
  });
  app.delete("/api/img/:id", (req, res) => {
    images.delImg(storeDir, req.params.id);
    res.json({ ok: true });
  });

  // --- Fingerprints ---
  app.get("/api/fp", (req, res) => {
    res.json({ fp: dbm.allFp(db) });
  });
  app.put("/api/fp/:id", (req, res) => {
    dbm.setFp(db, req.params.id, String(req.body && req.body.value != null ? req.body.value : ""));
    res.json({ ok: true });
  });
  app.delete("/api/fp/:id", (req, res) => {
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
    const srcDir = req.body && req.body.srcDir;
    if (!srcDir || typeof srcDir !== "string") {
      return res.status(400).json({ error: "srcDir required" });
    }
    try {
      const out = importLegacyBackup(srcDir, { db: ctx.db, storeDir: ctx.storeDir });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: String(e && e.message ? e.message : e) });
    }
  });

  // ---- backup / restore / health ----
  app.post("/api/backup", (req, res) => {
    try {
      const out = backup.runBackup(ctx.db, ctx.storeDir);
      if (backup.verifyBackup(out.name, out.counts)) backup.rotate(3);
      res.json({ ok: true, name: out.name, counts: out.counts });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.get("/api/backups", (req, res) => {
    res.json({ backups: backup.listBackups() });
  });

  app.post("/api/restore", (req, res) => {
    const name = req.body && req.body.name;
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    try {
      const out = backup.restore(name, ctx);   // restore rebinds ctx.db on success
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
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
