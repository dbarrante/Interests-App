"use strict";

// Restores a brand-new PWA install from the desktop app's regular, already-
// automatic Dropbox backups (core/backup.js's runBackup(), which now also
// writes a portable snapshot.json alongside the interests.db/images/meta.json
// it has always written). This is a ONE-WAY PULL — unlike the live peer-sync
// path (pwa/sync-pwa.js), it never re-publishes anything back to Dropbox,
// which is what makes it meaningfully faster for a first-time device setup:
// the live-sync path's slowness comes specifically from having to upload the
// device's whole library back to Dropbox before it's done, even on its very
// first run.
//
// Separate file, not folded into pwa/dropbox-connect.js, so each file keeps a
// single responsibility (that file owns the OAuth connect flow and publishing
// this device's own Worker config; this one owns restoring from an existing
// backup once connected). Injected into the Settings panel at runtime, same
// pattern as dropbox-connect.js/pwa-install.js, to preserve index.html's
// byte-for-byte-except-<script>-tags constraint.
//
// snapshot.json intentionally includes the RAW, unstripped settings blob
// (API keys included) — see docs/superpowers/specs/2026-07-13-pwa-restore-
// from-desktop-backup-design.md's "Security" section. The Dropbox App key
// itself can NEVER be bootstrapped from a backup or from another device's
// published config — reading any Dropbox file requires already being
// connected, which requires the App key first. Every device still enters it
// manually once; this file only ever runs after that's already true.

