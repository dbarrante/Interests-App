# Interests — Your AI Discovery Feed

A standalone web app (no install, no server) that works like a Pinterest/Facebook feed, except an AI of your choice finds the content based on your interests — and learns from every save.

## How to use

1. Double-click `index.html` (opens in your browser).
2. Go to **Settings**, pick a provider, paste an API key:
   - **Claude (Anthropic)** — get a key at console.anthropic.com/settings/keys
   - **ChatGPT (OpenAI)** — platform.openai.com/api-keys
   - **Gemini (Google)** — aistudio.google.com/apikey (free tier, has web search)
   - **Groq** — console.groq.com/keys (free tier, very fast, no web search; in-app popup has step-by-step instructions)
3. Hit **New ideas**. The AI web-searches for real articles, projects, tools, and initiatives matched to your profile and writes a two-sentence "Why for you" on each card.
4. Click a card to open the article. **Save** what you like, **Not for me** what you don't — both teach the feed. Saved items live in the **Saved** tab.

## Settings

- **Category importance** sliders (0–10) control the feed mix across: personal projects & hobbies, work initiatives, career movement, life direction — plus any custom categories you add. Type your own, or hit **✨ Suggest categories** to have the AI propose new ones based on your profile and import history; selected ones get their own color, slider, filter pill, and share of the feed. Custom categories can be removed anytime (✕).
- **Interest profile** is pre-seeded from your Facebook saves (3D printing, retro gaming, fishing, AI/Claude workflows, career development, etc.). Edit freely.
- **Provider/model** can be switched anytime; each provider's key is remembered separately.

## Site popularity filter

Settings → "Site popularity filter" toggle steers recommendations toward high-traffic, reputable sites. Add a free Open PageRank key (openpagerank.com — popup instructions in-app) and it's enforced with real rankings: every recommendation's domain is scored 0–10 and anything under ~3.5 is dropped before reaching your feed or Stumble.

## Free & local AI options

- **Gemini free tier** — best free cloud option, includes web search (real, live links).
- **Local / Custom provider** — works with:
  - **Ollama** (100% free, runs on your PC): install from ollama.com, run `ollama pull llama3.1:8b`, then start it with the environment variable `OLLAMA_ORIGINS=*` so the browser can call it. Endpoint: `http://localhost:11434/v1`, no key.
  - **OpenRouter** (`https://openrouter.ai/api/v1`) — free models ending in `:free`.
  - **Groq** (`https://api.groq.com/openai/v1`) — generous free tier, very fast.
  - Caveat: these have no web search, so links may occasionally be stale.

## Stumble

The **Stumble** tab is StumbleUpon reborn: one page at a time with a big preview, picked for serendipity ("things you'd never have searched for"). 👍 / 👎 teach it your taste, Save keeps it, Open jumps to the page. Category pills work here too — stumble within just one interest area. It fetches a batch of ~10 candidates at a time and quietly tops up in the background.

## Category tabs & view formats

Pills above the feed (All / Personal / Work / Career / Life) filter both the feed and your Saved tab. On the right of that bar, view format buttons switch between **4×4** (standard grid), **8×8** (dense thumbnail grid), **Detail** (two wide columns, bigger text), and **List** (horizontal rows). Your choice is remembered.

## Import your Facebook / Pinterest / YouTube saves

Settings → "Import your saves". Click the platform buttons there for step-by-step export popups:

- **Facebook:** Accounts Center → Download your information → only "Saved items and collections".
- **Pinterest:** Settings → Privacy and Data → Request your data.
- **YouTube:** takeout.google.com → only "YouTube and YouTube Music" (history, playlists, subscriptions). Playlist/Liked exports contain only video IDs — the app auto-resolves titles (up to 60 per import). "Watch Later" is not included in Google's export.

Drop the downloaded file into the import control — the ZIP works as-is. The app natively understands Pinterest's export format (real pin image, description, original article link per pin) and Facebook's export format (clickable post permalinks from your collections with group/author context, plus saved external articles with their real titles and URLs — note: Facebook's export omits links for plain post-saves outside collections, so those are skipped). Pre-processed `pinterest-import.json` and `facebook-import.json` from the June 2026 exports are in this folder. Imported titles become taste signals (they shape recommendations but don't clutter your Saved tab). A starter file, `facebook-saves.txt`, is in this folder — import it to seed learning from your existing FB saves immediately.

The **🏷 Tag** button (next to Enrich) auto-scans imported *and* saved articles: your AI assigns each one 2–4 keyword tags plus the best-fit category from your category list (custom categories included). Tags appear as clickable chips — click one anywhere to filter the Imported tab by it — and the search box matches tags too. Promoting an imported item to Saved carries its tags and tagged category along. Like Enrich, it runs ~120 items per click and resumes where it left off.

Everything you import is browsable in the **Imported** tab: search across all of it, 👍 Like the ones that still resonate (feeds the learning loop), promote items with links into Saved, or ✕ remove junk. Items with links get automatic pictures (YouTube thumbnails / page screenshots). The **✨ Enrich** button does two things: pulls real Pinterest pin data (actual pin image, title, and description, straight from Pinterest — no key needed, with a metadata-service fallback), then has your AI write a one-sentence description for everything else (batched ~40 at a time; resumes where it left off).

## Discover new interests

In Settings, type a rough musing ("curious about welding, maybe smart irrigation…") and hit **Suggest interest categories** — your AI returns specific category chips, including adjacent ideas you didn't think of. Tap to select, then **Add selected to my profile**.

## iPhone (future)

The app has PWA groundwork (manifest + meta tags). When ready: publish this folder to GitHub Pages (free), open the URL on iPhone Safari, "Add to Home Screen" — it becomes a full-screen app. Cross-device sync of saves/settings would then go through the Dropbox API. A native App Store app would wrap the same page (Capacitor).

## Notion & morning briefing

In Settings, click **Connect app folder** (choose this app's folder) — the app then keeps a `saves.json` file in sync. Claude reads it to:
- Sync your saves into the Notion database **"Interests App — Saved Articles"**
- Build your daily **Morning Briefing** (scheduled ~7am: your Notion to-dos + projects, new saves synced, fresh finds; delivered as a Gmail draft + Cowork notification). Note: scheduled tasks run while the Claude desktop app is open.

## Notes

- Everything (keys, saves, learning history) is stored locally on your device. Keys are sent only to the AI provider you chose — except that, when Dropbox sync is connected, your provider keys are also included (in plaintext) in the synced settings inside your own Dropbox (`/Interests App/sync/`) so every device gets them automatically (your choice, 2026-07-16; the desktop's GitHub `updateToken` never syncs). Use **Export my data** for a backup.
- Each refresh costs a few cents of API usage (Gemini's free tier may cover it).
- Card thumbnails use the article's preview image when available, otherwise a live screenshot service, otherwise a styled placeholder.
