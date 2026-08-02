// tests/notion-settings-ui.test.js — Task 5: the Notion export Settings UI
// (token + parent-page-id inputs, loadNotionStatus/saveNotionConfig), modeled
// on the existing Safe Browsing key section. The critical contract under test
// is saveNotionConfig's partial-update behavior: Store.setNotionConfig (Task 4)
// must receive a `fields` object where `token` is OMITTED ENTIRELY (not just
// falsy) whenever the token input was left at its NOTION_MASK placeholder —
// otherwise an unmodified token risks being wiped by Task 1's "omitted key
// leaves stored value unchanged" contract every time the user only touches
// the parent-page field.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
async function at(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function getNotionMask(src) {
  const m = /const NOTION_MASK\s*=\s*"([^"]*)"/.exec(src);
  assert.ok(m, "NOTION_MASK constant not found in source");
  return m[1];
}

// Builds a runnable saveNotionConfig() bound to a stubbed document/Store/toast,
// mirroring tests/notion-store-adapter.test.js's sandbox style but purely
// in-memory (no fetch involved — we only care what fields saveNotionConfig
// hands to Store.setNotionConfig).
function runSaveNotionConfig(src, { tokenValue, pageValue }) {
  const mask = getNotionMask(src);
  const body = fn(src, "saveNotionConfig");
  const elements = {
    notionToken: { value: tokenValue },
    notionParentPage: { value: pageValue },
  };
  const document = { getElementById: (id) => (id in elements ? elements[id] : null) };
  let setConfigFields = null;
  const Store = {
    setNotionConfig: async (fields) => { setConfigFields = fields; return { ok: true, hasToken: true, hasParent: true }; },
  };
  const toastCalls = [];
  const toast = (msg) => toastCalls.push(msg);
  let loadCalled = false;
  const loadNotionStatus = () => { loadCalled = true; };
  const factory = new Function(
    "document", "Store", "toast", "NOTION_MASK", "loadNotionStatus",
    body + "\nreturn saveNotionConfig;"
  );
  const saveNotionConfig = factory(document, Store, toast, mask, loadNotionStatus);
  return saveNotionConfig().then(() => ({ setConfigFields, toastCalls, loadCalled, tokenInputValue: elements.notionToken.value }));
}

// Runs the REAL loadNotionStatus() against a stubbed Store.getNotionStatus that
// returns `status`, on a shared `elements` bag the caller supplies (so a
// subsequent saveNotionConfig() call, run against the SAME elements, sees
// whatever loadNotionStatus pre-filled — this is what lets the regression test
// below reproduce "reload, then only touch the token field" without the test
// itself retyping the parent-page value).
function runLoadNotionStatus(src, elements, status) {
  const body = fn(src, "loadNotionStatus");
  const document = { getElementById: (id) => (id in elements ? elements[id] : null) };
  const Store = { getNotionStatus: async () => status };
  const mask = getNotionMask(src);
  const factory = new Function("document", "Store", "NOTION_MASK", body + "\nreturn loadNotionStatus;");
  const loadNotionStatus = factory(document, Store, mask);
  return loadNotionStatus();
}

// Same sandboxed saveNotionConfig runner as runSaveNotionConfig, but operating
// on a caller-supplied `elements` bag instead of building a fresh one, so it
// can be chained after runLoadNotionStatus on the same simulated DOM.
function runSaveNotionConfigOn(src, elements) {
  const mask = getNotionMask(src);
  const body = fn(src, "saveNotionConfig");
  const document = { getElementById: (id) => (id in elements ? elements[id] : null) };
  let setConfigFields = null;
  const Store = {
    setNotionConfig: async (fields) => { setConfigFields = fields; return { ok: true, hasToken: true, hasParent: true }; },
  };
  const toast = () => {};
  const loadNotionStatus = () => {};
  const factory = new Function(
    "document", "Store", "toast", "NOTION_MASK", "loadNotionStatus",
    body + "\nreturn saveNotionConfig;"
  );
  const saveNotionConfig = factory(document, Store, toast, mask, loadNotionStatus);
  return saveNotionConfig().then(() => setConfigFields);
}

