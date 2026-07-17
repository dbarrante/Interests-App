// tests/storemove-int.test.js — move a tmp store to a new tmp dir; assert target has
// db+images, pointer updated, and the SOURCE is still intact (kept until verified).
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ISOLATE the config in a temp APPDATA *before* requiring core/config —
// this test calls config.setStorePath(), and a run killed mid-test used to
// leave the REAL production pointer aimed at a throwaway temp store. That
// exact failure hijacked the installed app's store on 2026-07-14..16 (root
// cause of the 07-16 data-loss event). Same pattern as backup-dropbox-path.
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const backup = require("../core/backup.js");
const { openDb, upsertCard, upsertSaved, counts } = require("../core/db.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-mv-src-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

t("moveStore copies db+images to target, repoints pointer, leaves source intact", () => {
  const orig = config.loadConfig();
  try {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    upsertCard(db, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "idb:c2" });
    upsertSaved(db, { id: "s1", url: "https://x/s", category: "Tips", clipped: 1, image: "idb:s1" });
    images.putImg(store, "c1", TINY_JPG);
    images.putImg(store, "c2", TINY_JPG);
    images.putImg(store, "s1", TINY_JPG);
    config.setStorePath(store);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-mv-dst-"));
    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: config.setStorePath,
      reopen: function () { return openDb(ctx.storeDir); }
    };

    const res = backup.moveStore(target, ctx);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.path, target);

    // target has db + all 3 images
    assert.ok(fs.existsSync(path.join(target, "interests.db")), "target db present");
    assert.strictEqual(images.imageCount(target), 3, "target images present");
    assert.strictEqual(counts(ctx.db).cards, 2, "ctx.db reopened from target");

    // pointer updated
    assert.strictEqual(config.getStorePath(), target, "config pointer repointed");
    assert.strictEqual(ctx.storeDir, target, "ctx.storeDir repointed");

    // SOURCE still intact (kept until verified — and we keep it after, too)
    assert.ok(fs.existsSync(path.join(store, "interests.db")), "source db still present");
    assert.strictEqual(images.imageCount(store), 3, "source images still present");
    ctx.db.close();
  } finally {
    config.saveConfig(orig || {});
  }
});

t("moveStore on a bad target does NOT repoint and keeps both copies", () => {
  const orig = config.loadConfig();
  try {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    config.setStorePath(store);

    // target points at a path under a file (mkdir will fail) → verify cannot pass
    const blocker = fs.mkdtempSync(path.join(os.tmpdir(), "ia-mv-blk-"));
    const filePath = path.join(blocker, "afile");
    fs.writeFileSync(filePath, "x");
    const target = path.join(filePath, "store"); // child of a file → unwritable

    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: config.setStorePath,
      reopen: function () { return openDb(ctx.storeDir); }
    };
    const res = backup.moveStore(target, ctx);
    assert.strictEqual(res.ok, false, "bad target → not ok");
    assert.strictEqual(ctx.storeDir, store, "ctx.storeDir unchanged");
    assert.strictEqual(config.getStorePath(), store, "pointer unchanged");
    assert.strictEqual(images.imageCount(store), 1, "source intact");
    ctx.db.close();
  } finally {
    config.saveConfig(orig || {});
  }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
