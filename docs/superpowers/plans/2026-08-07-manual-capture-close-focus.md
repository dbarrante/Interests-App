# Manual Capture: Close Tab + Focus App on Accept Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user accepts a manual point-to-point picture-update capture (card-face icon → article opens → drag a selection box → "Use this"), the browser tab used for the capture closes and the Electron app window comes to the front.

**Architecture:** Two pieces. (1) A new best-effort HTTP signal, `POST /api/focus-app`, added to the existing local Express server (`core/server.js`) and wired in `main.js` to restore/show/focus the app's `BrowserWindow` — the same extension→app HTTP pattern (`findAppPort` + `fetch`) already used by every other capture delivery in `extension/background.js`. (2) A change to `regionSelectFinalize` in `extension/background.js` so the tab-close (and the new focus call) fires for every app-triggered manual-capture session, not just the rare case where the extension had to create the tab itself.

**Tech Stack:** Node.js/Express (`core/server.js`), Electron main process (`main.js`), Chrome MV3 service worker (`extension/background.js`). No new dependencies.

## Global Constraints

- Every route in `core/server.js` added after line 186 (`app.use(requireToken(ctx))`) is already covered by the existing auth gate — no new auth code needed.
- `core/server.js` must stay Electron-agnostic (never `require("electron")` directly) — reach the app window only through an optional `ctx.<capability>` callback, mirroring the existing `ctx.storeWorker` pattern.
- Bump `package.json`'s `"version"` as part of the final commit (current: `1.12.90` → `1.12.91`), matching this repo's convention of a version bump on every shipped behavior change. No PWA `SHELL_CACHE` bump needed — this change touches no `web/index.html`/`pwa/index.html`/`pwa/sw.js` files.
- Run `node tests/run.js` after each task and before the final commit; the only acceptable non-clean output is the pre-existing, unrelated `SOME TEST FILES FAILED` line with zero real `FAIL` lines anywhere (a known flaky test-runner summary line, not a real failure — confirmed by grepping the full output for `FAIL` before treating a run as green).

---

### Task 1: Add the `/api/focus-app` HTTP signal (server endpoint + Electron wiring)

**Files:**
- Modify: `core/server.js:525` (insert new route after the existing `/api/captures/ack` block, before the `// --- Single capture request...` comment)
- Modify: `main.js:99` (insert `ctx.focusApp` assignment right after the existing `ctx.storeWorker = storeWorker;` line)
- Test: `tests/focus-app-endpoint.test.js` (new)

**Interfaces:**
- Produces: `POST /api/focus-app` — no request body, always responds `200 {"ok":true}`. Calls `ctx.focusApp()` when that property is a function; silently no-ops otherwise.
- Produces: `ctx.focusApp: () => void` — set on the real `ctx` object by `main.js` once the Electron app is running. Not present on `ctx` objects built in tests or by other embedders of `core/server.js`.
- Consumes (Task 2 will use this): `POST http://127.0.0.1:<port>/api/focus-app` from `extension/background.js`, the same way `deliverToApp` already calls other `/api/*` routes.

- [ ] **Step 1: Write the failing test**

