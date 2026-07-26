# Remote-image fetch + image-based duplicate detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI title pipeline read Pinterest (remote-URL) card images so those cards stop showing `(untitled)`, and add image-similarity as a second, review-only duplicate-matching pass.

**Architecture:** A new Core route fetches a card's remote image **server-side** (no CORS), taking a **card id** rather than a URL so a caller can never name a destination. It composes the SSRF guards that already exist in `core/linkcheck.js` + `core/guardedfetch.js` — the same ones `capturemeta._fetchImageDataUrl` already uses. On top of that, a 64-bit dHash per card image feeds a second duplicate pass that runs only over cards the existing URL/title pass did not group, rendered unchecked behind a badge.

**Tech Stack:** Node 22+ (`node:sqlite`), Express, plain-`assert` test scripts, vanilla browser JS (no bundler), `OffscreenCanvas` for image decode/hash.

## Global Constraints

- Backend code under `core/` is **CommonJS**, directly `require()`-able from tests.
- Tests are **plain Node `assert` scripts**, run via `node tests/<name>.test.js`; `node tests/run.js` runs the syntax gate + all `*.test.js`.
- `web/index.html` and `pwa/index.html` must stay **byte-identical for shared functions** — several existing tests enforce this, and any new shared function must match. **One deliberate exception:** `resolveCardImageForAI` diverges in Task 4, because the PWA has no Core service and falls back to the `allorigins` proxy. No existing test asserts byte-parity on that function; do not converge it.
- Every inline `<script>` must keep parsing: `node tests/syntax-check.js`.
- **Never** edit shipped HTML by generating code through nested shell/Python string layers. Use the `Edit` tool against exact strings. Two files were corrupted with literal backspace bytes that way. After editing, scan: `[\x00-\x08\x0b\x0c\x0e-\x1f]` must be 0 in both HTML files.
- Any edit to `pwa/index.html` requires a `SHELL_CACHE` bump in `pwa/sw.js` before release.
- Tests must never touch the real store: isolate `process.env.APPDATA` to a temp dir **before** requiring `core/config` or `core/backup`.
- Image-duplicate matching is **strict** and its groups are **never auto-checked** — the outcome is deletion.
- Commit message trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## What already exists (do not rebuild)

| Need | Already in the repo |
|---|---|
| Scheme allowlist, `localhost`/`.local` reject, numeric-host encodings (`2130706433`, `0x7f000001`) reject | `core/linkcheck.js` `isProbableHost` |
| Private/loopback/link-local/IPv4-mapped-IPv6 ranges | `core/linkcheck.js` `isPrivateAddr` |
| DNS resolve-**all**-records, block if any private | `core/linkcheck.js` `safeToFetch` |
| Test DNS stubbing | `core/linkcheck.js` `setLookup(fn)` |
| Per-hop redirect re-validation, hop cap | `core/guardedfetch.js` `followRedirects` |
| Timeout + byte cap + body drain | `core/guardedfetch.js` `fetchOnceGuarded` |
| Server-side image fetch returning a data URL | `core/capturemeta.js` `_fetchImageDataUrl` |

**Three real gaps, closed by Task 1 and Task 2:**
1. `isPrivateAddr` omits CGNAT `100.64/10`, multicast `224/4`, reserved `240/4`, `192.0.0/24`, benchmark `198.18/15`, and IPv6 `2002::/16` (6to4) / `64:ff9b::/96` (NAT64), which can wrap a blocked IPv4.
2. `safeToFetch` returns **true** on DNS resolution failure (deliberate for link-probing: let the real fetch surface `ENOTFOUND`). For an image fetch that is fail-open; Task 2 passes a flag to fail closed.
3. **TOCTOU / connect-time pinning.** `safeToFetch` validates by hostname, then `fetch` re-resolves at connect time. A resolver that flips between the two lookups still lands on loopback. This is pre-existing across the whole app; Task 2 does **not** fix it (that is an app-wide change) but **records it** so the security review sees it named rather than missed.

## File structure

| File | Responsibility |
|---|---|
| `core/linkcheck.js` *(modify)* | `isPrivateAddr` gains the missing ranges. Benefits every existing caller. |
| `core/cardimage.js` *(create)* | Resolve a card id → its remote image URL → guarded server-side fetch → bytes. One job; no HTTP concerns. |
| `core/server.js` *(modify)* | `POST /api/fetch-card-image` — thin route over `core/cardimage.js`. |
| `web/imagehash.js` *(create)* | Pure dHash + Hamming, dual-exported (browser global + CommonJS for tests). No DOM. |
| `web/index.html`, `pwa/index.html` *(modify)* | Client wiring: route remote images through the endpoint; hash cache + scan; image-dupe pass; Duplicates UI. |
| `tests/*.test.js` *(create)* | One test file per new unit. |

---

### Task 1: Close the `isPrivateAddr` range gaps

**Files:**
- Modify: `core/linkcheck.js` (function `isPrivateAddr`, ~line 41)
- Test: `tests/linkcheck.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `isPrivateAddr(ip: string) -> boolean`, unchanged signature, now blocking more ranges. Already exported.

- [ ] **Step 1: Write the failing test**

Append to `tests/linkcheck.test.js` (match the file's existing `t(...)` helper style):

```js
t("isPrivateAddr blocks CGNAT, multicast, reserved and special-purpose IPv4", () => {
  // Ranges an SSRF guard must refuse that the original list omitted.
  for (const ip of ["100.64.0.1", "100.127.255.255", "224.0.0.1", "239.255.255.255",
                    "240.0.0.1", "255.255.255.255", "192.0.0.1", "198.18.0.1", "198.19.255.255"]) {
    assert.strictEqual(linkcheck.isPrivateAddr(ip), true, ip + " must be blocked");
  }
  // Public addresses next to those ranges must still pass.
  for (const ip of ["100.63.255.255", "100.128.0.1", "223.255.255.255", "192.0.1.1", "198.17.255.255", "198.20.0.1"]) {
    assert.strictEqual(linkcheck.isPrivateAddr(ip), false, ip + " must stay allowed");
  }
});

