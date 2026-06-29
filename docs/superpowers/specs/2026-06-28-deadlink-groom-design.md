# Dead-Link Check → Groom Review — Design

**Date:** 2026-06-28
**Status:** Approved (design); pending spec review → writing-plans

## Goal

Add a manual "Check dead links" action that probes the URLs of the user's cards
(Imported + Saved) and surfaces the **definitively dead** ones into a Groom-style
review modal where the user confirms deletion. Never auto-deletes; backs up first.

## Decisions (locked with the user)

- **Conservative classification — definitive deaths only.** A link is flagged DEAD
  only on HTTP **404 / 410 / 451** or a hard network failure (DNS does not resolve /
  connection refused). Everything ambiguous (403, 429, 5xx, timeouts, login walls,
  redirects to a sign-in page) is **UNKNOWN and never flagged**.
- **Scope: Imported + Saved.** Both card sets are checked. The review-before-delete
  step protects the curated Saved library.
- **Skip social-host probing by default.** Probing thousands of Instagram/Facebook
  URLs from the user's IP returns login/403 (never "definitively dead" under the
  conservative rule) and risks platform rate-limiting. YouTube returns HTTP 200 for
  deleted videos, so a status probe can never flag it. These hosts are **skipped**
  (reported as `skipped`, never dead), so the sweep spends requests only where a 404
  is real and safe. Default skip-list: `instagram.com`, `facebook.com`, `fb.watch`,
  `threads.net`, `youtube.com`, `youtu.be`. Pinterest and generic web/bookmark links
  ARE probed (a Pinterest 404 is real).
- **Manual, bounded, stoppable.** A button the user clicks; runs in bounded chunks
  with a progress bar and a **Stop** button (honors the standing "nothing unbounded /
  must be stoppable" rule). Resumable: a `lastChecked` marker lets re-runs skip links
  recently confirmed alive.
- **Review-before-delete, backup-first.** Reuses the exact deletion path Groom/dupe
  review already uses (`snapshotBeforeDestructive()` → filter arrays →
  `Store.putCards`/`putSaved` → `Store.imgDel` for orphaned images).

## Architecture

The probe runs in the **Core service** (Node), never the renderer. The browser
cannot fetch arbitrary third-party URLs (CORS); Node's built-in `fetch` (Electron 42
/ Node 20+) can. The extension is the wrong tool (built for one-tab live capture, not
a library-wide sweep).

```
[renderer]  Check-dead-links button
   → gather Imported+Saved cards with http(s) urls, minus recently-checked
   → POST /api/check-links in bounded chunks  ──►  [Core] probe each url
   ← {id, status: dead|alive|unknown|skipped, code}    (concurrency cap, timeout)
   → update progress bar (+ Stop), stamp card.lc {at, st}
   → collect DEAD → open review modal (mirrors dupe review)
   → user confirms "Remove selected"
   → snapshotBeforeDestructive() → filter imported/saved → imgDel orphans
   → Store.putCards / Store.putSaved → persist + re-render
```

## Components

### 1. `core/linkcheck.js` (new, pure + probe)

- `classify(httpStatus, errCode) -> "dead" | "alive" | "unknown"` — **pure**, unit-tested.
  - `dead`: status ∈ {404, 410, 451}; OR errCode ∈ {`ENOTFOUND`, `ECONNREFUSED`, `ERR_NAME_NOT_RESOLVED`}.
  - `alive`: status 200–399.
  - `unknown`: everything else (401, 403, 429, 5xx, 0/abort/timeout, `ETIMEDOUT`,
    `ECONNRESET`, `EAI_AGAIN`, cert errors, …). Safe default for any unrecognized input.
- `isSkippedHost(url, skipList?) -> boolean` — **pure**, unit-tested. True when the
  URL's host equals or is a subdomain of a skip-list entry. Default skip-list as above.
- `isProbableHost(url) -> boolean` — **pure**, unit-tested SSRF guard. Returns false
  for non-http(s) schemes, and for hosts that are `localhost`, an IP literal in a
  private/loopback/link-local range (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
  `169.254/16`, `::1`, `fc00::/7`), or `*.local`. Such URLs are reported `skipped`,
  never probed — prevents the endpoint being used to reach internal services (SSRF).
- `async probeUrl(url, {timeoutMs=8000}) -> {status, code}` — HEAD first; on a network
  error or a status that suggests HEAD is unsupported (405/501), retry once with GET.
  `redirect: "follow"` (final status is what we classify), `AbortController` timeout,
  a desktop User-Agent header. Network error → `{status: 0, code: err.code || "ERR"}`.
- `async checkChunk(items, {concurrency=8, timeoutMs=8000}) -> [{id, status, code}]`
  — runs `items` ({id,url}) through a concurrency-capped pool. For each item:
  skip-host or non-probable → `{status:"skipped"}`; else `probeUrl` → `classify` →
  `{status:<verdict>, code:<httpStatus|errCode|null>}`.

### 2. `core/server.js` — one endpoint

`POST /api/check-links`, body `{items:[{id,url}], concurrency?, timeoutMs?}` (chunk
capped server-side at ≤200 items, concurrency ≤8), returns `{results:[{id,status,code}]}`.
Wrapped in try/catch → 500 on failure. Inherits the existing loopback/origin guard.

