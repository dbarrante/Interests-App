# Card title quality — design

## Problem

Card titles come from five+ independent extraction paths (extension clip,
extension page-meta scrape, IG/FB auto-import, DOM-scrape parsers, Takeout
importers, server-side og-fetch), each with its own fallback ladder. In
practice this produces titles that are blank, a bare domain (`instagram.com`),
a platform name alone (`"Facebook"`, via `document.title` on a login-walled
page), a templated generic (`"Facebook post"`, `"Instagram post <slug>"`), or
a platform UI placeholder (`"Untitled pin page"`). None of the three existing
refresh paths (single-card ⟳, failed-capture recapture, bulk "Get pictures &
info") fix this beyond a cheap length/pattern gate (`genericTitle()`), and
nothing generates a real title when the source page simply doesn't have one.

Decision (user, 2026-07-23): add a canonical bad-title detector, wire AI
title generation into single-card refresh (automatic) and a new Library
Health tab (explicit, reviewed), enforce library-wide uniqueness, and keep
bulk refresh AI-free to avoid uncontrolled cost/rate-limit exposure across a
multi-thousand-card library.

## Scope

- Applies to **both** `imported` cards and `saved` items (both use `.title`).
- Only touches a title when it's flagged bad by the detector — a title that
  already looks fine is never overwritten by a fresher live-page fetch, so a
  manually-edited title is never silently clobbered.

## Design

### 1. Detection — `isGenericTitle(title, url)`

New pure function in `web/lib/capture-state.js`, alongside the existing
`isBadImg`/`isFavicon` (same dual browser/Node module convention: defined
once, exported via `module.exports` and attached to `root` for inline-script
use). Signature: `isGenericTitle(title, url) -> boolean`.

Flags a title as bad when:
- blank / whitespace-only, or under 25 chars (same threshold the existing
  `genericTitle()` already uses — kept to avoid an unrelated behavior swing)
- equals `domain(url)`, or the title string is itself a bare URL
- exact case-insensitive match against a blocklist: `facebook`, `instagram`,
  `pinterest`, `twitter`, `x`, `youtube`, `tiktok`, `reddit`, `no title`,
  `untitled`, `untitled pin page`
- matches a templated-generic pattern (ported from the existing `normTitle()`
  regex): `^(facebook|fb|instagram|ig|pinterest|saved)?\s?(post|video|reel|
  photo|photos|story|link|watch|pin|item)s?$`, `N photo(s)`/`N video(s)`,
  `Instagram post <slug>`, `<Platform> post by <Author>`

**Replaces `genericTitle()` everywhere** (its 3 existing call sites —
`enrichPins`, `enrichOnOpen`, `addClip` — switch to `isGenericTitle`) so
there's one definition of "bad title" used consistently by refresh,
enrichment, and the new health tab. `normTitle()` (the Duplicates tab's fuzzy
grouping key) is untouched — different purpose, stays as-is.

### 2. AI title generation — `web/lib/title-ai.js`

New pure module mirroring `web/deadcheck-ai.js`'s prompt-builder/reply-parser
split (called from index.html via the existing `callAI(prompt, opts)`
abstraction — no changes needed to `web/ai.js`).

```js
function buildTitlePrompt({ url, domain, description, avoidTitles }) {
  // Ask for exactly one title, <=8 words, grounded in url/domain/description.
  // avoidTitles (0-3 strings, only present on a collision retry) are listed
  // as exact titles NOT to reuse.
}
function parseTitleReply(text) {
  // Extract a single-line title: strip surrounding quotes/markdown/prefix
  // ("Title:"), trim, hard-truncate to 8 words as a backstop the AI's own
  // instruction-following can't be trusted to enforce.
}
```

Input content available for the prompt: `description` comes from whatever
`Store.captureMeta`/`enrichOnOpen` already fetched (og:description or meta
description) for that card — no new fetching infrastructure needed. If both
title AND description come back empty (blocked/JS-rendered page), the AI
call is skipped entirely and the card is left flagged for the health tab
(the URL/domain alone isn't enough signal for a meaningful title).

### 3. Uniqueness

Exact match after light normalization (`toLowerCase().trim().replace(/\s+/g,
" ")`) — deliberately NOT the existing `normTitle()` fuzzy grouping, which
discards too much information for a "must be unique" check. Checked against
a `Set` built once per operation from all current `imported` + `saved`
titles.

Collision handling: retry the AI call up to 3 times, each time appending the
colliding title(s) via `avoidTitles`. If still colliding after 3 attempts,
append a short disambiguator (the source domain, e.g. `"... — example.com"`)
to the last candidate. If that *still* collides (pathological edge case),
append a numeric suffix (`" (2)"`) as a guaranteed-unique last resort.

### 4. Refresh flow integration

**Single-card refresh** (`impRefresh`'s ⟳ button and `enrichOnOpen`, which
also backs the failed-capture recapture landing path): after the existing
free re-fetch (`Store.captureMeta`) applies whatever title it found, check
`isGenericTitle(it.title, it.url)`. If still bad, call the new AI generation
automatically (`description` from the same captureMeta response, uniqueness
checked against the live library), apply the result. This is the "when
refreshing a card... use the AI component" path from the request — single
card, so the AI cost is a non-issue.

**Bulk "Get pictures & info"** (`startGetPics` and its stages): the existing
title-touching call sites (`applyCaptureResult`, `drainCaptures`) switch from
`genericTitle()`/ad hoc gates to `isGenericTitle()`, but stay free-fetch-only
— no AI call added here. A card still flagged after the bulk run surfaces in
the new Library Health tab instead. This keeps a library-wide bulk refresh
from firing hundreds/thousands of AI calls unprompted.

### 5. Library Health "Title issues" tab

New tab following the existing `HEALTH_TABS`/`_healthCounts()`/`renderHealth()`
pattern (alongside Duplicates, Dead & unsafe, Failed captures, No link).

- `_healthCounts()` gains a `titles` count: cards (imported + saved) where
  `isGenericTitle(card.title, card.url)` is true.
- `renderHealthTitles(list)`: one row per flagged card (thumbnail, current
  title, source badge), a checkbox (default checked, matching the "No link"
  tab), and a **"Suggest titles"** button.
- Clicking "Suggest titles" generates AI candidates *sequentially* for the
  checked cards (uniqueness-checked against the live library plus titles
  already accepted earlier in the same batch, so two suggestions in one run
  can't collide with each other). Each result appears in an editable text
  input next to its card, replacing the checkbox row for that card.
- An **"Apply"** button commits the accepted/edited titles: re-validates
  uniqueness at apply time (in case the library changed since generation),
  persists via the existing card-mutation path (`Store.putCards`/
  `Store.putSaved` with `{confirm:true}`), and re-renders the tab (cards that
  now pass `isGenericTitle` drop off the list).
- A card can be unchecked/skipped at either the selection or review stage
  without affecting the others.

## Testing

- `isGenericTitle()`: unit tests covering every blocklist/pattern case above,
  plus false-positive checks (a normal descriptive title must NOT be
  flagged) and the domain-equals-title / bare-URL cases.
- `buildTitlePrompt`/`parseTitleReply`: pure-function unit tests (prompt
  shape, avoidTitles inclusion, reply parsing incl. quote-stripping and the
  8-word truncation backstop).
- Confirm `genericTitle()`'s 3 former call sites now use `isGenericTitle`.
- UI-wiring tests (regex-based, matching the existing `settings-wiring.test.js`
  /`autoimport-ui-wiring.test.js` convention) for the new tab's presence and
  wiring in both `web/index.html` and `pwa/index.html`.
- An HTTP/integration-level test for the single-card refresh AI-title path
  (mocked AI response) confirming it only fires when still generic after
  free re-fetch, and that a collision triggers the retry-with-avoidTitles
  path.
