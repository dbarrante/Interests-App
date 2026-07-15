# PWA Sync Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iPad PWA's Dropbox sync fail loudly and correctly instead of silently reporting fake success, and remove the temporary on-device diagnostic `alert()`s added earlier this session.

**Architecture:** Every Dropbox network call already funnels through one shared layer in `pwa/oauth.js`. Add a pure `classifyDbxError(status)` function there, wire it into every throw site so a 401 always clears the dead token and tags the error `AUTH_EXPIRED`, then let that signal propagate cleanly up through `pwa/sync-pwa.js`'s `readPeers()`/`runSyncCycle()` (replacing the temporary diagnostic fields with a permanent `partialFailures` contract) to `pwa/storage-pwa.js`'s `syncNow()` (which persists a "last sync result" to IndexedDB) and finally to the UI (`pwa/index.html` + `web/index.html`, kept identical per repo convention).

**Tech Stack:** Plain browser JS (no framework), `node:test`-free custom test runner (`node tests/run.js`), IndexedDB (`pwa/idb.js`), Dropbox HTTP API.

## Global Constraints

- `web/index.html` and `pwa/index.html` are documented as byte-for-byte copies except for `<script>` tags — every edit to a shared function (`syncNowClick`, `renderSyncStatus`) must be applied identically to both files.
- Desktop (`web/storage.js`) has a completely different `Store.syncNow`/`syncStatus` implementation (talks to the local Express server, not Dropbox) with no `code` field and no `lastSyncResult` method. Any new UI logic keyed on `r.code` or calling `Store.lastSyncResult` must be safe when those are `undefined`/missing (feature-detect, never assume presence).
- This codebase has no browser test harness — `pwa/oauth.js`/`pwa/sync-pwa.js` are tested via extracting function source text with `fs.readFileSync` + a `grab()` helper and `eval()`-ing it standalone (see `tests/durable-cdn-image.test.js`), not via `require()` (both files assign to `window.*` at module scope, which throws in plain Node).
- `pwa/sw.js`'s `SHELL_CACHE` constant must be bumped on any edit to `pwa/index.html`, any `pwa/*.js` file, or the manifest — read its live value fresh before bumping (do not assume a version number).
- `node tests/run.js` must print `ALL TEST FILES PASSED` before every commit in this plan.

---

### Task 1: `classifyDbxError()` — pure error classifier

**Files:**
- Modify: `pwa/oauth.js` (insert after `fetchWithRetry`, before `dbxApiCall` — currently line 189/191)
- Test: `tests/pwa-oauth-classify.test.js` (new)

**Interfaces:**
- Produces: `classifyDbxError(status)` → `{code: "AUTH_EXPIRED"|"OTHER", message: string|null}`. Later tasks call this from every Dropbox-call throw site.

- [ ] **Step 1: Write the failing test**

Create `tests/pwa-oauth-classify.test.js`:

