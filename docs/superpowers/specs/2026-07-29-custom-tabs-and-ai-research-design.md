# Custom tabs + AI research assistant — design

## Goal

A new "Tabs" nav area for user-defined card collections (e.g. "STL files"),
populated individually, in bulk, or via an on-demand AI suggestion sweep.
One tab is reserved and built-in: **🤖 AI** — cards flagged here can get a
one-click AI-drafted article and/or answers to typed questions, both with
cited sources, attached to the card.

Entirely a **web/pwa client-side feature**. No `core/` (backend service),
`core/db.js` schema, or sync/backup changes — tabs are tags, and research
output is just more data in a card's existing free-form JSON blob.

## Core mechanic: a tab is a pinned tag

Cards and saved items already carry a shared `tags` array (`web/index.html`'s
existing tag picker + `autoTag()` AI-suggestion feature, spanning both
`imported` and `saved`). A tab does not introduce a second organizing system:

- Creating a tab named "STL files" creates/reuses the tag `"stl files"` and
  adds `{id, name:"STL files", tag:"stl files", reserved:false, createdAt}`
  to a new `ia_tabs` KV array (mirrors how `ia_fcat`/other small config lists
  are stored today).
- A card is "in" a tab iff `tag` is present in the card's `tags` array.
  Opening a tab = filtering `imported.concat(saved)` by that tag — the same
  predicate shape `impFilterPredicate` already uses for other filters.
- Adding/removing a card from a tab = adding/removing that one tag. No new
  membership table, no new persistence path — goes through the same
  `persistCards`/`Store.putSaved` calls every tag edit already uses today.
- **Delete tab** unpins it (removes the `ia_tabs` entry) but does **not**
  strip the tag from cards — non-destructive by default, consistent with the
  project's "never lose user data without explicit intent" rule. The tag
  simply stops being pinned as a tab; re-creating a tab with the same name
  re-attaches to exactly the same cards.
- No reordering, no nesting, no multi-tag (AND/OR) smart tabs in v1 — YAGNI.
  A card can belong to any number of tabs simultaneously, same as it can
  carry any number of tags today.

## The reserved 🤖 AI tab

- Auto-created once (like a `DEFAULTS`-seeded value) if `ia_tabs` has no
  `reserved:true` entry yet — always present, always last in the pill row,
  cannot be renamed or deleted.
- Backed by a **namespaced** tag (e.g. `"__ai_research__"`) rather than a
  plain user-typed word, so it can never collide with a tag a user happens
  to type, and is filtered out of the normal tag picker / `autoTag`
  suggestion list (it's an implementation detail, not a word the user picks).

## Data model additions

**`ia_tabs`** (new KV key, small JSON array, same storage tier as
`ia_fcat`/`ia_itag`):
```
[{ id, name, tag, reserved: boolean, createdAt }]
```

**Per-card `research`** (new optional field inside the existing free-form
card/saved object — no `core/db.js` column, no migration; it round-trips
through the same `data` JSON blob every non-core-column field already uses):
```js
research: {
  article: { text, sources: [url], generatedAt } | null,
  qa: [{ question, answer, sources: [url], answeredAt }]
}
```
Only ever present on cards that have been flagged into the AI tab and
researched at least once. Absent = untouched, same as a card with no `tags`.

## UI: navigation

- New **"Tabs"** button in the main nav (`web/index.html` + `pwa/index.html`,
  both the desktop header and the mobile `mtabbar`), opening a pill-row
  sub-bar of the user's tabs (name + live count of matching cards) plus
  **"+ New tab"**. Keeps the main nav at a fixed width regardless of how many
  tabs exist.
- Clicking a pill shows that tab's filtered grid (reuses the existing card
  grid renderer).

## UI: populating a tab

- **Individual**: the existing per-card tag picker gets tabs shown as a
  starred/pinned section at the top (a tab is just a tag, so "add this card
  to STL files" *is* "add the tag `stl files`" — no parallel UI).
- **Bulk**: a **"Select"** mode toggle on the Saved/Imported grids AND inside
  an open tab (checkboxes on cards) + a bulk action bar. From Saved/Imported:
  "Add to tab ▾" (pick one or more tabs). From inside a tab: "Remove from
  tab" (strips just that one tag from the selection).
- **AI suggest** ("✨ Suggest cards" button on a tab): on-demand only, no
  background/automatic scanning. Batches candidate cards (title/description,
  capped similarly to `autoTag`'s existing 40-item batching) against the
  tab's name as the theme, through the user's configured default AI
  provider. Results go through the **same accept/reject review UI pattern**
  `autoTag`'s suggestion picker already uses — nothing new to design there.
  Accepted cards get the tag applied.

## UI: the AI tab

Same tab mechanism, plus per-card:

- **"Research & draft article"** button (only shown before an article
  exists) — one AI call, no user input needed, writes `research.article`.
- **"Ask a question"** input, always available — user types a question,
  gets a researched, sourced answer appended to `research.qa` (list keeps
  growing; entries are not edited in place, only added — deleting an entry
  is the only mutation).
- Article panel: inline expand/collapse, **Edit** (plain textarea over
  `research.article.text`), **Regenerate** (replaces the article — no
  version history, kept simple), **Copy** (clipboard).
- Both actions are **on-demand only, per-card, user-clicked** — never
  automatic — so there is no surprise AI-provider spend.

## AI integration

- Reuses the existing per-provider call functions (`callAnthropic`/
  `callOpenAI`/`callGemini`/`callGroq`/`callLocal`) — new prompt templates,
  not new network plumbing. Parses **plain article text + a source-URL
  list**, not the app's existing card-list JSON schema (`parseItems`) —
  a distinct, small parser for this one response shape.
- **Requires a web-search-capable provider** (Anthropic/OpenAI/Gemini today
  per `CLAUDE.md`; Groq and Local are not). If the user's configured default
  provider doesn't support web search, "Research & draft article" and "Ask a
  question" show a clear toast pointing at Settings rather than silently
  running an ungrounded call that could hallucinate "research."
- Errors (network, provider failure, empty result) → toast, no partial/corrupt
  write to `research` — same failure posture as the rest of the app's AI
  calls (e.g. title generation's tiered fallback).

## Out of scope (v1)

- Automatic/continuous AI tagging of new cards against tab themes (the
  on-demand sweep covers this deliberately, per cost discussion).
- Multi-tag (AND/OR) smart tabs, tab reordering/nesting.
- Article version history, Q&A answer editing, export/publish beyond copy.
- Any `core/` (backend), sync-wire-format, or backup/restore changes — a
  tab and its research data sync/back up exactly as any other card edit
  already does today.

## Testing

Follows existing repo conventions (`node tests/<name>.test.js`, plain
`assert`, web/pwa parity via `tests/surface-parity.test.js`-style checks):

- Tab CRUD (`ia_tabs` create/rename/unpin, reserved-tab bootstrap-once).
- Tag-based filtering (a card with/without the tab's tag in/out of the view).
- AI-suggest batching/review flow (mocked provider call, accept/reject).
- `research` field shape (article write/regenerate, Q&A append, no mutation
  of prior entries) — pure-logic tests, no DB involved since this never
  touches `core/`.
- Provider capability gate (Groq/Local configured → feature shows the toast,
  never calls out).
