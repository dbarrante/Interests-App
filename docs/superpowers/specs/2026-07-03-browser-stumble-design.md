# Browser Stumble — StumbleUpon-style discovery in the browser

**Date:** 2026-07-03
**Status:** Design — awaiting approval
**Author:** Claude (with Dave)

## 1. Goal

Turn the Chrome extension into a faithful **StumbleUpon** clone that browses *real
external web pages in the browser* (not inside the Electron app), powered by the app's
existing AI + strict-validation discovery engine.

Left-click the extension icon → land on one fresh, verified page in a single reused tab,
with an on-page overlay to rate it (👍/👎), **Save** it, or **Stumble again**. Ratings and
a chosen set of **interests** train what comes next, using the recommender the app already
has.

This is a **user-facing release**: it touches the extension, the app renderer, and Core.

## 2. Confirmed decisions

| Decision | Choice |
|---|---|
| Left-click target | Icon → Stumble directly (popup removed) |
| Tab behavior | **Reuse the same tab** on every stumble |
| Freshness | **Fresh only** — pages validated within the app's 30-min TTL |
| Overlay | Floating bar on the page: **👍 / 👎 / Save / Stumble again** |
| Interests | StumbleUpon-style topic picker on the **extension Options page** |
| Fidelity | **Full learning** — 👍/👎 feed the app's like/hide state; interests drive on-demand AI discovery |
| Empty/app-closed | Gentle notification; nothing destructive |
| Following/sharing | **Omitted** — this is a private personal app, no social graph |

## 3. What StumbleUpon did (verified research, 2026-07-03)

- One **"Stumble!"** button served *one* semi-random full external page matched to your
  interests — "like a random web search engine." Not a feed, not an in-app reader.
- Loop: **Stumble → land on page → 👍/👎 → repeat.** A "Stumble After Rating" option
  auto-advanced the moment you rated.
- **Interests/topics** seeded recommendations; content reflected **user taste**, not a crawl.
- **👍 = a "Like"** (compared to a Facebook Like) that shaped future recommendations; 👎
  suppressed similar.
- **Save/favorites** kept a page.
- Confirmed by modern clones (StumbleUponAwesome, Cloudhiker, Wiby): the model is the
  single-button loop over curated/opened real sites.

Sources: en.wikipedia.org/wiki/StumbleUpon, socialmediaexaminer.com/stumbleupon-guide,
elirose.com StumbleUpon guide, github.com/basharovV/StumbleUponAwesome, cloudhiker.net,
wiby.me/about/guide.html. (23 claims verified 3-0/2-1 across 18 sources.)

## 4. Why the app can do the "learning" today

`buildPrompt("stumble")` in `web/index.html` already turns app state into a personalized
prompt. It already consumes:

- `likes` → *"THUMBS-UP liked pages (strong positive signal)"*
- `hidden` → *"DISMISSED as 'not for me' (avoid similar)"*
- `saved`, `clicks`, and per-category weights `S.weights[c.key]`

So 👍/👎 from the browser only need to reach `likes` / `hidden` and the **next** AI stumble
automatically weights them. No new recommender is built.

## 5. Architecture

Three parts. **The extension never writes shared app data (spool/likes/hidden/cards)
directly** — everything flows through small Core mailboxes that the renderer drains, the
same safe pattern already used by `capture-request` / `batch-state` / `drainCaptures`.

```
Chrome extension (SW + overlay + Options)
        │  loopback HTTP (ports 3456–3465)
        ▼
Core mailboxes (core/server.js, loopback-only, no outbound fetch)
   • GET  /api/categories            → category list for the picker
   • POST /api/bstumble/request      → extension asks for pages in {interests}
   • GET  /api/bstumble/request      → renderer reads pending request
   • POST /api/bstumble/results      → renderer delivers verified pages
   • GET  /api/bstumble/results      → extension pops verified pages (clears them)
   • POST /api/bstumble/feedback     → extension posts 👍/👎 votes
   • GET  /api/bstumble/feedback     → renderer drains votes (clears them)
        │
        ▼
App renderer (web/index.html) — the ONLY place the AI runs and app state is written
   • publishes CATS → /api/categories at boot
   • pollBrowserStumble() every ~3s (gated on _booted):
       – drains a request → runs interest-scoped stumbleFetch → posts survivors to results
       – drains feedback  → likes.push / hidden.push → persistAll()
```

