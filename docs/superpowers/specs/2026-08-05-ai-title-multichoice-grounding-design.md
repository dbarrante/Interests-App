# AI Title Multi-Choice + Content Grounding — Design

## Problem

Two related complaints about the existing AI title pipeline (`generateUniqueTitle` → `titleFromSignal` → `buildTitlePrompt`/`parseTitleReply` in `web/title-ai.js` and `web/index.html`):

1. **Only one suggestion.** `edAiTitle()` generates a single AI title and drops it straight into the edit modal's title input. The user can't compare alternatives before choosing.
2. **Titles are often inaccurate.** Root-caused to thin grounding, not model/provider choice: `core/capturemeta.js`'s `extractOg()` only ever pulls a page's `og:description` (or generic `<meta name="description">`) — a short, sometimes boilerplate, sometimes entirely-missing string. `generateUniqueTitle`'s best tier (a "real description") is only as good as that string. No article body text is ever extracted or used. Web research this session confirmed grounding (real retrieved content) is the dominant lever for LLM output accuracy — more impactful than prompt wording — and found no benchmark evidence favoring one of this app's 5 supported providers over another for title/summarization accuracy specifically.

A third, related request: when an AI (or manual) title replaces a card's *current* title, any `#hashtags` embedded in the outgoing title should also be captured as tags — extending the hashtag→tag mechanism already shipped for *incoming* AI titles (`extractHashtags()` in `web/title-ai.js`, wired into `applyGeneratedTitle`) to run on the title being discarded too, at every site that overwrites a card's title.

This spec covers all three together, since they touch the same call sites and the multi-choice picker is the natural place to first surface improved grounding.

## Non-goals

- No new AI provider, no hardcoded provider preference.
- No change to what's displayed as a card's description (`card.desc`, 220-char cap) — grounding only improves the AI's *input*, not the UI.
- No true HTML-readability parsing (Readability.js-style boilerplate removal) — out of scope; a cheap `<p>`-tag heuristic is enough, per the "zero new dependencies" project constraint.

## 1. Configurable suggestion count

New setting `S.aiTitleSuggestCount`, default `3`, clamped `1–5` on read/write (same pattern as existing numeric settings like `backupRetainCount`). Added to `DEFAULTS` and to the Settings panel as a number input near the other AI options.

## 2. Multi-choice title picker

**Current:** `edAiTitle()` (`web/index.html:4881`) calls `regenerateTitleFor(card, [box.value.trim()].filter(Boolean), busyLabel)`, which returns one string, and writes it straight into `#edTitle`.

