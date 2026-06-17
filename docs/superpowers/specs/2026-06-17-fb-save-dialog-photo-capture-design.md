# Facebook save: capture the post photo, not the "Save To" dialog — design

**Date:** 2026-06-17
**Status:** Approved

## Problem
On Facebook, clicking "Save" opens a **"Save To" collection picker** dialog
(present for accounts with collections) that stays open over the post until
"Done". The capture fires 550 ms after the Save click, so it screenshots that
dialog instead of the post.

## Decision
Capture the post's **own photo** (the largest `fbcdn` image inside the post),
fetched to a durable data URL, instead of a region screenshot. The dialog lives
in a separate `[role=dialog]` and is never inside the post's image element, so
reading the post photo ignores the overlay — no timing/dismissal logic needed.

## Changes (one per layer)
1. **capture-configs.js** — Facebook config `image: "region"` → `image: "photo"`.
   (Sole platform-specific change; Instagram/Pinterest unchanged.)
2. **capture-core.js** — engine sends a `strategy` field (= `cfg.image`) in the
   clip payload, and includes the post `rect` for both `"photo"` and `"region"`
   strategies (so a text-only post can still fall back to a region crop). Image
   fallback (`largestImg`) is already sent.
3. **background.js** — `clipSocialPost` orders its fallback chain by strategy:
   - `"photo"`: fetch post image → crop rect → full screenshot.
   - `"region"` (default): crop rect → fetch image → full screenshot.
   All results stored as durable data URLs (existing behavior).

## Trade-off
Photo posts capture the real photo regardless of the dialog. **Text-only**
Facebook posts (no photo) fall back to the region crop, which can still catch the
dialog — accepted for now; revisit if needed.

## Out of scope
Instagram/Pinterest behavior; text-only-post dialog handling; any Settings UI.
