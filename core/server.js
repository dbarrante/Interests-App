// Core HTTP service for the Interests App.
// Phase 1 skeleton: serves the web/ UI statically and exposes GET /api/ping.
// createServer(ctx) is a pure factory (no listen) so it can be mounted on an
// ephemeral port in tests. startServer(ctx, port) binds with [3456..3465] fallback.
const path = require("path");
const http = require("http");
const express = require("express");
const dbm = require("./db");
const images = require("./images");

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
