# Vision-based title generation — design

## Problem

The 2026-07-24 fix to `generateUniqueTitle()` (commit `9d0fcfa`) correctly
stopped treating boilerplate Facebook descriptions (`"Saved from Facebook"`,
`"From your 'X' Facebook collection"`) as real content — it was feeding that
placeholder text to the AI as if it were the post's actual description,
producing confident-sounding but fabricated titles (the "duplicate-looking
cards" bug). The fix was correct, but its side effect is that **~1,135 real
cards now get no title suggestion at all**: they have no real description,
Facebook blocks the og-tag scrape that would normally backfill one, and the
current pipeline has no other source of signal, so `generateUniqueTitle()`
correctly declines every time.

But these cards aren't actually signal-free. Each one has a captured image
(most are Facebook posts, captured via the extension), and many of those
images contain the post's actual content as visible text (quote-card
screenshots) or a real photo. The gap is that nothing in the pipeline looks
at the image, and nothing extracts the one real piece of metadata already
present in the "boilerplate" description — the user's own collection name
(`"From your 'VR Stuff' Facebook collection"` → `VR Stuff` is real,
user-assigned signal, not fabricated).

## Goals

- For cards with no usable text description, derive an accurate title from
  whatever real signal the card actually has (image content, collection
  name), in order of cost/certainty — cheapest and most certain first.
- Never regress to the hallucination bug: a tier only produces a title when
  it has genuine grounding; weak signal alone (a bare collection name, a
  page slug) is never handed to an AI as if it were enough to invent post
  specifics.
- For OpenRouter and Gemini, let the user pick which vision-capable model
  handles the (more expensive) vision tier, with a visible cost estimate,
  scoped to the Title Issues reconciliation flow — not a global Settings
  change.
- Reuse the existing `generateUniqueTitle()` pipeline (uniqueness/collision
  retry, generic-title rejection, disambiguation) unchanged — only the
  *input signal* changes.

## Non-goals

- No change to `enrichOnOpen`'s free og-tag/description refetch — that stays
  as the first, cheapest attempt at a *real* description, tried before any
  of this ever runs (unchanged: this pipeline only engages when that has
  already failed and the card is still flagged).
- No vision/cost picker for Anthropic, OpenAI, Groq, or Local — those keep
  the "attempt with the configured model, gracefully decline on failure"
  behavior. (Anthropic/OpenAI's flagship and mini models are reliably
  vision-capable already; Groq/Local support is too model-dependent to
  build a picker around, and weren't asked for.)
- No attempt to dynamically detect Gemini vision capability or pricing via
  API — confirmed via Google's own docs that `models.list` exposes neither
  (see Research, below). A small curated, manually-maintained list is used
  instead, matching the existing `OR_MODELS` precedent (`web/index.html:1696`).
- Cost estimates are approximate (a fixed image-token estimate × the
  model's published per-token price), not exact — different providers tile
  images differently. Good enough for picking a model, not a billing
  guarantee.

## Research

- **OpenRouter** `GET https://openrouter.ai/api/v1/models` is public,
  unauthenticated, and returns (live-verified 2026-07-24) per model:
  `architecture.input_modalities` (array; contains `"image"` for
  vision-capable models) and `pricing.prompt`/`pricing.completion` (USD per
  token, as strings). Sufficient for full dynamic discovery + cost.
- **Gemini** `models.list` requires an API key and (per Google's official
  API reference, fetched 2026-07-24) exposes `supportedGenerationMethods`,
  token limits, and sampling params — **no modality or pricing fields**.
  Every current Gemini model (2.0/2.5 Flash, Pro) is natively multimodal, so
  "which models support vision" isn't really in question for Gemini; only
  cost needs a static source.

## Design

### 1. Tiered signal pipeline (replaces the single description-or-nothing
   check in `generateUniqueTitle()`)

Runs in this order, stopping at the first tier that produces a title.
Every tier before the last requires **genuine grounding** — none of them
hand bare weak-context (collection name, page slug) to an AI as the sole
basis for a specific-sounding title. That constraint is the direct lesson
from the hallucination bug and is non-negotiable for this feature.

**Tier 0 — context extraction (free, synchronous, no network).**
Pure function `extractWeakContext(card)` in `web/title-ai.js`:
- `collection`: regex `^From your '(.+)' Facebook collection$` against
  `card.desc` (case-sensitive match to the exact existing boilerplate
  string format written at capture time).
- `pageSlug`: first path segment of a `facebook.com`/`fb.watch` URL,
  excluding a blocklist of non-page path segments (`reel`, `permalink.php`,
  `photo.php`, `watch`, `groups`, `story.php`, `share`, `p`) — a Facebook
  permalink's page/profile name when present, `""` otherwise.
Returns `{collection, pageSlug}` (either may be `""`). This never produces
a title by itself — only supplies weak context to Tiers 1–2, and is the
sole input to Tier 3.

**Tier 1 — OCR-then-text (cheap, most accurate for text-bearing images).**
Most of the flagged cards are quote-card screenshots with the actual post
content rendered as text in the image. Client-side OCR extracts that text
*exactly* — cheaper than a vision call (no image tokens, just a normal text
prompt afterward) and more accurate (no risk of an LLM paraphrasing or
misreading the image, since the words are lifted directly).
- Library: **Tesseract.js**, loaded on demand from a CDN the first time
  it's needed — same lazy-load pattern already used for JSZip
  (`cdnjs.cloudflare.com`, see `CLAUDE.md`'s External Services list). Never
  bundled into the page; zero cost for users who never hit this path.
- Run OCR against the card's resolved image (same resolution helper Tier 2
  uses — see §3). Reject the result unless it clears a minimum bar: **≥15
  non-whitespace characters** across words Tesseract reports at **≥60%
  confidence** (garbage/noise text from photos routinely scores low
  confidence and must not pass through as if it were real content).
- On acceptance, the OCR'd text becomes `description` for the **existing**
  text-only `generateUniqueTitle` flow — `buildTitlePrompt()` gets a new
  `ocr: true` flag so the instruction explicitly says this text was
  OCR'd from an image and may contain minor recognition errors (models
  should treat it as approximate, not verbatim-perfect).
