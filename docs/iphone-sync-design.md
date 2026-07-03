# iPhone Sync — Design Handoff

For whoever builds the iOS companion app. Written at the end of v1.10.0 (desktop-side
prep only — no iOS code exists yet). Assume zero context beyond this file; it links to
the exact source files to read next.

Source: `docs/full-review-2026-07-02.md` section G (the original gap analysis) plus
what Phases 1-4 (v1.7.0-v1.10.0, see `docs/BACKLOG.md`) actually shipped.

## 1. Architecture decision: phone = another Dropbox sync peer

**The phone does NOT talk to the desktop app directly over the internet.** It becomes
another device in the existing Dropbox-folder sync scheme, using the **Dropbox HTTP
API** (`files/list_folder`, `files/download`, `files/upload`) instead of a synced
folder on disk (iOS has no such thing). This was chosen over LAN-only sync (stale
whenever away from home; needs real auth/TLS) and CloudKit (would require building a
second, parallel sync engine on Windows). Zero new desktop infrastructure — the
desktop side is unchanged by this decision.

**Folder layout.** Each device, including a future phone, gets its own folder under
the shared Dropbox sync root:

```
/Interests App/sync/<deviceId>/
  snapshot.json   <- cards, saved, tombstones (see core/sync.js publishSnapshot)
  meta.json       <- { deviceId, deviceLabel, schemaVersion, publishedAt }
  images/         <- idb:<id> images this device owns, keyed by id
```

Every device writes ONLY its own folder. Reading peers means listing the other
`<deviceId>` folders and downloading their `snapshot.json`/`meta.json`/images.

**Completion-marker protocol (torn-write protection).** A writer publishes
`snapshot.json` FIRST, then `meta.json` LAST. A reader that sees a folder with
`snapshot.json` but no (or a stale) `meta.json` treats it as mid-write and skips it
this round — `meta.json`'s presence is the "this snapshot is complete" signal. Port
this exactly: do not treat a folder as readable until `meta.json` has been
successfully downloaded and parsed. See `core/sync.js` (`publishSnapshot`,
`readPeerSnapshots`) for the reference implementation.

**Merge logic — port, don't reimplement.** `core/merge.js` (~80 lines) is pure and
I/O-free: it takes an in-memory local map + peer snapshots and tombstones, and
returns `{ upserts, deletes, tombstones, imageCopies, conflicts }`. It has no
filesystem or network calls, so it ports directly to Swift. **Use `tests/merge.test.js`
as the fixture source** — every case there (winner-by-updatedAt, tombstone-beats-stale-
upsert, tombstone carries original `deletedAt` so re-merges can't resurrect stale
deletes, local-wins-exact-ties, image-follows-winning-item) must produce identical
output from the Swift port. Alternatively, run `core/merge.js` itself inside a JS
bridge (JavaScriptCore is built into iOS) rather than porting — either is acceptable;
just don't hand-roll new merge semantics.

**Clock-skew guard.** `readPeerSnapshots` in `core/sync.js` skips (and counts as
`skewSkipped`) any peer snapshot whose `meta.publishedAt` is more than 24h in the
future relative to local clock. A snapshot with a MISSING `publishedAt` is trusted
(back-compat with pre-skew-guard snapshots), so **the phone must always set
`meta.publishedAt = Date.now()`** on every publish — omitting it doesn't get skipped,
but it defeats the whole point of the guard for peers reading the phone's snapshot.

## 2. Desktop API surface available today

All endpoints below are **loopback-only** (server binds `127.0.0.1`, not reachable
from a phone over Wi-Fi or cellular). They exist so a *local* JS bridge/dev harness
can exercise the same data the phone will eventually sync via Dropbox — they are not
the phone's transport. See `core/server.js`.

- `GET /api/changes?since=<ms>` → `{ ok, now, cards, saved, tombstones }`. Delta read:
  rows with `updatedAt > since` (tombstones: `deletedAt > since`). `now` is captured
  BEFORE the DB reads, so it's the watermark to pass as `since` on the *next* poll —
  a write that lands during the request window gets delivered again next poll
  (at-least-once, never-miss). `since` absent/0 returns everything (full snapshot).
  Poll loop shape: call once with no `since`, store the returned `now`, then loop
  `GET /api/changes?since=<last now>` on an interval, always overwriting the stored
  watermark with the newest `now`.
- `GET /api/tombstones?since=` — tombstones only, for a cheap poll when you just need
  to know what to delete.
- `GET /api/images` → `{ ok, images: [{id, size, type}] }` — manifest with sniffed
  MIME type (JPEG/PNG/GIF/WebP magic bytes, default `image/jpeg`). Diff this against
  local image ids/sizes to know what to fetch; don't trust the `.jpg` filename.
- `GET /api/img/:id` — now serves the SNIFFED content type, not a hardcoded
  `image/jpeg` (some images are PNG bytes stored under a `.jpg` name).
- `GET /api/cards`, `GET /api/saved` — full arrays. Fine for a one-time bootstrap;
  NOT the ongoing sync path (see the PUT warning below).
- `PUT /api/img/:id` — image upload is **base64-in-JSON** (`{data: "<base64>"}`).
  Works, but heavy over a network — see Open Items.
- `GET /api/pair-status` → `{ ok, lan }` — capability probe; `lan` is currently always
  `false` (see below).

