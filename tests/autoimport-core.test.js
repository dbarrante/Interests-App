// tests/autoimport-core.test.js — core/autoimport.js: normalizeUrl, per-field
// caps, the platformKey ledger (incl. the 5000-key prune and the
// "deleted-in-app but ledger-blocked" invariant), and the capture-mailbox
// shape handed to the SAME queue /api/captures feeds (drainCaptures ingests
// it unchanged via cap.clip -> routeCapture action "saved").
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const { openDb, getKV, setKV, upsertCard, upsertSaved } = require("../core/db.js");
const autoimport = require("../core/autoimport.js");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); }
}
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-autoimport-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function readJsonKV(db, key) {
  const raw = getKV(db, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function item(over) {
  return Object.assign({ url: "https://example.com/post/1", title: "A post", image: "", platformKey: "pk1" }, over);
}

// --- normalizeUrl ---------------------------------------------------------

t("normalizeUrl: lowercases the host", () => {
  assert.strictEqual(autoimport.normalizeUrl("https://EXAMPLE.com/Path"), "https://example.com/Path");
});
t("normalizeUrl: strips the hash", () => {
  assert.strictEqual(autoimport.normalizeUrl("https://example.com/a#section"), "https://example.com/a");
});
t("normalizeUrl: strips utm_*, fbclid, igsh; keeps other query params", () => {
  const u = autoimport.normalizeUrl("https://example.com/a?utm_source=fb&utm_medium=x&fbclid=abc&igsh=xyz&keep=1");
  assert.strictEqual(u, "https://example.com/a?keep=1");
});
t("normalizeUrl: query-param order does not affect the result", () => {
  const a = autoimport.normalizeUrl("https://example.com/a?b=2&a=1");
  const b = autoimport.normalizeUrl("https://example.com/a?a=1&b=2");
  assert.strictEqual(a, b);
});
t("normalizeUrl: two URLs differing only by hash/tracking params normalize equal", () => {
  const a = autoimport.normalizeUrl("https://EXAMPLE.com/post/1?utm_source=ig#top");
  const b = autoimport.normalizeUrl("https://example.com/post/1");
  assert.strictEqual(a, b);
});
t("normalizeUrl: unparseable input is a safe passthrough, not a throw", () => {
  assert.strictEqual(autoimport.normalizeUrl("not a url"), "not a url");
  assert.strictEqual(autoimport.normalizeUrl(""), "");
  assert.strictEqual(autoimport.normalizeUrl(null), "");
});

// --- processBatch: structural validation ----------------------------------

t("processBatch: unknown platform -> status invalid, no kv side effects", () => {
  const db = openDb(tmpStore());
  const ctx = { db };
  const r = autoimport.processBatch(ctx, { platform: "tw", status: "ok", items: [item()], checkedAt: 1 });
  assert.deepStrictEqual(r, { added: 0, duplicates: 0, status: "invalid" });
  assert.strictEqual(getKV(db, "ia_autoimport_seen_tw"), null);
  assert.strictEqual(getKV(db, "ia_autoimport_last_tw"), null);
});

t("processBatch: non-array items -> status invalid", () => {
  const db = openDb(tmpStore());
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", items: "nope" });
  assert.deepStrictEqual(r, { added: 0, duplicates: 0, status: "invalid" });
});

t("processBatch: missing items defaults to an empty batch (not invalid)", () => {
  const db = openDb(tmpStore());
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok" });
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.added, 0);
});

// --- processBatch: fail-soft status handling --------------------------------

t("processBatch: status !== 'ok' imports nothing even if items are attached", () => {
  const db = openDb(tmpStore());
  const ctx = { db };
  const r = autoimport.processBatch(ctx, { platform: "fb", status: "login-required", items: [item()], checkedAt: 5 });
  assert.deepStrictEqual(r, { added: 0, duplicates: 0, status: "login-required" });
  const last = readJsonKV(db, "ia_autoimport_last_fb");
  assert.deepStrictEqual(last, { at: last.at, found: 0, added: 0, duplicates: 0, status: "login-required" });
  const queue = readJsonKV(db, "ia_capture_queue");
  assert.ok(!queue || !queue.length, "nothing queued");
});

// --- processBatch: happy path + capture-mailbox shape -----------------------

t("processBatch: happy path adds survivors to the SAME ia_capture_queue, shaped for drainCaptures", () => {
  const db = openDb(tmpStore());
  const ctx = { db };
  const batch = {
    platform: "fb", status: "ok", checkedAt: 1000,
    items: [
      { url: "https://facebook.com/posts/1", title: "  Post One  ", image: "data:image/png;base64,AAAA", platformKey: "fb_1" },
      { url: "https://facebook.com/posts/2", title: "Post Two", image: "", platformKey: "fb_2" },
    ],
  };
  const r = autoimport.processBatch(ctx, batch);
  assert.deepStrictEqual(r, { added: 2, duplicates: 0, status: "ok" });
  const queue = readJsonKV(db, "ia_capture_queue");
  assert.strictEqual(queue.length, 2);
  const c = queue[0];
  assert.strictEqual(c.url, "https://facebook.com/posts/1");
  assert.strictEqual(c.title, "Post One");             // trimmed
  assert.strictEqual(c.clipImage, "data:image/png;base64,AAAA");
  // REVIEW FIX 1: no clip flag — clip:true would force route-capture's
  // unconditional Saved path; `source` is the discriminator the renderer's
  // auto-import routing branch (Task 4) keys on.
  assert.ok(!c.clip, "survivors must NOT carry clip:true");
  assert.strictEqual(c.source, "fb-auto");
  assert.strictEqual(c.ts, 1000);
  const ledger = readJsonKV(db, "ia_autoimport_seen_fb");
  assert.strictEqual(ledger.fb_1, 1000);
  assert.strictEqual(ledger.fb_2, 1000);
  const last = readJsonKV(db, "ia_autoimport_last_fb");
  assert.deepStrictEqual(last, { at: last.at, found: 2, added: 2, duplicates: 0, status: "ok" });
});

t("processBatch: appends to an EXISTING ia_capture_queue rather than clobbering it", () => {
  const db = openDb(tmpStore());
  setKV(db, "ia_capture_queue", JSON.stringify([{ url: "https://manual.example/x", clip: true }]));
  autoimport.processBatch({ db }, { platform: "ig", status: "ok", checkedAt: 1, items: [item({ url: "https://ig.example/p1", platformKey: "ig_1" })] });
  const queue = readJsonKV(db, "ia_capture_queue");
  assert.strictEqual(queue.length, 2);
  assert.strictEqual(queue[0].url, "https://manual.example/x");
  assert.strictEqual(queue[1].url, "https://ig.example/p1");
});

// --- processBatch: ledger dedup (the permanent, deletion-proof guard) -------

t("processBatch: a second batch with the SAME platformKeys is fully ledger-blocked", () => {
  const db = openDb(tmpStore());
  const ctx = { db };
  const batch = { platform: "fb", status: "ok", checkedAt: 1, items: [item({ platformKey: "dup_1" })] };
  autoimport.processBatch(ctx, batch);
  const r2 = autoimport.processBatch(ctx, { platform: "fb", status: "ok", checkedAt: 2, items: [item({ platformKey: "dup_1" })] });
  assert.deepStrictEqual(r2, { added: 0, duplicates: 1, status: "ok" });
  const queue = readJsonKV(db, "ia_capture_queue");
  assert.strictEqual(queue.length, 1, "second batch's duplicate never reaches the mailbox");
});

t("processBatch: ledger blocks re-import even after the card is DELETED from the library " +
   "(platformKey alone blocks — URL presence is irrelevant once ledgered)", () => {
  const db = openDb(tmpStore());
  const ctx = { db };
  // Seed the ledger directly, as if this platformKey was imported and then the
  // resulting card was deleted from the app (no card/saved row exists with this URL).
  setKV(db, "ia_autoimport_seen_fb", JSON.stringify({ gone_1: 500 }));
  const r = autoimport.processBatch(ctx, { platform: "fb", status: "ok", checkedAt: 999, items: [item({ url: "https://facebook.com/deleted-post", platformKey: "gone_1" })] });
  assert.deepStrictEqual(r, { added: 0, duplicates: 1, status: "ok" });
});

t("processBatch: a NEW platformKey whose normalized URL already exists as a card is a duplicate " +
   "(URL is the secondary guard), and its key still gets ledgered", () => {
  const db = openDb(tmpStore());
  upsertCard(db, { url: "https://facebook.com/existing?utm_source=ig#x", title: "Existing card" });
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 42, items: [item({ url: "https://facebook.com/existing", platformKey: "new_key_1" })] });
  assert.deepStrictEqual(r, { added: 0, duplicates: 1, status: "ok" });
  const ledger = readJsonKV(db, "ia_autoimport_seen_fb");
  assert.strictEqual(ledger.new_key_1, 42, "the platformKey is still recorded even though it was a URL duplicate");
});