### 5.1 The stumble loop (extension)

On icon left-click (`chrome.action.onClicked`):

1. Find the app port (existing `findAppPort`). If unreachable → notify
   *"Open the Interests app to Stumble."* Stop.
2. Use a **local buffer** (`chrome.storage.session`) of already-fetched pages. If empty,
   `GET /api/bstumble/results` (which returns **and clears** the Core queue) and refill the
   buffer. Opening pops one page from this buffer, so multi-page deliveries are never
   discarded.
3. Always `POST /api/bstumble/request {interests, nonce}` so the renderer tops up the
   browser results in the background for the next click.
4. If the buffer was empty *and* results returned nothing → notify *"Finding you something…
   click again in a moment."* (First cold click only; subsequent clicks are instant.)
5. Open the page in the **reused stumble tab**: if the tracked tab id still exists,
   `chrome.tabs.update(tabId,{url})`; else `chrome.tabs.create({url,active:true})` and
   remember the id (in `chrome.storage.session`).
6. On `webNavigation.onCompleted` for that tab, inject the overlay content script.

Freshness is enforced app-side (only pages within the 30-min TTL are ever delivered to
results), so the extension does not re-implement validation.

### 5.2 The overlay (injected content script)

A small fixed-position bar (high z-index, dark, unobtrusive, dismissible) injected onto the
stumbled page via `chrome.scripting.executeScript` (host permission `<all_urls>` already
granted). Buttons message the SW:

- **👍 Like** → `POST /api/bstumble/feedback {url,title,category,vote:1}` → advance to next.
- **👎 Not for me** → `…{vote:-1}` → advance to next.
- **Save** → existing `clipCurrentPage` flow (adds a Saved card). Stays on the page.
- **Stumble again** → advance without voting.

"Advance" = re-run the loop (§5.1) reusing the same tab. Rating auto-advances, matching
StumbleUpon's "Stumble After Rating"; **Save** deliberately stays so you can keep reading
what you saved.

### 5.3 Interests picker (Options page)

