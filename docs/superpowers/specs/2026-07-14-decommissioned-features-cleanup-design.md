# Remove decommissioned buttons and features — design

## Problem

Investigation of the whole app (extension, desktop web UI, PWA) turned up several
buttons/features that are dead, orphaned, or actively misleading — most
notably four PWA Settings buttons that show a false "success" toast for
operations `pwa/storage-pwa.js` permanently stubs out as unsupported on
iPad, because the calling code in `web/index.html` never checks the stub's
`{ok:false, reason:...}` result.

Confirmed with the user which of the investigation's findings to act on now.
One initial finding (a broad "legacy pre-SQLite import" cluster) was
corrected after deeper investigation: `web/restore-legacy.js` (via
`planLegacyRestore()` → `doRestoreCore()` → `applyRestore()`) is **not**
decommissioned — it's the machinery the PWA's "Restore from Dropbox
backup" feature (shipped and verified working earlier the same session)
depends on, and must not be touched. The actually-low-value item was a
separate, narrower button: "Import from folder…" (`#btnImportLegacy` →
`Store.runImport()`), which the user chose to remove outright.

## Scope (confirmed with the user)

1. **Delete the orphaned extension popup UI.**
2. **Delete the now-redundant PWA test harnesses** (superseded by the real
   in-app "Connect to Dropbox" UI).
3. **Fix 3 false-success PWA buttons** to check `res.ok` and show the real
   reason on failure, instead of claiming success. **Remove the 4th**
   ("Import from folder…") entirely rather than fix it.
4. **Hide PWA-inert Settings sections** (and the related Stumble News pill)
   on the PWA build specifically — they're fully functional on desktop,
   just silent no-ops on iPad.

**Explicitly not touched:** `web/restore-legacy.js`, `planLegacyRestore()`,
`doRestoreCore()`, `applyRestore()`, `Store.runImport()`'s underlying
implementation (only its one UI entry point goes), and anything not listed
above. `pwa/worker-config.html` stays (no in-app replacement exists yet).

## Architecture

### 1. Extension popup cleanup

Delete `extension/popup.html` and `extension/popup.js` — confirmed
unreachable (`extension/manifest.json`'s `action` block has no
`default_popup`, and nothing calls `chrome.action.setPopup`).

In `extension/background.js`'s single `chrome.runtime.onMessage` listener
(lines 1126-1212), remove only the two `if` branches that exist solely to
serve `popup.js`:
- `msg.action === "clipPage"` (lines 1127-1139)
- `msg.action === "removeCard"` (lines 1172-1190)

Leave `clipSocialPost`, `getStatus`, and the three `bstumble*` branches
untouched — they're used by content scripts and the Stumble overlay, not
the popup.

### 2. PWA test harness cleanup

Delete `pwa/dbx-test.html`, `pwa/sync-test.html`, `pwa/store-test.html`.
`pwa/dropbox-connect.js` (loaded from `pwa/index.html`) already provides
the real in-app OAuth connect UI these existed to stand in for.
`pwa/worker-config.html` is NOT touched (still the only entry point for
the Cloudflare Worker config).

### 3. False-success button fixes + one button removal

