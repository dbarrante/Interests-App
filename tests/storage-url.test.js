const assert = require("assert");
const { SE } = require("../web/storage.js");

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; console.log("  ok  " + name); } catch(e){ fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("imgUrl(id) is /api/img/ + id (the load-bearing rule)", () => {
  assert.strictEqual(SE.imgUrl("abc123"), "/api/img/" + "abc123");
});
t("imgUrl handles an empty id", () => {
  assert.strictEqual(SE.imgUrl(""), "/api/img/");
});
t("kv encodes the key", () => {
  assert.strictEqual(SE.kv("ia_settings"), "/api/kv/ia_settings");
  assert.strictEqual(SE.kv("a b"), "/api/kv/a%20b");
});
t("cards endpoints", () => {
  assert.strictEqual(SE.cards(), "/api/cards");
  assert.strictEqual(SE.card("id-1"), "/api/cards/id-1");
});
t("saved endpoints", () => {
  assert.strictEqual(SE.saved(), "/api/saved");
  assert.strictEqual(SE.savedItem("s9"), "/api/saved/s9");
});
t("fp endpoints", () => {
  assert.strictEqual(SE.fp(), "/api/fp");
  assert.strictEqual(SE.fpItem("c4"), "/api/fp/c4");
});
t("capture + batch endpoints", () => {
  assert.strictEqual(SE.captures(), "/api/captures");
  assert.strictEqual(SE.captureRequest(), "/api/capture-request");
  assert.strictEqual(SE.batchState(), "/api/batch-state");
  assert.strictEqual(SE.batchProgress(), "/api/batch-progress");
});
t("backup/restore/store/import endpoints", () => {
  assert.strictEqual(SE.backup(), "/api/backup");
  assert.strictEqual(SE.backups(), "/api/backups");
  assert.strictEqual(SE.restore(), "/api/restore");
  assert.strictEqual(SE.storeLocation(), "/api/store-location");
  assert.strictEqual(SE.storeMove(), "/api/store-location/move");
  assert.strictEqual(SE.import(), "/api/import");
});
t("check-content endpoint", () => {
  assert.strictEqual(SE.checkContent(), "/api/check-content");
});
t("capture-meta endpoint", () => {
  assert.strictEqual(SE.captureMeta(), "/api/capture-meta");
});
t("safety endpoints", () => {
  assert.strictEqual(SE.checkSafety(), "/api/check-safety");
  assert.strictEqual(SE.safeBrowsingKey(), "/api/safebrowsing-key");
});
t("Store is NOT exported to Node (browser-only); SE still is", () => {
  const mod = require("../web/storage.js");
  assert.ok(mod.SE, "SE must be exported for Node tests");
  assert.strictEqual(mod.Store, undefined, "Store must remain browser-only (uses fetch)");
});
t("browser-stumble endpoint builders", () => {
  assert.strictEqual(SE.categories(), "/api/categories");
  assert.strictEqual(SE.bstumbleRequest(), "/api/bstumble/request");
  assert.strictEqual(SE.bstumbleResults(), "/api/bstumble/results");
  assert.strictEqual(SE.bstumbleFeedback(), "/api/bstumble/feedback");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