t("isPrivateAddr blocks IPv6 forms that can wrap a private IPv4", () => {
  // 6to4 (2002::/16) and NAT64 (64:ff9b::/96) encapsulate an IPv4 address.
  assert.strictEqual(linkcheck.isPrivateAddr("2002:7f00:0001::1"), true, "6to4 wrapping 127.0.0.1");
  assert.strictEqual(linkcheck.isPrivateAddr("64:ff9b::7f00:1"), true, "NAT64 wrapping 127.0.0.1");
  assert.strictEqual(linkcheck.isPrivateAddr("ff02::1"), true, "IPv6 multicast");
  assert.strictEqual(linkcheck.isPrivateAddr("2606:4700:4700::1111"), false, "public IPv6 must stay allowed");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/linkcheck.test.js`
Expected: FAIL — `100.64.0.1 must be blocked` (currently returns `false`).

- [ ] **Step 3: Implement**

In `core/linkcheck.js`, replace the body of `isPrivateAddr` with:

```js
function isPrivateAddr(ip) {
  var h = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h.indexOf(":") >= 0) {  // IPv6
    if (/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(h)) {  // IPv4-mapped -> test the v4
      return isPrivateAddr(h.replace(/^::ffff:/, ""));
    }
    if (/^::/.test(h)) return true;                       // ::1, ::, ::ffff:<hex> (compat/mapped)
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;        // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;        // fe80::/10 link-local
    if (/^fec[0-9a-f]:/.test(h)) return true;             // fec0::/10 site-local (deprecated)
    if (/^ff[0-9a-f]{2}:/.test(h)) return true;           // ff00::/8 multicast
    // 6to4 (2002:AABB:CCDD::/48) and NAT64 (64:ff9b::/96) embed an IPv4 address.
    // Decode it and apply the v4 rules, or they become a wrapper around loopback.
    var six4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
    if (six4) return isPrivateAddr(_v4FromHextets(six4[1], six4[2]));
    var nat64 = h.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (nat64) return isPrivateAddr(_v4FromHextets(nat64[1], nat64[2]));
    if (/^64:ff9b::/.test(h)) return true;                // any other NAT64 form: refuse rather than guess
    return false;
  }
  var m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    var a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64/10 CGNAT
    if (a === 192 && b === 0) return true;                // 192.0.0/24 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true;                            // 224/4 multicast + 240/4 reserved + 255.255.255.255
    return false;
  }
  return false;
}