t("processBatch: URL dedup also matches an existing SAVED item", () => {
  const db = openDb(tmpStore());
  upsertSaved(db, { url: "https://instagram.com/p/xyz", title: "Existing saved clip" });
  const r = autoimport.processBatch({ db }, { platform: "ig", status: "ok", checkedAt: 1, items: [item({ url: "https://instagram.com/p/xyz", platformKey: "ig_dup" })] });
  assert.deepStrictEqual(r, { added: 0, duplicates: 1, status: "ok" });
});

// --- processBatch: per-field caps -------------------------------------------

t("processBatch: oversized image STRIPS the field but keeps the item (AMENDMENT — never reject for image size)", () => {
  const db = openDb(tmpStore());
  const bigImage = "data:image/png;base64," + "A".repeat(autoimport.CAPS.image + 10);
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 1, items: [item({ platformKey: "img_big", image: bigImage })] });
  assert.strictEqual(r.added, 1, "item survives an oversized image");
  const queue = readJsonKV(db, "ia_capture_queue");
  assert.strictEqual(queue[0].clipImage, "", "oversized image is stripped to empty, not truncated garbage");
});

t("processBatch: an image at exactly the cap is kept in full", () => {
  const db = openDb(tmpStore());
  const prefix = "data:image/png;base64,";
  const okImage = prefix + "B".repeat(autoimport.CAPS.image - prefix.length);
  assert.strictEqual(okImage.length, autoimport.CAPS.image);
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 1, items: [item({ platformKey: "img_exact", image: okImage })] });
  assert.strictEqual(r.added, 1);
  const queue = readJsonKV(db, "ia_capture_queue");
  assert.strictEqual(queue[0].clipImage, okImage);
});

