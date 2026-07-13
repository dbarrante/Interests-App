# Dropbox connect UI (iPad PWA) — design

Closes the gap flagged in `pwa/HANDOFF.md`: `pwa/index.html` has no in-app way
to start the Dropbox OAuth flow. Today, connecting only works in a browser
that already ran it once via `dbx-test.html`/`sync-test.html`, which `Store`
reads tokens out of transparently. A fresh browser or a real device has no way
in.

## Constraint this design has to respect

`pwa/index.html` is documented (README.md, HANDOFF.md) as a byte-for-byte copy
of `web/index.html`, with only its `<script>` tags allowed to differ from the
desktop version. Adding the Connect UI as static HTML/inline script in
`index.html` would break that parity and make future re-merges with
`web/index.html` harder. This design keeps `index.html`'s HTML and inline
script untouched.

## Architecture

One new file, `pwa/dropbox-connect.js`, added as one more `<script>` tag in
`pwa/index.html`'s script list — after `storage-pwa.js` (needs `IADropbox`
from `oauth.js`, and calls the page's existing global `renderSyncStatus()`).

It runs an IIFE on load that:
1. Handles the OAuth redirect callback first, if the page just came back from
   Dropbox with `?code=...&state=...` in the URL.
2. Injects a "Connect to Dropbox" subsection at the top of the existing
   `.sec` block that contains `#syncToggle`, found via
   `document.getElementById("syncToggle").closest(".sec")` — not by DOM
   position — so it stays correct if unrelated edits move things around
   inside the Settings panel.
3. Wires up its own Connect/Disconnect button and an App-key input.

No HTML or inline-script edits to `index.html` itself.

## Components

Injected markup (built via `insertAdjacentHTML`; no user-supplied data goes
into it, so `esc()` isn't needed here):

- Dropbox App key text input, pre-filled from
  `localStorage[IADropbox.LS_KEYS.appKey]`, saved on blur/change.
- Status line, mirroring `dbx-test.html`'s three states:
  - `"Not connected."`
  - `"Connected as <email>"`
  - `"Connected, but account check failed: <msg>"`
- One button that toggles between "Connect to Dropbox" and "Disconnect"
  depending on `IADropbox.isConnected()`.
- A small "last error" line under the status, for surfacing messages that
  `handleRedirectCallback` would otherwise only send to `console.log` (there's
  no `#log` panel here like `dbx-test.html` has). Cleared on the next
  successful action.

## Data flow

**On page load**, before rendering the widget's own state:

```js
const appKey = localStorage.getItem(IADropbox.LS_KEYS.appKey) || "";
const redirectUri = location.origin + "/";
localStorage.setItem(IADropbox.LS_KEYS.redirectUri, redirectUri);
const wasCallback = await IADropbox.handleRedirectCallback(appKey, redirectUri, logFn);
```

Redirect URI is always auto-computed as `location.origin + "/"` — no UI field
for it. This matches how `sync-test.html`/`worker-config.html` already default
it, and matches the registered URI noted in HANDOFF.md
(`http://localhost:8080/`, no path suffix).

If `wasCallback` is true, `handleRedirectCallback` already stored tokens (or
logged a failure) via `oauth.js`. The widget re-renders its own status and
calls the page's existing `renderSyncStatus()` so the sync
toggle/device-label/peer list picks up the new `connected` state immediately
— that field already comes back from `Store.syncStatus()` in
`storage-pwa.js`, it's just never been surfaced visibly until now.

**Connect click**: reads the App-key input, requires non-empty (toast if
blank), persists it, then `IADropbox.beginAuthorize(appKey, redirectUri)` —
this navigates away to Dropbox, so nothing else runs after it on this load.

**Disconnect click**: `IADropbox.disconnect()`, then re-render the widget and
call `renderSyncStatus()`.

## Error handling

Every failure mode already has a defined behavior one level down in
`oauth.js` (state-mismatch and token-exchange errors are logged by
`handleRedirectCallback`; `getCurrentAccount` failure is caught in the status
check). The widget's only job is to route those messages to the visible
"last error" line instead of only `console.log`.

## Explicitly out of scope

- The existing "Choose Dropbox folder…" button (desktop-only, File System
  Access API) is left as-is. It already fails gracefully — `Store.
  setSyncFolder()` resolves `{ok:false, reason:"Not applicable on iPad..."}`
  and the click handler toasts that reason. Not broken, just a rough edge;
  out of scope for this task.
- No editable Redirect URI field (see above — auto-computed only).
- No changes to `oauth.js`, `storage-pwa.js`, or `index.html`.

## Testing

Manual verification only, matching the rest of this codebase (no test
harness/build step): fresh browser profile, enter App key, click Connect,
complete real Dropbox OAuth, confirm the redirect back to `index.html` lands
on Settings with "Connected as …" shown and `renderSyncStatus()`'s existing
peer list populates; then Disconnect and confirm it reverts cleanly.
