# Skip Redundant Auto-Backups Across Synced Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `maybeAutoBackup()` should skip its own backup work when the shared Dropbox backups folder already has a fresh-enough dated backup from any device, instead of gating only on a local, per-device timestamp.

**Architecture:** One new opt-in parameter, `freshWithinMs`, on the existing `POST /api/backup` route (`core/server.js`). When present and the request is not a `safety` backup, the route checks `backup.newestDatedSnapshotTime()` (already exported, already used by the sync path's `ensureBackupBeforeMerge`) before doing any real work, and returns `{ok:true, skipped:true, reason:"already-fresh", verified:true}` if the shared folder is already fresh enough. The client's `maybeAutoBackup()` (`web/index.html`/`pwa/index.html`) passes its own `S.autoBackup` day-interval as this parameter; every other existing caller of the route/`doBackup()` is completely unaffected since none of them ever set this field.

**Tech Stack:** Node.js (CommonJS), Express (`core/server.js`), plain `assert`-based tests, no framework, no build step.

## Global Constraints

- This is a backup-triggering change: **both tasks' reviews, and the final review, must use the `data-safety-reviewer` agent** (per this project's own conventions), not a general-purpose reviewer.
- `safety` backups (the pre-destructive-action hard gate) must NEVER be skipped based on freshness — the check only applies when `safety` is falsy.
- Every existing caller of `POST /api/backup` / `Store.backupNow()` / `doBackup()` that does not explicitly opt in must behave byte-for-byte as it does today — this is a strictly additive, opt-in change.
- Any edit to `web/index.html` must be applied identically to `pwa/index.html` (this project's standing convention), even though `pwa/storage-pwa.js`'s `backupNow` is a no-op stub there.
- Tests are plain Node `assert` scripts, run via `node tests/<file>.test.js`; `node tests/run.js` runs the full suite and must stay green.

---

### Task 1: `freshWithinMs` skip check on `POST /api/backup`

**Files:**
- Modify: `core/server.js:665-707` (the `POST /api/backup` handler)
- Test: `tests/server-backup-int.test.js` (append new HTTP-level tests to the existing sequential test run)

**Interfaces:**
- Consumes: `backup.newestDatedSnapshotTime()` (already exported from `core/backup.js`, already required as `backup` at the top of `core/server.js`).
- Produces: `POST /api/backup` now accepts an optional `freshWithinMs` (number, ms) in its JSON body. When it is a positive finite number AND `req.body.safety` is falsy, and `(Date.now() - backup.newestDatedSnapshotTime()) < freshWithinMs`, the route responds `{ok:true, skipped:true, reason:"already-fresh", verified:true}` immediately, without calling `runner.runBackup(...)` or `backup.rotate(...)`. In every other case (parameter absent, non-numeric, `<=0`, `safety:true`, or the shared folder genuinely stale), behavior is completely unchanged from today.

- [ ] **Step 1: Write the failing tests**

Open `tests/server-backup-int.test.js`. Insert the following new `await run(...)` blocks immediately before the existing line `await new Promise(function (res) { srv.close(res); });` (currently the second-to-last statement in the file, right after the `"PUT/GET /api/img/:id after a store move..."` test):

```js
    // NOTE: by this point in the file, several earlier tests have already
    // created/rewritten today's dated backup — do NOT assume the shared
    // folder is empty. This priming call establishes a KNOWN-fresh baseline
    // regardless of whatever state came before, by making an ordinary
    // no-freshWithinMs call (which, like every earlier test in this file,
    // must always actually run).
    let freshTestBackupName, freshTestMetaPath, freshTestTsBefore;
    await run(t("POST /api/backup (priming call, no freshWithinMs) establishes a known-fresh baseline"), async () => {
      const r = await (await fetch(base + "/api/backup", { method: "POST" })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(!r.skipped, "a call with no freshWithinMs must never skip");
      assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(r.name));
      freshTestBackupName = r.name;
      freshTestMetaPath = path.join(bdir, freshTestBackupName, "meta.json");
      freshTestTsBefore = JSON.parse(fs.readFileSync(freshTestMetaPath, "utf8")).ts;
      assert.ok(typeof freshTestTsBefore === "number");
    });

    await run(t("POST /api/backup with freshWithinMs SKIPS when the shared folder already has a fresh dated backup"), async () => {
      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ freshWithinMs: 24 * 60 * 60 * 1000 }),
      })).json();
      assert.deepStrictEqual(r, { ok: true, skipped: true, reason: "already-fresh", verified: true });
      // Prove runBackup did NOT actually execute again -- a real run rewrites
      // meta.json with a brand new ts (core/backup.js's runBackup always does
      // `ts: Date.now()`), so an unchanged ts proves the skip short-circuited
      // BEFORE any real work, not just that the response happens to look right.
      const tsAfter = JSON.parse(fs.readFileSync(freshTestMetaPath, "utf8")).ts;
      assert.strictEqual(tsAfter, freshTestTsBefore, "meta.json must be untouched by a skipped call");
    });

    await run(t("POST /api/backup with a tiny freshWithinMs does NOT skip (the existing backup no longer counts as fresh)"), async () => {
      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ freshWithinMs: 1 }),
      })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(!r.skipped, "an interval of 1ms cannot possibly still be fresh");
      assert.strictEqual(r.name, freshTestBackupName, "same calendar day -> same dated folder name, just rewritten");
      const tsAfterRealRun = JSON.parse(fs.readFileSync(freshTestMetaPath, "utf8")).ts;
      assert.ok(tsAfterRealRun > freshTestTsBefore, "a real run must rewrite meta.json with a newer ts");
    });

    await run(t("POST /api/backup with freshWithinMs is ignored for a safety backup -- safety backups never skip"), async () => {
      const r = await (await fetch(base + "/api/backup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ freshWithinMs: 365 * 24 * 60 * 60 * 1000, safety: true }),
      })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(!r.skipped, "a safety backup must always actually run, regardless of freshWithinMs");
      assert.ok(/^interests-backup-before-cleanup-/.test(r.name), "safety backups use their own naming, confirming the safety path really ran");
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/server-backup-int.test.js`
Expected: the SECOND new test ("...SKIPS when the shared folder already has a fresh dated backup") FAILS — `freshWithinMs` isn't recognized yet, so the server always runs a real backup and the `deepStrictEqual` against `{ok:true, skipped:true, ...}` doesn't match. The other three new tests assert "must actually run" behavior, which is already true today regardless of `freshWithinMs` (the field is simply ignored pre-fix), so they may already pass — that's fine, they become meaningful regression coverage once Step 3 lands. Confirm specifically that the SKIPS test fails before proceeding.

- [ ] **Step 3: Implement the skip check in `core/server.js`**

Locate the `POST /api/backup` handler (currently `core/server.js:665-707`):

```js
  app.post("/api/backup", async (req, res) => {
    try {
      const safety = !!(req.body && req.body.safety);
      let keep = Number(req.body && req.body.keep);
      if (!Number.isFinite(keep) || keep < 1) keep = 3;
      keep = Math.min(Math.floor(keep), 30);
      const runner = (ctx.storeWorker && ctx.storeWorker.runBackup) ? ctx.storeWorker : { runBackup: (storeDir, opts) => Promise.resolve((function () {
        const out = backup.runBackup(ctx.db, storeDir, { safety: opts.safety });
        const verified = backup.verifyBackup(out.name, out.counts);
        if (verified && !opts.safety && opts.keep) backup.rotate(opts.keep);
        return { ok: true, verified, name: out.name, counts: out.counts };
      })()) };
      const out = await runner.runBackup(ctx.storeDir, { safety, keep });
```

Insert the new check immediately after `keep` is computed/clamped, before the `runner` declaration:

```js
  app.post("/api/backup", async (req, res) => {
    try {
      const safety = !!(req.body && req.body.safety);
      let keep = Number(req.body && req.body.keep);
      if (!Number.isFinite(keep) || keep < 1) keep = 3;
      keep = Math.min(Math.floor(keep), 30);
      // Opt-in freshness skip (multi-device Dropbox sync): a caller that knows
      // its own acceptable staleness window (maybeAutoBackup, using S.autoBackup's
      // day count) can avoid redoing work another device already did and Dropbox
      // already synced down. Never applies to a safety backup -- that gate must
      // always actually run. newestDatedSnapshotTime() only counts a folder once
      // its meta.json completion marker parses with non-zero counts -- the same
      // trust bar ensureBackupBeforeMerge already relies on without a full re-verify.
      const freshWithinMs = Number(req.body && req.body.freshWithinMs);
      if (!safety && Number.isFinite(freshWithinMs) && freshWithinMs > 0) {
        const newest = backup.newestDatedSnapshotTime();
        if (newest && (Date.now() - newest) < freshWithinMs) {
          return res.json({ ok: true, skipped: true, reason: "already-fresh", verified: true });
        }
      }
      const runner = (ctx.storeWorker && ctx.storeWorker.runBackup) ? ctx.storeWorker : { runBackup: (storeDir, opts) => Promise.resolve((function () {
        const out = backup.runBackup(ctx.db, storeDir, { safety: opts.safety });
        const verified = backup.verifyBackup(out.name, out.counts);
        if (verified && !opts.safety && opts.keep) backup.rotate(opts.keep);
        return { ok: true, verified, name: out.name, counts: out.counts };
      })()) };
      const out = await runner.runBackup(ctx.storeDir, { safety, keep });
```

Nothing else in the handler changes — the rest of the `try` block, the `catch`, and the whole `/api/backups` GET route stay exactly as they are today.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/server-backup-int.test.js`
Expected: all tests pass, including every pre-existing test in the file (the new tests were appended after the last pre-existing one and do not mutate any state earlier tests depend on).

- [ ] **Step 5: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED. (`tests/backup.test.js`'s direct `core/backup.js` unit tests are unaffected — this change is entirely inside `core/server.js`'s route handler and never touches `core/backup.js` itself.)

- [ ] **Step 6: Commit**

```bash
git add core/server.js tests/server-backup-int.test.js
git commit -m "feat: add opt-in freshWithinMs skip check to POST /api/backup"
```

---

### Task 2: Wire `maybeAutoBackup()` to request the skip check

**Files:**
- Modify: `web/index.html:1439` (`doBackup`), `web/index.html:1475` (`maybeAutoBackup`); mirror both edits in `pwa/index.html:1477` and `pwa/index.html:1513`
- Modify: `tests/settings-wiring.test.js:38-45` (one regex in the existing test needs updating to match the new source text — see Step 5)
- Test: new tests appended to `tests/settings-wiring.test.js` (or a new small file — see Step 4), using this project's `tests/_extract.js` `extractFn()` + `new Function(...)` sandbox pattern

**Interfaces:**
- Consumes: Task 1's `freshWithinMs` parameter (server-side; the client just needs to send it in the request body, which `Store.backupNow` already forwards verbatim as JSON — see `web/storage.js:178`, unchanged).
- Produces: `doBackup(manual, opts)` — `opts` is optional; when provided, its keys are merged into the `Store.backupNow()` call alongside the existing `{keep: S.backupRetainCount||3}` default. `maybeAutoBackup()` now calls `doBackup(false, {freshWithinMs: days*86400000})` instead of `doBackup()`, once its own local-timestamp staleness check has already passed.

- [ ] **Step 1: Write the failing tests**

Add the following to `tests/settings-wiring.test.js`, inside the existing `for (const [label, src] of [["web", html], ["pwa", pwaHtml]])` loop (after the last existing `t(label + ...)` call in that loop, before its closing `}`):

```js
  t(label + ": doBackup merges an optional opts object into the Store.backupNow call", () => {
    assert.match(src,
      /async function doBackup\(manual, ?opts\)\{\s*try\{\s*const res = await Store\.backupNow\(Object\.assign\(\{keep: S\.backupRetainCount\|\|3\}, ?opts\|\|\{\}\)\)/,
      "doBackup must accept an opts param and merge it into the Store.backupNow() call");
  });
  t(label + ": maybeAutoBackup passes its own autoBackup day-interval as freshWithinMs", () => {
    assert.match(src,
      /await doBackup\(false, ?\{freshWithinMs: days\*86400000\}\);/,
      "maybeAutoBackup must call doBackup with {freshWithinMs: days*86400000}");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/settings-wiring.test.js`
Expected: FAIL on both new assertions — the source doesn't have `opts` or `freshWithinMs` yet. (Note for later: after you make the Step 3 edit, the separate PRE-EXISTING test `"manual/auto/safety-gate backups all pass the configured retain count"` will start failing too, because its regex expects `doBackup`'s OLD signature — that's expected and is fixed in Step 5, not a sign anything is wrong.)

- [ ] **Step 3: Edit `doBackup` and `maybeAutoBackup` in `web/index.html`**

Replace (currently `web/index.html:1439`):
```js
async function doBackup(manual){
  try{
    const res = await Store.backupNow({keep: S.backupRetainCount||3});   // {ok,verified,name,counts}
```
with:
```js
async function doBackup(manual, opts){
  try{
    const res = await Store.backupNow(Object.assign({keep: S.backupRetainCount||3}, opts||{}));   // {ok,verified,name,counts}
```
(the rest of the function — the `res.ok===false` branch, the `counts`/`verified` extraction, the `ia_lastbackup`/`ia_backup_last` writes, the manual-only toasts, `storageHealthCheck()` — is completely unchanged; a `{skipped:true, verified:true}` response already flows through this unmodified logic correctly, since `res.ok` is `true` and `res.verified` is `true`).

Replace (currently `web/index.html:1475-1481`):
```js
async function maybeAutoBackup(){
  if(!_booted) return;   // gate: don't back up before bootData() has loaded the real library (review A2)
  const days = +S.autoBackup; if(!days) return;
  let last = 0; try{ last = (+(await Store.kvGet("ia_lastbackup")) || 0); }catch(e){}
  if(Date.now() - last < days*86400000) return;
  await doBackup();
}
```
with:
```js
async function maybeAutoBackup(){
  if(!_booted) return;   // gate: don't back up before bootData() has loaded the real library (review A2)
  const days = +S.autoBackup; if(!days) return;
  let last = 0; try{ last = (+(await Store.kvGet("ia_lastbackup")) || 0); }catch(e){}
  if(Date.now() - last < days*86400000) return;
  await doBackup(false, {freshWithinMs: days*86400000});
}
```

- [ ] **Step 4: Copy both edits identically to `pwa/index.html`**

Same two replacements, at `pwa/index.html:1477` (`doBackup`) and `pwa/index.html:1513` (`maybeAutoBackup`). Verify with:

```bash
diff <(sed -n '/^async function doBackup/,/^}/p' web/index.html) <(sed -n '/^async function doBackup/,/^}/p' pwa/index.html)
diff <(sed -n '/^async function maybeAutoBackup/,/^}/p' web/index.html) <(sed -n '/^async function maybeAutoBackup/,/^}/p' pwa/index.html)
```

Expected: no output for either.

- [ ] **Step 5: Fix the now-stale regex in `tests/settings-wiring.test.js`**

The existing test `"manual/auto/safety-gate backups all pass the configured retain count"` (currently lines 38-45) contains this regex, which matched `doBackup`'s OLD signature and will no longer match after Step 3:
```js
/doBackup\(manual\)\{\s*try\{\s*const res = await Store\.backupNow\(\{keep: S\.backupRetainCount\|\|3\}\)/,
```
Update it to match the new source text (the other two regexes in that same array — `verifiedSafetyBackup` and the `.then(res=>{` call site — are untouched by this plan and must NOT be changed):
```js
/doBackup\(manual, ?opts\)\{\s*try\{\s*const res = await Store\.backupNow\(Object\.assign\(\{keep: S\.backupRetainCount\|\|3\}, ?opts\|\|\{\}\)\)/,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node tests/settings-wiring.test.js`
Expected: all tests pass, including the fixed pre-existing regex test and the two new tests from Step 1.

- [ ] **Step 7: Run the full suite (regression check)**

Run: `node tests/run.js`
Expected: ALL TEST FILES PASSED.

- [ ] **Step 8: Commit**

```bash
git add web/index.html pwa/index.html tests/settings-wiring.test.js
git commit -m "feat: skip auto-backup when the shared Dropbox folder is already fresh"
```

---

## Self-Review Notes (for the controller, not a task)

- `verifiedSafetyBackup()`, the durability-banner button's `backupNow()` call, the manual "Back up now" button, and the legacy-import safety snapshot are all untouched by this plan — none of them pass a second argument to `doBackup`/`opts` to `Store.backupNow`, so `Object.assign({keep:...}, opts||{})` with `opts` undefined reduces to exactly `{keep:...}`, byte-for-byte what they send today.
- No change to `core/backup.js`, `core/sync.js`, or `ensureBackupBeforeMerge` — the sync-driven path is completely untouched, per the design's explicit scope decision.