**New:**
- `regenerateTitleFor` gains a fetch-grounding step (see §4) shared by every caller, unchanged return contract (still resolves one string, still used as-is by `impRefreshTitle` and `retryTitleSuggestion`).
- New `regenerateTitleChoices(card, extraAvoid, count)`: fetches grounding once, then calls `generateUniqueTitle(card, accumulatedAvoid, true, groundingText)` up to `count` times, appending each successful candidate to `accumulatedAvoid` before the next call (same collision-avoidance the single-suggestion path already relies on via `titleFromSignal`'s `avoidTitles`). Returns an array of the successful candidates — may be shorter than `count` if some attempts fail the quality gate; never padded with a worse fallback.
- `edAiTitle()` calls `regenerateTitleChoices(card, [box.value.trim()].filter(Boolean), S.aiTitleSuggestCount)` and renders the results as clickable chips in a new `#edTitleChoices` container below the title input (new `renderTitleChoices(list)`). Clicking a chip sets `box.value` to that candidate — same "stage for review, nothing written until Save" contract the whole edit modal already uses. The container is cleared when the modal opens/closes and when a new lookup starts.
- If `regenerateTitleChoices` returns zero candidates, show the same toast `regenerateTitleFor` already shows on failure (reuse its `failReason` messaging — `regenerateTitleChoices` surfaces the first attempt's fail reason if all attempts fail).
- `impRefreshTitle` (grid hover icon, no review step) and `retryTitleSuggestion` (Title-issues panel retry) are unaffected — they keep using single-shot `regenerateTitleFor`. The picker is specifically for the reviewed edit-modal flow, where showing options is valuable; the no-review icons are one-click-apply by design and stay that way.

## 3. Original-title hashtag capture, app-wide

**Existing mechanism** (shipped earlier this session): `extractHashtags(rawTitle) -> {title, tags}` (pure, `web/title-ai.js`), used by `applyGeneratedTitle` (`web/index.html:6533`) to strip hashtags out of a *new* AI-generated title and add them as tags.

**Gap:** hashtags embedded in the title being *discarded* (e.g. an imported card whose raw caption became its placeholder title, now being replaced by a cleaner AI or manual title) are lost.

**Fix:** factor the tag-cleaning block `applyGeneratedTitle` already has inline into a shared helper, then add a second helper that runs it against the outgoing title:

```js
// Clean + merge a raw hashtag list into the card's tags (dedupe, canonicalize,
// filter AI_TAB_TAG and bad patterns) -- shared by both the incoming-AI-title
// path (applyGeneratedTitle) and the outgoing-title path below.
function mergeCleanTags(card, rawTags){
  const seen=new Set(), cleaned=[];
  (rawTags||[]).forEach(t=>{
    if(t===AI_TAB_TAG) return;
    t=canonicalTag(t);
    const k=t.toLowerCase();
    if(seen.has(k)) return; seen.add(k);
    if(!tagBadPattern(t)) cleaned.push(t);
  });
  if(cleaned.length) card.tags = Array.from(new Set([...(card.tags||[]), ...cleaned]));
  return cleaned;
}
// Pull #hashtags out of a title about to be overwritten and add them as tags
// too -- the most common real source is a raw imported caption used as a
// fallback title, not the AI's own (rarely hashtag-laden) prose.
function captureOutgoingHashtags(card){
  if(!card || !card.title) return;
  mergeCleanTags(card, extractHashtags(card.title).tags);
}
```

`applyGeneratedTitle` is updated to call `mergeCleanTags(card, extracted.tags)` instead of its inline block (behavior-preserving refactor), plus a new `captureOutgoingHashtags(card)` call before `card.title` is overwritten.

Wired into the same 5 title-write choke points the title-rollback feature (2026-08-04) already established as covering "every place a card's title changes" — call `captureOutgoingHashtags(card)` immediately before each site's title assignment, alongside the existing `captureOrigTitle(card, newTitle)` call:

- `applyGeneratedTitle` (`web/index.html:6533`) — before `card.title = newTitle`
- `cardEditSave` (`web/index.html:4863`) — before `it.title = title.slice(0,250)`
- `impEditSave` (`web/index.html:4994`) — inside `if(title){...}`, before `it.title=title`
- `applyTitleSuggestions`'s manual (non-AI-origin) branch (`web/index.html:7320`, the `else card.title=val.slice(0,250)` line) — the AI-origin branch already routes through `applyGeneratedTitle`, so no separate call needed there
- `enrichOnOpen`'s og-tag branch (`web/index.html:5193`, the `if(m.title && ...)` block) — before `it.title=newTitle`

## 4. Content grounding for accuracy

**Discovery:** `core/contentcheck.js` already has `extractText(html, maxChars=4000)` — strips `<script>`/`<style>`/all tags, collapses whitespace, caps length — and it's *already called* inside `captureMetaChunk` (`core/capturemeta.js:87`) for dead-page classification, then discarded. No new extraction primitive is needed; the raw material is already being fetched and processed in the same request `extractOg` uses.

**New:** `extractArticleExcerpt(html)` in `core/capturemeta.js`:
1. Try joining all `<p>...</p>` block text (regex-extracted, inner tags stripped) — better signal-to-noise than a flat whole-page dump, since real article bodies are `<p>`-heavy while nav/footer chrome usually isn't.
2. If that yields too little text (< ~200 chars — most likely a non-`<p>`-based page), fall back to `contentcheck.extractText(html, 1500)`.
3. Cap the result at 1500 chars either way (headroom under `buildTitlePrompt`'s existing 1000-char `description` slice in `web/title-ai.js:17` — no prompt-building code changes needed at all, since this only changes *what string* gets passed as `description`).

`captureMetaChunk`'s per-item result gains a new `excerpt` field. `POST /api/capture-meta`'s response includes it. `Store.captureMeta` (`web/storage.js:211`) is a thin JSON passthrough — the new field reaches the client with no client-side plumbing changes.

**Consumption:**
- `generateUniqueTitle(card, extraAvoid, allowVision, groundingText)` — new 4th param. When `groundingText` is non-empty, it's used as the tier-0 description *instead of* `card.desc||card.benefit` (fresher and richer by construction — a stored `desc` may be stale, thin, or absent). `card.desc` itself is never written from this value — display behavior is unchanged.
- `enrichOnOpen` (`web/index.html:5193`) already calls `Store.captureMeta` for every card it enriches — pass `m.excerpt` straight into its `generateUniqueTitle` call as `groundingText`. No new network round-trip; grounding improves for free on the most common (automatic, background) title-generation path.
- `regenerateTitleFor` (`web/index.html:7147`) — used by the manual picker, the grid refresh icon, and Title-issues retry — fetches grounding explicitly via one `Store.captureMeta` call before generating, reusing the same busy-overlay UX it already shows ("Looking up a better title…"). `regenerateTitleChoices` (§2) fetches it once and reuses it across all N attempts in one picker session, since grounding is a property of the source article, not of any individual attempt.
- If the capture-meta call fails or the card's URL is unreachable/skipped (social hosts, SSRF-blocked, etc.), `excerpt` comes back empty and generation silently falls back to today's behavior (`card.desc`/OCR/vision/fallback tiers, unchanged) — no new error states, no new failure toasts.

## Testing

- `web/title-ai.js`: unit tests for `mergeCleanTags`/`captureOutgoingHashtags` (pure) — dedupe, canonicalization, `AI_TAB_TAG` exclusion, bad-pattern filtering, no-op on titleless/hashtag-less input.
- `core/capturemeta.js`: unit tests for `extractArticleExcerpt` — `<p>`-tag path, whole-page fallback path, length cap, empty/malformed HTML.
- `core/server.js` / `capturemeta` integration test: `/api/capture-meta` response includes `excerpt`.
- `web/index.html` sandboxed function tests (this project's `new Function(...)`-extraction pattern): `regenerateTitleChoices` accumulates avoid-lists correctly and returns a short list rather than padding on partial failure; `generateUniqueTitle` prefers `groundingText` over `card.desc` when both are present.
- Existing `node tests/run.js` full suite must stay green.
- `pwa/sw.js`'s `SHELL_CACHE` must be bumped as part of this plan's last task (this touches `pwa/index.html`) — per the standing project memory on this recurring miss.

## Global constraints for the implementation plan

- `web/index.html` and `pwa/index.html` must stay functionally identical for every touched function (project-wide dual-file constraint).
- `buildTitlePrompt`/`parseTitleReply` in `web/title-ai.js` are unchanged — grounding flows through the existing `description` parameter only.
- No new field is persisted on cards for grounding — `excerpt` is transient, request-scoped only.
- `pwa/sw.js`'s `SHELL_CACHE` bump is a required step, not left to a reviewer to catch.
