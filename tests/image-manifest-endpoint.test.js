// tests/image-manifest-endpoint.test.js — Task 3 (v1.10.0 iPhone-sync prep):
// GET /api/images manifest endpoint + GET /api/img/:id honest (sniffed)
// Content-Type. Boots the real Express app on an ephemeral loopback port
// (same pattern as delta-api.test.js).
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb } = require("../core/db.js");
const images = require("../core/images.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-imgmanifest-"));
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

// 1x1 red pixel JPEG, base64 (same fixture as tests/images.test.js)
const PIX_B64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const PIX_DATAURL = "data:image/jpeg;base64," + PIX_B64;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

(async function () {
  const store = newStore();
  const db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: function () { return store; }, setStorePath: function () {}, reopen: function () { return openDb(ctx.storeDir); } };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("GET /api/images on empty store -> {ok:true, images:[]}", async () => {
    const res = await fetch(base + "/api/images");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.images, []);
  });

  await run("GET /api/images lists seeded images with id/size/type", async () => {
    images.putImg(store, "jpegid", PIX_DATAURL);
    fs.writeFileSync(images.imgPath(store, "pngid"), PNG_HEADER);

    const res = await fetch(base + "/api/images");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.images.length, 2);
    const byId = {}; body.images.forEach((im) => { byId[im.id] = im; });
    assert.strictEqual(byId.jpegid.type, "image/jpeg");
    assert.strictEqual(byId.jpegid.size, Buffer.from(PIX_B64, "base64").length);
    assert.strictEqual(byId.pngid.type, "image/png");
    assert.strictEqual(byId.pngid.size, PNG_HEADER.length);
  });

  await run("GET /api/img/:id on PNG-bytes-under-.jpg-name -> Content-Type image/png", async () => {
    const res = await fetch(base + "/api/img/pngid");
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").indexOf("image/png") === 0, "expected image/png, got " + res.headers.get("content-type"));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepStrictEqual(buf, PNG_HEADER);
  });

  await run("GET /api/img/:id on real JPEG -> Content-Type image/jpeg (unchanged behavior)", async () => {
    const res = await fetch(base + "/api/img/jpegid");
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").indexOf("image/jpeg") === 0);
  });

  await run("GET /api/img/:id on missing id -> 404 (unchanged)", async () => {
    const res = await fetch(base + "/api/img/missingid");
    assert.strictEqual(res.status, 404);
  });

  await run("GET /api/img/:id on invalid id -> 400 (unchanged)", async () => {
    const res = await fetch(base + "/api/img/" + encodeURIComponent("../evil"));
    assert.strictEqual(res.status, 400);
  });

  await new Promise((resolve) => srv.close(resolve));
  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
