# Skills & Plugins Reference Guide

A complete reference for all installed skills — organized by category with guidance on **how**, **when**, and **where** each skill helps.

---

## Table of Contents

1. [Superpowers Workflow Skills](#1-superpowers-workflow-skills)
2. [Configuration & Setup](#2-configuration--setup)
3. [Code Quality & Architecture](#3-code-quality--architecture)
4. [Frontend & UI/UX Design](#4-frontend--uiux-design)
5. [GSAP Animation](#5-gsap-animation)
6. [System & Distributed Design](#6-system--distributed-design)
7. [Product Strategy & Discovery](#7-product-strategy--discovery)
8. [Marketing & Growth](#8-marketing--growth)
9. [Sales & Business Operations](#9-sales--business-operations)
10. [Content & Writing Tools](#10-content--writing-tools)
11. [Code Review & Security](#11-code-review--security)
12. [Claude API & AI Development](#12-claude-api--ai-development)
13. [Scheduling & Automation](#13-scheduling--automation)
14. [Knowledge Graph](#14-knowledge-graph)

---

## 1. Superpowers Workflow Skills

These skills govern **how Claude Code approaches work**. They are process-level skills that shape every other task.

---

### `superpowers:using-superpowers`
**How:** Loaded automatically at session start; establishes the rule that all relevant skills must be invoked before any response.
**When:** Every conversation — this is the meta-skill that ensures all other skills are used correctly.
**Helps with:** Enforcing skill discipline; preventing Claude from skipping workflows; ensuring consistency across sessions.

---

### `superpowers:brainstorming`
**How:** Invoke before any creative, architectural, or strategic work. Guides structured ideation before committing to a direction.
**When:** Before designing a new feature, writing a plan, making a significant technical decision, or any open-ended problem.
**Helps with:** Avoiding premature solutions; exploring the solution space; surfacing trade-offs early.

> Note: `superpowers:brainstorm` is deprecated — use `superpowers:brainstorming`.

---

### `superpowers:writing-plans`
**How:** Use when you have a spec or requirements and need to produce a structured implementation plan.
**When:** Before starting any non-trivial feature or refactor; when you need to align with the user before coding.
**Helps with:** Breaking down complex tasks; writing clear, ordered plans in `tasks/todo.md`; preventing scope creep.

> Note: `superpowers:write-plan` is deprecated — use `superpowers:writing-plans`.

---

### `superpowers:executing-plans`
**How:** Use when you have a written plan and are ready to implement it step by step.
**When:** After a plan is confirmed; when executing multi-step tasks with clear subtasks.
**Helps with:** Staying on track; marking tasks complete as you go; keeping the main context window clean.

> Note: `superpowers:execute-plan` is deprecated — use `superpowers:executing-plans`.

---

### `superpowers:dispatching-parallel-agents`
**How:** Use to split 2+ independent tasks across multiple subagents running simultaneously.
**When:** When facing parallel workstreams that don't depend on each other (e.g., writing tests + updating docs + refactoring a module simultaneously).
**Helps with:** Dramatically reducing wall-clock time; keeping the main context clean; handling large tasks efficiently.

---

### `superpowers:subagent-driven-development`
**How:** Delegates implementation steps to subagents, each owning one task.
**When:** Executing large implementation plans where individual steps can be isolated.
**Helps with:** Clean context management; parallelism; preventing a single long conversation from losing track.

---

### `superpowers:test-driven-development`
**How:** Enforces the Red-Green-Refactor TDD cycle — write failing tests first, then implementation.
**When:** Implementing any feature or bugfix where correctness must be verified.
**Helps with:** Catching regressions; ensuring coverage; forcing clear interface design before implementation.

---

### `superpowers:using-git-worktrees`
**How:** Creates an isolated git worktree for feature work so the main branch stays clean.
**When:** Starting feature work that needs isolation from main; when running parallel branches.
**Helps with:** Safe experimentation; avoiding branch conflicts; clean rollback if the feature fails.

---

### `superpowers:verification-before-completion`
**How:** Runs a structured checklist before marking any task complete.
**When:** Before telling the user a task is done; before closing a PR.
**Helps with:** Catching missed requirements; preventing false "done" claims; ensuring quality gates pass.

---

### `superpowers:requesting-code-review`
**How:** Prepares code for review by summarizing changes, trade-offs, and test coverage.
**When:** After completing a significant feature or fix.
**Helps with:** Getting high-quality review feedback; communicating intent clearly; reducing review cycles.

---

### `superpowers:receiving-code-review`
**How:** Guides how to process and respond to review feedback constructively.
**When:** When review comments arrive; before pushing back on or accepting suggestions.
**Helps with:** Prioritizing feedback; distinguishing blocking vs. nitpick issues; keeping PRs moving.

---

### `superpowers:finishing-a-development-branch`
**How:** Runs end-of-branch cleanup: tests pass, docs updated, branch rebased, PR ready.
**When:** When implementation is complete and you're ready to merge.
**Helps with:** Preventing messy merges; ensuring all CI checks pass; producing a clean commit history.

---

### `superpowers:writing-skills`
**How:** Guides creation and editing of new skill files with correct frontmatter and structure.
**When:** When the user wants to add a new skill or update an existing one.
**Helps with:** Consistent skill format; correct trigger conditions; skills that actually load and execute properly.

---

## 2. Configuration & Setup

---

### `update-config`
**How:** Modifies `settings.json` / `settings.local.json` to configure hooks, permissions, and env vars.
**When:** User says "from now on when X", "allow Y command", "set Z=value", "whenever Claude stops do X".
**Helps with:** Automating repetitive permissions; setting up pre/post hooks; configuring environment variables; reducing manual approval prompts.

---

### `keybindings-help`
**How:** Edits `~/.claude/keybindings.json` to remap or add keyboard shortcuts.
**When:** User wants to rebind a key, add a chord shortcut, or change the submit key.
**Helps with:** Personalizing the Claude Code interface; improving workflow speed; resolving key conflicts.

---

### `fewer-permission-prompts`
**How:** Scans transcripts for frequently used read-only Bash/MCP calls and adds them to an allowlist.
**When:** After a few sessions where you notice repetitive permission prompts.
**Helps with:** Smoother sessions; less interruption for safe, repeated operations; faster execution.

---

### `init`
**How:** Analyzes the codebase and generates a `CLAUDE.md` file with project-specific instructions.
**When:** Starting a new project or onboarding Claude Code into an existing repo without a `CLAUDE.md`.
**Helps with:** Giving Claude context about conventions, test commands, architecture, and team rules from the start.

---

## 3. Code Quality & Architecture

---

### `simplify`
**How:** Reviews changed code for reuse opportunities, quality issues, and efficiency, then fixes them.
**When:** After completing a feature or fix; before opening a PR; when code feels bloated.
**Helps with:** Removing duplication; improving readability; catching over-engineering after the fact.

---

### `clean-code`
**How:** Applies Clean Code principles: meaningful names, small functions, no side effects, clear intent.
**When:** Writing new code; reviewing existing code for maintainability; onboarding on a messy codebase.
**Helps with:** Long-term maintainability; reducing cognitive load; making code self-documenting.

---

### `clean-architecture`
**How:** Structures software around the Dependency Rule — entities, use cases, interfaces, frameworks.
**When:** Designing a new service or application; refactoring a monolith; separating business logic from infrastructure.
**Helps with:** Testability; framework independence; keeping domain logic pure and portable.

---

### `refactoring-patterns`
**How:** Applies named refactoring transformations (Extract Method, Replace Conditional with Polymorphism, etc.).
**When:** Code smells are present; before adding a feature to messy code; improving existing code without changing behavior.
**Helps with:** Systematic improvement; communicating changes clearly; reducing risk during refactors.

---

### `domain-driven-design`
**How:** Models software around the business domain using bounded contexts, aggregates, entities, and value objects.
**When:** Building complex business software; when the codebase needs to reflect the business language.
**Helps with:** Aligning code with business rules; reducing translation overhead; managing complexity in large systems.

---

### `pragmatic-programmer`
**How:** Applies meta-principles: DRY, orthogonality, tracer bullets, broken windows, stone soup.
**When:** Making architectural decisions; reviewing code for hidden coupling; choosing between approaches.
**Helps with:** Long-term code health; pragmatic trade-offs; avoiding over-engineering and under-engineering.

---

### `software-design-philosophy`
**How:** Manages complexity through deep modules, information hiding, and designing for tomorrow's changes.
**When:** Designing APIs and interfaces; deciding module boundaries; evaluating abstraction depth.
**Helps with:** Reducing cognitive complexity; building interfaces that hide messy internals; making systems easier to extend.

---

### `release-it`
**How:** Applies stability patterns: circuit breakers, bulkheads, timeouts, health checks, graceful degradation.
**When:** Building production services; designing integrations with external systems; preparing for failure modes.
**Helps with:** System resilience; preventing cascading failures; production readiness.

---

## 4. Frontend & UI/UX Design

---

### `frontend-design`
**How:** Creates production-grade frontend UI with strong visual hierarchy, component structure, and design tokens.
**When:** Building new UI components; redesigning a page; implementing a design spec.
**Helps with:** Consistent, polished interfaces; accessible and responsive layouts; production-quality code.

---

### `refactoring-ui`
**How:** Audits and fixes visual hierarchy, spacing, color, typography, and layout issues.
**When:** UI looks "off" or amateurish; after an MVP to improve polish; design critique sessions.
**Helps with:** Making interfaces look professional; fixing common visual mistakes; systematic UI improvement.

---

### `top-design`
**How:** Creates award-winning, immersive web experiences with advanced visual techniques.
**When:** Building a flagship product page, portfolio, or brand experience where design excellence is the goal.
**Helps with:** Standout visual design; creative layouts; pushing beyond standard UI patterns.

---

### `ios-hig-design`
**How:** Applies Apple Human Interface Guidelines for native iOS interface design.
**When:** Building iOS apps or designing mobile experiences that match Apple's standards.
**Helps with:** Platform-native feel; App Store approval alignment; accessibility on iOS.

---

### `ui-ux-pro-max`
**How:** Comprehensive UI/UX intelligence for both web and mobile design decisions.
**When:** Any design decision needing expert-level UX judgment; product design reviews.
**Helps with:** Usability; visual design; interaction patterns; cross-platform consistency.

---

### `ux-heuristics`
**How:** Evaluates interfaces against Nielsen's 10 usability heuristics and recommends fixes.
**When:** UX audits; before user testing; when users report confusion or frustration.
**Helps with:** Systematic usability improvement; identifying hidden friction; justifying design decisions with evidence.

---

### `microinteractions`
**How:** Designs triggers, rules, feedback, and loops for small interactive moments.
**When:** Adding hover states, loading indicators, form validation feedback, or transition animations.
**Helps with:** Delightful details; communicating system state; making interfaces feel alive and responsive.

---

### `design-everyday-things`
**How:** Applies affordances, signifiers, mappings, and feedback principles to interface design.
**When:** Users can't figure out how to use a feature; designing controls or navigation.
**Helps with:** Intuitive interfaces; reducing errors; making the right action obvious.

---

### `web-typography`
**How:** Selects, pairs, and implements typefaces with correct scale, spacing, and rendering.
**When:** Choosing fonts; setting up a type system; fixing readability issues.
**Helps with:** Readability; brand consistency; professional visual rhythm.

---

### `canvas-design`
**How:** Creates visual art in `.png` and `.pdf` formats using canvas/drawing APIs.
**When:** Generating diagrams, visual assets, or illustrations programmatically.
**Helps with:** Automated asset creation; data visualization; custom graphics without external tools.

---

### `high-perf-browser`
**How:** Optimizes web performance through network protocols, rendering pipeline, and resource loading.
**When:** Pages are slow; Core Web Vitals are poor; optimizing for mobile or low-bandwidth users.
**Helps with:** Faster load times; better Lighthouse scores; reduced layout shifts and render blocking.

---

## 5. GSAP Animation

All GSAP skills require the GSAP library. Use the specific sub-skill matching your use case.

---

### `gsap-core`
**How:** Uses the core `gsap.to()`, `gsap.from()`, `gsap.set()` API for basic animations.
**When:** Adding entrance/exit animations; animating CSS properties; basic tweens.
**Helps with:** Smooth, performant animations; cross-browser consistency; GSAP's easing library.

---

### `gsap-timeline`
**How:** Orchestrates sequences of animations using `gsap.timeline()`.
**When:** Coordinating multiple animations in sequence or with overlaps; building animation choreography.
**Helps with:** Precise timing control; pause/resume/reverse of animation sequences; complex multi-step animations.

---

### `gsap-scrolltrigger`
**How:** Ties animations to scroll position using the ScrollTrigger plugin.
**When:** Scroll-driven animations; parallax effects; pinning sections; revealing content on scroll.
**Helps with:** Immersive scroll experiences; performance-optimized scroll animations; scrub effects.

---

### `gsap-plugins`
**How:** Registers and uses GSAP plugins (MorphSVG, DrawSVG, SplitText, etc.).
**When:** Need effects beyond the core library: SVG morphing, text splitting, path drawing.
**Helps with:** Advanced visual effects; SVG animation; text animation.

---

### `gsap-react`
**How:** Uses the `useGSAP` hook for React-compatible animations with proper cleanup.
**When:** Building animations inside React components; avoiding memory leaks from GSAP in React.
**Helps with:** React + GSAP integration; cleanup on unmount; ref-based animation targets.

---

### `gsap-frameworks`
**How:** Integrates GSAP with Vue, Svelte, and other frameworks correctly.
**When:** Using GSAP outside React in a component-based framework.
**Helps with:** Framework lifecycle alignment; proper cleanup; SSR compatibility.

---

### `gsap-performance`
**How:** Applies GSAP performance best practices: will-change, GPU layers, avoiding layout thrash.
**When:** Animations are janky; targeting 60fps on mobile; optimizing complex animation scenes.
**Helps with:** Smooth animations on low-end devices; reducing paint/layout cost; profiling animation bottlenecks.

---

### `gsap-utils`
**How:** Uses `gsap.utils` helpers: `clamp`, `mapRange`, `interpolate`, `snap`, `shuffle`, etc.
**When:** Need math/utility operations in animation logic; mapping values between ranges.
**Helps with:** Clean animation math; avoiding manual clamp/lerp implementations; readable utility code.

---

## 6. System & Distributed Design

---

### `system-design`
**How:** Designs scalable distributed systems using structured trade-off analysis and standard patterns.
**When:** Designing new backend services; scaling an existing system; technical interviews or architecture reviews.
**Helps with:** Load balancing, caching, database sharding, message queues, consistency models, capacity planning.

---

### `ddia-systems`
**How:** Applies principles from *Designing Data-Intensive Applications* to storage, processing, and retrieval.
**When:** Choosing databases; designing data pipelines; reasoning about consistency and replication.
**Helps with:** Database selection; event sourcing; stream processing; distributed consensus trade-offs.

---

## 7. Product Strategy & Discovery

---

### `brainstorming` / `superpowers:brainstorming`
**How:** Structured ideation before creative or architectural work — explores the solution space before committing.
**When:** Before any new feature, product decision, or open-ended problem.
**Helps with:** Divergent thinking; surfacing non-obvious options; avoiding tunnel vision on the first idea.

---

### `jobs-to-be-done`
**How:** Reframes product decisions around what customers are trying to accomplish, not features.
**When:** Defining product requirements; evaluating feature requests; conducting user research.
**Helps with:** Building what users actually need; avoiding feature-itis; stronger product positioning.

---

### `continuous-discovery`
**How:** Builds a weekly cadence of customer touchpoints to inform product decisions continuously.
**When:** Setting up a product discovery process; avoiding big-bang user research.
**Helps with:** Reducing assumption risk; keeping the team aligned with real user needs; iterative product evolution.

---

### `design-sprint`
**How:** Runs a structured 5-day process to prototype and test ideas before building.
**When:** Validating a new product concept; de-risking a major feature; aligning a cross-functional team fast.
**Helps with:** Fast validation; team alignment; reducing wasted development effort.

---

### `inspired-product`
**How:** Applies principles from *Inspired* for building empowered product teams using discovery + delivery.
**When:** Structuring a product team; defining the product manager role; improving team output.
**Helps with:** Product team effectiveness; outcome-oriented roadmaps; discovery vs. delivery balance.

---

### `lean-startup`
**How:** Designs MVPs and validated learning experiments using Build-Measure-Learn loops.
**When:** Starting a new product or feature; testing a hypothesis; deciding what to build next.
**Helps with:** Reducing waste; validating assumptions cheaply; pivoting with evidence.

---

### `lean-ux`
**How:** Applies hypothesis-driven design: assumptions → experiments → validated learning.
**When:** UX design phase; cross-functional collaboration; designing features under uncertainty.
**Helps with:** Faster design cycles; evidence-based design decisions; reducing handoff waste.

---

### `blue-ocean-strategy`
**How:** Creates uncontested market space by eliminating, reducing, raising, and creating factors (ERRC grid).
**When:** Strategic planning; differentiating a product from competitors; entering a new market.
**Helps with:** Finding white space; escaping commodity competition; building lasting differentiation.

---

### `crossing-the-chasm`
**How:** Navigates the technology adoption lifecycle from early adopters to mainstream market.
**When:** Product has early traction but struggles to grow; targeting the mainstream market.
**Helps with:** Go-to-market strategy; market segmentation; messaging for different adopter groups.

---

### `drive-motivation`
**How:** Designs motivation systems using Autonomy, Mastery, and Purpose (Daniel Pink's framework).
**When:** Building engagement features; designing team incentives; improving user retention.
**Helps with:** Intrinsic motivation; reducing churn; building products people want to use.

---

### `hooked-ux`
**How:** Designs habit-forming product loops using the Hook Model: Trigger → Action → Reward → Investment.
**When:** Building products that need repeated engagement; designing notification systems; onboarding flows.
**Helps with:** User habit formation; retention; engagement loops.

---

### `improve-retention`
**How:** Diagnoses and fixes retention problems using behavioral frameworks and data.
**When:** Retention metrics are declining; users sign up but don't return; onboarding needs improvement.
**Helps with:** Identifying drop-off points; designing re-engagement flows; improving activation.

---

## 8. Marketing & Growth

---

### `one-page-marketing`
**How:** Builds a complete marketing plan on one page covering audience, message, and channel.
**When:** Starting marketing for a new product; aligning the team on strategy; investor/stakeholder presentations.
**Helps with:** Marketing clarity; resource prioritization; consistent messaging across channels.

---

### `storybrand-messaging`
**How:** Clarifies brand messaging using the StoryBrand narrative framework — customer as hero, brand as guide.
**When:** Writing website copy; building a pitch deck; defining brand voice.
**Helps with:** Clear, compelling messaging; reducing confusion about what you do; conversion-focused copy.

---

### `obviously-awesome`
**How:** Defines product positioning using competitive alternatives and unique attributes.
**When:** Launching a product; repositioning after feedback; writing the homepage headline.
**Helps with:** Sharp positioning; differentiated messaging; sales and marketing alignment.

---

### `contagious`
**How:** Engineers word-of-mouth and virality using STEPPS (Social Currency, Triggers, Emotion, Public, Practical Value, Stories).
**When:** Designing referral programs; creating shareable content; building viral loops.
**Helps with:** Organic growth; content virality; social sharing mechanics.

---

### `made-to-stick`
**How:** Crafts messages that are understood, remembered, and acted upon using SUCCES (Simple, Unexpected, Concrete, Credible, Emotional, Stories).
**When:** Writing marketing copy; internal communication; product announcements.
**Helps with:** Memorable messaging; cutting through noise; driving action.

---

### `cro-methodology`
**How:** Audits websites and landing pages for conversion rate optimization opportunities.
**When:** Landing pages underperform; A/B testing; funnel analysis.
**Helps with:** Higher conversion rates; identifying friction in the purchase flow; prioritizing CRO experiments.

---

### `hundred-million-offers`
**How:** Creates irresistible offers using the Value Equation (Dream Outcome × Likelihood / Time × Effort).
**When:** Pricing a product; writing a sales page; structuring a service offer.
**Helps with:** Higher perceived value; reducing sales friction; building compelling offers.

---

### `scorecard-marketing`
**How:** Builds quiz and assessment funnels that generate leads and segment audiences.
**When:** Building lead generation; personalizing onboarding; creating interactive content.
**Helps with:** Qualified lead capture; audience segmentation; engagement-driven funnels.

---

### `predictable-revenue`
**How:** Builds a scalable outbound B2B sales process with specialized roles and cold email sequences.
**When:** Setting up a sales team; building outbound sequences; scaling B2B revenue.
**Helps with:** Predictable pipeline; cold outreach systems; SDR/AE role separation.

---

## 9. Sales & Business Operations

---

### `negotiation`
**How:** Prepares and executes negotiations using tactical empathy, anchoring, and calibrated questions.
**When:** Salary negotiation; vendor contracts; partnership deals; conflict resolution.
**Helps with:** Better outcomes; avoiding leaving value on the table; de-escalating tense negotiations.

---

### `traction-eos`
**How:** Implements the Entrepreneurial Operating System: Vision, People, Data, Issues, Process, Traction.
**When:** Scaling a team; setting up OKRs/rocks; running effective meetings; fixing execution problems.
**Helps with:** Organizational clarity; accountability systems; leadership alignment.

---

### `mom-test`
**How:** Structures customer conversations to extract honest feedback without leading the witness.
**When:** Customer discovery; validating ideas; user interviews.
**Helps with:** Getting truthful feedback; avoiding false validation; uncovering real pain points.

---

### `influence-psychology`
**How:** Applies Cialdini's six principles of ethical persuasion: Reciprocity, Commitment, Social Proof, Authority, Liking, Scarcity.
**When:** Writing persuasive copy; designing sales flows; building trust with users.
**Helps with:** Ethical influence; higher conversion; building credibility.

---

## 10. Content & Writing Tools

---

### `content-research-writer`
**How:** Assists in writing high-quality content by combining research and structured writing.
**When:** Writing blog posts, technical articles, documentation, or long-form content.
**Helps with:** Research-backed content; structured arguments; consistent quality.

---

### `article-extractor`
**How:** Extracts clean article content from URLs, stripping ads and navigation.
**When:** Reading a web article for research; summarizing external content.
**Helps with:** Clean content ingestion; removing noise from web pages; research workflows.

---

### `avoid-ai-writing`
**How:** Audits and rewrites content to remove AI writing patterns and clichés.
**When:** Content sounds robotic or generic; preparing content for publication; brand voice enforcement.
**Helps with:** Authentic-sounding copy; removing AI tells; human brand voice.

---

### `youtube-transcript`
**How:** Downloads YouTube video transcripts for analysis or summarization.
**When:** User shares a YouTube URL and wants content extracted, summarized, or analyzed.
**Helps with:** Learning from video content; research; extracting quotes and ideas from talks.

---

## 11. Code Review & Security

---

### `review`
**How:** Reviews a pull request for correctness, quality, and alignment with requirements.
**When:** PR is ready for review; after implementing a feature.
**Helps with:** Catching bugs; enforcing standards; knowledge sharing.

---

### `security-review`
**How:** Performs a structured security review of pending changes.
**When:** Before merging security-sensitive code; auth changes; data handling updates; public API changes.
**Helps with:** Finding OWASP Top 10 issues; input validation gaps; insecure defaults; dependency risks.

---

### `superpowers:code-reviewer` *(agent)*
**How:** Spawned as a subagent to review a major completed step against the original plan and coding standards.
**When:** A numbered plan step is complete; a significant feature is implemented.
**Helps with:** Independent validation; catching drift from the plan; enforcing standards without bias.

---

## 12. Claude API & AI Development

---

### `claude-api`
**How:** Builds, debugs, and optimizes Claude API / Anthropic SDK applications, including prompt caching.
**When:** Code imports `anthropic` or `@anthropic-ai/sdk`; building features with Claude models; migrating between model versions.
**Helps with:** Prompt caching; tool use; streaming; model version migrations; batch processing; citations; memory management.

**Trigger signals:**
- File imports `anthropic` or `@anthropic-ai/sdk`
- User mentions Claude API, Anthropic SDK, or Managed Agents
- Adding caching, thinking, tool use, or batch features to an AI app

---

## 13. Scheduling & Automation

---

### `loop`
**How:** Runs a prompt or slash command on a recurring interval; self-pacing when no interval is specified.
**When:** User wants to poll for status, run something repeatedly, or set up a recurring check.
**Helps with:** Automated monitoring; repeated task execution; polling background processes.

---

### `schedule`
**How:** Creates, updates, lists, or runs scheduled remote agents on a cron schedule.
**When:** User wants to automate a task on a time schedule (daily, weekly, etc.).
**Helps with:** Automated recurring tasks; hands-off monitoring; scheduled reporting.

---

## 14. Knowledge Graph

---

### `graphify`
**How:** Converts any input — code, docs, papers, images, or an entire codebase — into a structured knowledge graph.
**When:** User types `/graphify` followed by a path or input; when mapping relationships across a large codebase or document set.
**Helps with:** Visualizing dependencies and relationships; understanding unfamiliar codebases; building navigable knowledge structures from unstructured input.

---

## Quick Skill Selector

| I want to... | Use this skill |
|---|---|
| Plan before coding | `superpowers:writing-plans` → `superpowers:brainstorming` |
| Execute a plan | `superpowers:executing-plans` |
| Run tasks in parallel | `superpowers:dispatching-parallel-agents` |
| Write tests first | `superpowers:test-driven-development` |
| Review my code | `review` or `superpowers:requesting-code-review` |
| Security check | `security-review` |
| Debug a bug | `superpowers:systematic-debugging` |
| Improve code quality | `simplify` → `clean-code` → `refactoring-patterns` |
| Design a system | `system-design` or `ddia-systems` |
| Build UI | `frontend-design` → `refactoring-ui` |
| Add animations | `gsap-core` → specific gsap-* skill |
| Set up Claude Code config | `update-config` or `init` |
| Build with Claude API | `claude-api` |
| Write marketing copy | `storybrand-messaging` → `made-to-stick` |
| Validate product ideas | `lean-startup` → `mom-test` → `design-sprint` |
| Improve retention | `hooked-ux` → `improve-retention` |
| Schedule a recurring task | `schedule` or `loop` |
| Extract web content | `article-extractor` or `youtube-transcript` |
| Map a codebase or docs to a knowledge graph | `graphify` |
