# Sync Skip-Work Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a nothing-changed sync cycle cost a folder list plus one tiny meta.json read per peer (seconds, not minutes) on both the PWA and the desktop, without changing merge semantics, file formats, or interop with older app versions.

**Architecture:** Watermark + signature skipping per spec `docs/superpowers/specs/2026-07-16-sync-skip-optimization-design.md`: (1) a pure `contentSignature(agg)` shared via `core/merge.js` → verbatim `pwa/merge.js`; (2) per-peer `publishedAt` watermarks that skip unchanged peers' snapshot reads, advanced ONLY after a clean merge; (3) publish-skip when the local content signature is unchanged and the last publish was clean; (4) a PWA kv cache of already-published image ids replacing the every-cycle folder pagination.

**Tech Stack:** Vanilla JS (CommonJS core + browser IIFE pwa), plain Node `assert` tests via `node tests/run.js`.

## Global Constraints

- `pwa/merge.js` is a **verbatim copy** of `core/merge.js` below its 5-line header — regenerate, never hand-edit (locked by `tests/merge-settings.test.js`).
- Tests are plain Node scripts; the whole suite must pass (`node tests/run.js`) after every task; `pwa/index.html` must keep parsing (`node tests/syntax-check.js`).
- Safety bias is binding: any missing/unreadable watermark, signature, or cache ⇒ full (today's) behavior. Watermarks advance ONLY after a clean merge: desktop `deferred === 0` (and backup not failed); PWA `imagesFailed === 0 && partialFailures.length === 0`.
- Publish-skip requires ALL of: signature equal, stored clean flag true, merge applied nothing this cycle.
- No changes to `mergeSnapshots` LWW semantics, snapshot file format, `SCHEMA_VERSION`, torn-write validation, or `core/synctimers.js`.
- Any shipped `pwa/**` edit bumps `pwa/sw.js` `SHELL_CACHE` exactly once for the change set: v23 → v24 (Task 3).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Repo lives in Dropbox: retry git on intermittent lock errors; CRLF warnings are normal.

---

### Task 1: `contentSignature` (shared pure) + `db.signatureAggregates`

**Files:**
- Modify: `core/merge.js` (insert before the export lines; extend both export lines)
- Modify: `pwa/merge.js` (regenerate: keep 5-line header, re-copy core body — same technique as the mergeSyncedSettings task; a python one-liner splitting on the `// Pure multi-device merge` marker already exists in git history, commit 0601ece)
- Modify: `core/db.js` (add `signatureAggregates` next to `settingsForSync`; export it)
- Create: `tests/merge-signature.test.js`

**Interfaces:**
- Produces: `contentSignature(agg) -> string` exported from BOTH merge files (CommonJS + browser global, exactly like `mergeSyncedSettings`); `db.signatureAggregates(db) -> {cards, saved, tombstones, maxCardUpdatedAt, maxSavedUpdatedAt, maxTombDeletedAt, settingsUpdatedAt}` (all Numbers, 0 when absent). Consumed by Tasks 2 and 3.

- [ ] **Step 1: Write the failing test** — create `tests/merge-signature.test.js`:

```js
// tests/merge-signature.test.js — contentSignature(): the publish-skip's equality
// oracle. Signature-equality must imply "republishing would produce identical
// content", so every aggregate field must be independently visible in the string.
// Runs against BOTH core/merge.js and pwa/merge.js (verbatim-copy lock lives in
// tests/merge-settings.test.js; here we just require both exports exist).
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

const BASE = { cards: 10, saved: 3, tombstones: 2, maxCardUpdatedAt: 111, maxSavedUpdatedAt: 222, maxTombDeletedAt: 333, settingsUpdatedAt: 444 };

for (const [label, m] of [["core", require("../core/merge.js")], ["pwa", require("../pwa/merge.js")]]) {
  const sig = m.contentSignature;
  run(label + ": exports contentSignature; deterministic", () => {
    assert.strictEqual(typeof sig, "function");
    assert.strictEqual(sig(BASE), sig(Object.assign({}, BASE)));
    assert.ok(/^v1\|/.test(sig(BASE)), "versioned prefix so future field changes can never alias old signatures");
  });
  run(label + ": every aggregate field independently changes the signature", () => {
    for (const k of Object.keys(BASE)) {
      const changed = Object.assign({}, BASE); changed[k] = BASE[k] + 1;
      assert.notStrictEqual(sig(changed), sig(BASE), "field " + k + " must be visible in the signature");
    }
  });
  run(label + ": garbage coerces to 0, never throws", () => {
    assert.doesNotThrow(() => sig(null));
    assert.doesNotThrow(() => sig({ cards: "x", maxCardUpdatedAt: NaN }));
    assert.strictEqual(sig(null), sig({}));
    assert.strictEqual(sig({ cards: NaN }), sig({ cards: 0 }));
  });
}

// db.signatureAggregates against a real store (pattern of tests/sync-settings.test.js)
const db = require("../core/db.js");
function newDb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sig-")); fs.mkdirSync(path.join(dir, "images"), { recursive: true }); return db.openDb(dir); }
run("signatureAggregates: empty store → all zeros; each mutation moves its aggregate", () => {
  const d = newDb();
  const a0 = db.signatureAggregates(d);
  assert.deepStrictEqual(a0, { cards: 0, saved: 0, tombstones: 0, maxCardUpdatedAt: 0, maxSavedUpdatedAt: 0, maxTombDeletedAt: 0, settingsUpdatedAt: 0 });
  db.upsertCard(d, { id: "c1", url: "u", ts: 1 });
  const a1 = db.signatureAggregates(d);
  assert.strictEqual(a1.cards, 1);
  assert.ok(a1.maxCardUpdatedAt > 0, "card upsert stamps updatedAt");
  db.addTombstone(d, "c9", "card", 777);
  const a2 = db.signatureAggregates(d);
  assert.strictEqual(a2.tombstones, 1);
  assert.strictEqual(a2.maxTombDeletedAt, 777);
  db.setKV(d, "ia_settings_updatedAt", "999");
  assert.strictEqual(db.signatureAggregates(d).settingsUpdatedAt, 999);
});

console.log("merge-signature: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run** `node tests/merge-signature.test.js` — expect FAIL (`contentSignature` not a function).

- [ ] **Step 3: Implement.** In `core/merge.js`, insert immediately before the `if (typeof module ...)` export line:

```js
  // Deterministic signature over the aggregates that can affect a published
  // snapshot. Signature-equality ⇒ republishing would produce identical
  // content: every mutating path bumps one of these (edits stamp updatedAt,
  // deletes add tombstones with deletedAt, settings edits stamp
  // ia_settings_updatedAt). Used by both sides' publish-skip. "v1|" prefix so
  // a future field change can never alias an old signature.
  function contentSignature(agg) {
    agg = (agg && typeof agg === "object") ? agg : {};
    function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
    return "v1|" + n(agg.cards) + "|" + n(agg.saved) + "|" + n(agg.tombstones) + "|" +
      n(agg.maxCardUpdatedAt) + "|" + n(agg.maxSavedUpdatedAt) + "|" + n(agg.maxTombDeletedAt) + "|" + n(agg.settingsUpdatedAt);
  }
```

Extend BOTH export lines with `contentSignature: contentSignature` / `root.contentSignature = contentSignature;` (keep existing exports). Regenerate `pwa/merge.js` (header + verbatim core body).

In `core/db.js`, next to `settingsForSync`, add (and export in `module.exports`):

```js
// Cheap aggregates for the publish-skip signature (see core/merge.js
// contentSignature) — SQL only, no serializeLibrary. updatedAt is a real
// column on cards/saved (ensureColumns migration); tombstones carry deletedAt.
function signatureAggregates(db) {
  const c = db.prepare("SELECT COUNT(*) AS n, MAX(updatedAt) AS m FROM cards").get();
  const s = db.prepare("SELECT COUNT(*) AS n, MAX(updatedAt) AS m FROM saved").get();
  const t = db.prepare("SELECT COUNT(*) AS n, MAX(deletedAt) AS m FROM tombstones").get();
  return {
    cards: Number(c.n) || 0, saved: Number(s.n) || 0, tombstones: Number(t.n) || 0,
    maxCardUpdatedAt: Number(c.m) || 0, maxSavedUpdatedAt: Number(s.m) || 0, maxTombDeletedAt: Number(t.m) || 0,
    settingsUpdatedAt: Number(getKV(db, "ia_settings_updatedAt") || 0) || 0,
  };
}
```

- [ ] **Step 4: Run** `node tests/merge-signature.test.js && node tests/merge-settings.test.js && node tests/merge.test.js && node tests/db.test.js` — all PASS (merge-settings also re-locks the verbatim copy).

- [ ] **Step 5: Commit** `feat(sync): contentSignature + db.signatureAggregates — publish-skip oracle`.

---

### Task 2: Desktop skip logic — core/sync.js

**Files:**
- Modify: `core/sync.js` (`readPeerSnapshots`, `applyMerge` return, `publishSnapshot` return, `runSync`)
- Create: `tests/sync-skip.test.js`

**Interfaces:**
- Consumes: `contentSignature` (require from `./merge` — extend the existing destructure), `db.signatureAggregates`, `db.getKV/setKV`.
- Produces: `readPeerSnapshots(syncDir, selfDeviceId, seenByDevice?)` → `{peers, skewSkipped, peersSkipped}` (3rd param optional — existing callers/tests unaffected); `applyMerge` return gains `deferred`; `publishSnapshot` return gains `imageFailures`; `runSync` result gains `peersSkipped` + `publishSkipped`. KV keys: `ia_peer_seen_<deviceId>`, `ia_last_publish_sig`, `ia_last_publish_clean` ("1"/"0").

- [ ] **Step 1: Write the failing test** — create `tests/sync-skip.test.js` (two-store e2e, pattern of `tests/sync-settings.test.js`; `newStore()` helper making tmp store dirs with `images/`):

```js
// tests/sync-skip.test.js — watermark + signature skipping (desktop).
// Safety property under test: skips NEVER change what a cycle would have
// produced — they only avoid re-reading/re-writing bytes that provably
// didn't change. Every doubt-path must fall back to full behavior.
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const db = require("../core/db.js");
const sync = require("../core/sync.js");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }
function mkCtx(root, name) { const s = path.join(root, name); fs.mkdirSync(path.join(s, "images"), { recursive: true }); return { db: db.openDb(s), storeDir: s }; }
const noBackup = function () {};

