# Interests App — Backlog / To-Do

A running list of requested features and deferred items. Each entry has enough context to pick up cold
(brainstorm → spec → plan → build when started). Newest requests at the top.

## Investigate 2026-07-16 (from live sync debugging)

- [ ] **Root-cause the desktop's mass phantom updatedAt re-stamp.** On 2026-07-16 ~6,600 of 6,673 cards got `updatedAt` bumped with NO content change (only 69 cards genuinely differed — the 7/15 image repairs). Every peer then treated the whole library as newer (full re-merge; before the v27 size-reuse fix, also a full ~5,600-image re-download per device). Suspects: a full-array `Store.putCards` where the `data` JSON's key order/shape changed across the v1.12.21→22 boundary (cardSig compares the raw data string), or a link/content/safety-check wave stamping `lc`/`sb` into every card. Find the trigger and either make cardSig shape-insensitive (stable-stringify) or exclude check-freshness stamps from the content signature. The v27 size-reuse fix caps the blast radius, but phantom stamps still force full snapshot re-merges fleet-wide.

## Requested 2026-07-14 (Dave)

- [ ] **Clear message when out of AI tokens/credits for Stumble.** When an AI-search Stumble call fails because the configured provider account is out of tokens/credits (not a generic network/API error), show a specific, actionable message — e.g. "Your [provider] account is out of credits — add funds or switch models in Settings" — instead of whatever generic failure text shows today. Needs a brainstorm: how to detect this specifically (provider error codes/messages vary — OpenAI/OpenRouter/Anthropic/Gemini each signal insufficient-balance differently) vs. other failure modes (rate limit, invalid key, network), and where the message surfaces (toast vs. inline in the Stumble empty state).

## v1.12.23 — Sync skip-work optimization (app 1.12.23)
- **A nothing-changed sync now costs seconds, not minutes.** Watermark + signature skipping on both sides (spec `docs/superpowers/specs/2026-07-16-sync-skip-optimization-design.md`): per-peer `publishedAt` watermarks skip unchanged peers' multi-MB snapshot downloads/parses and their images-folder listings (meta.json — written LAST, the torn-write marker — is the proof of no change); a `contentSignature` over cheap aggregates (counts + max updatedAt/deletedAt + settings stamp, `core/merge.js` + verbatim `pwa/merge.js`, desktop aggregates via SQL `db.signatureAggregates`) skips the entire publish when content is unchanged AND the last publish was clean; the PWA additionally caches its own published image ids (`_pwa_published_imgids`), replacing the every-cycle ~5,700-entry folder pagination.
- **Safety bias throughout:** watermarks advance ONLY after a clean cycle (desktop: zero deferred upserts + backup ok; PWA: zero image failures + zero partial peer reads) so deferrals always re-read next cycle; any kv error/missing memory ⇒ full behavior; upload failures now counted (`uploadFailures`, previously vanished into console.error) and gate the clean flag. Old app versions interoperate unchanged (they just stay slow themselves).
- New result fields `peersSkipped`/`publishSkipped` flow into the persisted last-sync result for diagnosability. Tests: `merge-signature` (dual-impl), `sync-skip` (desktop e2e incl. deferral/watermark/heal), `pwa-sync-skip` (source-scan). Built subagent-driven (plan `docs/superpowers/plans/2026-07-16-sync-skip-optimization.md`).