```js
// tests/pwa-oauth-classify.test.js — classifyDbxError() is a pure function
// with no external dependencies, so it can be extracted from pwa/oauth.js's
// source and eval'd standalone, same technique as tests/durable-cdn-image.test.js
// uses for extension/background.js (this codebase has no browser test harness).
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "oauth.js"), "utf8");

function grab(source, name) {
  const idx = source.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

const classifyDbxError = eval("(" + grab(src, "classifyDbxError") + ")");

t("classifyDbxError(401): AUTH_EXPIRED with a user-facing message", () => {
  const r = classifyDbxError(401);
  assert.strictEqual(r.code, "AUTH_EXPIRED");
  assert.strictEqual(typeof r.message, "string");
  assert.ok(r.message.length > 0);
});

t("classifyDbxError: 400/404/429/500 are all OTHER with no message", () => {
  for (const status of [400, 404, 429, 500]) {
    const r = classifyDbxError(status);
    assert.strictEqual(r.code, "OTHER", "status " + status);
    assert.strictEqual(r.message, null, "status " + status);
  }
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pwa-oauth-classify.test.js`
Expected: throws `Error: not found: classifyDbxError` (function doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `pwa/oauth.js`, insert immediately after `fetchWithRetry`'s closing brace (before `async function dbxApiCall`):

```js
// Pure — classifies a Dropbox HTTP response status into a code the rest of
// the app can branch on, without inspecting Dropbox's free-text
// error_summary. 401 means the access token is dead (revoked or expired
// server-side — distinct from our own locally-tracked expiresAt, which can
// still look "not expired yet" while the server has already killed it) and
// every caller must treat that identically: clear the token, tell the user
// to reconnect. Everything else (network failure, 404, 5xx, a 429 that
// survived fetchWithRetry's own retries) is a generic, non-auth failure
// that must NOT force a reconnect for what might just be a bad moment.
function classifyDbxError(status) {
  if (status === 401) return { code: "AUTH_EXPIRED", message: "Dropbox connection expired — reconnect in Settings." };
  return { code: "OTHER", message: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pwa-oauth-classify.test.js`
Expected: `2 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add pwa/oauth.js tests/pwa-oauth-classify.test.js
git commit -m "feat(pwa): add classifyDbxError() — 401 vs everything else"
```

---

### Task 2: Wire `classifyDbxError` into every Dropbox call site

**Files:**
- Modify: `pwa/oauth.js` (`disconnect`, `refreshAccessToken`, `dbxApiCall`, `dbxDownload`, `dbxDownloadBinary`, `dbxUpload`)
- Test: `tests/pwa-oauth-classify.test.js` (extend)

**Interfaces:**
- Consumes: `classifyDbxError(status)` from Task 1.
- Produces: `dbxError(status, detail)` → `Error` with `.status` and `.code` set, calling `disconnect()` first when `code === "AUTH_EXPIRED"`. Every Dropbox-call throw site now throws via this instead of a bare `new Error(...)`. `refreshAccessToken` failures also set `err.code = "AUTH_EXPIRED"` and call `disconnect()`. Later tasks (`readPeers`, `runSyncCycle`) branch on `e.code`.

- [ ] **Step 1: Write the failing test**

Append to `tests/pwa-oauth-classify.test.js` (before the `console.log(passed...)` line):

```js
t("dbxError: calls classifyDbxError, disconnects and tags AUTH_EXPIRED on 401", () => {
  const body = grab(src, "dbxError");
  assert.ok(body.indexOf("classifyDbxError(status)") >= 0, "must call classifyDbxError(status)");
  assert.ok(body.indexOf("disconnect()") >= 0, "must call disconnect() on the AUTH_EXPIRED path");
  assert.ok(/err\.status\s*=\s*status/.test(body), "must set err.status");
  assert.ok(/err\.code\s*=\s*info\.code/.test(body), "must set err.code from classifyDbxError's result");
});

t("every Dropbox-call throw site uses dbxError(...) instead of a bare new Error(...)", () => {
  for (const fn of ["dbxApiCall", "dbxDownload", "dbxDownloadBinary", "dbxUpload"]) {
    const body = grab(src, fn);
    assert.ok(/throw dbxError\(res\.status,/.test(body), fn + " must throw dbxError(res.status, ...)");
    assert.ok(!/throw new Error\(/.test(body), fn + " must not throw a bare Error anymore");
  }
});

t("refreshAccessToken tags a failed refresh AUTH_EXPIRED and disconnects", () => {
  const body = grab(src, "refreshAccessToken");
  // two failure paths: no refresh token on file, and a non-ok token-endpoint response
  const disconnectCount = (body.match(/disconnect\(\)/g) || []).length;
  assert.ok(disconnectCount >= 2, "both failure paths must call disconnect()");
  const codeCount = (body.match(/err\.code\s*=\s*"AUTH_EXPIRED"/g) || []).length;
  assert.ok(codeCount >= 2, "both failure paths must tag err.code = AUTH_EXPIRED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pwa-oauth-classify.test.js`
Expected: all 3 new tests FAIL (`dbxError` doesn't exist; the 4 call sites still throw bare `Error`; `refreshAccessToken` doesn't set `.code`).

- [ ] **Step 3: Write minimal implementation**

In `pwa/oauth.js`, insert immediately after `classifyDbxError` (from Task 1):

```js
// Builds — and, for AUTH_EXPIRED, acts on — a typed error from a failed
// Dropbox response. Every throw site below calls this instead of a bare
// `new Error(...)` so a 401 anywhere reliably clears the dead token instead
// of leaving isConnected() reporting a stale "yes" against a dead token.
function dbxError(status, detail) {
  const info = classifyDbxError(status);
  if (info.code === "AUTH_EXPIRED") disconnect();
  const err = new Error(info.code === "AUTH_EXPIRED" ? info.message : detail);
  err.status = status;
  err.code = info.code;
  return err;
}
```

Replace `dbxApiCall`'s throw (find `if (!res.ok) throw new Error(json.error_summary || res.statusText);`):

```js
async function dbxApiCall(accessToken, endpoint, argBody) {
  const res = await fetchWithRetry(`${DBX_API_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(argBody || {}),
  });
  const json = await res.json();
  if (!res.ok) throw dbxError(res.status, json.error_summary || res.statusText);
  return json;
}
```

Replace `dbxDownload`'s throw:

```js
async function dbxDownload(accessToken, path) {
  const res = await fetchWithRetry(`${DBX_CONTENT_URL}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw dbxError(res.status, `download ${path}: ${res.status} ${errText}`);
  }
  return res.text();
}
```

Replace `dbxDownloadBinary`'s throw:

```js
async function dbxDownloadBinary(accessToken, path) {
  const res = await fetchWithRetry(`${DBX_CONTENT_URL}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw dbxError(res.status, `download ${path}: ${res.status} ${errText}`);
  }
  return res.arrayBuffer();
}
```

Replace `dbxUpload`'s throw:

```js
async function dbxUpload(accessToken, path, contentBytesOrString, mode) {
  const res = await fetchWithRetry(`${DBX_CONTENT_URL}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: mode || "overwrite", mute: true }),
    },
    body: contentBytesOrString,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw dbxError(res.status, `upload ${path}: ${res.status} ${errText}`);
  }
  return res.json();
}
```

Replace `refreshAccessToken` in full (both failure paths now tag `AUTH_EXPIRED` and disconnect — a dead refresh token means the connection is just as gone as a live 401 on an API call):

```js
async function refreshAccessToken(appKey) {
  const refreshToken = localStorage.getItem(LS_KEYS.refreshToken);
  if (!refreshToken) {
    disconnect();
    const err = new Error("No refresh token on file — reconnect to Dropbox.");
    err.code = "AUTH_EXPIRED";
    throw err;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
  });
  const res = await fetch(DBX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    disconnect();
    const err = new Error(json.error_description || json.error || res.statusText);
    err.code = "AUTH_EXPIRED";
    err.status = res.status;
    throw err;
  }
  storeTokens(json);
  return json.access_token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pwa-oauth-classify.test.js`
Expected: `5 passed, 0 failed`

Also run the full suite to confirm nothing else broke:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add pwa/oauth.js tests/pwa-oauth-classify.test.js
git commit -m "fix(pwa): a dead Dropbox token (401, or a failed refresh) now disconnects and tags AUTH_EXPIRED everywhere"
```

---

### Task 3: `readPeers()` — replace temporary diagnostics with permanent `partialFailures`

**Files:**
- Modify: `pwa/sync-pwa.js:85-121` (current `readPeers`, including this session's temporary diagnostic fields)
- Test: `tests/pwa-sync-readpeers.test.js` (new)

**Interfaces:**
- Consumes: `classifyDbxError`/`dbxError`'s `.code === "AUTH_EXPIRED"` contract from Task 2 (errors thrown by `Dbx.dbxListFolder`/`Dbx.readFullPeerSnapshot`).
- Produces: `readPeers(accessToken, selfDeviceId)` → `Promise<{peers: Array, skewSkipped: number, partialFailures: Array<{deviceId, reason}>}>` on success, OR rejects (throws) when the whole cycle can't proceed (an `AUTH_EXPIRED` error, or any error that isn't the benign "no sync root yet" case). This REPLACES the temporary `errors`/`deviceIdsFound` fields this session's diagnostic commit (`ec48f81`) added — Task 4 (`runSyncCycle`) is the only caller and is being updated in this same plan.

- [ ] **Step 1: Write the failing test**

Create `tests/pwa-sync-readpeers.test.js`:

```js
// tests/pwa-sync-readpeers.test.js — readPeers() used to swallow ANY failure
// from Dbx.dbxListFolder into an identical-looking empty peer list (the root
// cause of a 2-day-long silent sync failure diagnosed 2026-07-15 — see
// docs/superpowers/specs/2026-07-15-sync-reliability-design.md). This locks
// in the permanent replacement: propagate AUTH_EXPIRED and genuinely
// unexpected errors, keep only the benign "nobody has ever synced" case
// (Dropbox's path/not_found) as a soft empty return, and report per-peer
// failures via partialFailures instead of silently dropping them.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "sync-pwa.js"), "utf8");

function grab(source, name) {
  const idx = source.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

const body = grab(src, "readPeers");

t("readPeers no longer has the temporary diagnostic errors/deviceIdsFound fields", () => {
  assert.ok(body.indexOf("TEMPORARY DIAGNOSTIC") === -1, "temporary diagnostic comment must be removed");
  assert.ok(!/deviceIdsFound/.test(body), "deviceIdsFound must be removed (was diagnostic-only)");
});

t("readPeers propagates an AUTH_EXPIRED error from dbxListFolder instead of swallowing it", () => {
  assert.ok(/if\s*\(e\s*&&\s*e\.code\s*===\s*"AUTH_EXPIRED"\)\s*throw e;/.test(body),
    "must re-throw an AUTH_EXPIRED error from the list_folder catch block");
});

t("readPeers still soft-returns empty peers for the benign path/not_found case", () => {
  assert.ok(/path\\\/not_found/.test(body), "must check for Dropbox's path/not_found error");
  assert.ok(/return \{ ?peers: \[\], ?skewSkipped: 0, ?partialFailures: \[\] ?\}/.test(body.replace(/\s+/g, " ")),
    "must return an empty-but-valid result for path/not_found");
});

t("readPeers propagates any OTHER unexpected list_folder error (no longer silently swallowed)", () => {
  // after the AUTH_EXPIRED check and the path/not_found check, anything else must fall through to a throw
  const catchBlock = body.slice(body.indexOf("catch (e) {", body.indexOf("dbxListFolder")));
  assert.ok(/throw e;/.test(catchBlock.slice(0, catchBlock.indexOf("}"))), "unexpected errors must propagate, not be swallowed");
});

t("a per-peer AUTH_EXPIRED also aborts the whole cycle (not just that one peer)", () => {
  const loopStart = body.indexOf("for (const deviceId of deviceIds)");
  const loopBody = body.slice(loopStart);
  assert.ok(/if\s*\(e\s*&&\s*e\.code\s*===\s*"AUTH_EXPIRED"\)\s*throw e;/.test(loopBody),
    "the per-peer catch must re-throw an AUTH_EXPIRED error rather than `continue`");
});

t("a per-peer non-auth failure is recorded in partialFailures and the loop continues", () => {
  assert.ok(/partialFailures\.push\(\{\s*deviceId,\s*reason:/.test(body), "must push {deviceId, reason} on a per-peer failure");
  assert.ok(/return \{ ?peers, ?skewSkipped, ?partialFailures ?\}/.test(body.replace(/\s+/g, " ")),
    "the final return must include partialFailures");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pwa-sync-readpeers.test.js`
Expected: multiple FAILs (current `readPeers` still has the temporary diagnostic shape from commit `ec48f81`).

- [ ] **Step 3: Write minimal implementation**

Replace the entirety of `readPeers` (`pwa/sync-pwa.js:85-121`) with:

```js
  async function readPeers(accessToken, selfDeviceId) {
    console.log("sync: readPeers — listing", SYNC_ROOT);
    let entries;
    try {
      entries = await Dbx.dbxListFolder(accessToken, SYNC_ROOT);
    } catch (e) {
      if (e && e.code === "AUTH_EXPIRED") throw e; // sync cannot proceed without a live connection
      // path/not_found is the normal, silent case for "nobody has ever synced
      // to this Dropbox account yet" — the sync root folder doesn't exist.
      // Anything else here used to be swallowed identically (the root cause
      // of a 2-day silent sync failure, see the design spec) — now it
      // propagates so the caller actually finds out.
      if (/path\/not_found/.test(e && e.message)) {
        console.log("sync: readPeers — no sync root yet (nobody has ever synced):", e.message);
        return { peers: [], skewSkipped: 0, partialFailures: [] };
      }
      throw e;
    }
    const deviceIds = entries.filter((e) => e[".tag"] === "folder").map((e) => e.name).filter((id) => id !== selfDeviceId);
    console.log("sync: readPeers — found device folders:", deviceIds);

    const now = Date.now();
    let skewSkipped = 0;
    const peers = [];
    const partialFailures = [];
    for (const deviceId of deviceIds) {
      console.log("sync: readPeers — reading peer", deviceId);
      let snap;
      try {
        snap = await Dbx.readFullPeerSnapshot(accessToken, deviceId);
      } catch (e) {
        if (e && e.code === "AUTH_EXPIRED") throw e; // a dead token kills the whole cycle, not just this peer
        console.error("sync: failed to read peer", deviceId, e.message);
        partialFailures.push({ deviceId, reason: (e && e.message) || String(e) });
        continue;
      }
      console.log("sync: readPeers — read peer", deviceId, "ok:", !!snap);
      if (!snap) { partialFailures.push({ deviceId, reason: "torn write (meta/snapshot count mismatch) — will retry next cycle" }); continue; }
      if ((snap.schemaVersion | 0) > SCHEMA_VERSION) continue; // ahead of us — forward-compat gate
      if (snap.publishedAt != null && isFinite(snap.publishedAt) && Number(snap.publishedAt) - now > MAX_FUTURE_SKEW_MS) {
        skewSkipped++;
        continue;
      }
      peers.push(snap);
    }
    console.log("sync: readPeers — done, peers=" + peers.length + " skewSkipped=" + skewSkipped + " partialFailures=" + partialFailures.length);
    return { peers, skewSkipped, partialFailures };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pwa-sync-readpeers.test.js`
Expected: `6 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add pwa/sync-pwa.js tests/pwa-sync-readpeers.test.js
git commit -m "fix(pwa): readPeers() propagates real failures instead of swallowing them into an empty peer list"
```

---

### Task 4: `runSyncCycle()` — never reject, always return a classified result

**Files:**
- Modify: `pwa/sync-pwa.js:304-342` (current `runSyncCycle`, including the temporary `deviceIdsFound`/`peerErrors` return fields)
- Test: `tests/pwa-sync-runcycle.test.js` (new)

**Interfaces:**
- Consumes: `readPeers()`'s new contract from Task 3 (resolves with `partialFailures`, or throws — possibly with `.code === "AUTH_EXPIRED"`). `publishSnapshot()` (unchanged this task, but now can also throw a `dbxError` per Task 2).
- Produces: `runSyncCycle(accessToken, opts)` → `Promise` that **always resolves** (never rejects) with either `{ok:true, deviceId, deviceLabel, changed, conflicts, upserts, deletes, peersRead, skewSkipped, partialFailures, published, publishedAt}` or `{ok:false, code:"AUTH_EXPIRED"|"OTHER", reason, deviceId, deviceLabel}`. Task 5 (`storage-pwa.js`'s `syncNow`) relies on this never rejecting.

- [ ] **Step 1: Write the failing test**

Create `tests/pwa-sync-runcycle.test.js`:

```js
// tests/pwa-sync-runcycle.test.js — runSyncCycle() used to let a peer-read or
// publish failure propagate as an unhandled rejection with no classification,
// and separately carried this session's temporary deviceIdsFound/peerErrors
// diagnostic fields. This locks in the permanent contract: always resolve,
// classify failures via {ok:false, code, reason}.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "sync-pwa.js"), "utf8");

function grab(source, name) {
  const idx = source.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

const body = grab(src, "runSyncCycle");

t("runSyncCycle no longer returns the temporary deviceIdsFound/peerErrors fields", () => {
  assert.ok(body.indexOf("TEMPORARY DIAGNOSTIC") === -1, "temporary diagnostic comment must be removed");
  assert.ok(!/deviceIdsFound/.test(body), "deviceIdsFound must be removed (was diagnostic-only)");
  assert.ok(!/peerErrors/.test(body), "peerErrors must be removed (replaced by partialFailures)");
});

t("runSyncCycle wraps the readPeers call in try/catch and returns ok:false with the error's code", () => {
  const tryIdx = body.indexOf("try {");
  assert.ok(tryIdx >= 0, "must have a try block around readPeers");
  const catchSlice = body.slice(body.indexOf("catch (e) {", tryIdx));
  assert.ok(/code:\s*\(e\s*&&\s*e\.code\)\s*\|\|\s*"OTHER"/.test(catchSlice), "must classify the caught error's code, defaulting to OTHER");
  assert.ok(/ok:\s*false/.test(catchSlice), "must return ok:false on a caught readPeers failure");
});

t("runSyncCycle's success return includes ok:true and partialFailures", () => {
  const returnIdx = body.lastIndexOf("return {");
  const returnBlock = body.slice(returnIdx);
  assert.ok(/ok:\s*true/.test(returnBlock), "success path must set ok:true");
  assert.ok(/partialFailures/.test(returnBlock), "success path must include partialFailures");
});

t("runSyncCycle wraps publishSnapshot in try/catch too (a publish-time 401 must also classify, not throw raw)", () => {
  const publishIdx = body.indexOf("publishSnapshot(");
  assert.ok(publishIdx >= 0, "publishSnapshot must still be called");
  const around = body.slice(Math.max(0, publishIdx - 200), publishIdx + 400);
  assert.ok(/try\s*\{/.test(around), "publishSnapshot call must be inside a try block");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pwa-sync-runcycle.test.js`
Expected: multiple FAILs (current `runSyncCycle` still has the temporary diagnostic shape and doesn't classify errors).

- [ ] **Step 3: Write minimal implementation**

Replace the entirety of `runSyncCycle` (`pwa/sync-pwa.js:304-342`) with:

```js
  async function runSyncCycle(accessToken, opts) {
    console.log("sync: runSyncCycle — starting");
    opts = opts || {};
    const { deviceId, deviceLabel } = await ensureDeviceIdentity();
    console.log("sync: runSyncCycle — device identity ready:", deviceId, deviceLabel);

    let peers, skewSkipped, partialFailures;
    try {
      ({ peers, skewSkipped, partialFailures } = await readPeers(accessToken, deviceId));
    } catch (e) {
      console.error("sync: runSyncCycle — aborting, peer read failed:", e && e.message);
      return { ok: false, code: (e && e.code) || "OTHER", reason: (e && e.message) || String(e), deviceId, deviceLabel };
    }

    let changed = false, conflicts = 0, upserts = 0, deletes = 0;
    if (peers.length) {
      console.log("sync: runSyncCycle — building local snapshot for merge");
      const local = await buildLocal();
      const plan = mergeSnapshots(local, peers); // pwa/merge.js — global, no import needed
      console.log("sync: runSyncCycle — merge plan: upserts=" + plan.upserts.length + " deletes=" + plan.deletes.length + " imageCopies=" + plan.imageCopies.length);
      if (opts.onProgress) opts.onProgress({ phase: "merging", done: 0, total: plan.imageCopies.length });
      if (plan.upserts.length + plan.deletes.length + plan.imageCopies.length > 0 || plan.settings) {
        const r = await applyMergeToLocal(plan, accessToken, (done, total) => {
          if (opts.onProgress) opts.onProgress({ phase: "downloading images", done, total });
        });
        changed = r.changed; conflicts = plan.conflicts; upserts = r.upserts; deletes = r.deletes;
        console.log("sync: runSyncCycle — merge applied");
      }
    }

    let publishResult = null;
    try {
      if (opts.publish !== false) {
        publishResult = await publishSnapshot(accessToken, deviceId, deviceLabel, (done, total) => {
          if (opts.onProgress) opts.onProgress({ phase: "publishing images", done, total });
        });
      }
    } catch (e) {
      console.error("sync: runSyncCycle — publish failed:", e && e.message);
      return {
        ok: false, code: (e && e.code) || "OTHER", reason: (e && e.message) || String(e), deviceId, deviceLabel,
        changed, conflicts, upserts, deletes, peersRead: peers.length, skewSkipped, partialFailures,
      };
    }
    console.log("sync: runSyncCycle — done");

    return {
      ok: true,
      deviceId, deviceLabel, changed, conflicts, upserts, deletes,
      peersRead: peers.length, skewSkipped, partialFailures,
      published: !!publishResult, publishedAt: publishResult && publishResult.publishedAt,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pwa-sync-runcycle.test.js`
Expected: `4 passed, 0 failed`

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add pwa/sync-pwa.js tests/pwa-sync-runcycle.test.js
git commit -m "fix(pwa): runSyncCycle() always resolves with a classified {ok,code,reason} instead of rejecting"
```

---

### Task 5: `storage-pwa.js` — persist "last sync result", never reject

**Files:**
- Modify: `pwa/storage-pwa.js:141-164` (current `syncStatus`/`syncNow`)

**Interfaces:**
- Consumes: `idb.kvGet`/`idb.kvSet` (`pwa/idb.js:113-121`, unchanged). `runSyncCycle`'s new contract from Task 4.
- Produces: `Store.syncNow(onProgress)` → same shape as `runSyncCycle` but **always** resolves (catches `Dbx.getAccessToken` rejecting too) and persists every result to `idb`'s kv store under `"_pwa_last_sync_result"` before returning it. New `Store.lastSyncResult()` → `Promise<{ok, code?, reason?, at}|null>`. Task 7 (`renderSyncStatus`) reads this — **must feature-detect** (`typeof Store.lastSyncResult === "function"`) since desktop's `web/storage.js` has no such method.

- [ ] **Step 1: Write the failing test**

There is no existing test harness for `pwa/storage-pwa.js` (it's an IIFE requiring `window`/`IndexedDB`/`fetch`, same constraint as `oauth.js`/`sync-pwa.js`). Verify via the same source-extraction technique, in a new file:

Create `tests/pwa-storage-sync.test.js`:

```js
// tests/pwa-storage-sync.test.js — Store.syncNow() used to reject if
// Dbx.getAccessToken threw, and never recorded a "last sync result" anywhere
// the Settings panel could show without the user tapping Sync again. This
// locks in: syncNow always resolves (never rejects), and every outcome
// (not connected / getAccessToken failure / runSyncCycle ok:false / success)
// is persisted to idb's kv store.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

const syncNowIdx = src.indexOf("syncNow(onProgress) {");
const syncNowEnd = src.indexOf("\n    },", syncNowIdx);
const syncNowBody = src.slice(syncNowIdx, syncNowEnd);

t("syncNow persists every outcome via a shared persist() helper", () => {
  assert.ok(/idb\.kvSet\("_pwa_last_sync_result"/.test(syncNowBody), "must write to the _pwa_last_sync_result kv key");
});

t("syncNow's not-connected path is tagged AUTH_EXPIRED for consistent UI branching", () => {
  assert.ok(/code:\s*"AUTH_EXPIRED"/.test(syncNowBody), "the not-connected early return must carry code: AUTH_EXPIRED");
});

t("syncNow catches a thrown getAccessToken/runSyncCycle failure instead of rejecting", () => {
  assert.ok(/\.catch\(/.test(syncNowBody), "must have a .catch() on the getAccessToken->runSyncCycle chain");
});

t("Store exposes lastSyncResult() reading the same kv key", () => {
  assert.ok(/lastSyncResult\(\)\s*\{\s*return idb\.kvGet\("_pwa_last_sync_result"\);\s*\}/.test(src),
    "lastSyncResult() must read _pwa_last_sync_result via idb.kvGet");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pwa-storage-sync.test.js`
Expected: all 4 FAIL (current `syncNow` has none of this).

- [ ] **Step 3: Write minimal implementation**

Replace `pwa/storage-pwa.js`'s `syncStatus()`/`syncNow()` block (lines 141-164) with:

```js
    syncStatus() {
      return idb.kvGet("_pwa_sync_enabled").then((enabled) =>
        window.IASync.ensureDeviceIdentity().then(({ deviceId, deviceLabel }) => ({
          enabled: !!enabled,
          connected: window.IADropbox.isConnected(),
          deviceId, deviceLabel,
        }))
      );
    },
    setSyncEnabled(b) { return idb.kvSet("_pwa_sync_enabled", !!b).then(() => ({ ok: true })); },
    setSyncFolder: () => Promise.resolve({ ok: false, reason: "Not applicable on iPad — always /Interests App/sync/." }),
    setDeviceLabel(label) { return window.IASync.setDeviceLabel(label).then(() => ({ ok: true })); },
    // Reads back what syncNow() last persisted (see below) — lets the Settings
    // panel show "Last sync: succeeded/failed" any time it's opened, not only
    // right after tapping Sync. Desktop's web/storage.js has no equivalent;
    // callers must feature-detect (typeof Store.lastSyncResult === "function").
    lastSyncResult() { return idb.kvGet("_pwa_last_sync_result"); },
    // onProgress (optional): ({phase, done, total}) => void — called periodically
    // during a long sync so callers can show live status instead of a static
    // "Syncing..." that's indistinguishable from a hang for a large library.
    //
    // ALWAYS resolves (never rejects), and persists every outcome — not
    // connected, a thrown getAccessToken/runSyncCycle failure, or a normal
    // result — to idb's kv store via persist(), so lastSyncResult() above
    // always reflects the true last attempt regardless of how it ended.
    syncNow(onProgress) {
      const Dbx = window.IADropbox;
      const appKey = localStorage.getItem(Dbx.LS_KEYS.appKey);
      const persist = (result) => idb.kvSet("_pwa_last_sync_result", Object.assign({ at: Date.now() }, result)).then(() => result);
      if (!appKey || !Dbx.isConnected()) {
        return persist({ ok: false, code: "AUTH_EXPIRED", reason: "Not connected to Dropbox." });
      }
      return Dbx.getAccessToken(appKey)
        .then((token) => window.IASync.runSyncCycle(token, { onProgress }))
        .then((result) => persist(Object.assign({ ok: true }, result)))
        .catch((e) => persist({ ok: false, code: (e && e.code) || "OTHER", reason: (e && e.message) || String(e) }));
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pwa-storage-sync.test.js`
Expected: `4 passed, 0 failed`

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add pwa/storage-pwa.js tests/pwa-storage-sync.test.js
git commit -m "fix(pwa): Store.syncNow() always resolves and persists every outcome for Settings to read back"
```

---

### Task 6: `syncNowClick()` — remove temporary `alert()`s, branch on `code`

**Files:**
- Modify: `pwa/index.html:1461-1477` (current `syncNowClick`, with this session's temporary `alert()` diagnostics)
- Modify: `web/index.html:1422-1426` (current `syncNowClick`, never had the temporary diagnostics — plain original)
- Test: `tests/ux-loop06.test.js` (extend — same file used for this session's earlier UX-5 card-sizing regression tests)

**Interfaces:**
- Consumes: `Store.syncNow()`'s new contract from Task 5 (`{ok:true,...}` | `{ok:false, code:"AUTH_EXPIRED"|"OTHER", reason}`) and `renderSyncStatus()` (unchanged signature, called after an `AUTH_EXPIRED` result so the Settings panel flips to "not connected" immediately).

- [ ] **Step 1: Write the failing test**

Add to `tests/ux-loop06.test.js`, after the existing `UX-5` block (before `console.log("ux-loop06: "...)`):

```js
// UX-6 (2026-07-15 sync-reliability plan): syncNowClick() branches on the
// classified sync result instead of the temporary alert()-based diagnostics
// added earlier this session. Desktop (web/index.html) never had the temp
// diagnostics — this locks in the SAME permanent shape landing on both files.
ok("UX-6: syncNowClick has no leftover temporary diagnostic alert()s", !/TEMPORARY DIAGNOSTIC/.test(src) && !/alert\("Sync result/.test(src) && !/alert\("Sync threw/.test(src));
ok("UX-6: syncNowClick shows a reconnect toast and re-renders sync status on AUTH_EXPIRED", /r\.code === "AUTH_EXPIRED"[\s\S]{0,120}?renderSyncStatus\(\)/.test(src));
ok("UX-6: syncNowClick still shows a generic failure toast for a non-auth failure", /Sync failed: " \+ \(r\.reason \|\| "unknown reason"\)/.test(src));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ux-loop06.test.js`
Expected: `UX-6: syncNowClick shows a reconnect toast...` FAILs against `web/index.html` (the file this test reads — see repo convention comment at the top of the file) since it doesn't have the `AUTH_EXPIRED` branch yet. (The "no leftover alert()" check passes trivially against `web/index.html` since it never had them — Step 3 still must fix `pwa/index.html`, which this source-only test can't see, so manual/visual confirmation on that file is required in Step 4.)

- [ ] **Step 3: Write minimal implementation**

Replace `pwa/index.html`'s `syncNowClick` (lines 1461-1477) with:

```js
async function syncNowClick(){
  toast("Syncing…");
  try{
    const r = await Store.syncNow();
    if(r && r.code === "AUTH_EXPIRED"){ toast("Dropbox connection expired — reconnect in Settings"); await renderSyncStatus(); return; }
    if(r && r.ok === false){ toast("Sync failed: " + (r.reason || "unknown reason")); return; }
    toast(r && r.changed ? "Synced — new items merged in" : "Synced — already up to date");
    if(r && r.changed){ setTimeout(()=>location.reload(), 900); }
  }
  catch(e){
    toast("Sync failed: " + (e&&e.message||e));
  }
}
```

Replace `web/index.html`'s `syncNowClick` (lines 1422-1426) with the identical function:

```js
async function syncNowClick(){
  toast("Syncing…");
  try{
    const r = await Store.syncNow();
    if(r && r.code === "AUTH_EXPIRED"){ toast("Dropbox connection expired — reconnect in Settings"); await renderSyncStatus(); return; }
    if(r && r.ok === false){ toast("Sync failed: " + (r.reason || "unknown reason")); return; }
    toast(r && r.changed ? "Synced — new items merged in" : "Synced — already up to date");
    if(r && r.changed){ setTimeout(()=>location.reload(), 900); }
  }
  catch(e){
    toast("Sync failed: " + (e&&e.message||e));
  }
}
```

(Desktop's `Store.syncNow()` result never carries `.code`, so the `AUTH_EXPIRED` branch is simply never taken there — safe no-op, per this plan's Global Constraints.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ux-loop06.test.js`
Expected: all UX-6 assertions pass (`20 passed, 0 failed` or similar — check the total against the prior count).

Confirm `pwa/index.html`'s `syncNowClick` is identical to `web/index.html`'s, independent of either file's current line numbers:

Run:
```bash
node -e '
const fs = require("fs");
function grab(src, name) {
  const idx = src.indexOf("async function " + name + "(");
  const open = src.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < src.length; i++) { const ch = src[i]; if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(idx, i);
}
const pwa = grab(fs.readFileSync("pwa/index.html", "utf8"), "syncNowClick");
const web = grab(fs.readFileSync("web/index.html", "utf8"), "syncNowClick");
console.log(pwa === web ? "IDENTICAL" : "MISMATCH:\n--pwa--\n" + pwa + "\n--web--\n" + web);
'
```
Expected: `IDENTICAL`

- [ ] **Step 5: Commit**

```bash
git add pwa/index.html web/index.html tests/ux-loop06.test.js
git commit -m "fix(web,pwa): syncNowClick() drops temp diagnostics, shows a real reconnect prompt on a dead Dropbox token"
```

---

### Task 7: `renderSyncStatus()` — persistent "Last sync" line

**Files:**
- Modify: `pwa/index.html:1437-1451` (current `renderSyncStatus`)
- Modify: `web/index.html:1398-1412` (current `renderSyncStatus`, identical)
- Test: `tests/ux-loop06.test.js` (extend)

**Interfaces:**
- Consumes: `Store.lastSyncResult()` from Task 5 — **feature-detected** (`typeof Store.lastSyncResult === "function"`), since `web/storage.js` has no such method.

- [ ] **Step 1: Write the failing test**

Add to `tests/ux-loop06.test.js`, after the UX-6 block:

```js
// UX-6 cont'd: persistent "Last sync" line in the Settings sync-status panel,
// feature-detected since desktop's web/storage.js has no lastSyncResult().
ok("UX-6: renderSyncStatus feature-detects Store.lastSyncResult before calling it", /typeof Store\.lastSyncResult === "function"/.test(src));
ok("UX-6: renderSyncStatus shows a succeeded/failed Last-sync line", /Last sync: <b>succeeded<\/b>/.test(src) && /Last sync: <b>failed<\/b>/.test(src));

console.log("ux-loop06: " + pass + " passed, " + fail + " failed");
```

(Move the pre-existing `console.log("ux-loop06: "...)` line down past these two new assertions rather than duplicating it — see Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ux-loop06.test.js`
Expected: the two new UX-6 assertions FAIL (current `renderSyncStatus` has neither).

- [ ] **Step 3: Write minimal implementation**

First, in `tests/ux-loop06.test.js`, delete the now-duplicated original `console.log("ux-loop06: "...)` line that used to be the file's last line (the Step 1 addition already appended a fresh copy after the new assertions).

Replace `pwa/index.html`'s `renderSyncStatus` (lines 1437-1451) with:

```js
async function renderSyncStatus(){
  const el = document.getElementById("syncStatus"); if(!el) return;
  let st = null; try{ st = await Store.syncStatus(); }catch(e){}
  if(!st){ el.textContent = "Sync status unavailable."; return; }
  const tog = document.getElementById("syncToggle"); if(tog) tog.checked = !!st.enabled;
  const ts = document.getElementById("trustSync"); if(ts) ts.textContent = st.enabled ? ", and shared across your devices through Dropbox" : "";
  const fi = document.getElementById("syncFolderInfo");
  if(fi) fi.textContent = st.folder ? st.folder : (st.dropboxFound ? "(default Dropbox location)" : "Dropbox not found — install Dropbox or pick a folder.");
  const nm = document.getElementById("syncDeviceName"); if(nm && document.activeElement!==nm) nm.value = st.deviceLabel || "";
  const peers = (st.peers||[]).map(p => esc(p.deviceLabel||p.deviceId) + (p.publishedAt ? " ("+new Date(p.publishedAt).toLocaleString()+")" : "")).join(", ") || "none seen yet";
  let lastSyncLine = "";
  if (typeof Store.lastSyncResult === "function") {
    try {
      const last = await Store.lastSyncResult();
      if (last) {
        const when = new Date(last.at).toLocaleString();
        lastSyncLine = last.ok
          ? "<div>Last sync: <b>succeeded</b> " + esc(when) + "</div>"
          : "<div>Last sync: <b>failed</b> — " + esc(last.reason || "unknown reason") + " " + esc(when) + "</div>";
      }
    } catch (e) {}
  }
  el.innerHTML =
    "<div>Status: <b>" + (st.enabled ? "on" : "off") + "</b></div>" +
    "<div>This device: <b>" + esc(st.deviceLabel||"") + "</b></div>" +
    "<div>Other devices: <b>" + peers + "</b></div>" +
    lastSyncLine;
}
```

Replace `web/index.html`'s `renderSyncStatus` (lines 1398-1412) with the identical function shown above.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ux-loop06.test.js`
Expected: `ALL` assertions pass — read the final count printed and confirm `0 failed`.

Also run the full suite:

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 5: Commit**

```bash
git add pwa/index.html web/index.html tests/ux-loop06.test.js
git commit -m "feat(web,pwa): persistent Last-sync status line in Settings (PWA only, feature-detected)"
```

---

### Task 8: Bump `SHELL_CACHE`, full-suite verification, wrap-up

**Files:**
- Modify: `pwa/sw.js` (`SHELL_CACHE` constant)

- [ ] **Step 1: Read the live SHELL_CACHE value**

Run: `grep -n "const SHELL_CACHE" pwa/sw.js`
Expected: prints the current version string, e.g. `const SHELL_CACHE = "interests-pwa-shell-vNN";` — read whatever `NN` actually is; do not assume it matches this plan's earlier references (other work may have bumped it since this plan was written).

- [ ] **Step 2: Bump it by exactly one**

Edit `pwa/sw.js`: change `interests-pwa-shell-vNN` to `interests-pwa-shell-v(NN+1)` using the number read in Step 1 (every task in this plan touched `pwa/index.html` and/or `pwa/*.js` files, all of which fall under the app-shell cache).

- [ ] **Step 3: Run the full test suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`

- [ ] **Step 4: Commit**

```bash
git add pwa/sw.js
git commit -m "chore(pwa): bump SHELL_CACHE for the sync-reliability plan's changes"
```

- [ ] **Step 5: Push and confirm the PWA deploy**

```bash
git push origin master
```

Then confirm the GitHub Pages deploy succeeded (this repo's `.github/workflows/deploy-pwa.yml` auto-deploys on push to `master` when `pwa/**` changes):

Run: `gh run list --workflow=deploy-pwa.yml --limit 1`
Expected: the most recent run shows `completed` / `success` for this plan's final commit.

## Manual verification (human only — cannot be automated by a subagent)

This plan's automated tests confirm the *code* correctly classifies and
propagates a dead-token error. Confirming it end-to-end requires an actual
revoked Dropbox connection, which needs a human with access to the Dropbox
App Console and the deployed PWA on a real device:

1. In the [Dropbox App Console](https://www.dropbox.com/developers/apps),
   revoke this app's access for the connected account (or on the device,
   Settings → Dropbox → Disconnect, then manually clear only
   `localStorage["ia_pwa_access_token"]`/`["ia_pwa_refresh_token"]` via
   Safari's dev tools to simulate a server-side revoke without a full
   disconnect).
2. Tap "Sync now".
3. Confirm the toast reads "Dropbox connection expired — reconnect in
   Settings" (not a generic "Sync failed" or the old misleading "already up
   to date").
4. Open Settings and confirm the sync status panel reflects "not connected"
   immediately, without needing another manual refresh.
5. Reconnect via the existing Dropbox connect flow, tap "Sync now" again,
   and confirm a normal sync completes with a "Last sync: succeeded
   `<time>`" line visible in Settings.