run("second no-change cycle skips peer re-read AND publish; a real edit un-skips both", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const A = mkCtx(root, "A"), B = mkCtx(root, "B");
  db.upsertCard(A.db, { id: "a1", url: "http://a/1", ts: 1 });

  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  const r1 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r1.peersSkipped, 0, "first sight of A must full-read");
  assert.strictEqual(r1.publishSkipped, false, "first publish must run");
  assert.ok(db.allCards(B.db).some(c => c.id === "a1"), "a1 merged into B");

  const bSnap = path.join(syncDir, "devB", "snapshot.json");
  const mtime1 = fs.statSync(bSnap).mtimeMs;
  const r2 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r2.peersSkipped, 1, "unchanged A must be skipped (watermark)");
  assert.strictEqual(r2.publishSkipped, true, "unchanged B must not republish");
  assert.strictEqual(fs.statSync(bSnap).mtimeMs, mtime1, "snapshot.json untouched on skip");

  db.upsertCard(A.db, { id: "a2", url: "http://a/2", ts: 2 });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  const r3 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r3.peersSkipped, 0, "changed A must be re-read");
  assert.ok(db.allCards(B.db).some(c => c.id === "a2"), "a2 arrived");
  assert.strictEqual(r3.publishSkipped, false, "merge applied → B must republish");
});

