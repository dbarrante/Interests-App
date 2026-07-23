# LOOP-11 Run Artifact — Browser Stumble adversarial review

- **run_id:** 2026-07-04-bstumble
- **date:** 2026-07-04
- **target:** Browser Stumble feature (v1.12.0 → v1.12.5), diff `b95dadf..eb42018`, product code only
- **branch:** master
- **git SHA:** eb42018
- **protocol:** FREE-MAD (3 independent hostile reviewers, reasoning tier), 1 round, read-only
- **mode:** standalone
- **tool deviation (Kernel §2):** no graphify/ast-grep MCP in this environment — reviewers used Read/Grep + reasoning; recorded in `unknown`.

## Verdict: **PASS** (after 1 REVISE round)

- **Round 1 (audit):** REVISE — 2 HIGH + 5 MED + 3 LOW, 0 CRITICAL; data-safe/boundary-secure but robustness gaps.
- **REVISE applied** on branch `loop/bstumble-revise-2026-07-04` (commits `e2db1c0`, `3c611f3`), each fix + regression test, full suite green (app 1.12.6 / ext 4.54).
- **Round 2 (re-attack):** **PASS** — all 7 targeted findings RESOLVED with cited evidence; the risky COR-3 concurrency concern explicitly cleared (single-thread + disjoint/union KV keys, no lost update); invariants upheld; 2 new LOW issues only (NEW-1 accepted UX trade-off, NEW-2 hardened). Final QOPC 0.88 ≥ 0.85 threshold.

Fixed: SEC-1 (overlay `isTrusted`), COR-1 (`bstumbleGo` re-entrancy guard), COR-2 (redirect-safe category via `matchKey`), COR-3 (feedback drains independent of the AI fetch), DAT-1/SEC-2 (coerce+cap vote fields), COR-6 (empty-active prompt fallback), COR-7 (restorable base categories). Deferred (documented): COR-4, COR-5, SEC-3, SEC-4, COR-8/DAT-2.

_Original round-1 verdict (kept for the record): REVISE — 2 HIGH unresolved, aggregate QOPC 0.70._

## QOPC (final, aggregated)

```yaml
qopc:
  confidence: 0.70          # ship-quality of the feature as-is
  risk: medium
  evidence: [security-review, correctness-review, data-safety-review — all cited file:line]
  per_lens: {data_safety: 0.93, security: 0.72, correctness: 0.55}
  unknown:
    - extension runtime behavior is only grep-asserted, never executed (context-menu creation, overlay injection timing, vote flow, storage.onChanged, tab reuse)
    - real chrome.tabs.update navigation-commit timing vs the 1.5s overlay fallback on slow pages
    - real-world redirect frequency among AI-suggested stumble URLs (COR-2 impact size)
    - synthetic-click reachability on the injected overlay (SEC-1, expected per MV3 isolated-world semantics, not executed)
  missing_evidence:
    - runtime trace of two overlapping bstumbleGo calls (COR-1)
    - observed feedback POST rate during a live 30s callAI fetch (COR-3)
    - a live test dispatching a synthetic click on #ia-bstumble-bar buttons (SEC-1)
```

## Findings (10 total: 2 HIGH, 5 MEDIUM, 3 LOW — 0 CRITICAL)

