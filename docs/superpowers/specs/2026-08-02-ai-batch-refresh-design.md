# AI batch retag/retitle + hashtag-to-tag — design

## Goal

A Library Health tool that runs the AI title-generation and/or tagging
pipelines across the whole library, 200 cards at a time, skipping cards
already refreshed within a user-set number of days — so re-running it
never restarts from scratch, it just keeps working through whatever's
gone stale. Separately: whenever a title gets AI-written anywhere in the
app, any `#hashtag` tokens in it become tags and are stripped from the
title text.

Entirely a **web/pwa client-side feature**, reusing existing AI-call
plumbing (`callAI`, `IA_AI.hasAIKey()`). No `core/` changes.

## Freshness field: `aiRefreshedAt`

A new plain per-card field (epoch ms, like `.edited`/`.lc.at`/`.sb.at`
elsewhere in this file — not a nested object, since there's nothing else
to store alongside it): stamped on every card the batch touches,
regardless of whether that run did retag, retitle, or both. This is the
whole resumability mechanism — no separate cursor/offset is stored
anywhere. Each run's candidate query is:

```js
imported.concat(saved).filter(it => it &&
  (!it.aiRefreshedAt || (Date.now() - it.aiRefreshedAt) > S.aiRefreshDays*864e5)
).sort((a,b) => (a.aiRefreshedAt||0) - (b.aiRefreshedAt||0)).slice(0,200)
```

Sorted oldest-first (never-touched cards, `aiRefreshedAt` undefined, sort
as `0` — oldest possible — so they're always processed before merely
stale ones). This exactly mirrors the existing `.lc`/`_lcFresh`/`.sb`/
`_sbFresh` "skip if checked within N days" pattern already used for
link-safety checks (`web/index.html:8003-8005`, `:8127-8128`) — same
shape, new field, no new mechanism invented.

## Settings: `S.aiRefreshDays`

One new number field in `S` (default e.g. `30`), added to `DEFAULTS`
alongside the other small settings. Editable from the new Library Health
section itself (see below) — no separate Settings-tab entry needed, since
this value is only ever read from the one place it's used.

## UI: a new Library Health tab

`HEALTH_TABS` (`web/index.html:6389-6395`) gains one entry:
`{ id:"airefresh", label:"AI refresh" }`. `renderHealth()`'s dispatch
gains `if(tab==="airefresh") return renderHealthAiRefresh(list);`,
following the exact structure `renderHealthTitles` already uses.

