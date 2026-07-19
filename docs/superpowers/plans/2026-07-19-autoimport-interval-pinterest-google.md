# Auto-import interval + Pinterest & Google-saves — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One global auto-import check interval (1 day default, down to hourly) + two new auto-import platforms (Pinterest all-pins, Google saved items), reusing the FB/IG pipeline end to end.

**Architecture:** Pure capture-tuned parsers in `extension/lib/`, sequential hidden-tab scrapes in `extension/background.js`, validation/ledger in `core/autoimport.js`, `import-auto` routing in `web|pwa/route-capture.js`, Settings in `web|pwa/index.html`. Spec: `docs/superpowers/specs/2026-07-19-autoimport-interval-pinterest-google-design.md`.

**Tech Stack:** Vanilla JS (no build), Node-assert tests via `node tests/run.js`.

## Global Constraints

- Scrapers fail SOFT: login wall / zero-entry parse ⇒ status + zero items, never partial garbage.
- Parser contract: `{status, items:[{url,title,image,platformKey}]}`, title ≤512, CAP 100, script/style stripped before anchor walk, merge-all-anchors-per-bare-key.
- NEVER credential-fetch a non-signed-CDN image (`isExpiringCdnImage` gate; i.pinimg.com and Google thumbs pass through raw).
- Delivery: 850KB batch budget, 250KB per-image ceiling (core caps 1MB body / 256KB field).
- A recommendations/home feed must never be scraped as saves (2026-07-19 @saved lesson): every navigate step verifies it landed on the intended page shape.
- Platform keys: `fb | ig | pin | gs` everywhere (config, ledger `ia_autoimport_seen_<p>`, status `ia_autoimport_last_<p>`, source `<p>-auto`).
- Tests self-isolate APPDATA before requiring core modules if they write config.
- Any `pwa/**` edit ⇒ SHELL_CACHE bump. Release at the end: v1.12.30.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Global check-interval setting (end to end)

**Files:**
- Modify: `web/index.html` (DEFAULTS ~line 768; secAutoImport markup ~line 640; toggle wiring ~line 1670)
- Modify: `pwa/index.html` (same three mirror points), `pwa/sw.js` (SHELL_CACHE v34→v35)
- Modify: `core/autoimport.js` `getConfig()` + `core/server.js` `/api/auto-import/config`
- Modify: `extension/background.js` (`pollAutoImportRequest` + new `ensureAutoImportAlarm`)
- Test: `tests/autoimport-ui-wiring.test.js`, `tests/autoimport-core.test.js`, `tests/autoimport-ext-wiring.test.js`

**Interfaces:**
- Produces: `S.autoImportEvery` (hours, default 24); config JSON field `intervalHours` (number, clamped 1–24 by consumers); extension fn `ensureAutoImportAlarm(intervalHours)`.

- [ ] **Step 1: failing tests.** Append to `tests/autoimport-ui-wiring.test.js` (inside the existing `[["web",web],["pwa",pwa]].forEach` at top level, add a new forEach block before the final console.log):

```js
// --- Check-interval dropdown (spec 2026-07-19) --------------------------------
[["web", web], ["pwa", pwa]].forEach(([label, src]) => {
  ok(`${label}: DEFAULTS ships autoImportEvery:24 (1 day)`, /autoImportEvery:24/.test(src));
  ok(`${label}: interval <select id="autoImportEvery"> present with 1-day top option`,
    /<select id="autoImportEvery"[^>]*>\s*<option value="24"[^>]*>Once a day<\/option>/.test(src));
  ok(`${label}: options are 24/12/8/4/2/1`, ["24","12","8","4","2","1"].every(v => new RegExp('<option value="' + v + '"').test(src)));
  ok(`${label}: onchange writes S.autoImportEvery via save("settings",S)`,
    /autoImportEvery"\)\.onchange\s*=\s*e=>\{[^}]*S\.autoImportEvery\s*=\s*Number\(e\.target\.value\)\|\|24;[^}]*save\("settings",S\)/.test(src));
});
```

Append to `tests/autoimport-core.test.js` (it already builds a db + settings kv; follow its existing getConfig cases):

