# Browser Bookmarks + Google Saved Import Design

**Date:** 2026-06-28
**Status:** Approved (design); ready for implementation planning
**Topic:** Two new import sources for the "Import your saves" pipeline — (A) Chrome/Edge browser bookmarks read directly from the live profile with a folder picker, and (B) Google Saved collections from a Google Takeout CSV.

---

## Goal

Add two import sources alongside Facebook/Instagram/Pinterest/YouTube, both feeding the existing dedup-into-Imported-cards flow:
- **A. Browser bookmarks** — the app reads the user's live Chrome/Edge bookmarks (no manual export); the user picks which browser/profile and which **folders** to import (so utility links don't pollute the interest profile).
- **B. Google Saved** — the user drops their Google Takeout "Saved" CSV(s) (or the whole Takeout ZIP); each saved link (Title/Note/URL) becomes an Imported card.

Decided with the user: bookmarks via **auto-read live profile + folder picker** (not manual HTML export); "Google saved" = **Google Saved collections** (google.com/save) via Takeout CSV.

## Decisions locked with the user (2026-06-28)

1. **Bookmarks = auto-read the live Chrome/Edge profile** (a Core endpoint reads the `Bookmarks` file), **with a folder picker** — import only the ticked folders.
2. **Google Saved = Google Takeout "Saved" CSVs** (Title/Note/URL), dropped like the other exports.
3. Both → **Imported taste-signal cards** (consistent with all existing imports), via the shared dedup flow. New pure parsers, unit-tested with synthetic fixtures.

## Non-goals

- Manual bookmark HTML export (the existing generic HTML branch still works as a fallback, but the dedicated path is auto-read).
- Live two-way bookmark sync / scheduled re-import (one-time, on demand).
- Reading any browser file other than the `Bookmarks` JSON; any client-supplied filesystem path.
- Google Maps saved places (separate Takeout product; out of scope — though the CSV parser tolerates the general Takeout "Saved" shape).
- Changes to the capture extension.

---

## Architecture

Two slices, one shared destination (the existing `imported` cards + dedup).

```
A. Bookmarks (auto-read):
   renderer "Import browser bookmarks" button
     -> GET /api/bookmark-sources              (Core: scan Chrome+Edge profiles)
     -> picker: browser/profile, then folders (checkboxes + counts)
     -> GET /api/bookmarks?browser=&profile=    (Core: read+parse that profile's Bookmarks)
     -> filter to ticked folders -> ingestImported(found)   [shared dedup]

B. Google Saved (file drop):
   Settings #impFile (existing) -> handleImport -> parseImportText (.csv branch)
     -> parseGoogleSaved(text)  [NEW pure parser]  -> ingestImported(found)  [shared dedup]
```

### Shared refactor: `ingestImported(found, ids)`

The dedup block currently inside `handleImport` (the `byTitle`/`byUrl` maps, junk filter, enrich-existing, push-new, `Store.putCards`/`writeSavesFile`/`renderImportStatus`/toast — `web/index.html` ~1792-1822) is extracted **verbatim in behavior** into a function `ingestImported(found, ids)` that returns `{added, updated}`. `handleImport` calls it; the new bookmark-import calls it. No behavior change to file imports — this is a pure extraction so both entry points share one safe dedup path.

---

## Slice A — Browser bookmarks (Core + parser + UI)

### Pure parser + fs helpers: `core/bookmarks.js` (Node)

