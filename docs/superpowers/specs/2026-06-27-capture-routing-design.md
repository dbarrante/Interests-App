# Capture & Routing (v2 — sub-project 1) Design

**Date:** 2026-06-27
**Status:** Approved (design); ready for implementation planning
**Topic:** Fix the capture→save routing data-safety bug and two capture-reliability issues in the shipped v1 Interests App, with the routing decision extracted into a pure, unit-tested function.

---

## Goal

Make saving from the Chrome extension safe and reliable: a Save can never overwrite the wrong Imported card; YouTube videos save as a clean thumbnail; saved Pinterest pins reliably show a picture. The data-safety-critical routing decision becomes a pure, tested function.

## Context

This is **v2 sub-project 1** (of: capture & routing, Dropbox sync, Instagram import, scheduled extraction, ⋯-menu, Pinterest Save-button). v1 is the shipped Electron desktop app (`D:\Dropbox\Documents\Claude\Projects\Interests App`; Express + `node:sqlite` + images-as-files; `web/index.html` UI + `web/storage.js`; Chrome capture extension delivers captures over HTTP to `POST /api/captures`; the app drains via `GET /api/captures` polled every 3 s).

Bugs this pass fixes (found in v1 manual smoke):
1. **DATA-SAFETY — clip mis-attribution:** a clip (popup/right-click "Save to Interests") could be routed to "fill" an *unrelated* Imported card and overwrite its image. Observed: a YouTube clip overwrote a Pinterest "Super-girl" card. Cause: the clip branch in `drainCaptures` (web/index.html ~3518-3541) matches loosely (URL + a recently-opened "active card" fallback) and calls `setCardImage` on the match.
2. **YouTube watch-page capture quality:** YouTube hijacks right-click on the player, so the only path is the popup "Clip this page" — which saves a full-page screenshot instead of the clean video thumbnail.
3. **Saved-pin image reliability:** a saved pin stored a *permalink* as its image → the render fallback proxied it via `image.thum.io` → `403` → no picture.

## Decisions (locked with the user, 2026-06-27)

| Decision | Choice |
|---|---|
| First v2 sub-project | **Capture & routing** |
| Scope of this pass | **Bug-fixes + reliability only** (no new save-features) |
| Save routing | **A Save always goes to the Saved library; it NEVER modifies Imported cards** (dedupes within Saved) |
| Approach | **Surgical fixes + extract the routing decision into a pure, unit-tested function** |

## Non-Goals (separate v2 sub-projects / later)

- ⋯-menu "Save to Interests"; Pinterest native Save-button → library import.
- Dropbox snapshot sync; Instagram import; scheduled extraction.
- Restoring the already-corrupted Super-girl card image (one-off user action: re-import the `2026-06-22` backup or re-save the pin).

---

## Architecture — a pure, testable router

The capture-routing **decision** moves out of `drainCaptures` into a new dual-use module **`web/route-capture.js`** (browser global + `module.exports`, same pattern as `web/storage.js` and `extension/bridge-probe.js`), so it is `require()`-able by Node tests.

```js
// web/route-capture.js
// Pure decision: given a capture and current state, decide what to do.
// No side effects, no DOM, no Store calls — caller executes the result.
function routeCapture(cap, ctx) {
  // ctx = { imported, lastOpened, now, normalizeUrl, domain }   (helpers injected)
  if (!cap || !cap.url) return { action: "skip", reason: "no url" };
  if (cap.dead)        return { action: "dead", reason: "extension reported dead/removed" };
  if (cap.clip)        return { action: "saved", reason: "clip → Saved library (never modifies Imported)" };

  // Non-clip capture = an image fetched FOR an imported card (batch/auto-capture).
  const { imported, lastOpened, now, normalizeUrl, domain } = ctx;
  let target = cap.id ? imported.find(it => it.id === cap.id) : null;
  if (!target) target = imported.find(it => it.url === cap.url);
  if (!target) target = imported.find(it => it.url && normalizeUrl(it.url) === normalizeUrl(cap.url));
  if (target) return { action: "card-image", target, reason: "matched imported card by id/url" };

  // Recently-opened "active card" — ONLY same, non-empty domain and within window.
  const ACTIVE_WINDOW = 30 * 60 * 1000;
  if (lastOpened && lastOpened.id && now - (lastOpened.ts || 0) < ACTIVE_WINDOW) {
    const c = imported.find(it => it.id === lastOpened.id);
    if (c && c.url && cap.url && domain(c.url) && domain(cap.url) && domain(c.url) === domain(cap.url)) {
      return { action: "card-image", target: c, reason: "active card (same domain)" };
    }
  }
  if (cap.force && !cap.id && !cap.blocked) return { action: "saved", reason: "manual capture, no card → Saved" };
  return { action: "unmatched", reason: "no confident match" };
}
```