// "7f00","0001" -> "127.0.0.1". Used to unwrap 6to4 / NAT64 IPv6 forms.
function _v4FromHextets(hi, lo) {
  var a = parseInt(hi, 16) || 0, b = parseInt(lo, 16) || 0;
  return [(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join(".");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/linkcheck.test.js` → all pass.
Run: `node tests/linkcheck-probe.test.js && node tests/linkcheck-endpoint.test.js` → still pass (the widened guard must not break existing probing).

- [ ] **Step 5: Commit**

```bash
git add core/linkcheck.js tests/linkcheck.test.js
git commit -m "Block CGNAT, multicast, reserved and 6to4/NAT64 in the SSRF address guard"
```

---

### Task 2: `core/cardimage.js` — card id → guarded server-side image fetch

**Files:**
- Create: `core/cardimage.js`
- Test: `tests/cardimage.test.js`

**Interfaces:**
- Consumes: `linkcheck.safeToFetch(url, opts) -> Promise<boolean>`, `linkcheck.setLookup(fn)`, `guardedfetch.followRedirects(url, opts) -> Promise<{result,current,hop,stopReason}>`, `guardedfetch.fetchOnceGuarded(url, opts) -> Promise<{error,status,buffer,res,location}>`, `db.getCard(db, id)`, `db.getSaved(db, id)`.
- Produces: `fetchCardImage(db, id, opts) -> Promise<{ ok: true, contentType: string, buffer: Buffer } | { ok: false, reason: string }>`. `reason` is one of `"not-found"`, `"no-remote-image"`, `"blocked"`, `"fetch-failed"`, `"not-an-image"`, `"too-large"`. Task 3 maps every failure to ONE generic client message.

- [ ] **Step 1: Write the failing test**

Create `tests/cardimage.test.js`:

```js
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
    const r = await cardimage.fetchCardImage(db, "s1", { fetchFn: okFetch(PNG, "image/png") });
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
    const r = await cardimage.fetchCardImage(db, "c7", { fetchFn: okFetch(Buffer.from("<html>"), "text/html") });
    assert.strictEqual(r.reason, "not-an-image");
    db.close();
  });

  await t("an empty body is refused", async () => {
    const db = newDb();
    upsertCard(db, { id: "c8", url: "https://x/8", img: "https://cdn.example.com/a.png" });
    const r = await cardimage.fetchCardImage(db, "c8", { fetchFn: okFetch(Buffer.alloc(0), "image/png") });
    assert.strictEqual(r.reason, "fetch-failed");
    db.close();
  });

  await t("a redirect to a blocked address is not followed", async () => {
    const db = newDb();
    upsertCard(db, { id: "c9", url: "https://x/9", img: "https://cdn.example.com/a.png" });
    let hops = 0;
    const r = await cardimage.fetchCardImage(db, "c9", {
      fetchFn: async (target) => {
        hops++;
        if (hops === 1) return { error: null, status: 302, location: "https://127.0.0.1/evil.png", buffer: null, res: null };
        throw new Error("must not fetch the redirect target");
      },
    });
    assert.strictEqual(r.ok, false, "a 30x into a blocked host must not produce bytes");
    db.close();
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/cardimage.test.js`
Expected: FAIL — `Cannot find module '../core/cardimage.js'`.

- [ ] **Step 3: Implement**

Create `core/cardimage.js`:

```js
// core/cardimage.js — fetch a CARD's remote image, server-side.
//
// The unit of request is a CARD ID, never a URL. That is the load-bearing SSRF
// mitigation: a caller cannot name a destination, only ask for a re-fetch of a
// URL the library already stores. The address guards below are defense in
// depth, because a stored URL is still untrusted — imports and captures come
// from third-party pages.
//
// Everything here composes guards that already exist:
//   linkcheck.safeToFetch  — scheme allowlist, localhost/.local, numeric-host
//                            encodings, private/loopback/link-local ranges, and
//                            a resolve-ALL-records DNS check.
//   guardedfetch           — timeout, byte cap, per-hop redirect re-validation.
//
// KNOWN, UNFIXED (app-wide, pre-existing — do not let a review think it is
// handled here): safeToFetch validates by HOSTNAME and the HTTP client then
// re-resolves at connect time, so a resolver that flips between the two lookups
// can still land on loopback (TOCTOU). Closing it needs connect-time address
// pinning across every caller (linkcheck, capturemeta, this), not a local patch.
"use strict";
const linkcheck = require("./linkcheck");
const gf = require("./guardedfetch");
const dbm = require("./db");

const MAX_BYTES = 8 * 1024 * 1024;   // a card thumbnail is orders of magnitude smaller
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

function remoteImageUrlFor(db, id) {
  const card = dbm.getCard(db, id);
  if (card) return String(card.img || "");
  const item = dbm.getSaved(db, id);
  if (item) return String(item.image || "");
  return null;   // null = no such row; "" = row exists but has no remote image
}

async function fetchCardImage(db, id, opts) {
  opts = opts || {};
  const url = remoteImageUrlFor(db, id);
  if (url === null) return { ok: false, reason: "not-found" };
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "no-remote-image" };

  // Fail CLOSED on an unresolvable name. safeToFetch returns true there on
  // purpose so link-probing can surface ENOTFOUND as "dead"; fetching bytes has
  // no such need, and letting it through would be the one fail-open path.
  const lookup = opts.lookup || null;
  const safeOpts = lookup ? { lookup } : {};
  if (lookup) {
    try { await lookup(new URL(url).hostname, { all: true }); }
    catch (e) { return { ok: false, reason: "blocked" }; }
  }
  if (!(await linkcheck.safeToFetch(url, safeOpts))) return { ok: false, reason: "blocked" };

  const fetchFn = opts.fetchFn
    || function (target) { return gf.fetchOnceGuarded(target, { method: "GET", timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, ua: gf.UA_CAPTURE }); };

  let hop;
  try {
    hop = await gf.followRedirects(url, {
      maxRedirects: MAX_REDIRECTS,
      fetchFn: fetchFn,
      safeToFetch: function (next) { return linkcheck.safeToFetch(next, safeOpts); },
    });
  } catch (e) { return { ok: false, reason: "fetch-failed" }; }

  const r = hop && hop.result;
  if (!r || r.error) return { ok: false, reason: "fetch-failed" };
  if (hop.stopReason !== "terminal") return { ok: false, reason: "blocked" };
  if (!(r.status >= 200 && r.status < 300)) return { ok: false, reason: "fetch-failed" };

  const ct = (r.res && r.res.headers && typeof r.res.headers.get === "function")
    ? String(r.res.headers.get("content-type") || "") : "";
  if (!/^image\//i.test(ct)) return { ok: false, reason: "not-an-image" };

  const buf = r.buffer || Buffer.alloc(0);
  if (!buf.length) return { ok: false, reason: "fetch-failed" };
  if (buf.length > MAX_BYTES) return { ok: false, reason: "too-large" };

  return { ok: true, contentType: ct.split(";")[0].trim(), buffer: buf };
}

module.exports = { fetchCardImage, remoteImageUrlFor, MAX_BYTES, TIMEOUT_MS, MAX_REDIRECTS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/cardimage.test.js` → `11 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add core/cardimage.js tests/cardimage.test.js
git commit -m "Add card-id-keyed server-side image fetch behind the existing SSRF guards"
```

---

### Task 3: `POST /api/fetch-card-image` route

**Files:**
- Modify: `core/server.js` (add the route next to `GET /api/img/:id`, ~line 400)
- Test: `tests/cardimage-endpoint.test.js`

**Interfaces:**
- Consumes: `cardimage.fetchCardImage(db, id, opts)` from Task 2.
- Produces: `POST /api/fetch-card-image` with JSON body `{ id }`. On success: `200`, `Content-Type` = the image's type, body = raw bytes. On any failure: `404` with `{ ok:false, error:"image unavailable" }` — **one** message for every reason, so the endpoint cannot be used to probe the network.

- [ ] **Step 1: Write the failing test**

Create `tests/cardimage-endpoint.test.js`:

```js
// tests/cardimage-endpoint.test.js — the HTTP surface of the card-image fetch.
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cie-"));

const { createServer } = require("../core/server.js");
const { openDb, upsertCard } = require("../core/db.js");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }
function listen(app) {
  return new Promise((res) => { const s = http.createServer(app).listen(0, "127.0.0.1", () => res({ s, base: "http://127.0.0.1:" + s.address().port })); });
}
function newStore() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cie-store-")); fs.mkdirSync(path.join(d, "images"), { recursive: true }); return d; }

(async function () {
  const store = newStore();
  const db = openDb(store);
  upsertCard(db, { id: "local", url: "https://x/1", img: "idb:local" });
  upsertCard(db, { id: "blocked", url: "https://x/2", img: "https://127.0.0.1/a.png" });
  const ctx = { db, storeDir: store, reopen: () => openDb(store) };
  const { s, base } = await listen(createServer(ctx));

  async function post(body) {
    const r = await fetch(base + "/api/fetch-card-image", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, ct, text: /json/.test(ct) ? JSON.stringify(await r.json()) : "" };
  }

  await t("an unknown id returns the generic 404", async () => {
    const r = await post({ id: "nope" });
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /image unavailable/);
  });

  await t("a card with no remote image returns the SAME generic 404", async () => {
    const r = await post({ id: "local" });
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /image unavailable/);
  });

  await t("a blocked destination returns the SAME generic 404 — no probing signal", async () => {
    const r = await post({ id: "blocked" });
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /image unavailable/,
      "every failure reason must look identical, or the endpoint maps the user's network");
  });

  await t("a missing id is rejected", async () => {
    const r = await post({});
    assert.ok(r.status === 400 || r.status === 404, "got " + r.status);
  });

  await t("the route accepts no URL field at all", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "core", "server.js"), "utf8");
    const m = /app\.post\("\/api\/fetch-card-image"[\s\S]*?\n  \}\);/.exec(src);
    assert.ok(m, "route not found");
    assert.doesNotMatch(m[0], /req\.body\s*&&\s*req\.body\.url|req\.body\.url/,
      "taking a URL from the caller would reintroduce the SSRF surface the card-id design removes");
  });

  await new Promise((r) => s.close(r));
  try { db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  await new Promise((r) => setTimeout(r, 50));
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/cardimage-endpoint.test.js`
Expected: FAIL — the first case returns `404` from Express's default handler with no JSON body, so `image unavailable` does not match.

- [ ] **Step 3: Implement**

In `core/server.js`, add `const cardimage = require("./cardimage");` beside the other `core/` requires, then add this route immediately after the `GET /api/img/:id` handler:

```js
  // Fetch a card's REMOTE image server-side, so the browser's CORS rules don't
  // block the AI title pipeline (Pinterest and friends serve images that render
  // in an <img> but refuse a fetch()). Takes a CARD ID, never a URL: a caller
  // cannot name a destination, only ask for a re-fetch of something already in
  // the library. See core/cardimage.js for the guard composition.
  app.post("/api/fetch-card-image", async (req, res) => {
    const id = req.body && req.body.id;
    if (!id || typeof id !== "string") return res.status(400).json({ ok: false, error: "id required" });
    let out;
    try { out = await cardimage.fetchCardImage(ctx.db, id); }
    catch (e) { console.error("fetch-card-image failed:", e); out = { ok: false, reason: "fetch-failed" }; }
    // ONE message for every failure reason. Distinguishable errors (or timings)
    // would turn this into a network scanner for whatever the service can reach.
    if (!out.ok) return res.status(404).json({ ok: false, error: "image unavailable" });
    res.set("Content-Type", out.contentType);
    res.set("Cache-Control", "no-store");
    res.send(out.buffer);
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/cardimage-endpoint.test.js` → `5 passed, 0 failed`.
Run: `node tests/run.js` → `ALL TEST FILES PASSED`.

- [ ] **Step 5: Commit**

```bash
git add core/server.js tests/cardimage-endpoint.test.js
git commit -m "Add POST /api/fetch-card-image with a single generic failure response"
```

---

### Task 4: Route remote images through the endpoint, and say why a title failed

**Files:**
- Modify: `web/index.html` (`resolveCardImageForAI`, ~line 4828; `regenerateTitleFor`, ~line 5415)
- Modify: `pwa/index.html` (same two functions, ~line 4907)
- Test: `tests/card-image-fetch-wiring.test.js`

**Interfaces:**
- Consumes: `POST /api/fetch-card-image` from Task 3.
- Produces: `resolveCardImageForAI(card)` unchanged signature — `Promise<{mediaType, base64} | null>`. New: `_lastImageFailReason` (module-level string) set to `""`, `"no-image"`, `"fetch-blocked"`, or `"decode-failed"`, read by `regenerateTitleFor` for its toast.

- [ ] **Step 1: Write the failing test**

Create `tests/card-image-fetch-wiring.test.js`:

```js
// tests/card-image-fetch-wiring.test.js — the client must not browser-fetch a
// remote card image (CORS refuses it; the pipeline then silently produced no
// title, which is why Pinterest cards sat at "(untitled)").
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }
function body(src, name) {
  const m = new RegExp("async function " + name + "\\(card\\)\\{([\\s\\S]*?)\\n\\}").exec(src);
  assert.ok(m, name + " not found");
  return m[1];
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": remote images do NOT go through a direct browser fetch of the image URL", () => {
    const b = body(src, "resolveCardImageForAI");
    assert.doesNotMatch(b, /fetch\(srcUrl\)/,
      "fetch(srcUrl) on a cross-origin image is refused by CORS — that was the bug");
  });
  t(label + ": the http(s) branch requests bytes by CARD ID, not by URL", () => {
    const b = body(src, "resolveCardImageForAI");
    assert.match(b, /fetch-card-image/, "must call the id-keyed endpoint");
    assert.match(b, /id:\s*card\.id/, "must send the card id");
    assert.doesNotMatch(b, /body:\s*JSON\.stringify\(\{\s*url/,
      "sending a URL would reintroduce the SSRF surface the endpoint's design removes");
  });
  t(label + ": a failure reason is recorded so the UI can say WHY", () => {
    const b = body(src, "resolveCardImageForAI");
    assert.match(b, /_lastImageFailReason\s*=/, "must record a reason");
    for (const reason of ["no-image", "fetch-blocked", "decode-failed"]) {
      assert.ok(src.indexOf('"' + reason + '"') >= 0, "missing reason: " + reason);
    }
  });
  t(label + ": regenerateTitleFor reports the specific reason, not one catch-all", () => {
    const m = /async function regenerateTitleFor\(card, ?extraAvoid, ?busyLabel\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "regenerateTitleFor not found");
    assert.match(m[1], /_lastImageFailReason/,
      "a card that failed because its picture was unreachable must not read as 'no usable image'");
  });
}
// NOT a byte-parity assertion, unlike the other shared functions. Step 3e gives
// the PWA a different remote-image path on purpose: it has no Core service, so
// it uses the allorigins proxy. Asserting parity here would be asserting a bug.
// Pin the part that MUST match instead.
t("both builds agree on the idb: path and neither browser-fetches a remote URL", () => {
  for (const src of [html, pwaHtml]) {
    const b = body(src, "resolveCardImageForAI");
    assert.match(b, /Store\.ensureImage/, "the idb: branch must be unchanged");
    assert.match(b, /maxEdge\s*=\s*1024/, "the downscale contract must be unchanged");
    assert.doesNotMatch(b, /fetch\(srcUrl\)\.then|await \(await fetch\(img\)\)/, "no direct remote fetch");
  }
});
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/card-image-fetch-wiring.test.js`
Expected: FAIL — `fetch(srcUrl) on a cross-origin image is refused by CORS`.

- [ ] **Step 3: Implement**

Using the `Edit` tool (not shell string generation), in **both** `web/index.html` and `pwa/index.html`:

**3a.** Replace the `http(s)` branch and the fetch line inside `resolveCardImageForAI`. Find:

```js
    } else if(/^https?:\/\//i.test(img)){
      srcUrl = img;
    } else {
      return null;
    }
    const blob = await (await fetch(srcUrl)).blob();
```

Replace with:

```js
    } else if(/^https?:\/\//i.test(img)){
      srcUrl = "";   // remote: fetched by card id below, never by URL from the browser
    } else {
      _lastImageFailReason = "no-image";
      return null;
    }
    // A cross-origin image renders in an <img> without CORS but REFUSES a
    // fetch(), so fetching the URL here returned null and the whole title
    // pipeline went quiet. Remote images are fetched server-side instead, by
    // card id — the browser never names a destination.
    let blob;
    if(srcUrl){
      blob = await (await fetch(srcUrl)).blob();
    } else {
      const resp = await fetch("/api/fetch-card-image", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ id: card.id })
      });
      if(!resp.ok){ _lastImageFailReason = "fetch-blocked"; return null; }
      blob = await resp.blob();
    }
