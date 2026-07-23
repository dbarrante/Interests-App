export const meta = {
  name: 'review-autoimport-parser-tuning',
  description: 'Adversarial multi-dimension review of the FB/IG saved-page parser live-tuning diff',
  phases: [
    { title: 'Review', detail: '4 reviewers: data-safety, security, correctness, coverage' },
    { title: 'Verify', detail: '2 skeptics per finding, majority-kill' },
  ],
}

const ROOT = 'D:/Dropbox/Documents/Claude/Projects/Interests App'

const COMMON = `
Repo: ${ROOT} (work there). The UNCOMMITTED working-tree diff is the review target — run: git diff
Context: the Interests App extension auto-imports saved posts from facebook.com/saved/ and
instagram.com/saved/all-posts/. The pure parsers extension/lib/saved-parse-fb.js and
extension/lib/saved-parse-ig.js (raw HTML string in, {url,title,image,platformKey}[] out) were just
live-tuned against real captured pages in ${ROOT}/_livecapture/ (fb-saved.html, ig-saved.html —
the user's PERSONAL data, local-only: never quote personal content in findings beyond a key/url stub).
Changes: (1) both parsers now group ALL anchors per bare post id and merge fragments (title/image
priority chains) instead of first-anchor-wins; (2) FB accepts /groups/<g>/permalink/<id>/ as the same
type as /groups/<g>/posts/<id>/; (3) IG accepts RELATIVE hrefs (/p/, /reel/) and absolutizes them to
https://www.instagram.com; (4) IG title prefers in-anchor <img alt> (real caption) over inner text
(junk "Clip" overlay); (5) FB demotes video-duration inner text ("00:52") to last-resort title.
Tests: node tests/run.js (full suite currently passes). Parser tests: tests/autoimport-fb-parse.test.js,
tests/autoimport-ig-parse.test.js. Downstream consumer: extension/background.js (scrapePlatform /
delivery), plus the app-side auto-import merge.
Report ONLY defects you can ground in code you actually read or commands you actually ran.
Your final output MUST be the structured findings object; an empty findings array is a valid result.`

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'severity', 'detail'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          detail: { type: 'string', description: 'What is wrong, concrete failure scenario (inputs/state -> wrong outcome), and evidence' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding is NOT a real defect' },
    reason: { type: 'string' },
  },
}

const REVIEWERS = [
  {
    key: 'data-safety',
    agentType: 'data-safety-reviewer',
    prompt: `${COMMON}
Dimension: DATA SAFETY of the parser changes feeding the auto-import pipeline.
Priority question: group posts that ALREADY imported under /groups/<g>/posts/<id>/ URLs may now be
delivered with /groups/<g>/permalink/<id>/ as the stored url (first-encountered anchor wins). Trace how
the auto-import pipeline (extension/background.js delivery + app-side merge/ledger, e.g. platform-import
ledger keyed on platformKey vs url-keyed dedup) decides "already imported" — could the changed URL shape
or the changed title/image resolution create DUPLICATE cards, overwrite user-edited cards, or delete/
downgrade existing rows on the next auto-import run? Also check: fail-soft contract still holds (login
wall / zero-parse never deletes anything), and the asOf-preserve reconcile invariant is untouched.`,
  },
  {
    key: 'security',
    agentType: 'electron-security-reviewer',
    prompt: `${COMMON}
Dimension: SECURITY of parsing fully attacker-influenced HTML (any page Facebook/Instagram serves,
including content authored by strangers: post captions, alt text, aria-labels).
Check: (1) ReDoS / catastrophic backtracking in the new/changed regexes on adversarial multi-MB inputs —
reason about the actual regexes; if suspicious, construct a worst-case input and time it with node;
(2) unbounded memory: anchors keep accumulating into already-capped groups (CAP=100 distinct keys but
per-key anchor arrays are unbounded — is that exploitable with 500k anchors to one key?);
(3) delivered titles/alt/urls are attacker-controlled strings — confirm downstream rendering escapes them
(esc()) and the 1MB body-cap + image-URL guards from the 2026-07-18 security review still apply to the
merged image field (relative-href absolutize can only produce https://www.instagram.com/... — verify).`,
  },
  {
    key: 'correctness',
    agentType: 'general-purpose',
    prompt: `${COMMON}
Dimension: CORRECTNESS of the merge logic itself. Read both parsers fully post-diff. Hunt for:
priority-chain bugs (e.g. an EMPTY string from anchor 1 vs a real value in anchor 2 at the same
priority tier; whitespace-only titles; aria/alt/text trim inconsistencies), first-encountered-url
semantics vs the regression tests, CAP edge behavior (group created at exactly CAP, anchors merged into
existing groups after CAP reached), blockFor/nearestImage fallback indices using firstIdx of the FIRST
anchor while fragments came from later anchors, and entity-decoding double/missing decode on url/title/
image. Verify empirically: run node tests/run.js AND replay both _livecapture files through the parsers
(node -e with require) to confirm 60 FB / 54 IG items with the reported title/image coverage.`,
  },
  {
    key: 'coverage',
    agentType: 'general-purpose',
    prompt: `${COMMON}
Dimension: TEST COVERAGE gaps for behaviors the live pages exhibit. Compare what the live captures
contain (structures, edge tiles) against what tests/autoimport-{fb,ig}-parse.test.js actually pin down.
Flag ONLY high-value gaps: a live-page behavior the parser now depends on that NO test would catch if
regressed (e.g. duration demotion order, permalink/posts merge, alt-over-Clip priority, absolutize,
per-key anchor merge across non-adjacent anchors, byline-only link-share cards). Do not propose
speculative tests for behaviors that cannot occur.`,
  },
]

phase('Review')
const results = await pipeline(
  REVIEWERS,
  r => agent(r.prompt, { label: `review:${r.key}`, phase: 'Review', schema: FINDINGS, agentType: r.agentType }),
  (review, r) => {
    if (!review || !review.findings || !review.findings.length) return []
    return parallel(review.findings.map(f => () =>
      parallel(['refute-by-code-reading', 'refute-by-reproduction'].map(lens => () =>
        agent(`${COMMON}
You are an adversarial verifier. A ${r.key} reviewer claims this defect in the working-tree diff:
TITLE: ${f.title}
FILE: ${f.file}${f.line ? ' line ~' + f.line : ''}
SEVERITY: ${f.severity}
DETAIL: ${f.detail}
Your job: try to REFUTE it via the "${lens}" lens (${lens === 'refute-by-reproduction'
  ? 'actually construct the failing input / run the code or tests to show the claimed failure does or does not happen'
  : 'read the actual code paths end-to-end and show why the claimed scenario is or is not reachable'}).
Default to refuted=true if the failure scenario is not concretely reachable.`,
          { label: `verify:${r.key}:${f.title.slice(0, 30)}`, phase: 'Verify', schema: VERDICT })
      )).then(vs => ({ ...f, dimension: r.key, votes: vs.filter(Boolean), survives: vs.filter(Boolean).filter(v => !v.refuted).length >= 2 }))
    ))
  }
)

const all = results.filter(Boolean).flat().filter(Boolean)
const confirmed = all.filter(f => f.survives)
const killed = all.filter(f => !f.survives)
log(`${all.length} raw findings, ${confirmed.length} survived adversarial verification`)
return {
  confirmed,
  killed: killed.map(k => ({ title: k.title, dimension: k.dimension, reasons: k.votes.map(v => v.reason.slice(0, 200)) })),
}