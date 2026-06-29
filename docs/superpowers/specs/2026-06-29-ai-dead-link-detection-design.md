# AI-assisted dead-link detection ("soft-dead" finder)

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

The current dead-link checker ([core/linkcheck.js](../../../core/linkcheck.js)) is deliberately
conservative: a link is "dead" only on hard HTTP signals (404 / 410 / 451 / DNS failure).
Anything that returns `200 OK` is treated as **alive** — so it misses **soft-dead** links:

- removed articles / "Sorry, this page isn't available"
- parked or for-sale domains
- products / listings that say "no longer available" / "this listing has ended"
- links that silently redirect to the site's generic homepage

These are exactly the links the existing sweep can't catch. This feature adds a content-aware
tier that uses the user's already-configured AI to judge whether a 200-OK page is actually dead.

## Scope

**In scope:** non-social web links (articles, blogs, recipes, shops, news) where a server-side
fetch retrieves the *real* page.

**Out of scope (and why):**

- **Social posts** (Instagram / Facebook / YouTube / Threads). A server-side fetch hits a
  login/consent wall and gets a generic page, not the post — the AI couldn't tell a deleted post
  from a live one. These stay on the existing skip-list. Reading logged-in social content would
  require the capture extension and is noted as a *separate future feature*, not built here.
- **"Keep anyway" flag** (so a kept dead link stops re-appearing each sweep). Deferred — tracked
  in the backlog, not in this spec.

## Approach: three tiers, cheap → paid

1. **HTTP check (free, existing).** `linkcheck.checkChunk` runs first, unchanged. Hard-dead →
   review list. Social → skipped. Only non-social links classified `alive`/`unknown` continue.

2. **Content heuristics (free, server-side, NEW).** For each continuing link, the Core does a
   real page GET (not just HEAD) and extracts: **final URL after redirects**, page **title**, and a
   short **text snippet**. Free rules then flag *suspects*:
   - title/text matches a known dead phrase ("page not found", "no longer available",
     "this listing has ended", "404", "doesn't exist", etc.)
   - the link redirected from a deep path to the site **homepage** (path became `/`)
   - the page body is **near-empty**

   Each result carries its evidence (title, snippet, final URL) and a human-readable reason.
   Most dead pages are caught here for **$0**.

3. **AI verdict (paid, user's key, only on suspects).** Only flagged-suspect links go to the
   user's existing AI layer (`callAnthropic` / `callOpenAI` / … in
   [web/index.html](../../../web/index.html), ~line 1245). Compact prompt: title + snippet + URL →
   strict JSON `{dead: boolean, reason: string}`. AI-confirmed-dead links join the **existing Groom
   dead-link review modal**, annotated with the AI's reason. **Nothing is ever auto-deleted.**

## Where each piece runs

- **Fetch + heuristics:** Core (server-side), behind the existing SSRF guard
  (`linkcheck.isProbableHost`). The user's API key is **never** sent to the Core.
- **AI call:** the browser, with the user's key — same as today's Enrich/categorize.
- **Verdicts → review modal:** the browser, reusing the existing `openDeadReview` /
  `applyDeadRemoval` backup-first removal path.

## Components

### Server: `core/contentcheck.js` (new)

Pure, independently testable functions plus one network probe:

- `extractTitle(html) -> string` — pure.
- `extractText(html, maxChars) -> string` — strip tags/scripts, collapse whitespace, truncate. Pure.
- `DEAD_PHRASES: string[]` — curated list (English v1; multilingual is a noted limitation).
- `classifyContent({ originalUrl, finalUrl, status, title, text }) -> { verdict, reason, signals }`
  where `verdict ∈ {"suspect","likely-alive"}`. Pure — this is the heuristic core.
- `fetchContent(url, opts) -> { finalUrl, status, title, snippet }` — GET with: SSRF guard
  (reuse `isProbableHost` per redirect hop), timeout (default 8s, cap 20s), **response size cap**
  (e.g. 256 KB — stop reading the body past the cap), `Connection: close`. Reuses the
  manual-redirect + hop-limit pattern already in `linkcheck.probeUrl`.

### Server: endpoint `POST /api/check-content` (new, in `core/server.js`)