- `parseChromeBookmarks(json) -> [{ title, url, ts, folder }]` — **pure**, require()-able. Walks `json.roots` (`bookmark_bar`→"Bookmarks bar", `other`→"Other bookmarks", `synced`→"Mobile bookmarks"); recurses folder `children`; for each `type:"url"` node with an `http(s)` url, emits `{ title: name, url, ts, folder }` where `folder` is the slash-joined folder path (e.g. `"Bookmarks bar/Recipes"`) and `ts` = Chrome `date_added` (a string of **microseconds since 1601-01-01 UTC**) converted to ms: `Math.round(Number(date_added)/1000) - 11644473600000` (only when it lands in a sane ~2000-2100 range, else omit). Skips non-`http(s)` nodes (`chrome://`, `edge://`, `javascript:`, `file:`, `data:`). Returns `[]` for any non-bookmarks object.
- `listBrowserProfiles() -> [{ browser, profile, name, count }]` — scans the two fixed bases:
  - Chrome: `%LOCALAPPDATA%\Google\Chrome\User Data\`
  - Edge: `%LOCALAPPDATA%\Microsoft\Edge\User Data\`
  For each base, every subdir containing a `Bookmarks` file is a profile (`Default`, `Profile 1`, …). `name` = display name from `<base>\Local State` JSON (`profile.info_cache[<dir>].name`), falling back to the dir name. `count` = `parseChromeBookmarks(read(Bookmarks)).length`. Missing base → skip. Read-only; never throws out (per-profile try/catch).
- `readProfileBookmarks(browser, profile) -> [{title,url,ts,folder}]` — **validates** `browser ∈ {"chrome","edge"}` and `profile` against `^[A-Za-z0-9 ._-]+$` AND against the set returned by `listBrowserProfiles()` (membership check); builds the path **only** from the fixed base + validated profile + `"Bookmarks"` (never a client-supplied path); reads + `parseChromeBookmarks`. Rejects anything else (returns `null`/throws a typed error the route maps to 400).

### Core endpoints: `core/server.js`

Both **GET**, read-only, behind the existing origin allowlist + loopback bind:
- `GET /api/bookmark-sources` → `{ sources: listBrowserProfiles() }`. No client input.
- `GET /api/bookmarks?browser=<chrome|edge>&profile=<dir>` → validate via `readProfileBookmarks`; on success `{ bookmarks: [...] }`; on a bad/unknown browser/profile → `400`; on a missing file → `404`. The `browser`/`profile` are the ONLY inputs and are validated as above — no path is ever accepted from the client.

### Security (the crux — this reads the user's browser files)

- Reads **only** the `Bookmarks` file under the two fixed vendor bases; the profile is a validated dir name confirmed to exist in the discovered set — **no path traversal, no arbitrary read.**
- `Bookmarks` is read while the browser may be running (Chrome/Edge don't hold it with an exclusive read lock on Windows); a read error degrades to "couldn't read bookmarks" rather than crashing.
- Loopback-only (`127.0.0.1`) + origin-allowlisted (existing middleware) — no new CORS/CSP surface; the browser never reaches this directly.
- The electron-security-reviewer reviews these endpoints before ship.

### Renderer UI: `web/index.html` + `web/storage.js`

- `web/storage.js`: `Store.bookmarkSources()` (GET `/api/bookmark-sources`), `Store.bookmarks(browser, profile)` (GET `/api/bookmarks?…`).
- `web/index.html`: a Settings control in the "Import your saves" section — a **"📑 Import browser bookmarks"** button. On click: `Store.bookmarkSources()` → if none, toast "No Chrome/Edge bookmarks found"; else a small picker (a modal reusing the existing modal, or an inline panel): choose **browser/profile** (with counts) → `Store.bookmarks(...)` → build the **folder checklist** (each distinct `folder` path with its count, checkboxes, default all checked) → **Import** ticks → filter the bookmarks to the checked folders → `ingestImported(found)`. Items tagged `src:"bookmark"`; the per-card title is the bookmark title, url the bookmark url, with the folder kept as the description (`"Bookmark · <folder>"`).
- `srcHint`: add `bookmark` (only relevant if a bookmarks HTML file is ever dropped; the auto-read path sets `src` directly).

---

## Slice B — Google Saved (Takeout CSV)

### Pure parser: `web/import-google-saved.js`

- `parseGoogleSaved(text) -> [{ title, url, desc }]` — **pure**, require()-able (dual browser/Node, `web/route-capture.js` idiom). Self-contained CSV line splitter (quote/comma aware). Header detection: find a **title** column (cell `== "title"` or contains "title" but **not** "channel"), a **url** column (`== "url"` or contains "url" but not "channel"), and an optional **note** column. **Return `[]` (not a match) if** there is no title+url column, OR the header contains YouTube markers (`"video id"`, `"channel"`) — so YouTube Takeout CSVs still route to the existing `parseCSV`. For each data row: `{ title: <title cell>, url: <url cell, only if http(s)>, desc: <note cell or ""> }`; skip rows missing title+url. Returns `[]` for non-CSV/garbage (no throw).

### Wiring: `web/index.html`

- In `parseImportText`, at the top of the `.csv` branch, try `parseGoogleSaved` first; if it returns items, `return { items: ig.map(i=>Object.assign(clean(i),{src:"google"})), ids:[] }`; else fall back to the existing `parseCSV`. (YouTube CSVs return `[]` from `parseGoogleSaved` and fall through unchanged.)
- Load `<script src="import-google-saved.js">` alongside `import-instagram.js`.
- `srcHint`: tag a Google-Saved path (`/saved/` under a Takeout export, not instagram/youtube) as `"google"` for the fallback case.
- **Fix `parseZip`'s source override** (`web/index.html` ~1771): change `if(h) r.items.forEach(i=>i.src=h)` to `if(h) r.items.forEach(i=>{ if(!i.src) i.src=h; })` so a content-detected `src` (google, instagram, facebook) inside a ZIP is **not clobbered** by the filename heuristic. (This also retroactively hardens the Instagram-in-ZIP case.)
- `GUIDES` + pill: add a `google` entry (Takeout → deselect all → **Saved** → JSON/CSV → download → drop the ZIP/CSVs) and a "Google" pill; update the section heading to include Google.

---

## Data shape & limitations

- Bookmarks: title + url + folder + (often) a date. No images — the card image fills in on open via the capture extension, like the other imports.
- Google Saved: title + url + note(→desc). No images (same enrichment-on-open).
- Both flow through the existing junk filter + dedup (by lowercased title / url), so re-importing is safe and idempotent.

## Error handling & data safety

- **Read-only on every source** — the Core bookmark endpoints only read; the Google CSV is read in the renderer from the dropped file. Nothing writes to the browser profile or the Takeout file.
- **Safe dedup** — both go through `ingestImported`, which enriches/appends and never deletes; the 10000-cap slice is pre-existing.
- **Defensive parsing** — `parseChromeBookmarks`/`parseGoogleSaved` return `[]` on any malformed/foreign input; per-profile reads are try/caught; a bad browser/profile param is a 400, a missing file a 404.
- **Personal data** — the user's real bookmarks and Takeout exports are personal data and must NEVER be committed; tests use only tiny synthetic fixtures.

## Testing

- `tests/bookmarks.test.js` (plain-Node `assert`, `require("../core/bookmarks")`): `parseChromeBookmarks` on a synthetic `{roots:{bookmark_bar:{children:[…]}}}` → right title/url/folder/ts (incl. the µs-since-1601 conversion); skips `chrome://`/`javascript:`; nested-folder paths; `[]` on garbage. `readProfileBookmarks` against a **temp dir** seeded with a fake `User Data/Default/Bookmarks` (inject the base dir for the test) → returns parsed items; **rejects** an invalid/traversal profile name (`"../foo"`, `"a/b"`) with no read.
- `tests/import-google-saved.test.js` (`require("../web/import-google-saved")`): a Title/Note/URL CSV → items with desc from Note; a YouTube subscriptions-style header (`Channel Id,Channel Url,Channel Title`) → `[]` (so it falls through to `parseCSV`); quoted fields with commas; empty/garbage → `[]`.
- `node tests/run.js` stays **ALL TEST FILES PASSED**; the inline-`<script>` syntax gate on `web/index.html` stays green. The Core endpoints get a `createServer`-on-ephemeral-port smoke test (sources returns a shape; `/api/bookmarks` with a bad browser → 400). fs profile-discovery on the real machine is a manual smoke.
- **data-safety-reviewer** (new import/library writes) + **electron-security-reviewer** (new Core endpoints reading browser profile files) before ship.

