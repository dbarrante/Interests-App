// tests/notion-store-adapter.test.js — Store.getNotionStatus / setNotionConfig / exportToNotion
// against the /api/notion-config + /api/notion/export routes built in Tasks 1+3.
const assert = require("assert");
let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

// Mirrors tests/storage-adapter.test.js's loadStoreWithFetch harness: load web/storage.js
// fresh in a vm sandbox with a stubbed fetch, so Store (which only attaches when fetch
// exists) is available without a real server.
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
  function stubError(status) {
    return async function (url, opts) {
      calls.push({ url, opts });
      return { ok: false, status: status, json: async () => ({ error: "boom" }) };
    };
  }

  await run("Store.getNotionStatus GETs /api/notion-config and returns {hasToken, hasParent}", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ hasToken: true, hasParent: false })));
    const r = await Store.getNotionStatus();
    assert.ok(calls[0].url.endsWith("/api/notion-config"));
    assert.strictEqual((calls[0].opts && calls[0].opts.method) || "GET", "GET");
    assert.deepStrictEqual(r, { hasToken: true, hasParent: false });
  });

  await run("Store.setNotionConfig({parentPageId}) POSTs a body with ONLY parentPageId", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, hasToken: false, hasParent: true })));
    const r = await Store.setNotionConfig({ parentPageId: "p" });
    assert.ok(calls[0].url.endsWith("/api/notion-config"));
    assert.strictEqual(calls[0].opts.method, "POST");
    const sentBody = JSON.parse(calls[0].opts.body);
    assert.deepStrictEqual(sentBody, { parentPageId: "p" }, "body must not add/default a 'token' key");
    assert.ok(!Object.prototype.hasOwnProperty.call(sentBody, "token"), "token key must be absent, not present-as-empty");
    assert.deepStrictEqual(r, { ok: true, hasToken: false, hasParent: true });
  });

  await run("Store.setNotionConfig({token, parentPageId}) POSTs a body with BOTH keys", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, hasToken: true, hasParent: true })));
    const r = await Store.setNotionConfig({ token: "t", parentPageId: "p" });
    const sentBody = JSON.parse(calls[0].opts.body);
    assert.deepStrictEqual(sentBody, { token: "t", parentPageId: "p" });
    assert.deepStrictEqual(r, { ok: true, hasToken: true, hasParent: true });
  });

  await run("Store.setNotionConfig({token}) alone omits parentPageId entirely", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, hasToken: true, hasParent: false })));
    await Store.setNotionConfig({ token: "t" });
    const sentBody = JSON.parse(calls[0].opts.body);
    assert.deepStrictEqual(sentBody, { token: "t" });
    assert.ok(!Object.prototype.hasOwnProperty.call(sentBody, "parentPageId"));
  });

  await run("Store.exportToNotion POSTs /api/notion/export with payload as the body", async () => {
    calls = [];
    const payload = { title: "T", url: "http://x.test/", article: "body text", qa: [{ q: "q1", a: "a1" }] };
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, pageUrl: "https://notion.so/abc" })));
    const r = await Store.exportToNotion(payload);
    assert.ok(calls[0].url.endsWith("/api/notion/export"));
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), payload);
    assert.deepStrictEqual(r, { ok: true, pageUrl: "https://notion.so/abc" });
  });

  await run("Store.exportToNotion returns a failure shape as-is ({ok:false, error|reason})", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: false, error: "no_token" })));
    const r = await Store.exportToNotion({ title: "T" });
    assert.deepStrictEqual(r, { ok: false, error: "no_token" });
  });

  await run("Store.getNotionStatus rejects on a non-2xx response (same as other jget methods)", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stubError(500));
    let threw = false;
    try { await Store.getNotionStatus(); } catch (e) { threw = true; assert.ok(/GET .*\/api\/notion-config -> 500/.test(e.message)); }
    assert.ok(threw, "expected getNotionStatus to reject on HTTP error");
  });

  await run("Store.setNotionConfig rejects on a non-2xx response (same as other jsend methods)", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stubError(400));
    let threw = false;
    try { await Store.setNotionConfig({ token: "t" }); } catch (e) { threw = true; assert.ok(/POST .*\/api\/notion-config -> 400/.test(e.message)); }
    assert.ok(threw, "expected setNotionConfig to reject on HTTP error");
  });

  await run("Store.exportToNotion rejects on a non-2xx response (same as other jsend methods)", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stubError(502));
    let threw = false;
    try { await Store.exportToNotion({ title: "T" }); } catch (e) { threw = true; assert.ok(/POST .*\/api\/notion\/export -> 502/.test(e.message)); }
    assert.ok(threw, "expected exportToNotion to reject on HTTP error");
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
