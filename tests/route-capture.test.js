const assert = require("assert");
const { routeCapture } = require("../web/route-capture");

// Simple stand-in helpers (same shape as the app's).
const normalizeUrl = (u) => (u || "").split("#")[0].replace(/\/+$/, "").toLowerCase();
const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
const base = (extra) => Object.assign({ imported: [], lastOpened: null, now: 1000000, normalizeUrl, domain }, extra || {});

let pass = 0, fail = 0;
function t(n, f) { try { f(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }

t("clip -> saved even when its url matches an imported card", () => {
  const imported = [{ id: "a", url: "https://www.pinterest.com/pin/1/" }];
  const r = routeCapture({ clip: true, url: "https://www.pinterest.com/pin/1/" }, base({ imported }));
  assert.strictEqual(r.action, "saved");
});
t("dead -> dead", () => assert.strictEqual(routeCapture({ dead: true, url: "x" }, base()).action, "dead"));
t("no url -> skip", () => assert.strictEqual(routeCapture({}, base()).action, "skip"));
t("non-clip id match -> card-image(target)", () => {
  const imported = [{ id: "a", url: "u1" }];
  const r = routeCapture({ id: "a", url: "u2" }, base({ imported }));
  assert.strictEqual(r.action, "card-image"); assert.strictEqual(r.target.id, "a");
});
t("non-clip exact url -> card-image", () => {
  const imported = [{ id: "a", url: "https://x.com/p" }];
  assert.strictEqual(routeCapture({ url: "https://x.com/p" }, base({ imported })).action, "card-image");
});
t("non-clip normalized url -> card-image", () => {
  const imported = [{ id: "a", url: "https://x.com/p/" }];
  assert.strictEqual(routeCapture({ url: "https://x.com/p" }, base({ imported })).action, "card-image");
});
t("non-clip same-domain recent active card -> card-image", () => {
  const imported = [{ id: "a", url: "https://x.com/home" }];
  const r = routeCapture({ url: "https://x.com/other" }, base({ imported, lastOpened: { id: "a", ts: 999000 } }));
  assert.strictEqual(r.action, "card-image"); assert.strictEqual(r.target.id, "a");
});
t("BUG GUARD: different-domain active card -> unmatched (never the wrong card)", () => {
  const imported = [{ id: "sg", url: "https://www.pinterest.com/pin/728/" }];
  const r = routeCapture({ url: "https://www.youtube.com/watch?v=z" }, base({ imported, lastOpened: { id: "sg", ts: 999000 } }));
  assert.strictEqual(r.action, "unmatched");
});
t("empty domain on both sides -> unmatched (no '' === '' match)", () => {
  const imported = [{ id: "a", url: "not a url" }];
  const r = routeCapture({ url: "also not a url" }, base({ imported, lastOpened: { id: "a", ts: 999000 } }));
  assert.strictEqual(r.action, "unmatched");
});
t("stale active card -> unmatched", () => {
  const imported = [{ id: "a", url: "https://x.com/h" }];
  const r = routeCapture({ url: "https://x.com/o" }, base({ imported, lastOpened: { id: "a", ts: 0 } }));
  assert.strictEqual(r.action, "unmatched");
});
t("force manual capture, no card -> saved", () => {
  assert.strictEqual(routeCapture({ force: true, url: "https://x.com/p" }, base()).action, "saved");
});
t("clip + recent recapTarget (id in imported) -> card-image(target) [heal, url need not match]", () => {
  const imported = [{ id: "f1", url: "https://fatpita.net/?i=1" }];
  const r = routeCapture({ clip: true, url: "https://fatpita.net/?i=9999" }, base({ imported, recapTarget: { id: "f1", ts: 999000 } }));
  assert.strictEqual(r.action, "card-image"); assert.strictEqual(r.target.id, "f1");
});
t("clip + NO recapTarget -> saved (unchanged)", () => {
  const imported = [{ id: "f1", url: "https://x.com/p" }];
  assert.strictEqual(routeCapture({ clip: true, url: "https://x.com/p" }, base({ imported })).action, "saved");
});
t("clip + EXPIRED recapTarget -> saved", () => {
  const imported = [{ id: "f1", url: "https://x.com/p" }];
  const r = routeCapture({ clip: true, url: "https://x.com/p" }, base({ imported, recapTarget: { id: "f1", ts: 0 } }));
  assert.strictEqual(r.action, "saved");
});
t("clip + recapTarget id NOT in imported -> saved", () => {
  const imported = [{ id: "other", url: "https://x.com/p" }];
  const r = routeCapture({ clip: true, url: "https://x.com/p" }, base({ imported, recapTarget: { id: "gone", ts: 999000 } }));
  assert.strictEqual(r.action, "saved");
});
t("dead + recapTarget still -> dead (Remove unaffected)", () => {
  const r = routeCapture({ dead: true, url: "x" }, base({ recapTarget: { id: "f1", ts: 999000 } }));
  assert.strictEqual(r.action, "dead");
});

// --- Auto-import routing (Task 4) ---------------------------------------
t("fb-auto source -> import-auto", () => {
  const r = routeCapture({ url: "https://www.facebook.com/permalink/1", source: "fb-auto", title: "A post", ts: 5000 }, base());
  assert.strictEqual(r.action, "import-auto");
});
t("ig-auto source -> import-auto", () => {
  const r = routeCapture({ url: "https://www.instagram.com/p/abc/", source: "ig-auto" }, base());
  assert.strictEqual(r.action, "import-auto");
});
t("PRECEDENCE (binding, task-3 carry-forward): -auto capture with a matching OPEN active card still routes import-auto, never card-image", () => {
  const imported = [{ id: "a", url: "https://www.facebook.com/permalink/1" }];
  const r = routeCapture(
    { url: "https://www.facebook.com/permalink/1", source: "fb-auto" },
    base({ imported, lastOpened: { id: "a", ts: 999000 } })
  );
  assert.strictEqual(r.action, "import-auto");
});
t("PRECEDENCE: -auto capture carrying clip-like fields (clip:true, force:true) still routes import-auto, not saved", () => {
  const r = routeCapture({ url: "https://www.instagram.com/p/xyz/", source: "ig-auto", clip: true, force: true }, base());
  assert.strictEqual(r.action, "import-auto");
});
t("PRECEDENCE: -auto capture matching an imported card by exact id still routes import-auto, not card-image", () => {
  const imported = [{ id: "a", url: "https://www.facebook.com/permalink/1" }];
  const r = routeCapture({ id: "a", url: "https://www.facebook.com/permalink/1", source: "fb-auto" }, base({ imported }));
  assert.strictEqual(r.action, "import-auto");
});
t("PRECEDENCE: -auto capture matching a live recapTarget still routes import-auto, not the heal card-image", () => {
  const imported = [{ id: "f1", url: "https://www.facebook.com/permalink/1" }];
  const r = routeCapture(
    { url: "https://www.facebook.com/permalink/1", source: "fb-auto" },
    base({ imported, recapTarget: { id: "f1", ts: 999000 } })
  );
  assert.strictEqual(r.action, "import-auto");
});
t("non-auto source (undefined/plain) is unaffected -> falls through to normal routing", () => {
  const r = routeCapture({ url: "https://x.com/p", source: "manual" }, base());
  assert.strictEqual(r.action, "unmatched");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
