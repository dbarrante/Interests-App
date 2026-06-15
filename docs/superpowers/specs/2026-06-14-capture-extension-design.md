# Interests Capture — Chrome Extension Design

## Purpose

A Chrome extension that captures screenshots and page metadata (OG title, description, image) from articles opened via the Interests App, writing them to a localStorage queue that the app drains to populate imported card thumbnails and descriptions. The extension is inert during normal browsing — it only activates when the Interests App explicitly requests a capture. Solves the problem of sites blocking external screenshot/proxy services (mshots, allorigins, Microlink).

## Architecture

### Extension Files

| File | Role |
|---|---|
| `manifest.json` | Manifest V3. Permissions: `activeTab`, `scripting`, `tabs`, `storage` |
| `background.js` | Service worker. Listens for `tabs.onCompleted`, orchestrates capture pipeline |
| `content.js` | Injected into completed pages. Extracts OG metadata and first large content image |

### Trigger: App-Initiated Only

The extension does **not** capture on every page visit. It is inert during normal browsing and only activates when the Interests App explicitly requests a capture:

1. User clicks an imported card in the Interests App → `impOpen()` calls `window.open(url)` AND writes `{url, idx}` to `localStorage.ia_capture_request`
2. The extension's content script on the app tab detects the new key via a `storage` event listener
3. Extension tells `background.js` to watch for a tab loading that URL

This ensures zero surveillance of general browsing — only articles opened from the app are captured.

### Capture Pipeline

1. `background.js` receives the capture request and watches `chrome.tabs.onUpdated` for a tab matching the requested URL with `status === 'complete'`
2. Background injects `content.js` into the matched tab via `chrome.scripting.executeScript()`
3. `content.js` extracts from the page DOM:
   - `og:title` / `twitter:title` meta tag
   - `og:description` / `twitter:description` meta tag
   - `og:image` / `twitter:image` meta tag URL
   - First `<img>` in the page body with `naturalWidth > 200` (fallback content image)
   - The page's canonical URL if different from `location.href`
4. `content.js` sends extracted data back via `chrome.runtime.sendMessage()`
5. `background.js` calls `chrome.tabs.captureVisibleTab(null, {format: 'jpeg', quality: 60})` to get a screenshot data URL (~40-80KB)
6. `background.js` combines metadata + screenshot into a capture object
7. `background.js` finds the Interests App tab and injects a small script that writes the capture to `localStorage.ia_captures`
8. `background.js` clears `localStorage.ia_capture_request` and stops watching — returns to inert state
9. Pending requests expire after 60 seconds (tab never loaded or user navigated away)

### Capture Indicator

When a capture is in progress, the user sees two visual cues:

1. **Extension badge** — `chrome.action.setBadgeText({text: '📷'})` with a colored background while capturing; cleared after completion
2. **Page toast** — a small translucent overlay injected into the bottom-right corner of the captured page reading "Captured for Interests ✓" that auto-fades after 2 seconds via CSS animation

Both are cosmetic — if either fails, the capture still completes normally.

### Capture Object Shape

```json
{
  "url": "https://example.com/article",
  "title": "Article Title",
  "desc": "OG description text",
  "ogImage": "https://example.com/og-image.jpg",
  "contentImage": "https://example.com/photos/hero.jpg",
  "screenshot": "data:image/jpeg;base64,...",
  "ts": 1718400000000
}
```

### Capture Queue (`ia_captures`)

- Stored in `localStorage` on the Interests App origin (`localhost:3456`)
- JSON array, max 20 entries, FIFO eviction (oldest removed when full)
- Deduped by URL before appending — revisiting a page overwrites the previous capture
- Total max size: ~1.5MB (20 slots x ~75KB average)

## App Integration

### Queue Drainer

A new `drainCaptures()` function in the Interests App, called every 3 seconds via `setInterval`:

1. Read `localStorage.ia_captures`, parse as JSON array
2. For each entry, find matching imported item by URL:
   - **Exact match**: `capture.url === item.url`
   - **Normalized match**: strip protocol, `www.`, trailing `/`, query params, then compare
3. Update matching item:
   - **Image priority**: OG image URL (1st) > content image URL (2nd) > screenshot data URL (3rd)
   - **Description**: OG description replaces missing or generic descriptions ("Saved from...", "From your...")
   - **Title**: OG title replaces generic titles (if `genericTitle()` returns true for current title)
4. Remove processed entry from queue
5. If any items were updated: `save('imported', imported)`, `writeSavesFile()`, re-render if on Imported tab
6. Write cleaned queue back to `localStorage.ia_captures`

### Image Priority Rationale

- OG image URLs are small strings (~100 bytes) and load fast — preferred
- Content images are a good fallback for pages without OG tags
- Screenshot data URLs (~60KB) are the last resort — guaranteed to exist but consume storage

### Coexistence with enrichOnOpen

The extension is additive. `enrichOnOpen` still fires on click, but if the extension already populated `it.img` and `it.desc`, the enrichment conditions (`!it.desc || !it.img`) are false and it skips. No conflicts.

## URL Matching

### Normalization

```
normalize(url):
  strip protocol (http:// or https://)
  strip leading "www."
  strip trailing "/"
  strip query string and fragment
  lowercase
```

### Facebook Redirect Handling

Facebook saves sometimes use redirect URLs like `l.facebook.com/l.php?u=<encoded_url>`. The content script detects URLs matching this pattern and extracts the real destination URL from the `u` query parameter for matching purposes.

## Screenshot Quality & Storage

- **Format**: JPEG at 60% quality via `captureVisibleTab`
- **Size**: ~40-80KB per screenshot as base64 data URL
- **Queue limit**: 20 entries (~1.5MB max)
- **On-item storage**: Only screenshot data URLs are stored when no OG/content image is available. Most sites provide an OG image (small URL string), so storage impact is minimal. Natural cap: only visited items get screenshots.

## Edge Cases

| Scenario | Handling |
|---|---|
| Multiple articles opened quickly | Each capture request queued; processed one at a time as tabs complete loading |
| App not running / no app tab found | Captures stored in `chrome.storage.local` as fallback; written to app localStorage when app tab is next detected |
| User navigates away before page loads | 60-second timeout expires; request discarded, extension returns to inert state |
| App on `file://` | Extension cannot inject into `file://` origins. App must run on `localhost:3456`. Extension logs a warning to console |
| Duplicate captures (revisit) | Newer capture replaces older one in queue (deduped by normalized URL) |
| Page with no OG data and no images | Screenshot is the only data captured; still useful |
| Page still loading when captured | `tabs.onUpdated` with `status === 'complete'` ensures DOM is ready; content script waits for `document.readyState === 'complete'` as a guard |
| Chrome internal pages (chrome://, chrome-extension://) | Skipped — `background.js` filters these out before injecting |

## Privacy

- **No ambient capture** — extension is inert during normal browsing; only activates on explicit app request
- No external API calls from the extension
- All data stays local (localStorage + chrome.storage.local)
- Screenshots never leave the machine
- Extension has no network permissions

## Files Changed

### New files (extension)
- `extension/manifest.json`
- `extension/background.js`
- `extension/content.js`

### Modified files (app)
- `index.html` — add `drainCaptures()` function, `setInterval` in init block, write `ia_capture_request` in `impOpen()`

## Not In Scope

- Extension popup UI (no user-facing UI needed; fully automatic)
- Syncing across browsers
- Batch re-capture of existing items
- Extension options page
