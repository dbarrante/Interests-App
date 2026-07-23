# LOOP-06 Run Artifact — UX/UI Visual, Stateful, Degradation, Memory-Transparency

- **run_id:** 2026-07-04 (LOOP-06)
- **target:** Interests App web UI (`web/index.html`), audited on a throwaway Core instance (:3990, temp data — live library untouched)
- **branch:** loop/LOOP-06-2026-07-04
- **harness:** Python Playwright (Chromium headless) — preview MCP was blocked by the live app on :3456, so a direct Playwright harness was used instead. Deterministic-render note: seeded disposable content; animations not frozen (single-shot capture, no baseline diffing this run → BASELINE-ESTABLISHED).
- **matrix:** 4 views (stumble/saved/imported/settings) × 3 viewports (375/768/1440) × 2 themes (light/dark) = 24 screenshots + memory panel = 25. `shots/` + `findings.json` alongside this file.

## Verdict: **PASS** (after node-7 fixes)

- **Audit:** REVISE — 2 MEDIUM + 2 LOW, 0 CRITICAL/HIGH.
- **Fixes applied** on `loop/LOOP-06-2026-07-04` (commit `dd371e6`, app 1.12.7), each with a regression assert (`tests/ux-loop06.test.js`, 11) + full suite green.
- **Re-verify (Playwright, cache-disabled):**
  - UX-1 — dark primary button **3.06 → 5.8:1**; **zero** contrast failures in either theme.
  - UX-2 — memory panel renders 4 removable items; **delete propagates to storage** (4→3, survives reload — not cosmetic).
  - UX-4 — boot-error banner **present** on API-down (no silent empty screen; still no white-screen/crash).
  - UX-3 — 375px horizontal overflow **622 → 381px** (header/stumble/settings fit exactly; ~6px residual on Saved/Imported grids **accepted** — desktop app).

_Original audit verdict (kept for the record): REVISE — 2 MEDIUM + 2 LOW._

## QOPC
```yaml
qopc:
  confidence: 0.82
  risk: low-medium
  evidence: [playwright screenshots x25, findings.json (overflow+contrast+state+degradation+memory), dark stumble render]
  unknown:
    - animations not frozen; visual sweep is capture-only (no baseline diff this run — first run establishes baselines)
    - hover/active/disabled states not force-screenshotted per element (focus + contrast sampled; full state matrix is the remaining depth)
    - contrast sampled on representative elements per theme, not every control
  missing_evidence:
    - per-element hover/active state screenshots; a real baseline set for future diffing
```

## Findings (2 MEDIUM, 2 LOW — 0 CRITICAL/HIGH)

| id | sev | node | evidence | description |
|---|---|---|---|---|
| UX-1 | MEDIUM | 3 (contrast/theme parity) | findings.json contrast; `shots/stumble_desktop_dark.png` | **Primary action buttons fail WCAG AA text contrast.** `.btn.btn-primary` (Stumble / Open / Save — the app's most-used controls) measured **3.06:1** in dark theme (white 14px/700 label on the orange/teal fill); 4.5:1 is required for 14px text. Light theme is borderline (a primary sampled 5.18, but the orange fill is ~3.3 regardless). This is the classic theme-parity contrast miss. |
| UX-2 | MEDIUM | 5 (memory transparency) | findings.json memory; `shots/settings_memory_full.png` | **No granular memory-transparency surface.** Profile (About / Interests / category weights) is fully view/edit/delete, and "Reset learning history" clears everything — but there is **no panel to view or individually edit/delete the specific things the app learned** from your 👍/👎/clicks (`individualMemoryList:false`). Per LOOP-06 Node 5, clear-all without per-item view/edit/delete = MEDIUM (transparent-ish, not the HIGH "panel absent"). The data already exists as `likes`/`hidden`/`clicks` arrays. |
| UX-3 | LOW | 2 (responsive) | findings.json overflow; `shots/*_mobile_*.png` | **Horizontal overflow at 375px** on every view, both themes (content min-width ≈ 622px, no mobile breakpoint). **Context: this is a desktop Electron app** — the window is desktop-sized and the planned iPhone client is a separate native app — so real-world impact is low. Tablet (768) and desktop (1440) are clean (no overflow). Kept LOW for that reason; would rise if the web UI is ever exposed on small screens. |
| UX-4 | LOW | 4 (degradation) | findings.json degradation.api_down_reload + pageerrors | **Silent data-load failure — no user-facing message.** With the Core API unreachable, the app shell + nav render (no white-screen ✅, no crash ✅) but content is empty with no "couldn't reach the app service" message, and two unhandled `Failed to fetch` boot rejections fire. Graceful enough, but not the "coherent error message" LOOP-06 Node 4 wants. |

## Passed / positives (cited)
- **Degradation (Node 4):** no crashes, no white-screen, no form-wipe. No-key Stumble shows a coherent message ("Add your … API key in Settings first") and routes to Settings. API-down reload keeps the nav/shell.
- **Contrast (Node 3):** light theme all pass (min 4.92); dark passes for `.hint`/`.sub`/`.tab`/labels/headings (5.2–6.6). Only the primary-button fill fails.
- **Focus (Node 3):** primary button shows a focus outline in both themes (not suppressed).
- **Visual (Node 2):** no occlusion / collapsed grids / unstyled flashes observed; tablet + desktop have zero horizontal overflow in both themes.
- **Memory (Node 5):** profile fully editable; clear-all learning history present; full backups include "likes … learning history."

## Recommended fixes (severity-ordered — for operator approval; LOOP-06 mutates on the loop branch, merge needs approval)
1. **UX-1** — raise primary-button label contrast to ≥4.5:1: darken the orange/teal fill (or bump the label to ≥18.66px / add a subtle text shadow). Re-screenshot both themes. *(highest value — affects every primary action)*
2. **UX-2** — add a "What I've learned about you" section in Settings listing recent likes / dismissals / clicks (already in memory as `likes`/`hidden`/`clicks`) with a per-item ✕ remove, next to the existing "Reset learning history."
3. **UX-4** — wrap boot data-load in a catch that shows a dismissible "Couldn't reach the app service — retrying…" banner instead of a silent empty state.
4. **UX-3** — (optional, low priority for a desktop app) add a `@media (max-width:640px)` breakpoint so the header/pills/toolbars wrap; only worth it if the web UI will be used on phones.

## Regression specs to add with each fix (Kernel §13)
- UX-1: assert computed contrast of `.btn.btn-primary` ≥ 4.5 in both themes (Playwright spec, or a source assertion on the fill color).
- UX-2: assert a memory-list element with per-item remove exists in Settings.
- UX-4: assert a boot-error banner appears when `/api/cards` fails.

## Governance row
`2026-07-04 | LOOP-06 | verdict=REVISE | findings=4 (0C/0H/2M/2L) | debate_rounds=0 (adversarial pending) | harness=playwright/25-shots | branch=loop/LOOP-06-2026-07-04 | no fixes applied yet | awaiting operator approval`

## Recommended next loops
- Apply fixes on the loop branch + adversarial re-check (LOOP-11 inline), then re-run this battery to confirm PASS.
- LOOP-05 (data/erasure) to confirm "Reset learning history" and any per-item delete actually erase server-side.