| id | sev | domain | file:line | description | status |
|---|---|---|---|---|---|
| COR-1 | HIGH | correctness | extension/background.js:127-143 | `bstumbleGo` read-modify-writes the session buffer with awaits and no in-flight guard → rapid icon clicks / concurrent `bstumbleNext` serve the same page twice | open |
| COR-2 | HIGH | correctness | extension/background.js:143-151 | Vote attributed to the current (post-advance / post-redirect) tab URL; when the stumbled URL redirects, `c.url===url` fails and **category is silently dropped** (learning degraded) | open |
| COR-3 | MED | correctness | web/index.html:4459-4485 | Feedback draining shares `_bstumbleBusy` with the 10-40s AI fetch → votes not drained during a fetch; extension keeps POSTing, 50-item feedback cap can drop oldest votes under load | open |
| COR-4 | MED | correctness | extension/background.js:104-127 | Overlay injection race on the reused tab: 1.5s fallback can inject into the pre-navigation (old) page; a stale `complete` can consume the one-shot listener → wrong-target or bar-less page | open |
| COR-5 | MED | correctness | web/index.html:4482-4484 | Request read (GET, no clear) then clear (POST null) is non-atomic; a new extension request in the gap is overwritten by `{request:null}` → occasional dropped refill → dry buffer | open |
| SEC-1 | MED | security | extension/overlay.js:27-41; background.js:1188-1196 | Injected overlay buttons have no `event.isTrusted` guard and `onMessage` does no sender check → a hostile stumbled page can forge clicks to auto-Save itself / spam votes | open |
| SEC-2 | MED | security | web/index.html:1286-1312, 4466-4471 | Attacker page `<title>`/category flows verbatim into `buildPrompt` (prompt injection). Bounded (≤60 entries, same class as existing saved-title exposure) | open |
| DAT-1 | LOW | data-safety | web/index.html:4468 | Vote `category`/`title` not type-coerced; a malformed vote lands non-string junk in `likes`/`hidden` → cosmetic prompt noise only (no data loss) | open |
| COR-6 | LOW | correctness | web/index.html:3516-3530, 582 | Keep-at-least-one guard counts `CATS`, not weight>0 `active`; two categories both at weight 0 yields an empty category list in the prompt | open |
| COR-7 | LOW | correctness/UX | web/index.html:439, 3524, 429 | `S.hiddenBase` is write-only — no UI to un-hide a removed base category, so the "reversible in settings" claim is unmet | open |
| SEC-3 / SEC-4 / COR-8 / DAT-2 | LOW | sec/robustness | background.js:648; server.js:399-411; :402 | removeActive fallback can remove the wrong (last-opened) card; a co-installed malicious extension could POST results; >20-item results eviction — all accepted-model / high-bar | noted |

## Recommended fixes (prioritized — for the operator to approve; LOOP-11 applied none)

1. **SEC-1** — gate every overlay button handler on `if(!e.isTrusted) return;` (and ideally render the bar in a closed shadow DOM). Cheap; closes the forgery path and shrinks SEC-2. *(top value/effort)*
2. **COR-1** — add a module-level `_bstumbleGoBusy` guard around `bstumbleGo` (mirror the renderer's `_bstumbleBusy`).
3. **COR-3** — drain `/api/bstumble/feedback` every tick, outside the AI-fetch busy section, so votes aren't lost during a long fetch.
4. **COR-2 + DAT-1** — carry category from the stashed current item via a normalized/`matchKey` URL match (tolerate redirects), and `String(...)`-coerce `category`/`title` in the renderer reducer.
5. **COR-7** — either add an un-hide affordance for base categories or drop the "reversible" wording in the hint/comment.
6. **COR-4 / COR-5 / COR-6 / SEC-3** — defense-in-depth: filter overlay inject by tab+URL, compare-and-clear the request nonce, guard on active-category count, and restrict the removeActive fallback to the action-icon context.

## Recommended regression tests (add with each fix — Kernel §13)
- COR-1: source/logic test asserting a `_bstumbleGoBusy` guard exists and re-entrancy is blocked.
- COR-3: assert feedback drain is not gated by the AI-fetch busy flag.
- COR-2/DAT-1: assert the vote path uses a normalized URL match and string-coerces category/title.
- SEC-1: assert overlay handlers check `isTrusted`.
- COR-6: assert the keep-one guard considers active (weight>0) categories.

## Diffs applied
None. LOOP-11 is read-only; it produced this verdict + critique only.

## Governance row (copy in governance-ledger.md)
`2026-07-04 | LOOP-11 | success_rate=1(artifact) | retry=0 | debate_rounds=1 | reviewers=3(sec,cor,dat) | findings=10(0C/2H/5M/3L) | verdict=REVISE | tokens≈240k opus | hallucinations_caught=0 | rollbacks=0`

## Recommended next loops
- Operator applies the prioritized fixes (branch `loop/bstumble-revise-2026-07-04`), each with a regression test, then re-run LOOP-11 to confirm PASS.
- Consider a lightweight runtime/e2e harness for the extension (the biggest `unknown` — all extension tests are grep-based).
