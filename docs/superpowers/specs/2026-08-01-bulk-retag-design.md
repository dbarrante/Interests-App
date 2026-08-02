# Bulk re-tag — design

## Goal

Let the user apply a tag to many cards at once, from any tag in the app
(existing or brand new) — not just a Custom Tab's tag, which is all the
current bulk toolbar supports. Works the same way in all three places a
multi-select toolbar already exists: Saved, Imported, and an open Custom Tab.

Entirely a **web/pwa client-side feature**. No `core/` (backend service) or
`core/db.js` schema changes — this reuses the existing tag data model and
persistence path; only the bulk-select toolbars and the tag-picker call site
change.

## Current state (context, not being changed)

- Every card already carries a `tags` array, edited one card at a time via
  `openTagPicker(scope, identity, ev)` — lists every tag in use (`allTags()`)
  with toggle-on/off, plus "create a new tag."
- Saved, Imported, and the open-Tab detail view each already have their own
  independent multi-select mode (`savedSelMode`/`selMode`/`tabSelMode`, each
  with its own `Set` of picked card ids/indices) and toolbar.
- Today, each of those toolbars' bulk-tag action is a dropdown sourced only
  from `tabs[]` (Custom Tab tags), applied via the existing pure function
  `bulkAddTag(items, tag)` — adds one tag to every item in the set, skipping
  ones that already have it.
- A Custom Tab is just a pinned tag (`t.tag`); a card is "in" a tab iff that
  tag is present in `card.tags`. This means applying any Custom Tab's tag
  through the tag picker is indistinguishable from adding the card to that
  tab — no special-casing required anywhere in this feature.

## What changes

**One new shared component:** a bulk variant of the tag picker — same
list-existing-tag-or-create-new UI as `openTagPicker`, but its confirm action
calls `bulkAddTag(picks, tag)` against a selection set instead of mutating
one card, and its header reads "Apply tag to N selected" instead of a card
title.

**Three call sites, one pattern, in all of Saved, Imported, and the open-Tab
view:**
- Replace the current "add to tab" dropdown button in each bulk-select
  toolbar with a single **"Apply tag…"** button.
- Clicking it opens the shared bulk tag picker, scoped to that section's
  current `*SelPicks` set.
- Confirming: `bulkAddTag(picks, tag)` → persist via the same
  `Store.putSaved`/`Store.putCards` calls every tag edit already uses →
  toast (e.g. *"Tagged 12 cards with 'travel'"*) → exit select mode, same
  as the existing bulk-action pattern (mirrors `addSavedPicksToTab`'s
  finish-up sequence).
- The open-Tab view's existing separate "remove from this tab" bulk action
  is untouched — it keeps working alongside the new "Apply tag…" button.

**Out of scope (YAGNI, confirmed):**
- No bulk tag *removal* in this pass — add-only.
- No cross-section selection — each section's existing independent
  multi-select stays independent; this only changes what each one's tag
  button does.
- No new selection UI, no new persistence path, no `core/` changes.

## Data flow

```
user selects N cards (existing selMode/selPicks, per section)
  → clicks "Apply tag…"
  → shared bulk tag picker: pick existing tag OR type new one
  → confirm
  → bulkAddTag(picks, tag)   // pure, already exists, unchanged
  → Store.putSaved(...) / Store.putCards(...)   // existing persistence path
  → toast + exit select mode
```

## Testing

- Plain-`assert` tests (this project's convention, `node tests/<name>.test.js`)
  covering: the bulk picker applies the tag to every picked card and skips
  ones that already have it (reuses `bulkAddTag`'s existing guarantee — the
  new test is about the *wiring*, not re-testing `bulkAddTag` itself);
  creating a brand-new tag via the bulk picker behaves the same as via the
  single-card picker; each of the three call sites (Saved, Imported, open Tab)
  independently exercises the shared component correctly.
- Byte-identity check between the touched functions in `web/index.html` and
  `pwa/index.html` — required project convention, both files must stay in
  sync for every function this feature touches.
