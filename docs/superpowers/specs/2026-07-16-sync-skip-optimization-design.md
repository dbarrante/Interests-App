# Sync skip-work optimization — design

## Problem

Every sync cycle does full work even when nothing changed, on both sides:

- **PWA** (`pwa/sync-pwa.js` + `pwa/oauth.js`): each cycle downloads every
  peer's full `snapshot.json` (~4 MB × 3 peers), page-lists every peer's
  `images/` folder (~5,700 entries each), then page-lists its **own** images
  folder and re-uploads its own ~4 MB `snapshot.json` + `meta.json` — all to
  report "already up to date."
- **Desktop** (`core/sync.js`): `readPeerSnapshots` reads + `JSON.parse`s
  every peer's multi-MB snapshot every merge tick, and `runSync` republishes
  the full snapshot **unconditionally** on every publish tick. The
  unconditional republish gives the desktop a fresh `publishedAt` every few
  minutes, which by itself would defeat any peer-skip on other devices —
  both sides must learn to skip or neither benefits.

Target: a no-change PWA cycle becomes one folder list + one tiny
`meta.json` download per peer (~2–5 s). A no-change desktop cycle becomes a
few tiny file reads and zero writes.

## Decisions (user-approved 2026-07-16)

- Optimize **every-sync overhead** (skip work), not transfer size.
  Compression and delta cursors explicitly deferred.
- Approach: **watermark + signature skipping** — kv-cached memories, no
  schema change, no new Dropbox APIs, full back-compat (older devices just
  stay slow themselves).
- Safety bias: **when in doubt, don't skip.** Any missing watermark, missing
  signature, prior partial failure, or read error falls back to today's full
  behavior.

## Design

### 1. Shared pure signature — `core/merge.js` (ported verbatim to `pwa/merge.js`)

`contentSignature(agg)` — deterministic string over the aggregates that can
possibly affect what a publish would produce:

```
agg = {
  cards,            // count
  saved,            // count
  tombstones,       // count
  maxCardUpdatedAt, // Number, 0 when none
  maxSavedUpdatedAt,
  maxTombDeletedAt,
  settingsUpdatedAt,
}
→ "v1|<cards>|<saved>|<tombstones>|<maxCardUpdatedAt>|<maxSavedUpdatedAt>|<maxTombDeletedAt>|<settingsUpdatedAt>"
```

Every mutating path in the app bumps one of these (edits stamp `updatedAt`,
deletes add tombstones with `deletedAt`, settings edits stamp
`ia_settings_updatedAt`), so signature-equality ⇒ a publish would produce
identical content. Missing/NaN inputs coerce to 0. Exported both CommonJS
and browser-global, same dual pattern as `mergeSyncedSettings`.

Desktop computes `agg` via cheap SQL (`SELECT COUNT(*)`, `MAX(updatedAt)`
on `cards`/`saved`, `MAX(deletedAt)` on tombstones) in a new
`db.signatureAggregates(db)` — no `serializeLibrary` needed for the skip
decision. The PWA computes `agg` from the row arrays `publishSnapshot`
already loads from IndexedDB (local reads — cheap; the network is what's
expensive there).

### 2. Peer-skip via publishedAt watermark

Per peer, remember the last **fully-merged** `publishedAt`:

- Desktop: kv `ia_peer_seen_<deviceId>` (SQLite kv via `db.getKV/setKV`).
- PWA: idb kv `_pwa_peer_seen_<deviceId>`.

Cycle behavior:
- Read the peer's tiny `meta.json` ONLY (desktop: small file read; PWA:
  `dbxDownload` of meta.json only). If `meta.publishedAt` equals the stored
  watermark → **skip** the snapshot download/parse and the peer's images
  listing entirely; the peer contributes nothing to this merge.
  Skipping is safe because a fully-merged peer is a no-op input to
  `mergeSnapshots` (its items exist locally with ≥ its updatedAt, its
  tombstones are already applied), and `meta.json` is written LAST (the
  existing torn-write completion marker), so an unchanged `publishedAt`
  proves the whole folder is unchanged.
- Otherwise → full read exactly as today.

**Watermark advancement rule (the safety core):** advance watermarks for the
peers read this cycle ONLY when the merge finished **clean**:
- desktop `applyMerge`: zero deferred upserts (item skipped because its
  `idb:` image wasn't copyable yet — new `deferred` counter) and zero
  failed image copies;
- PWA `applyMergeToLocal`: `imagesFailed === 0`; and zero
  `partialFailures` from `readPeers`.
A dirty cycle leaves all watermarks untouched, so every deferral re-reads
the peer next cycle exactly as today (the "self-heals next cycle" contract
is preserved). Skipped peers' watermarks are never touched. Any error
reading a watermark ⇒ treat as absent ⇒ full read.

### 3. Publish-skip via content signature

State (per side): `ia_last_publish_sig` + `ia_last_publish_clean`
(desktop kv) / `_pwa_last_publish_sig` + `_pwa_last_publish_clean` (idb kv).

Skip the entire publish (desktop: serialize+write; PWA: own-images listing
+ image uploads + snapshot/meta upload) when ALL of:
1. current `contentSignature(agg)` === stored sig,
2. stored `clean` flag is `true` (the last publish completed with **zero**
   image copy/upload failures),
3. this cycle's merge applied nothing (`changed === false` — belt and
   braces; an applied merge always changes the signature anyway).

