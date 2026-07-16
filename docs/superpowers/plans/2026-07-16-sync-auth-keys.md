# Sync Reliability v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-device sync 100% reliable: Dropbox auth survives transient failures and token expiry (no more forced re-auth), the PWA syncs automatically, and API keys travel with settings.

**Architecture:** Three independent fixes sharing one spec (`docs/superpowers/specs/2026-07-16-sync-auth-keys-design.md`): (A) `pwa/oauth.js` resolves a fresh token per call and retries once through a single-flight refresh on 401, disconnecting only on definitive auth failure; (B) `pwa/index.html` gains `autoSync()` on boot/foreground/interval sharing an in-flight guard with the manual button; (C) `core/merge.js` gains a pure `mergeSyncedSettings()` (ported verbatim to `pwa/merge.js`) so `keys`/`oprKey` publish and union-merge on apply, while `updateToken` stays device-local.

**Tech Stack:** Vanilla JS (browser IIFE modules + CommonJS core), plain Node `assert` tests run via `node tests/run.js`. No frameworks, no build step.

## Global Constraints

- Tests are plain Node scripts: `node tests/<name>.test.js`; the whole suite must pass via `node tests/run.js` after every task.
- `pwa/index.html` must keep parsing: `node tests/syntax-check.js` is part of `tests/run.js`.
- `pwa/merge.js` is a **verbatim copy** of `core/merge.js` below its 5-line header — never edit it independently; re-copy.
- Any edit under `pwa/` that ships requires bumping `SHELL_CACHE` in `pwa/sw.js` (currently `interests-pwa-shell-v20` at line 21) exactly once for the whole change set (done in Task 6).
- Never commit personal data (`saves.json`, `data/`, backups — see `.claude/skills/project-conventions`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- The repo lives in Dropbox: retry git commands on intermittent `.git` lock errors; CRLF warnings are normal.

---

### Task 1: `mergeSyncedSettings()` in core/merge.js + verbatim re-copy to pwa/merge.js

**Files:**
- Modify: `core/merge.js` (add two functions before the export block at the bottom; extend both export lines)
- Modify: `pwa/merge.js` (regenerate: 5-line header + new core/merge.js content)
- Create: `tests/merge-settings.test.js`

**Interfaces:**
- Produces: `mergeSyncedSettings(local, incoming) -> object` — exported from BOTH `core/merge.js` (CommonJS `module.exports.mergeSyncedSettings`) and `pwa/merge.js` (browser global `mergeSyncedSettings` on `self`/`window`, plus CommonJS for tests). Consumed by Task 2 (`core/db.js`) and Task 3 (`pwa/sync-pwa.js`).

- [ ] **Step 1: Write the failing test**

Create `tests/merge-settings.test.js`:

```js
// tests/merge-settings.test.js — mergeSyncedSettings(): the apply-side merge for
// synced settings. `incoming` won LWW at the blob level, but credentials union
// per-field so a device that never held a key can't wipe it fleet-wide, and the
// desktop-local GitHub updateToken never travels or gets overwritten.
// Runs against BOTH core/merge.js and pwa/merge.js — the pwa file is a verbatim
// copy and must stay in lockstep (also asserted here byte-for-byte).
const assert = require("assert");
const fs = require("fs"), path = require("path");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

const impls = [["core", require("../core/merge.js")], ["pwa", require("../pwa/merge.js")]];

for (const [label, m] of impls) {
  const mergeSyncedSettings = m.mergeSyncedSettings;

  run(label + ": exports mergeSyncedSettings", () => {
    assert.strictEqual(typeof mergeSyncedSettings, "function");
  });

  run(label + ": incoming wins non-credential fields (it won LWW)", () => {
    const out = mergeSyncedSettings({ about: "old", interests: "x" }, { about: "new", weights: { personal: 8 } });
    assert.strictEqual(out.about, "new");
    assert.deepStrictEqual(out.weights, { personal: 8 });
    assert.ok(!("interests" in out), "blob-level LWW: fields absent from incoming are absent from result");
  });

  run(label + ": keys union — incoming provider wins, local-only provider survives", () => {
    const out = mergeSyncedSettings(
      { keys: { openrouter: "LOCAL_OR", groq: "LOCAL_GROQ" } },
      { keys: { openrouter: "INCOMING_OR" } }
    );
    assert.strictEqual(out.keys.openrouter, "INCOMING_OR");
    assert.strictEqual(out.keys.groq, "LOCAL_GROQ");
  });

  run(label + ": empty/whitespace/non-string incoming key values never clobber local", () => {
    const out = mergeSyncedSettings(
      { keys: { openrouter: "LOCAL_OR", groq: "LOCAL_GROQ", gemini: "LOCAL_GEM" } },
      { keys: { openrouter: "", groq: "   ", gemini: 42 } }
    );
    assert.strictEqual(out.keys.openrouter, "LOCAL_OR");
    assert.strictEqual(out.keys.groq, "LOCAL_GROQ");
    assert.strictEqual(out.keys.gemini, "LOCAL_GEM");
  });

  run(label + ": a fresh device's missing/empty keys object can't wipe the fleet", () => {
    const out = mergeSyncedSettings({ keys: { openrouter: "LOCAL_OR" } }, { about: "fresh device edit" });
    assert.strictEqual(out.keys.openrouter, "LOCAL_OR");
  });

  run(label + ": oprKey — incoming non-empty wins, empty/missing keeps local", () => {
    assert.strictEqual(mergeSyncedSettings({ oprKey: "L" }, { oprKey: "I" }).oprKey, "I");
    assert.strictEqual(mergeSyncedSettings({ oprKey: "L" }, { oprKey: "" }).oprKey, "L");
    assert.strictEqual(mergeSyncedSettings({ oprKey: "L" }, {}).oprKey, "L");
    assert.ok(!("oprKey" in mergeSyncedSettings({}, {})), "absent on both sides stays absent");
  });

  run(label + ": updateToken NEVER travels and is never overwritten", () => {
    const out = mergeSyncedSettings({ updateToken: "LOCAL_GH" }, { updateToken: "ATTACKER_OR_STALE" });
    assert.strictEqual(out.updateToken, "LOCAL_GH");
    assert.ok(!("updateToken" in mergeSyncedSettings({}, { updateToken: "X" })), "no local token -> none in result");
  });

  run(label + ": garbage inputs don't throw", () => {
    assert.doesNotThrow(() => mergeSyncedSettings(null, null));
    assert.doesNotThrow(() => mergeSyncedSettings(undefined, { keys: null }));
    assert.doesNotThrow(() => mergeSyncedSettings({ keys: "not-an-object" }, { keys: ["arr"] }));
    const out = mergeSyncedSettings(null, { about: "x" });
    assert.strictEqual(out.about, "x");
  });
}

run("pwa/merge.js is still a verbatim copy of core/merge.js (below its header)", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "core", "merge.js"), "utf8").replace(/\r\n/g, "\n");
  const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "merge.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(pwa.indexOf(core) >= 0, "pwa/merge.js must contain core/merge.js verbatim — re-copy it");
});

console.log("merge-settings: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/merge-settings.test.js`
Expected: FAILs — `mergeSyncedSettings` is not a function (both impls).

- [ ] **Step 3: Implement in core/merge.js**

In `core/merge.js`, insert immediately BEFORE the line `if (typeof module !== "undefined" && module.exports) ...`:

```js
  // Apply-side merge for synced settings (2026-07-16 spec): `incoming` won
  // last-writer-wins at the blob level, but credentials merge per-field —
  // a device that has never held a key publishes an empty keys object before
  // its first receive, and must not wipe the fleet's keys. updateToken is a
  // desktop-local GitHub credential: never travels, never overwritten.
  function _nonEmptyStrings(obj) {
    var out = {};
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      Object.keys(obj).forEach(function (k) {
        if (typeof obj[k] === "string" && obj[k].trim()) out[k] = obj[k];
      });
    }
    return out;
  }
  function mergeSyncedSettings(local, incoming) {
    local = (local && typeof local === "object") ? local : {};
    incoming = (incoming && typeof incoming === "object") ? incoming : {};
    var merged = Object.assign({}, incoming);
    var localKeys = (local.keys && typeof local.keys === "object" && !Array.isArray(local.keys)) ? local.keys : {};
    merged.keys = Object.assign({}, localKeys, _nonEmptyStrings(incoming.keys));
    if (typeof incoming.oprKey === "string" && incoming.oprKey.trim()) merged.oprKey = incoming.oprKey;
    else if (local.oprKey != null) merged.oprKey = local.oprKey;
    else delete merged.oprKey;
    if (local.updateToken != null) merged.updateToken = local.updateToken;
    else delete merged.updateToken;
    return merged;
  }

```

Then extend the two export lines at the bottom to:

```js
  if (typeof module !== "undefined" && module.exports) module.exports = { mergeSnapshots: mergeSnapshots, mergeSyncedSettings: mergeSyncedSettings, _stable: _stable };
  if (root) { root.mergeSnapshots = mergeSnapshots; root.mergeSyncedSettings = mergeSyncedSettings; root._iaStable = _stable; }
```

- [ ] **Step 4: Regenerate pwa/merge.js**

Overwrite `pwa/merge.js` with: its existing 5-line header comment (the block starting `// pwa/merge.js — verbatim copy of core/merge.js.` and ending with the blank line) followed by the new full content of `core/merge.js`. Do not hand-edit the body.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/merge-settings.test.js`
Expected: all pass, `0 failed`.
Then: `node tests/merge.test.js` (existing merge behavior untouched)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/merge.js pwa/merge.js tests/merge-settings.test.js
git commit -m "feat(merge): mergeSyncedSettings — per-field credential union for settings apply

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Desktop key sync — core/db.js publish + apply

**Files:**
- Modify: `core/db.js` (`settingsForSync` ~line 437, `applySyncedSettings` ~line 449, add a require near the top of the file next to any existing requires)
- Modify: `tests/sync-settings.test.js` (rewrite expectations)

**Interfaces:**
- Consumes: `mergeSyncedSettings(local, incoming)` from `core/merge.js` (Task 1).
- Produces: `settingsForSync(db)` now returns `data` INCLUDING `keys` and `oprKey` (still excluding `updateToken`); `applySyncedSettings(db, incoming, updatedAt)` union-merges credentials. Signatures unchanged — `core/sync.js` callers untouched.

- [ ] **Step 1: Rewrite the test file to the new contract**

Replace the three settings-behavior tests and the end-to-end test in `tests/sync-settings.test.js` (keep the `mergeSnapshots` LWW tests in the middle of the file unchanged):

Replace the first `run(...)` block with:

```js
run("settingsForSync keeps keys + oprKey (they sync now), strips only updateToken, reads updatedAt", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "me", interests: "x", weights: { personal: 8 }, keys: { openrouter: "ORKEY" }, oprKey: "OPRKEY", updateToken: "GH_LOCAL" }));
  db.setKV(d, "ia_settings_updatedAt", "1700");
  const s = db.settingsForSync(d);
  assert.strictEqual(s.updatedAt, 1700);
  assert.strictEqual(s.data.about, "me");
  assert.strictEqual(s.data.weights.personal, 8);
  assert.strictEqual(s.data.keys.openrouter, "ORKEY", "provider keys sync (2026-07-16 decision)");
  assert.strictEqual(s.data.oprKey, "OPRKEY", "OPR key syncs (2026-07-16 decision)");
  assert.ok(!("updateToken" in s.data), "GitHub update token must NEVER sync");
});
```

Replace the `applySyncedSettings overlays incoming but PRESERVES local keys/oprKey + bumps stamp` block with:

```js
run("applySyncedSettings union-merges keys: incoming wins per provider, local-only survives, stamp bumps", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "old", keys: { openrouter: "MYKEY", groq: "MYGROQ" }, oprKey: "MYOPR", updateToken: "GH_LOCAL" }));
  db.applySyncedSettings(d, { about: "new", keys: { openrouter: "PEERKEY", gemini: "PEERGEM" }, oprKey: "", updateToken: "PEER_GH_MUST_NOT_LAND" }, 2000);
  const merged = JSON.parse(db.getKV(d, "ia_settings"));
  assert.strictEqual(merged.about, "new");
  assert.strictEqual(merged.keys.openrouter, "PEERKEY", "incoming provider key wins");
  assert.strictEqual(merged.keys.groq, "MYGROQ", "local-only provider key survives");
  assert.strictEqual(merged.keys.gemini, "PEERGEM", "new provider key arrives");
  assert.strictEqual(merged.oprKey, "MYOPR", "empty incoming oprKey doesn't clobber");
  assert.strictEqual(merged.updateToken, "GH_LOCAL", "updateToken always local");
  assert.strictEqual(db.getKV(d, "ia_settings_updatedAt"), "2000");
});

