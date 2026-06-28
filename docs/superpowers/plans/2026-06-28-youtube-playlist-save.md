# YouTube Playlist-Save → Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user adds a YouTube video to any playlist, capture that video into the app's Saved library — by giving the YouTube capture-config a real `saveTrigger`.

**Architecture:** Extension-only, inside the existing in-page capture engine. A new pure helper decides "is this click a playlist ADD?"; the `youtube` config gets a pending-video tracker (mirrors Facebook's menu-owner trick, because YouTube's add-to-playlist dialog is a detached popup), a real `saveTrigger`, and a `findPost` override. The rest of the pipeline (`clipSocialPost` → `background.js` i.ytimg thumbnail → `POST /api/captures` → `web/route-capture.js` → Saved) is unchanged.

**Tech Stack:** MV3 Chrome extension (plain JS, no bundler). Tests are plain-Node `assert` via `node tests/run.js`.

## Global Constraints

- Repo stays **private**; **never create/edit/`git add` personal-data files** (PreToolUse hook blocks them).
- A Save **always** routes to the **Saved library** and **never** modifies an Imported card (downstream in `web/route-capture.js` — unchanged here).
- **Extension-only**: do NOT modify `extension/capture-core.js` or any app file (`web/`, `core/`, `main.js`). Adding a platform = editing its config + the manifest.
- The pure helper must be **require()-able** in Node (browser global + `module.exports`, like `web/route-capture.js`).
- `node tests/run.js` must stay **ALL TEST FILES PASSED**; `node --check` must pass on every edited `.js`; `manifest.json` must parse and read version **4.37**.
- Best-effort against YouTube DOM changes (selectors are resilient-but-not-guaranteed).
- Manifest content_scripts already inject the capture engine on `*://*.youtube.com/*` (since v4.35).

---

### Task 1: Pure `ytShouldFireAdd` helper + unit test

**Files:**
- Create: `extension/yt-save-trigger.js`
- Test: `tests/yt-save-trigger.test.js`

**Interfaces:**
- Produces: `ytShouldFireAdd({ inPlaylistDialog, ariaChecked, isWatchLaterMenuItem, isSavePlaylistOpener }) -> boolean`. Attached to the global (`window.ytShouldFireAdd`) in the browser and `module.exports` in Node. Rules: an opener never fires; a one-click Watch-later item fires; a playlist row fires only when it is in the dialog AND currently **un-checked** (`ariaChecked === false`, i.e. about to toggle on); anything else (including unknown checked-state) does not fire.

- [ ] **Step 1: Write the failing test** — create `tests/yt-save-trigger.test.js`:

```js
const assert = require("assert");
const { ytShouldFireAdd } = require("../extension/yt-save-trigger");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }

test("playlist row toggling ON fires", () => {
  assert.strictEqual(ytShouldFireAdd({ inPlaylistDialog: true, ariaChecked: false }), true);
});
test("playlist row already checked (a remove/un-tick) does NOT fire", () => {
  assert.strictEqual(ytShouldFireAdd({ inPlaylistDialog: true, ariaChecked: true }), false);
});
test("one-click 'Save to Watch later' fires", () => {
  assert.strictEqual(ytShouldFireAdd({ isWatchLaterMenuItem: true }), true);
});
test("the 'Save'/'Save to playlist' opener does NOT fire", () => {
  assert.strictEqual(ytShouldFireAdd({ isSavePlaylistOpener: true }), false);
});
test("opener wins over other flags (it only opens the dialog)", () => {
  assert.strictEqual(ytShouldFireAdd({ isSavePlaylistOpener: true, isWatchLaterMenuItem: true }), false);
});
test("a dialog click with unknown checked-state does NOT fire (conservative)", () => {
  assert.strictEqual(ytShouldFireAdd({ inPlaylistDialog: true }), false);
});
test("a non-dialog, non-watch-later click does not fire", () => {
  assert.strictEqual(ytShouldFireAdd({}), false);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node tests/yt-save-trigger.test.js`
Expected: FAIL — cannot find module `../extension/yt-save-trigger`.

- [ ] **Step 3: Implement** — create `extension/yt-save-trigger.js`:

