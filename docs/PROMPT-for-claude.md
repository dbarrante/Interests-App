# Copy/paste prompt for Claude

You are taking over development of the **Interests App**, an Electron + local Express +
`node:sqlite` desktop application with a Chrome extension.

**First, read this file in full. It is the current source of truth:**

`D:\Dropbox\Documents\Claude\Projects\Interests App\docs\HANDOFF-to-claude.md`

The older `docs/HANDOFF-to-codex.md` is historical and stops at v1.10.4. Do not use its “current
state” or “in-flight work” sections as current instructions.

Current baseline:

- Repo: `D:\Dropbox\Documents\Claude\Projects\Interests App`
- Branch: `master`
- Release: **v1.11.2**
- Latest product-code commit: `f1ff2b9` (the handoff itself may be a later docs-only commit)
- Installer:
  `C:\Users\dkbar\interests-dist\Interests-App-Setup-1.11.2.exe`
- Feed is gone; Stumble is the home discovery surface.
- Stumble uses grounded OpenRouter web search, strict one-fetch content validation, page
  `og:image`, and verified-live screenshot fallback.
- The Chrome extension remains v4.48 and is out of scope unless Dave explicitly asks.

Before writing code:

1. Read `.agents/skills/project-conventions/SKILL.md`.
2. Run `git status --short --branch`.
3. Preserve the untracked `.agents/`, `.codex/`, and `AGENTS.md` files.
4. Confirm Dave installed v1.11.2 by asking him to click **?**.
5. Confirm he rotated the OpenRouter key after it appeared in a local diagnostic transcript.
6. Never print, quote, log, or commit provider keys; do not dump `ia_settings` wholesale.
7. Run `npm test` and require the final line `ALL TEST FILES PASSED`.

Hard invariants:

- Preserve the `asOf` and `{confirm:true}` mass-delete guard.
- Preserve the `_booted` boot-race gate.
- Keep sync tombstones forever.
- Never rename the frozen imported-card `img` or saved-card `image` wire fields.
- Keep Core loopback-only and SSRF-guarded.
- Never commit personal data, backups, exports, or the live `data/` store.

Debug with evidence:

- Query the running Core on ports 3456–3465.
- Pull exact Stumble URLs from `ia_stdeal` / `ia_spool`.
- Probe exact failures through `/api/check-content`.
- Time the AI call separately from validation.
- Add a regression test for every proven root cause.
- Do not weaken strict validation to make more cards appear.

For user-facing releases: work on a branch, run the syntax gate and complete test suite, bump the
version, update `docs/BACKLOG.md`, fast-forward `master`, push, and run `npm run dist`. Remind Dave
to install the new `.exe` and verify the version with **?**.

Dave is not a professional developer. Explain plainly, recommend a path, and make safe progress
without requiring him to translate technical implementation details.

After reading the handoff, inspect the current repository and then summarize your understanding and
implementation plan before editing code.

**Dave’s next request:**

> Paste the next task here.
