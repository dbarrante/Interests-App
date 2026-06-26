"use strict";

// Pure: parsed data.json -> { cards, saved, kv }.
// keys values are raw localStorage strings (each itself a JSON string).
// ia_imported -> cards (parsed array), ia_saved -> saved (parsed array),
// every other ia_* key (incl. ia_settings) -> kv[key] = raw string.
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

module.exports = { mapLegacyKeys: mapLegacyKeys };
