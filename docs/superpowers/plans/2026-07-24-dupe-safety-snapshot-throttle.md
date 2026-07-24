# Duplicate-Review Safety-Snapshot Throttle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `applyDupeRemoval()` from taking a full-library safety backup on every single duplicate removal (desktop only) — reuse a recently-verified one for up to 5 minutes, matching the already-shipped `snapshotBeforeDestructive()` throttle pattern.

**Architecture:** A module-level cache (`_dupeSafetyCache`) plus a pure decision function (`shouldReuseDupeSafety`) added to `web/index.html`/`pwa/index.html`. `applyDupeRemoval()` consults the pure function before deciding whether to reuse the cached snapshot identity or call the existing `createDupeSafetySnapshot()`. The cache is only armed (written) after a confirmed, verified fresh snapshot — never after a reused or failed one. Desktop only; the PWA branch (`window.IA_IDB` truthy) is untouched.

**Tech Stack:** Vanilla JS, no build step. `web/index.html`/`pwa/index.html` inline `<script>` blocks; plain Node `assert` test scripts under `tests/`, using the existing `tests/_extract.js` `loadFns` utility (already extended this session to support `async function`, though the new function here is not async).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-dupe-safety-snapshot-throttle-design.md` — every task below implements it; treat that doc as the source of truth for *why*, this plan for *how*.
- `web/index.html` is authoritative; `pwa/index.html` mirrors every change in this plan at its own line numbers (structurally equivalent, not necessarily byte-identical for this function overall, but the new lines added by this plan ARE byte-identical text between the two files).
- The cache is armed **only** on a confirmed truthy (verified) result from `createDupeSafetySnapshot()` — a `null`/falsy result (unverified or failed) must never overwrite/clear an existing still-valid cache entry, and must never itself be cached. This mirrors `snapshotBeforeDestructive`'s existing rule (`web/index.html`, the `if(res && res.ok!==false && res.verified===true) _lastDestructiveSnapshotAt=Date.now();` line) — only a confirmed success arms a throttle.
- `DUPE_SAFETY_REUSE_MS` = `5*60*1000` (5 minutes) — same window as `DESTRUCTIVE_SNAPSHOT_THROTTLE_MS`, for consistency, not because the two are the same throttle (they are independent caches for independent flows).
- Run `node tests/run.js` (full suite) before every commit in this plan.

---

## Task 1: Throttle the desktop safety snapshot in `applyDupeRemoval`

**Files:**
- Modify: `web/index.html` (near `let _dupeReviewMode = "single";` at line ~4906, and inside `applyDupeRemoval` at line ~5349-5351)
- Modify: `pwa/index.html` (mirrored, near its own `let _dupeReviewMode = "single";` at line ~4980, and inside its `applyDupeRemoval` at line ~5423-5425)
- Test: `tests/duplicate-review-mode.test.js` (extend — this file already uses `loadFns` from `tests/_extract.js` to pull pure functions like `mergeDupeMetadata`/`dupeSnapshotSignature`/`dupeGroupKey` out of `web/index.html` and `pwa/index.html` for direct unit testing; follow that exact convention)

**Interfaces:**
- Produces: `shouldReuseDupeSafety(cache, now, isIdb) -> boolean` — a pure function, no DOM/Store/global access beyond its three parameters. Not consumed by any other task (this is the only task in this plan).
- Consumes: nothing new — `createDupeSafetySnapshot()`, `window.IA_IDB`, and `applyDupeRemoval`'s existing structure all already exist unmodified.

- [ ] **Step 1: Write the failing tests**

Read the current top of `tests/duplicate-review-mode.test.js` to confirm the exact `loadFns` call — it currently reads (around line 120):

```js
const { mergeDupeMetadata, dupeSnapshotSignature, dupeGroupKey, dupeGroupDismissed, markDupeGroupNotDuplicate, dupeMemberKey } = loadFns(["mergeDupeMetadata", "dupeSnapshotSignature", "dupeGroupKey", "dupeGroupDismissed", "markDupeGroupNotDuplicate", "dupeMemberKey"]);
```

Change it to add `shouldReuseDupeSafety` to both the destructured names and the `loadFns` array:

```js
const { mergeDupeMetadata, dupeSnapshotSignature, dupeGroupKey, dupeGroupDismissed, markDupeGroupNotDuplicate, dupeMemberKey, shouldReuseDupeSafety } = loadFns(["mergeDupeMetadata", "dupeSnapshotSignature", "dupeGroupKey", "dupeGroupDismissed", "markDupeGroupNotDuplicate", "dupeMemberKey", "shouldReuseDupeSafety"]);
```

(Confirmed by reading `tests/_extract.js`: `loadFns(names)` hardcodes `web/index.html` as its source — it only ever extracts and eval's functions from the WEB file, never pwa. This is why the existing pattern in this test file separately verifies pwa-parity structurally: `featureSlice(source)` at the top of the file slices each of `web`/`pwa`'s full source from `"let _dupeReviewMode"` to `"// ---- Dead-link check"`, and `assert.strictEqual(pwaFeature, webFeature, "duplicate-review behavior must stay mirrored between web and PWA")` (line 94) already asserts the two slices are byte-identical. Since this plan's Step 3 inserts its new lines immediately after `let _dupeReviewMode = "single";` — INSIDE that slice's range — the existing mirror assertion will automatically fail if the web/pwa insertions in Steps 3/5 below are not byte-identical (including the comment text). This is why Steps 3 and 5 must use the exact same literal text in both files, not just equivalent code.)

Append these tests anywhere at the top level of the file (the `t()` helper just runs and tallies, matching every other test in this file):

```js
/* ---------- shouldReuseDupeSafety ---------- */
t("shouldReuseDupeSafety: no cached safety -> false", () => {
  assert.strictEqual(shouldReuseDupeSafety({at:0, safety:null}, Date.now(), false), false);
});
t("shouldReuseDupeSafety: cached within the window, desktop -> true", () => {
  const now = 1000000;
  const cache = {at: now - 60000, safety: {kind:"desktop", name:"interests-backup-before-cleanup-x"}};
  assert.strictEqual(shouldReuseDupeSafety(cache, now, false), true);
});
t("shouldReuseDupeSafety: cached but past the 5-minute window -> false", () => {
  const now = 1000000;
  const cache = {at: now - (5*60*1000 + 1), safety: {kind:"desktop", name:"x"}};
  assert.strictEqual(shouldReuseDupeSafety(cache, now, false), false);
});
t("shouldReuseDupeSafety: cached and within window, but PWA (IA_IDB) -> false", () => {
  const now = 1000000;
  const cache = {at: now - 60000, safety: {kind:"desktop", name:"x"}};
  assert.strictEqual(shouldReuseDupeSafety(cache, now, true), false);
});
t("shouldReuseDupeSafety: exactly at the window boundary -> false (strictly less-than)", () => {
  const now = 1000000;
  const cache = {at: now - (5*60*1000), safety: {kind:"desktop", name:"x"}};
  assert.strictEqual(shouldReuseDupeSafety(cache, now, false), false);
});
```

Then extend the file's EXISTING web/pwa structural loop (around line 17: `for (const [name, source] of [["web", web], ["pwa", pwa]]) {`) by adding these two `t()` calls inside that same loop body, alongside its existing `assert.match(source, ...)` checks:

```js
  t(name + ": applyDupeRemoval consults shouldReuseDupeSafety before creating a new safety snapshot", () => {
    const start = source.indexOf("async function applyDupeRemoval(");
    // "// ---- Dead-link check" is the literal comment immediately following
    // applyDupeRemoval's closing brace in both files today (confirmed by
    // reading web/index.html:5415-5417 during plan-writing) — it's also the
    // same end-marker featureSlice() above already uses, so it's a proven
    // stable boundary in this exact file, not a guess.
    const end = source.indexOf("// ---- Dead-link check", start);
    assert.ok(start >= 0 && end > start, "applyDupeRemoval not found or its end-boundary moved");
    const body = source.slice(start, end);
    assert.match(body, /shouldReuseDupeSafety\(_dupeSafetyCache, ?Date\.now\(\), ?!!window\.IA_IDB\)/);
    assert.match(body, /_dupeSafetyCache\s*=\s*\{\s*at:\s*Date\.now\(\),\s*safety\s*\}/, "cache must only be armed on a fresh confirmed snapshot");
  });
  t(name + ": _dupeSafetyCache and DUPE_SAFETY_REUSE_MS are declared", () => {
    assert.match(source, /let _dupeSafetyCache\s*=\s*\{\s*at:\s*0,\s*safety:\s*null\s*\};/);
    assert.match(source, /const DUPE_SAFETY_REUSE_MS\s*=\s*5\*60\*1000;/);
  });
```

Use `name`/`source` (not `label`/`src`) — those are the exact variable names this file's existing loop already uses; reusing them (inside the same loop body) avoids shadowing or introducing a second near-identical loop.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/duplicate-review-mode.test.js`
Expected: the 5 new `shouldReuseDupeSafety` tests fail with a "not a function" or similar error (loadFns can't find it yet); the 4 new structural checks (2 per file) fail (pattern not found yet).

- [ ] **Step 3: Add the cache declaration and pure function to `web/index.html`**

Find (near line 4906):
```js
let _dupeReviewMode = "single";
let _dupeReviewIndex = 0;
```

Insert immediately after:
```js
let _dupeReviewMode = "single";
let _dupeReviewIndex = 0;
// Desktop-only safety-snapshot reuse (2026-07-24): applyDupeRemoval used to
// take a full-library Store.backupNow({safety:true}) on every single
// removal — 25-47s each, and doing that repeatedly in one review sitting is
// what actually triggered the Dropbox publish-lock bug fixed the same day
// (core/backup.js). Same throttle shape as snapshotBeforeDestructive: only
// re-arm on a confirmed verified success, never on a failed/reused attempt.
let _dupeSafetyCache = { at: 0, safety: null };
const DUPE_SAFETY_REUSE_MS = 5*60*1000;
// Pure decision rule (no DOM/Store access) — desktop only; the PWA
// (window.IA_IDB) branch always takes its own cheap per-group-scoped
// snapshot and is untouched by this throttle.
function shouldReuseDupeSafety(cache, now, isIdb){
  return !isIdb && !!(cache && cache.safety) && (now - (cache ? cache.at : 0)) < DUPE_SAFETY_REUSE_MS;
}
```

- [ ] **Step 4: Wire it into `applyDupeRemoval` in `web/index.html`**

Find (inside `applyDupeRemoval`, around line 5349-5351):
```js
  showBusyOverlay("Creating a verified safety snapshot…");
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const safety=await createDupeSafetySnapshot();
```

Replace with:
```js
  showBusyOverlay("Creating a verified safety snapshot…");
  await new Promise(resolve=>requestAnimationFrame(resolve));
  let safety;
  if(shouldReuseDupeSafety(_dupeSafetyCache, Date.now(), !!window.IA_IDB)){
    safety = _dupeSafetyCache.safety;
  } else {
    safety = await createDupeSafetySnapshot();
    if(!window.IA_IDB && safety) _dupeSafetyCache = {at:Date.now(), safety};
  }
```

Nothing else in the function changes — the very next line is still `if(!safety){ hideBusyOverlay(); toast(...); return; }`, unaffected.

- [ ] **Step 5: Make the identical edits in `pwa/index.html`**

Same two insertions, at `pwa/index.html`'s own `let _dupeReviewMode = "single";` (line ~4980) and inside its own `applyDupeRemoval` (line ~5423-5425) — search for the same literal old text, it is byte-identical to web's at both sites.

- [ ] **Step 6: Run the syntax gate and the new/extended test file**

Run: `node tests/syntax-check.js && node tests/duplicate-review-mode.test.js`
Expected: syntax gate `0 errors`; all tests in the file pass, including the 5 new `shouldReuseDupeSafety` unit tests and the 4 new structural checks.

- [ ] **Step 7: Run the full suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 8: Manual sanity check against the real store (optional but recommended given this touches the exact flow debugged live earlier today)**

This does not need a new sandboxed preview — the fix is desktop-only backend-adjacent logic reachable only from the Duplicates review UI. If you want to confirm the reuse actually skips the expensive path without a live duplicate library to test against, a quick unit-level sanity check is enough: `node -e 'const {loadFns}=require("./tests/_extract.js"); const fs=require("fs"); const html=fs.readFileSync("web/index.html","utf8"); const {shouldReuseDupeSafety}=loadFns(["shouldReuseDupeSafety"]); console.log(shouldReuseDupeSafety({at:Date.now()-1000, safety:{kind:"desktop",name:"x"}}, Date.now(), false));' ` should print `true`. No commit needed for this step — verification only.

- [ ] **Step 9: Commit**

```bash
git add web/index.html pwa/index.html tests/duplicate-review-mode.test.js
git commit -m "Throttle duplicate-review safety snapshots to once per 5 min (desktop)

Every card removal in the Duplicates review flow took a full-library
Store.backupNow({safety:true}) — 25-47s each — and doing several in a row
is what actually triggered the Dropbox publish-lock bug fixed earlier
today (core/backup.js). Reuse a recently-verified snapshot for up to 5
minutes instead, same shape as the existing snapshotBeforeDestructive
throttle. Desktop only; the PWA's already-cheap per-group scoped
snapshot is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage:** every section of `docs/superpowers/specs/2026-07-24-dupe-safety-snapshot-throttle-design.md` (mechanism, scope, trust model, no-new-invalidation-hooks, testing) is implemented by this single task — the design was already scoped small enough that it didn't need decomposition into multiple tasks.

**Placeholder scan:** none found — every step has literal, exact code.

**Type/signature consistency:** `shouldReuseDupeSafety(cache, now, isIdb)` — same parameter order and shape used in its definition (Step 3) and its only call site (Step 4): `shouldReuseDupeSafety(_dupeSafetyCache, Date.now(), !!window.IA_IDB)`, and in every unit test (Step 1) via `(cache, now, isIdb)` positionally.
