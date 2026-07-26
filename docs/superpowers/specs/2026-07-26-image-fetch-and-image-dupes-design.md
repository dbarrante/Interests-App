# Remote-image fetch + image-based duplicate detection — design

**Date:** 2026-07-26
**Status:** approved (brainstorming), ready for implementation planning

Two related pieces of work, sharing one new capability (fetching a remote card
image without CORS):

- **Item A** — Pinterest cards show `(untitled)` and refuse to update. Root cause
  identified; fix restores the whole title pipeline for remote-image cards.
- **Item B** — duplicate detection misses cards that are the same thing saved
  twice with different links and titles. Adds image similarity as a new,
  deliberately separate matching signal.

---

## Item A — remote card images are unreachable by the title pipeline

### Problem

`resolveCardImageForAI` (web/index.html, pwa/index.html) resolves a card's image
to JPEG bytes for the OCR and vision tiers. For an `idb:` image it fetches
`/api/img/<id>` — same origin, fine. For an `http(s)` image it calls browser
`fetch()` directly on the remote URL.

Pinterest card images are remote (`i.pinimg.com`). An `<img>` tag renders those
without needing CORS, which is why the thumbnails are visible in the Title-issues
list; `fetch()` does need CORS and is refused. The `catch` returns `null`, so:

1. `ocrExtractText` returns `null` (no pixels to read),
2. the vision tier gets no image and is skipped,
3. `generateUniqueTitle` falls through to `fallbackCollectionTitle` and usually
   returns `null`,
4. the UI reports nothing actionable.

Observed: 63 flagged cards, most Pinterest, titles `(untitled)`, thumbnails
plainly showing readable text ("CREAMY CILANTRO GARLIC SAUCE"). Re-saving the
pin does not help — the image is still remote. Clicking the per-card title
refresh does not help — same failed fetch.

### Fix

Add `POST /api/fetch-image` to `core/server.js`. Body `{ url }`. It fetches the
URL server-side (no CORS applies to a Node HTTP client) and returns the image
bytes with their content type.

`resolveCardImageForAI` changes only its `http(s)` branch: instead of
`fetch(srcUrl)` it posts the URL to `/api/fetch-image` and uses the returned
bytes. The `idb:` branch, the downscale-to-1024px step, the JPEG re-encode, and
the `catch → null` contract are all unchanged.

`core/capturemeta.js` already contains `_fetchImageDataUrl(url, opts)`, which
does a size-capped server-side image fetch. The endpoint reuses that logic rather
than adding a second fetcher.

### Security — SSRF

An endpoint that fetches a caller-supplied URL is a server-side request forgery
hole unless constrained. The local service is reachable from the app UI and the
browser extension, so this must be guarded even though it only binds loopback.

Required guards:

- **Scheme:** `https:` only. Reject `http:`, `file:`, `data:`, `blob:`, and
  anything else.