```

**3b.** Set the reason on the decode failure. Find the closing catch of `resolveCardImageForAI`:

```js
  }catch(e){ console.warn("resolveCardImageForAI failed", e); return null; }
```

Replace with:

```js
  }catch(e){ console.warn("resolveCardImageForAI failed", e); _lastImageFailReason = "decode-failed"; return null; }
```

**3c.** Declare the reason and clear it at entry. Immediately **above** `async function resolveCardImageForAI(card){`, insert:

```js
// Why the last image resolve failed: "" | "no-image" | "fetch-blocked" | "decode-failed".
// Read by regenerateTitleFor so a card whose PICTURE was unreachable doesn't get
// reported as "no usable text or image" — they need different fixes.
let _lastImageFailReason = "";
```

and as the first line inside the function's `try{`:

```js
    _lastImageFailReason = "";
```

**3d.** Use it in the toast. In `regenerateTitleFor`, find:

```js
  if(!out) toast("Couldn't generate a title for that card — check your AI key/credits, or it may have no usable text or image.", 7000);
```

Replace with:

```js
  if(!out){
    const why = _lastImageFailReason === "fetch-blocked"
      ? "Couldn't load that card's picture — the site may be blocking it, or it may be gone."
      : _lastImageFailReason === "decode-failed"
      ? "That card's picture couldn't be read."
      : _lastImageFailReason === "no-image"
      ? "That card has no picture to read a title from."
      : "Couldn't generate a title — check your AI key, credits, and rate limits.";
    toast(why, 7000);
  }
```

**3e.** PWA has no Core service. In `pwa/index.html` **only**, the endpoint call must fall back to the existing CORS proxy. Replace the `fetch("/api/fetch-card-image", ...)` block there with:

```js
      const resp = window.IA_IDB
        ? await fetch("https://api.allorigins.win/raw?url=" + encodeURIComponent(img))
        : await fetch("/api/fetch-card-image", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ id: card.id })
          });