run("deferred upsert (peer image missing) blocks watermark advance → peer re-read next cycle heals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip2-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const A = mkCtx(root, "A"), B = mkCtx(root, "B");
  // a1 references an idb: image that does NOT exist in A's store → after A
  // publishes, B's merge defers the upsert (image uncopyable).
  db.upsertCard(A.db, { id: "a1", url: "http://a/1", ts: 1, img: "idb:a1" });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });

  const r1 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.ok(!db.allCards(B.db).some(c => c.id === "a1"), "a1 deferred (no image)");
  const r2 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r2.peersSkipped, 0, "dirty cycle must NOT advance the watermark — peer re-read");

  // heal: give A the image file and republish (content unchanged → force via edit)
  fs.writeFileSync(path.join(A.storeDir, "images", "a1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  db.upsertCard(A.db, { id: "a1", url: "http://a/1b", ts: 1, img: "idb:a1" });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.ok(db.allCards(B.db).some(c => c.id === "a1"), "a1 healed after image appeared");
  const r4 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r4.peersSkipped, 1, "clean cycle finally advances the watermark");
});

run("readPeerSnapshots without seenByDevice (old callers) behaves exactly as before", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip3-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const A = mkCtx(root, "A");
  db.upsertCard(A.db, { id: "a1", url: "http://a/1", ts: 1 });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  const rp = sync.readPeerSnapshots(syncDir, "devB");
  assert.strictEqual(rp.peers.length, 1);
  assert.strictEqual(rp.peersSkipped, 0);
});

