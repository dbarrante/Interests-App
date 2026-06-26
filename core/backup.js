// core/backup.js — backup/restore engine for the Core service.
// PURE helpers first (pickBackupsToDelete, backupCountsMatch) — ported verbatim
// from the legacy web app and covered by tests/backup.test.js.
"use strict";

// Given backup names, return the ones to delete (all but the newest `keep` by the
// embedded date). Matches a backup FOLDER (new) or a legacy single-file .json ONLY,
// so snapshots / saves.json / before-restore copies are never selected.
function pickBackupsToDelete(names, keep) {
  const re = /^interests-backup-(\d{4}-\d{2}-\d{2})(\.json)?$/;
  const dated = (names || [])
    .map(function (n) { const m = re.exec(n); return m ? { name: n, date: m[1] } : null; })
    .filter(Boolean)
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return dated.slice(Math.max(0, keep)).map(function (d) { return d.name; });
}

// True when two counts objects agree on imported/saved/images. Used to verify a
// freshly-written backup before older ones are rotated away.
function backupCountsMatch(a, b) {
  if (!a || !b) return false;
  return (a.imported | 0) === (b.imported | 0)
    && (a.saved | 0) === (b.saved | 0)
    && (a.images | 0) === (b.images | 0);
}

module.exports = { pickBackupsToDelete, backupCountsMatch };
