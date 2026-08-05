# Roll back a renamed title to its original — design

## Goal

After a card's title has been changed (by hand, or by any AI title-rename
path), let the user restore it to whatever the title was before the very
first rename touched it — not just "undo the last change," but "get back
to the original."

## Storage: `card.origTitle`

One new plain string field, set automatically the first time a rename
would actually change something:

- Captured **once** — the first rename after a card is created (or after
  a previous rollback) stores the pre-rename title into `card.origTitle`.
  Every rename after that leaves `origTitle` untouched, so it always
  points at the true original no matter how many times the title changes
  in between.
- **Cleared** the moment the current title is restored to match
  `origTitle` again (via either rollback surface below, or coincidentally
  if a later rename happens to land back on the exact original text) —
  at that point there's nothing left to roll back to, and the next rename
  starts a fresh baseline.
- No special handling needed anywhere else: like `tags`/`desc`/`titleSet`,
  it's a plain field on the card object and rides along through existing
  backup/restore/Dropbox-sync/Notion-export code paths unchanged — this
  project has no card-field allowlist that would need updating (confirmed
  precedent: `aiRefreshedAt`, added earlier this session, needed none).

Two small shared helpers, called at every title-write site:

```js
// Captures the card's true original title, once, the first time a rename
// would actually change something — never overwritten again.
function captureOrigTitle(card, newTitle){
  if(!card || !newTitle || card.title===newTitle) return;
  if(card.origTitle===undefined) card.origTitle = card.title;
}
// Clears origTitle once the current title matches it again — nothing
// left to roll back to.
function settleOrigTitle(card){
  if(card && card.origTitle!==undefined && card.title===card.origTitle) delete card.origTitle;
}
```

Every title-write site follows the same three-line pattern:
`captureOrigTitle(card, newTitle); card.title = newTitle; settleOrigTitle(card);`

## Write sites

Every AI-driven title rename already funnels through one shared function,
`applyGeneratedTitle(card, rawTitle)` (`web/index.html:6498`) — the single
choke point for the per-card "Aa" refresh button, the auto-title-on-open
path, the Title-issues panel, and the batch retitle tool. That's where the
capture/settle calls go for every AI path in one place.

The two manual edit-save paths get the same three-line pattern added
directly: `cardEditSave()` (`web/index.html:4862`, Saved cards) and
`impEditSave()` (`web/index.html:4982`, Imported cards). `impEditSave`
currently writes `it.title` without the 250-char cap `cardEditSave` uses —
a pre-existing inconsistency this feature deliberately leaves alone
(out of scope; not introducing a behavior change beyond origTitle
tracking).

## Two rollback surfaces

**1. Imported/Tabs card grid** — a small icon next to the existing "Aa"
AI-title button in `impCardHTML()` (`web/index.html:4754`), visible only
when `it.origTitle !== undefined` (same hover-reveal CSS group as the
existing `.imp-edit`/`.imp-refresh`/`.imp-reader`/`.imp-title` buttons —
`.imp-revert` joins that same selector list). Applies immediately, no
review step — matching `impRefreshTitle`'s own existing precedent ("no
review step here, same as the ↻ image refresh it sits beside"):

```js
function impRevertTitle(idx){
  const it = imported[idx]; if(!it || it.origTitle===undefined) return;
  it.title = it.origTitle;
  settleOrigTitle(it);
  persistCards();
  if(curTab==="imported"){ anchorImpOnCard(it); renderImported(); restoreImpScrollSettle(); } else refreshTabsViewIfShowing();
  toast("Title reverted to: "+it.title, 7000);
}
```

**2. The edit modal** — shared by both `impEdit()` (Imported,
`web/index.html:~4810`) and `cardEdit()` (Saved, `web/index.html:~4852`),
both of which already render the same `#edTitle` input and an "AI title
lookup" button next to it. A "Revert to original" button joins it,
visible under the same condition, and follows `edAiTitle()`'s existing
"stage into the input for review, nothing stored until Save" contract
rather than applying directly:

```js
function edRevertTitle(){
  const box = document.getElementById("edTitle"); if(!box) return;
  const card = _edScope==="saved" ? saved.find(x=>x && x.id===_edSavedId) : imported[_editIdx];
  if(!card || card.origTitle===undefined) return;
  box.value = card.origTitle;
  box.focus();
}
```

Saving after a staged revert goes through the normal
`cardEditSave`/`impEditSave` path, which (per the three-line pattern
above) settles `origTitle` away once the saved title matches it.

## Out of scope

- The Title-issues health panel — that tool is about generating *better*
  titles going forward, not undoing to a title that was likely already
  flagged as generic/bad.
- A multi-level undo history — only ever the single true original.
- Fixing `impEditSave`'s pre-existing missing 250-char cap.

## Review

This is a client-side card-field/UI feature — no backup/restore/import
code is touched, so it follows this project's standard review path (not
the data-safety-reviewer, which is reserved for changes to those specific
subsystems).

## Testing

- Pure-function tests for `captureOrigTitle`/`settleOrigTitle`: captures
  once and never again across multiple renames; no-ops when the "new"
  title equals the current one; clears exactly when the title returns to
  match `origTitle`.
- `applyGeneratedTitle` gains origTitle capture/settle without changing
  its existing hashtag/tag behavior (regression coverage against this
  session's existing tests for that function).
- `cardEditSave`/`impEditSave` capture on first manual rename, don't
  re-capture on a second, and settle on a save that restores the original.
- `impRevertTitle`: no-ops when `origTitle` is unset; applies directly and
  clears `origTitle` when set.
- `edRevertTitle`: stages the value into the input without touching the
  card; no-ops when `origTitle` is unset.
- UI-markup tests: the revert icon/button only renders when
  `origTitle !== undefined`, in both the card grid and both edit-modal
  templates.
- Byte-identity check between `web/index.html` and `pwa/index.html` for
  every touched function, per this project's standing convention.