console.log("sync-skip: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run** `node tests/sync-skip.test.js` — expect FAILs (`peersSkipped` undefined etc.).

- [ ] **Step 3: Implement in core/sync.js.**

Extend the require: `const { mergeSnapshots, contentSignature } = require("./merge");`

`readPeerSnapshots` — add optional 3rd param and the meta-first gate (keep the existing skew/schema filters, restructured into the loop):

```js
function readPeerSnapshots(syncDir, selfDeviceId, seenByDevice) {
  seenByDevice = seenByDevice || {};
  var skewSkipped = 0, peersSkipped = 0;
  var now = Date.now();
  var peers = [];
  peerDirs(syncDir, selfDeviceId).forEach(function (p) {
    // Peer-skip: meta.json is tiny and written LAST (the torn-write completion
    // marker), so an unchanged publishedAt proves the whole folder is unchanged
    // — the multi-MB snapshot read/parse is skipped. Watermarks only advance
    // after a CLEAN merge (see runSync), so deferrals always re-read next cycle.
    var seen = seenByDevice[p.deviceId];
    if (seen != null) {
      var meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(p.dir, "meta.json"), "utf8")); } catch (e) { meta = null; }
      if (meta && Number(meta.publishedAt) === Number(seen)) { peersSkipped++; return; }
    }
    var s = readSnapshot(p.dir);
    if (!s) return;
    s = Object.assign({}, s, { dir: p.dir });
    if ((s.schemaVersion | 0) > db.SCHEMA_VERSION) return;
    if (s.publishedAt != null && isFinite(s.publishedAt) && Number(s.publishedAt) - now > MAX_FUTURE_SKEW_MS) {
      skewSkipped++;
      console.error("sync: skipping future-skewed peer snapshot (clock skew) deviceId=" +
        s.deviceId + " dir=" + s.dir + " publishedAt=" + s.publishedAt + " now=" + now);
      return;
    }
    peers.push(s);
  });
  return { peers: peers, skewSkipped: skewSkipped, peersSkipped: peersSkipped };
}
```

(Preserve the existing FORWARD-COMPAT CONTRACT comment block above the schemaVersion check when restructuring.)

`applyMerge` — count deferrals: add `let deferred = 0;` and change the DEFER line to `if (!images.hasImg(ctx.storeDir, id)) { deferred++; continue; }`; include `deferred: deferred` in the return object.

`publishSnapshot` — count copy failures: in the `changedImageIds` loop, `catch (e) { imageFailures++; }` (declare `let imageFailures = 0;` above); return `{ name: deviceId, counts: counts, imageFailures: imageFailures }`.

`runSync` — wire it together (replace the body between `const backupFn = ...` and the final `return`):

```js
  let changed = false, conflicts = 0;
  // Peer watermarks: last fully-merged publishedAt per peer (kv). Unreadable ⇒
  // absent ⇒ full read (safety bias: when in doubt, don't skip).
  const seenByDevice = {};
  try {
    peerDirs(syncDir, opts.deviceId).forEach(function (p) {
      const v = db.getKV(ctx.db, "ia_peer_seen_" + p.deviceId);
      if (v != null && v !== "") seenByDevice[p.deviceId] = Number(v);
    });
  } catch (e) {}
  const rp = readPeerSnapshots(syncDir, opts.deviceId, seenByDevice);
  const peers = rp.peers;
  const skewSkipped = rp.skewSkipped;
  let mergeClean = true;
  if (peers.length) {
    const plan = mergeSnapshots(buildLocal(ctx), peers);
    if ((plan.upserts.length + plan.deletes.length + plan.imageCopies.length) > 0 || plan.settings) {
      let backedUp = true;
      try { backupFn(); } catch (e) { backedUp = false; console.error("sync: safety backup failed, skipping merge this cycle:", e && e.message); }
      if (backedUp) {
        const r = applyMerge(ctx, plan);
        changed = r.changed; conflicts = plan.conflicts;
        mergeClean = (r.deferred | 0) === 0;
      } else {
        mergeClean = false;
      }
    }
  }
  // Advance watermarks for the peers actually read this cycle ONLY when the
  // merge was clean — a deferral must re-read its peer next cycle (the
  // "self-heals next cycle" contract). Skipped peers keep their watermark.
  if (mergeClean) {
    peers.forEach(function (p) {
      if (p.publishedAt != null && isFinite(p.publishedAt)) {
        try { db.setKV(ctx.db, "ia_peer_seen_" + p.deviceId, String(p.publishedAt)); } catch (e) {}
      }
    });
  }
  let publishedAt = null, publishSkipped = false;
  if (opts.publish !== false) {
    let lastSig = null, lastClean = false;
    try { lastSig = db.getKV(ctx.db, "ia_last_publish_sig"); lastClean = db.getKV(ctx.db, "ia_last_publish_clean") === "1"; } catch (e) {}
    const sig = contentSignature(db.signatureAggregates(ctx.db));
    if (sig === lastSig && lastClean && !changed) {
      publishSkipped = true;   // identical content already published cleanly — zero writes
    } else {
      fs.mkdirSync(syncDir, { recursive: true });
      const pub = publishSnapshot(ctx, syncDir, opts.deviceId, opts.deviceLabel);
      publishedAt = Date.now();
      try {
        // Recompute AFTER the publish so the stored sig matches exactly what
        // was serialized (the merge above may have been the change).
        db.setKV(ctx.db, "ia_last_publish_sig", contentSignature(db.signatureAggregates(ctx.db)));
        db.setKV(ctx.db, "ia_last_publish_clean", (pub.imageFailures | 0) === 0 ? "1" : "0");
      } catch (e) {}
    }
  }
  return { changed: changed, conflicts: conflicts, skewSkipped: skewSkipped, peersSkipped: rp.peersSkipped, publishSkipped: publishSkipped, peers: peers.map(function (p) { return { deviceId: p.deviceId, deviceLabel: p.deviceLabel, publishedAt: p.publishedAt }; }), publishedAt: publishedAt };
```

- [ ] **Step 4: Run** `node tests/sync-skip.test.js && node tests/sync-settings.test.js && node tests/db-sync.test.js && node tests/sync-snapshot.test.js && node tests/synctimers.test.js && node tests/sync-endpoints.test.js && node tests/sync-readonly.test.js` — all PASS. If an existing test asserts unconditional publish, update it to the new contract citing the spec.

- [ ] **Step 5: Commit** `feat(sync): desktop peer-skip watermarks + signature publish-skip`.

---

### Task 3: PWA skip logic — pwa/sync-pwa.js + SHELL_CACHE

**Files:**
- Modify: `pwa/sync-pwa.js` (`readPeers`, `applyMergeToLocal` return, `publishSnapshot`, `runSyncCycle`)
- Modify: `pwa/sw.js` (SHELL_CACHE v23 → v24)
- Create: `tests/pwa-sync-skip.test.js`

**Interfaces:**
- Consumes: browser globals `contentSignature` (from Task 1's regenerated `pwa/merge.js`), `Dbx.dbxDownload`, `idb.kvGet/kvSet`.
- Produces: `readPeers` returns extra `peersSkipped`; `applyMergeToLocal` returns extra `imagesFailed`; `publishSnapshot(accessToken, deviceId, deviceLabel, onProgress, mergeChanged)` may return `{skipped:true}`, else gains `uploadFailures`; `runSyncCycle` result gains `peersSkipped` + `publishSkipped`. Idb kv keys: `_pwa_peer_seen_<deviceId>`, `_pwa_last_publish_sig`, `_pwa_last_publish_clean` (boolean), `_pwa_published_imgids` (array).

- [ ] **Step 1: Write the failing test** — create `tests/pwa-sync-skip.test.js` (source-scan with the standard `grab()` helper — copy it from `tests/pwa-sync-settings-wiring.test.js`):

```js
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
```

- [ ] **Step 2: Run** `node tests/pwa-sync-skip.test.js` — expect FAILs.

- [ ] **Step 3: Implement in pwa/sync-pwa.js.**

`readPeers` — inside the per-device loop, BEFORE `readFullPeerSnapshot`:

```js
      // Peer-skip: meta.json is tiny and written LAST (the torn-write completion
      // marker) — an unchanged publishedAt proves the folder is unchanged, so the
      // multi-MB snapshot download and the peer's images listing are skipped.
      // Watermarks only advance after a CLEAN cycle (see runSyncCycle), so any
      // deferral re-reads the peer next cycle. kv errors ⇒ treat as never-seen.
      let seen = null;
      try { seen = await idb.kvGet("_pwa_peer_seen_" + deviceId); } catch (e) { seen = null; }
      if (seen != null) {
        let meta = null;
        try {
          meta = JSON.parse(await Dbx.dbxDownload(accessToken, `${SYNC_ROOT}/${deviceId}/meta.json`));
        } catch (e) {
          if (e && e.code === "AUTH_EXPIRED") throw e; // dead token kills the cycle here too
          meta = null; // unreadable meta ⇒ fall through to the full read (which has its own handling)
        }
        if (meta && Number(meta.publishedAt) === Number(seen)) { peersSkipped++; continue; }
      }
```

Declare `let peersSkipped = 0;` next to `partialFailures`, return it from both return sites (`{ peers: [], skewSkipped: 0, partialFailures: [], peersSkipped: 0 }` for the path/not_found early return).

`applyMergeToLocal` — extend the return: `return { changed, upserts: upsertsApplied, deletes: plan.deletes.length, settings: settingsApplied, imagesFailed: imagesFailed };`

`publishSnapshot` — add 5th param `mergeChanged`; after loading the rows (which are needed either way) and BEFORE `listDeviceImageIds`:

```js
    // Publish-skip: identical content already published cleanly ⇒ zero network.
    // Gate on mergeChanged too (belt and braces — an applied merge always moves
    // the signature). kv errors ⇒ publish fully (doubt bias).
    const agg = {
      cards: cardRows.length, saved: savedRows.length, tombstones: tombRows.length,
      maxCardUpdatedAt: cardRows.reduce((m, r) => Math.max(m, Number(r.updatedAt) || 0), 0),
      maxSavedUpdatedAt: savedRows.reduce((m, r) => Math.max(m, Number(r.updatedAt) || 0), 0),
      maxTombDeletedAt: tombRows.reduce((m, r) => Math.max(m, Number(r.deletedAt) || 0), 0),
      settingsUpdatedAt: Number(settingsUpdatedAt) || 0,
    };
    const sig = contentSignature(agg); // pwa/merge.js — global, like mergeSnapshots
    let lastSig = null, lastClean = false;
    try { lastSig = await idb.kvGet("_pwa_last_publish_sig"); lastClean = (await idb.kvGet("_pwa_last_publish_clean")) === true; } catch (e) {}
    if (!mergeChanged && sig === lastSig && lastClean) {
      console.log("sync: publishSnapshot — content unchanged since last clean publish, skipping");
      return { skipped: true };
    }
```

Own-images cache replacing the unconditional listing:

```js
    let cachedIds = null;
    try { cachedIds = await idb.kvGet("_pwa_published_imgids"); } catch (e) { cachedIds = null; }
    const alreadyPublished = Array.isArray(cachedIds)
      ? new Set(cachedIds)
      : new Set(await Dbx.listDeviceImageIds(accessToken, deviceId)); // seed once (or after any cache error)
```

In `uploadWorker`, count failures and record successes: `let uploadFailures = 0;` declared beside `uploadedCount`; in the catch `uploadFailures++;`, and on success (after the `dbxUpload` resolves) `alreadyPublished.add(id);`. After the upload wave (before the snapshot upload):

```js
    // Persist the cache after the wave: successful ids stick even if the cycle
    // fails later. A stale/missing entry only ever costs one redundant upload
    // (Dropbox overwrite mode is idempotent) — never a missing file.
    try { await idb.kvSet("_pwa_published_imgids", [...alreadyPublished]); } catch (e) {}
```

After the meta.json upload, store the skip state and extend the return:

```js
    try {
      await idb.kvSet("_pwa_last_publish_sig", sig);
      await idb.kvSet("_pwa_last_publish_clean", uploadFailures === 0);
    } catch (e) {}
    return { publishedAt, counts, uploadFailures };
```

`runSyncCycle` — thread it through:
- destructure `peersSkipped` from `readPeers` (both the success path and default it to 0 in failure paths);
- capture `imagesFailed` from `applyMergeToLocal`'s result (`let imagesFailed = 0;` … `imagesFailed = r.imagesFailed | 0;`);
- after the merge phase, advance watermarks:

```js
      // Advance peer watermarks ONLY after a clean cycle (no deferred images,
      // no per-peer read failures) — a dirty cycle must re-read its peers.
      if (imagesFailed === 0 && partialFailures.length === 0) {
        for (const p of peers) {
          if (p.publishedAt != null && isFinite(p.publishedAt)) {
            try { await idb.kvSet("_pwa_peer_seen_" + p.deviceId, Number(p.publishedAt)); } catch (e) {}
          }
        }
      }
```

- pass `changed` into publish: `publishResult = await publishSnapshot(accessToken, deviceId, deviceLabel, cb, changed);`
- success return gains: `peersSkipped: peersSkipped | 0, publishSkipped: !!(publishResult && publishResult.skipped),` and `published` becomes `!!(publishResult && publishResult.publishedAt)`.

`pwa/sw.js`: `interests-pwa-shell-v23` → `interests-pwa-shell-v24`.

- [ ] **Step 4: Run** `node tests/pwa-sync-skip.test.js && node tests/pwa-sync-readpeers.test.js && node tests/pwa-sync-runcycle.test.js && node tests/pwa-sync-settings-wiring.test.js && node tests/pwa-storage-sync.test.js && node tests/syntax-check.js` — all PASS (update any existing assertion that hard-codes the old return shapes, citing the spec).

- [ ] **Step 5: Commit** `feat(pwa): peer-skip watermarks, signature publish-skip, published-images cache`.

---

### Task 4 (controller): verification + release

- [ ] Full suite `node tests/run.js` → ALL PASS.
- [ ] data-safety-reviewer agent over `git diff <base>..HEAD -- core/ pwa/ tests/` — the watermark-advancement rule is the review focus (can a skip ever hide un-merged peer data?). Fix findings, re-run suite.
- [ ] `docs/BACKLOG.md`: add a v1.12.23 entry (pattern of the v1.12.22 entry).
- [ ] `package.json` 1.12.22 → 1.12.23, commit `release: v1.12.23 — sync skip-work optimization`, push, verify the release build (`gh run watch`) and the Pages deploy; confirm deployed `sw.js` shows v24.
- [ ] Remind the user: install v1.12.23 on both laptops; the PWA updates itself on next two launches.
