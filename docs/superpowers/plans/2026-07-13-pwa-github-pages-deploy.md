# PWA GitHub Pages Deploy (Phase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the iPad PWA build to GitHub Pages over real HTTPS, fixing three latent origin-root-path assumptions that a subpath deploy (`https://dbarrante.github.io/Interests-App/`) would otherwise break, and tightening the Cloudflare content-check Worker's CORS to an allow-list.

**Architecture:** A new GitHub Actions workflow publishes `pwa/` as a Pages artifact on every push to `master` that touches `pwa/**` (plus manual dispatch). Three existing files get relative/scope-derived path fixes instead of hardcoded origin-root assumptions. The Worker's CORS header becomes a small allow-list echo instead of a single hardcoded origin, so local dev keeps working.

**Tech Stack:** GitHub Actions (`actions/upload-pages-artifact`, `actions/deploy-pages`, `actions/configure-pages`), vanilla browser JS (no build step), Cloudflare Workers (plain JS, no dependencies).

## Global Constraints

- No changes to `index.html`'s HTML or inline script — every fix in this plan lives in already-pwa/-scoped files, preserving the documented byte-for-byte-except-`<script>`-tags constraint.
- `SHELL_CACHE` in `pwa/sw.js` must be bumped whenever an already-cached file's content changes (established rule from Phase 5) — this plan changes `pwa/sw.js` itself, so it must bump its own constant.
- The Worker's `Access-Control-Allow-Origin` must support both `http://localhost:8080` (continued local dev) and `https://dbarrante.github.io` (the deployed site) — never a single hardcoded origin, and never a bare wildcard once tightened.
- Actually pushing this branch's merge to `origin/master` (which triggers the first real deploy and makes the site publicly live) and actually redeploying the Cloudflare Worker are both left for the user to explicitly decide when — do not treat "plan complete" as "push it" or "redeploy the Worker."
- Design spec: `docs/superpowers/specs/2026-07-13-pwa-github-pages-deploy-design.md` — read it for full rationale; this plan implements it task-by-task.

---

## File structure

- **Create** `.github/workflows/deploy-pwa.yml` — the Pages deploy workflow.
- **Modify** `pwa/storage-pwa.js` — service worker registration path and `imgUrl()`, both relative instead of absolute-root.
- **Modify** `pwa/sw.js` — the `/idb-img/` match regex, unanchored from path start; bump `SHELL_CACHE` to v4.
- **Modify** `pwa/dropbox-connect.js` — `redirectUri()` derived from the current document's own URL instead of `location.origin`.
- **Modify** `pwa/cf-worker/worker.js` — CORS allow-list instead of a single hardcoded/wildcard origin.
- **Modify** `pwa/HANDOFF.md`, `pwa/README.md` — check off Phase 6, document the two remaining manual steps (Worker redeploy, second Dropbox redirect URI) and the real-device test.

---

## Task 1: Subpath-safety fixes

**Files:**
- Modify: `pwa/storage-pwa.js`
- Modify: `pwa/sw.js`
- Modify: `pwa/dropbox-connect.js`

**Interfaces:**
- No new interfaces — these are behavior-preserving generalizations of existing functions (`Store.imgUrl`, the service-worker registration call, `redirectUri()` in `pwa/dropbox-connect.js`). Nothing outside these three files calls anything new.

- [ ] **Step 1: Fix the service worker registration path in `pwa/storage-pwa.js`**

Find (around line 21-25):

```javascript
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.error("Service worker registration failed (images will not load):", e);
    });
  }
```

Change to:

```javascript
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register("sw.js").catch((e) => {
      console.error("Service worker registration failed (images will not load):", e);
    });
  }
```

- [ ] **Step 2: Fix `imgUrl()` in the same file**

Find (in the `Store` object, around line 73):

```javascript
    imgUrl(id) { return "/idb-img/" + encodeURIComponent(id); },
```

Change to:

```javascript
    imgUrl(id) { return "idb-img/" + encodeURIComponent(id); },
```

- [ ] **Step 3: Fix the `/idb-img/` match regex in `pwa/sw.js`**

Find (around line 56):

```javascript
  const m = url.pathname.match(/^\/idb-img\/(.+)$/);
```

Change to:

```javascript
  const m = url.pathname.match(/\/idb-img\/([^/]+)$/);
```

(Safe because `encodeURIComponent`, used by `imgUrl()`, always encodes a literal `/` as `%2F` — an id can never contain an unencoded slash, so `[^/]+` still captures the entire id and nothing more.)

- [ ] **Step 4: Bump `SHELL_CACHE` in `pwa/sw.js`**

Find (around line 21):

```javascript
const SHELL_CACHE = "interests-pwa-shell-v3"; // bump on ANY edit to an already-cached
```

Change to:

```javascript
const SHELL_CACHE = "interests-pwa-shell-v4"; // bump on ANY edit to an already-cached
```

- [ ] **Step 5: Fix `redirectUri()` in `pwa/dropbox-connect.js`**

Find (around line 20):