**`drainCaptures` integration:** for each capture, call `routeCapture`, **log** `"[route] " + cap.url + " → " + action + " (" + reason + ")"`, then execute:
- `dead` → existing remove-card logic.
- `saved` → `addClip(cap)` (Saved library; `addClip` already dedupes within Saved via `clipKey`).
- `card-image` → set the image on `target` only (existing fill logic, **scoped to a confident target**); never overwrite an existing non-bad image unless `cap.force`/`cap.recap`.
- `unmatched` → the existing "received but no matching card" toast; do not modify any card.

The old "fill imported card from a clip" branch is **removed** — clips never reach `card-image`.

## Reliability fixes

**Fix 3 — YouTube clean thumbnail.** In `extension/background.js` `clipCurrentPage`, detect a YouTube `*.youtube.com/watch` or `/shorts/` URL and set `noShot: true`, relying on the page's og:image (the video thumbnail). `addClip`'s existing image priority (`clipImage` → `screenshot` → `ogImage`) then uses the og:image. Result: a clean thumbnail card, not a page screenshot.

**Fix 4 — saved-pin image reliability.** The `thum.io 403` happens when a saved card has **no real image** and the render fallback tries to *screenshot the card's URL* through a proxy — which 403s for Pinterest permalinks, leaving no picture. Two parts:
- *Ensure a real image at save time:* `addClip` stores a genuine image — `clipImage`/right-clicked `info.srcUrl` (e.g. `i.pinimg.com`) → page og:image → screenshot — so a pin is saved **with** its picture and the URL-proxy fallback isn't needed.
- *Graceful fallback:* the render image-fallback chain (`web/index.html` ~`resolveImg`/`nextImg`/`imageChain` ~660-680) lands on a **clean placeholder** when a proxy fails/403s (and skips proxying obvious non-image permalinks), instead of looping on a broken image.

## Diagnostics

Permanent, lightweight: the `[route] <url> → <action> (<reason>)` line per capture (above) makes any future capture issue answerable from the console.

## Testing

- **`tests/route-capture.test.js`** (pure unit tests, `require("../web/route-capture")`), covering:
  - clip → `saved`, even when `cap.url` matches an Imported card (never `card-image`);
  - `dead` → `dead`;
  - non-clip with `cap.id` → `card-image` (that card);
  - non-clip exact-URL and normalized-URL → `card-image`;
  - non-clip, no URL match, recent active card **same domain** → `card-image`;
  - non-clip, no URL match, recent active card **different domain** → `unmatched` (the YouTube-clip-vs-Pinterest-card bug — must NOT match);
  - non-clip, no match, no active card → `unmatched`;
  - empty `domain()` on either side → never matches via the active-card path.
- The inline-`<script>` syntax gate (`tests/syntax-check.js`) covers `web/index.html` + `web/route-capture.js`; `node tests/run.js` stays green.
- **Manual smoke:** save a YouTube video (popup) → clean thumbnail in Saved; right-click a Pinterest pin → its picture shows; confirm the `[route]` logs; confirm a save never alters an Imported card.

## Error handling & safety

- The router is pure and logged — decisions are auditable, not guessed.
- A clip can never modify an Imported card. A non-clip capture only sets an image on a confident, same-domain target, and never overwrites an existing good image on a low-confidence match.

## Files

- **Create:** `web/route-capture.js`, `tests/route-capture.test.js`.
- **Modify:** `web/index.html` — load `route-capture.js`; rewrite the `drainCaptures` decision to call `routeCapture` + log + execute; remove the clip "fill imported" branch; harden the image render fallback (Fix 4 display). `extension/background.js` — `clipCurrentPage` YouTube `noShot` (Fix 3); ensure `addClip`/clip payload never stores a permalink as image (Fix 4 prevention is in `web/index.html addClip`).

## Suggested implementation phases (for the plan)

1. **`web/route-capture.js` + `tests/route-capture.test.js`** — pure router, TDD (write the bug case first), green.
2. **Wire `drainCaptures` to the router** — call/log/execute; remove the clip fill-imported branch; keep non-clip image-set scoped to a confident target.
3. **Fix 3 — YouTube thumbnail** in `clipCurrentPage`.
4. **Fix 4 — pin image** (addClip never stores permalink; render fallback handles non-image / 403 → placeholder).
5. **Verify** — `node tests/run.js` green; manual smoke checklist.