### 3. `web/storage.js`

`SE.checkLinks()` → `"/api/check-links"`; `Store.checkLinks(items, opts)` →
`jsend("POST", SE.checkLinks(), {items, ...opts}).then(j => (j && j.results) || [])`.

### 4. `web/index.html` — driver + review modal

- **Button** "🔗 Check dead links" in the Imported-tab action row (next to "Scan
  duplicates").
- **`async function checkDeadLinks()`** — gather candidate cards: `imported` + `saved`
  with an `http(s)` url, excluding cards whose `lc.at` is within `LC_FRESH_DAYS` (14)
  and `lc.st === "alive"`. Chunk (~100), POST each chunk via `Store.checkLinks`, update
  a progress indicator, honor a module-level `_deadStop` flag (Stop button) between
  chunks. Stamp each result onto its card: `card.lc = {at: Date.now(), st: status}`.
  Persist `lc` updates (`Store.putCards`/`putSaved`) so re-runs resume. Collect cards
  whose status is `dead` into `_deadGroups`-equivalent, then open the review modal.
- **Review modal** `#deadModal` / `#deadBody` mirroring the duplicate modal: header
  "Dead links — N found"; rows via a `deadRowHTML(mem)` (thumbnail, title, domain,
  Imported/Saved tag, the dead reason e.g. "404" / "gone (domain)", checkbox checked);
  footer Cancel + "Remove selected (N)".
- **`function applyDeadRemoval()`** — collect checked rows, `snapshotBeforeDestructive()`,
  build `rmImported`/`rmSaved` id sets, delete orphaned `idb:` images (`Store.imgDel`) +
  fingerprints, filter `imported`/`saved`, `Store.putCards`/`Store.putSaved`,
  `writeSavesFile()`, `updateCounts()`, close modal, re-render, toast.

## Data flow / persistence

- The per-card `lc` marker lives in the card's data blob (cardToRow's catch-all keeps
  non-column keys), so it round-trips with no schema change.
- Deletions use the established bulk-replace path (`Store.putCards(imported)` →
  `replaceCards`, which tombstones removed ids for Dropbox sync). Saved deletions use
  `Store.putSaved(saved)` similarly.

## Error handling

- Per-URL: timeout (AbortController) and any network error are caught → `unknown`
  (never dead) except the two definitive hard-failure codes.
- Per-chunk: a failed POST is caught; that chunk's cards are left unstamped (re-checked
  next run); the driver continues. A run can be Stopped at any chunk boundary.
- Concurrency cap (≤8) + per-host gentleness avoids hammering any single server.

## Data safety

- Nothing is auto-deleted — the user reviews and confirms every removal.
- A backup is taken before any deletion (`snapshotBeforeDestructive`).
- Only definitive deaths are ever flagged; UNKNOWN/skipped are never offered for deletion.
- The Saved library is only mutated through the confirmed review step.

## Security

- The new endpoint fetches user-supplied URLs server-side → SSRF surface. Mitigated by
  `isProbableHost` (http/https only; reject localhost/private/link-local/`.local`), so
  the prober can only reach public hosts — not the Core's own port or internal services.
- Endpoint inherits the existing loopback + Origin guard; no new CSP changes (Node
  `fetch` is server-side, not subject to the renderer CSP).

## Testing

- `tests/linkcheck.test.js` — `classify` truth table (404/410/451/ENOTFOUND/ECONNREFUSED
  → dead; 2xx/3xx → alive; 401/403/429/5xx/timeout/abort/unknown-code → unknown);
  `isSkippedHost` (instagram/facebook/youtube/subdomains skipped, pinterest/example not);
  `isProbableHost` (localhost/127.0.0.1/10.x/192.168.x/169.254.x/::1/`.local` rejected,
  public host allowed). Synthetic only.
- `tests/linkcheck-endpoint.test.js` — spin a local throwaway http server returning
  404 and 200 on two paths; `POST /api/check-links` against `createServer(ctx)` on an
  ephemeral port (mirrors `tests/sync-endpoints.test.js`); assert the 404 path →
  `dead`, the 200 path → `alive`, a private-IP url → `skipped`. No real-internet calls.
- Renderer (button, driver, modal, removal) — verified by the inline-`<script>` syntax
  gate (`node tests/run.js`) + manual smoke. No headless DOM test.

## Out of scope (YAGNI)

- Content-based "deleted post" detection for social platforms (the rejected aggressive
  option).
- Scheduled/background automatic checking (manual only for v1).
- A persistent dead-links dashboard / history beyond the per-card `lc` marker.

## Reused building blocks

- Duplicate-review modal pattern (`#dupeModal`/`dupeBody`/`dupeRowHTML`/`applyDupeRemoval`).
- `snapshotBeforeDestructive()`, `Store.putCards`/`putSaved`/`imgDel`/`fpDel`.
- Concurrency-pool idiom from `extension/bridge.js` (`pump()` inFlight cap).
- Endpoint test harness from `tests/sync-endpoints.test.js`.