All in `web/index.html` (shared with `pwa/index.html` — every edit applies
to both files identically, per this project's established convention).

**`doBackup(manual)`** (currently ~line 1179): after `const res = await
Store.backupNow();`, check `res.ok === false` and, if manual, toast
`res.reason` instead of proceeding to the "Backed up: N cards..." success
toast. Desktop behavior is unchanged (its real `backupNow()` returns
`ok:true` on success today; this only changes what happens on an explicit
failure, which was already mishandled the same way on desktop, just far
less frequently hit).

**`moveDataLocation()`** (currently ~line 1340): after `const res = await
Store.moveStore(target);`, check `res.ok === false` and toast `res.reason`
instead of `"Data store moved to " + (res.path||target)`.

**`saveSafeBrowsingKey()`** (currently ~line 1579): after `await
Store.setSafeBrowsingKey(v)` resolves, check the returned object's `.ok`
(currently the code ignores the resolved value entirely) and toast a
failure message when `ok !== true`, instead of unconditionally toasting
"Safe Browsing key saved"/"cleared".

**Remove `bindImportLegacy()` entirely**: delete the IIFE (currently
~lines 1388-1418), the `<button id="btnImportLegacy">` element and its
enclosing markup in the Settings panel (~line 615), and confirm no other
reference to `btnImportLegacy`/`importLegacyResult` remains. `Store.runImport()`'s
underlying implementation in `core/` is left alone — only this one UI
entry point is removed.

### 4. Hide PWA-inert Settings sections

New pattern: `window.IA_IDB` is a global set only by `pwa/idb.js` (loaded
only by `pwa/index.html`, never by `web/index.html`) — confirmed via grep
that this name doesn't already exist as a different concept in either
file, and that it correctly distinguishes "PWA build with a stubbed Store"
from "desktop build with a real Store" regardless of whether the desktop
build is running inside Electron or opened in a plain browser tab via
"Open in browser" (a distinction `window.ia` alone can't make, since
`window.ia` is absent in the plain-browser-tab case too, even though that
case has a fully working `Store`).

Add `id` attributes to exactly the fragments that should hide on PWA (not
whole unrelated sections):
- The entire "Browser extension" `.sec` div → `id="secBrowserExt"`
- Just the "Mix fresh news into Stumble" `<label>` + its `<div class="hint">`
  (NOT the whole "Appearance" section, which has unrelated toggles) →
  wrap in `<div id="newsMixBlock">...</div>`
- The Safe Browsing sub-block inside "Site popularity filter" (NOT the
  "Prefer popular sites"/`oprKey` part of that same `.sec`) → the existing
  `<div style="margin-top:16px;...">` wrapper gets `id="sbKeyBlock"` added
- The entire "App updates" `.sec` div → `id="secAppUpdates"`

Add one small boot-time block (placed near other init code, run
unconditionally on page load — no event-listener wrapper needed, matching
this file's existing pattern of DOM-querying IIFEs that run inline since
scripts execute after the body is parsed):
```js
if (window.IA_IDB) {
  ["secBrowserExt","newsMixBlock","sbKeyBlock","secAppUpdates"].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}
```

**Stumble's 📰 News pill**: also gate its rendering on `!window.IA_IDB` at
its source (`Store.news()` is stubbed to `[]` on PWA, so the pill is
currently always-present but functionally inert there) — find its render
site (a `.tg` pill with `onclick="toggleNewsOnly()"`) and skip emitting it
when `window.IA_IDB` is truthy.

## Data flow

No data model changes anywhere in this cleanup — every change either
deletes unreachable code, corrects an existing function's handling of an
already-returned value it was ignoring, or conditionally hides existing
DOM nodes at boot based on a build-time-constant-per-deployment global.
Nothing here touches `core/`, the database schema, or sync.

## Error handling

The 3 fixed buttons (`doBackup`, `moveDataLocation`, `saveSafeBrowsingKey`)
gain real error surfacing where they previously had none — this is itself
the fix. No new error paths are introduced beyond what `Store`'s existing
`{ok, reason}` / `{ok}` return shapes already carry.

## Explicitly out of scope

- Any change to `core/`, `Store.runImport()`'s implementation, or any
  other stubbed `storage-pwa.js` method not named above.
- `web/restore-legacy.js`, `planLegacyRestore()`, `doRestoreCore()`,
  `applyRestore()` — confirmed load-bearing, not touched.
- `pwa/worker-config.html` — no in-app replacement exists yet.
- Any change to `extension/background.js` beyond the two named branches —
  `clipSocialPost`/`getStatus`/`bstumble*` handlers stay exactly as-is.
- Any change to the "Prefer popular, well-known sites" / `oprKey` part of
  the "Site popularity filter" section — only its nested Safe Browsing
  sub-block is hidden on PWA.
- Any change to `pwa/README.md`'s or `pwa/dropbox-connect.js`'s prose
  references to the now-deleted test harness filenames — left as harmless
  historical narrative, not corrected as part of this cleanup.

## Testing

Manual only, matching this project's established convention for
`index.html`'s inline script (no automated harness beyond the syntax
gate). Concretely, per cluster:

- **Extension**: load the unpacked extension, confirm it still installs
  and runs with no console errors referencing `popup.html`/`popup.js`;
  confirm right-click "Save to Interests" and the Stumble overlay both
  still work (they don't touch the removed message handlers).
- **PWA test harnesses**: confirm the PWA's real "Connect to Dropbox" flow
  (Settings, via `dropbox-connect.js`'s widget) still works end-to-end
  from a fresh browser profile without visiting the deleted pages.
- **False-success fixes**: on the PWA build specifically, click each of
  the 3 fixed buttons and confirm they now show the real "not applicable
  on iPad" reason instead of a false success toast; on desktop, confirm
  all 3 still work exactly as before (real backup/move/key-save still
  succeed and toast success normally).
- **Removed import button**: confirm `#btnImportLegacy` no longer appears
  in Settings on either build, and no console error references
  `btnImportLegacy`/`importLegacyResult`.
- **Hidden sections**: on the PWA build, confirm Browser extension /
  News-mix toggle / Safe Browsing sub-block / App updates section / 📰
  News pill are all absent from the rendered Settings panel and Stumble
  view; on desktop, confirm all of them are still present and functional,
  unchanged from before this cleanup.

Run `node tests/syntax-check.js` and the file-parity `diff` (script-tags
stripped) after every task, same as the prior session's mobile-nav plan.
