// tests/pwa-image-ondemand.test.js — on-demand images: source map upkeep,
// idb-first fetcher with coalescing + 4-way cap, and both Store layers
// exposing ensureImage. Spec: docs/superpowers/specs/2026-07-17-on-demand-images-design.md
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

t("runSyncCycle maintains _pwa_image_sources: read peers replace their own entries over the stored map", () => {
  const body = grab(src, "runSyncCycle");
  assert.ok(/_pwa_image_sources/.test(body), "must persist the source map");
  assert.ok(/p\.imageSizes/.test(body), "must consume per-peer sizes");
  // read-peer entries replace that peer's prior entries; other dirs' entries survive
  assert.ok(/\.dir !== p\.dir|dir: p\.dir/.test(body), "entries must be keyed to the owning peer dir");
});

t("ensureImage: idb hit short-circuits; miss consults the map then downloads, caches, coalesces", () => {
  const body = grab(src, "ensureImage");
  const idbIdx = body.indexOf('idb.get("images"');
  const mapIdx = body.indexOf("_pwa_image_sources");
  const dlIdx = body.indexOf("dbxDownloadBinary");
  assert.ok(idbIdx >= 0 && mapIdx > idbIdx && dlIdx > mapIdx, "order must be idb -> map -> download");
  assert.ok(/dbxDownloadBinary\(null,/.test(body), "token resolved internally — pass null");
  assert.ok(/idb\.put\("images"/.test(body), "downloaded bytes must be cached");
  assert.ok(/sniffImageType/.test(body), "must sniff the real type");
  assert.ok(/_imgInFlight/.test(src), "duplicate requests for one id must coalesce on one promise");
  assert.ok(/_IMG_FETCH_LIMIT = 4|_imgFetchActive/.test(src), "downloads must be concurrency-capped");
});

t("ensureImage never throws to the renderer: all failure paths resolve false", () => {
  const body = grab(src, "ensureImage");
  assert.ok(!/throw /.test(body), "no throws — a missing image is a placeholder, not an error");
  assert.ok(/return false|resolve\(false\)|=> false/.test(body), "failures resolve false");
});

t("both Store layers expose ensureImage (desktop = always-true shim)", () => {
  const pwaStore = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");
  assert.ok(/ensureImage\(id\)/.test(pwaStore) && /IASync\.ensureImage/.test(pwaStore), "pwa Store must delegate to IASync");
  const webStore = fs.readFileSync(path.join(__dirname, "..", "web", "storage.js"), "utf8");
  assert.ok(/ensureImage/.test(webStore), "web Store needs the shim so shared renderer code can call it unconditionally");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
