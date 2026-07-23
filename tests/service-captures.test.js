const assert = require("assert");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { openDb } = require("../core/db");
const { setKV } = require("../core/db");
const { createServer } = require("../core/server");
const captureQueue = require("../core/capture-queue");

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
  await t("POST two captures then GET claims both; ACK makes the mailbox empty", async () => {
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
      assert.ok(got.captures[0]._captureId);
      assert.ok(got.captures[0]._captureLease);

      // the drain cleared the queue — a second GET is empty
      r = await fetch(m.base + "/api/captures");
      assert.deepStrictEqual((await r.json()).captures, []);
      r = await fetch(m.base + "/api/captures/ack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: got.captures.map((c) => c._captureId) }),
      });
      assert.strictEqual(r.status, 400, "ACK must prove ownership with the active lease");
      r = await fetch(m.base + "/api/captures/ack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acks: got.captures.map((c) => ({ id: c._captureId, lease: c._captureLease })) }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true, acked: 2 });
      r = await fetch(m.base + "/api/captures");
      assert.deepStrictEqual((await r.json()).captures, []);
    } finally { await m.close(); }
  });

  await t("capture-request POST then GET returns it; POST null clears it", async () => {
    const storeDir = tmpStore();
    const m = await mount(storeDir);
    try {
      // empty store -> null
      let r = await fetch(m.base + "/api/capture-request");
      assert.deepStrictEqual(await r.json(), { request: null });

      const reqObj = { url: "https://example.com/p", id: "card-p", delay: 3000, render: false };
      r = await fetch(m.base + "/api/capture-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: reqObj }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });

      r = await fetch(m.base + "/api/capture-request");
      const got = await r.json();
      assert.strictEqual(got.request.url, "https://example.com/p");
      assert.strictEqual(got.request.id, "card-p");

      // POST null clears it
      r = await fetch(m.base + "/api/capture-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: null }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });
      r = await fetch(m.base + "/api/capture-request");
      assert.deepStrictEqual(await r.json(), { request: null });
    } finally { await m.close(); }
  });

  await t("batch-state and batch-progress round-trip", async () => {
    const storeDir = tmpStore();
    const m = await mount(storeDir);
    try {
      let r = await fetch(m.base + "/api/batch-state");
      assert.deepStrictEqual(await r.json(), { state: null });
      r = await fetch(m.base + "/api/batch-progress");
      assert.deepStrictEqual(await r.json(), { progress: null });

      const state = { items: [{ url: "u1", id: "i1" }], next: 0, total: 1, concurrency: 2 };
      r = await fetch(m.base + "/api/batch-state", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });
      r = await fetch(m.base + "/api/batch-state");
      assert.deepStrictEqual((await r.json()).state.total, 1);

      const progress = { done: 1, total: 1, active: false, ts: 123 };
      r = await fetch(m.base + "/api/batch-progress", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });
      r = await fetch(m.base + "/api/batch-progress");
      assert.deepStrictEqual((await r.json()).progress.done, 1);
    } finally { await m.close(); }
  });

  await t("queue persists across a new createServer() on the same store", async () => {
    const storeDir = tmpStore();

    // first server instance: enqueue one capture, then close everything
    const m1 = await mount(storeDir);
    const cap = { url: "https://example.com/persist", id: "card-persist", screenshot: "data:image/jpeg;base64,CCCC", ts: 9 };
    let r = await fetch(m1.base + "/api/captures", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture: cap }),
    });
    assert.deepStrictEqual(await r.json(), { ok: true });
    await m1.close();   // closes the http server AND the sqlite db (flushes to disk)

    // a fresh createServer() / openDb() on the same store sees the queued capture
    const m2 = await mount(storeDir);
    try {
      r = await fetch(m2.base + "/api/captures");
      const got = await r.json();
      assert.strictEqual(got.captures.length, 1);
      assert.strictEqual(got.captures[0].url, "https://example.com/persist");
      assert.strictEqual(got.captures[0].id, "card-persist");
      const first = got.captures[0];
      r = await fetch(m2.base + "/api/captures/ack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acks: [{ id: first._captureId, lease: first._captureLease }] }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true, acked: 1 });
      // drained — the second instance's queue is now empty
      r = await fetch(m2.base + "/api/captures");
      assert.deepStrictEqual(await r.json(), { captures: [] });
    } finally { await m2.close(); }
  });

  await t("unacknowledged claims become retryable and stale ACKs cannot delete a new lease", async () => {
    const storeDir = tmpStore();
    const database = openDb(storeDir);
    try {
      captureQueue.enqueue(database, { url: "https://example.com/retry" });
      const first = captureQueue.claim(database, 1000)[0];
      assert.ok(first._captureId && first._captureLease);
      assert.deepStrictEqual(captureQueue.claim(database, 1000 + captureQueue.LEASE_MS - 1), []);
      const retry = captureQueue.claim(database, 1000 + captureQueue.LEASE_MS + 1)[0];
      assert.strictEqual(captureQueue.ack(database, [{ id: first._captureId, lease: first._captureLease }]), 0);
      assert.strictEqual(captureQueue.ack(database, [{ id: retry._captureId, lease: retry._captureLease }]), 1);
      assert.deepStrictEqual(captureQueue.claim(database, 1000 + captureQueue.LEASE_MS + 2), []);
    } finally { try { database.close(); } catch (e) {} }
  });

  await t("capture endpoint rejects untrusted origins and malformed payloads", async () => {
    const storeDir = tmpStore();
    const m = await mount(storeDir);
    try {
      let r = await fetch(m.base + "/api/ping", { headers: { Origin: "null" } });
      assert.strictEqual(r.status, 403);
      r = await fetch(m.base + "/api/ping", { headers: { Origin: "chrome-extension://not-an-extension-id" } });
      assert.strictEqual(r.status, 403);
      r = await fetch(m.base + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        body: JSON.stringify({ capture: { screenshot: "data:image/jpeg;base64,AAAA" } }),
      });
      assert.strictEqual(r.status, 400);
    } finally { await m.close(); }
  });

  await t("malformed queue JSON fails closed and remains intact", async () => {
    const storeDir = tmpStore();
    const database = openDb(storeDir);
    try {
      setKV(database, captureQueue.KEY, "{not-json");
      assert.throws(() => captureQueue.read(database), (e) => e && e.code === "CAPTURE_QUEUE_CORRUPT");
      assert.strictEqual(require("../core/db").getKV(database, captureQueue.KEY), "{not-json");
    } finally { try { database.close(); } catch (e) {} }
  });

  console.log(pass + " passed, " + fail + " failed");
  // On Node v25 / Windows, forcing process.exit() right after node:sqlite db.close()
  // can trip a libuv handle-teardown assertion (abort, exit 127) even though every
  // assertion passed. Force a non-zero exit only on real failures; on success let the
  // event loop drain naturally so the sqlite handle finishes closing cleanly.
  if (fail) process.exit(1);
})();