```js
t("getConfig exposes intervalHours from settings (default 24, clamped 1-24)", () => {
  setSettings({ autoImportOn: true });                          // helper already in this file
  assert.strictEqual(autoimport.getConfig(ctx).intervalHours, 24);
  setSettings({ autoImportOn: true, autoImportEvery: 4 });
  assert.strictEqual(autoimport.getConfig(ctx).intervalHours, 4);
  setSettings({ autoImportOn: true, autoImportEvery: 999 });
  assert.strictEqual(autoimport.getConfig(ctx).intervalHours, 24);
  setSettings({ autoImportOn: true, autoImportEvery: "garbage" });
  assert.strictEqual(autoimport.getConfig(ctx).intervalHours, 24);
});
```

(Adapt the settings-setting helper name to what the file actually uses — read it first.)

Append to `tests/autoimport-ext-wiring.test.js`:

```js
// --- Configurable alarm interval ----------------------------------------------
ok("ensureAutoImportAlarm re-creates the alarm only when the applied interval changed",
  /async function ensureAutoImportAlarm\(intervalHours\)/.test(src) &&
  /ia_autoimport_interval/.test(src) && /periodInMinutes:\s*hours \* 60/.test(src));
ok("interval clamped to [1,24] with 24 fallback", /Math\.min\(24, Math\.max\(1, Number\(intervalHours\) \|\| 24\)\)/.test(src));
ok("poll tick keeps the alarm in sync from live config", /pollAutoImportRequest[\s\S]{0,900}?ensureAutoImportAlarm\(/.test(src));
```

- [ ] **Step 2: run, verify FAIL:** `node tests/autoimport-ui-wiring.test.js && node tests/autoimport-core.test.js && node tests/autoimport-ext-wiring.test.js` → new cases FAIL.
- [ ] **Step 3: implement.**
  - `web/index.html` DEFAULTS: after `autoImportIg:true,` add `autoImportEvery:24,   // hours between automatic checks (1-24); "Check now" unaffected`.
  - Markup, after the Instagram checkbox row inside `secAutoImport`:

```html
<div style="margin-top:8px">Check every
  <select id="autoImportEvery" style="width:auto;margin-left:6px">
    <option value="24">Once a day</option>
    <option value="12">12 hours</option>
    <option value="8">8 hours</option>
    <option value="4">4 hours</option>
    <option value="2">2 hours</option>
    <option value="1">1 hour</option>
  </select>
</div>
```

  - Wiring, next to the existing toggle wiring block:

```js
document.getElementById("autoImportEvery").value = String(S.autoImportEvery||24);
document.getElementById("autoImportEvery").onchange = e=>{ S.autoImportEvery = Number(e.target.value)||24; save("settings",S); toast("Auto-import: checking every "+(S.autoImportEvery===24?"day":S.autoImportEvery+"h")); };
```

  - `core/autoimport.js getConfig`: add `intervalHours: clampHours(s.autoImportEvery)` with

```js
function clampHours(v) { const n = Number(v); return (isFinite(n) && n >= 1 && n <= 24) ? Math.round(n) : 24; }
```

  (place next to getConfig; export nothing new — server passes the field through).
  - `core/server.js` config route: include `intervalHours: cfg.intervalHours` in the JSON (read what getConfig returns — if the route builds the object itself, add the field there using the same clamp via autoimport.getConfig).
  - `extension/background.js`, above `pollAutoImportRequest`:

```js
// Keep the daily alarm's period in sync with the app's configured interval
// (Settings "Check every"). Cheap: runs on the same 30s poll tick that
// already resolved the port; re-creates the alarm ONLY when the applied
// value actually changed (chrome.storage.local ia_autoimport_interval).
async function ensureAutoImportAlarm(intervalHours) {
  const hours = Math.min(24, Math.max(1, Number(intervalHours) || 24));
  let applied = null;
  try { applied = (await chrome.storage.local.get("ia_autoimport_interval")).ia_autoimport_interval; } catch (e) {}
  if (applied === hours) return;
  try {
    chrome.alarms.create(AUTOIMPORT_ALARM, { periodInMinutes: hours * 60, delayInMinutes: Math.min(30, hours * 60) });
    await chrome.storage.local.set({ ia_autoimport_interval: hours });
    log("auto-import alarm interval set to " + hours + "h");
  } catch (e) { log("auto-import alarm update failed: " + (e && e.message)); }
}
```

  In `pollAutoImportRequest`, right after `if (port == null) return;`:

