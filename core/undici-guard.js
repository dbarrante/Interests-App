// Backstop for a Node/undici quirk: when an HTTP(S) response body is cancelled or aborted
// before it's fully consumed, undici can throw an ASYNC, uncatchable AssertionError during
// socket teardown — `assert(!this.paused)` in Parser.finish, fired from onHttpSocketEnd.
// It is benign (the request was already handled), but in the Electron MAIN process it
// surfaces as an uncaughtException and crashes the app with a scary dialog. We recognize
// ONLY that specific teardown assertion and swallow it; everything else stays fatal.
"use strict";

function isBenignUndiciTeardown(err) {
  if (!err) return false;
  var isAssert = err.code === "ERR_ASSERTION" || err.name === "AssertionError";
  if (!isAssert) return false;
  var msg = String(err.message || "");
  var stack = String(err.stack || "");
  if (/this\.paused/.test(msg)) return true;
  return /undici/.test(stack) && /Parser\.finish|onHttpSocketEnd/.test(stack);
}

// Build the decision handler (pure-ish; takes log + onFatal callbacks). Exposed for tests.
function _makeHandler(opts) {
  opts = opts || {};
  var log = typeof opts.log === "function" ? opts.log : function () {};
  var onFatal = typeof opts.onFatal === "function" ? opts.onFatal : function (err) { throw err; };
  return function handle(err) {
    if (isBenignUndiciTeardown(err)) { log("ignored benign undici teardown: " + (err && err.message)); return; }
    onFatal(err);
  };
}

// Install process-level guards. `onFatal` lets the caller (main.js) preserve the normal
// fatal behavior (e.g. show an Electron error dialog + quit) for genuine errors; the
// default re-throws so the process still crashes on a real bug.
function installCrashGuard(opts) {
  opts = opts || {};
  if (process.__interestsCrashGuard) return;
  process.__interestsCrashGuard = true;
  var handle = _makeHandler(opts);
  process.on("uncaughtException", handle);
  process.on("unhandledRejection", function (reason) {
    handle(reason instanceof Error ? reason : new Error("Unhandled rejection: " + String(reason)));
  });
}

module.exports = { isBenignUndiciTeardown: isBenignUndiciTeardown, _makeHandler: _makeHandler, installCrashGuard: installCrashGuard };
