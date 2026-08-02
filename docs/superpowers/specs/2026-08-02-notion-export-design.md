# Export card research to Notion — design

## Goal

Let the user export a card's AI-generated article + Q&A research to Notion
as a new page, from a button in the research panel (the reserved 🤖 AI
tab). Requested by the user during Plan 3 live-testing (2026-07-31),
scoped there as "for later" — see `notion-export-backlog` memory.

**Electron/web build only.** Notion's API does not support CORS (confirmed
live: browsers cannot call `api.notion.com` directly — no
`Access-Control-Allow-Origin`), so this needs the bundled Core HTTP
service as a server-side relay. The PWA build has no such service and
gets a "Not applicable" stub, matching backup/restore/move today.

## Architecture: mirrors the existing Google Safe Browsing key pattern

This app already has one precedent for "store a third-party API secret and
call that service server-side": Safe Browsing
(`core/config.js:237-246`'s `getSafeBrowsingKey`/`setSafeBrowsingKey`,
`core/server.js:1087-1107`'s `/api/safebrowsing-key` GET/POST +
`/api/safebrowsing-verify`). Notion export follows the identical shape,
not the AI-provider-key shape (`S.keys.*`, called directly from the
browser) — because the call MUST happen server-side, and because a Notion
secret, like a Safe Browsing key, has no reason to round-trip through
Dropbox settings-sync the way AI-provider keys deliberately do (per
CLAUDE.md's privacy note on `ia_settings` sync).

**`core/config.js`** — two new fields on the same `config.json`, same
`loadConfig()`/`saveConfig()` atomic-write helpers, same
get/trim-on-set/never-round-trip-the-raw-value-back convention as
`getSafeBrowsingKey`/`setSafeBrowsingKey`:
```js
function getNotionConfig() {
  const cfg = loadConfig();
  return { token: typeof cfg.notionToken==="string"?cfg.notionToken:"",
           parentPageId: typeof cfg.notionParentPageId==="string"?cfg.notionParentPageId:"" };
}
function setNotionConfig(token, parentPageId) {
  const cfg = loadConfig();
  cfg.notionToken = typeof token==="string" ? token.trim() : "";
  cfg.notionParentPageId = typeof parentPageId==="string" ? parentPageId.trim() : "";
  saveConfig(cfg);
}
```

**`core/server.js`** — three new routes, same shape as the Safe Browsing
trio:
- `GET /api/notion-config` → `{hasToken: bool, hasParent: bool}` (never
  the raw values).
- `POST /api/notion-config` → body `{token, parentPageId}`, sets both,
  returns `{ok:true, hasToken, hasParent}`.
- `POST /api/notion/export` → body `{title, url, article:{text,sources},
  qa:[{question,answer,sources}]}` (the card's exportable content, built
  client-side from `it.research` — see Content mapping below). Server
  builds the Notion API request (block content, see below), calls
  `https://api.notion.com/v1/pages` with the stored token (Node's
  `fetch`, no CORS issue — same pattern as
  `core/safebrowse.js`'s `checkUrls`), and returns `{ok:true, pageUrl}` or
  `{ok:false, error}`. Async, wrapped in try/catch, same error-response
  shape as `/api/check-safety`.

**`web/storage.js`** — matching `Store.*` adapter methods
(`getNotionStatus`, `setNotionConfig`, `exportToNotion`), same
`jget`/`jsend` helpers every other `Store` method already uses.

**`pwa/storage-pwa.js`** — the same three methods stubbed
`{ok:false, reason:"Not applicable on iPad — Notion export needs the
desktop app's local service."}`, matching the existing
`getSafeBrowsingKey`/`setSafeBrowsingKey`/`verifySafeBrowsing` stubs.

## Settings UI

A new small section in `renderSettings()`, modeled directly on the
existing Safe-Browsing-key UI (`web/index.html:2188-2211`'s `SB_MASK`,
`loadSafetyKeyStatus()`, `saveSafeBrowsingKey()` pattern): a masked
integration-secret input, a plain parent-page-ID input (Notion shows this
in the page's URL — the settings copy should say so), a Save button, and
a status line reflecting `{hasToken, hasParent}`. No "Verify" call against
Notion's API in v1 (Safe Browsing's verify step checks quota/validity;
Notion's cheapest equivalent, a `GET /v1/users/me` call, is a nice-to-have,
not required for v1 — the first real export attempt is the de facto
verification).

## Export UI

One more `.btn-ghost` button in `researchPanelHTML`'s existing
Copy/Edit/Regenerate row (`web/index.html:3848-3853`), labeled "Export to
Notion." Shown whenever the card has an article (`it.research.article`)
or at least one Q&A entry (`it.research.qa.length`) — nothing to export
otherwise. Capability is checked inside the click handler, not by hiding
the button — matches the existing `generateArticle`/`askQuestion` gating
convention (`hasResearchProvider()`/`IA_AI.hasAIKey()` checks +
`toast()` + early return, `web/index.html:3772-3773`): the handler awaits
`Store.getNotionStatus()`, and toasts one of "Not applicable on iPad…",
"Add your Notion integration in Settings first," or "Set a target page in
Settings first" before attempting the export.

## Content mapping

Client builds the export payload from `it.research` (already-existing
shape, `it.research.article = {text, sources, generatedAt}`,
`it.research.qa = [{question, answer, sources, answeredAt}]` — no new
card fields). Server turns it into Notion blocks:
- Page title = card title (`it.title`).
- First block: a paragraph linking back to the card's source (`it.url`),
  if present.
- Article (if present): paragraph blocks, one per paragraph (split on
  blank lines) — any single paragraph over Notion's 2000-character
  rich-text-segment limit gets hard-split across multiple `rich_text`
  entries within one block (Notion allows an array of rich-text segments
  per block; this is not a block-count problem, just a segment-length one).
  Followed by a small bulleted list of the article's cited source URLs, if
  any.
- Each Q&A pair (if any): a `heading_3` block with the question text,
  paragraph block(s) for the answer (same paragraph-splitting rule as the
  article), then a bulleted list of that answer's cited sources, if any.

## Out of scope (v1)

- No re-export/update tracking — every export creates a new Notion page
  (confirmed decision). A duplicate from re-exporting is the user's to
  clean up in Notion.
- No database target — parent-page-only, no Notion database schema
  mapping.
- No OAuth — internal-integration token only (user pastes it from
  `notion.so/my-integrations`; the parent page must be explicitly
  "connected" to that integration from Notion's own UI first — this is a
  one-time manual step in Notion, outside the app, documented in the
  Settings copy, not something the app can automate).
- No bulk export (one card at a time, from the research panel).

## Testing

- Plain-`assert` tests for: `core/config.js`'s
  `getNotionConfig`/`setNotionConfig` (mirrors existing
  `getSafeBrowsingKey`/`setSafeBrowsingKey` tests); the block-building
  logic (paragraph splitting, 2000-char hard-split, Q&A block shape) as a
  pure function, independent of the actual Notion HTTP call; the
  `/api/notion-config` and `/api/notion/export` routes via a mounted
  `createServer()` test (matching this project's HTTP route test
  convention), with the outbound Notion call mocked/injected the same way
  `core/safebrowse.js` is exercised in existing tests.
- Manual smoke test (this feature needs a real Notion workspace + a real
  integration token — cannot be fully automated): paste a real token +
  parent page ID in Settings, export a card with both an article and Q&A,
  confirm the resulting Notion page's content and formatting.
- `pwa/storage-pwa.js` stub coverage: confirm the three new methods return
  the "Not applicable" shape, matching existing stub tests' pattern.
