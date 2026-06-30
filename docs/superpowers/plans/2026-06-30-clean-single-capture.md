# Clean Single-Capture (⟳ Refresh) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-card ⟳ "Refresh image" capture clean and reliable via the proven background-worker driver — one tab (no duplicate), the image reliably overwrites (no manual delete), and the user knows to wait for the worker's ~30s poll.

**Architecture:** The background worker (extension v4.41, proven) already polls `/api/capture-request` and runs `captureOneTab`, which opens its OWN tab, captures it (redirect-safe, by tab-id), and closes it. `impRefresh` currently ALSO opens a tab via `window.open` — the duplicate. Remove the app's `window.open` so the worker is the sole tab-owner. This is an app-only change; the extension is unchanged (the v4.41 poller already drives it).

**Tech Stack:** Vanilla JS single-file renderer (`web/index.html`); plain-`node` text-assert wiring tests.

## Global Constraints

- App-only change (`web/index.html`). No extension or Core change — the v4.41 worker poller already opens+captures+closes the tab for both FB (render) and non-FB (screenshot).
- The worker is the sole tab-owner for a refresh: the app must NOT also open a tab.
- Refresh must clear the card image first (it already does via `setCardImage(it,"")`) and the worker's forced capture must overwrite it — verify no manual delete is needed.
- Requires Chrome open with the extension (v4.41+) and the user logged into FB/IG (documented behavior).
- Keep `node tests/run.js` green; commit after the task.

---

### Task 1: `impRefresh` — let the worker own the tab (remove the duplicate), set the wait expectation

**Files:**
- Modify: `web/index.html` — `impRefresh` (~lines 3186–3194: the `if(!isFb){ window.open … _refreshTabs }` block and the toast)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: the existing capture-request mechanism — `impRefresh` already calls `Store.setCaptureRequest({url, id, force:true, capture:true, closeAfter:true, render: isFb?1:undefined})`; the v4.41 worker poller claims it and runs `captureOneTab`, which opens/captures/closes the tab for ALL platforms. `_refreshPins`/`closeRefreshTab` stay (the spinner state + prior-pending cleanup).

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js`:

```js
t("impRefresh lets the extension own the capture tab (no app window.open duplicate)", () => {
  const i = html.indexOf("function impRefresh(");
  const body = html.slice(i, i + 1100);
  assert.ok(body.indexOf("Store.setCaptureRequest(") >= 0, "still queues the capture request for the worker");
  assert.ok(body.indexOf("window.open(") < 0, "impRefresh must NOT open its own tab — the extension worker owns it");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `impRefresh must NOT open its own tab` (the `window.open` is still there).

- [ ] **Step 3: Remove the app's tab-open + update the toast.** In `web/index.html` `impRefresh`, find this block:

```js
  closeRefreshTab(it.id);   // clear any prior pending refresh for this card
  if(!isFb){
    const win = window.open(it.url,"_blank");
    // track the tab we opened so drainCaptures can close it once the capture lands;
    // a fallback timer closes it even if no result ever arrives (extension off, etc.)
    if(win) _refreshTabs[it.id] = { win, timer: setTimeout(()=>closeRefreshTab(it.id), 60000) };
  }
  enrichOnOpen(it, idx);
  renderImportedKeepFocus();   // the ↻ spins via card state (lastResult pending + _refreshPins) so it persists until the capture lands
  toast(isFb ? "Auto-capturing this Facebook post — a tab opens briefly to render it, then closes. Stay logged into Facebook." : "Refreshing image — capturing the page…", 5000);
```

Replace it with (drop the `window.open` block entirely; the extension worker opens, captures, and closes the tab for every platform):

```js
  closeRefreshTab(it.id);   // clear any prior pending refresh for this card
  enrichOnOpen(it, idx);    // fast Core og/thumbnail fallback while the real screenshot lands
  renderImportedKeepFocus();   // the ↻ spins via card state (lastResult pending + _refreshPins) so it persists until the capture lands
  toast("Recapturing — the extension opens the page briefly, captures it, and closes it (up to ~30s). Keep Chrome open" + (isFb ? " and stay logged into Facebook." : "."), 7000);
```

(Net: the extension's worker `captureOneTab` is now the sole tab-owner for FB and non-FB alike — one tab, opened/captured/closed by the extension. The image was already cleared above via `setCardImage(it,"")`, and the request carries `force:true`, so `drainCaptures` overwrites the card with no manual delete. `_refreshTabs`/`closeRefreshTab` remain for any prior pending refresh.)

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "fix(ui): impRefresh lets the extension worker own the capture tab (no duplicate, reliable overwrite)"
```

---

## Notes for the executor

- After the task passes, run the **data-safety-reviewer** (it changes capture/refresh behavior, though it's app-only and only refreshes a card image via the existing heal path). Then bump `package.json` to 1.5.9 and rebuild the installer to `C:/Users/dkbar/interests-dist` (`npm run dist`) — the app must be fully CLOSED first.
- Manual validation (the real proof): in the desktop app, with Chrome open (extension v4.41+, logged in, NO localhost tab), click ⟳ on cards across platforms (a live website, a Facebook post, an Instagram post). Confirm: only ONE tab opens/closes per card, the image updates within ~30s, and no manual delete was needed. This is Phase 2 of docs/superpowers/specs/2026-06-30-unified-sw-capture-driver-design.md; bulk + the in-app Capture Log are the next plans.
