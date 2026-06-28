"use strict";
const fs = require("fs");
const path = require("path");
const db = require("./db");
const images = require("./images");
const backup = require("./backup");
const config = require("./config");
const { mergeSnapshots } = require("./merge");

function defaultSyncDir() {
  const root = backup.detectDropboxRoot();
  return root ? path.join(root, "Interests App", "sync") : null;
}

// Other devices' folders inside syncDir (skip self + non-directories).
function peerDirs(syncDir, selfDeviceId) {
  let names = [];
  try { names = fs.readdirSync(syncDir); } catch (e) { return []; }
  return names
    .filter(function (n) { return n !== selfDeviceId; })
    .map(function (n) { return { deviceId: n, dir: path.join(syncDir, n) }; })
    .filter(function (p) { try { return fs.statSync(p.dir).isDirectory(); } catch (e) { return false; } });
}

module.exports = { defaultSyncDir, peerDirs };
