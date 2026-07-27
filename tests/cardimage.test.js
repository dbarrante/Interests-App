// tests/cardimage.test.js — the card-id-keyed, SSRF-guarded server-side image fetch.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cardimg-"));

const { openDb, upsertCard, upsertSaved } = require("../core/db.js");
const linkcheck = require("../core/linkcheck.js");
const cardimage = require("../core/cardimage.js");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function newDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cardimg-store-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return openDb(dir);
}
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
function okFetch(buf, ct) {
  return async function () {
    return { error: null, status: 200, buffer: buf, location: null,
             res: { headers: { get: (k) => (k.toLowerCase() === "content-type" ? ct : null) } } };
  };
}
// A resolver stub for tests whose hostname ("cdn.example.com" etc.) doesn't need to
// resolve to anything specific — it just needs to resolve, to a public address, now that
// the fail-closed DNS check runs unconditionally (see IMPORTANT 1 in the task brief).
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

(async function () {
  await t("an unknown id is refused without fetching anything", async () => {
    const db = newDb();
    let called = false;
    const r = await cardimage.fetchCardImage(db, "nope", { fetchFn: async () => { called = true; } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "not-found");
    assert.strictEqual(called, false, "must not perform any network call for an unknown card");
    db.close();
  });

  await t("a card with no remote image is refused without fetching", async () => {
    const db = newDb();
    upsertCard(db, { id: "c1", url: "https://x/1", img: "idb:c1" });   // local image, no img_url
    let called = false;
    const r = await cardimage.fetchCardImage(db, "c1", { fetchFn: async () => { called = true; } });
    assert.strictEqual(r.reason, "no-remote-image");
    assert.strictEqual(called, false);
    db.close();
  });

  await t("a saved item's remote image is found too (not just cards)", async () => {
    const db = newDb();
    upsertSaved(db, { id: "s1", url: "https://x/s1", image: "https://cdn.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "s1", { lookup: publicLookup, fetchFn: okFetch(PNG, "image/png") });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.contentType, "image/png");
    db.close();
  });

  await t("a stored URL pointing at a blocked address is refused", async () => {
    const db = newDb();
    upsertCard(db, { id: "c2", url: "https://x/2", img: "https://127.0.0.1/a.png" });
    let called = false;
    const r = await cardimage.fetchCardImage(db, "c2", { fetchFn: async () => { called = true; } });
    assert.strictEqual(r.reason, "blocked", "a stored URL is still untrusted — imports come from third-party pages");
    assert.strictEqual(called, false);
    db.close();
  });

  await t("http:// is refused — https only", async () => {
    const db = newDb();
    upsertCard(db, { id: "c3", url: "https://x/3", img: "http://cdn.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "c3", { fetchFn: okFetch(PNG, "image/png") });
    assert.strictEqual(r.reason, "blocked");
    db.close();
  });

  await t("a public name that resolves to loopback is refused (DNS rebinding)", async () => {
    const db = newDb();
    upsertCard(db, { id: "c4", url: "https://x/4", img: "https://evil.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "c4", {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchFn: okFetch(PNG, "image/png"),
    });
    assert.strictEqual(r.reason, "blocked");
    db.close();
  });

  await t("a name with one public AND one private record is refused", async () => {
    const db = newDb();
    upsertCard(db, { id: "c5", url: "https://x/5", img: "https://mixed.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "c5", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
      fetchFn: okFetch(PNG, "image/png"),
    });
    assert.strictEqual(r.reason, "blocked", "ANY private record must block, not just the first");
    db.close();
  });

  await t("DNS resolution failure fails CLOSED here (unlike link probing)", async () => {
    const db = newDb();
    upsertCard(db, { id: "c6", url: "https://x/6", img: "https://gone.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "c6", {
      lookup: async () => { throw new Error("ENOTFOUND"); },
      fetchFn: okFetch(PNG, "image/png"),
    });
    assert.strictEqual(r.reason, "blocked",
      "safeToFetch lets probing continue on an unresolved name; an image fetch must not");
    db.close();
  });

  await t("a non-image content type is refused", async () => {
    const db = newDb();
    upsertCard(db, { id: "c7", url: "https://x/7", img: "https://cdn.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "c7", { lookup: publicLookup, fetchFn: okFetch(Buffer.from("<html>"), "text/html") });
    assert.strictEqual(r.reason, "not-an-image");
    db.close();
  });

  await t("image/svg+xml is refused (raster-only allowlist) while image/png is accepted", async () => {
    // SVG is an active document format (can carry <script>), not a raster image the
    // decode path (OCR / vision / phash) needs. The gate must be an allowlist of raster
    // types, not a broad image/* test — pins the fix for review finding 1.
    const db = newDb();
    upsertCard(db, { id: "csvg", url: "https://x/svg", img: "https://cdn.example.com/a.svg" });
    upsertCard(db, { id: "craster", url: "https://x/raster", img: "https://cdn.example.com/a.png" });
    const svgR = await cardimage.fetchCardImage(db, "csvg", {
      lookup: publicLookup, fetchFn: okFetch(Buffer.from("<svg onload=\"alert(1)\"></svg>"), "image/svg+xml"),
    });
    assert.strictEqual(svgR.reason, "not-an-image", "svg must be refused, and with the SAME reason as any other non-raster type");
    const pngR = await cardimage.fetchCardImage(db, "craster", { lookup: publicLookup, fetchFn: okFetch(PNG, "image/png") });
    assert.strictEqual(pngR.ok, true);
    assert.strictEqual(pngR.contentType, "image/png");
    db.close();
  });

  await t("a 404 with a non-empty body is refused as fetch-failed (not not-an-image)", async () => {
    // The empty-body variant of "fetch-failed" was already covered (below); this covers
    // the terminal non-2xx branch, which a non-empty body never exercised before.
    const db = newDb();
    upsertCard(db, { id: "c404", url: "https://x/404", img: "https://cdn.example.com/gone.png" });
    const r = await cardimage.fetchCardImage(db, "c404", {
      lookup: publicLookup,
      fetchFn: async () => ({
        error: null, status: 404, buffer: Buffer.from("not found"), location: null,
        res: { headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/plain" : null) } },
      }),
    });
    assert.strictEqual(r.reason, "fetch-failed");
    db.close();
  });

  await t("a body over MAX_BYTES is refused as too-large (through the real default fetchFn, not a stub)", async () => {
    // Regression guard for the "maxBytes: MAX_BYTES + 1" fix: drainCapped (guardedfetch.js)
    // truncates the body to whatever cap it's given, so if fetchCardImage passed exactly
    // MAX_BYTES, buf.length could never exceed MAX_BYTES and "too-large" would be
    // unreachable. Deliberately does NOT pass opts.fetchFn — followRedirects calls
    // fetchFn(target) with no opts, so an opts.fetchFn stub can never observe (or be
    // sensitive to) the maxBytes value fetchCardImage decides to use. Only going through
    // the real default fetchFn -> gf.fetchOnceGuarded -> drainCapped exercises that value.
    const db = newDb();
    upsertCard(db, { id: "ctoolarge", url: "https://x/big", img: "https://cdn.example.com/big.png" });
    const realFetch = global.fetch;
    global.fetch = async () => ({
      status: 200, url: "https://cdn.example.com/big.png",
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => new Uint8Array(cardimage.MAX_BYTES + 1000).buffer,
    });
    try {
      const r = await cardimage.fetchCardImage(db, "ctoolarge", { lookup: publicLookup });
      assert.strictEqual(r.reason, "too-large");
    } finally {
      global.fetch = realFetch;
    }
    db.close();
  });

  await t("an empty body is refused", async () => {
    const db = newDb();
    upsertCard(db, { id: "c8", url: "https://x/8", img: "https://cdn.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "c8", { lookup: publicLookup, fetchFn: okFetch(Buffer.alloc(0), "image/png") });
    assert.strictEqual(r.reason, "fetch-failed");
    db.close();
  });

  await t("a redirect to a blocked address is not followed", async () => {
    // Regression guard for a test that used to be unable to fail: the original version
    // redirected to a literal "https://127.0.0.1/..." address, which isProbableHost()
    // rejects on the STRING alone (no DNS involved) — so it passed whether or not
    // followRedirects() actually re-validated each hop with safeToFetch's lookup. This
    // version redirects to a DOMAIN NAME whose "privateness" is only knowable via the
    // per-call lookup stub, so it can only pass if that stub is genuinely threaded
    // through to the redirect-hop check, not just to the first-hop check.
    const db = newDb();
    upsertCard(db, { id: "c9", url: "https://x/9", img: "https://cdn.example.com/a.png" });
    let hops = 0;
    const lookup = async (host) => {
      // The redirect target resolves private; the initial host resolves public — so
      // blocking only happens if the redirect hop's host is re-resolved and re-checked.
      if (host === "redirect-target.invalid") return [{ address: "127.0.0.1", family: 4 }];
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const r = await cardimage.fetchCardImage(db, "c9", {
      lookup,
      fetchFn: async (target) => {
        hops++;
        if (hops === 1) return { error: null, status: 302, location: "https://redirect-target.invalid/evil.png", buffer: null, res: null };
        throw new Error("must not fetch the redirect target");
      },
    });
    assert.strictEqual(r.ok, false, "a 30x into a blocked host must not produce bytes");
    assert.strictEqual(r.reason, "blocked", "the redirect target's host must be re-validated, not just the initial host");
    assert.strictEqual(hops, 1, "the redirect target must never actually be fetched once its host is blocked");
    db.close();
  });

  await t("an unresolvable hostname is refused even when the caller passes no lookup stub", async () => {
    const db = newDb();
    upsertCard(db, { id: "cdns", url: "https://x/dns", img: "https://definitely-not-a-real-host.invalid/a.png" });
    let called = false;
    const r = await cardimage.fetchCardImage(db, "cdns", { fetchFn: async () => { called = true; } });
    assert.strictEqual(r.reason, "blocked", "the fail-closed DNS check must not depend on the caller opting in");
    assert.strictEqual(called, false, "nothing may be fetched when the destination can't be resolved");
    db.close();
  });

  await t("_setLookup reaches fetchCardImage, so in-process endpoint tests can stub DNS", async () => {
    const db = newDb();
    upsertCard(db, { id: "cseam", url: "https://x/seam", img: "https://seam.invalid/a.png" });
    const lc = require("../core/linkcheck.js");
    // Polarity inverted vs. a "blocked" assertion on purpose: "seam.invalid" never resolves via
    // real DNS (RFC 2606), so "blocked" can't distinguish a working seam from a plain lookup
    // failure — the real resolver ALSO reports blocked for this host. Instead the module stub
    // returns a PUBLIC address, which only lets the fetch through if fetchCardImage's default
    // resolver really is linkcheck._getLookup() (this stub), not a fresh require("dns") lookup.
    lc._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);   // module-wide stub, NO opts.lookup
    try {
      const r = await cardimage.fetchCardImage(db, "cseam", { fetchFn: okFetch(PNG, "image/png") });
      assert.strictEqual(r.ok, true, "the module-wide resolver stub must be honoured, not bypassed for a fresh dns lookup");
      assert.strictEqual(r.contentType, "image/png");
    } finally { lc._setLookup(null); }
    db.close();
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