```

> Because of 3e, `resolveCardImageForAI` is **no longer byte-identical** across the two files — which is why the Step 1 test pins the *shared contract* (the `idb:` branch, the 1024px downscale, no direct remote fetch) rather than byte equality. Do **not** "fix" the divergence by giving the desktop build the proxy path: the desktop must use its own service.
>
> Also check `tests/title-tiers-structural.test.js` and any other suite asserting web/pwa parity — if one of them compares `resolveCardImageForAI` byte-for-byte, it will fail here, and the correct change is to narrow that assertion the same way, not to re-converge the code.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/card-image-fetch-wiring.test.js` → all pass.
Run: `node tests/syntax-check.js` → `0 error(s)`.
Run: `node -e "const fs=require('fs');for(const f of ['web/index.html','pwa/index.html'])console.log(f,(fs.readFileSync(f,'utf8').match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g)||[]).length)"` → both `0`.
Run: `node tests/run.js` → `ALL TEST FILES PASSED`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/card-image-fetch-wiring.test.js
git commit -m "Fetch remote card images by id server-side; report why a title failed"
```

---

### Task 5: `web/imagehash.js` — pure dHash + Hamming

**Files:**
- Create: `web/imagehash.js`
- Test: `tests/imagehash.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (browser global `IA_IMGHASH`, and CommonJS for tests):
  - `dhashFromGrey(grey: number[]|Uint8Array, w=9, h=8) -> string` — 16 lowercase hex chars.
  - `hamming(a: string, b: string) -> number` — 0..64; returns 64 for missing/mismatched input.
  - `HASH_W = 9`, `HASH_H = 8`, `MAX_DISTANCE = 5`.

- [ ] **Step 1: Write the failing test**

Create `tests/imagehash.test.js`:

```js
// tests/imagehash.test.js — dHash + Hamming. Pure functions: the greyscale
// sampling lives in the browser, the bit math lives here so it can be tested.
const assert = require("assert");
const { dhashFromGrey, hamming, HASH_W, HASH_H, MAX_DISTANCE } = require("../web/imagehash.js");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }

function grey(fn) {
  const out = new Uint8Array(HASH_W * HASH_H);
  for (let y = 0; y < HASH_H; y++) for (let x = 0; x < HASH_W; x++) out[y * HASH_W + x] = fn(x, y);
  return out;
}

t("produces 16 hex chars (64 bits)", () => {
  const h = dhashFromGrey(grey((x) => x * 20));
  assert.strictEqual(h.length, 16);
  assert.match(h, /^[0-9a-f]{16}$/);
});

t("is deterministic", () => {
  const g = grey((x, y) => (x * 7 + y * 13) % 256);
  assert.strictEqual(dhashFromGrey(g), dhashFromGrey(g));
});

t("a left-to-right ramp is all zero bits; its mirror is all ones", () => {
  // dHash asks "is this pixel brighter than the one to its right?"
  assert.strictEqual(dhashFromGrey(grey((x) => x * 20)), "0000000000000000");
  assert.strictEqual(dhashFromGrey(grey((x) => 200 - x * 20)), "ffffffffffffffff");
});

t("hamming: identical is 0, inverted is 64", () => {
  assert.strictEqual(hamming("0000000000000000", "0000000000000000"), 0);
  assert.strictEqual(hamming("ffffffffffffffff", "0000000000000000"), 64);
});

t("hamming: counts single-bit differences", () => {
  assert.strictEqual(hamming("0000000000000001", "0000000000000000"), 1);
  assert.strictEqual(hamming("0000000000000003", "0000000000000000"), 2);
});

t("hamming: missing or malformed input is maximally distant, never 0", () => {
  // Returning 0 for junk would group every unhashable card together — the
  // worst possible failure mode when the outcome is deletion.
  assert.strictEqual(hamming("", ""), 64);
  assert.strictEqual(hamming(null, "0000000000000000"), 64);
  assert.strictEqual(hamming("abc", "0000000000000000"), 64);
});

t("a small brightness shift stays within MAX_DISTANCE; a different image does not", () => {
  const base = grey((x, y) => (x * 25 + y * 3) % 256);
  const shifted = grey((x, y) => Math.min(255, ((x * 25 + y * 3) % 256) + 4));   // re-compression noise
  assert.ok(hamming(dhashFromGrey(base), dhashFromGrey(shifted)) <= MAX_DISTANCE);
  const other = grey((x, y) => (y * 37 + x * 5) % 256);
  assert.ok(hamming(dhashFromGrey(base), dhashFromGrey(other)) > MAX_DISTANCE);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/imagehash.test.js`
Expected: FAIL — `Cannot find module '../web/imagehash.js'`.

- [ ] **Step 3: Implement**

Create `web/imagehash.js`:

```js
/* web/imagehash.js — perceptual image hashing for duplicate detection.
   Pure functions only (no DOM), so tests can require() them in Node; the
   browser attaches them as IA_IMGHASH. Same dual-export shape as web/storage.js.

   dHash, not aHash or pHash: aHash groups anything flat or similarly-branded
   (Pinterest templates collide constantly), and pHash's DCT buys accuracy this
   use case doesn't need. dHash asks one question per pixel pair — "is this one
   brighter than its right-hand neighbour?" — which survives rescaling and
   re-compression while still separating different pictures. */
(function (root) {
  "use strict";

  var HASH_W = 9, HASH_H = 8;   // 9 wide so each row yields 8 comparisons -> 64 bits

  // STRICT by design: the outcome of a match is a deletion prompt, so the cost
  // of too loose (a wrongly grouped card) is worse than too strict (a missed
  // duplicate). Measure before changing: hash the real library, print the
  // distance distribution for known-duplicate and known-distinct pairs, and
  // record the numbers here.
  var MAX_DISTANCE = 5;

  function dhashFromGrey(grey, w, h) {
    w = w || HASH_W; h = h || HASH_H;
    var bits = "";
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w - 1; x++) {
        bits += (grey[y * w + x] > grey[y * w + x + 1]) ? "1" : "0";
      }
    }
    var hex = "";
    for (var i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }

  var HEX = /^[0-9a-f]+$/;
  function hamming(a, b) {
    // Junk in must NOT read as "identical" — that would group every unhashable
    // card into one deletion pile.
    if (typeof a !== "string" || typeof b !== "string") return 64;
    if (a.length !== 16 || b.length !== 16) return 64;
    if (!HEX.test(a) || !HEX.test(b)) return 64;
    var d = 0;
    for (var i = 0; i < 16; i++) {
      var x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15;
      while (x) { d += x & 1; x >>= 1; }
    }
    return d;
  }

  var api = { dhashFromGrey: dhashFromGrey, hamming: hamming, HASH_W: HASH_W, HASH_H: HASH_H, MAX_DISTANCE: MAX_DISTANCE };
  root.IA_IMGHASH = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/imagehash.test.js` → `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add web/imagehash.js tests/imagehash.test.js
git commit -m "Add pure dHash + Hamming helpers for image duplicate detection"
```