(function () {
  const Dbx = window.IADropbox;
  const idb = window.IA_IDB;
  const Store = window.Store;
  const BACKUPS_ROOT = "/Interests App/backups";

  function $(id) { return document.getElementById(id); }

  // Ported from pwa/sync-pwa.js's safeImgId (not exported from that file's
  // IIFE) — a snapshot.json is only as trustworthy as the Dropbox account
  // it came from; guard against a malformed/corrupted id reaching a Dropbox
  // download path or an IndexedDB primary key, same as the live peer-sync
  // path already does for structurally identical data.
  function safeImgId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
  }

  // Ported from pwa/sync-pwa.js's sniffImageType (not exported from that
  // file's IIFE) — always trust sniffed magic bytes over the .jpg extension.
  function sniffImageType(bytes) {
    const buf = new Uint8Array(bytes);
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
    if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
    return "image/jpeg";
  }

  // path/not_found means the backups folder doesn't exist yet (desktop has
  // never backed up) — the normal, silent "nothing to restore from" case.
  // Anything else is a real error and must not be swallowed the same way.
  async function findLatestBackup(accessToken) {
    let entries;
    try {
      entries = await Dbx.dbxListFolder(accessToken, BACKUPS_ROOT);
    } catch (e) {
      if (/path\/not_found/.test(e.message)) return null;
      throw e;
    }
    const names = entries
      .filter((e) => e[".tag"] === "folder" && /^interests-backup-\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name);
    if (!names.length) return null;
    names.sort(); // YYYY-MM-DD sorts correctly as a plain string
    return names[names.length - 1];
  }

  const IMAGE_DOWNLOAD_CONCURRENCY = 4;

  async function restoreImages(accessToken, backupName, imageIds, onProgress) {
    let done = 0, failed = 0, nextIndex = 0;
    async function worker() {
      while (nextIndex < imageIds.length) {
        const id = imageIds[nextIndex++];
        try {
          const bytes = await Dbx.dbxDownloadBinary(accessToken, `${BACKUPS_ROOT}/${backupName}/images/${id}.jpg`);
          await idb.put("images", { id, blob: new Blob([bytes]), type: sniffImageType(bytes) });
        } catch (e) {
          failed++; // deferred — a future live sync can pick it up from a peer instead
        }
        done++;
        if (onProgress && done % 25 === 0) onProgress(done, imageIds.length);
      }
    }
    if (imageIds.length) {
      await Promise.all(Array.from({ length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, imageIds.length) }, worker));
      if (onProgress) onProgress(imageIds.length, imageIds.length);
    }
    return { done, failed };
  }

  function imageIdsIn(snapshot) {
    const ids = new Set();
    let skippedUnsafe = 0;
    function addIfSafe(id) {
      if (safeImgId(id)) ids.add(id);
      else skippedUnsafe++;
    }
    (snapshot.cards || []).forEach((c) => { if (typeof c.img === "string" && c.img.indexOf("idb:") === 0) addIfSafe(c.img.slice(4)); });
    (snapshot.saved || []).forEach((s) => { if (typeof s.image === "string" && s.image.indexOf("idb:") === 0) addIfSafe(s.image.slice(4)); });
    if (skippedUnsafe) console.error("restore-from-backup: skipped " + skippedUnsafe + " image id(s) that failed the safe-id check");
    return [...ids];
  }

  async function restoreFromDropboxBackup(statusEl) {
    const appKey = localStorage.getItem(Dbx.LS_KEYS.appKey);
    if (!appKey || !Dbx.isConnected()) { toast("Connect to Dropbox first."); return; }

    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
    setStatus("Looking for a desktop backup…");
    let token, backupName;
    try {
      token = await Dbx.getAccessToken(appKey);
      backupName = await findLatestBackup(token);
    } catch (e) {
      setStatus("Couldn't reach Dropbox: " + e.message);
      return;
    }
    if (!backupName) {
      setStatus("No desktop backup found in Dropbox yet — back up from the desktop app first.");
      return;
    }

    let snapshot;
    try {
      const text = await Dbx.dbxDownload(token, `${BACKUPS_ROOT}/${backupName}/snapshot.json`);
      snapshot = JSON.parse(text);
    } catch (e) {
      setStatus("Found " + backupName + " but couldn't read its snapshot.json: " + e.message);
      return;
    }

    const cardCount = (snapshot.cards || []).length;
    const savedCount = (snapshot.saved || []).length;
    if (!confirm("Restore from " + backupName + "? (" + cardCount + " imported, " + savedCount + " saved)\n\n" +
                 "This replaces the cards, saved items, and settings currently in this browser with the backup's version.")) {
      setStatus("Restore cancelled.");
      return;
    }

    // PWA's Store.backupNow() is a stub that always resolves {ok:false} — this
    // is a no-op on the PWA build today, so no real safety copy happens here
    // (unlike the desktop, which takes a real one). Kept for forward
    // compatibility if that stub is ever filled in.
    try { await Store.backupNow(); } catch (e) {}

    setStatus("Writing cards, saved items & settings…");
    try {
      // Direct idb writes here, not Store.putCards/putSaved — those stamp every
      // row's updatedAt to "now" (storage-pwa.js's nowStamp), which would make
      // every restored item outrank a genuinely newer edit the next time this
      // device runs a live sync. The snapshot already carries each row's real
      // updatedAt (core/db.js's rowToCard/rowToSaved) and must keep it.
      if (snapshot.cards) { await idb.clear("cards"); await idb.putMany("cards", snapshot.cards); }
      if (snapshot.saved) { await idb.clear("saved"); await idb.putMany("saved", snapshot.saved); }
      if (snapshot.tombstones && snapshot.tombstones.length) {
        const rows = snapshot.tombstones.map((t) => ({ key: t.kind + ":" + t.id, id: t.id, kind: t.kind, deletedAt: t.deletedAt }));
        await idb.putMany("tombstones", rows);
      }
      if (snapshot.settings) {
        await Store.kvSet("ia_settings", snapshot.settings);
        await Store.kvSet("ia_settings_updatedAt", Date.now());
      }
    } catch (e) {
      setStatus("Restore was partial — some data may already have been written. (" + e.message + ")");
      return;
    }

    const imageIds = imageIdsIn(snapshot);
    setStatus("Downloading " + imageIds.length + " images…");
    const { done, failed } = await restoreImages(token, backupName, imageIds, (d, total) => {
      setStatus("Downloading images: " + d + " / " + total + "…");
    });

    setStatus("Restored " + cardCount + " imported + " + savedCount + " saved, " + done + " images" +
      (failed ? (" (" + failed + " image" + (failed === 1 ? "" : "s") + " deferred)") : "") + " — reloading…");
    setTimeout(() => location.reload(), 1200);
  }

  function injectWidget() {
    const anchor = $("syncToggle");
    if (!anchor || $("restoreBackupBox")) return;
    const sec = anchor.closest(".sec");
    if (!sec) return;

    const box = document.createElement("div");
    box.id = "restoreBackupBox";
    box.style.marginTop = "14px";
    box.style.paddingTop = "14px";
    box.style.borderTop = "1px solid var(--line)";
    box.innerHTML =
      '<button class="btn btn-ghost" id="restoreBackupBtn">Restore from Dropbox backup…</button>' +
      '<div class="hint" id="restoreBackupStatus" style="margin-top:6px">' +
        'Pulls your desktop app\'s latest backup directly — faster than a first-time sync, ' +
        'and includes your AI provider keys so this device needs no manual key entry. ' +
        '<b>Contains your live API keys</b> — only use this on a device you trust.' +
      '</div>';

    sec.appendChild(box);
    $("restoreBackupBtn").addEventListener("click", () => restoreFromDropboxBackup($("restoreBackupStatus")));
  }

  function init() {
    if (!Dbx || !idb || !Store) return;
    injectWidget();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