```js
  try { const cfg = await autoImportGetConfig(port); await ensureAutoImportAlarm(cfg.intervalHours); } catch (e) {}
```

  - Mirror the three `web/index.html` edits into `pwa/index.html` (PWA hides the section but the tests assert source parity, matching the existing toggle pattern). Bump `pwa/sw.js` SHELL_CACHE v34→v35.
- [ ] **Step 4: run tests → PASS**, then `node tests/run.js` → ALL PASS.
- [ ] **Step 5: Commit** `feat(auto-import): configurable check interval (1 day default, down to hourly)`.

---

### Task 2: Core + renderer plumbing for platforms `pin` and `gs`

**Files:**
- Modify: `core/autoimport.js` (platform whitelist), `core/server.js` (config platforms)
- Modify: `web/route-capture.js`, `pwa/route-capture.js` (import-auto sources)
- Modify: `web/index.html`, `pwa/index.html` (DEFAULTS `autoImportPin:true, autoImportGs:true`; checkboxes + wiring; status rows for "Pinterest"/"Google"; `autoImportItemFromCap` source map), `pwa/sw.js` (SHELL_CACHE v35→v36 if Task 1 already bumped, else v34→v35 — bump exactly once per release is NOT enough; bump per edit batch, final value checked in Task 6)
- Test: `tests/autoimport-core.test.js`, `tests/route-capture.test.js`, `tests/autoimport-ui-wiring.test.js`

**Interfaces:**
- Consumes: existing `processBatch(ctx, batch)`, `routeCapture` decision list, `autoImportItemFromCap(cap, now)`.
- Produces: platforms `"pin"`/`"gs"` valid in `processBatch` + config; sources `"pin-auto"`/`"gs-auto"` routed `import-auto`; cards `src:"pinterest"` / `src:"google"`, desc `"Saved from Pinterest"` / `"Saved from Google"`.

- [ ] **Step 1: failing tests.**
  - `tests/autoimport-core.test.js`: duplicate an existing happy-path processBatch case for platform `"pin"` (ledger key `ia_autoimport_seen_pin`, status `ia_autoimport_last_pin`) and one for `"gs"`; keep the invalid-platform case asserting `"xx"` still rejects.
  - `tests/route-capture.test.js`: for each of `pin-auto`/`gs-auto`, mirror the fb-auto precedence cases INCLUDING the binding carry-forward ("an -auto capture with a matching open active card still routes import-auto").
  - `tests/autoimport-ui-wiring.test.js`: assert `autoImportPinToggle`/`autoImportGsToggle` present + wired via `save("settings",S)` (copy the FB/IG assertion shapes); assert DEFAULTS `autoImportPin:true` and `autoImportGs:true`; assert `_autoImportRowHTML` is called for `"pin"` and `"gs"` in `renderAutoImportStatus` (`/_autoImportRowHTML\("Pinterest","pin"/` and `/_autoImportRowHTML\("Google","gs"/`).
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement.**
  - `core/autoimport.js`: change `if (platform !== "fb" && platform !== "ig")` → `if (["fb","ig","pin","gs"].indexOf(platform) < 0)`. getConfig platforms: add `pin: s.autoImportPin !== false, gs: s.autoImportGs !== false`.
  - `route-capture.js` (both copies): where `source === "fb-auto" || source === "ig-auto"` decides import-auto, extend to `["fb-auto","ig-auto","pin-auto","gs-auto"].indexOf(source) >= 0` (keep it FIRST in precedence).
  - `web/index.html` `autoImportItemFromCap`: replace the two-way map with

