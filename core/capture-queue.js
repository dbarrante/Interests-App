// Durable capture mailbox shared by manual extension captures and platform
// auto-import. Claims are leased, not deleted: an unacknowledged capture is
// eligible for retry after the lease expires.
"use strict";

const crypto = require("crypto");
const dbm = require("./db");

const KEY = "ia_capture_queue";
const LEASE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;
const MAX_CLAIM = 200;
const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_KEYS = 48;
const MAX_URL_LENGTH = 4096;
const IMAGE_KEYS = new Set(["screenshot", "clipImage", "ogImage", "contentImage", "image"]);

function fail(message, code) {
  const error = new Error(message);
  error.code = code || "CAPTURE_QUEUE_INVALID";
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validCapture(capture) {
  if (!isPlainObject(capture)) return false;
  const keys = Object.keys(capture);
  if (keys.length > MAX_CAPTURE_KEYS) return false;
  if (typeof capture.url !== "string" || !capture.url.trim() || capture.url.length > MAX_URL_LENGTH) return false;
  for (const key of keys) {
    const value = capture[key];
    if (value == null || typeof value === "boolean" || typeof value === "number") continue;
    if (typeof value !== "string") return false;
    const limit = IMAGE_KEYS.has(key) ? MAX_CAPTURE_BYTES : 4096;
    if (value.length > limit) return false;
  }
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(capture), "utf8"); } catch (e) { return false; }
  return bytes <= MAX_CAPTURE_BYTES;
}

function validEntry(value) {
  return isPlainObject(value) && value._queueEntry === 1
    && typeof value.queueId === "string" && value.queueId.length > 0 && value.queueId.length <= 128
    && validCapture(value.capture)
    && (value.leaseId == null || (typeof value.leaseId === "string" && value.leaseId.length <= 128))
    && Number.isFinite(Number(value.leaseUntil)) && Number(value.leaseUntil) >= 0;
}

function id(prefix) {
  return prefix + crypto.randomUUID();
}

function entry(capture) {
  if (!validCapture(capture)) throw fail("invalid capture", "CAPTURE_INVALID");
  return {
    _queueEntry: 1,
    queueId: id("cap_"),
    capture: capture,
    leaseId: null,
    leaseUntil: 0,
  };
}

// Migrate the old raw-capture array in memory. The first operation that writes
// the queue persists the envelopes, so a legacy mailbox is not lost during the
// upgrade.
function normalize(raw) {
  if (!Array.isArray(raw)) throw fail("capture queue is not an array", "CAPTURE_QUEUE_CORRUPT");
  if (raw.length > MAX_ENTRIES) throw fail("capture queue has too many entries", "CAPTURE_QUEUE_LIMIT");
  return raw.map(function (value) {
    if (value && typeof value === "object" && value._queueEntry === 1
      && typeof value.queueId === "string" && value.capture && typeof value.capture === "object") {
      const normalized = {
        _queueEntry: 1,
        queueId: value.queueId,
        capture: value.capture,
        leaseId: typeof value.leaseId === "string" ? value.leaseId : null,
        leaseUntil: Number(value.leaseUntil) || 0,
      };
      if (!validEntry(normalized)) throw fail("capture queue contains an invalid entry", "CAPTURE_QUEUE_CORRUPT");
      return normalized;
    }
    return entry(value);
  });
}

function read(db) {
  const raw = dbm.getKV(db, KEY);
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw fail("capture queue JSON is corrupt", "CAPTURE_QUEUE_CORRUPT"); }
  return normalize(parsed);
}

function write(db, entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES || entries.some(function (value) { return !validEntry(value); })) {
    throw fail("capture queue exceeds its safety limits", "CAPTURE_QUEUE_LIMIT");
  }
  const json = JSON.stringify(entries);
  if (Buffer.byteLength(json, "utf8") > MAX_QUEUE_BYTES) throw fail("capture queue is too large", "CAPTURE_QUEUE_LIMIT");
  dbm.setKV(db, KEY, json);
}

function appendTo(entries, captures) {
  const out = (entries || []).slice();
  (captures || []).forEach(function (capture) {
    out.push(entry(capture));
  });
  if (out.length > MAX_ENTRIES) throw fail("capture queue has too many entries", "CAPTURE_QUEUE_LIMIT");
  return out;
}

function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw e;
  }
}

function enqueue(db, capture) {
  return withTransaction(db, function () {
    const entries = appendTo(read(db), [capture]);
    write(db, entries);
    return entries[entries.length - 1].queueId;
  });
}

function claim(db, now) {
  now = Number(now) || Date.now();
  return withTransaction(db, function () {
    const entries = read(db);
    const captures = [];
    entries.some(function (item) {
      if (captures.length >= MAX_CLAIM) return true;
      if (item.leaseId && item.leaseUntil > now) return;
      item.leaseId = id("lease_");
      item.leaseUntil = now + LEASE_MS;
      captures.push(Object.assign({}, item.capture, {
        _captureId: item.queueId,
        _captureLease: item.leaseId,
      }));
      return false;
    });
    if (entries.length) write(db, entries);
    return captures;
  });
}

function ack(db, acknowledgements) {
  const acks = Array.isArray(acknowledgements) ? acknowledgements : [];
  return withTransaction(db, function () {
    const entries = read(db);
    const accepted = new Set();
    const wanted = new Map();
    acks.forEach(function (acknowledgement) {
      if (!acknowledgement || typeof acknowledgement !== "object") return;
      if (typeof acknowledgement.id !== "string" || acknowledgement.id.length > 128) return;
      if (typeof acknowledgement.lease !== "string" || !acknowledgement.lease || acknowledgement.lease.length > 128) return;
      wanted.set(acknowledgement.id, acknowledgement.lease);
    });
    const kept = entries.filter(function (item) {
      if (!wanted.has(item.queueId)) return true;
      const lease = wanted.get(item.queueId);
      if (lease !== item.leaseId) return true;
      accepted.add(item.queueId);
      return false;
    });
    if (kept.length !== entries.length) write(db, kept);
    return accepted.size;
  });
}

module.exports = {
  KEY,
  LEASE_MS,
  MAX_ENTRIES,
  MAX_CLAIM,
  MAX_QUEUE_BYTES,
  MAX_CAPTURE_BYTES,
  validCapture,
  read,
  write,
  appendTo,
  enqueue,
  claim,
  ack,
};
