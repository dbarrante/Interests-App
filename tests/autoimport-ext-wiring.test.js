// tests/autoimport-ext-wiring.test.js — extension wiring for the daily
// FB/IG platform auto-import scheduler (source assertions, pattern of
// bstumble-ext-bg.test.js). Task 3 (core/autoimport.js + the /api/auto-import*
// routes) hasn't landed yet, so this only verifies the EXTENSION side: alarm
// registration, the in-flight guard, the sequential per-platform tab flow,
// durableImage conversion, and status delivery on a non-"ok" scrape.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("parses as valid JS", (() => { try { new vm.Script(src); return true; } catch (e) { return false; } })());

// --- Alarm registration: daily period, 30min initial delay -----------------
ok("registers the ia-autoimport alarm", /chrome\.alarms\.create\(\s*AUTOIMPORT_ALARM/.test(src) && /AUTOIMPORT_ALARM\s*=\s*["']ia-autoimport["']/.test(src));
ok("alarm is daily (periodInMinutes: 1440)", /AUTOIMPORT_ALARM[\s\S]{0,80}periodInMinutes:\s*1440/.test(src));
ok("alarm has a 30-minute initial delay", /AUTOIMPORT_ALARM[\s\S]{0,80}delayInMinutes:\s*30/.test(src));
ok("the alarm listener dispatches to runAutoImportCheck(false) — alarm path", /a\.name === AUTOIMPORT_ALARM\)\s*runAutoImportCheck\(false\)/.test(src));

// --- Bridge poll so "Check now" works immediately ---------------------------
ok("polls GET /api/auto-import/request (piggybacked on the existing poll loop)", /\/api\/auto-import\/request/.test(src));
ok("the request poll is wired into iaPollAll (same cadence as capture-request)", /function iaPollAll\(\)[^\n]*pollAutoImportRequest\(\)\.catch/.test(src));
ok("a claimed Check-now request always runs, bypassing the config gate (manual=true)", /runAutoImportCheck\(true\)/.test(src));
// A Check-now click landing during an in-flight scrape must NOT be claimed
// (claimed-then-dropped = silently lost). The busy check must come FIRST in
// pollAutoImportRequest — before the GET and before the claiming POST — so an
// unclaimed request stays in the app-side mailbox and the next 30s poll tick
// retries it naturally.
ok("pollAutoImportRequest bails on autoImportBusy BEFORE touching the request mailbox", (() => {
  const m = /async function pollAutoImportRequest\(\)\s*{([\s\S]*?)\n}/.exec(src);
  if (!m) return false;
  const body = m[1];
  const busyIdx = body.indexOf("if (autoImportBusy) return;");
  const fetchIdx = body.indexOf("/api/auto-import/request");
  return busyIdx !== -1 && fetchIdx !== -1 && busyIdx < fetchIdx;
})());

// --- Config gate: ALARM PATH ONLY (manual requests always run) -------------
ok("reads GET /api/auto-import/config", /\/api\/auto-import\/config/.test(src));
ok("gate only applies on the alarm path: !manual && !cfg.on", /if\s*\(!manual\s*&&\s*!cfg\.on\)\s*return;/.test(src));

// --- In-flight guard ---------------------------------------------------------
ok("has a module-level in-flight guard flag", /let autoImportBusy = false;/.test(src));
ok("runAutoImportCheck bails when a check is already in flight", /if\s*\(autoImportBusy\)\s*return;/.test(src));
ok("the guard is set/cleared around the whole check (try/finally)", /autoImportBusy = true;[\s\S]{0,600}?finally\s*{\s*autoImportBusy = false;/.test(src));

// --- Sequential per-platform loop -------------------------------------------
ok("iterates platforms sequentially (fb then ig) with an awaited per-item call", /for\s*\(const platform of \["fb", "ig"\]\)\s*{[\s\S]{0,200}?await runAutoImportPlatform\(platform, port\);/.test(src));
ok("a platform can be disabled via its config checkbox", /platforms\[platform\] === false/.test(src));

// --- Tab flow: inactive create -> wait complete -> executeScript -> close in finally
ok("opens the saved-items page in an INACTIVE tab", /chrome\.tabs\.create\(\{\s*url,\s*active:\s*false\s*\}\)/.test(src));
ok("waits for the tab to finish loading before scraping", /await waitTabComplete\(tabId, 30000\)/.test(src));
ok("injects the pure parser lib via executeScript files", /files:\s*\[libFile\]/.test(src) && /lib\/saved-parse-fb\.js/.test(src) && /lib\/saved-parse-ig\.js/.test(src));
// Live-tuning 2026-07-19: a fixed 2-scroll wait parsed an EMPTY shell on
// Instagram — its lazy grid takes several seconds to mount tiles in a hidden
// tab. The collector now polls scroll->settle(1s)->parse up to 15 rounds,
// using the parser itself as the readiness probe, and stops early on any
// non-parse-failed status (ok or login-required).
ok("polls scroll->settle(1s)->parse up to 15 rounds (lazy hidden-tab grids)", /tries < 15/.test(src) && /window\.scrollTo\(0, document\.body\.scrollHeight\)/.test(src) && /setTimeout\(r, 1000\)/.test(src));
// Live-tuning round 2: breaking on the FIRST ok parse froze FB at its
// initially-mounted ~13 items — the loop now keeps scrolling while the count
// grows and stops after 2 stable rounds (login wall stops immediately).
ok("poll is GROWTH-based: stops after 2 stable ok rounds, not on first success", /if \(res\.status === "ok" && n === last\) \{ if \(\+\+stable >= 2\) break; \} else stable = 0;/.test(src));
ok("login wall still stops the poll immediately", /if \(res\.status === "login-required"\) break;/.test(src));

// --- IG API-first saved feed (complete, paginated) with DOM fallback ---------
ok("IG tries the page-context saved-feed API first", /\/api\/v1\/feed\/saved\/posts\//.test(src) && /"x-ig-app-id"/.test(src));
ok("API pagination is bounded (page cap) and item-capped", /pages < 6/.test(src) && /items\.length < CAP/.test(src));
ok("API failure/empty falls back to the DOM scrape (never a dependency)", /falling back to DOM scrape/.test(src));
ok("API items ship canonical /p/ urls keyed on the shortcode", /"https:\/\/www\.instagram\.com\/p\/" \+ m\.code \+ "\/"/.test(src));
ok("scrape diagnostics stay SW-console-only (diag stripped before delivery)", /delete result\.diag;/.test(src));
ok("calls parseSavedDoc(document) in-page", /api\.parseSavedDoc\(document\)/.test(src));
ok("the tab is ALWAYS closed, in a finally block", /finally\s*{\s*if\s*\(tabId != null\)\s*{\s*try\s*{\s*await chrome\.tabs\.remove\(tabId\); }/.test(src));

// --- Image durability + SSRF/beacon guard (security review 2026-07-18 F1) -----
// Only genuine signed-CDN images are fetched with credentials; an arbitrary
// attacker-chosen <img src> from a multi-author saved page is passed through
// raw, never fetched — else the daily scrape becomes a credentialed tracking
// beacon / loopback-SSRF probe from the user's IP.
// Live-tuning 2026-07-19: delivery converts via durableThumb (640px JPEG),
// not full-res durableImage — the core's /api/auto-import enforces a 1MB body
// cap + 256KB per-image cap, and one full-res IG tile batch blew both (413,
// swallowed silently). Same isExpiringCdnImage gate as before (F1).
ok("only converts signed-CDN images (durableThumb behind isExpiringCdnImage); other URLs pass through raw", /if\s*\(isExpiringCdnImage\(raw\)\)\s*{\s*const thumb = await durableThumb\(raw\);/.test(src));
ok("per-batch image budget + per-field ceiling keep the delivery under the core's caps", /imgBudget\s*=\s*850 \* 1024/.test(src) && /Math\.min\(imgBudget,\s*250 \* 1024\)/.test(src));
ok("durableThumb downscales to a bounded longest edge", /AUTOIMPORT_THUMB_MAX = 640/.test(src) && /OffscreenCanvas/.test(src));
ok("does NOT unconditionally durableImage every scraped image (the vulnerable pattern is gone)", !/image:\s*await durableImage\(it\.image \|\| ""\)/.test(src));

// --- IG two-step: home -> username discovery -> /<username>/saved/all-posts/ --
// 2026-07-19 incident: instagram.com/saved/ is the PROFILE of a real account
// named @saved — scraping it imported @saved's own posts as the user's saves.
// The scrape must start at HOME, read the viewer's username from the nav
// avatar, and only then navigate to the real saved page; no username = fail
// soft (import nothing).
ok("IG scrape starts at instagram.com HOME, never at /saved/", /ig:\s*"https:\/\/www\.instagram\.com\/"/.test(src) && !/ig:\s*"https:\/\/www\.instagram\.com\/saved/.test(src));
ok("IG saved page is built from the DISCOVERED username", /IG_SAVED_PAGE = \(username\) => "https:\/\/www\.instagram\.com\/" \+ username \+ "\/saved\/all-posts\/"/.test(src));
ok("username comes from the nav avatar profile link", /img\[alt\$="profile picture"\]/.test(src));
ok("no discovered username -> fail soft, import nothing", /if \(!username\) \{ log\("auto-import ig: viewer username NOT found[\s\S]{0,80}?return result; \}/.test(src));

// --- Delivery: batch + statuses ----------------------------------------------
ok("posts the batch to POST /api/auto-import", /autoImportPostBatch[\s\S]{0,200}\/api\/auto-import["'`]/.test(src) || /fetch\("http:\/\/127\.0\.0\.1" \+ port \+ "\/api\/auto-import"/.test(src));
ok("a non-\"ok\" scrape (login-required/parse-failed) posts the status with NO items", /result\.status !== "ok"\)\s*{[\s\S]{0,220}?items:\s*\[\],\s*checkedAt\s*}\);\s*return;/.test(src));
ok("a clean parse posts status \"ok\" with the durably-imaged items", /status:\s*"ok",\s*items,\s*checkedAt/.test(src));

console.log("autoimport-ext-wiring: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