**Dormant pairing-token + Host allowlist.** The Host-header allowlist (rejects any
request whose Host isn't `127.0.0.1`/`localhost`/`::1`) is LIVE today — it closes a
DNS-rebinding hole and runs on every request regardless of LAN mode. The
**pairing-token bearer check is dormant**: `core/config.js` has `ensurePairingToken()`
/`getPairingToken()` (32-hex token, generated once, persisted), and
`core/server.js`'s `requireToken` middleware only enforces it when config's
`lanEnabled` is `true`. Today `lanEnabled` is never set, so every request passes
through unauthenticated — this is correct for a same-machine renderer/extension, not
sufficient for a phone.

**LAN mode is NOT enabled and won't be by just flipping `lanEnabled`.** The server
bind stays `127.0.0.1` unconditionally regardless of that flag (there's a test
asserting this). Actually exposing the API to a phone on the LAN requires, as a
separate future project: (1) changing the bind address, (2) a TLS decision (plain
HTTP on a LAN is a sniffable-token risk), (3) a pairing UX (how does the phone learn
the token — QR code shown on desktop is the obvious answer), and only then does the
token check start meaning anything. None of that is shipped; it's explicitly future
work (see Open Items).

## 3. Schema notes

- **IDs**: TEXT, with a stable SHA1 fallback for items imported without a natural id
  (see `core/db.js` id-generation helpers). Never assume integer/UUID ids.
- **`updatedAt`**: per-record, ms epoch, content-diffed — only bumped when the content
  actually changes (not touched on a no-op write). This is what merge conflict
  resolution (`core/merge.js`) sorts on.
- **Tombstones are kept forever.** `core/db.js` has `pruneTombstones` but it is
  intentionally never called automatically. An occasionally-offline phone peer is
  exactly the case that makes any TTL unsafe — if a tombstone were pruned before the
  phone reconnects and saw it, the phone could resurrect a deleted item on its next
  sync. Do not add pruning without first designing per-peer sync cursors (see Open
  Items) so pruning can be gated on "every known peer has seen this delete."
- **`img` (cards) / `image` (saved) wire format is FROZEN.** Cards use the field name
  `img`; saved items use `image`. This is deliberate — v1.9.0/desktop peers merge
  snapshots by reading these exact field names, and changing them would break
  cross-version merges. **Do not rename either field in the phone client.** (v1.10.0
  added `itemImg`/`setItemImg` accessor helpers on the *renderer* side only, in
  `web/index.html`, to remove scope-conditional noise in UI code — the underlying
  storage/wire format is untouched by design. See `docs/BACKLOG.md` v1.10.0 T5.)
- Both `img`/`image` values are either a real URL/data-URI or an `idb:<id>` reference.
  An `idb:<id>` ref means the actual bytes live as a file named `images/<id>.jpg` in
  the store dir — **the `.jpg` extension is just a filename convention, not a promise
  about the actual byte format**; always trust the manifest's sniffed `type`, never
  the extension, when deciding how to decode/display the bytes.
- **`kv` table is machine-local, mixed with user settings.** It holds both things
  that must never sync (capture queue, local store paths, batch-driver state) and
  things that arguably should (user-facing settings/preferences). **A settings/kv
  split is still TODO — do not blindly sync the whole `kv` table.** Until that split
  exists, treat every `kv` key as machine-local and out of scope for phone sync.

## 4. Open items for the iOS phase

- **Settings/kv sync split** — design which `kv` keys are user settings (sync-worthy)
  vs. machine-local (capture queue, store paths — never sync). See section 3 above.
- **Thumbnails** — no server support yet; the phone must fetch full images via
  `/api/images` + `/api/img/:id` (or the Dropbox `images/` folder) until a
  thumbnail-generation dependency is added on the desktop side.
- **Binary image upload** — `PUT /api/img/:id` is base64-in-JSON today; workable but
  heavy over cellular. A raw-binary upload path is future work if this proves to be a
  bottleneck.
- **LAN fast-path** — the `/api/changes` delta API and the token/Host-allowlist infra
  already exist and could support a same-Wi-Fi fast sync, but the bind change + TLS
  decision + pairing UX (see section 2) is unbuilt. Dropbox-peer sync is the only
  supported transport for now.
- **Per-peer sync cursors** — would let tombstones eventually be pruned safely (each
  peer acks what it's seen). Not designed yet; tombstones stay forever until this
  lands.

## 5. Write path — use PATCH/DELETE + Dropbox, not the full-array PUT

**The phone must never call `PUT /api/cards` or `PUT /api/saved`.** Those full-array
endpoints exist for the single desktop renderer and carry `asOf`/mass-delete-guard
semantics (a 409 if the incoming array looks like it would wipe more than half the
existing library without an explicit `confirm: true`) designed around one writer
having the full picture. They are not part of the phone's transport at all — the
phone never talks to the desktop's local HTTP server directly (see section 1: it's
loopback-only). The phone's writes are: update its own in-memory/local store, then
publish a `snapshot.json`/`meta.json` pair to its own Dropbox
`/Interests App/sync/<phoneDeviceId>/` folder, exactly like a desktop peer does via
`core/sync.js`. Desktop then merges that snapshot in on its own sync cycle via
`core/merge.js`.