```js
const SRC_MAP = { "fb-auto":["facebook","Facebook"], "ig-auto":["instagram","Instagram"], "pin-auto":["pinterest","Pinterest"], "gs-auto":["google","Google"] };
const entry = SRC_MAP[s];
if (!entry) console.warn("auto-import: unexpected source", s);
const [src, label] = entry || ["instagram","Instagram"];
const it = { title: cap.title || domain(cap.url) || cap.url, url: cap.url, ts: cap.ts || now, src, desc: "Saved from "+label };
```

  - Settings: two checkbox rows (copy the FB/IG rows, ids `autoImportPinToggle`/`autoImportGsToggle`, labels "Pinterest" / "Google saves") + wiring lines (S.autoImportPin / S.autoImportGs); status: `renderAutoImportStatus` renders `_autoImportRowHTML("Pinterest","pin",st) + _autoImportRowHTML("Google","gs",st)` after the IG row.
  - Mirror all of it into `pwa/index.html` + SHELL_CACHE bump.
- [ ] **Step 4: run the three test files + full suite → PASS.**
- [ ] **Step 5: Commit** `feat(auto-import): core+renderer plumbing for pinterest/google-saves platforms`.

---

### Task 3: Pinterest parser (capture-tuned)

**Files:**
- Create: `extension/lib/saved-parse-pin.js`
- Create: `tests/fixtures/pin-saved-sample.html`, `tests/fixtures/pin-saved-login.html`
- Test: `tests/autoimport-pin-parse.test.js`

**Interfaces:**
- Produces: global `IASavedParsePin` + module export `{parseSavedHtml, parseSavedDoc}` — contract identical to `IASavedParseIG`.

Capture facts (`_livecapture/pinterest-saved.html`, 2026-07-19): relative hrefs `/pin/<digits>/`; every distinct pin has an in-anchor `<img src="https://i.pinimg.com/...">`; the anchor `aria-label` is the best title but has a junk value `"Untitled pin page"`; img `alt` is second-best after stripping the prefixes `"This may contain: "` / `"This contains an image of: "`; anchors-per-pin can be 2 (merge on bare id); logged-in page has NO login markers; Pinterest's login wall lives at `/login/`.

- [ ] **Step 1: copy `extension/lib/saved-parse-ig.js` → `saved-parse-pin.js`** and adjust (full deltas — everything else stays byte-similar):
  - Header comment: Pinterest all-pins page; recognized shape `pinterest.com/pin/<id>/` (relative or absolute), platformKey = the numeric id.
  - Patterns + canonical:

```js
var PATH_PATTERNS = [
  { type: "pin", re: /^(?:https?:\/\/(?:[a-z]{2,3}\.)?pinterest\.[a-z.]+)?\/pin\/(\d+)/i }
];
function canonicalUrl(pat) { return "https://www.pinterest.com/pin/" + pat.id + "/"; }
```

  - Login detection: `var LOGIN_RE = /(?:\bid=["']loginform["'])|(?:\baction=["'][^"']*login[^"']*["'])|(?:href=["']\/login\/?["'])|(?:\/accounts\/login\/)/i;`
  - Title resolution in pass 2 (replaces the IG chain; junk aria + alt-prefix handling):

```js
var JUNK_TITLE_RE = /^untitled pin page$/i;
var ALT_PREFIX_RE = /^this (?:may contain|contains an image of):?\s*/i;
// chain: first NON-JUNK aria -> first prefix-stripped alt -> first text -> block aria
for (j = 0; j < g2.anchors.length && !title; j++) { if (g2.anchors[j].aria && !JUNK_TITLE_RE.test(g2.anchors[j].aria)) title = g2.anchors[j].aria; }
for (j = 0; j < g2.anchors.length && !title; j++) { var a2 = g2.anchors[j].alt.replace(ALT_PREFIX_RE, "").trim(); if (a2) title = a2; }
for (j = 0; j < g2.anchors.length && !title; j++) title = g2.anchors[j].text;
```

  - Export names `IASavedParsePin`.
