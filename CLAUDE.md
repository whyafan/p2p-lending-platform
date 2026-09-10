# General Guidelines
- Never use the em dash "-". Use plain dash "-" instead
- When writing commit messages, NEVER auto-add your agent name as co-author
- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated
- When writing or substantially editing long Markdown files, put each full sentence on its own line. Preserve normal Markdown structure, but avoid wrapping multiple sentences onto one physical line.
- When making technical decisions, do not give much weight to development cost. Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would experience it as possible. This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
- If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness.
If you see one, even if it is not caused by what you are working on right now, still get it fixed.

# Git policy
I handle git and GitHub myself. Never run `git add`, `git commit`, `git push`, or create PRs unless I explicitly ask for it — announce what you intend first, then act only on my confirmation. Never add Claude attribution, co-author trailers, or session links to commits or PRs; all contributions must appear as mine alone.

# Workflow precedence
- Repo has `.planning/` → GSD owns the workflow (discuss → plan → execute). Don't mix superpowers process skills into GSD phases.
- No `.planning/` → superpowers loop (brainstorming → writing-plans → TDD → verification) drives feature work.
- Ponytail governs code minimalism in both.

# Design skill routing
Build new UI → ui-ux-pro-max · aesthetic direction → frontend-design · audit existing UI → web-design-guidelines · charts → dataviz

# Browser tool routing
- **gstack** — headless QA, screenshots, dogfooding site flows (in projects set up for it)
- **claude-in-chrome** — actions in my real Chrome session (logged-in pages, live tabs)
- **WebSearch/WebFetch** — web search and fetching pages for content

# Context & response economy
- Grep/glob to locate first instead of reading whole dirs blind. But before editing a file (not just skimming it), read the whole thing if it's non-trivial or you haven't seen it yet in this conversation — a matched region without its surroundings is how edits miss a caller or an edge case. A PreToolUse hook asks before Reads over 500 lines; that's a nudge to reconsider, not a rule to route around when the file actually needs full context.
- Don't restate context already established in the conversation — cite where it was set instead of repeating it.
- Minimal prose for the routine parts: bullets over paragraphs, no recap/preamble, no "let me know if." This governs filler, not substance — risks, tradeoffs, assumptions, and deviations from what was asked always get stated in full, at whatever length they need.
- Plan at high/xhigh effort (`/effort` or `--effort`); medium/low is fine for executing mechanical, fully-specified steps. Jump back to high/xhigh mid-execution for non-trivial logic, security/money-handling code, or the moment reality diverges from the plan — don't stay low just because that's where the session started.

Full playbook: `~/.claude/WORKFLOW.md`
