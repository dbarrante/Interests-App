# Incident report — 2026-07-16 fleet data event (root-caused 2026-07-17)

One event, three symptoms, forensically verified against the live DB, NTFS
timestamps, backup metas, and published snapshots.

## Root cause: killed test runs poisoned the production config pointer

`tests/storemove-int.test.js`, `tests/server-backup-int.test.js`, and
`tests/backup.test.js` did load-modify-restore on the REAL
`%APPDATA%\Interests App\config.json` (no APPDATA isolation), trusting
`try/finally` to restore it. Test runs killed mid-flight (timeouts,
interrupts — suites run constantly on this machine) left `storePath` /
`backupDir` pointing at throwaway `%TEMP%` fixture dirs:

- 07-14 ~11:36 — `backupDir` → `%TEMP%`: daily backups silently start
  landing in temp dirs (symptom 3, began under v1.12.21).
- 07-14 ~15:18 — `storePath` → a test store; the real store
  (`%APPDATA%\Interests App\data`, 6,672/180) freezes forever.
- 07-15 13:00 — another killed run re-points `storePath` at a 2-card
  `ia-mv-dst-*` fixture. The running app is unaffected (pointer read at
  boot only); it keeps operating on a temp store all day (backup 19:59:
  6,673 cards / **187 saved** — the last fully-healthy state).
- 07-16 13:24 — the **v1.12.22 update restart activates the poisoned
  pointer**: the app boots on the 2-card fixture. The boot merge rebuilds
  the library from Dropbox peers, but `applyMerge`'s image-defer gate
  (`if (!images.hasImg(...)) continue`) blocks the 126 saved items whose
  clip images exist in NO folder the merge may use — maddeningly, 125 of
  them sat in the desktop's OWN sync folder, skipped as "self" (symptom 2:
  saved 187→67, zero tombstones because nothing was deleted — the rows
  were simply never applied to the swapped-in store).
- 07-16 21:18–21:20 — the iPhone PWA, freshly reset (new `_pwa_device_id`),
  does a first full sync then a routine full-array persist;
  `pwa/storage-pwa.js guardedReplace` stamped `updatedAt = Date.now()`
  **unconditionally** on every row → the entire library re-stamped within
  ~2ms, published, and LWW steamrolled the fleet (symptom 1: ~6,600
  phantom re-stamps; pre-v27 this also forced full-library image
  re-downloads on every device).

## Fixes shipped (commit 426d9ec + earlier v27/v28)

1. **Test isolation:** the three writer tests self-isolate with a temp
   `process.env.APPDATA` before requiring `core/config`, AND
   `tests/run.js` gives every child a throwaway APPDATA (blanket guard for
   future tests). Locked by comments; direct `node tests/<file>` runs of
   the writers are also safe.
2. **PWA stamp preservation:** `guardedReplace` sig-compares each incoming
   row (stable stringify, minus `updatedAt`) against the existing row and
   keeps the old stamp when content is identical — mirrors
   `core/db.js upsertCard`. Test: `tests/pwa-stamp-preserve.test.js`.
3. **Image re-download amplification** (already shipped as v27):
   size-match reuse; superseded by on-demand images (v28).

## Recovery performed 2026-07-17

- Full healthy 07-15 store rescued from `%TEMP%` →
  `Dropbox/Interests App/backups/recovery-2026-07-17-temp-rescue/`
  (healthy store 6,673/187/974 + the misdirected 07-14..17 backups, ~2.4GB).
- Desktop store repaired: old real store kept as
  `%APPDATA%\Interests App\data-frozen-2026-07-14`; rescued store seeded as
  `%APPDATA%\Interests App\data`; image union from frozen store (97) + own
  sync folder (39) → 5,851 images, **zero saved items with unresolvable
  images**; `config.json` re-pointed, poisoned `backupDir` removed.
- One image genuinely lost everywhere: `imp_mr22zmz4_3081` ("Lettuce Wrap
  Steak Tacos") — row recovers, image renders placeholder.
- A stray `python -m http.server 3456` had claimed the app's port; killed.

## Still open after the repair

- [ ] First relaunch verification: boots on the repaired store; first sync
  merges the 3 phone-era saves + the legitimate 07-16 deletion
  (`c_mqyfkl7c_ghahkv` must STAY deleted).
- [ ] Delete the test-fixture rows that leaked into the fleet (`c1`, `c2`
  cards; `s1` saved "Tips") via proper tombstoning once the app is up.
- [ ] Desktop-side hardening (backlog): boot guard refusing/prompting on a
  store under `os.tmpdir()` or on collapsed counts vs `ia_backup_last`;
  `backupDir` sanity check; let merge copy images from any folder that
  holds them (incl. self) + surface chronic deferrals in the UI.
- [ ] The fleet permanently carries the 07-16 phantom `updatedAt` stamps
  (content is correct; only history is blurred). Accepted.