t("processBatch: oversized url DROPS the item entirely (never truncated — a cut URL points elsewhere)", () => {
  const db = openDb(tmpStore());
  const bigUrl = "https://example.com/" + "a".repeat(autoimport.CAPS.url + 10);
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 1, items: [item({ url: bigUrl, platformKey: "url_big" })] });
  assert.deepStrictEqual(r, { added: 0, duplicates: 0, status: "ok" });
  assert.strictEqual(getKV(db, "ia_capture_queue"), null);
  const ledger = readJsonKV(db, "ia_autoimport_seen_fb");
  assert.ok(!ledger || !ledger.url_big, "an invalid item never reaches the ledger either");
});

t("processBatch: oversized platformKey DROPS the item (a truncated key risks colliding with another post)", () => {
  const db = openDb(tmpStore());
  const bigKey = "k".repeat(autoimport.CAPS.platformKey + 1);
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 1, items: [item({ platformKey: bigKey })] });
  assert.deepStrictEqual(r, { added: 0, duplicates: 0, status: "ok" });
});

t("processBatch: missing platformKey or non-http url DROPS the item", () => {
  const db = openDb(tmpStore());
  const r = autoimport.processBatch({ db }, {
    platform: "fb", status: "ok", checkedAt: 1,
    items: [item({ platformKey: "" }), item({ url: "javascript:alert(1)", platformKey: "bad_scheme" })],
  });
  assert.deepStrictEqual(r, { added: 0, duplicates: 0, status: "ok" });
});

t("processBatch: oversized title is TRUNCATED (item kept)", () => {
  const db = openDb(tmpStore());
  const bigTitle = "T".repeat(autoimport.CAPS.title + 50);
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 1, items: [item({ platformKey: "title_big", title: bigTitle })] });
  assert.strictEqual(r.added, 1);
  const queue = readJsonKV(db, "ia_capture_queue");
  assert.strictEqual(queue[0].title.length, autoimport.CAPS.title);
});