run("applySyncedSettings: a fresh device's keyless blob can't wipe local keys", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ keys: { openrouter: "MYKEY" } }));
  db.applySyncedSettings(d, { about: "fresh device edit" }, 3000);
  const merged = JSON.parse(db.getKV(d, "ia_settings"));
  assert.strictEqual(merged.keys.openrouter, "MYKEY");
});
```

Replace the END-TO-END test with:

```js
const sync = require("../core/sync.js");
run("END-TO-END: A's settings+keys publish and merge into B; B-only key survives; updateToken never travels", () => {
  const rootd = fs.mkdtempSync(path.join(os.tmpdir(), "ia-synce2e-"));
  const storeA = path.join(rootd, "A"); fs.mkdirSync(path.join(storeA, "images"), { recursive: true });
  const storeB = path.join(rootd, "B"); fs.mkdirSync(path.join(storeB, "images"), { recursive: true });
  const syncDir = path.join(rootd, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const ctxA = { db: db.openDb(storeA), storeDir: storeA };
  const ctxB = { db: db.openDb(storeB), storeDir: storeB };
  db.setKV(ctxA.db, "ia_settings", JSON.stringify({ about: "A about", interests: "woodworking", keys: { openrouter: "AKEY" }, oprKey: "AOPR", updateToken: "A_GH_TOKEN" }));
  db.setKV(ctxA.db, "ia_settings_updatedAt", "5000");
  db.setKV(ctxB.db, "ia_settings", JSON.stringify({ about: "B old", keys: { groq: "B_GROQ_ONLY" } }));
  db.setKV(ctxB.db, "ia_settings_updatedAt", "1000");

  sync.runSync(ctxA, { syncDir: syncDir, deviceId: "devA", deviceLabel: "A", backupFn: function () {} });
  const snapRaw = fs.readFileSync(path.join(syncDir, "devA", "snapshot.json"), "utf8");
  assert.ok(snapRaw.indexOf("A about") >= 0, "published snapshot must include settings");
  assert.ok(snapRaw.indexOf("AKEY") >= 0, "provider key must publish (2026-07-16 decision)");
  assert.ok(snapRaw.indexOf("AOPR") >= 0, "OPR key must publish");
  assert.ok(snapRaw.indexOf("A_GH_TOKEN") < 0, "updateToken must NEVER be published");

  sync.runSync(ctxB, { syncDir: syncDir, deviceId: "devB", deviceLabel: "B", backupFn: function () {} });
  const bSettings = JSON.parse(db.getKV(ctxB.db, "ia_settings"));
  assert.strictEqual(bSettings.about, "A about", "A's newer settings propagated to B");
  assert.strictEqual(bSettings.keys.openrouter, "AKEY", "A's provider key arrived on B");
  assert.strictEqual(bSettings.keys.groq, "B_GROQ_ONLY", "B's own key survived the merge");
  assert.ok(!("updateToken" in bSettings), "no updateToken landed on B");
});
```

Also update the file's first-line comment to `// tests/sync-settings.test.js — cross-device settings sync (keys union-merge, updateToken local-only, LWW merge).`

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node tests/sync-settings.test.js`
Expected: the rewritten cases FAIL (keys still stripped / force-preserved); `mergeSnapshots` cases still pass.

- [ ] **Step 3: Implement in core/db.js**

Near the top of `core/db.js`, next to the existing `require` lines, add:

```js
const { mergeSyncedSettings } = require("./merge.js");
```

Replace `settingsForSync` (~line 437) with:

```js
// Settings for cross-device sync: the ia_settings blob plus its last-modified
// stamp for last-writer-wins merge. Provider keys + the Open PageRank key SYNC
// as of the 2026-07-16 spec (user decision: plaintext inside the user's own
// Dropbox). Only updateToken (a per-device GitHub credential for the desktop
// auto-updater) never leaves the machine. Absent settings → {data:null, updatedAt:0}.
function settingsForSync(db) {
  let s;
  try { s = JSON.parse(getKV(db, "ia_settings") || "null"); } catch (e) { s = null; }
  if (!s || typeof s !== "object") return { data: null, updatedAt: 0 };
  const clean = Object.assign({}, s);
  delete clean.updateToken;  // GitHub update token — a per-device credential; never syncs
  return { data: clean, updatedAt: Number(getKV(db, "ia_settings_updatedAt") || 0) || 0 };
}
```

In `applySyncedSettings` (~line 449), replace the line

```js
  const merged = Object.assign({}, incoming, { keys: local.keys, oprKey: local.oprKey, updateToken: local.updateToken });
```

with

```js
  const merged = mergeSyncedSettings(local, incoming);
```

(Everything else in `applySyncedSettings` — the oversized-blob guard, the setKV calls — stays byte-identical.)

- [ ] **Step 4: Run tests**

Run: `node tests/sync-settings.test.js`
Expected: all pass.
Run: `node tests/db.test.js && node tests/db-sync.test.js && node tests/sync-snapshot.test.js && node tests/synctimers.test.js`
Expected: PASS (if any of these assert the old strip behavior, update those assertions to the new contract in the same way as Step 1 — same decision, same comment reference).

- [ ] **Step 5: Commit**

```bash
git add core/db.js tests/sync-settings.test.js
git commit -m "feat(sync): provider keys + oprKey sync across devices; updateToken stays local

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: PWA key sync — pwa/sync-pwa.js publish + apply

**Files:**
- Modify: `pwa/sync-pwa.js` (`stripSecrets` line 62, settings block in `applyMergeToLocal` lines 230-241)
- Create: `tests/pwa-sync-settings-wiring.test.js`

**Interfaces:**
- Consumes: browser global `mergeSyncedSettings` from `pwa/merge.js` (Task 1) — same bare-global pattern `sync-pwa.js` already uses for `mergeSnapshots` (line 339).

- [ ] **Step 1: Write the failing test**

Create `tests/pwa-sync-settings-wiring.test.js`:

```js
// tests/pwa-sync-settings-wiring.test.js — the PWA side of key sync must match
// core/db.js: publish keys+oprKey (strip only updateToken), apply via the shared
// mergeSyncedSettings union instead of force-preserving local credentials.
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

t("stripSecrets strips ONLY updateToken now — keys and oprKey sync", () => {
  const body = grab(src, "stripSecrets");
  assert.ok(/delete clean\.updateToken/.test(body), "must still strip updateToken");
  assert.ok(!/delete clean\.keys/.test(body), "keys must sync (2026-07-16 decision)");
  assert.ok(!/delete clean\.oprKey/.test(body), "oprKey must sync (2026-07-16 decision)");
});

t("applyMergeToLocal merges settings via mergeSyncedSettings, not blanket local-key preservation", () => {
  const body = grab(src, "applyMergeToLocal");
  assert.ok(/mergeSyncedSettings\(\s*local\s*,\s*plan\.settings\.data\s*\)/.test(body),
    "must call mergeSyncedSettings(local, plan.settings.data)");
  assert.ok(!/keys:\s*local\.keys/.test(body), "old force-preserve of local.keys must be gone");
});

t("index.html loads merge.js before sync-pwa.js (bare-global dependency order)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");
  const mergeIdx = html.indexOf("merge.js");
  const syncIdx = html.indexOf("sync-pwa.js");
  assert.ok(mergeIdx >= 0 && syncIdx >= 0 && mergeIdx < syncIdx, "merge.js must load before sync-pwa.js");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/pwa-sync-settings-wiring.test.js`
Expected: first two FAIL (old strip/preserve behavior); the load-order test should already pass.

- [ ] **Step 3: Implement in pwa/sync-pwa.js**

Replace `stripSecrets` (lines 60-68) with:

```js
  // Mirrors core/db.js's settingsForSync: provider keys + the Open PageRank key
  // SYNC as of the 2026-07-16 spec (user decision — plaintext inside the user's
  // own Dropbox). Only updateToken (desktop auto-updater GitHub credential,
  // meaningless on an iPad anyway) stays behind.
  function stripSecrets(s) {
    const clean = Object.assign({}, s);
    delete clean.updateToken;
    return clean;
  }
```

In `applyMergeToLocal`, replace the settings block (lines 230-241) with:

```js
    let settingsApplied = false;
    if (plan.settings && plan.settings.data) {
      try {
        const local = (await idb.kvGet("ia_settings")) || {};
        const merged = mergeSyncedSettings(local, plan.settings.data); // pwa/merge.js — global, like mergeSnapshots
        await idb.kvSet("ia_settings", merged);
        await idb.kvSet("ia_settings_updatedAt", Number(plan.settings.updatedAt) || Date.now());
        settingsApplied = true;
      } catch (e) {
        console.error("sync: applying synced settings failed:", e.message);
      }
    }
```

- [ ] **Step 4: Run tests**

Run: `node tests/pwa-sync-settings-wiring.test.js && node tests/pwa-sync-readpeers.test.js && node tests/pwa-sync-runcycle.test.js && node tests/pwa-storage-sync.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pwa/sync-pwa.js tests/pwa-sync-settings-wiring.test.js
git commit -m "feat(pwa): provider keys + oprKey sync on the PWA side via mergeSyncedSettings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: oauth.js — refresh classification (definitive vs transient)

**Files:**
- Modify: `pwa/oauth.js` (`refreshAccessToken` lines 110-138, `getAccessToken` lines 157-161)
- Modify: `tests/pwa-oauth-classify.test.js` (the `refreshAccessToken` assertions, lines 61-68)

**Interfaces:**
- Produces: `refreshAccessToken(appKey)` — throws `err.code === "AUTH_EXPIRED"` + calls `disconnect()` ONLY for (a) no refresh token on file, (b) token endpoint HTTP 400/401; throws `err.code === "OTHER"` with tokens INTACT for network failure/429/5xx. New `sharedRefreshAccessToken(appKey)` single-flight wrapper (module-level `_refreshPromise`), used by `getAccessToken` and Task 5's `dbxAuthedFetch`.

- [ ] **Step 1: Update the test to the new contract**

In `tests/pwa-oauth-classify.test.js`, replace the `refreshAccessToken tags a failed refresh AUTH_EXPIRED and disconnects` test with:

```js
t("refreshAccessToken: definitive failures (no token on file; 400/401) disconnect + AUTH_EXPIRED", () => {
  const body = grab(src, "refreshAccessToken");
  const disconnectCount = (body.match(/disconnect\(\)/g) || []).length;
  assert.strictEqual(disconnectCount, 2, "exactly two disconnect() calls: no-refresh-token and invalid_grant (400/401)");
  assert.ok(/res\.status === 400 \|\| res\.status === 401/.test(body),
    "the token-endpoint disconnect must be gated on 400/401 (Dropbox rejects a dead refresh token with 400 invalid_grant)");
  const codeCount = (body.match(/err\.code = "AUTH_EXPIRED"/g) || []).length;
  assert.strictEqual(codeCount, 2, "exactly the two definitive paths tag AUTH_EXPIRED");
});

t("refreshAccessToken: transient failures (network throw; 429/5xx) keep tokens and tag OTHER", () => {
  const body = grab(src, "refreshAccessToken");
  const otherCount = (body.match(/err\.code = "OTHER"/g) || []).length;
  assert.ok(otherCount >= 2, "network-throw and non-400/401 HTTP paths must both tag OTHER (found " + otherCount + ")");
  assert.ok(/try \{[\s\S]*?res = await fetch\(/.test(body),
    "the token-endpoint fetch itself must be wrapped so an offline moment doesn't look like a dead refresh token");
});

t("getAccessToken refreshes through the single-flight wrapper", () => {
  const body = grab(src, "getAccessToken");
  assert.ok(/sharedRefreshAccessToken\(appKey\)/.test(body), "must use sharedRefreshAccessToken, not a direct refresh");
});
```

- [ ] **Step 2: Run to verify the updated tests fail**

Run: `node tests/pwa-oauth-classify.test.js`
Expected: the three new/changed tests FAIL; the untouched ones PASS.

- [ ] **Step 3: Implement in pwa/oauth.js**

Replace `refreshAccessToken` (lines 110-138) with:

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
  let res;
  try {
    res = await fetch(DBX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (e) {
    // Offline / DNS / captive portal — says NOTHING about the refresh token's
    // validity. Tokens stay; the next attempt retries with the same one.
    const err = new Error("Token refresh failed (network): " + ((e && e.message) || e));
    err.code = "OTHER";
    throw err;
  }
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (!res.ok) {
    const detail = (json && (json.error_description || json.error)) || res.statusText;
    // Dropbox rejects a revoked/expired refresh token with 400 invalid_grant
    // (401 for a bad client). Only THAT is definitive. A 429/5xx is a bad
    // moment at the token endpoint — wiping a still-valid refresh token here
    // is exactly the "keeps disconnecting" bug this replaces.
    if (res.status === 400 || res.status === 401) {
      disconnect();
      const err = new Error(detail);
      err.code = "AUTH_EXPIRED";
      err.status = res.status;
      throw err;
    }
    const err = new Error("Token refresh failed (" + res.status + "): " + detail);
    err.code = "OTHER";
    err.status = res.status;
    throw err;
  }
  storeTokens(json);
  return json.access_token;
}

// Single-flight: N concurrent workers (4 image workers all 401ing at the same
// instant) share ONE refresh call instead of stampeding the token endpoint —
// same shared-gate reasoning as fetchWithRetry's rateLimitedUntil below.
let _refreshPromise = null;
function sharedRefreshAccessToken(appKey) {
  if (!_refreshPromise) {
    _refreshPromise = refreshAccessToken(appKey).finally(() => { _refreshPromise = null; });
  }
  return _refreshPromise;
}
```

Replace `getAccessToken` (lines 157-161) body's last line `return refreshAccessToken(appKey);` with `return sharedRefreshAccessToken(appKey);`.

- [ ] **Step 4: Run tests**

Run: `node tests/pwa-oauth-classify.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add pwa/oauth.js tests/pwa-oauth-classify.test.js
git commit -m "fix(pwa): token refresh only disconnects on definitive auth failure, single-flight

A transient 429/5xx/network failure at Dropbox's token endpoint used to wipe
the (still valid) refresh token and force a full re-auth — the core of the
'Dropbox keeps disconnecting' complaint.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: oauth.js — fresh token per call + 401 refresh-retry at the choke point

**Files:**
- Modify: `pwa/oauth.js` (add `canRefresh`/`resolveToken`/`dbxAuthedFetch` after `sharedRefreshAccessToken`; rewrite `dbxApiCall` line 229, `dbxDownload` line 243, `getCurrentAccount` line 258, `dbxDownloadBinary` line 267, `dbxUpload` line 284)
- Create: `tests/pwa-oauth-authretry.test.js`

**Interfaces:**
- Consumes: `sharedRefreshAccessToken(appKey)` (Task 4).
- Produces: all five Dropbox HTTP entry points resolve their token internally per call and survive one mid-flight token expiry. **Every existing signature is unchanged** — the `accessToken` parameter becomes a fallback for disconnected edge cases, so `sync-pwa.js`, `restore-from-backup.js`, `dropbox-connect.js`, `storage-pwa.js` need zero changes.

- [ ] **Step 1: Write the failing test**

Create `tests/pwa-oauth-authretry.test.js`:

```js
// tests/pwa-oauth-authretry.test.js — the 'Dropbox keeps disconnecting' fix.
// A 401 mid-cycle used to disconnect() immediately (wiping the refresh token)
// even though the refresh token was valid — e.g. iOS suspends the PWA mid-sync
// and resumes after the 4h access token died. Now: fresh token resolved per
// call, one shared refresh + one retry on 401, and only a fresh-token 401 is
// treated as definitive. Functional tests eval the extracted functions with
// shimmed localStorage (direct-eval closure capture, same technique as
// tests/pwa-oauth-classify.test.js).
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
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

// --- shims the eval'd functions close over ---
const LS_KEYS = { appKey: "ia_pwa_app_key", redirectUri: "ia_pwa_redirect_uri", accessToken: "ia_pwa_access_token", refreshToken: "ia_pwa_refresh_token", expiresAt: "ia_pwa_expires_at" };
let store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null) };
let refreshCalls = 0, refreshImpl = async () => { refreshCalls++; return "FRESH"; };
async function sharedRefreshAccessToken(appKey) { return refreshImpl(appKey); }
let getAccessTokenCalls = 0;
async function getAccessToken(appKey) { getAccessTokenCalls++; return "RESOLVED"; }

const canRefresh = eval("(" + grab(src, "canRefresh") + ")");
const resolveToken = eval("(" + grab(src, "resolveToken") + ")");
const dbxAuthedFetch = eval("(" + grab(src, "dbxAuthedFetch") + ")");

t("canRefresh: true only with BOTH app key and refresh token stored", async () => {
  store = {}; assert.strictEqual(canRefresh(), false);
  store = { ia_pwa_app_key: "k" }; assert.strictEqual(canRefresh(), false);
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" }; assert.strictEqual(canRefresh(), true);
});

t("resolveToken: prefers live getAccessToken when refreshable; falls back to the passed token; then stored token; then AUTH_EXPIRED", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  assert.strictEqual(await resolveToken("FALLBACK"), "RESOLVED");
  store = {};
  assert.strictEqual(await resolveToken("FALLBACK"), "FALLBACK");
  store = { ia_pwa_access_token: "STORED" };
  assert.strictEqual(await resolveToken(null), "STORED");
  store = {};
  await assert.rejects(() => resolveToken(null), (e) => e.code === "AUTH_EXPIRED");
});