```js
// Pure decision for YouTube's save UI: is this click a real "add to a playlist"?
// Dual browser/Node (like web/route-capture.js) so it gets a real unit test.
// Rules: an opener never fires (it just opens the dialog); a one-click "Save to
// Watch later" fires; a playlist row fires only when it's in the dialog AND
// currently UN-checked (about to toggle on). Unknown checked-state = no fire.
(function (root) {
  "use strict";
  function ytShouldFireAdd(o) {
    o = o || {};
    if (o.isSavePlaylistOpener) return false;
    if (o.isWatchLaterMenuItem) return true;
    if (o.inPlaylistDialog && o.ariaChecked === false) return true;
    return false;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { ytShouldFireAdd: ytShouldFireAdd };
  if (root) root.ytShouldFireAdd = ytShouldFireAdd;
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node tests/yt-save-trigger.test.js`
Expected: `7 passed, 0 failed`.

- [ ] **Step 5: Run the full gate**

Run: `node tests/run.js`
Expected: ends `ALL TEST FILES PASSED` (the new test file is auto-discovered).

- [ ] **Step 6: Commit**

```bash
git add extension/yt-save-trigger.js tests/yt-save-trigger.test.js
git commit -m "feat(ext): pure ytShouldFireAdd helper for YouTube playlist-save (+ unit test)"
```

---

### Task 2: Wire the YouTube config (pending tracker + saveTrigger + findPost) and load the helper

**Files:**
- Modify: `extension/capture-configs.js` (the `youtube` config + a few module-scope helpers near it)
- Modify: `extension/manifest.json` (load `yt-save-trigger.js`; bump version `4.36` → `4.37`)

**Interfaces:**
- Consumes: `window.ytShouldFireAdd` (Task 1), loaded before `capture-configs.js`. The capture engine (`capture-core.js`, unchanged) calls `cfg.init(U)` once, `cfg.saveTrigger(e, U)` on every click, and `cfg.findPost(trigger, U)` to resolve the post.
- Produces: a working YouTube native-save mirror.

**Context — the current `youtube` config** in `extension/capture-configs.js` is (replace the whole object, and add the module-scope helpers shown below just above it):

```js
const youtube = {
  id: "youtube",
  match: function (h) { return /(^|\.)youtube\.com$/.test(h); },
  image: "photo", imageCdn: /ytimg/, preCaptureDelayMs: 0,
  saveTrigger: function () { return null; },
  findPost: function (trigger, U) { /* tile-walk + watch fallback */ },
  isSpecificUrl: function (href) { return /[?&]v=/.test(href || "") || /\/shorts\//.test(href || ""); },
  findPermalink: function (post, U) { /* clean /watch?v= */ },
  extract: function (post, U) { /* #video-title */ },
  title: function (a) { return a || "YouTube video"; },
};
```

Keep `isSpecificUrl`, `findPermalink`, `extract`, `title`, `match`, `image`, `imageCdn` **exactly as they currently are** — only `saveTrigger`, `findPost` change and `init` is added, plus the module-scope helpers.

- [ ] **Step 1: Add the module-scope helpers** just above the `const youtube = {` line in `extension/capture-configs.js`:

```js
  /* ============================ YouTube ============================ */
  // The add-to-playlist dialog is a DETACHED popup with no link back to the video,
  // so remember which tile's ⋮ menu opened the save flow (mirrors fbLastPost). On a
  // watch page the video is resolvable from the URL, so no tracking is needed there.
  let _ytPending = null, _ytPendingAt = 0;
  const YT_TILE_SEL = "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, ytd-playlist-video-renderer, ytd-rich-grid-media";
  function ytTileFrom(el) {
    let node = (el && el.closest) ? el.closest(YT_TILE_SEL) : null;
    if (node) return node;
    node = el;
    while (node && node !== document.body) {
      if (node.querySelector && node.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')) return node;
      node = node.parentElement;
    }
    return null;
  }
  function ytWatchVideo() {
    if (/[?&]v=/.test(location.href) || /\/shorts\//.test(location.href)) return document.querySelector("ytd-watch-flexy, #primary") || document.body;
    return null;
  }
  function ytInPlaylistDialog(el) {
    return !!(el && el.closest && el.closest('ytd-add-to-playlist-renderer, ytd-playlist-add-to-option-renderer'));
  }
  function ytPlaylistRow(el) { return (el && el.closest) ? el.closest('ytd-playlist-add-to-option-renderer') : null; }
  function ytLabelOf(el) {
    const b = (el && el.closest) ? el.closest('[aria-label], [title], ytd-menu-service-item-renderer, tp-yt-paper-item, a, button') : null;
    return (((b && b.getAttribute && (b.getAttribute("aria-label") || b.getAttribute("title"))) || (b && b.innerText) || (el && el.innerText) || "")).toLowerCase();
  }
  // Read a playlist row's current checked state. A freshly-listed row with no
  // explicit state defaults to UN-checked (so a click on it is "about to add").
  function ytRowChecked(row) {
    const cb = row.querySelector('tp-yt-paper-checkbox, [role="checkbox"], #checkbox') || row;
    const ac = (cb.getAttribute && cb.getAttribute("aria-checked")) || (row.getAttribute && row.getAttribute("aria-checked"));
    if (ac === "true") return true;
    if (ac === "false") return false;
    if (cb.hasAttribute && (cb.hasAttribute("checked") || cb.hasAttribute("active"))) return true;
    return false;
  }
```