After a publish that ran: store the fresh sig; set `clean = true` only if
zero image failures (desktop: copy failures counted in the
`changedImageIds` loop; PWA: new `uploadFailures` counter in
`uploadWorker` — today failures are logged and invisible). `clean = false`
forces future publishes until a fully clean one lands (owed images keep
retrying).

### 4. PWA own-published-images cache

`_pwa_published_imgids` (idb kv, array of ids): replaces the every-publish
full `listDeviceImageIds` pagination of this device's own folder.

- Absent → seed with one full listing (first publish after this update).
- `toUpload` = local image ids − cached set.
- Append each **successfully** uploaded id; persist the updated array after
  the upload wave (successful ids persist even when the cycle later fails —
  Dropbox `overwrite` mode makes re-upload idempotent anyway, so a stale
  cache entry can only cost one redundant upload, never a missing file...
  and a MISSING cache entry only costs a redundant upload too — errors on
  either side are cheap and self-correcting).
- Any error reading/writing the cache → fall back to a full listing.

Peer image listings (`listDeviceImageIds` of peers) are already avoided for
skipped peers by §2; for non-skipped peers they still run (merge needs
`imageIds` to plan copies).

### 5. What deliberately does NOT change

- `mergeSnapshots`, LWW semantics, tombstones, torn-write validation,
  `MAX_FUTURE_SKEW_MS`, schemaVersion gate — untouched.
- Snapshot format, file layout, `SCHEMA_VERSION` — untouched. Old app
  versions interoperate: they full-read/full-publish as before; new devices
  skip around them correctly (an old desktop's unconditional republish just
  means its peers re-read it each cycle, as today).
- No compression, no Dropbox delta cursors (deferred).
- `synctimers.js` cadence — unchanged; ticks simply become cheap when idle.

## Data flow (PWA no-change cycle after this change)

```
runSyncCycle
  -> readPeers: dbxListFolder(SYNC_ROOT)                 // 1 call
     per peer: dbxDownload(meta.json)                    // tiny, 1 call each
       publishedAt === watermark -> skip snapshot+images listing
  -> peers=[] -> no merge
  -> publishSnapshot: contentSignature(agg) === stored sig && clean
       -> skip listing/uploads entirely, return {skipped:true}
  -> result {ok:true, changed:false, peersSkipped:N, publishSkipped:true}
```

`runSyncCycle`'s result gains `peersSkipped` and `publishSkipped` counters
(surfaced in the persisted last-sync result for diagnosability).

## Error handling

Every new memory is advisory: unreadable/absent watermark, sig, or image
cache degrades to today's full behavior, never to a skipped-but-needed
read. AUTH_EXPIRED/OTHER classification paths are untouched (meta-only
reads flow through the same `dbxDownload`/`dbxError` choke point).

## Testing

- `tests/merge-signature.test.js` — pure `contentSignature` against BOTH
  `core/merge.js` and `pwa/merge.js` (dual-impl loop + verbatim-copy lock,
  same pattern as `tests/merge-settings.test.js`): determinism, field
  sensitivity (each aggregate change changes the sig), garbage coercion.
- `tests/sync-skip.test.js` — desktop end-to-end with real temp stores
  (pattern of `tests/sync-settings.test.js`): A publishes; B syncs (full
  read) → B syncs again with nothing changed → asserts A's folder was NOT
  re-parsed (runSync result reports the skip), B's snapshot.json mtime
  unchanged (publish skipped); A edits a card → B's next cycle full-reads A
  and applies; deferral case (peer item with missing image file) → watermark
  NOT advanced → next cycle re-reads the peer; dirty publish (image copy
  failure via injected unreadable file) → `clean=false` → next cycle
  publishes despite equal signature.
- `tests/pwa-sync-skip.test.js` — source-scan + extraction of
  `pwa/sync-pwa.js` (grab() pattern): meta-only fetch before full peer read;
  watermark advance gated on `imagesFailed === 0 && partialFailures.length
  === 0`; publish-skip gated on sig+clean+`!changed`; `uploadFailures`
  counted; `_pwa_published_imgids` seed/append; every skip path falls back
  to full behavior on kv read error.
- Full suite (`node tests/run.js`) green throughout; SHELL_CACHE bump;
  data-safety-reviewer gate on the core/sync.js + sync-pwa.js diff (merge
  correctness depends on the watermark-advancement rule).

## Deployment

- `pwa/sw.js` SHELL_CACHE v23 → v24; PWA auto-deploys on push.
- Desktop half needs release **v1.12.23** + reinstall (both laptops) — until
  installed, the desktop keeps republishing unconditionally and peers keep
  re-reading it (correct, just slow; no interop hazard).