---

### Task 6: Hash one card's image in the browser, with a resumable cache

**Files:**
- Modify: `web/index.html` (add `<script src="imagehash.js">` beside the other script tags; add the functions below near `resolveCardImageForAI`)
- Modify: `pwa/index.html` (same)
- Copy: `web/imagehash.js` → `pwa/imagehash.js` (the PWA serves its own copy; `pwa/sw.js` caches any same-origin `.js` automatically)
- Test: `tests/imagehash-cache-wiring.test.js`

**Interfaces:**
- Consumes: `IA_IMGHASH.dhashFromGrey`, `resolveCardImageForAI(card)` from Task 4, `Store.kvGet/kvSet`.
- Produces:
  - `imgHashSrcKey(card) -> string` — identifies the image a hash was computed from.
  - `async computeCardHash(card) -> string|""` — `""` when unhashable.
  - `async loadImgHashCache() -> object` / `saveImgHashCache(map)` — the `ia_imghash` kv, shape `{ [cardId]: { h: string, src: string } }`. `h === ""` means "known unhashable"; it is cached so it is not retried every scan.

- [ ] **Step 1: Write the failing test**

Create `tests/imagehash-cache-wiring.test.js`:

```js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }
function fn(src, name) {
  const m = new RegExp("(?:async )?function " + name + "\\([^)]*\\)\\{[\\s\\S]*?\\n\\}").exec(src);
  assert.ok(m, name + " not found");
  return m[0];
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": imagehash.js is loaded", () => {
    assert.match(src, /<script src="imagehash\.js"><\/script>/);
  });
  t(label + ": the hash is computed from a 9x8 greyscale sample", () => {
    const b = fn(src, "computeCardHash");
    assert.match(b, /IA_IMGHASH\.HASH_W/);
    assert.match(b, /IA_IMGHASH\.dhashFromGrey/);
  });
  t(label + ": an unhashable card caches \"\" so it isn't retried every scan", () => {
    const b = fn(src, "computeCardHash");
    assert.match(b, /return "";/, "must return the empty-string sentinel rather than throwing");
  });
  t(label + ": the cache entry records WHICH image it was computed from", () => {
    const b = fn(src, "imgHashSrcKey");
    assert.ok(/card\.img|card\.image/.test(b), "srcKey must derive from the card's current image");
  });
  t(label + ": the cache lives in ia_imghash, not the fp table", () => {
    assert.match(src, /"ia_imghash"/);
    const b = fn(src, "loadImgHashCache");
    assert.doesNotMatch(b, /fpSet|fpGet/, "fp is placeholder detection — overloading it would break that");
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/imagehash-cache-wiring.test.js`
Expected: FAIL — `<script src="imagehash.js">` not found.

- [ ] **Step 3: Implement**

**3a.** `cp web/imagehash.js pwa/imagehash.js`

**3b.** In **both** HTML files, add beside the existing script tags (e.g. after the `storage.js` tag):

```html
<script src="imagehash.js"></script>
```

**3c.** In **both** HTML files, insert immediately above `async function resolveCardImageForAI(card){`:

```js
// --- perceptual image hashing (duplicate detection) -------------------------
// Identifies WHICH image a cached hash was computed from, so the entry
// self-invalidates when the card's picture changes (re-capture, manual upload,
// "Fix placeholders") instead of matching on a stale hash forever.
function imgHashSrcKey(card){
  const v = (card && (card.img || card.image)) || "";
  return String(v).indexOf("idb:")===0 ? ("idb:"+card.id+":"+(card.lastUpdate||card.edited||0)) : String(v);
}
// A 64-bit dHash for one card, or "" when the image can't be read. "" is a
// CACHED verdict, not an error: an unreachable image must not be re-fetched on
// every scan of a multi-thousand-card library.
async function computeCardHash(card){
  try{
    const image = await resolveCardImageForAI(card);
    if(!image) return "";
    const blob = await (await fetch("data:"+image.mediaType+";base64,"+image.base64)).blob();
    const bitmap = await createImageBitmap(blob);
    const W = IA_IMGHASH.HASH_W, H = IA_IMGHASH.HASH_H;
    const c = new OffscreenCanvas(W, H);
    const ctx = c.getContext("2d", {willReadFrequently:true});
    ctx.drawImage(bitmap, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const grey = new Uint8Array(W*H);
    for(let i=0;i<W*H;i++){
      grey[i] = (px[i*4]*0.299 + px[i*4+1]*0.587 + px[i*4+2]*0.114) | 0;
    }
    return IA_IMGHASH.dhashFromGrey(grey, W, H);
  }catch(e){ console.warn("computeCardHash failed", e); return ""; }
}
async function loadImgHashCache(){
  try{ const m = await Store.kvGet("ia_imghash"); return (m && typeof m==="object") ? m : {}; }
  catch(e){ return {}; }
}
function saveImgHashCache(map){ try{ Store.kvSet("ia_imghash", map); }catch(e){} }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/imagehash-cache-wiring.test.js` → all pass.
Run: `node tests/syntax-check.js` → `0 error(s)`; control-char scan → both `0`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html pwa/imagehash.js tests/imagehash-cache-wiring.test.js
git commit -m "Compute and cache a per-card image hash, invalidated by the source image"
```

---

### Task 7: The image-duplicate second pass

**Files:**
- Modify: `web/index.html` (add `scanImageDuplicates` next to `scanDuplicates`, ~line 5595)
- Modify: `pwa/index.html` (same)
- Test: `tests/image-dupes.test.js`

**Interfaces:**
- Consumes: `IA_IMGHASH.hamming`, `MAX_DISTANCE`; the hash cache from Task 6; `dupeGroupDismissed(members)`, `dupeMemberKey(m)`, `dupePrimary(mem)` (existing).
- Produces: `groupByImageHash(entries, alreadyGrouped, hamming, maxDistance) -> Array<Array<entry>>` — a **pure** function so it can be tested in Node. `entries` are `{key, scope, card, hash}`; `alreadyGrouped` is a `Set` of keys the URL/title pass consumed.

- [ ] **Step 1: Write the failing test**

Create `tests/image-dupes.test.js`:

```js
// tests/image-dupes.test.js — the image pass is deliberately SEPARATE from the
// url/title pass. Two reasons, both tested here: today's grouping must not
// change, and one shared union-find would merge A~B (image) with B~C (title)
// into a single group even though nothing links A to C. The outcome of a group
// is a deletion prompt, so transitive merging is unacceptable.
const assert = require("assert");
const { hamming, MAX_DISTANCE } = require("../web/imagehash.js");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }

