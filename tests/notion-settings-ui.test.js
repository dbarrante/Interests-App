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
const storagePwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");

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

// Pulls the desktop-only-sections hide list out of the `if (window.IA_IDB) {
// [...].forEach(...)` block at the bottom of the page. Deliberately parses the
// ARRAY LITERAL rather than just grepping the file for a section id — every id
// in this list also appears elsewhere in the file as the section's own
// `id="..."` attribute, so a plain substring assertion would pass even with the
// id missing from the hide list (which is exactly the gap this test closes).
function iPadHideList(src) {
  const m = /if\s*\(window\.IA_IDB\)\s*\{\s*(\[[^\]]*\])\.forEach/.exec(src);
  assert.ok(m, "iPad desktop-only hide-list block not found");
  return JSON.parse(m[1]);
}

// Runs the REAL exportCardToNotion() against stubbed _researchCard/Store/toast/window.
function runExportCardToNotion(src, { status, statusThrows, exportResult, card }) {
  const body = fn(src, "exportCardToNotion");
  const toastCalls = [];
  const toast = (msg, ms, onclick) => toastCalls.push({ msg, ms, onclick });
  const _researchCard = () => (card === undefined ? { id: "c1", title: "T", url: "https://x.test/", research: { article: { text: "A" }, qa: [] } } : card);
  const opened = [];
  const Store = {
    getNotionStatus: async () => { if (statusThrows) throw new Error("boom"); return status; },
    exportToNotion: async () => exportResult,
  };
  const win = { open: (u, t, f) => opened.push({ u, t, f }) };
  const factory = new Function("_researchCard", "Store", "toast", "window", body + "\nreturn exportCardToNotion;");
  const exportCardToNotion = factory(_researchCard, Store, toast, win);
  return exportCardToNotion("saved", "c1").then(() => ({ toastCalls, opened }));
}

(async function () {
  // --- final-review fix wave, Fix 1 (half A): the iPad hide list ---
  // notionExportBlock is a desktop-only Settings section — the whole feature
  // needs the local Core service, which does not exist on iPad. Left visible,
  // it renders a live, interactive password + page-id form that can only ever
  // fail. This list had ZERO test coverage before this wave, which is why the
  // omission survived Task 5's review.
  for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
    t(label + ": notionExportBlock is in the iPad desktop-only hide list", () => {
      const ids = iPadHideList(src);
      assert.ok(ids.includes("notionExportBlock"),
        "hide list is [" + ids.join(", ") + "] — notionExportBlock must be in it");
    });
  }
  t("the iPad hide list is byte-identical between web and pwa", () => {
    assert.deepStrictEqual(iPadHideList(html), iPadHideList(pwaHtml));
  });

  // --- Fix 1 (half B): the PWA stub must explain itself ---
  // Hiding the Settings section alone would make things WORSE: the research
  // panel's "Export to Notion" button is gated on card content, not platform,
  // so it still renders on iPad. Its handler consults Store.getNotionStatus()
  // and, without an `ok:false`/`reason` on the stub, tells the user to visit a
  // Settings section that is now invisible. The stub must carry the same
  // {ok:false, reason} shape as its setNotionConfig/exportToNotion siblings.
  t("pwa/storage-pwa.js: getNotionStatus stub returns ok:false with a reason, like its siblings", () => {
    const m = /getNotionStatus:\s*\(\)\s*=>\s*Promise\.resolve\((\{[^}]*\})\)/.exec(storagePwa);
    assert.ok(m, "getNotionStatus stub not found in pwa/storage-pwa.js");
    const stub = m[1];
    assert.match(stub, /ok:\s*false/, "stub must carry ok:false — the panel handler branches on it");
    assert.match(stub, /reason:\s*"Not applicable on iPad/, "stub must carry the same reason string as setNotionConfig/exportToNotion");
    assert.match(stub, /hasToken:\s*false/);
    assert.match(stub, /hasParent:\s*false/);
  });
  t("pwa/storage-pwa.js: all three Notion stubs share one reason string", () => {
    // Scoped to the three Notion stubs by name — storage-pwa.js has several
    // other unrelated "Not applicable on iPad" reasons (backupNow, restore, …).
    const reasons = ["getNotionStatus", "setNotionConfig", "exportToNotion"].map((name) => {
      const m = new RegExp(name + ":\\s*\\(\\)\\s*=>\\s*Promise\\.resolve\\(\\{[^}]*reason:\\s*\"([^\"]*)\"").exec(storagePwa);
      assert.ok(m, name + " stub has no reason string");
      return m[1];
    });
    assert.strictEqual(new Set(reasons).size, 1, "the reason string must be identical across all three stubs, got: " + JSON.stringify(reasons));
  });

  for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
    await at(label + ": exportCardToNotion surfaces status.reason instead of the generic 'Add your Notion integration in Settings' message", async () => {
      const reason = "Not applicable on iPad — Notion export needs the desktop app's local service.";
      const { toastCalls } = await runExportCardToNotion(src, {
        status: { hasToken: false, hasParent: false, ok: false, reason },
        exportResult: { ok: true, pageUrl: "https://notion.so/x" },
      });
      assert.strictEqual(toastCalls.length, 1, "expected exactly one toast, got: " + JSON.stringify(toastCalls.map(c => c.msg)));
      assert.strictEqual(toastCalls[0].msg, reason, "must show the platform reason, not a pointer to a hidden Settings section");
    });

    await at(label + ": exportCardToNotion still shows the generic Settings prompt on desktop (no reason in the status)", async () => {
      const { toastCalls } = await runExportCardToNotion(src, {
        status: { hasToken: false, hasParent: false },
        exportResult: { ok: true, pageUrl: "https://notion.so/x" },
      });
      assert.strictEqual(toastCalls.length, 1);
      assert.match(toastCalls[0].msg, /Add your Notion integration in Settings first/);
    });

    // --- Fix 5: the success toast must not offer to open a blank tab ---
    // createPage defaults pageUrl to "" when Notion's response omits `url`.
    await at(label + ": exportCardToNotion attaches click-to-open only when res.pageUrl is present", async () => {
      const { toastCalls } = await runExportCardToNotion(src, {
        status: { hasToken: true, hasParent: true },
        exportResult: { ok: true, pageUrl: "https://notion.so/abc" },
      });
      const success = toastCalls[toastCalls.length - 1];
      assert.match(success.msg, /click to open/);
      assert.strictEqual(typeof success.onclick, "function", "a real pageUrl must get a click-to-open handler");
    });

    await at(label + ": exportCardToNotion shows a plain success toast (no click handler) when pageUrl is empty", async () => {
      const { toastCalls, opened } = await runExportCardToNotion(src, {
        status: { hasToken: true, hasParent: true },
        exportResult: { ok: true, pageUrl: "" },
      });
      const success = toastCalls[toastCalls.length - 1];
      assert.match(success.msg, /Exported to Notion/);
      assert.ok(!/click to open/.test(success.msg), "must not promise a click that opens nothing");
      assert.strictEqual(success.onclick, undefined, "an empty pageUrl must NOT get a click-to-open handler");
      // Belt and braces: even if a handler somehow existed, firing it must not open "".
      if (typeof success.onclick === "function") success.onclick();
      assert.strictEqual(opened.length, 0, "window.open must never be called with an empty url");
    });
  }

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

  t("exportCardToNotion is byte-identical between web and pwa", () => {
    const a = fn(html, "exportCardToNotion");
    const b = fn(pwaHtml, "exportCardToNotion");
    assert.strictEqual(a.trim(), b.trim());
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