New `options.html` / `options.js`, opened via right-click icon → Options (or
chrome://extensions → Details → Extension options).

- Fetches the category list from `GET /api/categories` (renderer publishes `CATS`).
- Shows each category as a checkbox ("interests").
- Saved selection lives in `chrome.storage.local` and is sent as `interests` with every
  `/api/bstumble/request`. Empty selection = all interests (default).

### 5.4 Renderer wiring (web/index.html)

- At boot (after `_booted`): publish `CATS` (key+name) to KV `ia_cats` so `/api/categories`
  can serve it.
- Add `pollBrowserStumble()` on a ~3s interval (mirrors `setInterval(drainCaptures,3000)`),
  gated on `_booted`:
  - **Request:** if a pending `/api/bstumble/request` exists, clear it, then run a
    stumble fetch **scoped to the requested interests** and `POST` the verified survivors to
    `/api/bstumble/results`. Scoping = `buildPrompt("stumble")` gains an optional
    `interestKeys` argument that filters `active` categories to the requested set (falls
    back to all when empty). Reuses the existing `parseItems → dropAlreadySaved →
    validateItems → rankFilter` pipeline unchanged, so **strict validation is preserved**.
  - **Feedback:** drain `/api/bstumble/feedback`; for each vote apply the *same* code paths
    the in-app UI uses — 👍 → `likes.push({title,category,ts})`; 👎 →
    `hidden.push({title,category,ts})` (and record the URL so it is excluded going forward,
    consistent with `dropAlreadySaved`/`shown`). Then `persistAll()` (renderer-owned,
    `asOf`-safe write). The next AI stumble automatically weights these.

### 5.5 Core mailboxes (core/server.js)

Six small loopback handlers added **after** the existing KV routes, following the
`capture-request` in-memory-mailbox pattern (no outbound network, no SSRF surface):

- `GET /api/categories` → `{categories: <ia_cats KV>}`.
- `POST /api/bstumble/request {request}` / `GET …` → set/read a single pending request.
- `POST /api/bstumble/results {items}` (append, cap ~20) / `GET …` (return **and clear**).
- `POST /api/bstumble/feedback {vote}` (append, cap ~50) / `GET …` (return **and clear**).

Middleware ordering is preserved; these are added in the same block as the other mailbox
routes, behind the existing host-allowlist/Origin guards that the extension already passes.

## 6. Invariants preserved

- Extension never writes `cards`/`saved`/`likes`/`hidden`/`spool` KV directly → no `asOf`
  or mass-delete-guard interaction; the renderer performs all app-state writes via
  `persistAll()`.
- `_booted` gate respected before any renderer drain acts.
- Sync tombstones untouched; frozen `img`/`image` wire fields untouched.
- Core stays `127.0.0.1`-only and SSRF-guarded; new routes make no outbound requests. The
  only outbound calls remain the renderer's existing AI + `check-content` validation.
- Strict live-page/`isVerifiedDiscoveryResult` validation is **unchanged** — browser
  results come only from the same validated pipeline.

## 7. Files touched

**Extension**
- `manifest.json` — remove `default_popup`; add `options_page`; add `action.onClicked`;
  bump **4.48 → 4.49**. (`scripting`, `tabs`, `notifications`, `<all_urls>` already present.)
- `background.js` — icon-click loop; overlay injection; feedback/request/results calls;
  add right-click **"Remove from Interests"** (the popup's Remove action's new home; Clip is
  already the existing "Save to Interests").
- `overlay.js` (new) — the injected on-page bar.
- `options.html` / `options.js` (new) — interests picker.
- `popup.html` / `popup.js` — left on disk, unreferenced (easy revert).

**App**
- `web/index.html` — publish `CATS`; `pollBrowserStumble()`; `buildPrompt` optional
  `interestKeys`; interest-scoped fetch helper.
- `core/server.js` — six mailbox routes + `/api/categories`.
- `package.json` — version bump (new installer).

## 8. Testing

- `tests/bstumble-mailbox.test.js` (new) — mount `createServer()` on port 0; assert the
  request/results/feedback mailboxes set/return/clear correctly and cap their queues.
- `tests/ai-module.test.js` / a buildPrompt test — assert `interestKeys` filters `active`
  categories and empty = all; assert the grounded `{webSearch:true}` call is unchanged.
- Feedback wiring — assert (pure/trace) that a 👍 vote maps to a `likes` entry and 👎 to a
  `hidden` entry.
- `node tests/syntax-check.js` for the `web/index.html` inline scripts.
- Full `npm test` must print `ALL TEST FILES PASSED`.
- Manual: load unpacked extension, pick interests, stumble, rate, save, confirm same-tab
  reuse and that a later in-app Stumble reflects the 👍/👎.

## 9. Release

Feature branch → syntax gate → targeted tests → `npm test` green → bump `package.json` and
`manifest.json` → update `docs/BACKLOG.md` → commit → fast-forward `master` → push →
`npm run dist`. Dave installs the new `.exe` (verify via **?**) **and** reloads the
extension in Chrome.

## 10. Explicitly out of scope (YAGNI)

- Following, sharing, social profiles, reviews/comments.
- URL submission to a shared index (single-user app).
- Interests influencing anything beyond the stumble prompt.
- Honoring the in-app category filter (`ia_fcat`) from the browser — browser interests are
  independent and live in the extension.

## 11. Open UX question for spec review

Rating auto-advances (👍/👎 → next page). If you'd rather thumbs just mark the page and
*stay* (only "Stumble again" advances), say so and I'll flip it.
