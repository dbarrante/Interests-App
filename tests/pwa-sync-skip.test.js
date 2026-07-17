// tests/pwa-sync-skip.test.js — PWA watermark + signature skipping. Source-scan
// contract: every skip is doubt-biased (kv errors ⇒ full behavior), watermarks
// advance only after a clean cycle, and the own-images cache replaces the
// every-cycle folder pagination.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "sync-pwa.js"), "utf8");

function grab(source, name) {
  let idx = source.indexOf("async function " + name + "(");
  if (idx < 0) idx = source.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); } }

t("readPeers: meta.json fetched FIRST and unchanged publishedAt skips the full snapshot read", () => {
  const body = grab(src, "readPeers");
  const metaIdx = body.indexOf("meta.json");
  const fullIdx = body.indexOf("readFullPeerSnapshot");
  assert.ok(metaIdx >= 0 && fullIdx >= 0 && metaIdx < fullIdx, "meta must be read before the full snapshot");
  assert.ok(/_pwa_peer_seen_/.test(body), "must consult the per-peer watermark");
  assert.ok(/peersSkipped\+\+/.test(body), "must count skips");
  assert.ok(/AUTH_EXPIRED/.test(body.slice(0, fullIdx)), "meta-read failures must still propagate AUTH_EXPIRED");
});

t("watermark advance gated on a CLEAN cycle (no image failures, no partial failures)", () => {
  const body = grab(src, "runSyncCycle");
  assert.ok(/imagesFailed/.test(body) && /partialFailures\.length === 0/.test(body),
    "advance condition must require imagesFailed === 0 and zero partialFailures");
  assert.ok(/_pwa_peer_seen_/.test(body), "runSyncCycle owns the advancement");
});

t("applyMergeToLocal reports imagesFailed to the caller", () => {
  const body = grab(src, "applyMergeToLocal");
  assert.ok(/imagesFailed:\s*imagesFailed/.test(body), "return must include imagesFailed");
});

t("publishSnapshot: signature+clean+mergeChanged gate, computed before any network call", () => {
  const body = grab(src, "publishSnapshot");
  assert.ok(/contentSignature\(/.test(body), "must compute the content signature");
  assert.ok(/_pwa_last_publish_sig/.test(body) && /_pwa_last_publish_clean/.test(body), "must consult stored sig + clean flag");
  assert.ok(/mergeChanged/.test(body), "must refuse to skip when the merge applied changes");
  assert.ok(/skipped:\s*true/.test(body), "skip path must return {skipped:true}");
  const sigIdx = body.indexOf("contentSignature(");
  const listIdx = body.indexOf("listDeviceImageIds");
  assert.ok(listIdx < 0 || sigIdx < listIdx, "the skip decision must come before the images listing");
});

t("own-images cache: seeded from one listing, appended on success, errors fall back to full listing", () => {
  const body = grab(src, "publishSnapshot");
  assert.ok(/_pwa_published_imgids/.test(body), "must use the published-ids cache");
  assert.ok(/Array\.isArray\(/.test(body), "must validate the cached value before trusting it");
  assert.ok(/listDeviceImageIds/.test(body), "full listing must remain as the seed/fallback path");
});

t("publish uploads count failures and store the clean flag", () => {
  const body = grab(src, "publishSnapshot");
  assert.ok(/uploadFailures\+\+/.test(body), "upload failures must be counted (they used to vanish into console.error)");
  assert.ok(/_pwa_last_publish_clean.*uploadFailures === 0/.test(body) || /uploadFailures === 0/.test(body), "clean flag must reflect zero failures");
});

t("runSyncCycle surfaces peersSkipped + publishSkipped in its result", () => {
  const body = grab(src, "runSyncCycle");
  assert.ok(/peersSkipped/.test(body) && /publishSkipped/.test(body), "counters must flow to the persisted last-sync result");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