## v1.12.22 — Sync reliability v2: auth resilience, PWA auto-sync, API-key sync (app 1.12.22)
- **"Dropbox keeps disconnecting" fixed.** `pwa/oauth.js` no longer wipes the long-lived refresh token on transient failures: token refresh disconnects ONLY on a definitive rejection (no refresh token on file, or HTTP 400/401 `invalid_grant` from the token endpoint) — a 429/5xx/network blip at the token endpoint now surfaces as a retryable failure with tokens intact. Every Dropbox call resolves a fresh token per call (`resolveToken`) and, on a 401, refreshes once through a single-flight `sharedRefreshAccessToken` and retries exactly once (`dbxAuthedFetch`) — so iOS suspending the PWA mid-sync past the ~4h access-token lifetime no longer nukes the connection. Signatures unchanged; all five entry points (`dbxApiCall`/`dbxDownload`/`dbxDownloadBinary`/`dbxUpload`/`getCurrentAccount`) route through the choke point.
- **PWA auto-sync.** The iPad/iPhone app now syncs automatically: on app open (after boot), on returning to the foreground, and every 15 minutes while open (5-minute cooldown between auto runs). One `_syncInFlight` guard is shared with the manual "Sync now" button so cycles never overlap. Auto-merged changes show the "✨ Updates synced — tap to refresh" toast (never a forced reload); an expired connection toasts "reconnect in Settings" once per disconnect. `syncNowClick` stays byte-identical between web/pwa (ux-loop06 parity).
- **API keys + OPR key now sync** (user decision 2026-07-16: plaintext inside the user's own Dropbox). Publish keeps `keys`/`oprKey` in the settings blob; apply uses the new pure `mergeSyncedSettings` (core/merge.js, copied verbatim to pwa/merge.js): incoming wins per provider, local-only keys survive, empty/garbage incoming values never clobber, and `updateToken` (desktop GitHub credential) never travels or gets overwritten. Back-compat: older peers' keyless snapshots lose nothing (union merge).
- **Tests:** new `merge-settings` (17 cases, both merge copies + verbatim-copy lock), `pwa-oauth-authretry` (functional, eval'd with shimmed localStorage), `pwa-autosync-wiring`, `pwa-sync-settings-wiring`; rewritten `sync-settings` (union-merge + e2e A→B keys travel, updateToken never), updated `pwa-oauth-classify`. Spec `docs/superpowers/specs/2026-07-16-sync-auth-keys-design.md`, plan `docs/superpowers/plans/2026-07-16-sync-auth-keys.md`.

## v1.12.19 — News stories in Stumble (intermix + dedicated news-only) (app 1.12.19)
- **Interest-matched news is now part of Stumble, two ways:** (1) **intermixed** into the normal deck (~1-in-4) via a default-on Settings toggle **"Mix fresh news into Stumble"**; (2) **dedicated news-only** via a **📰 News** pill at the top of the Stumble sidebar — when active the sidebar swaps from categories to **your specific interest keywords** (from `S.interests`), and each dealt card is a current news story for the selected interest ("All" = across everything).
- **Free & no-AI:** news comes from **Google News RSS** (no key, no per-use cost). News-only mode makes **zero AI calls**; intermix adds free news cards to a deal that was already running. Only "Web" discovery uses the paid AI search.
- **New `core/news.js`** — `parseNewsRss(xml)` (dependency-free parser: title/link/publisher/date, entity+CDATA decode, strips " - Publisher") + `fetchNews(interests, opts)` (per-interest fetch via `core/guardedfetch`, tag/dedupe/sort-newest/cap, one-feed-failure resilient, injectable fetch for tests). Exposed at loopback **`GET /api/news?interests=&limit=`** (caps 8 interests / 60 items; safe 500). Renderer adapter `Store.news`/`SE.news`.
- **Renderer:** `stNewsOnly`/`filterInterest` state (persisted `ia_stnewsonly`/`ia_finterest`), `interestList()`, `relTime()`, `newsBatch()` (shapes news → `isNews:true`, runs `dropAlreadySaved` so 👎-blocklist + 5-day-seen + saved-dedupe still apply), `interleaveNews()` (~1-in-4), `stumbleFetch` news branch (no AI key/`callAI`/`validateItems` — news links are fresh, so the AI title-mismatch check is skipped) + `usableSpool` keeps news past the discovery TTL; `stCatSideHTML`/`stNewsSideHTML`/`stWrap` sidebar dispatch, `toggleNewsOnly`/`setNewsInterest`, a 📰 card badge, and a news empty-state nudge when no interests are set.
- **Verified:** full suite green + live end-to-end (`/api/news?interests=woodworking` returned real current articles) + Playwright UI smoke (News toggle swaps the sidebar to interests and back). Tests: `news-parse`, `news-fetch`, `news-route`, `storage-se-news`, `stumble-news-data`, `stumble-news-ui`. Built subagent-driven (spec `docs/superpowers/specs/2026-07-09-stumble-news-integration-design.md`, plan `docs/superpowers/plans/2026-07-09-stumble-news-integration.md`).
- **Known/deferred:** Google News item links are Google-redirect URLs (open to the publisher fine); if they ever prove flaky, swap to Bing News RSS or resolve the final URL — contained in `core/news.js`. News cards use the placeholder image (og:image enrichment deferred; capture can enrich on Save). No News toggle in the narrow-screen top-bar fallback (sidebar-only; intermix still works there).

## v1.12.18 — Stumble categories in a left sidebar (app 1.12.18)
- **The Stumble tab's category filter now appears in a LEFT sidebar** (like the Imported/Saved tabs) on wide screens (≥760px), using the same `.tg` pill style. New `stCatSideHTML()` (a `.tag-side` aside of `.tg` pills) + `stWrap()` (wraps the stumble content in an `.imp-body` flex row beside the sidebar) + `stSidebarOn()` gate. `renderCatBar` now suppresses the stumble top-bar pills when the sidebar is showing; on narrow screens the sidebar hides and the pills fall back to the top bar (resize re-renders across the breakpoint). CSS: `.imp-body>.st-main{flex:1;min-width:0}`. Playwright-verified (sidebar left of content, 5 `.tg` pills @10.5px/2px 9px, top bar empty when sidebar on, narrow fallback works). Test parity assertions updated in `tests/pill-style-parity.test.js`.

## v1.12.17 — One-click in-app auto-update (app 1.12.17)
- **The "Check for updates" button now actually updates the app** (electron-updater against the private GitHub repo). When a newer release exists it downloads in the background and offers to restart-and-install. Falls back to opening the releases page when unpackaged, when no token is set, or on error.
- **Auth = a user-pasted, read-only, single-repo GitHub token** (Settings → App updates). Chosen delivery (2026-07-08): token stored **only in local settings** — never baked into the .exe, never committed, and **never synced** (stripped in `settingsForSync`, preserved locally in `applySyncedSettings`, same as the provider/OPR keys). Passed to the main process per-check via a new `ia:check-updates` IPC; main uses `setFeedURL({provider:"github", private:true, token})`.
- **Token type = fine-grained, Contents: Read-only, Interests-App only** — in-app step-by-step guide (`showUpdateTokenHelp`) walks the user through creating it.
- Wiring: `preload.js` (`checkUpdates`/`installUpdate`/`onUpdateStatus`), `main.js` (lazy-required updater, dev-guarded, event relay → renderer toasts/status), renderer (`checkForUpdates` rework + status listener + Settings section). `package.json` gained the `electron-updater` dep + a `publish` (github) block so electron-builder emits `latest.yml`/`app-update.yml`; CI now attaches `latest.yml` + the `.exe.blockmap` to each release. +`tests/auto-update.test.js` (13 asserts, incl. token-never-syncs).
- **First-run caveat:** the currently-installed build (≤1.12.16) has no updater, so **v1.12.17 must be installed manually once** (from the releases page). After that, the button auto-updates. Unsigned → one Windows "Run anyway" prompt may still appear during an update install.

## v1.12.16 — Stumble category pills match Imported tag style (app 1.12.16)
- **Stumble category filter pills now use the same small `.tg` style/size as the Imported tags** (10.5px, 2px 9px, pill, accent when active) instead of the chunky `.catpill`. `renderCatBar` gained a `curTab==="stumble"` branch that renders the filters as `.tg` spans; Imported source pills, Saved (already `.tg` in its sidebar), and the view-mode pills are unchanged. +`tests/pill-style-parity.test.js` locks the parity across Imported/Saved/Stumble.

## v1.12.15 — SmartScreen workaround guidance (app 1.12.15)
- **Decision (2026-07-08): live with the SmartScreen warning, no code-signing certificate.** The installer is unsigned, and only a paid Authenticode/Azure Trusted Signing cert removes the warning — deferred. Options remain documented below if revisited.
- **In-app note:** the Help/About modal (under "Check for updates") now explains the expected **"Windows protected your PC"** warning and the **More info → Run anyway** workaround (unsigned but safe).
- **Release-page note:** the CI workflow (`.github/workflows/release.yml`) now prepends the same "Installing on Windows" guidance above the auto-generated changelog on every GitHub release — shown right where the installer is downloaded. Best-effort step (`continue-on-error`); never blocks the release.

### Deferred: remove SmartScreen via code signing (if revisited)
- **Azure Trusted Signing** (~$10/mo, Microsoft) — cheapest legit path; needs an Azure account + identity verification, then wire electron-builder + CI signing creds.
- **OV/EV Authenticode cert** (~$100–400/yr, EV often on a hardware token) — EV = instant trust; OV builds reputation.
- Either way I'd add the signing config to `package.json` build + CI secrets once credentials exist.

## v1.12.14 — Check-for-updates + Saved sidebar style parity (app 1.12.14)
- **"Check for updates"** button in the Help/About modal → opens the GitHub **releases/latest** page in the browser (via `window.ia.openExternal`), where you compare against the version shown in the modal. (Repo is private, so there's no unauthenticated version API to auto-compare; the page is the check.)
- **Saved category sidebar now matches the Imported tag sidebar exactly** — the pills use the same `.tg` style (10.5px, 2px 9px, counts shown, active pill with ✕ to clear) instead of the larger `catpill`. `catSideHTML` rewritten to mirror `tagSideHTML`; unused `.cat-side .catpill` CSS removed.

## 💡 Wish list — not scheduled

### "Local Stumble" — a free, no-AI (no-cost) discovery mode
Requested 2026-07-04 (parked to the wish list). Goal: a Stumble mode that costs **$0** (no API/model calls), for when the user doesn't want to pay per stumble.
- **Why it can't just clone StumbleUpon:** StumbleUpon's pre-AI magic was **collaborative filtering** (millions of users' 👍/👎 → taste neighborhoods) + topic/tag matching over a **human-curated** page pool. A single-user app has no crowd, so collaborative filtering is out. The viable path is **content-based** recommendation.
- **Proposed design (content-based, local):**
  - **Candidate pool** from free sources the app already has: (a) the user's own **imported cards + saves** (~5,445) → a "**rediscover**" mode that resurfaces forgotten saves (zero external calls — the strongest, simplest free win); (b) *optional phase 2:* a small **bundled, topic-tagged URL pool** (curated "awesome-list"-style, à la the StumbleUponAwesome clone) for genuinely *new* pages.
  - **Ranking** = pure local math (no model): score each candidate by tag/domain/keyword overlap with the user's **category weights + liked domains + `S.interests` text** (simple TF-IDF / keyword match).
  - **Learning** = 👍/👎 nudge local weights (upweight liked domains/topics, downweight disliked) — the "figures out what you like" part via counters, not AI.
  - **Reuse existing:** liveness via `/api/check-content`, the permanent 👎 `disliked` blocklist, and the 5-day `seenAt` filter — all free.
  - **Surface:** a provider/mode option (e.g. a "Local (free)" provider or a Stumble toggle) that routes discovery to this engine instead of `callAI`.
- **Trade-off:** less fresh/serendipitous than live AI web search (finite pool, needs seeding); but $0 and fully private. **Recommended first slice = rediscover-own-library only** (fully free, immediate, no bundled data); add the curated new-pages pool as phase 2 if liked.
- **Open question for build time:** rediscover-only vs. also-bundled-pool (user was asked, chose to wishlist instead of deciding now).

## v1.12.11 — Collapsible Settings sections (app 1.12.11)
- **Interest categories**, **Your profile**, and **What I've learned about you** now collapse/expand — click the section header (▾/▸ chevron) to fold it. State is remembered per device (localStorage `ia_collapsed`, not synced). `.sec.collapsible`/`.collapsed` CSS + `toggleSec`/`restoreCollapsed` (called from `renderSettings`). +`tests/collapsible-sections.test.js`.

## v1.12.10 — Cost-sorted model picker + 5-day "already seen" suppression (app 1.12.10 / ext 4.55)
- **Model dropdown now ranks cheapest → most expensive and shows the approx per-stumble cost** in each option (free models first, marked "⚠ rate-limited"). Hint notes that OpenRouter web search (~$0.01–0.02/stumble, same for every model) usually dwarfs the model cost. `OR_MODELS` gained a cost field + `.sort`; `orModelCost` helper.
- **Stumbles won't repeat a page you've already seen for ~5 days.** New `seenAt` map (`ia_seen`, `SEEN_TTL`=5 days, pruned): a page is stamped when it's actually **dealt** (in-app `spoolTake`) or **opened** in the browser (extension sends a `vote:0` "seen" ping → `drainBrowserFeedback`), and `dropAlreadySaved` hard-skips anything seen within the window. Complements the permanent 👎 blocklist.
- Regression asserts: `tests/model-dropdown.test.js`, `tests/seen-suppression.test.js`. Extension bumped to 4.55 (reload it).

## v1.12.9 — Model picker dropdown + Gemini default (app 1.12.9)
- The OpenRouter **Model** field is now a **grouped dropdown** (Recommended / Higher quality / Free⚠) of curated, live-verified models, with a **Custom…** option to type any id. `OR_MODELS` + `orModelSelectHTML` in the renderer; other providers keep the text input.
- **Default model changed to `google/gemini-2.5-flash-lite`** — tested working for Stumble and ~2× faster than gpt-4o-mini at a fraction of a cent. (Findings: the requested `gemini-2.0-flash-exp:free` no longer exists on OpenRouter, and current free models 429-rate-limit under the web-search Stumble task.)
- Regression asserts in `tests/model-dropdown.test.js`.

## v1.12.8 — Settings sync + thumbs-down blocklist (app 1.12.8)
- **Settings now sync across devices** (rides the existing Dropbox sync): About/Interests, category weights, provider + model choice, and other prefs propagate with newest-wins merge. **API keys and the Open PageRank key never sync** (stripped at publish; each device keeps its own); the Safe Browsing key is config-only and was never in the synced blob. Requires Dropbox sync enabled on each device. Core: `settingsForSync`/`applySyncedSettings` (db.js), settings LWW in `mergeSnapshots` (merge.js), publish + apply in sync.js (additive snapshot field — no schema bump). The renderer stamps `ia_settings_updatedAt` only on genuine content changes (not boot re-saves).
- **Thumbs-down = never show again** — a 👎 (in-app *or* browser overlay) now permanently blocklists that page's URL, hard-filtered in `dropAlreadySaved` (the shared discovery gate), not just a soft/windowed prompt hint. The blocklist is viewable/undoable in Settings → "What I've learned about you" → 🚫 Never show again.
- **2 CRITICALs caught by data-safety review before ship & fixed:** settings were never actually published (publish object omitted the field → silent no-op); and the boot re-save was bumping the sync timestamp every launch (would make last-*booted* win instead of last-*edited*). Both fixed + an end-to-end publish→merge regression test (`tests/sync-settings.test.js`, `tests/dislike-blocklist.test.js`).

## v1.12.7 — LOOP-06 UX fixes (app 1.12.7)
From the LOOP-06 UX/UI audit (`_loopstate/LOOP-06/2026-07-04/AUDIT-ARTIFACT.md`), all Playwright-verified:
- **UX-1 (contrast)** — primary/accent button FILLS now use a new `--accent-strong` (white text ≥4.5:1 in both themes); the dark primary button went from 3.06:1 → 5.8:1. `--accent` stays bright for accent-colored text.
- **UX-2 (memory transparency)** — new Settings panel **"What I've learned about you"** lists your 👍/👎/opened items with per-item ✕ remove (delete verified to persist to storage, not cosmetic). `renderLearned`/`removeLearned`, backed by the existing `likes`/`hidden`/`clicks`.
- **UX-4 (degradation)** — boot now shows a dismissible **"Couldn't reach the app service — Retry"** banner instead of a silent empty screen when the local service is unreachable.
- **UX-3 (responsive)** — a `≤640px` breakpoint wraps the header/stumble/settings (horizontal overflow 622px → 381px; a ~6px residual on the Saved/Imported grids is accepted — this is a desktop app). Tablet/desktop unaffected.
Regression asserts in `tests/ux-loop06.test.js` (11). Re-verify: contrast no failures either theme; memory panel with working delete; boot banner present; overflow reduced.

## v1.12.6 — LOOP-11 REVISE hardening (app 1.12.6, ext 4.54)
Fixes from the LOOP-11 adversarial review (`_loopstate/loop-11/2026-07-04-bstumble/AUDIT-ARTIFACT.md`):
- **COR-1** — `bstumbleGo` is now re-entrancy-guarded (`_bstumbleGoBusy`), so rapid icon clicks / a click racing the overlay's "Stumble ⟳" can't shift the same buffered page twice.
- **COR-2** — 👍/👎 votes match the stashed item by normalized `matchKey` (host+path+query), so a redirect on the stumbled page no longer silently drops the category.
- **COR-3** — feedback draining (`drainBrowserFeedback`) runs every renderer tick independent of the 10-40s AI fetch, so votes cast during a fetch aren't blocked (and can't hit the 50-item extension cap and drop).
- **DAT-1 / SEC-2** — vote `title`/`category` are `String()`-coerced and length-capped (200/80) before entering `likes`/`hidden` and the AI prompt (defends the mailbox→prompt injection surface).
- **SEC-1** — injected overlay buttons require a trusted (`event.isTrusted`) click, so a hostile stumbled page can't script-click them to forge a Save/vote.
- **COR-6** — `buildPrompt` falls back to all categories when every weight is 0 (never sends an empty category list).
- **COR-7** — removed built-in categories are now truly reversible: Settings shows a "↺ Restore" control (`restoreCategory`), matching the earlier "reversible" claim.
Deferred (documented, lower value / higher effort): COR-4 (overlay inject timing — 1.5s fallback + idempotency accepted), COR-5 (non-atomic request clear, low frequency), SEC-3/SEC-4/COR-8 (accepted trust model / high bar). Every fix carries a regression assertion.

### Deferred — LOOP-11 low-severity items (2026-07-04, browser stumble)
From the LOOP-11 audit (`_loopstate/loop-11/2026-07-04-bstumble/AUDIT-ARTIFACT.md`). None block ship; revisit if the symptom shows up in real use.
- **COR-4 (MED) — overlay injection timing on the reused tab.** The `onUpdated` "complete" listener + 1.5s idempotent fallback can, on a very slow reused-tab navigation, briefly draw the bar on the old page or miss the listener. Robust fix: use `webNavigation.onCommitted`/`onCompleted` filtered to the specific `tabId` **and** target URL instead of a one-shot `onUpdated` + timeout. (`extension/background.js` `bstumbleInjectOverlayWhenReady`)
- **COR-5 (MED) — non-atomic request read-then-clear drops an occasional refill.** Renderer GETs the request then POSTs `{request:null}`; a new extension request arriving in that gap is overwritten → buffer runs dry until the next click. Fix: compare-and-clear by `nonce`, or make the request route return-and-clear atomically server-side like results/feedback. (`web/index.html` `pollBrowserStumble`; `core/server.js`)
- **SEC-3 (LOW) — "Remove from Interests" fallback can remove the wrong card.** When triggered from an explicit link/page whose URL doesn't match any card, it falls back to deleting the last-opened card. Fix: only use the last-opened fallback for the action-icon context, not for an explicit link/page target. (`extension/background.js` removeFromInterests handler → `deliverToApp({removeActive:true})`; `web/index.html` drainCaptures)
- **SEC-4 (LOW) — validate result URLs before opening.** A co-installed malicious extension could POST arbitrary `items` to `/api/bstumble/results` that the stumble tab then navigates to. Defense-in-depth: check `next.url` is `http(s):` before `bstumbleOpen`. (`extension/background.js` `bstumbleGo`/`bstumbleOpen`)
- **COR-8 / DAT-2 (LOW) — results/feedback mailbox eviction.** Ephemeral last-writer-wins queues (results cap 20, feedback 50) can drop the oldest under GET/POST lag. Accepted for disposable data; only revisit if validated AI results are observably wasted.
- **NEW-1 (LOW) — rapid double-click drops one advance.** The `_bstumbleGoBusy` guard (COR-1 fix) makes a second concurrent advance a no-op (costs one extra click, no data loss). Optional: queue a single pending advance instead of dropping. (`extension/background.js` `bstumbleGo`)

## v1.12.5 — "Save to Interests" on the extension icon menu (ext 4.53, extension-only)
- "Save to Interests" (and "Remove from Interests") now also appear when you **right-click the extension toolbar icon** (added the `"action"` context), not only on the web page's right-click menu. Right-clicking the icon → "Save to Interests" saves the current page — the home the removed popup's "Clip this page" used to have. Still gated by the `ia_ctx_save` toggle. Extension-only — reload the extension.

## v1.12.4 — Toggle for "Save to Interests" menu (ext 4.52, extension-only)
- New checkbox on the extension Options page turns the right-click **"Save to Interests"** item on/off (default ON). `ensureContextMenu()` reads `ia_ctx_save` (default ON when unset) and only creates the item when enabled; a `chrome.storage.onChanged` watcher rebuilds the menu the instant the toggle flips (no reload). "Remove from Interests" is always present. Extension-only — reload the extension.

## v1.12.3 — Removable base categories (app 1.12.3)
- The 4 built-in categories (Personal / Work / Career / Life) can now be removed with ✕, same as custom ones — removed base categories are remembered in `S.hiddenBase` and filtered out of `rebuildCats()`. A keep-at-least-one guard protects the `catByName`/`buildPrompt` fallback. No card data is touched (a removed category only stops driving Stumble; existing cards keep their label and fall back to the first category's color).

## v1.12.2 — Thumbs-up stays + interest-picker category fix (app 1.12.2, ext 4.51)
- 👍 (like) now records the vote and **stays on the page** so you can read it or ★ Save it; only 👎 (not-for-me) auto-advances to the next page. (ext 4.51)
- **Fixed: the extension's interest picker showed no/stale categories until a category was added.** Root cause — `bootData()` loaded settings but never re-ran `rebuildCats()`, so `ia_bstumble_cats` stayed at the module-load base-only list until the next settings edit republished it. Now `rebuildCats()` runs once after settings load at boot, republishing the full list every launch. (app 1.12.2)

## v1.12.1 — Stumble polish (ext 4.50)
- Browser 👍/👎 votes now carry the stumbled page's **category** (from the stumble result) so the app's learning is category-weighted, not title-only. Falls back to title-only if the page navigated away from the stumbled URL.
- Removed the redundant header **⟳ New ideas** button — the on-surface **🎲 Stumble** button already deals a fresh set; cleaned up its dead helpers (`stumbleRefill`, `syncRefillBtn`) and updated the Help text.

## v1.12.0 — Browser Stumble (StumbleUpon-style)
- Left-click the extension icon (ext 4.49) to stumble one fresh, app-validated page in a single reused browser tab.
- On-page overlay: 👍 / 👎 / ★ Save / Stumble ⟳. 👍→liked, 👎→not-for-me feed the app's discovery AI; Save clips to Interests.
- Interests picker on the extension Options page (synced from the app's categories) scopes discovery.
- New Core mailboxes (`/api/categories`, `/api/bstumble/request|results|feedback`) drained by the renderer; extension never writes app data directly. Strict live-page validation unchanged.
- Extension left-click no longer opens the old popup; Clip stays on right-click "Save to Interests", new right-click "Remove from Interests".

## v1.11.2 Grounded + faster Stumble (2026-07-03)

v1.11.1 correctly rejected dead pages but could return no cards and took too long. Live diagnosis
found the configured OpenRouter model was being told to search without actually receiving a search
tool, so it invented URLs; strict validation then rejected them. The pipeline also fetched every
candidate up to three times and waited for a second AI batch when the first batch had fewer than the
requested 1/2/4 deal size.

- OpenRouter Stumble calls now enable the official `openrouter:web_search` server tool. Other
  OpenRouter tasks (Enrich, categorization, etc.) do not pay for search.
- Search is capped at 4–6 candidates based on deal size, six total results, low search context, and
  bounded output. Stumble's taste-history prompt is trimmed; local duplicate removal still checks
  the complete Saved collection.
- Validation now uses one SSRF-guarded `/api/check-content` fetch per page. It already returns the
  final HTTP status, soft-404 signals, page title, and `og:image`, so the prior status and image URL
  probes were redundant. Strict 2xx/content/title acceptance remains unchanged.
- The extracted `og:image` renders immediately; a broken/missing image naturally falls through to
  mShots for a screenshot of the already-verified live page.
- Any cached survivor is dealt immediately. The first non-empty AI batch is also shown immediately;
  missing slots refill quietly in the background instead of blocking the user.
- Measured on the configured OpenRouter model: old path 30.4 seconds for 9 cards; new path 14.7
  seconds for 6 candidates, with 5 verified survivors—enough for the current four-card deal.

## v1.11.1 Strict-live Stumble + verified card images (2026-07-03)

Live evidence from the user's persisted Stumble deal/spool showed 10 of 11 candidates were dead or
unverifiable: six real 404s (including the reported Verge card), two 403/error pages, one
Cloudflare challenge, one empty TLS failure, and only one positively verified page with a live
page-provided image. The Core probes already recognized these results; the renderer was still
fail-open on batch errors and deliberately kept unknown/challenged pages.

- Stumble is now **fail-closed**: a candidate must receive `alive` from `/api/check-links`, then a
  clean 2xx `likely-alive` result from `/api/check-content`. Unknown, skipped, errored, empty,
  challenged, soft-404, redirect-home, and wrong-article results never enter the spool.
- AI-supplied image URLs are no longer trusted. A kept card uses the page's extracted `og:image`
  only after that image URL also passes `/api/check-links`; otherwise the card falls back to an
  mShots capture of the already-verified live page.
- Accepted cards carry a live-check timestamp. Spool entries expire after 30 minutes, and a
  one-time validation-version migration clears v1.11.0's persisted fail-open deal/spool so the
  reported 404 card cannot survive the upgrade.
- Pure tests pin the exact Verge failure plus 403/404/500, skipped/unknown, empty, challenge,
  wrong-article, homepage, and freshness boundaries; renderer assertions pin fail-closed wiring,
  image verification, and cache migration.

## v1.11.0 Stumble-first — Feed removed (2026-07-03)

**Feed module removed.** Rationale: the Feed asked the AI for N articles and rendered them as a
grid, but AI-hallucinated deep URLs mostly don't exist. After v1.10.2–1.10.4 the validation
pipeline (tier-1 `/api/check-links` + tier-2 `/api/check-content` soft-404 / entity / challenge /
title-mismatch detection) correctly kills most of those suggestions — so the honest Feed rendered
nearly empty or full of drops. Rather than water down validation, we killed the Feed and made
**Stumble the primary discovery surface**.

- **Removed:** Feed tab + `view-feed` + `renderFeed`/`refreshFeed`, feed-only empty states, the
  `feed` global + its persistence. Boot writes a one-time `save("feed",[])` tombstone (no schema
  change). A persisted `tab==="feed"` migrates to `"stumble"`; boot default is now `"stumble"`.
- **Kept (shared):** categories/importance sliders → `buildPrompt` (UI relabeled "feed sections" →
  "interest categories"), cat-bar filtering for Saved, `dropAlreadySaved`, `parseItems`,
  `validateItems` + `rankFilter` (now feed the spool), `shown` history, per-card save flows.
- **Stumble now deals 1 / 2 / 4 validated cards** from a `spool`. One AI call requests ~12
  candidates (`buildPrompt("stumble")`) → `dropAlreadySaved` → `validateItems` → `rankFilter` →
  survivors spool. `stDeal` (persisted, replaces `stCur`) holds the current deal; `stSize`
  (persisted kv `stsize`, default 1) is the deal size. Deal-size selector (1/2/4 toggle) on the
  view. Auto-refill when the spool is short, capped at 2 attempts/deal → friendly "couldn't find
  enough live ideas" instead of looping. In multi-card mode, Save / "Not for me" replaces just that
  one card (single replacement). Header "⟳ New ideas" repoints to `stumbleRefill`.
- Layout: 1 = single card, 2 = side-by-side, 4 = 2×2 grid, reusing the existing card/thumb/ph
  markup and `imageChain`/noshot machinery.

## v1.10.0 iPhone-sync prep release (2026-07-03)

Phase 4 of the full-review pass in `docs/full-review-2026-07-02.md` (section G): the
DESKTOP-side prerequisites for a future iPhone companion app. No iOS code — the
deliverable is an API + sync layer a phone client can safely use, plus a written
handoff design doc. Extension untouched this phase (stays 4.48).

- [x] **T1** `GET /api/changes?since=` — delta read API (cards/saved/tombstones,
  `now` watermark, at-least-once poll semantics); `GET /api/tombstones?since=` cheap
  poll variant. `core/db.js` gains `cardsSince`/`savedSince`/`tombstonesSince`.
- [x] **T2** Host-header allowlist (closes a DNS-rebinding hole; runs before the
  Origin guard) + dormant pairing-token auth scaffolding (`ensurePairingToken`/
  `getPairingToken` in `core/config.js`, `requireToken` middleware gated on a future
  `lanEnabled` config flag, `GET /api/pair-status` capability probe). Bind stays
  `127.0.0.1` regardless of the flag — asserted by test.
- [x] **T3** Image manifest (`GET /api/images` → id/size/sniffed-type) and honest
  content types on `GET /api/img/:id` (magic-byte sniff instead of hardcoded
  `image/jpeg`).
- [x] **T4** Sync robustness: clock-skew guard (peer snapshots >24h in the future are
  skipped + counted as `skewSkipped` + logged), `fp` table no longer published in
  snapshots (still merge-tolerant of old snapshots that have it), tombstone retention
  policy documented as "keep forever" (an occasionally-offline phone peer makes any
  TTL unsafe).
- [x] **T5** `itemImg`/`setItemImg` accessor helpers in `web/index.html` remove
  `scope==="saved" ? it.image : it.img`-shaped conditionals from renderer code. The
  storage/wire format is UNCHANGED by design — cards keep `img`, saved keeps `image`;
  a real schema rename would need an iOS-driven schema-version bump.
- [x] **T6** `docs/iphone-sync-design.md` — handoff doc for the iOS build (architecture
  decision, API surface, schema notes, open items). This BACKLOG entry.

**Out of scope / deferred to the iOS phase** (see `docs/iphone-sync-design.md` section
4 for the anchor):
- Thumbnails — no server-side image-processing support yet.
- Binary (non-base64) image upload — `PUT /api/img/:id` stays base64-in-JSON.
- Settings/kv sync split — `kv` table stays entirely machine-local/unsynced until user
  settings are separated from capture-queue/store-path state.
- LAN fast-path enablement — the delta API + token/Host-allowlist infra exists, but
  the bind-address change, TLS decision, and pairing UX are unbuilt; `lanEnabled`
  stays off.
- Per-peer sync cursors — needed before tombstones can ever be pruned; not designed.

## v1.9.0 tightening release (2026-07-03)

Phase 3 duplication-collapse and module-extraction pass across core, web, and extension, plus a
13-item deferred-minors sweep.

- [x] **T1** `core/guardedfetch.js` — three SSRF-fetch copies unified; undici drain workaround
  single-sourced.
- [x] **T2** core smalls — shared stable-stringify via `merge.js`, `jsonKvEndpoints` helper, JSON
  error middleware, read-only `getSyncConfig` + `ensureSyncConfig` at boot, `window.app` alias
  removed, `copyById` typo fixed.
- [x] **T3** `web/ai.js` — one AI dispatcher + `parseJsonArray` replace ~25 copies.
- [x] **T4** `web/lib/urlkey.js` — four URL canonicalizers unified, fuzz-verified.
- [x] **T5** `web/lib/import-parsers.js` + `capture-state.js` — parsers, 8 predicates,
  `ingestImported` pure/impure split; same-batch dedupe crash fixed post-review.
- [x] **T6** `dispatchCaptureBatch` spine — three extension-batch dispatchers unified; og-fetch path
  deliberately kept separate.
- [x] **T7** 13-item deferred-minors sweep — Esc unification, poller `flushQueue`, `saveConfig` tmp
  cleanup, stumble cap, `parseItems` ids, etc.

**Sanctioned behavior changes (four):** error bodies no longer leak stack traces; duplicate-scan
groups YouTube shorts like clip-dedupe; CSV titles with doubled quotes import correctly; unified
no-key message at most AI sites.

### Deferred (from v1.9.0 final review)

- [ ] `urlkey` garbage-input coercion test.
- [ ] `import-parsers` unconfigured-decode hard-assert.
- [ ] `kvSet`-move error-path note.
- [ ] Out-of-band-config-corruption `deviceId` edge in pure `getSyncConfig`.

**Also deferred:** `.img`/`.image` field unification to Phase 4 (iPhone schema work); web
views/state split is the next increment of the F-plan.

## v1.8.0 consolidation release (2026-07-02)

Phase 2 of the full-review pass in `docs/full-review-2026-07-02.md` (sections D1-D5, E): GUI
consolidation on the web side and simplification on the extension side. The app gets smaller —
fewer buttons, fewer permissions, less code.

- [x] **D1** — "Get pictures & info" capture panel replaces six capture/enrich buttons (Enrich,
  Capture missing, Capture Facebook, Auto-capture all, Auto-capture in tabs, Select-mode Fetch
  info). One panel shows per-bucket counts (never-tried, Facebook-needs-extension, failed/retry,
  missing descriptions); one Start button drains per-bucket sequentially with jittered pauses,
  capped at ~500 FB posts per Start; one Stop button aborts the whole sequence, not just the
  current stage.
- [x] **D2** — "Library health" modal replaces six janitor tools (Scan duplicates, Check links,
  Groom link-less, failed-captures dropdown, Couldn't-capture toggle, Fix placeholders) with one
  tabbed modal (Duplicates | Dead & unsafe | Failed captures | No link) sharing one `removeCards`
  helper (idb + fingerprint cleanup, `persistCards`, user-reviewed `{confirm:true}`, undo toast).
- [x] **D3** — Backup & restore consolidated into one section: status line, Back up now, auto-backup
  schedule, restore list, Import legacy backup. Removed the Notion/Jarvis bridge stub section and
  the browser-quota/persistence rows (meaningless since the SQLite move). Fixed: `ia_theme`
  legacy-restore routing, partial-restore toast wording, restore's `plan.skipped` count now shown.
- [x] **D4** — "Suggest interest categories" and "Analyze my library" merged into one "Build my
  profile" flow (optional free-text + library analysis, same chip/about-draft output). Taxonomy
  labels clarified in Settings copy (categories = feed sections, tags = imported organization,
  interests = profile). `persistCards` 409-regex unified with the global net matcher; net toast
  copy now write-verb-only so failed GETs don't toast "Saving failed"; dead `ogParse` removed.
- [x] **D5** — extension: the legacy bridge-driving layer (`bridge.js`, `bridge-probe.js`, localhost
  content-script injection, defer-to-app-tab branches) is deleted; the service-worker poller
  (`pollCaptureRequest`/`pollBatchState`) is now the only capture driver. Passive dead-link
  auto-removal (the `chrome.webRequest` 404/410 listener) is retired and the `webRequest`
  permission dropped — dead links are found only by the app's review-based "Check links" sweep now.
  Instagram 429/rate-limit pages are now recognized by the blocked-page detector instead of being
  captured as a card image. Capture-claim persistence for single captures is now handled by the SW
  poller, surviving service-worker suspension.
- [x] **E** — dead code sweeps on both sides: extension (`manualCapture` handler, orphaned `.cap`
  CSS, `clipFacebookPost` alias, `deliverDead` wrapper, duplicated `lockedCaptureVisible` copies,
  doubled `onInstalled`/`onStartup` registrations, extracted `buildClipInfo`, stale capture-configs
  doc comment, `*.tmp.*` stray files) and web (`collectBackupMeta`, `downloadJSON`, `markBackupDone`,
  `restoreFromDir`, `initImageStore`, `BACKUP_SKIP`, `viewFailures` wrapper, `_refreshTabs`/
  `closeRefreshTab` no-ops).
- [x] **Repo hygiene** — deleted stray `package.json.tmp.*` and `tests/*.tmp.*` files; moved root-level
  `facebook-import.json`, `facebook-saves.txt`, `pinterest-import.json`, `youtube-import.json` into
  `_recovery/root-import-files/`.

**Retired in v1.8.0:** passive dead-link auto-removal (now only via the app's review-based Check
links sweep); the unbounded auto-capture loop (now a bounded drain-per-Start, capped ~500 FB posts);
the manual "Fix placeholders" button (placeholder fixing now runs automatically before FB capture
runs); browser-tab single-capture latency may now be up to ~30s (governed by the SW alarm cadence,
since the bridge's faster-but-racier path is gone).

### Deferred (from v1.8.0 final review)

- [ ] `pollCaptureRequest` re-entrancy guard for concurrent claims.
- [ ] `flushQueue` in `iaPollAll` for faster offline-queue delivery.
- [ ] Stale bridge comment in `background.js` ~line 759 (leftover reference to the deleted bridge
  layer).
- [ ] Triple-Esc-listener unification (web side).
- [ ] Web-side `backupCountsMatch` orphan (dead code left over from the D3 backup consolidation).
- [ ] `enrichImported`'s `#enrichBtn` guarded ref (button no longer exists post-D1; the guard should
  be removed with it).
- [ ] Double-delivery-after-suspension comment (extension SW).

## v1.7.0 stability release (2026-07-02)

Fixes from the full-review pass in `docs/full-review-2026-07-02.md` (four parallel review agents:
Core service, Web UI, Extension, Data-model/Sync-for-iPhone). All Phase-1 findings fixed and tested.

- [x] **A1** — legacy file-restore wrote to dead `localStorage` instead of the Core service; restore
  silently restored nothing but images.
- [x] **A2** — boot race: the capture-drain interval could fire before `bootData()` finished loading,
  triggering a full-replace `putSaved([one clip])` that could wipe the entire Saved library.
- [x] **A3** — `ctx.db`/`ctx.storeDir` went stale after a Restore or store Move because routes kept
  destructured locals instead of reading through `ctx`.
- [x] **A4** — extension `content.js`'s metadata IIFE was missing a `return`, making og:image/title/
  description extraction and the blocked-page/CAPTCHA detector dead code for every capture.
- [x] **A5** — full-array `PUT /api/cards` tombstoned any row missing from the payload; added an `asOf`
  guard and a mass-delete 409 so a stale renderer array can't wipe synced rows.
- [x] **B1** — restore mid-swap failure now reopens `ctx.db` on failure instead of leaving it closed.
- [x] **B2** — un-awaited `shell.openExternal()` rejections no longer crash-quit the app.
- [x] **B3** — sync enable/disable now takes effect without an app restart.
- [x] **B4** — Settings "clear" link fixed to actually clear imported data (was a dead localStorage key).
- [x] **B5** — persistence failures (`putCards`/`putSaved`/`kvSet`) are now surfaced via a toast instead
  of being silently fire-and-forget.
- [x] **B6** — "Fetch info" no longer calls the dead `allorigins` proxy.
- [x] **B7** — a stale/foreign `filterCat` after restore or sync no longer crashes the Feed/Saved render.
- [x] **B8** — "Select all shown" now uses the same filter predicate as the visible list, instead of
  drifting from it.
- [x] **B9/B10** — bridge batch driver no longer resurrects a cancelled ("Stop") batch, and bridge
  injection is narrowed off unrelated localhost ports.
- [x] **B11** — offline capture queue no longer silently drops captures on quota failure.
- [x] **B12** — pending single-capture requests survive service-worker suspension instead of being lost.
- [x] **B13** — capture/dedupe/dead-report matching now preserves query strings instead of collapsing
  distinct URLs together.
- [x] **M1/M3/M4/L1** — `savedToRow` id-less `idb:` item fix; atomic `config.json` write; tombstone
  `deletedAt` passed through end-to-end instead of re-stamped; per-row corrupt-JSON resilience in
  `db.js`; `c.description`/`.desc` display typo fixed.

### Deferred to backlog (from v1.7.0 reviews)

- [ ] `ia_theme` legacy-restore routing — same class as A1, lower stakes; not yet migrated off legacy
  storage.
- [ ] Partial-restore toast wording — clarify what was/wasn't restored when a restore partially fails.
- [ ] `plan.skipped` surfacing — sync merge plan's skipped items aren't shown anywhere.
- [ ] `ogParse` dead-code removal — leftover parsing path superseded by the A4 fix.
- [ ] `saveConfig` tmp-orphan on rename-throw — atomic write can leave a stray tmp file if rename throws.
- [ ] Ctrl+Shift+B pre-boot gate — guard the shortcut before boot/data load completes.
- [ ] `persistCards`/net 409-regex unification — the new A5 409 handling and existing net-error regexes
  should share one matcher.
- [ ] Global net toast copy on GET failures — align wording with the new persistence-failure toasts (B5).
- [ ] Bridge `saveState` GET→POST race + `reportDead` `normalizeUrl` asymmetry — both superseded by
  Phase 2 D5 bridge-driving removal; no standalone fix planned.
- [ ] Server-generated `asOf` (Phase 4) — client-supplied `asOf` is a stopgap until the server stamps it.
- [ ] `syncDirty` cleared-before-publish note — a narrow ordering edge case flagged during A5/B3 work;
  revisit once Phase 4 delta endpoints land.

## Requested 2026-06-30 (Dave)

- [x] **(1) BUG — feed showed nothing but 404s. FIXED v1.6.3 (commit pending rebuild).** Root cause:
  `validateItems` checked each AI-suggested URL through `api.allorigins.win` (now HTTP 500 / CORS-blocked
  from the app) and FAILED OPEN (returned "alive" on any proxy error) → zero filtering → every dead
  AI-hallucinated URL was shown. Fix: `validateItems` now uses the app's own `Store.checkLinks`
  (`/api/check-links`: server-side, SSRF-guarded, conservative) and drops ONLY confirmed-dead links
  (404/410/451/DNS); social hosts return `skipped`, unknown/alive are kept (live pages never hidden).
  Verified the Core probe live (example.com→alive, fake→404 dead, yt/ig/fb→skipped). `tests/feed-validate.test.js`.
- [ ] **(2) ENHANCEMENT — feed AI-recommends from interests & previous saves (the larger upgrade, NOT yet built).**
  The feed should **use AI to propose the most likely pages the user will want**, grounded in their
  **interests** (`S.interests` / `S.about`, populated by Analyze-my-library) **and previous saves** (Saved +
  Imported history). The feed already builds an AI prompt from `S.about`+`S.interests` (`buildPrompt` in
  `web/index.html`) and passes recent saves/likes/clicks; the upgrade is to weight prior saves more heavily
  and improve relevance/ranking. Brainstorm: have the AI suggest topics/queries → resolve to REAL pages
  (or suggest only from a live source) → still live-check before render (done in part 1) → rank by
  interest/saves overlap; consider caching validated suggestions so the feed isn't empty while checking.
  NOTE: hard-404 filtering is done (part 1); soft-404 (200-but-gone) detection in the feed could fold in
  the existing `/api/check-content` tier if needed.

- [ ] **Single-card "reader" view (full-page, one article at a time).** A page-sized view that shows ONE
  card at a time with **advance / retreat arrows** to move through the set, plus a **Remove card** button
  in the view. For focused reading/triage of one item at a time (vs. the grid). Open questions for
  brainstorm: which set does it page through (current filter/search result, or all Imported?); keyboard
  arrows too; what "remove" does (same backup-first delete as elsewhere); where the entry point lives.

- [ ] **"Open app in a browser session" button.** A button that opens the app in a real browser tab
  (the Core already serves the UI at `http://localhost:3456`). Note: when the app is open as a
  `localhost` Chrome tab, the extension's `bridge.js` content script runs there and can also drive
  capture — so this doubles as an alternate capture path. Brainstorm: open via `shell.openExternal`
  to the loopback URL; confirm the served UI works the same in a browser vs. the Electron window.

- [ ] **YouTube "Save" → auto-add the video to the app (integrate or confirm).** When you click **Save**
  on a YouTube video (add to a playlist / Watch Later), it should capture that video into the app
  automatically. **Likely already built** — the extension has a YouTube `saveTrigger` + `yt-save-trigger.js`
  (playlist-save, shipped ~v4.37): adding a video to any playlist fires a capture → Saved library.
  Action: **confirm it still works end-to-end** (reload ext, refresh a YouTube tab, Save a video to a
  playlist → check it lands in Saved with the real thumbnail); fix/extend if it doesn't.

## YouTube channel cards — decision needed

- [ ] **What to do with the 451 imported YouTube *channel* cards** (from a `youtube` subscriptions import;
  they open the creator's page, not a video). Options: (1) leave them (a followed channel is a valid
  interest signal); (2) give them a nicer picture (channel avatar/art via og:image instead of the current
  page screenshot); (3) replace with real videos by re-importing a video-bearing source (YouTube/Takeout
  watch-history / liked / playlists); (4) remove them. Real videos will also flow in going forward via the
  YouTube "Save" integration above.

## Deferred capture/UX niceties (offered, not yet built)

- [ ] **In-app Capture Log panel** (spec `2026-06-30-unified-sw-capture-driver-design.md`, Phase 3–4): a
  Settings view that tails the worker's capture trail (POST/GET `/api/log` ring buffer + SW mirroring),
  so capture issues are visible without DevTools / live queue grabbing.
- [ ] **Stuck-spinner timeout**: a per-card refresh that never lands should flip to "failed" after a
  timeout instead of spinning forever.
- [ ] **force on the localhost `bridge.js` batch path**: `bridge.js dispatch` doesn't pass `force`, so a
  Recapture run driven from a localhost browser tab won't overwrite good images (MINOR; the standalone
  app's SW driver already passes force).

## Older deferred (from earlier phases — see memory `interests-app-formal-app-phase.md`)

- [ ] **Notion connector**: token in Settings → Core fetches pages/databases → feed the profile analysis
  via the existing `extraSources` seam in `web/profile-analyze.js`.
- [ ] **Dropbox sync follow-ons (#5)**: settings-sync + content-addressed image pool (pays off once
  actively multi-device syncing).
- [ ] **Bounded scheduled extraction (#6)**: hands-off periodic capture from social saved lists
  (ToS/rate-limit caveats; must stay bounded + stoppable).