t("processBatch: >200 items REJECTS the whole batch as invalid (review adjudication — no truncate-and-continue)", () => {
  const db = openDb(tmpStore());
  const items = [];
  for (let i = 0; i < autoimport.MAX_ITEMS + 5; i++) items.push(item({ url: "https://example.com/p/" + i, platformKey: "pk_" + i }));
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 1, items });
  assert.deepStrictEqual(r, { added: 0, duplicates: 0, status: "invalid" });
  assert.strictEqual(getKV(db, "ia_capture_queue"), null, "nothing queued");
  assert.strictEqual(getKV(db, "ia_autoimport_seen_fb"), null, "nothing ledgered");
  assert.strictEqual(getKV(db, "ia_autoimport_last_fb"), null, "no status record for a rejected batch");
});

t("processBatch: exactly 200 items is accepted", () => {
  const db = openDb(tmpStore());
  const items = [];
  for (let i = 0; i < autoimport.MAX_ITEMS; i++) items.push(item({ url: "https://example.com/p/" + i, platformKey: "pk_" + i }));
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 1, items });
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(r.added, autoimport.MAX_ITEMS);
});

// --- ledger hardening: "__proto__" as a platformKey ------------------------

t("processBatch: a '__proto__' platformKey is RECORDED in the ledger and blocks its second delivery", () => {
  const db = openDb(tmpStore());
  const ctx = { db };
  const r1 = autoimport.processBatch(ctx, { platform: "fb", status: "ok", checkedAt: 7, items: [item({ url: "https://facebook.com/proto-post", platformKey: "__proto__" })] });
  assert.deepStrictEqual(r1, { added: 1, duplicates: 0, status: "ok" });
  const ledger = readJsonKV(db, "ia_autoimport_seen_fb");
  assert.ok(Object.prototype.hasOwnProperty.call(ledger, "__proto__"), "'__proto__' persisted as an OWN ledger key");
  assert.strictEqual(ledger["__proto__"], 7);
  const r2 = autoimport.processBatch(ctx, { platform: "fb", status: "ok", checkedAt: 8, items: [item({ url: "https://facebook.com/proto-post-2", platformKey: "__proto__" })] });
  assert.deepStrictEqual(r2, { added: 0, duplicates: 1, status: "ok" }, "second '__proto__' delivery is ledger-blocked");
});

// --- processBatch: ledger 5000-key cap, prune oldest ------------------------

t("processBatch: ledger prunes to 5000 keys, oldest firstSeenMs dropped first", () => {
  const db = openDb(tmpStore());
  const seeded = {};
  for (let i = 0; i < autoimport.LEDGER_CAP; i++) seeded["old_" + i] = i;   // firstSeenMs 0..4999, ascending
  setKV(db, "ia_autoimport_seen_fb", JSON.stringify(seeded));
  const r = autoimport.processBatch({ db }, { platform: "fb", status: "ok", checkedAt: 999999, items: [item({ url: "https://example.com/new", platformKey: "brand_new" })] });
  assert.strictEqual(r.added, 1);
  const ledger = readJsonKV(db, "ia_autoimport_seen_fb");
  assert.strictEqual(Object.keys(ledger).length, autoimport.LEDGER_CAP, "stays capped at 5000");
  assert.ok(ledger.brand_new, "the new key survives the prune");
  assert.ok(!("old_0" in ledger), "the very oldest key was pruned");
  assert.ok("old_1" in ledger, "only exactly enough oldest keys are pruned to make room");
});

// --- getConfig / getStatus ---------------------------------------------------

t("getConfig: defaults off, both platforms on, when ia_settings is absent", () => {
  const db = openDb(tmpStore());
  assert.deepStrictEqual(autoimport.getConfig({ db }), { on: false, platforms: { fb: true, ig: true } });
});

t("getConfig: reads autoImportOn/autoImportFb/autoImportIg from the ia_settings JSON blob", () => {
  const db = openDb(tmpStore());
  setKV(db, "ia_settings", JSON.stringify({ autoImportOn: true, autoImportFb: false }));
  assert.deepStrictEqual(autoimport.getConfig({ db }), { on: true, platforms: { fb: false, ig: true } });
});

t("getStatus: null for a platform with no run yet; reflects the last processBatch record after one", () => {
  const db = openDb(tmpStore());
  assert.deepStrictEqual(autoimport.getStatus({ db }), { fb: null, ig: null });
  autoimport.processBatch({ db }, { platform: "ig", status: "ok", checkedAt: 1, items: [item({ url: "https://instagram.com/p/1", platformKey: "s1" })] });
  const status = autoimport.getStatus({ db });
  assert.strictEqual(status.fb, null);
  assert.strictEqual(status.ig.added, 1);
});

console.log("autoimport-core: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
