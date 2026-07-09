# Stumble ← News integration — design

**Date:** 2026-07-09
**Status:** Approved (brainstorm), pending spec review → plan
**Author:** Claude (with Dave)

## Goal

Bring current **news stories matched to the user's specific interests** into the Stumble
discovery surface, in **two complementary ways**:

1. **Intermixed** — the normal (AI "Web") Stumble deck occasionally blends in a fresh news
   card (default on, user-toggleable).
2. **Dedicated news-only** — a **"📰 News"** pill in the Stumble sidebar switches the deck to
   news-only, filtered by the user's **specific interest keywords**.

News is sourced from **free Google News RSS** (no API key, no per-use cost). News-only mode
makes **zero AI calls**; intermix adds free news cards to a deal that was already running.

## Background / current state

- Stumble is the app's home surface (`web/index.html`). One AI call (`buildPrompt("stumble")`
  → `callAI(..., {webSearch:true})`) returns ~12 candidate items `{title, url, category,
  source, image, benefit}`; they pass `dropAlreadySaved` → `validateItems` (tier-1 dead-link +
  tier-2 soft-404/challenge/title-mismatch) → `rankFilter`, then fill `spool`. A "deal" of
  N cards (1/2/4, `stSize`) is dealt into `stDeal` and rendered by `stCardHTML`.
- The Stumble **left sidebar** (added v1.12.18) shows **category** filter pills via
  `stCatSideHTML()`, gated by `stSidebarOn()` (≥760px), wrapped beside the content by
  `stWrap()`. `setFilter(key)` sets `filterCat` and re-renders.
- Filters already respected across discovery: the permanent `disliked` 👎 blocklist and the
  5-day `seenAt` "already seen" suppression, both enforced in `dropAlreadySaved`.
- `S.interests` holds the user's free-text, comma-separated interests (e.g.
  "woodworking, generative art, synths, natural history"). These are distinct from the broad
  `CATS` categories.
- The renderer talks to the local **Core service** (Express, loopback-only, Origin-guarded) at
  the same origin; Core is the only place cross-origin outbound fetches happen (see
  `core/guardedfetch.js`, `core/contentcheck.js`). Browser-side cross-origin fetch to news
  feeds is impossible (CORS), so news fetching MUST live in Core.

## User-facing behavior

### The sidebar
The Stumble sidebar always shows a **"📰 News"** toggle pill at the top. Below it:
- **Discovery mode** (News off): the existing **category** pills (`stCatSideHTML`) — unchanged.
- **News-only mode** (News on): the user's **specific interests** as pills, plus **"All"**.
  Clicking an interest (e.g. "woodworking") filters news to that keyword; "All" blends news
  across every interest.

Clicking "📰 News" toggles news-only mode on/off and re-fetches accordingly.

