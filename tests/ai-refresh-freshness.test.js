// tests/ai-refresh-freshness.test.js — aiRefreshCandidates, the freshness
// query behind the "Process next 200" button. Mirrors the existing
// .lc.at/_lcFresh and .sb.at/_sbFresh "skip if checked within N days"
// pattern already used for link-safety checks, with its own field
// (aiRefreshedAt) and its own threshold (S.aiRefreshDays).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": DEFAULTS includes aiRefreshDays: 30", () => {
    assert.match(src, /aiRefreshDays\s*:\s*30\s*,/);
  });

  t(label + ": aiRefreshCandidates includes cards with no aiRefreshedAt and excludes recently-touched ones", () => {
    const now = 1000000000000;
    const S = { aiRefreshDays: 30 };
    const imported = [
      { id: "never", title: "a" },
      { id: "fresh", title: "b", aiRefreshedAt: now - 1 * 864e5 },      // 1 day ago -> not eligible
      { id: "stale", title: "c", aiRefreshedAt: now - 40 * 864e5 },     // 40 days ago -> eligible
    ];
    const saved = [];
    const factory = new Function(
      "imported", "saved", "S", "Date_now",
      "Date.now = Date_now;\n" + extractFn(src, "aiRefreshCandidates") + "\nreturn aiRefreshCandidates;"
    );
    const aiRefreshCandidates = factory(imported, saved, S, () => now);
    const ids = aiRefreshCandidates().map(c => c.id);
    assert.deepStrictEqual(ids.sort(), ["never", "stale"]);
  });

  t(label + ": aiRefreshCandidates sorts oldest-first, with never-touched cards ahead of merely-stale ones", () => {
    const now = 1000000000000;
    const S = { aiRefreshDays: 1 };
    const imported = [
      { id: "stale-recent", aiRefreshedAt: now - 5 * 864e5 },
      { id: "never" },
      { id: "stale-old", aiRefreshedAt: now - 50 * 864e5 },
    ];
    const saved = [];
    const factory = new Function(
      "imported", "saved", "S", "Date_now",
      "Date.now = Date_now;\n" + extractFn(src, "aiRefreshCandidates") + "\nreturn aiRefreshCandidates;"
    );
    const aiRefreshCandidates = factory(imported, saved, S, () => now);
    const ids = aiRefreshCandidates().map(c => c.id);
    assert.deepStrictEqual(ids, ["never", "stale-old", "stale-recent"]);
  });

  t(label + ": aiRefreshCandidates includes both imported and saved cards", () => {
    const now = 1000000000000;
    const S = { aiRefreshDays: 30 };
    const imported = [{ id: "imp1" }];
    const saved = [{ id: "sav1" }];
    const factory = new Function(
      "imported", "saved", "S", "Date_now",
      "Date.now = Date_now;\n" + extractFn(src, "aiRefreshCandidates") + "\nreturn aiRefreshCandidates;"
    );
    const aiRefreshCandidates = factory(imported, saved, S, () => now);
    const ids = aiRefreshCandidates().map(c => c.id);
    assert.deepStrictEqual(ids.sort(), ["imp1", "sav1"]);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