## Files

- **Create** `core/bookmarks.js` — `parseChromeBookmarks` (pure) + `listBrowserProfiles` + `readProfileBookmarks` (validated fs reads).
- **Create** `web/import-google-saved.js` — pure `parseGoogleSaved`.
- **Create** `tests/bookmarks.test.js`, `tests/import-google-saved.test.js`.
- **Modify** `core/server.js` — `GET /api/bookmark-sources`, `GET /api/bookmarks`.
- **Modify** `web/storage.js` — `Store.bookmarkSources`, `Store.bookmarks`.
- **Modify** `web/index.html` — extract `ingestImported(found, ids)`; the bookmark-import button + browser/profile + folder-picker UI; wire `parseGoogleSaved` into `parseImportText`; load `import-google-saved.js`; `parseZip` src-clobber fix; `srcHint` google/bookmark; `GUIDES` google pill + section heading.

## Global constraints (carry verbatim into the plan)

- Repo **private**; **never create/edit/`git add` personal-data files** — the user's real bookmarks/Takeout especially; tests use synthetic fixtures only.
- **Read-only on every import source**; **safe dedup** via the shared `ingestImported` (never lose/overwrite existing cards).
- **Bookmark Core endpoints read ONLY the fixed `Bookmarks` path for a validated, discovered profile** — no client-supplied path, no traversal, no other file.
- New pure parsers (`core/bookmarks.js parseChromeBookmarks`, `web/import-google-saved.js`) are **require()-able** + unit-tested.
- Tests are plain-Node `assert` via `tests/run.js`; the inline-`<script>` syntax gate must stay green.
- **App change** (Core + renderer) → ships via an installer rebuild + reinstall. Do **not** modify the capture extension.

## Future (not in scope)

- Firefox bookmarks (different format/path).
- Scheduled bookmark re-import; live sync.
- Google Maps saved places (separate Takeout product).
