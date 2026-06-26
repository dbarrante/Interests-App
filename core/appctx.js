// Builds the single server context (db + paths + reopen) used by core/server.js
// and the live Electron app. Keeping it here (not inline in main.js) makes it testable.
const db = require("./db");
const config = require("./config");

function buildContext(storeDir) {
  const dir = storeDir || config.getStorePath();
  const ctx = {
    db: db.openDb(dir),
    storeDir: dir,
    getStorePath: config.getStorePath,
    setStorePath: config.setStorePath,
    reopen: function () {
      try { if (ctx.db && typeof ctx.db.close === "function") ctx.db.close(); } catch (e) {}
      ctx.db = db.openDb(ctx.storeDir);
      return ctx.db;
    }
  };
  return ctx;
}

module.exports = { buildContext };
