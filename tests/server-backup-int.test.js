// tests/server-backup-int.test.js — backup/restore/health endpoints over HTTP
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ISOLATE the config in a temp APPDATA *before* requiring anything that loads
// core/config — this test moves the store via the API, and a killed run used
// to leave the REAL production pointer aimed at a temp dir (root cause of the
// 2026-07-16 data-loss event). Same pattern as backup-dropbox-path.
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const { createServer } = require("../core/server.js");
const { openDb, upsertCard, counts } = require("../core/db.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

let pass = 0, fail = 0;
function t(name) { return name; }
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-store-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise(function (res) {
    const srv = http.createServer(app).listen(0, "127.0.0.1", function () {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}

(async function () {
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-dest-"));
  const orig = config.loadConfig();
  config.saveConfig(Object.assign({}, orig, { backupDir: bdir }));
  try {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);

    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: function () {},
      // Reopen against ctx.storeDir (not the original `store` var) — moveStore()
      // repoints ctx.storeDir before calling reopen(), matching core/appctx.js.
      reopen: function () { return openDb(ctx.storeDir); }
    };
    const app = createServer(ctx);
    const { srv, base } = await listen(app);

    await run(t("GET /api/health reports store path + counts"), async () => {
      const h = await (await fetch(base + "/api/health")).json();
      assert.strictEqual(h.storePath, store);
      assert.deepStrictEqual(h.counts, { cards: 1, saved: 0, images: 1 });
      assert.strictEqual(h.lastBackup, null);
    });

    let backupName;
    await run(t("POST /api/backup creates a verified dated backup"), async () => {
      const r = await (await fetch(base + "/api/backup", { method: "POST" })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(r.name));
      assert.deepStrictEqual(r.counts, { imported: 1, saved: 0, images: 1 });
      backupName = r.name;
      assert.ok(fs.existsSync(path.join(bdir, r.name, "interests.db")));
    });

    await run(t("GET /api/backups lists the new backup"), async () => {
      const r = await (await fetch(base + "/api/backups")).json();
      assert.ok(Array.isArray(r.backups));
      assert.strictEqual(r.backups[0].name, backupName);
    });

    await run(t("POST /api/backup honors a client-supplied retain count (keep)"), async () => {
      // Seed extra dated-backup fixtures (older dates, matching content so they
      // verify) so rotation has something to actually trim.
      const dc = counts(db);
      const seedCounts = { imported: dc.cards | 0, saved: dc.saved | 0, images: 1 };
      for (const date of ["2020-01-01", "2020-01-02", "2020-01-03"]) {
        const folder = path.join(bdir, "interests-backup-" + date);
        fs.mkdirSync(path.join(folder, "images"), { recursive: true });
        fs.copyFileSync(path.join(store, "interests.db"), path.join(folder, "interests.db"));
        fs.copyFileSync(path.join(store, "images", "c1.jpg"), path.join(folder, "images", "c1.jpg"));
        const stat = fs.statSync(path.join(folder, "images", "c1.jpg"));
        const sha256 = require("crypto").createHash("sha256").update(fs.readFileSync(path.join(folder, "images", "c1.jpg"))).digest("hex");
        fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({
          _counts: seedCounts, _images: [{ name: "c1.jpg", size: stat.size, sha256 }], ts: Date.now(),
        }));
      }
      const before = (await (await fetch(base + "/api/backups")).json()).backups;
      assert.ok(before.length >= 4, "seeded fixtures plus the earlier backup are all present");

      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keep: 1 }),
      })).json();
      assert.strictEqual(r.ok, true);
      const after = (await (await fetch(base + "/api/backups")).json()).backups;
      assert.strictEqual(after.length, 1, "keep:1 rotates down to just the newest (the one this call just made)");
      assert.strictEqual(after[0].name, r.name);
      backupName = r.name; // subsequent tests restore/reference the current newest
    });

    await run(t("POST /api/backup clamps an invalid keep instead of crashing"), async () => {
      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keep: -5 }),
      })).json();
      assert.strictEqual(r.ok, true, "an out-of-range keep value falls back to the default rather than 500ing");
      backupName = r.name;
    });

    await run(t("GET /api/health now shows lastBackup"), async () => {
      const h = await (await fetch(base + "/api/health")).json();
      assert.ok(h.lastBackup && h.lastBackup.name === backupName);
    });

    await run(t("GET /api/health's lastBackup stays the dated snapshot even when the rolling mirror is newer, and lastMirrorAt reports the mirror separately"), async () => {
      // The mirror is only ever produced by core/sync.js's pre-merge gate, not
      // any HTTP route -- create one directly, the same way sync would.
      const backup = require("../core/backup.js");
      backup.updateMirror(ctx.db, store);
      const h = await (await fetch(base + "/api/health")).json();
      assert.ok(h.lastBackup && h.lastBackup.name === backupName,
        "lastBackup must stay the real dated snapshot, not silently become the volatile mirror");
      assert.ok(typeof h.lastMirrorAt === "number" && h.lastMirrorAt > 0,
        "the mirror's own freshness must still be reported, just under its own field");
    });

    await run(t("POST /api/restore round-trips and rebinds ctx.db"), async () => {
      // mutate live to 2 cards, then restore the 1-card backup
      upsertCard(ctx.db, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "" });
      assert.strictEqual(counts(ctx.db).cards, 2);
      const r = await (await fetch(base + "/api/restore", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: backupName })
      })).json();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(counts(ctx.db).cards, 1, "ctx.db rebound to restored 1-card store");

      // The pre-restore safety snapshot is the ONLY way back from a mistaken
      // restore, so it must contain the state that was live a moment ago (2
      // cards) — not an empty or stale file. It is written by stageRestore,
      // which has no db handle and therefore copies interests.db as-is, so the
      // route must flush the WAL first; without that checkpoint this snapshot
      // silently loses every write still sitting in the -wal sidecar (on a
      // young store, that is the entire database, schema included).
      const bdir2 = require("../core/backup.js").dropboxBackupDir();
      const snaps = fs.readdirSync(bdir2).filter((n) => n.indexOf("interests-backup-before-restore-") === 0);
      assert.strictEqual(snaps.length, 1, "exactly one pre-restore safety snapshot");
      const snapDb = openDb(path.join(bdir2, snaps[0]));
      assert.strictEqual(counts(snapDb).cards, 2,
        "the safety snapshot must capture the PRE-restore live store (2 cards), not a WAL-lagged copy");
      snapDb.close();
    });

    await run(t("GET /api/store-location reports path + counts"), async () => {
      const r = await (await fetch(base + "/api/store-location")).json();
      assert.strictEqual(r.path, ctx.storeDir);
      assert.ok(r.counts && typeof r.counts.images === "number");
    });

    await run(t("POST /api/store-location/move relocates the store"), async () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-mv-"));
      const r = await (await fetch(base + "/api/store-location/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target })
      })).json();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.path, target);
      assert.strictEqual(ctx.storeDir, target, "ctx repointed");
      assert.ok(fs.existsSync(path.join(target, "interests.db")), "db at target");
    });

    await run(t("GET /api/cards after restore-over-HTTP still works (ctx.db not stale)"), async () => {
      // write a new card live, back it up, mutate again, then restore that backup —
      // all over HTTP — and confirm reads still work afterward (not a closed handle).
      const putRes = await (await fetch(base + "/api/cards", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cards: [{ id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" }] })
      })).json();
      assert.strictEqual(putRes.ok, true);

      const backupRes = await (await fetch(base + "/api/backup", { method: "POST" })).json();
      assert.strictEqual(backupRes.ok, true);
      const freshBackupName = backupRes.name;

      const putRes2 = await (await fetch(base + "/api/cards", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cards: [
            { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" },
            { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "" }
          ]
        })
      })).json();
      assert.strictEqual(putRes2.ok, true);

      const restoreRes = await (await fetch(base + "/api/restore", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: freshBackupName })
      })).json();
      assert.strictEqual(restoreRes.ok, true);

      const getResp = await fetch(base + "/api/cards");
      assert.strictEqual(getResp.status, 200, "GET /api/cards must not 500 after restore");
      const got = await getResp.json();
      assert.ok(Array.isArray(got.cards));
      assert.strictEqual(got.cards.length, 1, "cards reflect the restored (1-card) backup");
      assert.strictEqual(got.cards[0].id, "c1");
    });

    await run(t("PUT/GET /api/img/:id after a store move writes under the NEW store dir"), async () => {
      const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-mv2-"));
      const moveRes = await (await fetch(base + "/api/store-location/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: newDir })
      })).json();
      assert.strictEqual(moveRes.ok, true);
      assert.strictEqual(ctx.storeDir, newDir);

      const putImgRes = await (await fetch(base + "/api/img/c3", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: TINY_JPG })
      })).json();
      assert.strictEqual(putImgRes.ok, true);

      assert.ok(
        fs.existsSync(path.join(newDir, "images", "c3.jpg")),
        "image must be written under the NEW store dir, not the abandoned one"
      );

      const getImgResp = await fetch(base + "/api/img/c3");
      assert.strictEqual(getImgResp.status, 200, "GET /api/img must find the image at the new store dir");
    });

    await run(t("POST /api/store-location/move (no-worker fallback) relays an actionable error on count mismatch, not a bare {ok:false}"), async () => {
      // ctx here has no ctx.storeWorker, so this route takes the synchronous
      // no-worker fallback branch (backup.moveStore(t, ctx) called directly).
      // A residual leftover file in the target — as if left over from an
      // earlier aborted/failed move — makes backup.moveStore's post-copy
      // count check fail, and this test confirms the route actually relays
      // that failure's `error` field instead of leaving it undefined.
      const preMoveDir = ctx.storeDir;
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-mv3-"));
      fs.mkdirSync(path.join(target, "images"), { recursive: true });
      fs.writeFileSync(path.join(target, "images", "leftover.jpg"), "residue from an earlier attempt");

      const r = await (await fetch(base + "/api/store-location/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target })
      })).json();
      assert.strictEqual(r.ok, false, "count mismatch → not ok");
      assert.ok(r.error && typeof r.error === "string" && r.error.length > 0, "route relays an actionable error string");
      assert.ok(r.error.indexOf(target) !== -1, "error names the offending target");
      assert.strictEqual(ctx.storeDir, preMoveDir, "refused move must not repoint ctx");
    });

    // NOTE: by this point in the file, several earlier tests have already
    // created/rewritten today's dated backup — do NOT assume the shared
    // folder is empty. This priming call establishes a KNOWN-fresh baseline
    // regardless of whatever state came before, by making an ordinary
    // no-freshWithinMs call (which, like every earlier test in this file,
    // must always actually run).
    let freshTestBackupName, freshTestMetaPath, freshTestTsBefore;
    await run(t("POST /api/backup (priming call, no freshWithinMs) establishes a known-fresh baseline"), async () => {
      const r = await (await fetch(base + "/api/backup", { method: "POST" })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(!r.skipped, "a call with no freshWithinMs must never skip");
      assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(r.name));
      freshTestBackupName = r.name;
      freshTestMetaPath = path.join(bdir, freshTestBackupName, "meta.json");
      freshTestTsBefore = JSON.parse(fs.readFileSync(freshTestMetaPath, "utf8")).ts;
      assert.ok(typeof freshTestTsBefore === "number");
    });

    await run(t("POST /api/backup with freshWithinMs SKIPS when the shared folder already has a fresh dated backup"), async () => {
      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ freshWithinMs: 24 * 60 * 60 * 1000 }),
      })).json();
      assert.deepStrictEqual(r, { ok: true, skipped: true, reason: "already-fresh", verified: true });
      // Prove runBackup did NOT actually execute again -- a real run rewrites
      // meta.json with a brand new ts (core/backup.js's runBackup always does
      // `ts: Date.now()`), so an unchanged ts proves the skip short-circuited
      // BEFORE any real work, not just that the response happens to look right.
      const tsAfter = JSON.parse(fs.readFileSync(freshTestMetaPath, "utf8")).ts;
      assert.strictEqual(tsAfter, freshTestTsBefore, "meta.json must be untouched by a skipped call");
    });

    await run(t("POST /api/backup with a tiny freshWithinMs does NOT skip (the existing backup no longer counts as fresh)"), async () => {
      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ freshWithinMs: 1 }),
      })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(!r.skipped, "an interval of 1ms cannot possibly still be fresh");
      assert.strictEqual(r.name, freshTestBackupName, "same calendar day -> same dated folder name, just rewritten");
      const tsAfterRealRun = JSON.parse(fs.readFileSync(freshTestMetaPath, "utf8")).ts;
      assert.ok(tsAfterRealRun > freshTestTsBefore, "a real run must rewrite meta.json with a newer ts");
    });

    await run(t("POST /api/backup with freshWithinMs is ignored for a safety backup -- safety backups never skip"), async () => {
      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ freshWithinMs: 365 * 24 * 60 * 60 * 1000, safety: true }),
      })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(!r.skipped, "a safety backup must always actually run, regardless of freshWithinMs");
      assert.ok(/^interests-backup-before-cleanup-/.test(r.name), "safety backups use their own naming, confirming the safety path really ran");
    });

    await new Promise(function (res) { srv.close(res); });
    try { ctx.db.close(); } catch (e) {}
  } finally {
    config.saveConfig(orig || {});
  }
  console.log(pass + " passed, " + fail + " failed");
  // Let libuv finish finalizing the sqlite handle that restore closed in-request
  // before process.exit (avoids a Windows UV_HANDLE_CLOSING abort that would mask
  // the real pass/fail exit code).
  await new Promise(function (res) { setTimeout(res, 50); });
  process.exit(fail ? 1 : 0);
})();
