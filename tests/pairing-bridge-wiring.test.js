const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const bg = fs.readFileSync(path.join(root, "extension/background.js"), "utf8");
const options = fs.readFileSync(path.join(root, "extension/options.js"), "utf8");
const html = fs.readFileSync(path.join(root, "extension/options.html"), "utf8");
const server = fs.readFileSync(path.join(root, "core/server.js"), "utf8");
const web = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const pwa = fs.readFileSync(path.join(root, "pwa/index.html"), "utf8");

assert.match(bg, /ia_pairing_token/);
assert.match(bg, /Authorization.*Bearer/);
assert.match(options, /pairingSaveBtn/);
assert.match(options, /ia_pairing_token/);
assert.match(html, /pairingToken/);
assert.match(html, /pairingSaveBtn/);
assert.match(web, /showPairingToken/);
assert.match(pwa, /showPairingToken/);
assert.match(server, /extensionPairingRequired/);
assert.match(server, /\/api\/pairing-token/);
assert.match(server, /\/api\/pairing-config/);
console.log("pairing-bridge-wiring: passed");