Create `tests/focus-app-endpoint.test.js`:

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../core/server");
const db = require("../core/db");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-focus-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise((res) => {
    const srv = http.createServer(app).listen(0, "127.0.0.1", () => {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}

(async () => {
  const storeDir = tmpStore();
  const database = db.openDb(storeDir);
  const ctx = { db: database, storeDir, getStorePath: () => storeDir, setStorePath: () => {}, reopen: () => db.openDb(storeDir) };

  {
    let calls = 0;
    ctx.focusApp = () => { calls++; };
    const app = createServer(ctx);
    const { srv, base } = await listen(app);
    try {
      await t("POST /api/focus-app calls ctx.focusApp() and responds ok:true", async () => {
        const r = await fetch(base + "/api/focus-app", { method: "POST" });
        assert.strictEqual(r.status, 200);
        const j = await r.json();
        assert.deepStrictEqual(j, { ok: true });
        assert.strictEqual(calls, 1);
      });
    } finally { await new Promise((res) => srv.close(res)); }
  }

  {
    delete ctx.focusApp;
    const app = createServer(ctx);
    const { srv, base } = await listen(app);
    try {
      await t("POST /api/focus-app is a safe no-op (still ok:true, never throws) when ctx.focusApp is absent", async () => {
        const r = await fetch(base + "/api/focus-app", { method: "POST" });
        assert.strictEqual(r.status, 200);
        const j = await r.json();
        assert.deepStrictEqual(j, { ok: true });
      });
    } finally { await new Promise((res) => srv.close(res)); }
  }

  try { ctx.db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/focus-app-endpoint.test.js`
Expected: FAIL on both tests — `/api/focus-app` doesn't exist yet, so both requests 404 (`r.status` is `404`, not `200`).

- [ ] **Step 3: Add the endpoint in `core/server.js`**

Insert immediately after the `/api/captures/ack` handler's closing `});` (currently line 525) and before the `// --- Single capture request / batch driver state / batch progress ---` comment (currently line 527):

```js
  // App focus signal: extension/background.js's regionSelectFinalize posts here right
  // after an accepted manual-capture picture update, so the Electron window comes back
  // to front once the user returns from the browser. ctx.focusApp is set by main.js
  // only when a live window exists (see main.js) -- core/server.js stays Electron-
  // agnostic, so this must never throw or fail the response when it's absent (test
  // contexts and any other embedder of this server won't have it wired).
  app.post("/api/focus-app", (req, res) => {
    try { if (typeof ctx.focusApp === "function") ctx.focusApp(); } catch (e) {}
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Wire `ctx.focusApp` in `main.js`**

Insert immediately after the existing line (currently `main.js:99`):
```js
      ctx.storeWorker = storeWorker;   // POST /api/sync/now, /api/backup, /api/restore, /api/store-location/move all use this when present
```

Add:
```js
      // App-focus signal for POST /api/focus-app (core/server.js): reuses the exact
      // restore/focus sequence the second-instance handler above already uses, so the
      // manual-capture browser flow can bring the app back to front after an accepted
      // picture update.
      ctx.focusApp = () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/focus-app-endpoint.test.js`
Expected: `2 passed, 0 failed`

- [ ] **Step 6: Run the full suite and commit**

Run: `node tests/run.js` — confirm no new failures (see Global Constraints for how to read the flaky summary line).

```bash
git add core/server.js main.js tests/focus-app-endpoint.test.js
git commit -m "$(cat <<'EOF'
feat: add POST /api/focus-app so the extension can bring the app window forward

New best-effort HTTP signal, following the existing extension->app HTTP
pattern (findAppPort + fetch) already used for every capture delivery.
core/server.js stays Electron-agnostic -- the route only calls an optional
ctx.focusApp callback, which main.js wires to the same restore/show/focus
sequence the second-instance handler already uses. Not yet called from
anywhere; wiring lands in the next commit.
EOF
)"
```

---

### Task 2: Close the tab and call `/api/focus-app` on manual-capture accept

**Files:**
- Modify: `extension/background.js:1547-1584` (`startManualCapture` — remove the now-dead `owned` tracking)
- Modify: `extension/background.js:1879-1907` (`regionSelectFinalize` handler — close+focus gated on `session.id`, not `session.owned`)
- Modify: `tests/manual-capture-wiring.test.js` (update the test that asserted the old `session.owned` gating; add two new tests)
- Modify: `package.json` (version bump)

**Interfaces:**
- Consumes: `findAppPort()` (existing, `extension/background.js:80`) and `POST /api/focus-app` (Task 1).
- Produces: manual-capture session objects are now always `{ id, url }` (never carry `owned`) — no other code in this file reads `.owned` after this task (verified below; it was the only reader).

- [ ] **Step 1: Write the failing tests**

In `tests/manual-capture-wiring.test.js`, replace the existing test (currently around line 67):

```js
t("regionSelectFinalize only closes the tab it owns (app-triggered), never the user's own standalone browsing tab", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2000);
  assert.ok(/if \(session\.owned\) \{ try \{ await chrome\.tabs\.remove\(tab\.id\); \} catch \(e\) \{\} \}/.test(body),
    "chrome.tabs.remove must be gated on session.owned so a standalone capture never closes the user's own tab");
});
```

with:

```js
t("regionSelectFinalize closes the tab and calls /api/focus-app for ANY app-triggered session (session.id), not just one the extension itself created", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2000);
  assert.ok(!/session\.owned/.test(body), "must not still gate on session.owned -- that left the tab open in the common case where the app's own openLink tab was found");
  const gateIdx = body.indexOf("if (session.id) {");
  assert.ok(gateIdx >= 0, "close+focus must be gated on session.id");
  const closeIdx = body.indexOf("chrome.tabs.remove(tab.id)", gateIdx);
  const focusIdx = body.indexOf("/api/focus-app", gateIdx);
  assert.ok(closeIdx > gateIdx, "chrome.tabs.remove must be inside the session.id gate");
  assert.ok(focusIdx > closeIdx, "the /api/focus-app call must be inside the gate too, after the tab close");
});
t("regionSelectFinalize's /api/focus-app call uses findAppPort() and is a fire-and-forget POST (never fails the response)", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2000);
  const gateIdx = body.indexOf("if (session.id) {");
  const gated = body.slice(gateIdx, body.indexOf("sendResponse({ ok: true });", gateIdx));
  assert.ok(/findAppPort\(\)/.test(gated));
  assert.ok(/method: "POST"/.test(gated));
  assert.ok(/catch \(e\) \{\}/.test(gated), "a focus-app fetch failure must be swallowed, not thrown");
});
t("regionSelectFinalize never closes the tab or calls /api/focus-app for a standalone (id-less) session", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2000);
  const gateIdx = body.indexOf("if (session.id) {");
  const closeIdx = body.indexOf("chrome.tabs.remove(tab.id)");
  const focusIdx = body.indexOf("/api/focus-app");
  assert.ok(gateIdx < closeIdx && closeIdx < focusIdx, "both the close and the focus call must live inside the session.id gate, in that order");
});
```

Replace the existing test at (currently around line 73):

```js
t("startManualCapture only sets owned:true for a tab IT created, not one it found already open", () => {
  const startIdx = bg.indexOf("async function startManualCapture(req) {");
  const startBody = bg.slice(startIdx, startIdx + 2400);
  assert.ok(/let owned = false;/.test(startBody));
  assert.ok(/owned = true;/.test(startBody));
  assert.ok(/chrome\.tabs\.create\(\{ url: req\.url, active: true \}\)/.test(startBody),
    "still falls back to creating its own tab when no app-opened tab is found");
  assert.ok(/setManualCaptureSession\(tab\.id, \{ id: req\.id \|\| "", url: req\.url, owned \}\)/.test(startBody),
    "owned must be the variable (true only when this flow created the tab), not a hardcoded true");

  const ctxIdx = bg.indexOf('info.menuItemId === "pointToPointCapture"');
  const ctxBody = bg.slice(ctxIdx, ctxIdx + 400);
  assert.ok(/setManualCaptureSession\(tab\.id, \{ id: "", url: tab\.url \|\| "" \}\)/.test(ctxBody),
    "the standalone context-menu session must NOT set owned:true");
});
```

with:

```js
t("startManualCapture still falls back to creating its own tab when no already-open tab is found, and no longer tracks owned (dead since regionSelectFinalize now gates on session.id)", () => {
  const startIdx = bg.indexOf("async function startManualCapture(req) {");
  const startBody = bg.slice(startIdx, startIdx + 2400);
  assert.ok(!/\bowned\b/.test(startBody), "owned must be fully removed -- it was only ever read by regionSelectFinalize's now-superseded session.owned gate");
  assert.ok(/chrome\.tabs\.create\(\{ url: req\.url, active: true \}\)/.test(startBody),
    "still falls back to creating its own tab when no app-opened tab is found");
  assert.ok(/setManualCaptureSession\(tab\.id, \{ id: req\.id \|\| "", url: req\.url \}\)/.test(startBody));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/manual-capture-wiring.test.js`
Expected: the three `regionSelectFinalize` tests FAIL (current code still gates on `session.owned` and never calls `/api/focus-app`); the `startManualCapture` test FAILS (current code still declares `owned`).

- [ ] **Step 3: Update `startManualCapture` in `extension/background.js`**

Current (`extension/background.js:1547-1580`):
```js
async function startManualCapture(req) {
  await setStatus("Waiting for you to select an image…", true);
  let tab = await findAppOpenedTab(req.url);
  let owned = false;
  if (!tab) {
    owned = true;
    try { tab = await chrome.tabs.create({ url: req.url, active: true }); }
    catch (e) { await deliverToApp({ url: req.url, id: req.id || "", attempt: true, ok: false, ts: Date.now() }); return; }
  }
```
becomes:
```js
async function startManualCapture(req) {
  await setStatus("Waiting for you to select an image…", true);
  let tab = await findAppOpenedTab(req.url);
  if (!tab) {
    try { tab = await chrome.tabs.create({ url: req.url, active: true }); }
    catch (e) { await deliverToApp({ url: req.url, id: req.id || "", attempt: true, ok: false, ts: Date.now() }); return; }
  }
```

Further down, current (`extension/background.js:1572-1579`):
```js
  try {
    await waitTabComplete(tab.id, 30000);
    // owned:true only for a tab THIS flow created, so regionSelectFinalize may
    // close it afterward. A tab the app already had open (found above) or the
    // standalone context-menu flow (pointToPointCapture below) must NOT set
    // this -- the user may have had it open for their own reasons too.
    await setManualCaptureSession(tab.id, { id: req.id || "", url: req.url, owned });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["region-select.js"] });
  } catch (e) {
```
becomes:
```js
  try {
    await waitTabComplete(tab.id, 30000);
    await setManualCaptureSession(tab.id, { id: req.id || "", url: req.url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["region-select.js"] });
  } catch (e) {
```

- [ ] **Step 4: Update `regionSelectFinalize` in `extension/background.js`**

Current (`extension/background.js:1897-1904`):
```js
      await deliverToApp(capture);
      await setStatus("Manual capture saved ✓", true);
      // Only close a tab THIS feature opened for the capture (session.owned, set
      // only by startManualCapture's app-triggered flow). The standalone
      // context-menu flow captures on the user's own already-open tab and must
      // not close it out from under them.
      if (session.owned) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
      sendResponse({ ok: true });
```
becomes:
```js
      await deliverToApp(capture);
      await setStatus("Manual capture saved ✓", true);
      // App-triggered only (session.id set): the app opened this tab specifically for
      // this capture either way -- whether startManualCapture found it via
      // findAppOpenedTab or had to create it as a fallback, there's no reason to leave
      // it open once the user has accepted. Always close it and bring the app back to
      // front. The standalone context-menu flow (session.id === "") captures on the
      // user's own already-open tab and must not close it or steal focus from under
      // them, so this whole block stays gated on session.id.
      if (session.id) {
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
        try {
          const port = await findAppPort();
          if (port != null) await fetch("http://127.0.0.1:" + port + "/api/focus-app", { method: "POST" });
        } catch (e) {}
      }
      sendResponse({ ok: true });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/manual-capture-wiring.test.js`
Expected: all tests pass (check the final `N passed, 0 failed` line).

- [ ] **Step 6: Run the full suite**

Run: `node tests/run.js` — confirm no new failures.

- [ ] **Step 7: Bump the version and commit**

In `package.json`, change `"version": "1.12.90"` to `"version": "1.12.91"`.

```bash
git add extension/background.js tests/manual-capture-wiring.test.js package.json
git commit -m "$(cat <<'EOF'
feat: close the manual-capture tab and focus the app on every accepted picture update

regionSelectFinalize only closed the tab when session.owned was true --
set by startManualCapture only in the rare fallback where the extension
had to create its own tab. In the common case (the app's own openLink()
tab found via findAppOpenedTab), owned stayed false and the tab was left
open after the user accepted -- reported: the browser tab should close
and the app should come back to front once a manual picture update is
accepted.

The app opened this tab specifically for the capture either way, so
close+focus (via the new POST /api/focus-app) now gates on session.id
(app-triggered) instead of session.owned, closing/focusing in both
cases. owned itself is now dead (it had exactly one reader) and is
removed. The standalone context-menu capture flow (session.id === "")
is unchanged -- it still never closes or steals focus from the user's
own browsing tab.

v1.12.91.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Spec §1 (close tab, session.id not session.owned) → Task 2 Steps 3-4. Spec §2 (`/api/focus-app` endpoint + `ctx.focusApp` wiring + extension call) → Task 1 (endpoint+wiring) and Task 2 Step 4 (the call site). Spec's scope boundaries (accept-only, app-triggered-only, best-effort/swallowed failures) → enforced by the `session.id` gate and the `try {} catch (e) {}` around the fetch in Task 2 Step 4, tested in Task 2 Step 1's tests.
- **Placeholder scan:** none found — every step has literal code.
- **Type consistency:** `ctx.focusApp` is `() => void` everywhere it's declared (Task 1 Step 4) and called (Task 1 Step 3). `findAppPort()` and the `/api/focus-app` URL string match the existing `deliverToApp` call style exactly (same base URL construction, same header-less POST). Manual-capture session shape is `{ id, url }` consistently after Task 2 (no lingering `owned` reads anywhere — confirmed by grep during design that `owned` had exactly one reader, the block being replaced).
