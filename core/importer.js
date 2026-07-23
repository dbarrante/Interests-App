"use strict";

const fs = require("fs");
const path = require("path");

const db = require("./db");
const images = require("./images");

// Pure: parsed data.json -> { cards, saved, kv }.
function safeParseArray(value) {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function mapLegacyKeys(dataJson) {
  const keys = (dataJson && dataJson.keys) || {};
  const cards = safeParseArray(keys.ia_imported);
  const saved = safeParseArray(keys.ia_saved);
  const kv = {};
  for (const key of Object.keys(keys)) {
    if (!key.startsWith("ia_") || key === "ia_imported" || key === "ia_saved") continue;
    kv[key] = keys[key];
  }
  return { cards, saved, kv };
}

function isLocalImgRef(ref) {
  return typeof ref === "string" && ref.indexOf("idb:") === 0;
}

function strictArray(raw, label) {
  if (raw == null || raw === "") return [];
  let value;
  try { value = JSON.parse(raw); } catch (e) { throw new Error("invalid " + label + " JSON"); }
  if (!Array.isArray(value)) throw new Error("invalid " + label + " array");
  return value;
}

// Parse every source file before touching the live store. A legacy source is
// treated as untrusted input: missing or malformed shards fail the import.
function readLegacySource(srcDir) {
  const dataPath = path.join(srcDir, "data.json");
  let dataJson;
  try { dataJson = JSON.parse(fs.readFileSync(dataPath, "utf8")); }
  catch (e) { throw new Error("invalid data.json"); }
  if (!dataJson || typeof dataJson !== "object" || Array.isArray(dataJson)) throw new Error("invalid data.json");

  const keys = dataJson.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("backup keys missing");
  const mapped = {
    cards: strictArray(keys.ia_imported, "ia_imported"),
    saved: strictArray(keys.ia_saved, "ia_saved"),
    kv: {},
  };
  for (const key of Object.keys(keys)) {
    if (key.startsWith("ia_") && key !== "ia_imported" && key !== "ia_saved") mapped.kv[key] = keys[key];
  }

  const shardCount = dataJson.shards == null ? 0 : Number(dataJson.shards);
  if (!Number.isInteger(shardCount) || shardCount < 0 || shardCount > 10000) throw new Error("invalid image shard count");
  const shards = [];
  for (let i = 0; i < shardCount; i++) {
    const shardPath = path.join(srcDir, "img-" + i + ".json");
    if (!fs.existsSync(shardPath)) throw new Error("missing image shard " + i);
    let shard;
    try { shard = JSON.parse(fs.readFileSync(shardPath, "utf8")); }
    catch (e) { throw new Error("invalid image shard " + i); }
    if (!shard || typeof shard !== "object" || Array.isArray(shard)) throw new Error("invalid image shard " + i);
    shards.push(shard);
  }
  return { mapped, shards };
}

// Publish staged images and rows while retaining the existing live DB handle.
// If either the image move or DB transaction fails, restore the old images and
// leave the live rows untouched.
function publishImportedStore(stageDir, mapped, ctx) {
  const liveImages = path.join(ctx.storeDir, "images");
  const holdDir = ctx.storeDir + ".before-import-" + process.pid + "-" + Date.now();
  const stagedImages = path.join(stageDir, "images");
  let oldImagesMoved = false;
  let newImagesMoved = false;
  let committed = false;

  fs.mkdirSync(holdDir, { recursive: true });
  try {
    if (fs.existsSync(liveImages)) {
      fs.renameSync(liveImages, path.join(holdDir, "images"));
      oldImagesMoved = true;
    }
    fs.renameSync(stagedImages, liveImages);
    newImagesMoved = true;

    ctx.db.exec("BEGIN IMMEDIATE");
    try {
      db.replaceCards(ctx.db, mapped.cards, { _inTransaction: true });
      db.replaceSaved(ctx.db, mapped.saved, { _inTransaction: true });
      for (const key of Object.keys(mapped.kv)) db.setKV(ctx.db, key, mapped.kv[key]);
      ctx.db.exec("COMMIT");
      committed = true;
    } catch (e) {
      try { ctx.db.exec("ROLLBACK"); } catch (rollbackError) {}
      throw e;
    }
    try { fs.rmSync(holdDir, { recursive: true, force: true }); } catch (e) {}
  } catch (e) {
    if (!committed) {
      if (newImagesMoved) {
        try { fs.rmSync(liveImages, { recursive: true, force: true }); } catch (removeError) {}
      }
      if (oldImagesMoved) {
        try { fs.renameSync(path.join(holdDir, "images"), liveImages); } catch (restoreError) {}
      }
    }
    throw e;
  }
}

// One-time migration. READ-ONLY on srcDir. The source is fully parsed and
// staged before the live store is replaced, so malformed shards or a failed
// write cannot turn the current library into a partial import.
function importLegacyBackup(srcDir, ctx) {
  const source = readLegacySource(srcDir);
  const mapped = source.mapped;
  const stageDir = fs.mkdtempSync(path.join(ctx.storeDir + ".import-stage-"));
  fs.mkdirSync(path.join(stageDir, "images"), { recursive: true });

  try {
    const stagedDb = db.openDb(stageDir);
    try {
      for (const item of mapped.saved) {
        if (item && typeof item.image === "string" && item.image.indexOf("data:") === 0) {
          images.putImg(stageDir, item.id, item.image);
          item.image = "idb:" + item.id;
        }
      }
      for (const shard of source.shards) {
        for (const id of Object.keys(shard)) {
          const dataUrl = shard[id];
          if (typeof dataUrl !== "string" || !dataUrl) throw new Error("invalid image payload for " + id);
          images.putImg(stageDir, id, dataUrl);
        }
      }
      db.replaceCards(stagedDb, mapped.cards);
      db.replaceSaved(stagedDb, mapped.saved);
      for (const key of Object.keys(mapped.kv)) db.setKV(stagedDb, key, mapped.kv[key]);
    } finally {
      try { stagedDb.close(); } catch (e) {}
    }

    const missing = [];
    for (const card of mapped.cards) {
      if (isLocalImgRef(card.img) && !images.hasImg(stageDir, card.id)) missing.push(card.id);
    }
    publishImportedStore(stageDir, mapped, ctx);
    const counts = db.counts(ctx.db);
    return { cards: counts.cards, saved: counts.saved, images: images.imageCount(ctx.storeDir), missing };
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { mapLegacyKeys, importLegacyBackup };