- Body `{ items: [{id, url}], timeoutMs? }`; items capped at **200** (mirrors `/api/check-links`).
- Skips non-probable / social URLs without a request (reuse `isSkippedHost` + `isProbableHost`).
- Returns `{ results: [{ id, finalUrl, title, snippet, verdict, reason }] }`.
- Read-only. No deletion, no writes to the store.

### Browser: extend `checkDeadLinks()` ([web/index.html](../../../web/index.html) ~3642)

New pipeline after the existing HTTP pass:

1. Collect non-social candidates the HTTP pass left as `alive`/`unknown`.
2. Call `/api/check-content` in chunks (reuse the existing chunking + `_deadStop` stop pattern and
   the tap-to-stop toast).
3. Gather `verdict === "suspect"` items (with title/snippet/finalUrl).
4. **Preview + consent before any AI spend:** show "N links checked, M look suspicious — ask your
   AI to confirm? (uses your API key)". Proceed only on confirm.
5. For each suspect, up to a **hard cap** (`AI_DEAD_CAP`, default 200): call the configured AI via
   `buildDeadCheckPrompt` → `parseDeadVerdict`. If the cap is hit, process the first N and **tell
   the user the rest were skipped** (no silent truncation).
6. AI-confirmed-dead items are added to `_deadList` with `aiReason` and a Wayback link, then
   `openDeadReview(...)`.

New pure helpers (unit-testable):

- `buildDeadCheckPrompt({ title, snippet, url }) -> string`
- `parseDeadVerdict(aiText) -> { dead: boolean, reason: string }` — tolerant of code fences and
  surrounding prose; defaults to `{dead:false}` if it can't parse (conservative: never flag on a
  garbled reply).
- `waybackUrl(url) -> string` — `https://web.archive.org/web/2/<encoded url>` (latest snapshot;
  no key, no extra request during the sweep).

### Review modal changes ([web/index.html](../../../web/index.html) ~3669)

- `deadRowHTML` distinguishes **"hard dead (404 / gone)"** from **"AI: content removed — <reason>"**
  in the badge/reason line.
- AI-confirmed rows show a **"View archived copy"** link (`waybackUrl`) — Wayback recovery (extra A).
- Removal still goes through the unchanged `applyDeadRemoval` (snapshot-before-destructive → bulk
  replace). Default checkbox state for AI-flagged rows: **unchecked** is safer than hard-404 rows
  (AI is a judgment call) — to be confirmed in the plan.

## Data-safety & security

- **Read-only detection.** Routes to the review modal; the user decides every removal; removals
  reuse the existing backup-first path. No auto-delete.
- **Minimal data to the AI:** only a link's title, text snippet, and URL — never the user's library.
- **SSRF:** the new full-page GET reuses `isProbableHost` on every redirect hop; private/loopback/
  link-local/metadata hosts are never fetched.
- **Resource bounds:** response size cap, request timeout, item cap (200/req), concurrency ≤ 8.
- **Bounded & stoppable (hard rule):** manual trigger; preview before spend; Stop aborts mid-sweep;
  `AI_DEAD_CAP` ceilings the paid calls; nothing runs unattended.

## Testing (TDD)

Pure units (no network):
- `classifyContent`: dead-phrase hit, redirect-to-homepage, near-empty body, clean live page →
  `likely-alive`; non-social filtering.
- `extractTitle` / `extractText`: tag stripping, truncation, missing title.
- `buildDeadCheckPrompt` / `parseDeadVerdict`: well-formed JSON, fenced JSON, prose-wrapped, garbled
  → safe default.
- `waybackUrl`: correct encoding.

Integration:
- `/api/check-content` with an **injected fetch** (no real DNS/network — per the project's test
  rule): suspect vs alive vs skipped(social) routing; item cap; SSRF rejection.

Then run **data-safety-reviewer** + **electron-security-reviewer** before shipping (new external GET
/ SSRF surface; content-size cap; confirm the key never reaches the Core).

## Known limitations (v1)

- Dead-phrase list is English-first; non-English dead pages may slip to the AI tier or be missed.
- Some custom error pages return 200 with no dead phrase and a non-trivial body — the AI tier is the
  backstop, but coverage isn't guaranteed.
- Social posts are out of scope (login wall) — covered above.

## Out of scope / deferred

- "Keep anyway" flag (backlog).
- Reading logged-in social content via the extension (separate future feature).
- A free third-party "is this URL dead" service — none exists that reliably answers soft-404;
  Wayback is used only for *recovery* of confirmed-dead links, not detection.