t("dbxAuthedFetch: 401 -> ONE shared refresh -> exactly one retry with the fresh token", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  refreshCalls = 0; refreshImpl = async () => { refreshCalls++; return "FRESH"; };
  const seen = [];
  const res = await dbxAuthedFetch(null, async (token) => {
    seen.push(token);
    return seen.length === 1 ? { status: 401 } : { status: 200, ok: true };
  });
  assert.deepStrictEqual(seen, ["RESOLVED", "FRESH"]);
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(res.status, 200);
});

t("dbxAuthedFetch: still-401 after the retry is returned (caller's dbxError path decides), NOT retried again", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  refreshImpl = async () => "FRESH";
  let calls = 0;
  const res = await dbxAuthedFetch(null, async () => { calls++; return { status: 401 }; });
  assert.strictEqual(calls, 2, "exactly one retry");
  assert.strictEqual(res.status, 401);
});

t("dbxAuthedFetch: a transient (OTHER) refresh failure propagates without a second request", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  refreshImpl = async () => { const e = new Error("503 from token endpoint"); e.code = "OTHER"; throw e; };
  let calls = 0;
  await assert.rejects(
    () => dbxAuthedFetch(null, async () => { calls++; return { status: 401 }; }),
    (e) => e.code === "OTHER"
  );
  assert.strictEqual(calls, 1);
});

