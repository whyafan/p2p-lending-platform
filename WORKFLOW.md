# Claude Code Workflow Playbook

> Built 2026-07-03 from an audit of 763 prompts across 12 projects (GriDLocK, SamsungHack, ETHackathon, CreditWise, Portfolio…).
> `~/.claude/CLAUDE.md` holds only the always-loaded routing rules; this file is the full reference.
> Your profile: hackathon-sprint builder. Top themes: planning > building > writing > UI/design > research/scraping > deploys.

## 1. Route every task first (the one decision that matters)

| Situation | Do this |
|---|---|
| New serious project (multi-day / hackathon build) | `/gsd-new-project`, then per phase: `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase` |
| Feature work in a repo **without** `.planning/` | Superpowers loop — just describe the feature; brainstorming → writing-plans → TDD → verification auto-invoke |
| Small task in a GSD repo | `/gsd-quick` (keeps atomic commits + state); `/gsd-fast` for trivial |
| Tiny one-off fix anywhere | Just ask. Ponytail keeps the diff minimal. |
| Hard bug | Say "diagnose this" (diagnose skill); `/gsd-debug` inside GSD repos |
| Stress-test a plan or idea before building | `/grill-me` (relentless interview); `/grill-with-docs` to also produce ADRs + glossary |
| Pre-ship quality gate | `/code-review` (bugs) then `/simplify` (cleanup) |
| Session long / switching contexts | `/handoff` → `/clear` → paste the handoff in the fresh session |

## 2. GSD vs Superpowers — keep both, never mixed

- **GSD** is a project operating system: state lives on disk in `.planning/`, survives `/clear`, rate-limit resets, and multi-day gaps. Use it for anything that outlives one session. Its own agents (planner, executor, verifier) replace the superpowers loop inside phases.
- **Superpowers** is single-session engineering discipline: brainstorm → plan → TDD → verify. It's your default for feature-sized work in repos that aren't GSD projects.
- **The rule** (enforced by CLAUDE.md): repo has `.planning/` → GSD owns the workflow. No `.planning/` → superpowers owns it.
- **Ponytail** is orthogonal to both — it governs how minimal the *code* is, not the process. Leave it on.

## 3. Per-project setup — 5 minutes that produce the max-output gap

Your prompts are short (median ~50 chars). Short prompts only work when the context is pre-loaded. For every new project:

1. `git init` + first commit — enables checkpoints, `/rewind`, and `gsd-undo`.
2. `/init` → creates the project `CLAUDE.md`. Make sure it ends up containing: the run command, the test command, the stack, and any quirk you'd otherwise re-explain. Every future short prompt draws on this for free.
3. Serious build → `/gsd-new-project` (creates `.planning/`, roadmap, phases). Throwaway experiment → skip GSD entirely.
4. If permission prompts get annoying → `/fewer-permission-prompts` once.
5. Inherited or large codebase → `/graphify` once, then ask architecture questions against the graph instead of re-exploring each session.
6. Hackathons specifically: `/gsd-mvp-phase` plans a phase as a vertical demo-able slice — plan the demo path, not the feature list.

## 4. Skill routing table

| Need | Use |
|---|---|
| Build new UI / pick styles, palettes, fonts | ui-ux-pro-max (auto-fires on UI work) |
| Aesthetic direction, distinctive look | frontend-design |
| Audit existing UI / accessibility | web-design-guidelines |
| Charts / dashboards | dataviz |
| Web search & research | built-in WebSearch/WebFetch (firecrawl plugin disabled 2026-07) |
| Scrape / crawl a site | built-in WebFetch; re-enable firecrawl only for large crawls |
| Test or QA a running site headlessly | claude-in-chrome |
| Act in your real Chrome (logged-in pages) | claude-in-chrome |
| Library/API docs | context7 (automatic) |
| Understand a codebase | graphify |
| Office files | docx / pdf / pptx / xlsx |
| YouTube content | youtube-transcript |
| Make writing sound human | avoid-ai-writing |
| Review docs/prose style | writing-guidelines |
| Turn conversation into PRD / issues | /to-prd, /to-issues, /triage |
| Domain glossary + ADRs | /ubiquitous-language, domain-modeling |
| Find or write a skill | find-skills (skill-creator plugin disabled 2026-07; re-enable to author new skills) |

Slash-only utilities (hidden from auto-invoke, still yours): `/handoff`, `/teach`, `/prototype`, `/tailored-resume-generator`, `/developer-growth-analysis`, `/lead-research-assistant`, `/content-research-writer`, `/image-enhancer`, `/setup-pre-commit`, `/git-guardrails-claude-code`, `/migrate-to-shoehorn`, `/design-an-interface`, `/request-refactor-plan`, `/improve-codebase-architecture`, `/obsidian-vault`, `/qa`.

## 5. Context & rate-limit economy (Pro plan)

- `/clear` between unrelated tasks — you already do this; it's the single best habit.
- Mid-task at >60–70% context: `/handoff` + `/clear` + paste, **instead of** `/compact`. A handoff doc is smaller than a compaction summary and you control what survives.
- Long-running work (big refactors, renders, installs) → run as background tasks so the session stays cheap.
- `effortLevel: xhigh` is set globally — maximum quality per message. If you're burning through the rate limit, `/effort high` costs little quality.
- Broad codebase searches → let the Explore agent do the fan-out; it keeps file dumps out of your main context.

## 6. Skill management rules (how this setup stays clean)

1. **Before installing anything**: check the routing table above — does something already own that job? One owner per job.
2. **Prefer plugins over loose global skills** — plugins version-update themselves; global copies rot (the 7 stale `vercel-*` copies deleted in this audit were exactly that).
3. **New utility that you'd only ever invoke yourself** → add `disable-model-invocation: true` to its frontmatter. It stays slash-invocable at zero context cost.
4. **Never hand-edit `gsd-*` skills, hooks, or agents** — GSD manages them. Tune with `/gsd-surface` (clusters) and `/gsd-settings`.
5. **Quarterly**: re-run a config audit (this file + one prompt: "audit my global claude config against WORKFLOW.md").

## 7. Post-audit inventory (2026-07-03)

- **Plugins — enabled (9)**: superpowers, ponytail, ui-ux-pro-max, frontend-design, context7, code-review, claude-mem, impeccable. (brag removed.)
- **Plugins — installed but disabled (5, token-optimization pass 2026-07)**: code-simplifier, skill-creator, firecrawl, vercel, swift-lsp. Re-enable with `claude plugin enable <name>` when needed.
- **Global skills**: 77 dirs — GSD suite (self-managed), Matt Pocock engineering suite (now complete: grilling + domain-modeling installed), document suite, utilities. 17 marked slash-only.
- **Deleted**: 9 duplicate skills, 19-skill HyperFrames video suite (backup: `~/.claude/backups/video-suite-2026-07-03.tgz`).
- **Backups**: original CLAUDE.md at `~/.claude/backups/CLAUDE.md.pre-audit-2026-07-03`.
