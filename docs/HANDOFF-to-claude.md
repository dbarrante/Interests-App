# Interests App — Handoff to Claude (2026-07-03)

This is the current handoff for the Interests App as of release **v1.11.2**. The latest
product-code commit is `f1ff2b9`; this handoff may be committed after it as a docs-only change.
Read this document completely before changing code.

`docs/HANDOFF-to-codex.md` is useful history through v1.10.4, but its “current state” and
“in-flight work” sections are obsolete. This document supersedes it.

The owner, Dave, is not a professional developer. Explain findings plainly, make a recommendation
when presenting choices, and prefer safe, reversible changes.

---

## 1. Current state

- Repository: `D:\Dropbox\Documents\Claude\Projects\Interests App`
- Private GitHub remote: `https://github.com/dbarrante/Interests-App.git`
- Main branch: `master`
- Current release and `package.json` version: **1.11.2**
- Latest product-code commit: `f1ff2b9`
- Latest installer:
  `C:\Users\dkbar\interests-dist\Interests-App-Setup-1.11.2.exe`
  (105,244,149 bytes / 100.37 MB, unsigned)
- Chrome extension remains **Bookmark Spark v4.48**. It was not changed during the v1.11 work.
- The tracked worktree was clean after shipping v1.11.2. These local control files were untracked
  and intentionally left alone: `.agents/`, `.codex/`, and `AGENTS.md`.

The v1.11.2 installer was built and verified, but Dave had not yet confirmed installation in the
last Codex session. The running app observed during diagnosis was v1.11.1. Ask Dave to install
v1.11.2, click **?**, and confirm the displayed version before diagnosing behavior that may still
come from the old executable.

---

## 2. What the app is

Interests App is a personal discovery and library desktop app:

1. `main.js` / `preload.js` — Electron shell.
2. `core/*.js` — local Express + built-in `node:sqlite` service, loopback-only.
3. `web/index.html` — the renderer and most UI logic; intentionally one large file.
4. `web/*.js` and `web/lib/*.js` — pure/shared modules.
5. `extension/` — Chrome MV3 social-post capture extension.

There is no cloud backend owned by the app. User data stays in SQLite and image files. AI requests
go directly to the provider selected by the user.

The old Feed module no longer exists. **Stumble is the home discovery surface.**

---

## 3. Important paths