t("dbxAuthedFetch: no refresh capability -> a 401 is returned as-is (no refresh attempt)", async () => {
  store = {};
  refreshCalls = 0; refreshImpl = async () => { refreshCalls++; return "FRESH"; };
  const res = await dbxAuthedFetch("FALLBACK", async () => ({ status: 401 }));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(refreshCalls, 0);
});

t("all five Dropbox entry points route through dbxAuthedFetch", () => {
  for (const fn of ["dbxApiCall", "dbxDownload", "dbxDownloadBinary", "dbxUpload", "getCurrentAccount"]) {
    const body = grab(src, fn);
    assert.ok(/dbxAuthedFetch\(/.test(body), fn + " must route through dbxAuthedFetch");
    assert.ok(/Bearer \$\{token\}/.test(body), fn + " must use the per-call resolved token, not the stale parameter");
  }
});

t("getCurrentAccount failures now classify through dbxError (it used to throw a bare Error)", () => {
  const body = grab(src, "getCurrentAccount");
  assert.ok(/throw dbxError\(res\.status/.test(body), "must throw dbxError(res.status, ...)");
  assert.ok(!/throw new Error\(/.test(body), "no bare Error");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/pwa-oauth-authretry.test.js`
Expected: FAIL — `not found: canRefresh`.

- [ ] **Step 3: Implement in pwa/oauth.js**

Insert after `sharedRefreshAccessToken` (from Task 4):

```js
function canRefresh() {
  return !!(localStorage.getItem(LS_KEYS.appKey) && localStorage.getItem(LS_KEYS.refreshToken));
}

// Resolve the freshest usable token at CALL time, not cycle-start time. The old
// design fetched one token string per sync cycle and threaded it through every
// call — if iOS suspended the PWA mid-cycle and resumed after the ~4h access
// token died, every remaining call 401'd and (worse) nuked the whole connection.
// Fallback chain keeps disconnected edge cases working: callers that hold an
// explicit token (restore-from-backup during connect, etc.) still function.
async function resolveToken(fallbackToken) {
  if (canRefresh()) return getAccessToken(localStorage.getItem(LS_KEYS.appKey));
  if (fallbackToken) return fallbackToken;
  const stored = localStorage.getItem(LS_KEYS.accessToken);
  if (stored) return stored;
  const err = new Error("Not connected to Dropbox.");
  err.code = "AUTH_EXPIRED";
  throw err;
}

// Auth choke point for every Dropbox HTTP call: resolve a fresh token, make the
// request, and on a 401 refresh (single-flight) and retry EXACTLY once. Only a
// fresh-token 401 reaches the caller's dbxError(401) path — which is what makes
// that path's disconnect() finally correct: by then the rejection is definitive.
async function dbxAuthedFetch(fallbackToken, makeRequest) {
  let token = await resolveToken(fallbackToken);
  let res = await makeRequest(token);
  if (res.status === 401 && canRefresh()) {
    token = await sharedRefreshAccessToken(localStorage.getItem(LS_KEYS.appKey));
    res = await makeRequest(token);
  }
  return res;
}
```

Rewrite the five entry points (bodies only — signatures identical):

```js
async function dbxApiCall(accessToken, endpoint, argBody) {
  const res = await dbxAuthedFetch(accessToken, (token) => fetchWithRetry(`${DBX_API_URL}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(argBody || {}),
  }));
  const json = await res.json();
  if (!res.ok) throw dbxError(res.status, json.error_summary || res.statusText);
  return json;
}

async function dbxDownload(accessToken, path) {
  const res = await dbxAuthedFetch(accessToken, (token) => fetchWithRetry(`${DBX_CONTENT_URL}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  }));
  if (!res.ok) {
    const errText = await res.text();
    throw dbxError(res.status, `download ${path}: ${res.status} ${errText}`);
  }
  return res.text();
}

async function getCurrentAccount(accessToken) {
  const res = await dbxAuthedFetch(accessToken, (token) => fetch(`${DBX_API_URL}/users/get_current_account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }));
  if (!res.ok) throw dbxError(res.status, "users/get_current_account failed: " + res.status);
  return res.json();
}

async function dbxDownloadBinary(accessToken, path) {
  const res = await dbxAuthedFetch(accessToken, (token) => fetchWithRetry(`${DBX_CONTENT_URL}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  }));
  if (!res.ok) {
    const errText = await res.text();
    throw dbxError(res.status, `download ${path}: ${res.status} ${errText}`);
  }
  return res.arrayBuffer();
}

// mode: "overwrite" (default, matches desktop's atomic-write-then-rename intent —
// Dropbox itself makes a single PUT atomic from a reader's perspective) or "add".
async function dbxUpload(accessToken, path, contentBytesOrString, mode) {
  const res = await dbxAuthedFetch(accessToken, (token) => fetchWithRetry(`${DBX_CONTENT_URL}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: mode || "overwrite", mute: true }),
    },
    body: contentBytesOrString,
  }));
  if (!res.ok) {
    const errText = await res.text();
    throw dbxError(res.status, `upload ${path}: ${res.status} ${errText}`);
  }
  return res.json();
}
```

(Note: an ArrayBuffer/string body is safe to resend on the retry — `fetch` copies it; nothing is consumed.)

- [ ] **Step 4: Run tests**

Run: `node tests/pwa-oauth-authretry.test.js && node tests/pwa-oauth-classify.test.js`
Expected: all PASS. (The classify test's `every Dropbox-call throw site uses dbxError` case must still pass — the rewritten bodies keep `throw dbxError(res.status, ...)`.)

- [ ] **Step 5: Commit**

```bash
git add pwa/oauth.js tests/pwa-oauth-authretry.test.js
git commit -m "fix(pwa): per-call token resolution + single 401 refresh-retry at the Dropbox choke point

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: PWA auto-sync + shared in-flight guard + SHELL_CACHE bump

**Files:**
- Modify: `pwa/index.html` (rewrite `syncNowClick` at line 1474; add `autoSync` block after it; add `autoSync("boot")` after `maybeAutoBackup()` at line 5196 area)
- Modify: `pwa/sw.js` line 21 (`interests-pwa-shell-v20` → `interests-pwa-shell-v21`)
- Create: `tests/pwa-autosync-wiring.test.js`

**Interfaces:**
- Consumes: `Store.syncNow()` / `Store.syncStatus()` (`pwa/storage-pwa.js`, unchanged), `toast(msg, ms, onclick)` (line 887), `renderSyncStatus()` (line 1437), `_booted` (line ~834).
- Produces: `autoSync(trigger)`, module globals `_syncInFlight`, `_lastAutoSyncAt`, `_authToastShown`, constants `AUTO_SYNC_COOLDOWN`, `AUTO_SYNC_INTERVAL`.

- [ ] **Step 1: Write the failing test**

Create `tests/pwa-autosync-wiring.test.js`:

```js
// tests/pwa-autosync-wiring.test.js — the PWA used to sync ONLY from the manual
// "Sync now" button; settings/cards changed elsewhere never arrived unless the
// user remembered to tap it. This locks in the auto-sync wiring: boot +
// foreground + interval triggers, one shared in-flight guard with the manual
// button, cooldown, and a once-per-disconnect reconnect toast.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

t("autoSync exists with cooldown + interval constants", () => {
  assert.ok(/async function autoSync\(/.test(src), "autoSync must exist");
  assert.ok(/AUTO_SYNC_COOLDOWN\s*=\s*5\*60\*1000/.test(src), "5-minute cooldown");
  assert.ok(/AUTO_SYNC_INTERVAL\s*=\s*15\*60\*1000/.test(src), "15-minute interval");
});

t("autoSync bails when not booted, in flight, cooling down, disabled, or disconnected", () => {
  const body = src.slice(src.indexOf("async function autoSync("), src.indexOf("}", src.indexOf("async function autoSync(")) + 1);
  // cheap containment checks against the whole function region instead
  const region = src.slice(src.indexOf("async function autoSync("), src.indexOf("async function autoSync(") + 1600);
  assert.ok(/_booted/.test(region), "must check _booted");
  assert.ok(/_syncInFlight/.test(region), "must check the shared in-flight guard");
  assert.ok(/AUTO_SYNC_COOLDOWN/.test(region), "must enforce the cooldown");
  assert.ok(/st\.enabled/.test(region) && /st\.connected/.test(region), "must check syncStatus().enabled + .connected");
});

t("all three triggers are wired: boot, visibilitychange, interval", () => {
  assert.ok(/autoSync\("boot"\)/.test(src), "bootData must fire autoSync(\"boot\")");
  const bootedIdx = src.indexOf("_booted = true");
  assert.ok(bootedIdx >= 0 && src.indexOf('autoSync("boot")') > bootedIdx, "boot trigger must come AFTER _booted = true");
  assert.ok(/visibilitychange[\s\S]{0,120}autoSync\("visible"\)/.test(src), "foreground trigger");
  assert.ok(/setInterval\(\(\)=>autoSync\("interval"\), AUTO_SYNC_INTERVAL\)/.test(src), "interval trigger");
});

t("syncNowClick shares the in-flight guard (no overlapping cycles) and clears it in finally", () => {
  const start = src.indexOf("async function syncNowClick(");
  const region = src.slice(start, start + 1600);
  assert.ok(/if\(_syncInFlight\)/.test(region), "manual tap must refuse to start a second concurrent cycle");
  assert.ok(/finally\{[\s\S]{0,80}_syncInFlight = null/.test(region), "guard must clear in finally (a thrown sync must not wedge auto-sync forever)");
});

t("AUTH_EXPIRED toasts once per disconnect, reset on success", () => {
  assert.ok(/_authToastShown/.test(src), "needs the once-per-disconnect flag");
  const matches = src.match(/_authToastShown = false/g) || [];
  assert.ok(matches.length >= 1, "flag must reset when a sync succeeds/reconnects");
});

t("auto-sync 'changed' outcome reuses the click-to-refresh toast, never a forced reload", () => {
  const start = src.indexOf("async function autoSync(");
  const region = src.slice(start, start + 1600);
  assert.ok(/tap to refresh|click to refresh/.test(region), "must offer, not force, the reload");
  assert.ok(/toast\(/.test(region) && /location\.reload\(\)/.test(region), "toast with reload callback");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/pwa-autosync-wiring.test.js`
Expected: all FAIL (no autoSync yet).

- [ ] **Step 3: Implement in pwa/index.html**

Replace `syncNowClick` (lines 1474-1488) with:

```js
async function syncNowClick(){
  if(_syncInFlight){ toast("Sync already running…"); return; }
  toast("Syncing…");
  try{
    _syncInFlight = Store.syncNow();
    const r = await _syncInFlight;
    if(r && r.code === "AUTH_EXPIRED"){ toast("Dropbox connection expired — reconnect in Settings"); await renderSyncStatus(); return; }
    if(r && r.ok === false){ toast("Sync failed: " + (r.reason || "unknown reason")); await renderSyncStatus(); return; }
    _authToastShown = false;
    _lastAutoSyncAt = Date.now();
    toast(r && r.changed ? "Synced — new items merged in" : "Synced — already up to date");
    await renderSyncStatus();
    if(r && r.changed){ setTimeout(()=>location.reload(), 900); }
  }
  catch(e){
    toast("Sync failed: " + (e&&e.message||e));
    await renderSyncStatus();
  }
  finally{
    _syncInFlight = null;
  }
}

/* ============ auto-sync (spec: docs/superpowers/specs/2026-07-16-sync-auth-keys-design.md) ============ */
// The PWA used to sync ONLY from the manual button — settings and cards changed
// on other devices never arrived unless the user remembered to tap it (and
// silently stopped forever when a tap failed). Auto-sync runs on app open, on
// returning to the foreground, and on a timer, sharing ONE in-flight guard with
// the manual button so two cycles can never overlap.
const AUTO_SYNC_COOLDOWN = 5*60*1000;   // min gap between AUTO syncs; manual taps bypass this (they only respect the in-flight guard)
const AUTO_SYNC_INTERVAL = 15*60*1000;  // periodic cadence while the app stays open
let _syncInFlight = null;               // Promise while a cycle runs — shared by autoSync + syncNowClick
let _lastAutoSyncAt = 0;
let _authToastShown = false;            // one reconnect toast per disconnect, not one per 15-minute tick
async function autoSync(trigger){
  if(!_booted || _syncInFlight) return;
  if(Date.now() - _lastAutoSyncAt < AUTO_SYNC_COOLDOWN) return;
  let st = null; try{ st = await Store.syncStatus(); }catch(e){ return; }
  if(!st || !st.enabled || !st.connected) return;
  _lastAutoSyncAt = Date.now();
  let r = null;
  try{
    _syncInFlight = Store.syncNow();
    r = await _syncInFlight;
  }catch(e){
    console.warn("auto-sync ("+trigger+") threw:", e && e.message);
  }finally{
    _syncInFlight = null;
  }
  if(!r) return;
  if(r.code === "AUTH_EXPIRED"){
    if(!_authToastShown){ _authToastShown = true; toast("Dropbox connection expired — reconnect in Settings", 8000); }
    renderSyncStatus();
    return;
  }
  if(r.ok === false){ console.warn("auto-sync ("+trigger+") failed:", r.reason); return; }   // transient: Settings' "Last sync" line is the surface, no toast spam
  _authToastShown = false;
  if(r.changed){ toast("✨ Updates synced from your other devices — tap to refresh", 8000, ()=>location.reload()); }
}
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) autoSync("visible"); });
setInterval(()=>autoSync("interval"), AUTO_SYNC_INTERVAL);
```

In `bootData()`, after `maybeAutoBackup();` (line ~5196), add:

```js
  autoSync("boot");   // fire-and-forget: first sync of the session, now that the real library is loaded
```

- [ ] **Step 4: Bump the service-worker shell cache**

In `pwa/sw.js` line 21: `interests-pwa-shell-v20` → `interests-pwa-shell-v21`.

- [ ] **Step 5: Run tests**

Run: `node tests/pwa-autosync-wiring.test.js && node tests/syntax-check.js && node tests/ux-loop06.test.js`
Expected: all PASS. If `ux-loop06.test.js` (which scans `syncNowClick`) asserts structure the rewrite moved, adjust the REWRITE to satisfy it (keep `renderSyncStatus` on every outcome; keep the exact toast strings) — do not weaken the test.

- [ ] **Step 6: Commit**

```bash
git add pwa/index.html pwa/sw.js tests/pwa-autosync-wiring.test.js
git commit -m "feat(pwa): auto-sync on open/foreground/15-min interval with shared in-flight guard

chore(pwa): bump SHELL_CACHE v20 -> v21

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Docs, full suite, data-safety review, push, release v1.12.22

**Files:**
- Modify: `CLAUDE.md` line 18, `package.json` (version), `docs/BACKLOG.md` (if it tracks the settings-sync item)

**Interfaces:** none (verification + release).

- [ ] **Step 1: Update privacy docs**

`CLAUDE.md` line 18, replace:

```
- **Privacy-first**: Keys stored in localStorage, never sent anywhere except the chosen AI provider.
```

with:

```
- **Privacy-first**: Keys stored locally, sent only to the chosen AI provider — plus, when Dropbox sync is connected, included in the synced settings inside the user's own Dropbox (`/Interests App/sync/`, user decision 2026-07-16). The desktop `updateToken` never syncs.
```

- [ ] **Step 2: Run the FULL suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`. Fix any straggler (e.g. another test asserting the old keys-never-sync contract) before proceeding — update it to the new contract, never delete assertions wholesale.

- [ ] **Step 3: Data-safety review gate**

Dispatch the `data-safety-reviewer` agent over the diff (`git diff <base>..HEAD -- core/ pwa/`), per house rule ("after store/backup/import/restore changes"). Address any findings before release.

- [ ] **Step 4: Version bump + push + release**

- `package.json`: `1.12.21` → `1.12.22`, commit `release: v1.12.22 — sync auth resilience, PWA auto-sync, key sync`.
- `git push origin master` (retry on Dropbox `.git` lock errors).
- Cut the release the same way v1.12.21 was cut (check `.github/workflows/` — if the build triggers on tag, `git tag v1.12.22 && git push origin v1.12.22`; verify with `gh run watch` then `gh release view v1.12.22`).
- Confirm the PWA deploy ran (`deploy-pwa.yml` triggers on `pwa/**` push).

- [ ] **Step 5: Tell the user the manual steps**

- Install v1.12.22 on both laptops (installed Electron app doesn't follow git — project memory).
- On iPad/iPhone: open the PWA twice (first load fetches the new shell, second runs it), reconnect Dropbox once, tap Sync now; keys + categories should appear after the reload prompt.
- Offer (separately, with confirmation) deleting the 3 orphaned `ipad-*` folders in `Dropbox/Interests App/sync/`.
```
