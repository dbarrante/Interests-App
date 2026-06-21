# Design: Duplicate scan/review + Tags sidebar toggle

Date: 2026-06-20
App: Interests App (`index.html`, single-file vanilla web app; state in `localStorage` under `ia_*`; card images in IndexedDB `ia_img`/`imgs` via `idb:<id>` refs mirrored in `_imgCache`).

Two self-contained features added to the Imported workflow.

---

## Feature A — Duplicate scan + review

### Goal
Go beyond today's exact same-link dedup (`groomDupes`, one-click) with **fuzzy-title** matching, a **review step**, and coverage of **both Imported and Saved**.

### Detection
Two cards are duplicates if they share **either**:
1. **Normalized link** — `normalizeUrl(it.url)` (existing helper; FB story_fbid/v/fbid handling already inside `clipKey`/`normalizeUrl`). Always counts.
2. **Near-identical title** — `normTitle(title)`:
   - lowercase; replace `&nbsp;`/NBSP with space
   - strip emoji and punctuation (keep alphanumerics + spaces)
   - drop trailing `… see more` / `... more`; drop leading `saved …` and `from your '<x>' … collection`
   - collapse whitespace; trim
   - **Title match is ignored** when the normalized title has `< 10` chars or `< 2` words (prevents grouping generic/empty titles like "facebook post"). Link match has no such gate.

Grouping spans **both `imported` and `saved`**. Each card in a group carries its scope (`"imported"`/`"saved"`) and its index so removal targets the right array. Use union grouping so a card linked by URL to one card and by title to another lands in one group.

### Keep-the-best (auto-selected primary)
Within a group, score each card and keep the highest; pre-check the rest for removal. Score priority (desc):
1. has a real image (`!isBadImg(resolveImg(img/image))`)
2. has a non-generic `desc`
3. has `tags.length`
4. has a real `sdate`
5. scope: a **Saved** card outranks an **Imported** card (Saved = deliberate keep)
6. tiebreak: older `ts`/`sdate`

The kept copy **absorbs** the best fields from removed members (mirrors `groomDupes`): image (if kept's is bad and a removed one is good), `desc`, `sdate`, `tags` (union), `liked`, earliest `captured`, `blocked`. Cross-scope note: if the kept card is Saved it uses `item.image`/`setSavedImage`; if Imported it uses `it.img`/`setCardImage`.

### Review modal
Reuse the existing `#modal`. Render duplicate **groups**; per group show each member as a row: thumbnail (`resolveImg`/`imageChain` first frame), title, source/domain, a scope badge (Imported/Saved), and the saved date. The auto-kept member is highlighted/labelled "Keep"; the others have a checkbox **pre-checked** ("Remove"). Controls: click a different row's "Keep" to reassign the primary (re-checks the others); uncheck any row to spare it. Footer: "**Remove N selected**" + "Cancel" + a running count. Empty result → toast "No duplicates found".

### Removal
On confirm: for each group, merge best fields into the kept card, then remove the checked members from their respective array (`imported` / `saved`), and delete each removed card's orphaned image from IndexedDB (`idbDelImg(id)` + `delete _imgCache[id]`) — matching `groomDupes`. Persist (`save("imported")`, `save("saved")`, `writeSavesFile()`), `updateCounts()`, re-render the current tab, toast the count. **Safety model:** the review is the safeguard + a confirm; no separate undo (consistent with current dedup; user backups remain). [Open option: add an undo toast if requested — not in scope unless asked.]

### UI placement
The Imported toolbar's existing **"🧾 Remove N duplicates"** button is **replaced** by **"🔎 Scan duplicates"** (always available; the count is discovered by the scan, not precomputed in the toolbar to keep it cheap). `dupeCount()`/`groomDupes()` may be removed or kept as internal helpers — the button calls the new scan/review path.

### New functions
`normTitle(t)`, `scanDuplicates()` → `[{members:[{card,scope,idx}], keepId}]`, `dupePrimary(members)`, `openDupeReview(groups)`, `applyDupeRemoval(selection)`.

---

## Feature B — Tags in a left sidebar (Settings toggle, Imported only)

### Setting
`S.tagSidebar` (boolean, default `false`), persisted with the rest of settings. A toggle in the Settings panel: **"Tags in a left sidebar (Imported view)."** Toggling it re-renders Imported.

### Layout
In `renderImported`, branch on `S.tagSidebar`:
- **OFF (today):** top horizontal tag bar (`tagBarHTML()`) inside the sticky region.
- **ON:** omit the top tag bar; render the Imported body as a two-column row:
  `<div class="imp-body"> <aside class="tag-side">…vertical tags…</aside> <div class="imp-grid …">…cards…</div> </div>`
  - `.tag-side` ≈ 210px, **sticky** (top = below the sticky search/filter toolbar, reusing the `--catBottom`/sticky-offset machinery), own vertical scroll if long.
  - Same tag data/behavior as `tagBarHTML` (tag + count, active-tag highlight via `setImpTag`, "untagged", clear); just laid out vertically. Factor the tag list into a shared producer used by both the bar and the sidebar.
- The sticky search/filter row (`.imp-sticky`) is unchanged in both modes (tags simply move out of it when sidebar is on).

### Responsive
At `< ~760px` viewport, the sidebar layout falls back to the top tag bar (CSS media query hides `.tag-side`, or `renderImported` ignores the setting below a width) so cards aren't crushed.

### Scope
Imported only. Saved/Feed unchanged. (Saved sidebar explicitly out of scope per the decision.)

---

## Out of scope / non-goals
- Same-image (perceptual) duplicate matching — not requested; fuzzy title covers reposts.
- Saved-tab tag sidebar.
- Undo for duplicate removal (unless requested).
- Any change to the capture/extension pipeline.

## Testing
- `node --check`-style inline-script syntax check of `index.html` after edits.
- Logic unit-checks (node) for `normTitle` (emoji/punct/See-more/casing → same key; short/generic → no title-group) and `scanDuplicates` grouping (link-only group, title-only group, cross-scope group, no false group on generic titles) against sample data and/or the on-disk backup `interests-backup-2026-06-19.json`.
- Manual: hard-reload the app; run Scan duplicates → review modal shows groups → remove → counts drop, kept copies retain best image; toggle the Settings sidebar option → tags move left on Imported, top bar returns when off, narrow-window fallback.