| Item | Path |
|---|---|
| Repo | `D:\Dropbox\Documents\Claude\Projects\Interests App` |
| Live store | `C:\Users\dkbar\AppData\Roaming\Interests App\data\` |
| App config | `C:\Users\dkbar\AppData\Roaming\Interests App\config.json` |
| Backups | `D:\Dropbox\Interests App\backups\` |
| Installers | `C:\Users\dkbar\interests-dist\` |
| Current changelog | `docs/BACKLOG.md` |
| Full earlier review | `docs/full-review-2026-07-02.md` |
| iPhone design | `docs/iphone-sync-design.md` |
| Project rules | `.agents/skills/project-conventions/SKILL.md` |
| Release rules | `.agents/skills/release/SKILL.md` |

The repo is inside Dropbox. Transient Git index locks and CRLF warnings have occurred; retry a
failed Git command rather than using destructive recovery.

---

## 4. Run, test, and build

```powershell
cd "D:\Dropbox\Documents\Claude\Projects\Interests App"
npm start
npm test
npm run dist
```

Required release signal:

```text
ALL TEST FILES PASSED
```

Tests are plain Node scripts, not Jest/Vitest:

- `node tests/run.js` discovers every `tests/*.test.js`.
- `node tests/syntax-check.js` parses inline scripts in `web/index.html`.
- Never call `process.exit()` from tests; use `process.exitCode`.
- Network behavior in automated tests must be stubbed.
- `web/index.html` has no browser unit harness. Use the syntax gate, source assertions, pure-module
  tests, careful code trace, and live Core probes.

The installer is built by electron-builder into `C:\Users\dkbar\interests-dist\`. It is unsigned;
SmartScreen’s **More info → Run anyway** flow is expected.

Build-host quirk: `winCodeSign-2.6.0` contains two irrelevant macOS symlinks that non-elevated
Windows cannot create. `docs/VERIFICATION.md` documents the proven cache workaround. The cache was
already populated successfully during v1.11.0 and later builds.

---

## 5. Architecture and invariants that must not regress

### Data safety

This project has previously lost data. These are hard requirements:

1. Full-array `PUT /api/cards` and `/api/saved` use an `asOf` watermark.
2. The mass-delete guard returns 409 unless a reviewed destructive action passes `{confirm:true}`.
3. Renderer writes must not occur before `_booted` is true.
4. Use `persistCards()` rather than a bare fire-and-forget `Store.putCards`.
5. Sync tombstones are retained forever; an offline peer makes TTL deletion unsafe.
6. Backups verify counts before rotation and keep at least three.
7. Import sources are read-only.
8. Never commit live/personal data (`data/`, backups, exports, imported archives, `saves.json`).

### Frozen wire format

- Imported/library cards use `img`.
- Saved cards use `image`.
- This split is frozen because desktop peers and the future phone client depend on it.
- Do not rename DB columns or serialized fields. Use the renderer accessors.

### Security

- Core binds to `127.0.0.1`.
- Host-header allowlisting runs before Origin checks.
- Pairing/LAN scaffolding is dormant; do not expose Core casually.
- All server-side page fetches must stay behind the shared SSRF guard in `core/guardedfetch.js`.
- Middleware ordering in `core/server.js` is load-bearing.

### Extension

The extension capture engine is stable at 4.48. Do not change it for Stumble/UI work.

---

## 6. What changed in v1.11

### v1.11.0 — Stumble-first

Commits: `41e6320`, `cd6b85a`

- Removed Feed tab, view, renderer, refresh flow, global state, and persistence.
- Stumble became the default/home discovery surface.
- Added persisted 1 / 2 / 4 deal-size selector (`ia_stsize`).
- Added persisted dealt array (`ia_stdeal`) and validated spool (`ia_spool`).
- Save / Not for me / Like replace only the acted-on card in multi-card mode.
- Header **New ideas** now drives Stumble.
- Migrated persisted `tab === "feed"` to `stumble`.
- Hardened immediate persistence of votes/saves and partial-deal behavior.

### v1.11.1 — strict-live pages and images

Commit: `5b02b1d`

User evidence showed a Stumble card whose picture was an mShots screenshot of The Verge’s 404 page.
The exact persisted URL was:

```text
https://www.theverge.com/2020/1/1/21078720/the-power-of-habit-review
```

Live replay of the persisted deal/spool found 10 bad or unverifiable cards out of 11. The original
renderer was fail-open on batch errors and admitted unknown/403/challenge/empty results.

The fix:

- Added pure `isVerifiedDiscoveryResult()` and `isFreshDiscoveryItem()` predicates in
  `web/lib/capture-state.js`.
- Strictly reject non-2xx, suspect, empty, challenge, redirect-home, and wrong-article pages.
- Clear the old fail-open spool/deal once via `ia_stvalver = 2`.
- Expire validated recommendations after 30 minutes.
- Prefer the page’s `og:image`; use mShots only as a fallback for a page already verified live.

### v1.11.2 — grounded OpenRouter search and lower latency

Commit: `f1ff2b9`

v1.11.1 was correct but too strict and slow in practice. Diagnosis found:

- The selected provider was OpenRouter with `openai/gpt-4o-mini`.
- The app told OpenRouter to “search the web” but did not enable a search tool.
- The model therefore invented deep URLs, which strict validation correctly removed.
- Validation fetched each candidate up to three times.
- A four-card deal waited for a second full AI batch even when the first batch had survivors.

The v1.11.2 fix:

- `web/ai.js` enables OpenRouter’s official server tool only when Stumble calls
  `callAI(prompt, {webSearch:true})`:

  ```js
  {
    type: "openrouter:web_search",
    parameters: {
      max_results: 6,
      max_total_results: 6,
      search_context_size: "low"
    }
  }
  ```

- Other OpenRouter tasks do not use or pay for web search.
- Stumble asks for 4–6 candidates based on deal size rather than 15.
- Prompt history was trimmed; local duplicate checking still covers the complete Saved collection.
- `validateItems()` now makes one `/api/check-content` request. That guarded GET already provides
  final status, content signals, page title, and `og:image`; separate status/image probes were
  redundant.
- A returned `og:image` is rendered immediately. Browser `onerror` falls through to mShots.
- Cached survivors deal immediately.
- The first non-empty AI batch deals immediately; remaining slots refill quietly.

Live measurements with the configured model:

| Path | Candidates | Verified survivors | AI | Validation | Total |
|---|---:|---:|---:|---:|---:|
| Pre-optimization | 9 | 9 | 27.3 s | 3.1 s | 30.4 s |
| v1.11.2 | 6 | 5 | 13.0 s | 1.7 s | 14.7 s |

The v1.11.2 live batch returned enough verified pages to fill the user’s four-card deal. Two had
direct `og:image` values; the others use screenshots of pages already proven live.

---

## 7. Current Stumble data flow

Primary code: `web/index.html`, `web/ai.js`, `web/lib/capture-state.js`.

```text
buildPrompt("stumble")
  → callAI(prompt, {webSearch:true})
  → parseItems()
  → dropAlreadySaved()
  → validateItems()
       → Store.checkContent() once for all candidates
       → isVerifiedDiscoveryResult()
       → attach page og:image when present
       → stamp liveCheckedAt
  → rankFilter() when Open PageRank is enabled
  → append survivors to spool
  → deal cached/first survivors immediately
  → refill remaining slots in background
```

Relevant persisted KV keys:

- `ia_spool`
- `ia_stdeal`
- `ia_stsize`
- `ia_stvalver`
- `ia_shown`
- `ia_fcat`
- `ia_tab`

At diagnosis, deal size was 4 and category filter was empty. Treat that as historical observation,
not a permanent default.

---

## 8. How to diagnose Stumble with evidence

The service normally starts on 3456 and falls back through 3465.

```powershell
Invoke-RestMethod http://127.0.0.1:3456/api/ping
```

Useful read-only probes:

- `/api/ping`
- `/api/kv/ia_stdeal`
- `/api/kv/ia_spool`
- `/api/kv/ia_stsize`
- `/api/kv/ia_fcat`
- `/api/check-content`

When a card is wrong:

1. Pull its exact URL from `ia_stdeal`.
2. POST that URL to `/api/check-content`.
3. Inspect final status, title, verdict, signals, and `ogImage`.
4. Reproduce before changing code.
5. Add a regression test using the real title/URL pattern.

When Stumble is slow:

1. Time the AI request separately from `/api/check-content`.
2. Count model candidates and accepted survivors.
3. Check whether a category filter hides otherwise valid spool entries.
4. Check `ia_stsize`; four-card mode naturally needs more survivors.
5. Do not weaken strict content acceptance merely to increase yield.

### Secret-handling warning

Never print `ia_settings` wholesale: it contains provider keys. Redact or select only non-secret
fields. During the last diagnosis the OpenRouter key was accidentally emitted into the local Codex
tool transcript. Dave was told to rotate it. At the beginning of the next session, confirm that he
rotated the key and updated Settings. **Do not copy the old key into any file, issue, prompt, commit,
or chat response.**

---

## 9. Tests most relevant to recent work

- `tests/ai-module.test.js`
  - OpenRouter search tool appears only when `{webSearch:true}` is requested.
  - Search result/context/output caps are pinned.
- `tests/capture-state.test.js`
  - Strict 2xx/content/title acceptance.
  - Real Verge 404 regression.
  - Challenge/empty/wrong-article rejection.
  - 30-minute freshness boundaries.
- `tests/feed-validate.test.js`
  - One content probe, no redundant link/image probe in Stumble.
  - Fail-closed behavior.
  - Page `og:image` wiring.
  - Grounded search call.
  - 4–6 candidate cap.
  - Immediate cached/partial deal behavior.
- `tests/contentcheck*.test.js`
  - Entity decode, soft-404 phrases, challenge signals, redirects, `ogImage`.
- `tests/mass-delete-guard.test.js`, `tests/db*.test.js`, `tests/sync*.test.js`
  - Data-safety invariants.

The full v1.11.2 suite passed and printed `ALL TEST FILES PASSED` immediately before release.

---

## 10. Git and release workflow

For a user-facing change:

1. Start from updated `master`.
2. Create a small feature branch.
3. Write the failing regression test first where practical.
4. Implement the smallest complete fix.
5. Run `node tests/syntax-check.js`.
6. Run targeted tests.
7. Run `npm test` and verify the final success line.
8. Bump `package.json` to a distinct version.
9. Update `docs/BACKLOG.md`.
10. Commit, fast-forward merge to `master`, and push.
11. Run `npm run dist`.
12. Report the installer path and remind Dave to verify the version via **?**.

Do not tag, push, or build on a red suite. Do not commit personal data or local control folders.

---

## 11. Recommended first actions for Claude

1. Ask Dave whether v1.11.2 is installed and confirm the version shown by **?**.
2. Ask whether the OpenRouter key was rotated after the diagnostic transcript exposure.
3. Run `git status --short --branch` and preserve the untracked local control files.
4. Run `npm test` before making changes.
5. Reproduce any new report against the exact running version and exact card URL.
6. Keep strict live-page validation; improve grounding, batching, or UX instead of admitting
   unknown/dead pages.
7. If no bug is currently reported, the next large planned effort remains the iPhone companion
   described in `docs/iphone-sync-design.md`.