- [ ] **Step 2: fixtures.** `pin-saved-sample.html`: 5 tiles modeled on the capture — relative hrefs, in-anchor imgs, one duplicate pin id, one `aria-label="Untitled pin page"` + alt `"This contains an image of: a wooden desk"`, one absolute `https://www.pinterest.com/pin/123.../` href, junk anchors (`/ideas/`, `/search/`, profile `/someuser/`). `pin-saved-login.html`: minimal page with `href="/login/"` + no pin anchors.
- [ ] **Step 3: failing tests** `tests/autoimport-pin-parse.test.js` — copy the IG test file's skeleton; cases: extraction count + exact url/key/title/image per fixture tile; junk-aria demoted to stripped alt; dedup on bare id; junk-anchor exclusion; login-required; parse-failed; CAP; 512-cap; script-bleed regression; parseSavedDoc delegation; PLUS a live-replay case:

```js
t("LIVE capture replays: >=17 pins, all canonical urls, all with images", () => {
  let html; try { html = fs.readFileSync(path.join(__dirname, "..", "_livecapture", "pinterest-saved.html"), "utf8"); } catch (e) { return; } // capture is local-only; skip on other machines
  const r = PIN.parseSavedHtml(html);
  assert.strictEqual(r.status, "ok");
  assert.ok(r.items.length >= 17, "found " + r.items.length);
  r.items.forEach(i => { assert.ok(/^https:\/\/www\.pinterest\.com\/pin\/\d+\/$/.test(i.url)); });
  assert.ok(r.items.every(i => i.image), "every pin tile carries its img");
});
```

- [ ] **Step 4: run → parser cases pass, replay yields ≥17 items with titles/images. Fix chain order against real data if not.**
- [ ] **Step 5: Commit** `feat(auto-import): pinterest saved-pins parser (capture-tuned)`.

---

### Task 4: Pinterest scrape wiring

**Files:**
- Modify: `extension/background.js` (`AUTOIMPORT_URLS`, `autoImportScrapePlatform`, `runAutoImportCheck` platform list)
- Test: `tests/autoimport-ext-wiring.test.js`

**Interfaces:**
- Consumes: `IASavedParsePin` via `lib/saved-parse-pin.js`.
- Produces: platform `"pin"` scraped between `ig` and `gs`.

- [ ] **Step 1: failing wiring tests:**

```js
ok("pin platform: lands on pinterest.com/me/pins/ (server-side own-profile redirect)", /pin:\s*"https:\/\/www\.pinterest\.com\/me\/pins\/"/.test(src));
ok("pin scrape refuses to parse the HOME feed (landed-page guard)", /auto-import pin: landed on the home feed/.test(src));
ok("runAutoImportCheck iterates fb,ig,pin,gs sequentially", /for \(const platform of \["fb", "ig", "pin", "gs"\]\)/.test(src));
ok("pin/gs libs mapped", /saved-parse-pin\.js/.test(src) && /saved-parse-gs\.js/.test(src));
```

- [ ] **Step 2: implement.**
  - `AUTOIMPORT_URLS`: `pin: "https://www.pinterest.com/me/pins/",` and `gs: "https://www.google.com/interests/saved/list/allsaves",` (gs consumed in Task 5).
  - Lib/global maps in `autoImportScrapePlatform` become lookup objects:

```js
const AUTOIMPORT_LIBS = { fb: "lib/saved-parse-fb.js", ig: "lib/saved-parse-ig.js", pin: "lib/saved-parse-pin.js", gs: "lib/saved-parse-gs.js" };
const AUTOIMPORT_GLOBALS = { fb: "IASavedParseFB", ig: "IASavedParseIG", pin: "IASavedParsePin", gs: "IASavedParseGS" };
```

  - Landed-page guard after `waitTabComplete` for `pin` (the @saved lesson generalized — /me/ redirect could fail to the home feed, whose /pin/ anchors are RECOMMENDATIONS):

```js
if (platform === "pin") {
  const loc = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.pathname });
  const pathname = (loc && loc[0] && loc[0].result) || "/";
  if (pathname === "/" || pathname === "") {
    log("auto-import pin: landed on the home feed (own-profile redirect failed) — skipping, importing nothing");
    return result;   // fail soft; recommendations must never import as saves
  }
}
```

  - `runAutoImportCheck` loop: `["fb", "ig", "pin", "gs"]`.
  - NOTE: `gs` will 404 the lib file until Task 5 creates it — implement Tasks 4+5 before reloading the extension; tests don't load Chrome so ordering only matters for live runs.
