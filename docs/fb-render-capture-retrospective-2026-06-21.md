# Interests App — Facebook capture + app hardening retrospective

**Date:** 2026-06-21
**Scope:** Extension v4.27 → v4.34, plus several app-side (`index.html`) fixes.
**Goal of the work:** reliably get pictures onto imported Facebook cards (especially restricted/login-gated posts), without crashes, wrong images, infinite loops, or data loss.

This is a "what worked / what didn't" record so we don't re-walk the same dead ends.

---

## 1. Features shipped this session

| Area | What | Where |
|---|---|---|
| Imported UX | **Refresh pins** — a refreshed/captured card stays visible in the current filter (Couldn't capture / Failed) so you watch the picture land instead of the card vanishing | `index.html` `_refreshPins`, `attachCardImages` filter overrides |
| Imported UX | **Open selected** — open each selected card's link in its own tab (pop-up-blocker aware, http(s)-only, retry-safe) | `index.html` `openSelected` |
| Capture | **Auto render-capture** restricted FB posts — open the permalink in a real focused tab, render it like a manual "Save to Interests", capture, close. Single ↻ + a batch button ("🖼️ Auto-capture in tabs") | `background.js` `renderCaptureFb`/`captureFbPost`, `capture-core.js` `autoCaptureFB` |
| Capture | **Dead-post removal** — a deleted/"content isn't available" post is detected on render and the card is removed; the batch moves on | `capture-core.js` `isUnavailable`, `background.js` dead delivery |
| Capture | **Retry pacing** — render-capture retries up to 3× with a 5s wait + reload between tries | `background.js` `RENDER_MAX_TRIES`/`RENDER_RETRY_WAIT_MS` |
| Reliability | **Placeholder-loop fix** — fingerprint known junk images; "Fix placeholders" routes them to "Couldn't capture" and `drainCaptures` rejects any re-captured junk | `index.html` `imgFp`/`_phFps`/`clearFbPlaceholders` |
| Reliability | **Render-crash fix** — lazy image loading so the grid doesn't build one 500 MB HTML string | `index.html` `attachCardImages` + `impCardHTML` `data-imgid` |
| Reliability | **`alreadyGood` fix** — a card captured before but holding a bad/placeholder image now re-captures instead of reporting "nothing to capture" | `index.html` `impOpen` |

---

## 2. How Facebook capture works now (the model that survived)

Two paths, by speed vs. fidelity:

1. **`og`-fetch (fast, no tab)** — `captureFbByOg`: fetch the permalink's **raw server HTML** (logged-OUT first, then logged-in), regex `og:image`, fetch it to a data URL, deliver. Used by the fast **"Capture Facebook"** batch and as a **fallback** inside render mode. Most public posts/videos resolve here with no tab and no focus-steal.

2. **Render (slow, reliable)** — `renderCaptureFb` → `captureFbPost` → `autoCaptureFB`: open the permalink in a **real, focused, visible tab**, wait for the **real photo** to load, capture it (or stability-crop a text/quote post), or detect a **deleted/unavailable** post and remove the card. Used by **"Auto-capture in tabs"** and the single **↻**. In render mode we **render first**, og is only the fallback.

Shared write-back: every capture is delivered to the app's `ia_captures` and applied by `drainCaptures` (matched by card **id**), which also rejects known-junk fingerprints.

---

## 3. What WORKED (keep doing this)

- **`og:image` from RAW server HTML, fetched logged-OUT first.** The rendered SPA omits `og:image` from the live DOM; the public unfurl HTML carries it. This is the reliable no-tab path for the bulk of posts.
- **Render only in a FOCUSED, VISIBLE tab.** Facebook lazy-loads the post photo only when the tab is actually being viewed. A background/hidden tab serves only the spinner.
- **Wait for the REAL photo; never capture on a timeout.** Poll up to ~18s for a decoded `scontent` image (or `og:image`). If none loads, give up cleanly (leave a clean favicon) rather than capture whatever is on screen.
- **`metaPhoto()` / `og:image` preferred over the on-page `<img>`.** A cold permalink's largest decoded `<img>` is frequently FB's loading placeholder, which *passes* the decode gate.
- **Stability-checked crop for text/quote posts.** Crop the post twice ~1.2s apart; keep it only if **byte-identical** (static = real text post; animating = spinner → reject).
- **Scope to the post's dialog.** An opened FB permalink usually renders as a **lightbox dialog over the live Home feed**. Look only inside that dialog and take the **topmost article** — never search the document (that grabbed feed photos behind the dialog).
- **`clipKey` (host+path+post-id) for dedup/fill**, not `normalizeUrl`. FB post identity lives in the query (`?v=`, `?story_fbid=`, `?fbid=`).
- **Render FIRST in render mode for dead detection.** The rendered page is the only reliable signal a post is deleted.
- **Detect "unavailable" from the RENDERED post's text (scoped), never from fetched HTML.**
- **Lazy image attach (`IntersectionObserver`).** Keep base64 data URLs out of the joined HTML string; set `<img>.src` after render, only near the viewport.
- **Fingerprint known junk + reject on capture.** A self-heal loop needs a memory of what already failed.
- **Adversarial multi-agent review workflows before committing.** They caught the `normalizeUrl` mass-collapse, the single-↻-during-batch false-fail, the popup leak, and more — before they shipped.
- **Honest diagnostics first.** The "IDB keys vs card refs vs `_imgCache`" console snippet proved data was intact and the failure was a render crash — preventing a needless destructive "recovery."
- **Version stamping.** `FB_CAP_VERSION` is delivered and logged as `[fb-cap] … (ext vX)` so the app console shows whether the new extension code is actually live.

---

## 4. What did NOT work (avoid these)

| Tried | Why it failed | Do instead |
|---|---|---|
| Capture the rendered `<img>` directly | It's often FB's loading **spinner** — a decoded placeholder that passes the decode gate | Prefer `og:image`; require a real `scontent` photo; never crop on timeout |
| Background / hidden capture tabs | FB serves only the spinner to unfocused tabs | Focus the window + activate the tab before waiting |
| Read `og:image` from the rendered SPA DOM | FB omits it from the live DOM | Fetch the **raw server HTML** |
| `credentials:include` first for `og` | The logged-in response is the app shell (no `og:image`) | Fetch **logged-out (`omit`) first**, then include |
| `normalizeUrl` for FB dedup/fill | Strips the query → collapses distinct `/watch?v=` posts into one → mass false-"attempted" **and** cross-contaminated images via the `recap` duplicate-fill | `clipKey` everywhere in the capture dedup/stamp/fill path |
| "topmost article **with a photo**" + document-wide `largestImg` | A photoless text post made it wander into the **Home feed behind the dialog** and grab a random feed photo | Scope to the post's dialog; take the topmost article in scope; search for the photo only **within the post** |
| Crop-on-timeout fallback | Captured the spinner | Stability-checked crop only; otherwise leave clean |
| Inlining base64 data URLs into one big HTML string | ~3,789 cards × ~150 KB exceeded JS's max string length → `RangeError: Invalid string length` in `renderImported` → **no FB images rendered** (looked like data loss) | Emit `<img data-imgid>` and lazy-attach `src` post-render |
| `clear → recapture` placeholder self-heal with no memory | Gated posts re-captured the **identical junk** every time → infinite "Fix placeholders" loop | Record the junk **fingerprint**; reject it on future capture; route to "Couldn't capture" |
| `alreadyGood = it.captured && !stale` | A card captured before but holding a **bad** image was treated as good → opened watch-only ("nothing to capture") and never re-captured | `alreadyGood` must also require `!isBadImg(it.img)` |
| `og`-first in render mode | A deleted post's `og` returned a stale/generic image → "captured ✓ (no render needed)" → tab never opened → dead detector never ran | **Render first**; `og` only as fallback |
| Detect "unavailable" from the **fetched HTML** | FB inlines its UI string table into page HTML → the phrase appears on **every** page → would falsely delete **every** card (catastrophic) | Use the **rendered**, post-scoped text only |
| Popup window for render-capture | The user preferred a normal tab; the popup wasn't the cause of the spinner anyway (crop-on-timeout was) | Use a real foreground tab (matches the manual flow) |

---

## 5. Incidents & how they were resolved (chronological)

1. **Spinner captured instead of the photo** (long saga, v4.13→4.22): root cause was `largestImg` accepting an undecoded placeholder + preferring the on-page `<img>` over `og:image`. Fixed by requiring a decoded `scontent` image and preferring `og:image`; ultimately `og`-from-raw-HTML (v4.23+) sidestepped rendering for most posts.
2. **Wrong post / feed photo** (v4.30): opened permalink renders as a dialog over Home; the engine grabbed a feed post's photo. Fixed by dialog scoping + post-only photo search + bail on Home-feed redirect.
3. **"Fix placeholders" infinite loop**: gated posts re-captured identical junk. Fixed with fingerprint memory (`_phFps`) + `drainCaptures` reject + route-to-Couldn't-capture.
4. **"All FB pictures gone"** — was **not** data loss; it was the `RangeError` render crash at scale. Diagnosed with the IDB/refs/cache snippet (all intact), fixed with lazy image loading.
5. **Deleted posts not removed** ("captured ✓ no render needed"): `og`-first short-circuited render. Fixed with render-first ordering.

---

## 6. Debugging playbook (fast triage for next time)

- **"Which code is live?"** Watch the app console for `[fb-cap] <title> → src=… (ext vX)`. If `vX` is old or you see `chrome-extension://invalid`, the extension is stale → **Remove + Load unpacked** (a plain Reload is not always enough). Content-script changes (`capture-core.js`) also need any open FB tab refreshed — but render-capture opens fresh tabs, so usually just the extension reload.
- **"Images vanished — lost or just not showing?"** Run the IDB-keys vs `ia_imported` refs vs `_imgCache` console snippet. All present → display/render bug (reload or fix render). `IDB blobs: 0` / `IDB open FAILED` → eviction → restore the latest `interests-backup-*.json`.
- **"Same image on many cards?"** Byte-identical fingerprint groups = a placeholder/spinner; `fbPlaceholderGroups` finds them.
- **Before shipping a non-trivial capture change:** run an adversarial multi-agent review workflow (dimensions: contract/round-trip, lifecycle/cleanup, FB behavior, app/UX) with each finding verified.

---

## 7. Cross-cutting lessons (the durable ones)

1. **A detector is only as good as the path that reaches it.** Don't let a fast-path short-circuit past your check (og-first hid dead detection).
2. **"Already done" must mean "done well."** Guard on result *quality*, not just that an attempt happened.
3. **Self-heal loops need a failure memory**, or genuinely-unfixable items cycle forever.
4. **Don't inline large binary payloads into strings.** Attach to DOM nodes and lazy-load. Hard ceilings (max string length) stay invisible until your archive crosses them.
5. **Verify before "recovering."** A display/render bug can look exactly like data loss; check storage first so you don't run a destructive fix on intact data.
6. **For destructive automation (removing cards), the signal must discriminate the actual condition** — render-scoped text, not a string that appears everywhere. Make it conservative, undoable, and backed up.
7. **Order encodes trust.** Whichever source runs first gets to make the irreversible call. Put the most authoritative source first for destructive outcomes.
8. **The rendered page is ground truth for a logged-in SPA.** Raw HTML/og is a fast approximation that lies in specific ways (omits og from the DOM, inlines UI strings, serves spinners to hidden tabs).

---

## 8. Known latent risks / follow-ups

- **Saved/Feed render (`cardHTML`) has the same inline-data-URL pattern** as the old Imported grid; it'll hit the same `RangeError` if saved data-URL clips ever reach the thousands (currently ~18). A spun-off task covers applying the lazy-attach there.
- **The fast `og` batch ("Capture Facebook")** does not remove dead posts (no render) — dead posts captured there with a stale `og` image won't be flagged. The render pass ("Auto-capture in tabs") is where dead removal happens.
- **`impOpen` of an FB card uses `og`, not render** — the reliable FB capture entry points are ↻ and "Auto-capture in tabs".
- **Truly login/age/region-gated posts** FB won't expose to any fetch and won't render a photo even logged-in; these correctly remain favicons in "Couldn't capture" for a true manual Save.

---

*Extension version at time of writing: 4.34. App and extension are in the private repo; personal data (`saves.json`, `*-import.json`, `interests-backup-*.json`, `_recovery/`) stays gitignored and is never committed.*