// Extract the pure grouper from the shipped source (no bundler in this project).
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const m = /function groupByImageHash\([\s\S]*?\n\}/.exec(html);
assert.ok(m, "groupByImageHash not found in web/index.html");
const groupByImageHash = new Function(m[0] + "; return groupByImageHash;")();

const H_A = "0000000000000000";
const H_A2 = "0000000000000001";   // 1 bit off — same picture, re-encoded
const H_B = "ffffffffffffffff";    // 64 bits off — different picture

t("groups cards whose hashes are within MAX_DISTANCE", () => {
  const g = groupByImageHash([
    { key: "imported:1", hash: H_A }, { key: "imported:2", hash: H_A2 },
  ], new Set(), hamming, MAX_DISTANCE);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].length, 2);
});

t("does not group visibly different images", () => {
  const g = groupByImageHash([
    { key: "imported:1", hash: H_A }, { key: "imported:2", hash: H_B },
  ], new Set(), hamming, MAX_DISTANCE);
  assert.strictEqual(g.length, 0);
});

t("skips cards the url/title pass already grouped", () => {
  const g = groupByImageHash([
    { key: "imported:1", hash: H_A }, { key: "imported:2", hash: H_A2 },
  ], new Set(["imported:1"]), hamming, MAX_DISTANCE);
  assert.strictEqual(g.length, 0, "an already-grouped card must not be pulled into a second group");
});

t("ignores unhashable cards entirely", () => {
  const g = groupByImageHash([
    { key: "imported:1", hash: "" }, { key: "imported:2", hash: "" }, { key: "imported:3", hash: null },
  ], new Set(), hamming, MAX_DISTANCE);
  assert.strictEqual(g.length, 0, "empty hashes must never group — hamming returns 64 for them");
});

t("a lone card is not a group", () => {
  const g = groupByImageHash([{ key: "imported:1", hash: H_A }], new Set(), hamming, MAX_DISTANCE);
  assert.strictEqual(g.length, 0);
});