- [ ] **Step 2: Replace the `youtube` config object** (`saveTrigger`, `findPost`, add `init`; leave the other keys untouched):

```js
  const youtube = {
    id: "youtube",
    match: function (h) { return /(^|\.)youtube\.com$/.test(h); },
    image: "photo", imageCdn: /ytimg/, preCaptureDelayMs: 0,
    // Remember which tile a save flow started from: clicking a tile's ⋮ "Action
    // menu" in the feed/grid/search/sidebar. Capture-phase so we see it first.
    init: function (U) {
      document.addEventListener("click", function (e) {
        try {
          const menu = e.target.closest && e.target.closest("ytd-menu-renderer");
          const lab = ytLabelOf(e.target);
          if (!menu && !/action menu|more actions/.test(lab)) return;
          const tile = ytTileFrom(menu || e.target);
          if (tile) { _ytPending = tile; _ytPendingAt = Date.now(); }
        } catch (err) { /* never break the page */ }
      }, true);
    },
    saveTrigger: function (e, U) {
      try {
        const t = e.target;
        const inDialog = ytInPlaylistDialog(t);
        const row = ytPlaylistRow(t);
        const lab = ytLabelOf(t);
        const isWatchLater = /save to watch later|add to watch later/.test(lab) && !/remove/.test(lab);
        const isOpener = (/^\s*save\s*$/.test(lab) || /save to playlist|add to playlist/.test(lab)) && !inDialog;
        const decide = (typeof window !== "undefined") && window.ytShouldFireAdd;
        if (!decide) return null;   // helper not loaded -> fail safe (capture nothing)
        const fire = decide({
          inPlaylistDialog: inDialog && !!row,
          ariaChecked: (inDialog && row) ? ytRowChecked(row) : undefined,
          isWatchLaterMenuItem: isWatchLater,
          isSavePlaylistOpener: isOpener,
        });
        if (!fire) return null;
        return row || t.closest('ytd-menu-service-item-renderer, tp-yt-paper-item, [role="menuitem"]') || t;
      } catch (err) { return null; }
    },
    // Dialog/Watch-later trigger -> the pending video (or the watch-page video).
    // A direct tile trigger (right-click captureCtxPost) -> resolve the tile as before.
    findPost: function (trigger, U) {
      try {
        if (ytInPlaylistDialog(trigger) || /save to watch later|add to watch later/.test(ytLabelOf(trigger))) {
          if (_ytPending && _ytPending.isConnected !== false && (Date.now() - _ytPendingAt) < 60000) return _ytPending;
          return ytWatchVideo();
        }
      } catch (err) {}
      const tile = ytTileFrom(trigger);
      if (tile) return tile;
      return ytWatchVideo();
    },
    isSpecificUrl: function (href) { return /[?&]v=/.test(href || "") || /\/shorts\//.test(href || ""); },
    findPermalink: function (post, U) {
      const a = post.querySelector ? post.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]') : null;
      const href = a ? U.hrefOf(a) : (this.isSpecificUrl(location.href) ? location.href : "");
      try {
        const q = new URL(href, location.origin);
        const v = q.searchParams.get("v"); if (v) return "https://www.youtube.com/watch?v=" + v;
        const m = /\/shorts\/([^/?#]+)/.exec(q.pathname); if (m) return "https://www.youtube.com/shorts/" + m[1];
      } catch (e) {}
      return href || location.href;
    },
    extract: function (post, U) {
      const t = U.txtOf(post.querySelector ? post.querySelector('#video-title, a#video-title, yt-formatted-string#video-title, h1 yt-formatted-string, h1.title') : null);
      return { author: (t || "").split("\n")[0].slice(0, 200), text: "" };
    },
    title: function (a) { return a || "YouTube video"; },
  };
```