- If Tier 0 found a `collection`, it's appended as one extra context line
  ("This was saved from the user's '<collection>' collection.") — genuine
  supplementary signal, never the sole basis for the title.

**Tier 2 — vision LLM (moderate cost, for images with no legible text).**
Only reached when Tier 1 found no usable text (plain photos: the excavator/
3D-printing/food examples we found have no overlaid text at all) and there
is still no real description.
- Image resolution + downscale (§3), sent as a real multimodal API call
  (§4). `buildTitlePrompt()` gets `hasImage: true` — one instruction line
  telling the model an image is attached, read any legible text in it
  first, otherwise describe what's depicted.
- Same Tier-0 `collection` context line appended when present.
- **Model selection (OpenRouter/Gemini only):** see §2 — the model actually
  used for this call is whatever the user picked in the Title Issues tab's
  picker (default: cheapest available vision-capable option), passed as a
  model override, not a change to the user's global Settings model.
  Anthropic/OpenAI/Groq/Local use the currently configured model as-is.

**Tier 3 — deterministic fallback (free, no AI call, cannot hallucinate).**
Reached only when Tier 1 and Tier 2 both produced nothing (vision call
failed/errored/unsupported, or no image at all) **and** Tier 0 found a
`collection`. Composes a plain, factual label:
`"<collection> — saved from a Facebook collection"` — stating true
collection membership is not a hallucination, unlike inventing what the
specific post says. The template's fixed padding text is chosen so the
*shortest realistic* collection name (a single character) still clears
`isGenericTitle()`'s 25-character floor (`"X — saved from a Facebook
collection"` is 39 chars) — but the composer still runs the result through
`isGenericTitle()` before returning it, same defensive check every other
tier's output gets, so an unexpectedly long/short edge case can never
silently re-flag itself; a result that somehow fails the check falls
through to decline rather than being asserted anyway.
If Tier 0 found no `collection` either, the pipeline declines (returns
`null`, same as today) — a bare `pageSlug` alone is never enough (it says
*who* posted it, not *what* it is).

### 2. Vision model + cost picker (Title Issues tab, OpenRouter/Gemini only)

New UI block in `renderHealthTitles()`, shown only when
`S.provider === "openrouter"` or `S.provider === "gemini"`, above the
Suggest/Apply buttons:

- **OpenRouter:** `web/ai.js` gains `listVisionModels()` — fetches
  `GET /api/v1/models`, filters
  `architecture.input_modalities.includes("image")`, sorts by
  `pricing.prompt` ascending, and shapes each into
  `{id, name, estCostPerCard}`. `estCostPerCard` uses a fixed estimate
  (~1500 image tokens + ~250 prompt + ~20 completion tokens) × the model's
  published per-token price — labeled "~$X.XXXX/card (est.)" in the UI, not
  presented as exact.