- **Destination:** resolve the hostname and reject loopback (`127.0.0.0/8`,
  `::1`), private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`),
  link-local (`169.254/16` — this covers the cloud metadata endpoint
  `169.254.169.254`), and unspecified/reserved addresses.
- **Redirects:** re-apply the destination check to every hop; never follow a
  redirect to a blocked host. Cap redirect depth.
- **Content type:** response must be `image/*`, else reject.
- **Size and time:** abort past **8 MB** or **15 s**. (8 MB comfortably exceeds
  any real card thumbnail — `resolveCardImageForAI` downscales to a 1024px edge
  anyway — while bounding a hostile or runaway response. 15 s matches the
  responsiveness budget of the surrounding capture code.)
- **Response shape:** return only bytes plus content type. Never echo response
  headers, the final URL, or error bodies back to the caller — those leak
  information about the network the server can see.

Per `.claude/skills/project-conventions/SKILL.md`, a change to `core/server.js`
adding a new route goes through the **electron-security-reviewer** agent before
merge.

### PWA

`pwa/index.html` has no Core service. Its `http(s)` branch falls back to the
`allorigins` CORS proxy already listed in CLAUDE.md's external services. The PWA
does not gain the SSRF surface because there is no server involved.

### Failure visibility

Today a card that cannot produce a title fails silently. The pipeline should
distinguish and surface:

- image could not be fetched or decoded,
- OCR found no text above the confidence/length bar,
- the AI call failed (including rate-limited / no credits).

This matters immediately: the vision model currently selected is
"NVIDIA: Nemotron 3 Nano Omni (free) — rate-limited", which fails in a way the
user cannot currently distinguish from "no usable image".

---

## Item B — image-based duplicate detection

### Problem

`scanDuplicates()` already walks the entire library (all imported + all saved).
Coverage is not the gap. Matching is: it groups on normalized URL (`dupeKey`) or
normalized title (`normTitle`). The duplicates being missed are **the same
picture saved twice with different links and titles** — a pin and its source
article, or the same item re-pinned. Neither key matches, so they never group.

The existing `imgFp` value cannot help: it is
`length + "|" + first 48 chars + "|" + last 48 chars` of the data URL, an
exact-match fingerprint. Two encodings of the same picture do not match, and it
is still used by placeholder detection, so its format must not change.

### Hashing

Compute a **64-bit dHash** (difference hash) per card image:

1. reuse the downscaled bitmap `resolveCardImageForAI` already produces,
2. reduce to 9×8 greyscale,
3. emit one bit per horizontally-adjacent pixel pair (left > right),
4. giving 64 bits, serialized as 16 hex characters.

dHash is chosen over aHash (too permissive; flat/branded images collide) and over
pHash (needs a DCT for accuracy this use case does not require).

Similarity is **Hamming distance** between two hashes. **Start at ≤ 5 bits of
64** — strict: catches the same image re-saved, re-pinned, or re-screenshotted at
a different size or compression, and does not attempt to group different
photographs of the same subject.

That figure is a starting point, not a guess to leave unexamined. During
implementation, run the hash over the real library, print the distance
distribution for a sample of known-duplicate and known-distinct pairs, and
confirm 5 separates them. If it does not, adjust and record the measured
distribution in a comment beside the constant so the next person sees the
evidence rather than a magic number. Err toward a lower threshold: the cost of
too strict is a missed duplicate, the cost of too loose is a deleted card.

### Cache

Card id → `{ hash, srcKey }`, stored in the `ia_imghash` kv entry (the same
`Store.kvGet`/`kvSet` mechanism the other `ia_*` state uses), **not** in the `fp`
table — placeholder detection depends on that format.

`srcKey` identifies the image the hash was computed from, so the entry
self-invalidates when a card's picture changes (re-capture, manual upload,
"Fix placeholders"). A cached entry whose `srcKey` no longer matches the card's
current image is recomputed.

Deleting a card removes its cache entry alongside its image file and `fp` entry,
in the existing removal path.

### Scan

On demand, when the Duplicates tab is opened. Not at startup: startup
responsiveness is a live concern in this project, and this cost should not be
paid by users who never open the feature.

- progress indication while hashing (the first pass over a ~6,000-image library
  decodes every image, including network fetches for remote ones),
- **resumable**: each computed hash is cached as it is produced, so closing the
  modal part-way through means the next open continues rather than restarts,
- remote images are fetched through whichever path Item A established for that
  build — the Core endpoint on desktop, the `allorigins` proxy in the PWA — so
  Pinterest cards participate, which is where the missed duplicates actually are,
- a card whose image cannot be fetched or decoded is skipped, cached as
  "unhashable" so it is not retried on every scan, and never grouped.

### Grouping — a separate second pass

The existing URL/title union-find runs **unchanged**. Image similarity runs as a
**second pass over cards that the first pass did not already group**, producing
its own groups.

Two reasons this is separate rather than another key in the same union-find:

1. **No regression surface.** Today's grouping and today's auto-check behavior
   are untouched, so the existing dedup flow cannot change behavior.
2. **No transitive merging.** In one shared union-find, `A ~ B` by image plus
   `B ~ C` by title would merge A and C into a single group, even though nothing
   links A to C. With deletion as the outcome, that is unacceptable.

### Safety

This flow deletes cards, and perceptual matching has false positives — pins
sharing a template or a background can hash close.

- image-matched groups carry a **distinct badge** identifying them as image
  matches,
- their members render **unchecked**; nothing can be removed without the user
  explicitly ticking it (URL/title groups keep today's best-copy-kept,
  rest-checked behavior),
- the existing "not a duplicate" dismissal memory (`dupeGroupDismissed`,
  `dupeNotDuplicateGroups`) applies to image groups too,
- the existing pre-destructive safety snapshot still gates removal.

Per project conventions, this goes through the **data-safety-reviewer** agent
before merge.

---

## Testing

**Pure functions, plain Node `assert` tests** (`node tests/<name>.test.js`):

- dHash: stable for the same input; unchanged by re-encoding at a different JPEG
  quality; different for visibly different images.
- Hamming distance: known vectors, including identical (0) and inverted (64).
- Grouping: image pass ignores cards already grouped by URL/title; no transitive
  merging across the two passes; a dismissed group stays dismissed.
- Cache invalidation: an entry whose `srcKey` no longer matches is recomputed.
- SSRF guard predicate: rejects `http:`, `file:`, `data:`; rejects `localhost`,
  `127.0.0.1`, `::1`, `10.x`, `192.168.x`, `172.16.x`, `169.254.169.254`;
  rejects a redirect whose target resolves to a blocked address; rejects a
  non-image content type; rejects an oversize body. Accepts an ordinary public
  HTTPS image URL.

**Structural tests** (regex against shipped source, existing convention): the
`http(s)` branch of `resolveCardImageForAI` routes through the endpoint rather
than calling `fetch` directly; web and pwa stay byte-identical for shared
functions.

**Browser verification** (against an isolated temp store, never the real one):

- a Pinterest-shaped card with a remote image and an empty title goes from
  `(untitled)` to a real title read off the picture,
- a known-duplicate pair with the same image and different URLs/titles groups,
  renders with the image badge, and renders unchecked,
- interrupting the hashing scan and reopening resumes rather than restarting.

## Out of scope

Deliberately not built now:

- a sensitivity slider for the image threshold — ship strict; revisit only if it
  demonstrably leaves real duplicates behind,
- a separate "Similar images" tab — image groups live in Duplicates, badged,
- background hashing at startup — see the startup-responsiveness rationale above,
- changing `imgFp` or the `fp` table's format — placeholder detection depends on
  both.

## Review gates

- `core/server.js` new route → **electron-security-reviewer**
- duplicate removal path → **data-safety-reviewer**
- `pwa/index.html` edited → **`SHELL_CACHE` bump** in `pwa/sw.js` before release
