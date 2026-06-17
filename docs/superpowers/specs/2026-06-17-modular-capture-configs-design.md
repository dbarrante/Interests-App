# Modular per-platform capture configs — design

**Date:** 2026-06-17
**Status:** Approved

## Goal
Make the extension's capture mechanisms modular so adding or tuning a platform
(Facebook, Instagram, Pinterest, generic website) is a small, isolated change —
not a rewrite. Today the per-platform logic lives in separate content scripts
(`fb-save.js`, `ig-save.js`) that duplicate helpers (`rectOf`, `largestImg`,
`txtOf`, `isSpecific*`, `extractPost`, save-trigger detection).

## Decisions
- **Shared engine + declarative config objects** (not separate plugin files, not
  just a shared library).
- **Unify everything**: the generic website capture is the default/fallback
  config; Facebook/Instagram/Pinterest are configs that override it on their
  sites.
- **Code-only** — no Settings UI for now.

## Architecture
- **`capture-core.js`** — the engine. Holds all common logic: `rectOf`,
  `largestImg`, `txtOf`, timestamp hover-coax, debounce, the capture-phase click
  listener, and the orchestration: *qualifying Save click → find post → (hover
  coax) → wait `preCaptureDelayMs` for the native menu to close → measure rect →
  build payload {url,title,desc,image-hint,rect} → `chrome.runtime.sendMessage
  clipSocialPost`*. Picks the active config by `location.hostname` at load.
- **`capture-configs.js`** — a map of platform config objects. The engine reads a
  global `INTERESTS_CAPTURE_CONFIGS` it defines. Both files are listed (configs
  first) in one `content_scripts` entry so they share the isolated-world scope.

Adding a platform = add a config object + add its host to the manifest `matches`.

## Config schema
Engine supplies defaults; each config overrides only its specifics.
```
{
  id: "facebook",
  match: (host) => bool,
  saveTrigger: (clickTarget) => bool,   // is this a native "Save" click?
  findPost: (clickTarget) => Element,   // the post container to crop
  isSpecificUrl: (href) => bool,        // page URL already the permalink?
  findPermalink: (post) => url,         // scrape fallback (feed view)
  extract: (post) => { author, text },
  title: (author) => string,
  image: "region" | "cdnImage" | "ogImage" | "screenshot",
  imageCdn: RegExp,                     // for cdnImage / largestImg
  preCaptureDelayMs: number,
  hoverTimestamps: bool,                // coax lazy permalink hrefs (FB)
}
```

## The four configs
- **facebook** — port `fb-save.js` verbatim: menu-item Save trigger; post finder
  via menu `aria-controls` → trigger → smallest/innermost `[role=article]`;
  `isSpecificUrl` = FB post/photo/permalink patterns; `findPermalink` = hover the
  timestamp then read href; `image: "region"`; `preCaptureDelayMs: 550`;
  `hoverTimestamps: true`.
- **instagram** — port `ig-save.js`: bookmark "Save" aria-label trigger; post =
  `closest('article')`; `isSpecificUrl` = `/p//reel//tv/`; permalink = the
  `<a>` wrapping `<time>`; `image: "region"`; delay 250.
- **pinterest** — NEW, best-effort: detect the pin "Save" button (aria-label/text
  "Save"); post = the pin element (`closest('[data-test-id="pin"], [role="listitem"]')`
  or the `a[href*="/pin/"]` container); `isSpecificUrl`/permalink = `/pin/<id>/`;
  `image: "region"`; delay ~300. Tune from console output.
- **default (website)** — no in-page trigger; the existing popup **Clip** +
  right-click **Save to Interests** + `content.js` OG metadata + screenshot path,
  unchanged. This is what runs when no platform config matches.

## Background
Unchanged in behavior. `clipSocialPost` / `cropScreenshot` / `fetchAsDataUrl` /
`clipCurrentPage` already implement the image fallback chain (region crop →
CDN image data URL → full screenshot) and durable data-URL storage. Minor: accept
an optional `strategy`/`image` hint to pick the fallback order.

## Files
- Add: `capture-core.js`, `capture-configs.js`.
- Remove: `fb-save.js`, `ig-save.js` (logic moves into configs).
- Manifest: one `content_scripts` entry → `[capture-configs.js, capture-core.js]`
  matching facebook + instagram + pinterest. Bump version.
- Unchanged: `background.js` (minor), `content.js`, `bridge.js`, popup, app.

## Risk & mitigation
Facebook and Instagram work today; the chief risk is regressing them. Mitigation:
port their selector logic byte-for-byte into config methods, leave the background
handler untouched, syntax-check + simulate matchers, and keep the rich console
logs (`[Interests] <platform> save | author= | url= | rect=`) so each platform is
verifiable after an extension reload.

## Out of scope (for now)
Settings UI; X/Twitter, Reddit, LinkedIn, YouTube configs (the schema makes them
easy to add later).
