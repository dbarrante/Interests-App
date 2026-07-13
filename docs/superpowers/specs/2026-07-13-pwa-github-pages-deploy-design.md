# PWA GitHub Pages deploy (Phase 6) — design

Closes Phase 6 from `pwa/HANDOFF.md`'s recommended next steps: "deploy `pwa/`
to GitHub Pages (gets real HTTPS, which the local dev server can't provide —
needed for both PKCE/Web Crypto and the service worker to work on an actual
iPhone/iPad, not just localhost)." This is the first point the project can
actually be used on the device it was built for.

## Findings that shape this design

- The repo (`dbarrante/Interests-App`) is **private**. GitHub Pages sites
  built from a private repo are still publicly reachable at their URL —
  there is no private-Pages option outside GitHub Enterprise Cloud. The
  source stays private; the deployed static site does not. Confirmed
  acceptable with the user — this is the intended outcome of deploying a
  usable PWA, and the site holds no data of its own (cards/saved items live
  in each device's IndexedDB + the user's private Dropbox, never on the
  server).
- No GitHub Pages is configured on this repo yet (confirmed via
  `gh api repos/dbarrante/Interests-App/pages` → 404).
- The repo is not named `dbarrante.github.io`, so its default Pages URL is a
  **project-page subpath**: `https://dbarrante.github.io/Interests-App/`,
  not the origin root. Three places in the already-shipped PWA code hardcode
  an *origin-root* assumption that a subpath breaks:
  - `pwa/storage-pwa.js:22` — `navigator.serviceWorker.register("/sw.js")`
  - `pwa/storage-pwa.js:73` — `imgUrl(id)` returns `"/idb-img/" + id`, an
    absolute root path. Under a subpath deploy, the service worker's scope
    (derived from where it's registered) would never even see these image
    requests — they'd fall outside its scope entirely, silently breaking
    every image on the page.
  - `pwa/dropbox-connect.js:20` — `redirectUri()` hardcodes
    `location.origin + "/"`, which sends Dropbox the wrong OAuth callback
    URL under a subpath.
  A full grep of every `pwa/*.js` and `pwa/lib/*.js` file for other absolute
  same-origin path strings turned up nothing else — these three (plus the
  service worker's matching regex) are the complete list.
- `pwa/cf-worker/worker.js` already has a
  `// tighten to your GitHub Pages origin once deployed there (Phase 6)`
  comment on its wildcard CORS header — exactly on schedule for this phase.

## Architecture

**`.github/workflows/deploy-pwa.yml`** (new) — a standard modern GitHub
Pages deploy workflow:

- Checks out the repo, uploads the `pwa/` directory as-is (no build step —
  it's already zero-tooling static files) via `actions/upload-pages-artifact
  @v3` (`path: pwa`), then publishes via `actions/deploy-pages@v4`.
- Triggers: `push` to `master` when any `pwa/**` file changes, plus manual
  `workflow_dispatch`.
- Needs `permissions: pages: write, id-token: write` and
  `environment: github-pages` — the standard shape this action requires.
  This typically auto-configures the repo's Pages "source" setting on first
  run; if it doesn't, a one-time manual toggle in Settings → Pages would be
  needed (documented, not assumed).

**Three subpath-safety fixes** (make existing absolute-root assumptions
relative/scope-derived instead — works identically at `localhost:8080`, a
GitHub Pages subpath, or any future custom domain, with no special-cased
branching):

- `pwa/storage-pwa.js`: `register("/sw.js")` → `register("sw.js")`;
  `imgUrl(id)` returns `"idb-img/" + id` instead of `"/idb-img/" + id`.
- `pwa/sw.js`: the fetch handler's `/idb-img/` match
  (`url.pathname.match(/^\/idb-img\/(.+)$/)`) is anchored to the very start
  of the path, which only works when the site is at origin root. Changed to
  match the segment anywhere in the path
  (`url.pathname.match(/\/idb-img\/([^/]+)$/)`), so it works whether the
  full path is `/idb-img/<id>` or `/Interests-App/idb-img/<id>`.
- `pwa/dropbox-connect.js`: `redirectUri()` changes from
  `location.origin + "/"` to `new URL(".", location.href).href` — resolving
  "." against the current document's URL gives its containing directory
  correctly regardless of subpath or whether the URL ends in `index.html`.

No changes to `index.html` at all — every fix is in already-pwa/-scoped
files, so the byte-for-byte-except-`<script>`-tags constraint isn't touched.

**`pwa/cf-worker/worker.js`** — CORS tightened to an **allow-list**, not a
single hardcoded origin. A single static origin would break local dev
testing of Stumble's content-check from `localhost:8080` going forward
(`Access-Control-Allow-Origin` can only echo one value per response). The
Worker instead checks the incoming request's `Origin` header against
`["http://localhost:8080", "https://dbarrante.github.io"]` and echoes back
whichever matches (plus `Vary: Origin`), falling back to the first
allow-listed origin for anything else — which correctly fails a mismatched
browser's own CORS check, since that origin won't match what the browser
expects. This is the standard multi-origin CORS pattern for a Worker (no
per-request server-side origin verification framework needed — it's an
`Array.includes` check).

Note the Origin header is scheme+host+port only, never a path — so
`https://dbarrante.github.io` is the correct allow-list entry even though
the actual site lives under `/Interests-App/`.

**Doc updates** — `pwa/HANDOFF.md`/`pwa/README.md` get Phase 6 checked off,
plus a clear note on what remains manual and outside what an agent can do:
redeploying the updated Worker script to the user's Cloudflare account,
adding the Pages URL as a second registered Dropbox OAuth redirect URI
(alongside `http://localhost:8080/`), and the real-device Add to Home
Screen test.

## Data flow

Push to `master` touching `pwa/**` (or manual dispatch) → Action packages
`pwa/` unchanged → `deploy-pages` publishes to
`https://dbarrante.github.io/Interests-App/`. The three path fixes mean
nothing else changes behavior — the exact same code now resolves correctly
whether loaded from `localhost:8080` or the Pages subpath. Two steps stay
manual: redeploying the Worker, and registering the second Dropbox redirect
URI.

## Error handling

A failed Pages deploy surfaces as a normal failed GitHub Actions run —
nothing silent. The path fixes are pure generalizations, not
subpath-specific branches, so there's no new failure mode introduced for
the existing local-dev flow. An Origin that doesn't match the Worker's
allow-list gets a response whose `Access-Control-Allow-Origin` doesn't match
its own origin, so the browser's built-in CORS enforcement blocks it from
reading the response — equivalent security posture to an explicit deny,
implemented via fallback instead.

## Explicitly out of scope

- Any change to `index.html`.
- A custom domain or a dedicated `dbarrante.github.io` user-Pages repo
  (the rejected alternative to the subpath-safety fixes).
- Actually redeploying the Cloudflare Worker, or registering the Dropbox
  redirect URI — both require the user's own account access.
- The real-device Add to Home Screen test itself (an agent cannot perform
  this; it's the plan's final manual verification step).

## Testing

Manual only, matching every prior phase (no automated test harness for
`pwa/*.js` or for GitHub Actions workflows in this repo): push (or manually
dispatch) the workflow, confirm it succeeds, confirm the deployed site loads
and the service worker registers with the correct scope, images load
correctly under the subpath, and the Manifest panel looks right. Then: add
the Pages URL as a second Dropbox redirect URI and test Connect end-to-end
from the real deployed site (not just localhost). Redeploy the Worker with
the CORS allow-list change and confirm Stumble's content-check works from
both `localhost:8080` and the deployed site. Finally, the actual milestone:
Add to Home Screen on a real iPhone/iPad, confirm the icon, an offline
reload, and a real sync round-trip against a live desktop install.
