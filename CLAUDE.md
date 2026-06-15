# Interests App

AI-powered personal discovery feed — like a smart Pinterest/Facebook feed that learns your taste.

## Architecture

Single-page vanilla web app. No framework, no build step, no backend. Opens via `index.html` in any browser.

- `index.html` — Everything: HTML structure, `<style>` block with all CSS, `<script>` block with all JS (~1600 lines total). Must stay a single file so it works via double-click.

Everything runs client-side. API keys go only to the user's chosen AI provider.

## Key constraints

- **Zero tooling**: No bundler, no npm, no build. Just open `index.html`.
- **No backend**: localStorage + IndexedDB only. The `saves.json` bridge uses File System Access API (Chrome/Edge).
- **Single-user**: Profile stored in DEFAULTS / localStorage. Not multi-tenant.
- **Privacy-first**: Keys stored in localStorage, never sent anywhere except the chosen AI provider.

## Storage

All state lives in localStorage under `ia_*` keys:
- `ia_settings`, `ia_feed`, `ia_saved`, `ia_hidden`, `ia_clicks`, `ia_shown`, `ia_likes`, `ia_imported`, `ia_spool`, `ia_stcur`, `ia_fcat`, `ia_view`, `ia_itag`, `ia_isrc`

IndexedDB (`ia_fs` database) stores the File System Access directory handle for saves.json sync.

## AI providers

Five backends, all using the same prompt format:
- **Anthropic Claude** — web search via tools API
- **OpenAI ChatGPT** — web search via responses API
- **Google Gemini** — web search via google_search tool (free tier)
- **Groq** — no web search, fast inference
- **Local/Custom** — OpenAI-compatible endpoint (Ollama, OpenRouter, etc.)

Provider abstraction: `callAnthropic()`, `callOpenAI()`, `callGemini()`, `callGroq()`, `callLocal()` — each returns raw text, parsed identically by `parseItems()`.

## External services (no keys needed unless noted)

- `api.allorigins.win` — CORS proxy for link validation
- `wp.com/mshots` + `thum.io` — screenshot fallback chain for card thumbnails
- `widgets.pinterest.com` — pin metadata (images, titles)
- `api.microlink.io` — OG tag extraction fallback
- `noembed.com` — YouTube video title resolution
- `openpagerank.com` — domain popularity filtering (optional free key)
- `cdnjs.cloudflare.com` — JSZip (loaded on demand for ZIP imports)

## Code conventions

- Minified-style CSS (dense, single-line rules grouped by component)
- Global state variables (`S`, `feed`, `saved`, `hidden`, `clicks`, etc.)
- Render functions rebuild innerHTML on every state change (no virtual DOM)
- `persistAll()` writes all state to localStorage + triggers saves.json write
- `toast()` for user notifications
- `esc()` for HTML escaping user content in templates
