# Instagram Import (data-download export) Design

**Date:** 2026-06-28
**Status:** Approved (design); ready for implementation planning
**Topic:** Add Instagram as an import source alongside the existing Facebook / Pinterest / YouTube importers, reading the user's Instagram "Download your information" export so saved Instagram posts become taste-signal cards in the Imported tab.

---

## Goal

Let the user drop their Instagram data-download export (the ZIP, or the `saved_posts.json` inside it) into the existing **Settings → "Import your saves"** control and have their **saved Instagram posts** appear as Imported cards — exactly like Facebook/Pinterest imports — feeding the AI's interest profile. Decided with the user: **saved posts only** (not likes — a like is a noisier signal than a deliberate save).

This is v2 backlog #4. It reuses the entire existing import pipeline; the only new logic is an Instagram-specific parser.

## Decisions locked with the user (2026-06-28)

1. **Saved posts only** — parse `saved_saved_media`; ignore `likes_media_likes` and other shapes.
2. **Imported cards (taste signals), not Saved clips** — consistent with the existing FB/Pinterest/YouTube imports (the "Import your saves" section feeds the Imported tab / interest profile, never the Saved tab).
3. **Extract the parser as a pure, testable module** (not inline like `parseFacebookJSON`) — imports mutate the library, so the new code gets real unit tests.

## Non-goals

- Liked posts, your-own-posts, followers/following, or any IG shape other than saved.
- Fetching IG captions/images at import time (IG's export carries neither for saved posts — enrichment happens later via the capture extension when a card is opened, same as FB/Pinterest).
- Any change to dedup, the Imported tab, the capture extension, or the import UI flow beyond adding Instagram.

---

## Architecture

The import pipeline already exists in `web/index.html`:

```
Settings #impFile (accept .json/.html/.txt/.csv/.zip)
  -> handleImport(ev)
       -> per file: parseZip(f)  (JSZip; iterates entries; path filter already includes "saved"/"liked")
                    OR parseImportText(text, name)
       -> parseImportText: try parsePinterestSAR -> parseFacebookJSON -> [NEW] parseInstagramSaved -> generic harvest
       -> dedup into `imported` cards (by title/url, junk filter, enrich existing, push new), cap 10000
       -> Store.putCards(imported)
```

The only new piece is the Instagram parser, slotted into `parseImportText` before the generic `harvest` fallback. Everything else — ZIP unpacking (`parseZip`'s path filter `/saved|collection|.../i` already matches `saved_posts.json`), `clean()` normalization, `normTs()` timestamp handling, `srcHint()` source tagging, dedup, the Imported tab — is reused unchanged.

### New unit: `web/import-instagram.js`

A pure, dual-module file (browser global + `module.exports`, the `web/route-capture.js` idiom), so it is `require()`-able for tests:

```
parseInstagramSaved(json) -> [ { title, url, ts }, ... ]
```

- Accept a parsed object. Recognize the saved-posts shape: `json.saved_saved_media` is an array. (Return `[]` for any other shape — liked, garbage, null — so it's safe to try on every JSON file.)
- For each entry: `username = entry.title`; the post URL + save-time live in `entry.string_map_data["Saved on"]` → `{ href, timestamp }`. Tolerate the value living under a differently-named single key (IG localizes "Saved on") by taking the first `string_map_data` value that has an `href`.
- Emit `{ title: <username or "Instagram post">, url: <href, only if it's an instagram.com URL>, ts: <timestamp> }`. Skip entries with no valid instagram URL.
- Pure: no DOM, no I/O, no dependence on app globals.

### Wiring in `web/index.html`

1. Add `<script src="import-instagram.js"></script>` before the main inline app script (so `parseInstagramSaved` is defined).
2. In `parseImportText`, inside the `t.startsWith("{")||t.startsWith("[")` JSON branch, after `parseFacebookJSON`: try `parseInstagramSaved(p)`; if it returns items, `return { items: ig.map(i => Object.assign(clean(i), { src: "instagram" })), ids: [] }`.
3. In `srcHint(name)`, map an Instagram export path/filename (contains `instagram` or `saved_posts`) to `"instagram"` so the Imported-tab source filter labels them correctly.
4. Update the section heading + hint to read "Facebook · Instagram · Pinterest · YouTube" (copy only).

## Data shape & the title limitation

A saved entry yields: **title = the account/username**, **url = the post permalink**, **sdate = the real saved timestamp** (via `clean()` → `normTs()`). Instagram's export does **not** include the post caption or image for saved posts, so the card's title is the account name and it starts image-less — the capture extension fills the image (and a better title/caption) when the user opens the card, identical to how Facebook/Pinterest imports enrich. This is an accepted limitation, documented so it isn't surprising; the card is still useful (URL drives enrichment, the account is a taste signal).

`clean()` already runs `fixTxt()` (mojibake/unicode repair) on titles, covering IG's occasional unicode-escaped usernames.

## Error handling & data safety

- **Read-only on the source** — `parseInstagramSaved` only reads the parsed object; the import never writes the user's export file (the file input reads it as text/zip in memory).
- **Safe dedup** — items flow through the existing `handleImport` dedup (by lowercased title + url), which enriches existing cards and never deletes; the 10000-cap slice is pre-existing behavior.
- **Defensive parsing** — any malformed/partial entry is skipped (no throw); a non-saved JSON returns `[]` so trying the parser on every JSON file is harmless. A whole-file parse error is already caught by `parseImportText`'s `try/catch`.
- **Personal data** — the user's real IG export is personal data and must NEVER be committed; tests use only tiny synthetic fixtures.

## Testing

`tests/import-instagram.test.js` (plain-Node `assert`, via `tests/run.js`; `require("../web/import-instagram")`), synthetic fixtures only:

1. A `saved_saved_media` entry with `string_map_data["Saved on"].href` + `timestamp` → one item with the right title (username), url, and ts.
2. Multiple entries → all parsed; an entry with no valid instagram href → skipped.
3. A `likes_media_likes` object (liked, not saved) → `[]` (not parsed).
4. `null` / `{}` / `[]` / a non-IG object → `[]` (no throw).
5. A localized `string_map_data` key (not literally "Saved on") that still carries an `href` → still parsed.
6. A unicode-escaped username round-trips (no crash; `clean()`/`fixTxt` handles repair downstream — the pure parser passes the raw username through).

`node tests/run.js` stays **ALL TEST FILES PASSED**; the inline-`<script>` syntax gate on `web/index.html` stays green.

## Files

- **Create** `web/import-instagram.js` — pure `parseInstagramSaved(json)`, require()-able.
- **Create** `tests/import-instagram.test.js` — synthetic-fixture unit tests.
- **Modify** `web/index.html` — load the script; call `parseInstagramSaved` in `parseImportText`; `srcHint` instagram tag; section-label copy.

## Global constraints (carry verbatim into the plan)

- Repo **private**; **never create/edit/`git add` personal-data files** (the user's IG export especially); tests use synthetic fixtures only.
- **Read-only on the import source**; **safe dedup** into the library (never lose/overwrite existing cards).
- `web/import-instagram.js` is **require()-able** (browser global + `module.exports`, like `web/route-capture.js`).
- Tests are plain-Node `assert` via `tests/run.js`; the inline-`<script>` syntax gate must stay green.
- **App/renderer change** (not the extension) → ships via an **installer rebuild + reinstall**.

## Future (not in scope)

- Liked-posts import (if the user later wants the looser signal).
- Import-time caption/image enrichment (would require fetching IG pages — auth-walled; deferred to the existing on-open capture path).