### Intermix
A Settings toggle **"Mix fresh news into Stumble"** (default **on**). When on, discovery deals
blend in news cards at roughly a **1-in-4** ratio (matched to the user's interests). When off,
discovery is news-free. Intermix has no effect while news-only mode is active (that deck is
already all news).

### Cards
News cards reuse `stCardHTML` — headline, publisher, "how long ago", and the
👍/👎/Save/Open actions behave identically (Save → Saved library, 👎 → permanent blocklist,
5-day seen suppression applies). A subtle **📰 badge** marks a news card so it is
distinguishable from a discovery card in the blended deck. The card's benefit/subtitle line
reads e.g. **"From The Verge · 3h ago"**.

### Empty / error states
- **No interests set:** News mode shows a friendly nudge ("Add a few interests in Settings to
  get news") instead of an empty deck.
- **Feed down / offline:** news fetch fails quietly with a toast; discovery still works.

## Architecture

### New: `core/news.js` (free news engine)
Two units, cleanly separable:

- `parseNewsRss(xml) → [{ title, url, source, ts }]` — **pure** function. Parses Google News
  RSS `<item>` blocks (dependency-free string/regex parse, consistent with the app's
  no-native-dep ethos): extracts `<title>`, `<link>`, `<pubDate>` (→ `ts` via `Date.parse`),
  and the `<source>` publisher. Decodes CDATA + HTML entities. Strips the trailing
  " - Publisher" that Google appends to headlines when it matches the `<source>`. Fully
  unit-testable from a fixture, no network.
- `fetchNews(interests, opts) → Promise<[{ title, url, source, ts, interest }]>` — for each
  interest term, builds the fixed-host feed URL
  `https://news.google.com/rss/search?q=<encodeURIComponent(interest)>%20when:7d&hl=en-US&gl=US&ceid=US:en`,
  fetches it through the app's guarded/timeout fetch, `parseNewsRss`, tags each item with its
  `interest`, caps per-interest (~10), then **merges → dedupes (by normalized url + title) →
  sorts newest-first**. Bounded concurrency; a single feed failure is caught and skipped
  (never rejects the batch). `opts`: `{ limit, perInterest, whenDays }`. The fetch function is
  **injectable** (default = the guarded fetch) so tests never hit the real network/DNS.

**SSRF note:** the feed host is fixed (`news.google.com`); only the query string is
user-derived (URL-encoded). No user-controlled host — safe. Still routed through the guarded
fetch for timeouts/consistency.

### New Core route (`core/server.js`)
`GET /api/news?interests=<comma-list>&limit=<n>` — loopback + Origin-guarded by the existing
middleware. Parses `interests`, **caps the count** (max ~8 interests, max ~40 items — logged,
not silently truncated), calls `fetchNews`, returns `{ ok:true, now:<ms>, items:[...] }`.
Errors → `{ ok:false, error }` with a safe message (no stack leak).

### Renderer (`web/index.html`)
- `interestList()` — parse `S.interests` → trimmed, de-duped, non-empty array (the news tags).
- **State:**
  - `S.newsMix` (bool, default `true`) — the Settings intermix toggle (part of `ia_settings`,
    syncs normally; it's a preference, not a secret).
  - `stNewsOnly` (bool, persisted `ia_stnewsonly` via `save`) — news-only mode active.
  - `filterInterest` (string, persisted `ia_finterest`) — active interest in news-only mode
    ("" = All). `filterCat` is untouched and still drives discovery.
- **Sidebar:** a single `stSideHTML()` that renders the "📰 News" toggle pill (active styling
  when `stNewsOnly`) followed by either the category pills (discovery) or the interest pills
  (news-only). `renderStumble`/`stWrap` call it. Handlers: `toggleNewsOnly()` (flip + persist +
  re-render + fetch), `setNewsInterest(k)` (set `filterInterest` + persist + re-render + fetch).
- **Fetch path:** `stumbleFetch()` branches:
  - `stNewsOnly` → `newsFetch()`: `Store.news(activeInterests)` (all interests when
    `filterInterest===""`, else the one) → shape items into the stumble item form
    `{ title, url, source, category:interest, image:null, benefit:"From <source> · <ago>",
    isNews:true }` → `dropAlreadySaved` (dedupe vs saved + `disliked` + `seenAt`) → spool.
    **Skips `validateItems`** (see below).
  - else (discovery) → existing AI path; **additionally**, if `S.newsMix`, fetch a small batch
    of news (all interests), shape as above, and **interleave** into the spool at ~1:3 so the
    dealt deck is ~1-in-4 news.
- **Card:** `stCardHTML` gains an `it.isNews` branch for the 📰 badge; `image:null` already
  renders the existing placeholder.
- **Settings:** a "Mix fresh news into Stumble" checkbox wired like the other `S.*` toggles
  (`renderSettings` populate + `onchange` → `save("settings", S)`).

### Storage adapter (`web/storage.js`)
`Store.news(interests) → GET /api/news?...` returning `{ok, now, items}` — thin wrapper for
consistency with the rest of the Store API.

## Validation & filtering rules (news)

- News links are fresh and real, so news items **skip `validateItems`** entirely — in
  particular the tier-2 **title-mismatch** check, which false-flags news (RSS headline ≠ page
  `<title>`). This keeps news fast and avoids dropping good links.
- News items **still** pass through `dropAlreadySaved`: deduped against the Saved library,
  filtered by the permanent `disliked` 👎 blocklist, and suppressed by the 5-day `seenAt`
  window (a news card is stamped `markSeen` when dealt/opened, same as discovery).

## Cost

- News fetch is **free** (Core → Google News RSS, no key).
- **News-only mode:** zero AI calls.
- **Intermix:** the discovery AI call runs as it does today; news cards are free additions —
  no extra AI spend.

## Testing (no real network — repo rule)

- `tests/news-parse.test.js` — `parseNewsRss` over a fixture Google News RSS XML: asserts
  title/publisher/date/url extraction, CDATA + entity decode, and the " - Publisher" strip.
- `tests/news-fetch.test.js` — `fetchNews` with an **injected stub fetch**: per-interest
  tagging, dedupe, newest-first sort, per-interest + total caps, and one-feed-failure
  resilience.
- `tests/news-route.test.js` — `GET /api/news` with `core/news` stubbed: `{ok, items}` shape,
  interest-count cap, error path returns a safe message.
- `tests/stumble-news-wiring.test.js` — renderer source-assertions: the 📰 News toggle pill,
  interest sidebar in news-only mode vs category sidebar in discovery, `S.newsMix` default +
  Settings wiring, the intermix gate, news items skipping `validateItems`, and the `isNews`
  badge.

## Files touched

- **NEW** `core/news.js` — `parseNewsRss` + `fetchNews`.
- `core/server.js` — `GET /api/news` route.
- `web/index.html` — `interestList`, sidebar (`stSideHTML` + News toggle + interest pills),
  `toggleNewsOnly`/`setNewsInterest`, `newsFetch`, `stumbleFetch` branch + intermix,
  `stCardHTML` news badge, Settings "Mix fresh news into Stumble" toggle, new state/persist.
- `web/storage.js` — `Store.news`.
- **NEW** tests as above.

## Out of scope / deferred

- **og:image enrichment** of news cards (news cards use the placeholder for now; the existing
  capture pipeline can enrich on Save later).
- Non-English / region tuning of the feed (defaults to `en-US`); revisit if needed.
- A per-interest "news volume" control and scheduled/background news prefetch.

## Open implementation detail (contained, no design impact)

Google News RSS is the primary free source. Its item links route through a Google redirect
(they open to the publisher correctly). If, in testing, those links prove unreliable for the
in-app open/Save flow, the fallback — swap to **Bing News RSS** (`https://www.bing.com/news/
search?q=<q>&format=rss`) or resolve the final publisher URL — is fully contained inside
`core/news.js` with no UI or contract change.
