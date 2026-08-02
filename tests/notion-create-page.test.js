const assert = require("assert");
const notion = require("../core/notion");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  const realFetch = global.fetch;

  await t("success: posts to /v1/pages with the right headers, returns {ok:true, pageUrl}", async () => {
    let capturedUrl, capturedOpts;
    global.fetch = async (url, opts) => {
      capturedUrl = url; capturedOpts = opts;
      return { ok: true, json: async () => ({ url: "https://notion.so/abc123" }) };
    };
    const r = await notion.createPage("secret_x", "parent-1", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pageUrl, "https://notion.so/abc123");
    assert.strictEqual(capturedUrl, "https://api.notion.com/v1/pages");
    assert.strictEqual(capturedOpts.headers["Authorization"], "Bearer secret_x");
    assert.ok(capturedOpts.headers["Notion-Version"], "must send a Notion-Version header");
    const body = JSON.parse(capturedOpts.body);
    assert.deepStrictEqual(body.parent, { page_id: "parent-1" });
  });

  await t("Notion 4xx -> {ok:false, error} carrying Notion's own message, not a raw exception", async () => {
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ message: "path failed validation" }) });
    const r = await notion.createPage("secret_x", "bad-parent", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /path failed validation/);
  });

  await t("network throw -> {ok:false, error}, never throws", async () => {
    global.fetch = async () => { throw new Error("network down"); };
    const r = await notion.createPage("secret_x", "p", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t("malformed qa entry (null) -> resolves {ok:false, error}, never rejects", async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ url: "https://notion.so/should-not-be-reached" }) });
    const r = await notion.createPage("secret_x", "p", { title: "T", url: "", article: null, qa: [null] });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  await t("mixed-garbage qa array (string, number, then null) -> resolves {ok:false, error}, never rejects", async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ url: "https://notion.so/should-not-be-reached" }) });
    const r = await notion.createPage("secret_x", "p", { title: "T", url: "", article: null, qa: ["oops", 42, null] });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  // Fix 3 (final-review fix wave): pin the outbound fetch's redirect behavior.
  // Without an explicit `redirect`, fetch defaults to "follow" — whether the
  // Authorization: Bearer <token> header survives a cross-origin redirect then
  // depends on the JS runtime's own stripping behavior, which is verified on
  // recent Node but not on every Electron/Node build this app ships against.
  // "error" fails closed instead: if api.notion.com ever redirects, the call
  // fails rather than the runtime deciding whether to forward the token.
  await t("createPage pins redirect:'error' so a redirect can never forward the Bearer token", async () => {
    let capturedOpts;
    global.fetch = async (url, opts) => {
      capturedOpts = opts;
      return { ok: true, json: async () => ({ url: "https://notion.so/abc123" }) };
    };
    await notion.createPage("secret_x", "p", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(capturedOpts.redirect, "error", "fetch options must pin redirect:'error' (fails closed)");
  });

  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
