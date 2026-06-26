const assert = require("assert");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { openDb } = require("../core/db");
const { createServer } = require("../core/server");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cap-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

// Mount createServer() on an ephemeral port; return {base, close, db, storeDir}.
function mount(storeDir) {
  const db = openDb(storeDir);
  const app = createServer({
    db, storeDir,
    getStorePath: () => storeDir,
    setStorePath: () => {},
  });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: "http://127.0.0.1:" + port,
        db, storeDir,
        close: () => new Promise((r) => server.close(() => { try { db.close(); } catch (e) {} r(); })),
      });
    });
  });
}

(async () => {
  await t("POST two captures then GET returns both; second GET returns empty", async () => {
    const storeDir = tmpStore();
    const m = await mount(storeDir);
    try {
      const a = { url: "https://example.com/a", id: "card-a", screenshot: "data:image/jpeg;base64,AAAA", ts: 1 };
      const b = { url: "https://example.com/b", id: "card-b", screenshot: "data:image/jpeg;base64,BBBB", ts: 2 };

      let r = await fetch(m.base + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture: a }),
      });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(await r.json(), { ok: true });

      r = await fetch(m.base + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture: b }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });

      r = await fetch(m.base + "/api/captures");
      const got = await r.json();
      assert.strictEqual(got.captures.length, 2);
      assert.strictEqual(got.captures[0].url, "https://example.com/a");
      assert.strictEqual(got.captures[1].url, "https://example.com/b");

      // the drain cleared the queue — a second GET is empty
      r = await fetch(m.base + "/api/captures");
      assert.deepStrictEqual(await r.json(), { captures: [] });
    } finally { await m.close(); }
  });

  console.log(pass + " passed, " + fail + " failed");
  // On Node v25 / Windows, forcing process.exit() right after node:sqlite db.close()
  // can trip a libuv handle-teardown assertion (abort, exit 127) even though every
  // assertion passed. Force a non-zero exit only on real failures; on success let the
  // event loop drain naturally so the sqlite handle finishes closing cleanly.
  if (fail) process.exit(1);
})();
