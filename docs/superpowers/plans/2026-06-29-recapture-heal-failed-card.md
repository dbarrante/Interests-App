# Recapture: Heal the Failed Card on the Next Clip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v1.5.3 recapture flow actually work — when the user clicks a failed card's title (which arms a one-shot "recapture target") and then clicks the extension's Clip, the resulting clip heals THAT failed card (sets its image → ✅ Success) instead of being filed as a brand-new Saved entry.

**Architecture:** App-only. The pure router `web/route-capture.js` currently short-circuits any `clip:true` capture to `"saved"` before it considers imported cards. Add a branch: a clip arriving while a recent recapture target is armed routes to `"card-image"` for that target. The renderer (`web/index.html`) arms the target in `openFailOne`, passes it to `routeCapture` in `drainCaptures`, prefers the screenshot for a recapture, and disarms after a successful heal. No extension or Core change.

**Tech Stack:** Vanilla JS; `web/route-capture.js` is a dual browser/Node module; plain-`node` tests.

## Global Constraints

- App-only: NO extension change, NO Core endpoint change.
- The recapture target is the explicit card the user clicked — healing must NOT require the clip's URL to match the card's stored URL (robust against redirects / random query params like fatpita's `?i=`).
- One-shot + time-windowed: `RECAP_WINDOW = 15 * 60 * 1000` ms. Disarm only after a picture is actually applied to the target card (so a blocked/failed clip leaves the target armed for a retry).
- A recapture heal must NOT also create a duplicate Saved entry.
- The `dead`/Remove path must be unaffected (the new branch is only for `cap.clip`, placed after the existing `cap.dead` check).
- Data safety: reuse the EXISTING `card-image` apply path in `drainCaptures`; add no new delete path; `openFailOne`'s backup-first image clear is unchanged.
- Keep `node tests/run.js` green; commit after each task.

---

### Task 1: Route a clip to the recapture target (pure router)

**Files:**
- Modify: `web/route-capture.js` (insert a branch between the `cap.dead` check and the `cap.clip -> saved` line)
- Test: `tests/route-capture.test.js` (extend)

**Interfaces:**
- Consumes: `ctx.recapTarget = { id: string, ts: number }` (passed by Task 2's `drainCaptures`), plus the existing `ctx.imported`, `ctx.now`.
- Produces: for `cap.clip` with a valid recent `recapTarget` whose id is in `imported`, returns `{ action: "card-image", target: <card>, reason: "recapture target (healing failed card)" }`. All other cases unchanged.

- [ ] **Step 1: Write the failing tests** — in `tests/route-capture.test.js`, add these BEFORE the final `console.log(...)` line:

```js
t("clip + recent recapTarget (id in imported) -> card-image(target) [heal, url need not match]", () => {
  const imported = [{ id: "f1", url: "https://fatpita.net/?i=1" }];
  const r = routeCapture({ clip: true, url: "https://fatpita.net/?i=9999" }, base({ imported, recapTarget: { id: "f1", ts: 999000 } }));
  assert.strictEqual(r.action, "card-image"); assert.strictEqual(r.target.id, "f1");
});
t("clip + NO recapTarget -> saved (unchanged)", () => {
  const imported = [{ id: "f1", url: "https://x.com/p" }];
  assert.strictEqual(routeCapture({ clip: true, url: "https://x.com/p" }, base({ imported })).action, "saved");
});
t("clip + EXPIRED recapTarget -> saved", () => {
  const imported = [{ id: "f1", url: "https://x.com/p" }];
  const r = routeCapture({ clip: true, url: "https://x.com/p" }, base({ imported, recapTarget: { id: "f1", ts: 0 } }));
  assert.strictEqual(r.action, "saved");
});
t("clip + recapTarget id NOT in imported -> saved", () => {
  const imported = [{ id: "other", url: "https://x.com/p" }];
  const r = routeCapture({ clip: true, url: "https://x.com/p" }, base({ imported, recapTarget: { id: "gone", ts: 999000 } }));
  assert.strictEqual(r.action, "saved");
});
t("dead + recapTarget still -> dead (Remove unaffected)", () => {
  const r = routeCapture({ dead: true, url: "x" }, base({ recapTarget: { id: "f1", ts: 999000 } }));
  assert.strictEqual(r.action, "dead");
});
```

(Note: `base()` uses `now: 1000000`; `ts:999000` is within the 15-min window, `ts:0` is expired.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/route-capture.test.js`
Expected: the new "heal" case FAILS (returns `saved`, not `card-image`); the others may pass coincidentally.

- [ ] **Step 3: Add the recapture branch.** In `web/route-capture.js`, find:

```js
    if (cap.dead) return { action: "dead", reason: "extension reported dead/removed" };
    if (cap.clip) return { action: "saved", reason: "clip -> Saved library (never modifies Imported)" };
```

Replace those two lines with (insert the new branch between them):

```js
    if (cap.dead) return { action: "dead", reason: "extension reported dead/removed" };
    // A clip arriving while the user is actively recapturing a failed card (they clicked its
    // title in the failures modal within RECAP_WINDOW) heals THAT card instead of creating a new
    // Saved entry. The target is the explicit card they clicked, so the clip URL need NOT match
    // (handles redirects / random query params like fatpita's ?i=). One-shot: the renderer disarms
    // recapTarget after a picture lands.
    var RECAP_WINDOW = 15 * 60 * 1000;
    if (cap.clip && ctx.recapTarget && ctx.recapTarget.id && now - (ctx.recapTarget.ts || 0) < RECAP_WINDOW) {
      var rt = find(imported, function (it) { return it.id === ctx.recapTarget.id; });
      if (rt) return { action: "card-image", target: rt, reason: "recapture target (healing failed card)" };
    }
    if (cap.clip) return { action: "saved", reason: "clip -> Saved library (never modifies Imported)" };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/route-capture.test.js`, then `node tests/run.js`.
Expected: all PASS (including the existing "clip -> saved even when its url matches an imported card" test, which has no `recapTarget`).

- [ ] **Step 5: Commit**

```bash
git add web/route-capture.js tests/route-capture.test.js
git commit -m "fix(routing): a clip during an active recapture heals that failed card, not Saved"
```

---

### Task 2: Arm / pass / disarm the recapture target (renderer)

**Files:**
- Modify: `web/index.html` — declare `_recapTarget` (after `let _failStatus = {};`, ~line 2354); arm it in `openFailOne` (~line 2415); pass it into `routeCapture` and apply with screenshot-preference + disarm in `drainCaptures` (~lines 4129–4205)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes (from Task 1): `routeCapture` honoring `ctx.recapTarget`, returning `reason` starting with `"recapture target"`.
- Produces: module var `_recapTarget` (`null` or `{ id, ts }`).

- [ ] **Step 1: Write the failing test** — in `tests/capture-wiring.test.js`, append:

```js
t("recapture heal wiring: openFailOne arms _recapTarget; drainCaptures passes + disarms; viaRecap prefers screenshot", () => {
  assert.ok(html.indexOf("let _recapTarget") >= 0, "_recapTarget declared");
  const oi = html.indexOf("function openFailOne(");
  const ob = html.slice(oi, oi + 800);
  assert.ok(ob.indexOf("_recapTarget") >= 0, "openFailOne arms _recapTarget");
  const di = html.indexOf("async function drainCaptures(");
  const db = html.slice(di, di + 7000);
  assert.ok(db.replace(/\s/g, "").indexOf("recapTarget:_recapTarget") >= 0, "drainCaptures passes recapTarget to routeCapture");
  assert.ok(db.indexOf("viaRecap") >= 0, "drainCaptures computes viaRecap");
  assert.ok(db.replace(/\s/g, "").indexOf("_recapTarget=null") >= 0, "disarms _recapTarget after heal");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `_recapTarget declared`.

- [ ] **Step 3a: Declare `_recapTarget`.** Find (~line 2354):

```js
let _failStatus = {};   // {cardId: "recapturing"} — transient hint set on title-click; success/removed are derived
```

Add immediately after it:

```js
let _recapTarget = null;   // {id, ts} — one-shot, time-windowed target armed by openFailOne; a clip heals it (route-capture.js)
```

- [ ] **Step 3b: Arm the target in `openFailOne`.** Find these lines (~2415–2416):

```js
  try{ Store.kvSet("ia_last_opened", {id:c.id, ts:Date.now()}); }catch(e){}
  _failStatus[id]="recapturing";
```

Replace with (arm `_recapTarget` alongside):

```js
  try{ Store.kvSet("ia_last_opened", {id:c.id, ts:Date.now()}); }catch(e){}
  _recapTarget = {id:c.id, ts:Date.now()};   // the next extension Clip heals THIS card (route-capture.js)
  _failStatus[id]="recapturing";
```

- [ ] **Step 3c: Pass `recapTarget` into `routeCapture`.** Find (~line 4129):

```js
    const decision = routeCapture(cap, { imported, lastOpened, now, normalizeUrl, domain });
```

Replace with:

```js
    const decision = routeCapture(cap, { imported, lastOpened, now, normalizeUrl, domain, recapTarget:_recapTarget });
```

- [ ] **Step 3d: Compute `viaRecap`.** Find (~line 4160):

```js
    const viaActive = decision.reason === "active card (same domain)";
```

Add immediately after it:

```js
    const viaRecap = !!(decision.reason && decision.reason.indexOf("recapture target") === 0);   // user-driven heal of the clicked failed card
```

- [ ] **Step 3e: Prefer the screenshot for a recapture, and force-apply.** Find (~lines 4181–4184):

```js
    const force = !!cap.force;                 // manual capture forces overwrite
    // manual: prefer the actual screenshot (what you see); auto: prefer clean OG image
    const best = force ? (cap.screenshot || cap.ogImage || cap.contentImage)
                       : (cap.ogImage || cap.contentImage || cap.screenshot);
```

Replace with (treat a recapture like a manual capture for image preference):

```js
    const force = !!cap.force;                 // manual capture forces overwrite
    // manual OR an active recapture: prefer the actual screenshot (what you see); auto: prefer clean OG image
    const best = (force || viaRecap) ? (cap.screenshot || cap.ogImage || cap.contentImage)
                                     : (cap.ogImage || cap.contentImage || cap.screenshot);
```

- [ ] **Step 3f: Apply on recapture too, and disarm after success.** Find (~line 4195):

```js
    if(best && (force || cap.recap || isBadImg(match.img))){ setCardImage(match, best); changed=true; if(/facebook\.com|fb\.watch/i.test(match.url||"")) _fbSessCaptured++; }
```

Replace with (add `viaRecap` to the apply condition):

```js
    if(best && (force || viaRecap || cap.recap || isBadImg(match.img))){ setCardImage(match, best); changed=true; if(/facebook\.com|fb\.watch/i.test(match.url||"")) _fbSessCaptured++; }
```

Then find (~line 4205):

```js
    match.captured=now; if(match.blocked) delete match.blocked; match.lastUpdate=now; match.lastResult="ok"; persisted=true;
```

Add immediately after it (one-shot disarm once the heal landed):

```js
    if(viaRecap) _recapTarget=null;   // healed — consume the one-shot target
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "fix(ui): arm a one-shot recapture target on title-click; heal the card on the next clip"
```

---

## Notes for the executor

- After both tasks pass, run the **data-safety-reviewer** on the branch (the change alters how a capture mutates an imported card, though it reuses the existing `card-image` apply path and adds no delete path). The **electron-security-reviewer** is not needed (no endpoint/IPC/extension change). Then bump `package.json` 1.5.3 → 1.5.4 and rebuild the installer (`npm run dist`) — the app must be fully CLOSED first (it locks `dist\win-unpacked`).
