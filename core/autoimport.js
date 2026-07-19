// core/autoimport.js — Facebook/Instagram "auto-import" ingestion.
//
// The extension (extension/background.js, already shipped/frozen — see the
// contract comment above its AUTOIMPORT_ALARM block) scrapes a platform's
// saved-items page in an inactive tab, converts any signed-CDN image to a
// durable data: URL, then POSTs the result here as ONE batch:
//   { platform: "fb"|"ig", status, items: [{url,title,image,platformKey}], checkedAt }
// status !== "ok" (login wall, parse failure) means the scraper failed SOFT —
// items is always [] in that case, and this module double-checks that rather
// than trusting the client.
//
// This module never talks to the extension directly — core/server.js mounts
// the HTTP routes and calls processBatch()/getConfig()/getStatus() below.
//
// Survivors (new, non-duplicate items) are appended to the SAME capture
// mailbox (`ia_capture_queue`) that /api/captures POST feeds, shaped like an
// extension clip capture (`clip:true`) so the renderer's existing
// drainCaptures/routeCapture/addClip pipeline ingests them completely
// unchanged — see web/route-capture.js (`cap.clip` -> action "saved") and
// web/index.html's addClip() (consumes url/title/clipImage).
"use strict";
const dbm = require("./db");

// --- Per-field caps -----------------------------------------------------
// Structural identity fields (url, platformKey) are REJECTED outright when
// oversized — truncating a URL or a dedup key would silently corrupt it
// (a truncated URL points somewhere else; a truncated platformKey can
// collide with an unrelated post). title is free text, so it is safely
// truncated like the app's other clip-title handling (addClip does the
// same `.slice()` truncation).
//
// image is the one AMENDED cap (Task 2 review, binding): 262144 chars, and
// an oversized image STRIPS the field but KEEPS the item — the renderer's
// existing capture-enrichment queue backfills a missing image later, so
// losing the whole item over an oversized image would be needless data loss.
const CAPS = { url: 2048, title: 512, image: 262144, platformKey: 128 };
const MAX_ITEMS = 200;
const LEDGER_CAP = 5000;