- **Gemini:** a small curated constant array (mirroring `OR_MODELS`'s
  shape/comment convention) — `gemini-2.5-flash-lite`, `gemini-2.5-flash`,
  `gemini-2.5-pro` — with per-image pricing manually sourced from Google's
  published rates and the same comment-dated "verified" convention the
  existing `OR_MODELS` list uses, so a future maintainer knows to re-check
  it periodically.
- Selection defaults to the cheapest option; persists only for the current
  Title Issues session (not written to `S`/Settings — this is a per-
  reconciliation choice, not a global default).
- The picked model ID flows into Tier 2's `callAI(..., {model: picked})`
  call as a one-off override.

### 3. Image resolution + downscale (browser-only, shared by Tiers 1 and 2)

New helper `resolveCardImageForAI(card)` in `web/index.html`/`pwa/index.html`:
- Resolves `card.img`: `idb:<id>` → `await Store.ensureImage(id)` then the
  Core service's `/api/img/<id>` URL; `http(s)` → fetch directly.
- Decodes via `createImageBitmap`, downscales via `OffscreenCanvas` to a
  1024px longest edge (same canvas pattern already used by
  `dHashFromDataUrl`, `web/index.html:2629`), re-encodes as JPEG (~0.7
  quality) to bound payload size and API cost.
- Returns `{mediaType: "image/jpeg", base64}` or `null` on any failure
  (missing image, fetch error, decode error) — callers treat `null` as
  "this tier can't run," never as an error to surface.

### 4. Provider payload changes — `web/ai.js`

Every provider caller (`callAnthropic`, `callOpenAI`, `callGemini`,
`callGroq`, `callOpenRouter`, `callLocal`) gains two new optional `opts`
fields, on top of what they take today:

- `opts.image` (`{mediaType, base64}`): when present, builds that
  provider's multimodal payload shape (Anthropic: separate `image` content
  block with `source.media_type`/`source.data`; OpenAI: `input_image` with
  a data-URL; Gemini: `inline_data`; Groq/OpenRouter/Local — all
  OpenAI-chat-completions-shaped — an `image_url` content part with an
  embedded data URL). Absent: byte-for-byte the same payload as today.
- `opts.model` (string): overrides `s.models[provider]` for just this call.
  Absent: today's behavior (uses the configured model) — no change for
  every existing caller.

`listVisionModels()` (OpenRouter only, §2) is a new exported function,
network-based but pure in the sense that it takes no card/settings input
beyond the API call itself.

### 5. `generateUniqueTitle()` orchestration

Becomes a thin tier-dispatcher instead of the current single description-
gate. Each tier is its own testable function (`tryOcrTier`, `tryVisionTier`,
`tryFallbackTier`) so the ordering/short-circuit logic can be unit tested
with injected fake tier implementations — mirroring how existing tests
already inject a fake `callAI` — without needing real OCR or a real image
in Node.

## Error handling

- Any tier's failure (OCR unavailable/low-confidence, image fetch/decode
  failure, vision API error or a provider that silently ignores the image)
  falls through to the next tier. Only Tier 3's absence of a `collection`
  falls through to an actual decline (today's behavior — leave flagged).
- No partial or low-confidence result is ever applied as a title — a tier
  either clears its bar or contributes nothing.

## Testing

- Tier 0 (`extractWeakContext`), Tier 3's deterministic composition (+ its
  `isGenericTitle()` pass check), the tier-dispatch ordering (with injected
  fake tiers), `buildTitlePrompt()`'s new `ocr`/`hasImage` flags, and
  `web/ai.js`'s `opts.image`/`opts.model` payload shapes and
  `listVisionModels()` (stubbed `fetch`, same pattern as `ai-module.test.js`)
  are all pure/mockable and get real Node `assert` tests.
- OCR execution (Tesseract.js) and image fetch/downscale (`createImageBitmap`/
  `OffscreenCanvas`) are browser-only, matching the existing untested-in-
  Node status of `dHashFromDataUrl` and friends — verified manually in the
  browser against real flagged cards, same as the original title-quality
  feature's manual-verification task.

## Privacy

Confirmed with the user (2026-07-24): sending a card's actual captured
image to the configured AI provider is acceptable, on the same trust basis
as today's title/description/URL text already going to that provider.