(async function () {
  for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
    t(label + ": a #notionToken input exists in the static shell", () => {
      assert.match(src, /id="notionToken"/);
    });

    t(label + ": a #notionParentPage input exists in the static shell", () => {
      assert.match(src, /id="notionParentPage"/);
    });

    t(label + ": notionExportBlock is its own top-level Settings section, not nested inside 'Site popularity filter'", () => {
      // Review fix: nesting it under the unrelated popularity-filter section was
      // a discoverability problem. It must be a sibling <div class="sec">, same
      // as secAppUpdates and the other independent settings sections.
      assert.match(src, /<div class="sec" id="notionExportBlock">/);
    });

    const mask = getNotionMask(src);

    await at(label + ": saveNotionConfig omits 'token' entirely when the token field is left at NOTION_MASK", async () => {
      const { setConfigFields } = await runSaveNotionConfig(src, { tokenValue: mask, pageValue: "abc123page" });
      assert.ok(setConfigFields, "Store.setNotionConfig was not called");
      assert.strictEqual(setConfigFields.parentPageId, "abc123page");
      assert.ok(!("token" in setConfigFields), "token key must be genuinely absent, not present-as-falsy");
    });

    await at(label + ": saveNotionConfig includes 'token' when the token field was actually changed", async () => {
      const { setConfigFields } = await runSaveNotionConfig(src, { tokenValue: "secret_real_token_value", pageValue: "abc123page" });
      assert.ok(setConfigFields, "Store.setNotionConfig was not called");
      assert.ok("token" in setConfigFields, "token key must be present when the field was modified");
      assert.strictEqual(setConfigFields.token, "secret_real_token_value");
      assert.ok("parentPageId" in setConfigFields);
      assert.strictEqual(setConfigFields.parentPageId, "abc123page");
    });

    await at(label + ": loadNotionStatus pre-fills #notionParentPage from status.parentPageId when the field is empty", async () => {
      const elements = { notionToken: { value: "" }, notionParentPage: { value: "" }, notionStatus: { textContent: "" } };
      await runLoadNotionStatus(src, elements, { hasToken: true, hasParent: true, parentPageId: "real-page-123" });
      assert.strictEqual(elements.notionParentPage.value, "real-page-123");
    });

    await at(label + ": REGRESSION — reload then rotate-only-the-token no longer wipes the stored parentPageId", async () => {
      // Reproduces the reviewer's exact sequence: app loads, loadNotionStatus
      // pre-fills both fields from the server's status (token -> mask,
      // parent page -> its real value). The user then only retypes the token
      // (e.g. after rotating a leaked key) and clicks Save WITHOUT touching
      // the parent-page field. Before the fix, GET /api/notion-config never
      // sent back parentPageId, so loadNotionStatus had nothing to pre-fill
      // the field with, it stayed "", and saveNotionConfig would then send
      // {parentPageId: "", token: "<new>"} — wiping the real stored page id
      // per Task 1's "present key = set it" contract.
      const elements = { notionToken: { value: "" }, notionParentPage: { value: "" }, notionStatus: { textContent: "" } };
      await runLoadNotionStatus(src, elements, { hasToken: true, hasParent: true, parentPageId: "real-page-123" });
      // Simulate the user retyping ONLY the token — the parent-page input is
      // left exactly as loadNotionStatus set it, never touched again.
      elements.notionToken.value = "brand_new_rotated_token";
      const fields = await runSaveNotionConfigOn(src, elements);
      assert.strictEqual(fields.parentPageId, "real-page-123", "parentPageId must survive a token-only rotation, not be sent as ''");
      assert.strictEqual(fields.token, "brand_new_rotated_token");
    });
  }

  t("loadNotionStatus is byte-identical between web and pwa", () => {
    const a = fn(html, "loadNotionStatus");
    const b = fn(pwaHtml, "loadNotionStatus");
    assert.strictEqual(a.trim(), b.trim());
  });

  t("saveNotionConfig is byte-identical between web and pwa", () => {
    const a = fn(html, "saveNotionConfig");
    const b = fn(pwaHtml, "saveNotionConfig");
    assert.strictEqual(a.trim(), b.trim());
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
