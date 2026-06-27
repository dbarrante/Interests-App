# Interests App — Install & Smoke Checklist

This is the manual round-trip to run after building the installer (`npm run dist`)
and before sharing it. It proves the packaged app installs, finds its data, accepts
a capture from the extension, and survives backup/restore and a store move.

The build artifact is `dist/Interests-App-Setup-<version>.exe`.

## Install (assisted wizard)

- [ ] Run `dist/Interests-App-Setup-<version>.exe`. Windows SmartScreen may show
      **"Windows protected your PC / unknown publisher"** (expected — v1 is unsigned).
      Click **More info → Run anyway**.
- [ ] At the wizard, **choose the install folder** (the default is
      `%LOCALAPPDATA%\Programs\Interests App\`). Confirm the **Change…** option is
      available — per-user install, no admin prompt.
- [ ] Leave **Create desktop shortcut** and **Create Start-menu shortcut** checked.
      Finish the wizard with **Launch** enabled.

## Launch & data location

- [ ] The app **launches** as its own window (not a browser tab). The Start-menu
      entry **Interests App** also opens it.
- [ ] In **Settings → Data location**, confirm the store path is
      `<install>\data\` and that `%APPDATA%\Interests App\config.json` records it.

## Migrate the legacy library

- [ ] Run the one-time **Import / Migrate** against an existing Dropbox legacy backup
      folder (`interests-backup-<date>\` containing `data.json` + `img-*.json`).
- [ ] Confirm the verification report (e.g. "5,500 cards, 18 saved, 4,303 images —
      all present"); note any card flagged with a missing image.

## See the library

- [ ] The main view renders **cards** with their images, and the **Saved** view shows
      saved clips. Spot-check a few thumbnails load (served from `/api/img/<id>`).

## Capture one post via the extension

- [ ] In Chrome (logged into a social site), trigger a capture with the
      **capture extension**. The extension probes ports `3456..3465` (`/api/ping`)
      to find the app and **POSTs the capture** to it.
- [ ] Confirm the new card appears in the app **without an app tab open in Chrome**.
      Close the app, capture again, reopen — the queued capture is delivered on
      reconnect.

## Back up

- [ ] Click **Back up now**. Confirm a dated folder appears under
      `Dropbox\Interests App\backups\interests-backup-<date>\` containing
      `interests.db` and copied images. The verification reports matching counts.

## Restore

- [ ] From the backup list, **Restore** the just-made backup. Confirm a safety
      snapshot of the current store is taken first, then counts match after restore.

## Move the data store

- [ ] **Settings → Data location → Move…** to a new folder. Confirm the app copies
      `interests.db` + `images\`, **verifies counts**, repoints the `%APPDATA%`
      pointer, and reopens from the new path. The **old copy is left intact** until
      the move verifies.

## Update & uninstall safety (optional, recommended)

- [ ] Install a newer build over the existing one — confirm the **library survives**
      (the `data\` folder is preserved on update).
- [ ] Run the uninstaller — confirm it **prompts "Also delete your saved library?"**
      defaulting to **No**, and that choosing No leaves `<install>\data\` in place.