- [ ] **Step 3: full suite → PASS.**
- [ ] **Step 4: Commit** `feat(auto-import): pinterest scrape wiring with home-feed guard`.

---

### Task 5: Google-saves parser + wiring — GATED on `_livecapture/google-allsaves.html`

The overview capture proved `google.com/save` is collections-only (no item anchors). The scrape target is `https://www.google.com/interests/saved/list/allsaves`. **Before writing parser code, analyze the allsaves capture** exactly as Tasks 3's facts were produced:

- [ ] **Step 1: analyze capture.** Run the anchor/href/img/aria census (same node one-liners as the Pinterest analysis in git history / scratchpad `inspect.js`). Decide, and RECORD as comments in the parser header: (a) item link shape (external hrefs? `role` containers? data attributes), (b) title source priority, (c) image source, (d) `platformKey` rule — external URL normalized via the same `decodeEntities`+trim used elsewhere IF no stable internal id exists in the DOM (spec's open point), (e) login/consent markers (`accounts.google.com/ServiceLogin`, `consent.google.com`).
- [ ] **Step 2: create `extension/lib/saved-parse-gs.js`** from the `saved-parse-pin.js` skeleton with the recorded constants; global `IASavedParseGS`. If items are NOT anchors (jsaction divs), the parser walks the recorded container/attribute shape instead of `<a>` tags — same contract, same fail-soft statuses. platformKey for external-URL items:

```js
function keyFromUrl(u) {
  // normalize: lowercase host, strip hash + utm_* params, keep path/query otherwise
  var m = /^(https?:\/\/)([^\/?#]+)([^#]*)/i.exec(u); if (!m) return "";
  var rest = m[3].replace(/([?&])(utm_[a-z]+|ref)=[^&]*/gi, "$1").replace(/[?&]+$/, "").replace(/\?&/, "?");
  return m[2].toLowerCase() + rest;
}
```

- [ ] **Step 3: fixtures + `tests/autoimport-gs-parse.test.js`** mirroring Task 3's case list (extraction, dedup on key, junk exclusion, login/consent-required, parse-failed, CAP, 512, script-bleed, doc delegation, live-replay against `_livecapture/google-allsaves.html` with the try/skip guard).
- [ ] **Step 4: extension already wired (Task 4's maps + URL).** Add gs-specific landed-page guard only if the capture shows redirects (record decision in code comment).
- [ ] **Step 5: full suite → PASS. Commit** `feat(auto-import): google-saves parser (capture-tuned)`.

---

### Task 6: Review gates, live validation, release v1.12.30

- [ ] **Step 1:** `node tests/run.js` → ALL PASS. Confirm exactly ONE net SHELL_CACHE bump landed for this release (v34 → v35; collapse if two bumps happened).
- [ ] **Step 2:** data-safety-reviewer over the working diff (new import surface: ledgers, route-capture precedence, external-URL keys). electron-security-reviewer over `extension/background.js` diff (new scrape targets; no new endpoints). Fix findings; re-run suite.
- [ ] **Step 3: live validation.** User reloads extension → Check now → status endpoint shows 4 platforms; verify `pin` imports real pins (SW diag), `gs` imports or fails SOFT with its status; verify a dropdown change to "1 hour" flips the alarm within ~30s (SW console line `auto-import alarm interval set to 1h`) then set it back.
- [ ] **Step 4:** version 1.12.29→1.12.30, commit `release: v1.12.30 — auto-import interval + Pinterest & Google saves`, push, `gh run watch` the release build, confirm installer assets + Pages deploy.
- [ ] **Step 5:** update `docs/BACKLOG.md` + project memory with capture facts and outcomes.

## Self-review notes

- Spec coverage: Part 1 → Task 1; parsers → Tasks 3/5; scheduler → Task 4; core/renderer → Task 2; testing/rollout → each task + Task 6. Non-goals respected (no per-board, no per-platform intervals).
- Google parser constants are capture-gated BY DESIGN (spec's one open point); Task 5 Step 1 produces them before any code.
- Type consistency: platform ids `pin`/`gs`, sources `pin-auto`/`gs-auto`, globals `IASavedParsePin`/`IASavedParseGS` used identically across Tasks 2–5.