// --- URL normalization (unit-tested; core-side, deliberately NOT the
// web/lib/urlkey.js implementation — this only needs the three transforms
// called out in the plan) ------------------------------------------------
// lowercase host, strip the hash, strip utm_*/fbclid/igsh tracking params.
// Remaining query params are kept but re-serialized in sorted key order so
// two URLs that differ only in query-param ORDER still normalize equal.
function normalizeUrl(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let u;
  try { u = new URL(trimmed); } catch (e) { return trimmed; }   // not a parseable URL — best effort passthrough
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (/^utm_/i.test(k) || /^fbclid$/i.test(k) || /^igsh$/i.test(k)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = new URLSearchParams();
  kept.forEach(([k, v]) => qs.append(k, v));
  const search = qs.toString();
  u.search = search ? "?" + search : "";
  return u.toString();
}

// --- kv helpers -----------------------------------------------------------
function ledgerKvKey(platform) { return "ia_autoimport_seen_" + platform; }
function lastKvKey(platform) { return "ia_autoimport_last_" + platform; }

function readJson(db, key, fallback) {
  const raw = dbm.getKV(db, key);
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function writeJson(db, key, value) { dbm.setKV(db, key, JSON.stringify(value)); }

// Same read shape as core/server.js's readCaptureQueue — kept independent
// (rather than imported) since server.js's version is a route-local closure,
// but the kv key and "array or []" contract are matched exactly so the two
// producers (manual capture, auto-import) can never disagree about the shape.
function readCaptureQueue(db) {
  const raw = dbm.getKV(db, "ia_capture_queue");
  if (!raw) return [];
  try { const q = JSON.parse(raw); return Array.isArray(q) ? q : []; }
  catch (e) { return []; }
}

// Prune the ledger to LEDGER_CAP entries, oldest firstSeenMs first, in place.
function pruneLedger(ledger) {
  const keys = Object.keys(ledger);
  if (keys.length <= LEDGER_CAP) return ledger;
  keys.sort((a, b) => (Number(ledger[a]) || 0) - (Number(ledger[b]) || 0));
  const drop = keys.length - LEDGER_CAP;
  for (let i = 0; i < drop; i++) delete ledger[keys[i]];
  return ledger;
}

// Every existing card/saved URL, normalized, for the URL half of the dedup
// check (platformKey-ledger dedup is the primary/permanent guard; this is a
// secondary guard so an item never duplicates a URL already in the library
// even the very first time its platformKey is seen).
function existingUrlSet(db) {
  const set = new Set();
  try { dbm.allCards(db).forEach((c) => { if (c && c.url) set.add(normalizeUrl(c.url)); }); } catch (e) {}
  try { dbm.allSaved(db).forEach((s) => { if (s && s.url) set.add(normalizeUrl(s.url)); }); } catch (e) {}
  return set;
}

// Validate + cap one raw scraped item. Returns a clean {url,platformKey,title,image}
// or null if the item is structurally unusable (dropped silently — not counted
// as added or duplicate, since it was never a real candidate).
function validItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url || url.length > CAPS.url || !/^https?:\/\//i.test(url)) return null;
  const platformKey = typeof raw.platformKey === "string" ? raw.platformKey.trim() : "";
  if (!platformKey || platformKey.length > CAPS.platformKey) return null;
  const title = (typeof raw.title === "string" ? raw.title.trim() : "").slice(0, CAPS.title);
  let image = typeof raw.image === "string" ? raw.image : "";
  if (image.length > CAPS.image) image = "";   // AMENDMENT: strip oversized image, keep the item
  return { url, platformKey, title, image };
}

// processBatch(ctx, batch) -> {added, duplicates, status}
// ctx: the same server ctx used throughout core/server.js (ctx.db is the open
// better-sqlite3 handle). batch: the parsed POST /api/auto-import body.
function processBatch(ctx, batch) {
  const db = ctx && ctx.db;
  if (!batch || typeof batch !== "object") return { added: 0, duplicates: 0, status: "invalid" };
  const platform = batch.platform;
  if (platform !== "fb" && platform !== "ig") return { added: 0, duplicates: 0, status: "invalid" };
  if (batch.items !== undefined && !Array.isArray(batch.items)) return { added: 0, duplicates: 0, status: "invalid" };

  const incomingStatus = (typeof batch.status === "string" && batch.status) ? batch.status : "parse-failed";
  const checkedAt = Number(batch.checkedAt) || Date.now();
  let rawItems = Array.isArray(batch.items) ? batch.items : [];
  // Fail-soft, enforced core-side too (never trust the client alone): only a
  // clean "ok" scrape may add items. A login wall / parse failure imports
  // nothing even if a buggy or malicious POST attached items anyway.
  if (incomingStatus !== "ok") rawItems = [];
  if (rawItems.length > MAX_ITEMS) rawItems = rawItems.slice(0, MAX_ITEMS);
  const found = rawItems.length;

  const ledger = readJson(db, ledgerKvKey(platform), {});
  const existingUrls = existingUrlSet(db);
  const queue = readCaptureQueue(db);
  const survivors = [];
  let added = 0, duplicates = 0;

  for (const raw of rawItems) {
    const item = validItem(raw);
    if (!item) continue;   // structurally invalid — silently dropped
    const nu = normalizeUrl(item.url);
    const seenBefore = Object.prototype.hasOwnProperty.call(ledger, item.platformKey);
    const urlExists = existingUrls.has(nu);
    // Ledger-add every NEW platformKey seen this run, whether or not it turns
    // out to be a duplicate by URL — this is what makes "deleted in the app"
    // permanent: the key stays in the ledger long after the card is gone, so
    // it is never reconsidered on a later scrape (until the 5000-cap prune
    // eventually ages very old keys out).
    if (!seenBefore) ledger[item.platformKey] = checkedAt;
    if (seenBefore || urlExists) { duplicates++; continue; }
    added++;
    existingUrls.add(nu);   // guard against the same URL appearing twice within one batch
    survivors.push({
      url: item.url,
      title: item.title,
      clipImage: item.image || "",
      clip: true,                          // routeCapture: cap.clip -> action "saved" (new Saved card, never touches Imported)
      source: platform + "-auto",
      ts: checkedAt,
    });
  }

  pruneLedger(ledger);
  writeJson(db, ledgerKvKey(platform), ledger);
  if (survivors.length) writeJson(db, "ia_capture_queue", queue.concat(survivors));

  const status = incomingStatus;
  writeJson(db, lastKvKey(platform), { at: Date.now(), found, added, duplicates, status });
  return { added, duplicates, status };
}

// GET /api/auto-import/config — settings kv `ia_settings` is a JSON blob;
// autoImportOn defaults false (auto-check ships OFF by default), each
// platform toggle defaults true (on once the master switch is on).
function getConfig(ctx) {
  const db = ctx && ctx.db;
  let settings = {};
  try { settings = JSON.parse(dbm.getKV(db, "ia_settings") || "null") || {}; } catch (e) { settings = {}; }
  return {
    on: !!settings.autoImportOn,
    platforms: {
      fb: settings.autoImportFb !== false,
      ig: settings.autoImportIg !== false,
    },
  };
}

// GET /api/auto-import/status — the renderer's Settings section reads both
// platforms' last-run records at once.
function getStatus(ctx) {
  const db = ctx && ctx.db;
  return {
    fb: readJson(db, lastKvKey("fb"), null),
    ig: readJson(db, lastKvKey("ig"), null),
  };
}

module.exports = { processBatch, getConfig, getStatus, normalizeUrl, CAPS, MAX_ITEMS, LEDGER_CAP };