The tab's body:
- A count line: how many cards are currently eligible (same
  `aiRefreshedAt`-stale predicate as above, computed live, no scan
  needed — it's a synchronous filter over in-memory arrays).
- A number input bound to `S.aiRefreshDays` ("Only touch cards older
  than ___ days").
- Two checkboxes: "Retag" and "Retitle" (independently toggleable —
  "and/or" from the request). At least one must be checked to enable the
  run button.
- A "Process next 200" button (relabels itself while running, matching
  `autoTag`'s spinner-button pattern), showing `toast()` progress the
  same way `autoTag()`/`openGetPics()` do.
- A brief cost note next to "Retitle": generating a title can call the
  paid vision tier when cheaper signals (description, OCR) come up empty
  — same as the existing single-card refresh button already does; this
  batch doesn't change that pipeline, just runs it across more cards at
  once.

## Retag: generalizing `autoTag()`, not replacing it

`autoTag()` (`web/index.html:3473-3507`) is untouched and keeps its own
"Tag N untagged" button/behavior exactly as today — it's a different
entry point for a different, narrower job (cards with *zero* tags).

The new batch's retag step needs the same core "send a chunk of cards to
the AI, get tags back" logic, but for potentially-already-tagged cards,
merging new tags in rather than overwriting. The chunk-processing body of
`autoTag()` (lines 3481-3497: build the prompt, call `callAI`, parse,
apply) is factored into a shared function,
`aiTagChunk(cards) -> Promise<void>` (mutates each card's `.tags`/
`.category`/`.cat` in place, same shapes `autoTag` already produces), that
both `autoTag()` and the new batch call. The only behavioral difference
between the two callers is what each does with the AI's tag list:
- `autoTag()`: `q.tags = r.t...` (cards had none, so "set" and "merge"
  are the same operation) — unchanged.
- The new batch: merges (`q.tags = Array.from(new Set([...(q.tags||[]),
  ...r.t...]))`), consistent with the "add on top" decision.

Category is still always set (not merged — a card has exactly one
category), same `.cat`/`.category` split handling `autoTag()` already
gets right.

## Retitle: reuses `generateUniqueTitle` directly

The batch calls `generateUniqueTitle(card, undefined, true)`
(`web/index.html:6320`) per card — the exact same full pipeline (desc →
OCR → vision → deterministic fallback) the manual per-card refresh button
already uses, vision included, unchanged. It does **not** go through
`regenerateTitleFor`'s wrapper (`:6862`), since that wrapper's busy
overlay/single-card toast is built for one card at a time, not 200 — the
batch has its own progress UI instead.

## Hashtag → tag, wired into every AI-driven title write

**New shared helper**, e.g. `applyGeneratedTitle(card, rawTitle)`:
1. Extract every `#word` token from `rawTitle` (word = letters/digits/
   underscore, no length cap beyond what a real hashtag would ever be) —
   new regex, no existing precedent to reuse (confirmed: nothing in this
   codebase currently scans free text for embedded hashtag tokens; the
   only existing `#`-handling, `web/index.html:4397`, strips a single
   *leading* `#` from an already-isolated AI-returned tag string, a
   different, narrower job).
2. Strip those tokens from the title text (collapsing any resulting
   double-spaces), producing the clean title.
3. Run each extracted token through the same cleaning `aiSuggestTags`
   already does for AI-returned tags (`web/index.html:4396-4404`):
   lowercase, `canonicalTag()` (merge onto an existing tag if it's the
   same word/near-plural), skip anything `tagBadPattern` rejects.
4. Set `card.title` to the cleaned title (capped at 250 chars, matching
   every existing title-write site), merge the cleaned hashtag tags into
   `card.tags` (same merge-not-replace rule as retagging above).
5. Return whether anything changed, so the caller knows whether to
   persist/toast.

**Wired into the three existing AI-driven title-write sites** (refactored
to call this helper instead of writing `.title` directly):
- `impRefreshTitle` (`:6905-6917`)
- `enrichOnOpen`'s AI-title branch (`:5104-5109`)
- the Title-issues panel's Apply flow (`:7018-7050`, the loop that reads
  each row's — possibly user-edited — suggestion text and commits it)

**Deliberately NOT wired into manual title edits** — `cardEditSave`
(`:4735-4746`, the Saved-card edit form) and `impEditSave` (`:4855-4864`,
the Imported-card edit form) both let the user type a title directly into
a text box and save it verbatim. Silently stripping characters out of
text someone just typed by hand — and creating tags they didn't ask
for — would be surprising in a way it isn't when the text originated from
AI/scraped content in the first place. **Scope call, not explicitly
confirmed with the user** — flagging it here for visibility; the fix if
this reading is wrong is a small, additive change to also route those two
call sites through the same helper.

**The new batch's own retitle step also routes through
`applyGeneratedTitle`** — one call site, not a duplicate implementation.

## `.titleSet` handling

Matches the existing convention (only the Title-issues Apply flow sets
`.titleSet=true` today; `impRefreshTitle`/`enrichOnOpen`'s auto-regenerated
titles don't, since a fresh AI title should already pass `isGenericTitle`
on its own merits without needing the manual-override flag). The new
batch's retitle step follows the same rule as `impRefreshTitle` —
does **not** set `.titleSet`.

## Persistence

Same incremental-persist-per-chunk pattern `autoTag()` already uses
(`Store.putCards(imported); persistAll();` after each chunk, not just at
the end) — an interrupted run (page closed mid-batch) keeps whatever
progress it made; nothing is lost, and the next run's freshness query
naturally skips the cards that already got stamped.

## Out of scope (v1)

- No automatic/scheduled running — manual button only (confirmed
  decision).
- No per-run cost estimate/preview before starting.
- No UI to review AI-generated tags/titles before they're applied (matches
  `autoTag()`'s existing auto-apply behavior, not the Title-issues panel's
  review-first behavior) — this is a deliberate batch-maintenance tool,
  not a review tool; the existing Title-issues panel remains the
  review-first option for anyone who wants to check before applying.

## Testing

- Plain-`assert` tests for: the freshness-query predicate/sort (including
  the "never touched sorts oldest" case); `aiTagChunk`'s merge-not-replace
  behavior on an already-tagged card, and its unchanged behavior for
  `autoTag()`'s own untagged-card case (regression coverage); the new
  `S.aiRefreshDays` field round-tripping through settings save/load;
  `applyGeneratedTitle`'s hashtag extraction (multiple hashtags, no
  hashtags, hashtag-only title, mixed case, tag-merge-not-replace,
  `canonicalTag` folding onto an existing tag) as a pure function,
  independent of the AI call; each of the three refactored call sites
  still doing everything they did before, plus now routing through the
  helper.
- Byte-identity check between the touched functions in `web/index.html`
  and `pwa/index.html` — required project convention.
- Manual smoke test needs a real AI key (cannot be fully automated):
  running the batch against a small real library and eyeballing the
  results.
