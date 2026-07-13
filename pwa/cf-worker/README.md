# Content-Check Worker (Stumble mode dependency)

Stumble mode's safety check (`isVerifiedDiscoveryResult` in `web/lib/capture-state.js`)
requires fetching each AI-suggested URL server-side to see its real HTTP status,
detect dead/removed pages, and pull an `og:image`. A browser can't do this itself —
almost no site's CORS policy allows a page on a different origin to read its
response. This Worker does that one job, ported from `core/contentcheck.js`, and
runs free on Cloudflare's Workers free tier (100,000 requests/day — far more than a
single-user Stumble feed needs).

## Deploy (no CLI, no build step — paste-and-go)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign up free if you
   don't already have an account.
2. In the sidebar: **Workers & Pages** → **Create** → **Create Worker**.
3. Give it any name (e.g. `interests-content-check`) → **Deploy** (it'll deploy a
   placeholder first; that's fine).
4. Click **Edit code** to open the quick-editor.
5. Delete the placeholder code and paste in the full contents of `worker.js` from
   this folder.
6. Click **Deploy** (top right) to publish your version.
7. Set the auth secret: go to the Worker's **Settings** tab → **Variables and
   Secrets** → **Add** → name it `AUTH_TOKEN`, type **Secret**, and paste in any
   long random string (this is the shared password the PWA uses to call this
   Worker — anyone who doesn't have it gets a 401). Generate one easily with:
   ```bash
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
   Save it somewhere (you'll paste it into the PWA's config page next).
8. Note your Worker's URL — shown at the top of the Worker's overview page,
   looks like `https://interests-content-check.<your-subdomain>.workers.dev`.

## Wire it into the PWA

Open `worker-config.html` (in this `pwa/` folder) in your browser, paste in the
Worker URL and the `AUTH_TOKEN` you generated, and save. The PWA's `Store.checkContent`
will then call this Worker instead of returning an empty (always-fails-verification)
result — Stumble mode should start finding live ideas again.

## What this Worker does NOT do

- **`Store.checkLinks`** (a separate "check for dead links in my saved library"
  health-check feature) is still stubbed to return empty. If that turns out to
  matter, the same Worker could be extended with another endpoint — it's a
  simpler check than content-classification (just: is this URL reachable).
- **SSRF protection is simplified** compared to desktop's `core/guardedfetch.js`
  (no DNS-rebinding re-check per redirect hop — Workers don't expose the raw
  socket/DNS API that would need). It blocks the obvious cases (non-http(s)
  schemes, literal private/loopback/link-local IPs) but isn't a hardened
  public-internet SSRF shield. Fine for a personal single-user proxy gated by a
  secret token; don't repurpose this code for a multi-tenant service without
  revisiting that.
- **CORS is currently wide open** (`Access-Control-Allow-Origin: *`) since the PWA
  isn't deployed anywhere with a fixed origin yet. Once Phase 6 deploys to GitHub
  Pages, tighten `CORS_HEADERS` in `worker.js` to that exact origin and redeploy.