```javascript
  function redirectUri() { return location.origin + "/"; }
```

Change to:

```javascript
  function redirectUri() { return new URL(".", location.href).href; }
```

- [ ] **Step 6: Syntax-check all three files**

Run: `node --check pwa/storage-pwa.js && node --check pwa/sw.js && node --check pwa/dropbox-connect.js`
Expected: no output (all three valid).

- [ ] **Step 7: Manually verify subpath correctness locally**

This can be verified without an actual GitHub Pages deploy by serving the whole repo (not just `pwa/`) and browsing to a subpath — this exactly mirrors how a GitHub Pages project site serves `pwa/` under `/Interests-App/`.

1. From the repo root (not inside `pwa/`): `python -m http.server 8080`
2. Open `http://localhost:8080/pwa/` in a browser (note the `/pwa/` — this is the subpath simulation).
3. DevTools → Application → Service Workers: confirm the registered worker's scope is `http://localhost:8080/pwa/` (not the origin root).
4. Confirm images still load (the `/idb-img/` proxy resolves correctly under the subpath).
5. Confirm the Settings panel's Dropbox section still renders (doesn't require an actual OAuth round-trip for this check — just confirms nothing crashed).
6. Stop this test server before continuing normal `pwa/`-rooted local dev (`cd pwa && python -m http.server 8080`), so you don't confuse the two.

- [ ] **Step 8: Commit**

```bash
git add pwa/storage-pwa.js pwa/sw.js pwa/dropbox-connect.js
git commit -m "fix(pwa): make service worker scope, image URLs, and OAuth redirect subpath-safe"
```

---

## Task 2: GitHub Actions Pages deploy workflow

**Files:**
- Create: `.github/workflows/deploy-pwa.yml`

**Interfaces:**
- None — this is a standalone CI workflow, independent of Task 1/3/4.

- [ ] **Step 1: Create the workflow file**

```yaml
name: Deploy PWA to GitHub Pages

# Publishes pwa/ as a static site whenever it changes on master, so the iPad
# PWA build is reachable over real HTTPS (required for PKCE/Web Crypto and
# the service worker — see pwa/HANDOFF.md's Phase 6).

on:
  push:
    branches: [master]
    paths:
      - 'pwa/**'
  workflow_dispatch: {}

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Upload pwa/ as the Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: pwa

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Validate the YAML syntax**

Run: `node -e "require('fs').readFileSync('.github/workflows/deploy-pwa.yml','utf8')" && python -c "import yaml, sys; yaml.safe_load(open('.github/workflows/deploy-pwa.yml'))" 2>&1 || echo "python+pyyaml not available, skip"`

If `pyyaml` isn't available, that's fine — the syntax will also be validated for real the first time the workflow runs. Expected either way: no YAML parse error reported.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-pwa.yml
git commit -m "feat: add GitHub Pages deploy workflow for the iPad PWA build"
```

**Note for the controller/user, not a plan step:** this workflow only actually runs (and only actually makes the site live) once this branch is merged AND pushed to `origin/master` — merging locally is not enough. Per this plan's Global Constraints, that push is a deliberate, separate decision, not implied by "the plan is done."

---

## Task 3: Cloudflare Worker CORS allow-list

**Files:**
- Modify: `pwa/cf-worker/worker.js`

