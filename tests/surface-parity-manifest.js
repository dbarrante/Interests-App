"use strict";

// This is intentionally a plain Node manifest: the project has no build step.
// Exact pairs are byte-identical contracts; indexContracts are behavior-identical
// contracts whose adapters legitimately differ between Core and IndexedDB.
module.exports = {
  exactPairs: [
    ["web/lib/capture-state.js", "pwa/lib/capture-state.js"],
    ["web/lib/import-parsers.js", "pwa/lib/import-parsers.js"],
    ["web/lib/urlkey.js", "pwa/lib/urlkey.js"],
    ["web/route-capture.js", "pwa/route-capture.js"],
    ["web/profile-analyze.js", "pwa/profile-analyze.js"],
  ],
  indexContracts: [
    "setCardImageDurably",
    "ingestImported",
    "drainCaptures",
    "renderPwaRecoveryStatus",
    "recoverPwaMerge",
  ],
};
