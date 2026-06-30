# Instagram match-and-heal: recover failed IG cards + clean new saves

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

Instagram cards can only be captured by browsing Instagram in Chrome (logged in, with the extension) —
the Core skips IG, and direct permalinks hit the login wall. Capture itself **works** (extension v4.39
grabs the real post photo). But a captured IG post currently always creates a **new Saved card**: it
doesn't recognize that the post is already one of the user's **failed imported cards**, so it makes a
duplicate instead of healing the failed one. The user wants **both**: recover the failed IG backlog,
and have new saves capture cleanly.

There is no reliable way to bulk-automate Instagram (it walls permalinks and rate-limits scraping, and
the extension batch driver doesn't run in this user's setup). So backlog recovery is **semi-manual**:
the user goes through their IG Saved collection in Chrome and captures each post. The fix makes those
captures **heal** the matching failed cards instead of duplicating them.

## Fix (app-side only — no extension change)

When a captured Instagram post arrives, match its permalink **shortcode** to the failed imported
cards. If it matches → heal that card with the captured photo. If not → it's a new save → Saved (as
today). Reuses the capture that already works; reuses `setCardImage`.

## Components (all in `web/index.html`, in the capture-ingest path)

1. **`igShortcode(url)` — pure helper.** Extracts the post code from `instagram.com/(p|reel|reels|tv)/<code>`;
   returns `""` for any non-Instagram or non-post URL. Matching ignores `/p` vs `/reel(s)` vs `/tv`
   (the same `<code>` is the same post).

2. **`igHealMatch(cap) -> bool` — match + heal.** Steps:
   - If `igShortcode(cap.url)` is `""` → return `false` (not an IG post).
   - Pick the captured image, preferring the post photo: `cap.clipImage || cap.screenshot ||
     cap.ogImage || cap.contentImage`. If none → return `false` (nothing to heal with; let `addClip`
     handle it / show its "couldn't capture" toast).
   - Find every failed imported card with a **bad image** whose `igShortcode(card.url)` equals the
     capture's shortcode (handles imported duplicates). If none → return `false`.
   - For each match: `setCardImage(card, <chosen image>)` (a `data:` image → stored as `idb:`; an
     `http(s)` image → stored as the URL), then `card.captured = now; card.lastUpdate = now;
     card.lastResult = "ok"; card.capReason = ""`.
   - Persist (`Store.putCards(imported)`), re-render if on the imported tab, and return `true`.

3. **Wire into `drainCaptures`.** In the existing `decision.action === "saved"` branch, call
   `igHealMatch(cap)` first; only `addClip(cap)` (→ Saved) when it returns `false`:
   ```js
   if(decision.action === "saved"){
     try{ if(!igHealMatch(cap)) addClip(cap); }catch(e){ console.error("[clip] failed", e); }
     continue;
   }
   ```
   Non-IG captures and non-matching IG captures are completely unchanged.

4. **Backlog guidance.** Add a short line to the failed-captures modal's help text (and/or the
   `social` group): *"Instagram: open your IG **Saved collection** in Chrome (logged in) and right-click
   → 'Save to Interests' on each post — matching ones heal here."* The failed list already auto-refreshes
   (the v1.5.x live status via `drainCaptures` + `refreshFailStatuses`), so cards flip to ✅ as captured.

## Flow

Browse IG Saved collection in Chrome → right-click "Save to Interests" on a post → extension captures
(works today) → `drainCaptures` ingests it → `igHealMatch` matches the shortcode → heals the failed
card (no duplicate) and the modal row flips to ✅. New posts with no matching failed card → Saved.

## Error handling / limits

- **Purely additive / non-destructive:** only fills a card whose image `isBadImg` (never overwrites a
  good image), never deletes a card, never creates a duplicate when matched.
- **No usable image in the capture** → `igHealMatch` returns `false`; `addClip`'s existing IG-no-image
  path handles it (toast "couldn't capture that post").
- **Still post-by-post** for the backlog — the accepted reality (IG can't be reliably bulk-automated).
- Facebook / Pinterest / normal-web clips are untouched (the helper only acts on IG shortcodes).

## Security / data-safety

- App-side only; no extension change, no Core/endpoint change, no new fetch. The captured image came
  from the extension exactly as a normal IG save does. `data:` images go to `idb:`, `http(s)` to a URL
  (via `setCardImage`, which cleans up any prior `idb:` blob). Run the **data-safety-reviewer**
  (additive card mutation + image path).

## Testing

- `igShortcode`: `/p/<c>/`, `/reel/<c>/`, `/reels/<c>/`, `/tv/<c>/` → `<c>`; `instagram.com/accounts/login`
  and non-IG URLs → `""`.
- `igHealMatch`: a clip whose shortcode matches a failed imported card (bad image) heals it
  (image set, `lastResult:"ok"`, `capReason:""`) and returns `true`; a clip with no matching failed
  card → `false`; a clip with no usable image → `false`; `/reel/<c>` capture matches a `/p/<c>`
  imported card (alias). (These are renderer functions — test via the project's `_extract`/text-assert
  pattern as feasible, plus a wiring assert that `drainCaptures` calls `igHealMatch` before `addClip`.)
- `tests/syntax-check.js` + full `node tests/run.js` green.

## Out of scope / deferred

- Auto-scroll / bulk IG capture (rejected — fragile, IG rate-limits, batch driver doesn't run here).
- Any extension change (capture already works; right-click already routes through the engine).
- Healing non-IG cards from clips (covered by the separate `_recapTarget` heal and the og-URL fallback).