(The `findPermalink`/`extract` bodies above are the current ones verbatim — keep whatever is already in the file; do not regress them.)

- [ ] **Step 3: Load the helper + bump the version** in `extension/manifest.json`. Change the capture content_scripts `js` array so `yt-save-trigger.js` loads **before** `capture-configs.js` (and `capture-core.js` stays last):

```json
      "js": ["yt-save-trigger.js", "capture-configs.js", "capture-core.js"],
```

and bump:

```json
  "version": "4.37",
```

- [ ] **Step 4: Syntax-check + manifest validate + gate**

Run:
```bash
node --check extension/capture-configs.js && echo configs-ok
node --check extension/yt-save-trigger.js && echo helper-ok
node -e "const m=require('./extension/manifest.json'); if(m.version!=='4.37') throw new Error('version '+m.version); const e=m.content_scripts.find(c=>c.js.includes('capture-core.js')); if(e.js[0]!=='yt-save-trigger.js') throw new Error('helper not first: '+e.js.join(',')); console.log('manifest ok v'+m.version)"
node tests/run.js
```
Expected: `configs-ok`, `helper-ok`, `manifest ok v4.37`, and `ALL TEST FILES PASSED`.

- [ ] **Step 5: Commit**

```bash
git add extension/capture-configs.js extension/manifest.json
git commit -m "feat(ext): YouTube playlist-save mirror — saveTrigger + pending-video tracker (v4.37)"
```

- [ ] **Step 6: Manual smoke (record results; not automated)**

Reload the extension (`chrome://extensions → ↻`, now **v4.37**) and **refresh** any open YouTube tabs, then verify:
1. On a **watch page**, click **Save** → tick a custom playlist → a Saved card appears in the app with the right **title + thumbnail + `watch?v=` URL**.
2. In the **home feed**, a thumbnail's **⋮ → Save to playlist** → tick a playlist → **that** video (not a neighbor) is saved.
3. A thumbnail's **⋮ → Save to Watch later** → the video is saved.
4. **Un-tick** a playlist (remove) → nothing is saved.
5. Add **one video to two playlists** → exactly **one** Saved card (video-id dedup).
6. Click the **thumbs-up Like** → nothing is saved.

If any step misbehaves, capture the `[Interests] youtube save | …` console line (it logs author/url/img) and the engine's `[route] … → saved` line to localize whether the trigger fired and which video/URL it resolved.

---

## Self-Review (plan vs spec)

**Spec coverage:** real `saveTrigger` replacing the stub (Task 2) ✓; every-playlist-add via dialog tick + Watch-later one-click (Task 2 `saveTrigger` + `ytShouldFireAdd`) ✓; add-only, not remove (`ariaChecked===false` gate + helper) ✓; Like excluded (no label match) ✓; which-video via pending tracker + watch-page fallback (Task 2 `init`/`findPost`) ✓; right-click `captureCtxPost` not regressed (`findPost` keeps tile resolution for tile triggers) ✓; dedup + Saved-only routing unchanged downstream ✓; i.ytimg thumbnail already in `background.js` (no change) ✓; pure helper require()-able + unit-tested (Task 1) ✓; manifest loads helper first + v4.37 (Task 2) ✓; extension-only, `capture-core.js` untouched ✓; manual smoke checklist ✓.

**Placeholder scan:** none — all code is complete; `findPermalink`/`extract` are the current verbatim bodies, explicitly "keep as-is."

**Type consistency:** `ytShouldFireAdd({inPlaylistDialog, ariaChecked, isWatchLaterMenuItem, isSavePlaylistOpener})` defined in Task 1 is called with exactly those keys in Task 2; `window.ytShouldFireAdd` is the access path; the helper file name `extension/yt-save-trigger.js` matches the manifest `js` entry and the test's `require("../extension/yt-save-trigger")`.