**Interfaces:**
- Produces: `corsHeaders(request)` — replaces the old bare `CORS_HEADERS` constant. Nothing outside this file calls it (it's a single-file Cloudflare Worker with no imports elsewhere in the repo).

- [ ] **Step 1: Replace the CORS constant and all its usages**

Find (around line 196-218, the file's last section):

```javascript
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your GitHub Pages origin once deployed there (Phase 6)
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });

    const token = request.headers.get(AUTH_HEADER);
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    let body;
    try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }); }
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []; // cap per-request batch size

    const results = await checkContentChunk(items);
    return new Response(JSON.stringify({ results }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  },
};
```

Change to:

```javascript
// Allow-list, not a single hardcoded origin: a static single origin would break
// local dev testing of Stumble's content-check from localhost:8080 once this is
// tightened for the deployed GitHub Pages site, since a CORS response can only
// echo back ONE Access-Control-Allow-Origin value. Instead, check the request's
// actual Origin against this list and echo back whichever one matches (Phase 6).
const ALLOWED_ORIGINS = ["http://localhost:8080", "https://dbarrante.github.io"];

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

    const token = request.headers.get(AUTH_HEADER);
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...headers, "Content-Type": "application/json" } });
    }

    let body;
    try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } }); }
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []; // cap per-request batch size

    const results = await checkContentChunk(items);
    return new Response(JSON.stringify({ results }), { headers: { ...headers, "Content-Type": "application/json" } });
  },
};
```

- [ ] **Step 2: Syntax-check**

Run: `node --check pwa/cf-worker/worker.js`
Expected: no output (valid syntax). Note: this file uses `export default`, which `node --check` parses fine as an ES module — if it errors specifically on that, confirm by running `node --input-type=module --check < pwa/cf-worker/worker.js` instead.

- [ ] **Step 3: Commit**

```bash
git add pwa/cf-worker/worker.js
git commit -m "fix(pwa): allow-list CORS origins on the content-check Worker instead of a wildcard"
```

**Note for the controller/user, not a plan step:** this only takes effect once the updated `worker.js` is redeployed to the user's actual Cloudflare account — that's a manual step outside this repo that an agent cannot perform.

---

## Task 4: Documentation updates

**Files:**
- Modify: `pwa/HANDOFF.md`
- Modify: `pwa/README.md`

**Interfaces:**
- None — documentation only.

- [ ] **Step 1: Update `pwa/README.md`'s "What's next" section**

Find:

```markdown
## What's next (not built yet)

- Phase 5: PWA manifest + extend `sw.js` for full offline app-shell caching and installability
- Phase 6: deploy to GitHub Pages (gets real HTTPS, which the local dev server
  can't provide — needed for both PKCE/Web Crypto and the service worker to work
  on an actual iPhone/iPad, not just localhost), verify on a real device via Add to
  Home Screen, confirm a full sync round-trip against a live desktop install
```

Change to:

```markdown
## What's next (not built yet)

- Phase 5: done — see `pwa/HANDOFF.md`.
- Phase 6: done in code — GitHub Actions deploys `pwa/` to GitHub Pages on every
  push to `master` (`.github/workflows/deploy-pwa.yml`), three origin-root-path
  assumptions were fixed to work under the Pages subpath, and the Cloudflare
  content-check Worker's CORS is now an allow-list (`localhost:8080` +
  `https://dbarrante.github.io`). **Three things remain manual, outside what an
  agent can do:** redeploy the updated `pwa/cf-worker/worker.js` to your actual
  Cloudflare account; add `https://dbarrante.github.io/Interests-App/` as a
  second registered redirect URI in the Dropbox App Console (alongside
  `http://localhost:8080/`); and verify Add to Home Screen on a real
  iPhone/iPad — the first point this project can actually be used on the
  device it was built for.
```

- [ ] **Step 2: Add a short Phase 6 section to `pwa/HANDOFF.md`**

Find the "Recommended next steps, in order" section (the file's last section) and, immediately before it, insert:

```markdown
## Phase 6 (done in code, not yet verified live)

GitHub Actions (`.github/workflows/deploy-pwa.yml`) deploys `pwa/` to GitHub
Pages on every push to `master` touching `pwa/**`, plus manual dispatch. The
default project-site URL for this repo is a subpath —
`https://dbarrante.github.io/Interests-App/`, not the origin root — which
would have broken three hardcoded-root-path assumptions (service worker
registration, `Store.imgUrl()`, the OAuth `redirectUri()`); all three are now
relative/scope-derived instead. The Cloudflare content-check Worker's CORS is
now an allow-list (`localhost:8080` + the Pages origin) instead of a
wildcard, so local dev testing keeps working alongside the deployed site.

**Three things still require a human, outside what an agent can do:**
1. Redeploy the updated `pwa/cf-worker/worker.js` to your Cloudflare account.
2. Add `https://dbarrante.github.io/Interests-App/` as a second registered
   OAuth redirect URI in the Dropbox App Console (keep
   `http://localhost:8080/` too, for continued local dev).
3. Verify Add to Home Screen on a real iPhone/iPad, confirm the icon renders,
   an offline reload works, and a full sync round-trip succeeds against a
   live desktop install.
```

- [ ] **Step 3: Commit**

```bash
git add pwa/HANDOFF.md pwa/README.md
git commit -m "docs(pwa): document Phase 6 GitHub Pages deploy and remaining manual steps"
```

---

## Self-review notes

- **Spec coverage:** GitHub Actions Pages workflow (push-to-master + manual dispatch, `actions/upload-pages-artifact` + `actions/deploy-pages`) → Task 2. Three subpath-safety fixes (`register`, `imgUrl`, idb-img regex, `redirectUri`) → Task 1, all four exact edits present. `SHELL_CACHE` bump for the `sw.js` edit → Task 1 Step 4. CORS allow-list (not single origin, not wildcard) → Task 3. Doc updates covering the three remaining manual steps → Task 4. No `index.html` edits anywhere → confirmed, none of the four tasks touch it. Local subpath verification method (serving the whole repo and browsing to `/pwa/`) → Task 1 Step 7.
- **Placeholder scan:** none found — every step ships complete, runnable code/config and concrete manual-verification instructions.
- **Type/name consistency:** `corsHeaders(request)` and `ALLOWED_ORIGINS` used identically within Task 3 (single file, single task, no cross-task interface to drift). `SHELL_CACHE`'s new value (`v4`) doesn't collide with Phase 5's progression (v1→v2→v3 already shipped on master). `redirectUri()`'s new body doesn't change its call sites in the rest of `pwa/dropbox-connect.js` (still a zero-argument function returning a string, exactly as before) — confirmed no other function signature needed to change.