t("three near-identical images form ONE group, not three pairs", () => {
  const g = groupByImageHash([
    { key: "a", hash: "0000000000000000" }, { key: "b", hash: "0000000000000001" }, { key: "c", hash: "0000000000000003" },
  ], new Set(), hamming, MAX_DISTANCE);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].length, 3);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/image-dupes.test.js`
Expected: FAIL — `groupByImageHash not found in web/index.html`.

- [ ] **Step 3: Implement**

In **both** HTML files, insert immediately above `function scanDuplicates(){`:

```js
// Group entries by image similarity. PURE (no globals) so it can be unit-tested.
// `alreadyGrouped` holds the keys the url/title pass consumed — those are
// skipped, which is what keeps the two passes from merging transitively.
function groupByImageHash(entries, alreadyGrouped, hammingFn, maxDistance){
  const live = (entries||[]).filter(e => e && e.hash && !alreadyGrouped.has(e.key));
  const parent = live.map((_,i)=>i);
  const find = (x)=>{ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
  const union = (a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent[ra]=rb; };
  for(let i=0;i<live.length;i++){
    for(let j=i+1;j<live.length;j++){
      if(hammingFn(live[i].hash, live[j].hash) <= maxDistance) union(i,j);
    }
  }
  const buckets = {};
  live.forEach((e,i)=>{ const r=find(i); (buckets[r]=buckets[r]||[]).push(e); });
  return Object.values(buckets).filter(b => b.length > 1);
}
// Hash-backed duplicate pass. Runs AFTER scanDuplicates and only over cards it
// did not already group, so today's behavior is untouched and nothing merges
// across the two passes. Returns groups shaped like scanDuplicates' output plus
// `imageMatch:true`, which the UI uses to badge them and leave them unchecked.
async function scanImageDuplicates(alreadyGroupedKeys, onProgress){
  const cache = await loadImgHashCache();
  const members = [];
  imported.forEach(c=>{ if(c) members.push({key:"imported:"+c.id, scope:"imported", card:c}); });
  saved.forEach(c=>{ if(c) members.push({key:"saved:"+c.id, scope:"saved", card:c}); });
  const todo = members.filter(m => !alreadyGroupedKeys.has(m.key));
  let done = 0;
  for(const m of todo){
    const src = imgHashSrcKey(m.card);
    const hit = cache[m.card.id];
    if(hit && hit.src === src){ m.hash = hit.h; }
    else {
      m.hash = await computeCardHash(m.card);
      cache[m.card.id] = { h: m.hash, src: src };
      // Persist as we go: closing the modal half-way must RESUME next time, not
      // restart. A multi-thousand-card first pass is too expensive to redo.
      if(done % 25 === 0) saveImgHashCache(cache);
    }
    done++;
    if(onProgress && done % 10 === 0) onProgress(done, todo.length);
    if(_imgScanAbort) break;
  }
  saveImgHashCache(cache);
  const groups = groupByImageHash(todo, alreadyGroupedKeys, IA_IMGHASH.hamming, IA_IMGHASH.MAX_DISTANCE);
  return groups
    .map(mem => ({ members: mem.map(e=>({card:e.card, scope:e.scope})), imageMatch: true }))
    .filter(g => !dupeGroupDismissed(g.members))
    .map(g => Object.assign(g, { keepKey: dupeMemberKey(dupePrimary(g.members)) }));
}
let _imgScanAbort = false;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/image-dupes.test.js` → `6 passed, 0 failed`.
Run: `node tests/syntax-check.js` → `0 error(s)`; control-char scan → both `0`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/image-dupes.test.js
git commit -m "Add the image-similarity duplicate pass as a separate second stage"
```

---

### Task 8: Duplicates UI — badge, unchecked-by-default, progress

**Files:**
- Modify: `web/index.html` (`renderHealthDupes`, ~line 5280)
- Modify: `pwa/index.html` (same)
- Test: `tests/image-dupes-ui.test.js`

**Interfaces:**
- Consumes: `scanImageDuplicates(alreadyGroupedKeys, onProgress)` from Task 7.
- Produces: no new exports; `_dupeGroups` entries may now carry `imageMatch: true`.

- [ ] **Step 1: Write the failing test**

Create `tests/image-dupes-ui.test.js`:

```js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": image-matched groups are visibly labelled as such", () => {
    assert.match(src, /imageMatch\s*\?[\s\S]{0,200}?Same picture/i,
      "a group formed only by image similarity must say so — it is a weaker signal than a shared link");
  });
  t(label + ": image-matched members start UNCHECKED", () => {
    // Perceptual matching has false positives and the outcome is deletion, so
    // nothing may be pre-selected for removal in an image-only group.
    assert.match(src, /imageMatch\s*\?\s*""\s*:\s*"\s*checked"|!g\.imageMatch\s*&&/,
      "the checked attribute must be conditional on the group NOT being an image match");
  });
  t(label + ": the scan reports progress and can be aborted", () => {
    assert.match(src, /_imgScanAbort/, "closing the modal mid-scan must stop the work");
    assert.match(src, /scanImageDuplicates\(/);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/image-dupes-ui.test.js`
Expected: FAIL — `a group formed only by image similarity must say so`.

- [ ] **Step 3: Implement**

In **both** HTML files, in `renderHealthDupes(list)`:

**3a.** After the existing `_dupeGroups = scanDuplicates();` line inside the `if(!_healthScanned.dupes){ ... }` block, append the image pass:

```js
    const groupedKeys = new Set();
    _dupeGroups.forEach(g => g.members.forEach(m => groupedKeys.add(m.scope + ":" + m.card.id)));
    _imgScanAbort = false;
    const bar = document.getElementById("healthList");
    if(bar) bar.innerHTML = `<div class="s" style="padding:14px 4px">Checking pictures for duplicates… <span id="imgScanPct">0%</span></div>`;
    scanImageDuplicates(groupedKeys, (done,total)=>{
      const el = document.getElementById("imgScanPct");
      if(el) el.textContent = Math.round(done/Math.max(1,total)*100) + "%";
    }).then(imgGroups=>{
      _dupeGroups = _dupeGroups.concat(imgGroups);
      renderHealthDupes(document.getElementById("healthList"));
    });
```

**3b.** In the group header markup, add the badge. Find the line rendering the group summary and append, inside the same element:

```js
${g.imageMatch ? `<span class="dupe-badge" style="background:var(--accent);color:#fff">Same picture — review before removing</span>` : ""}
```

**3c.** In the per-member checkbox markup, make `checked` conditional:

```js
<input type="checkbox" data-dupe-del ${g.imageMatch ? "" : "checked"}>
```

**3d.** Where the health modal is closed (`closeHealth` or equivalent), add:

```js
  _imgScanAbort = true;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/image-dupes-ui.test.js` → all pass.
Run: `node tests/syntax-check.js` → `0 error(s)`; control-char scan → both `0`.
Run: `node tests/run.js` → `ALL TEST FILES PASSED`.

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html tests/image-dupes-ui.test.js
git commit -m "Show image-matched duplicate groups badged and unchecked"
```

---

### Task 9: Browser verification, review gates, shell-cache bump

**Files:**
- Modify: `pwa/sw.js` (`SHELL_CACHE`, line 21)

**Interfaces:** none.

- [ ] **Step 1: Verify the Pinterest fix in a real browser**

Start an isolated Core service (temp `APPDATA` + temp store — never the real one), seed a card whose `img` is a **remote https URL** serving an image with legible text, open Title issues, and click the per-card ↻.

Expected: the card's title changes from `(untitled)` to text read off the picture. Confirm via `GET /api/cards` that it persisted.

- [ ] **Step 2: Verify a blocked URL produces the friendly message, not silence**

Seed a card whose `img` is `https://127.0.0.1/x.png`, click ↻.
Expected toast: `Couldn't load that card's picture — the site may be blocking it, or it may be gone.`

- [ ] **Step 3: Verify image duplicates group, badged and unchecked**

Seed two cards with the **same** image bytes but different `url` and different titles. Open Library health → Duplicates.
Expected: one group, badged `Same picture — review before removing`, with **no** member pre-checked.

- [ ] **Step 4: Verify the scan resumes**

With ~50 seeded cards, open Duplicates, close the modal at roughly 50%, reopen.
Expected: the progress readout resumes near where it stopped, not at 0%. Confirm `ia_imghash` has entries for the cards already processed.

- [ ] **Step 5: Tune the threshold against the real library**

Hash the real library, print the Hamming distribution for a sample of known-duplicate and known-distinct pairs, confirm `MAX_DISTANCE = 5` separates them, and record the measured numbers in the comment beside the constant in `web/imagehash.js` **and** `pwa/imagehash.js`. If 5 does not separate them, lower it — never raise it without evidence.

- [ ] **Step 6: Run the review gates**

Dispatch **electron-security-reviewer** on `core/server.js` + `core/cardimage.js` + `core/linkcheck.js`. Its bypass list now names DNS rebinding; the known TOCTOU gap is documented at the top of `core/cardimage.js` and must be reported as a named, accepted limitation rather than silently passed.

Dispatch **data-safety-reviewer** on the duplicate-removal path — image groups must be unable to auto-delete.

Fix anything blocking; re-run both.

- [ ] **Step 7: Bump the shell cache and commit**

`pwa/index.html` and `pwa/imagehash.js` changed, so installed PWAs will serve stale copies without a bump. In `pwa/sw.js`, increment `SHELL_CACHE` by one (currently `interests-pwa-shell-v53`).

```bash
node tests/run.js
git add pwa/sw.js
git commit -m "Bump PWA shell cache for the image-fetch and image-dupe changes"
```

---

## Notes for the implementer

- **`_lastImageFailReason` is module-level, not per-call.** It is only read immediately after an awaited `resolveCardImageForAI` inside `regenerateTitleFor`, so concurrent bulk suggestion could interleave. If Task 4's toast ever reports the wrong reason during a bulk run, thread the reason through the return value instead of a shared variable — do not add locking.
- **Do not "fix" the web/pwa divergence** introduced in Task 4 step 3e by giving the desktop build the `allorigins` path. The desktop must use its own service; the proxy exists only because the PWA has no server.
- **The threshold constant appears in two files** (`web/imagehash.js`, `pwa/imagehash.js`). Keep them identical; Task 9 step 5 updates both.
