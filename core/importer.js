"use strict";

const fs = require("fs");
const path = require("path");

const db = require("./db");
const images = require("./images");

// Pure: parsed data.json -> { cards, saved, kv }.
function safeParseArray(s) {
  if (typeof s !== "string" || !s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}

function mapLegacyKeys(dataJson) {
  const keys = (dataJson && dataJson.keys) || {};
  const cards = safeParseArray(keys.ia_imported);
  const saved = safeParseArray(keys.ia_saved);
  const kv = {};
  for (const k of Object.keys(keys)) {
    if (!k.startsWith("ia_")) continue;
    if (k === "ia_imported" || k === "ia_saved") continue;
    kv[k] = keys[k];
  }
  return { cards: cards, saved: saved, kv: kv };
}

// True when a card's image reference points at the local file store (idb:<id>).
function isLocalImgRef(ref) {
  return typeof ref === "string" && ref.indexOf("idb:") === 0;
}

// One-time migration. READ-ONLY on srcDir. Writes rows + image files into ctx.
// ctx = { db, storeDir }. Returns { cards, saved, images, missing }.
function importLegacyBackup(srcDir, ctx) {
  const dataPath = path.join(srcDir, "data.json");
  const dataJson = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const mapped = mapLegacyKeys(dataJson);

  // Rows first (transactions inside replaceCards/replaceSaved).
  db.replaceCards(ctx.db, mapped.cards);
  db.replaceSaved(ctx.db, mapped.saved);
  for (const key of Object.keys(mapped.kv)) {
    db.setKV(ctx.db, key, mapped.kv[key]);
  }

  // Unpack each shard: id -> dataURL written to images/<id>.jpg.
  const shardCount = (dataJson && typeof dataJson.shards === "number") ? dataJson.shards : 0;
  for (let i = 0; i < shardCount; i++) {
    const shardPath = path.join(srcDir, "img-" + i + ".json");
    if (!fs.existsSync(shardPath)) continue;
    let shard;
    try { shard = JSON.parse(fs.readFileSync(shardPath, "utf8")); }
    catch (e) { continue; }
    for (const id of Object.keys(shard)) {
      const dataUrl = shard[id];
      if (typeof dataUrl !== "string" || !dataUrl) continue;
      try { images.putImg(ctx.storeDir, id, dataUrl); } catch (e) { /* skip bad image */ }
    }
  }

  // Any card whose image is a local (idb:) ref but has no file on disk is "missing".
  const missing = [];
  for (const card of mapped.cards) {
    if (isLocalImgRef(card.img) && !images.hasImg(ctx.storeDir, card.id)) {
      missing.push(card.id);
    }
  }

  const c = db.counts(ctx.db);
  return {
    cards: c.cards,
    saved: c.saved,
    images: images.imageCount(ctx.storeDir),
    missing: missing
  };
}

module.exports = { mapLegacyKeys: mapLegacyKeys, importLegacyBackup: importLegacyBackup };
