# "Analyze my library" → interest profile

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

The app already personalizes recommendations (New ideas / Stumble) from the user's
**About you** (`S.about`) + **interests list** (`S.interests`) + imported saves
([buildPrompt, web/index.html ~1230](../../../web/index.html)). Today the only AI-assisted way to
*build* that profile is the **Discover** tool, where the user types a rough musing and the AI
suggests interest chips ([discoverInterests, web/index.html:3414](../../../web/index.html)).

The user wants the AI to instead **analyze their whole library (~7,400 cards)** to derive their
interests, present them for review, and populate the profile — which the existing feed then uses.

## Solution overview

A new **"Analyze my library"** button in Settings → *Your interest profile*. It aggregates all
cards locally into a compact summary, sends that in **one** AI call, and returns (a) interest
topics and (b) an "About you" draft. The user reviews topics as checkbox chips and edits the
draft, then accepts — **non-destructively** populating `S.interests` and `S.about`. The existing
feed/Stumble then use the enriched profile automatically (no feed changes).

This reuses: the existing AI provider dispatch, the Discover chip-review pattern, and the existing
feed. The genuinely new work is the local aggregation + the review panel.

## Behavior

### Aggregate (local, free, scales to any size)

Scan **all** cards (`imported` + `saved`) and build a compact summary — top-N of each, never the
raw 7,400 titles:

- **categories:** count of each `card.category`, top ~40.
- **domains:** count of each card's URL host, top ~40.
- **title keywords:** tokenize titles, drop stopwords + short tokens, count, top ~60.
- **tags:** count of each tag if cards carry a `tags` array, top ~40 (skipped if absent).

Result shape: `{ total, categories:[{name,count}], domains:[{name,count}], keywords:[{word,count}], tags:[{name,count}] }`.

### Analyze (one AI call)

Build a prompt from the summary + the user's current `S.about`/`S.interests` and call the
configured provider (same dispatch as Enrich/feed; key required → toast + Settings if missing).
Ask for **~15–25 interest topics** (2–5 words each, feed-able), drawn **primarily from the library**
with **a few clearly-adjacent "stretch" topics**, plus a short first-person **"About you" draft**
(2–4 sentences) describing the user's taste. Response is strict JSON:
`{ "interests": ["…", …], "about": "…" }`. Parse tolerantly (strip code fences; locate the JSON
object; fail-safe to empty on garbage, with a toast).

### Review & accept (user in control)

A review panel shows:
- **interest topics as checkbox chips**, all checked by default — deselect any (reuse the existing
  `discTags`/`toggleTag`/`renderDiscTags` chip pattern, in a parallel set so Discover is untouched);
- an **editable "About you" textarea**, pre-filled with `S.about` (existing) + a blank line + the
  AI draft, so the user can keep/merge/trim — nothing is lost.

**Accept:** `S.interests` ← dedup-append(existing, checked chips) (case-insensitive de-dupe, never
removes); `S.about` ← the textarea's current content. Persist via the existing `save("settings", S)`
+ update the `#interestList` / `#aboutMe` Settings fields. **Cancel** discards everything.

### Recommendations — already wired

No feed work. New ideas / Stumble already read `S.about` + `S.interests`; once the profile is
populated they reflect it automatically.

## Components

- **NEW `web/profile-analyze.js`** (pure, dual browser/Node UMD like `web/route-capture.js`):
  - `summarizeLibrary(cards) -> { total, categories, domains, keywords, tags }` (cards = the
    combined imported+saved array; pure).
  - `buildProfilePrompt(summary, { about, interests }, extraSources) -> string` (pure).
    `extraSources` is an **optional** array of `{ label, text }` (default `[]`) appended to the
    prompt as additional taste signals. It is unused now (always `[]`) but is the seam a future
    **Notion connector** plugs into without reworking the analysis — see Deferred below.
  - `parseProfileResult(text) -> { interests: string[], about: string }` (pure, tolerant; `{}` /
    garbage → `{interests:[], about:""}`).
  - `mergeInterests(existingCsv, picked) -> string` (case-insensitive dedup-append; pure).
- **`web/index.html`** (wiring, inline): `<script src="profile-analyze.js">`; the **Analyze my
  library** button + handler `analyzeLibrary()`; the review panel (chips + editable About box) and
  its `acceptProfile()` / cancel; reuse `esc`, `toast`, the provider dispatch, `imported`/`saved`,
  `save`, `S`.
- **No** `core/*`, endpoint, storage, or feed changes.

## Data-safety & security

- **Read-only on cards;** only writes `S.about`/`S.interests` (settings) via the existing
  non-destructive path. Interests are append-only (de-duped); About you is replaced only with the
  content the user reviewed/edited in the box (which starts from their existing text). Nothing in
  the card store is modified or deleted.
- **Privacy:** the aggregated summary (category/domain/keyword/tag counts) is sent to the user's AI
  provider — same trust model as Enrich/feed (which already send titles/urls + the profile).
- **Bounded cost:** one AI call regardless of library size (aggregation caps the prompt).
- The heavy **data-safety / electron-security reviews are not required** (no Core/endpoint/delete
  path; no new network/IPC/key surface — reuses the in-browser provider dispatch).

## Testing (TDD)

Pure units in `tests/profile-analyze.test.js`:
- `summarizeLibrary`: counts categories/domains/keywords; caps top-N; tolerates missing
  category/url/tags; stopword + short-token filtering on titles.
- `buildProfilePrompt`: includes the summary + asks for the `{interests, about}` JSON shape.
- `parseProfileResult`: plain JSON, fenced JSON, prose-wrapped, garbage → safe empty.
- `mergeInterests`: append, case-insensitive de-dupe, preserves existing, trims separators.
- A small wiring test (like `tests/safety-wiring.test.js`): page loads `profile-analyze.js`, has the
  Analyze button + `analyzeLibrary`, and `acceptProfile` writes `S.interests`/`S.about`.
- `tests/syntax-check.js` + full gate green. Installer version bump at the end.

## Out of scope / deferred

- Changing the feed/Stumble prompts (they already consume the profile).
- A scheduled/auto re-analysis (manual button only — YAGNI).
- Per-category weighting / sliders (just topics + About you for now).
- **Notion connector (explicit NEXT feature, separate spec→plan→build).** The app has no live
  Notion read-integration today (the existing "Notion & Jarvis bridge" is a one-way `saves.json`
  export an external process reads — and a no-op in the Electron build). A future feature would:
  add a Notion integration token in Settings; have the **Core** fetch the user's pages/databases via
  the Notion API (paginated, bounded); aggregate that text into one or more
  `{ label:"Notion", text }` source summaries; and pass them as the `extraSources` arg to
  `buildProfilePrompt` so Notion interests/project items fold into the same analysis + review flow.
  Designing `buildProfilePrompt` to accept `extraSources` now is the only concession this spec makes
  to that future work — no Notion code is built here. That connector gets its own data-safety +
  electron-security review (new external API + token handling).
