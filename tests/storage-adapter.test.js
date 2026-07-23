// tests/storage-adapter.test.js — request/URL building + response mapping for Store
const assert = require("assert");
let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

/* ---- backup/restore/store-location adapter methods ---- */
// Minimal harness: load web/storage.js with a stubbed fetch and a localhost origin.
// (Reuse the Phase-3 loader if present; this self-contained version works standalone.)
function loadStoreWithFetch(fetchImpl) {
  const fs = require("fs"); const path = require("path"); const vm = require("vm");
  const code = fs.readFileSync(path.join(__dirname, "..", "web", "storage.js"), "utf8");
  const sandbox = { window: {}, fetch: fetchImpl, console };
  sandbox.window.location = { origin: "http://localhost:3456" };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.Store || sandbox.Store;
}

(async function () {
  let calls = [];
  function stub(respFor) {
    return async function (url, opts) {
      calls.push({ url, opts });
      const body = respFor(url, opts);
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
  }

  await run("Store.backupNow POSTs /api/backup and returns the result", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, name: "interests-backup-2026-06-26", counts: { imported: 5, saved: 1, images: 4 } })));
    const r = await Store.backupNow();
    assert.ok(calls[0].url.endsWith("/api/backup"));
    assert.strictEqual((calls[0].opts && calls[0].opts.method) || "GET", "POST");
    assert.strictEqual(r.name, "interests-backup-2026-06-26");
  });

  await run("Store.backupNow forwards the destructive-cleanup safety flag", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, verified: true })));
    await Store.backupNow({ safety: true });
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { safety: true });
  });

  await run("Store.listBackups GETs /api/backups and unwraps .backups", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ backups: [{ name: "interests-backup-2026-06-26", date: "2026-06-26", counts: {} }] })));
    const list = await Store.listBackups();
    assert.ok(calls[0].url.endsWith("/api/backups"));
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, "interests-backup-2026-06-26");
  });

  await run("Store.restore POSTs /api/restore with {name}", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true })));
    const r = await Store.restore("interests-backup-2026-06-26");
    assert.ok(calls[0].url.endsWith("/api/restore"));
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { name: "interests-backup-2026-06-26" });
    assert.strictEqual(r.ok, true);
  });

  await run("Store.storeLocation GETs /api/store-location", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ path: "C:\\data", counts: { cards: 5, saved: 1, images: 4 } })));
    const r = await Store.storeLocation();
    assert.ok(calls[0].url.endsWith("/api/store-location"));
    assert.strictEqual(r.path, "C:\\data");
  });

  await run("Store.moveStore POSTs /api/store-location/move with {target}", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, path: "D:\\newdata" })));
    const r = await Store.moveStore("D:\\newdata");
    assert.ok(calls[0].url.endsWith("/api/store-location/move"));
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { target: "D:\\newdata" });
    assert.strictEqual(r.path, "D:\\newdata");
  });

  await run("Store.health GETs /api/health", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ storePath: "C:\\data", counts: { cards: 5, saved: 1, images: 4 }, lastBackup: null })));
    const r = await Store.health();
    assert.ok(calls[0].url.endsWith("/api/health"));
    assert.strictEqual(r.storePath, "C:\\data");
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
