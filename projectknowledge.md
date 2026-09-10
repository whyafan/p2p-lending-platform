# NexusFi - Project Knowledge

> The major design decisions taken while building NexusFi, and why.
> This captures the reasoning that the code and commit history do not make obvious.
> For current status see `report.md`; for remaining work see `planv2.md`.
> Last updated 2026-08-21 after Phase 3 (multi-lender pooling).

## Scope philosophy

**The live MVP is a deliberately smaller, honest subset of the academic spec.**
The literature review and project brief describe SHAP-based ML with MLOps, IPFS-anchored term sheets, an on-chain event indexer with dashboards, oracle-driven automatic liquidation with a full delinquency state machine, and decentralized identity.
The decision was to ship a real, working subset and track the gap explicitly rather than overclaim.
PLAN.md is the single living, code-accurate reference; the academic docs describe intent and were archived to `docs/archive/`.

## Risk scoring

- **Rule-based explainable scorer as the primary path.** `lib/risk-explainer.ts` computes an 8-feature weighted score deterministically. A real FastAPI ML model (`backend/`, trained `credit_model.pkl`) is called via `/api/credit/score` but **falls back to the rule-based scorer if the backend is down**, so scoring never blocks. The FastAPI backend is not deployed to production; the rule-based path always works.
- **Tier -> deterministic terms, not negotiated.** Tier A/B/C maps deterministically to max LTV, base APR + risk spread, and liquidation buffer in `lib/loan-terms.ts`. This is a core stance: terms are rule-derived from the risk signal, which is what makes the explainability meaningful.
- **Persist the borrower's risk breakdown for lenders.** The 8-feature score was originally computed in the browser and discarded on unmount, so lenders saw only a letter grade. Now saved to Supabase (`003_loan_risk_assessments.sql`) keyed by **loan contract address** (globally unique across factory redeploys), readable by any signed-in user (no PII, only signals that already set the public on-chain terms), insertable only by the creator, and immutable afterwards so a borrower can't rewrite an explanation a lender already funded against. Saved after the receipt confirms (the Loan address doesn't exist at submit time), best-effort so a failure never blocks the borrower.

## Smart contract design

- **Instant settlement where possible, with a pull fallback (revised in Phase 3).** Originally `fund()` forwarded `msg.value` to the borrower and each `repay()` forwarded to the lender instantly, with no pending state. Pooling kept that intent but could not keep the mechanism: see "Multi-lender pooling" below for why a pure push loop became unsafe once several lenders shared one loan.
- **Interest accrues by elapsed time, capped.** Interest accrues continuously from `fundedAt` (not only over the fixed `durationDays` term) and keeps growing past the deadline, but is capped at `repaymentDueAt() + GRACE_PERIOD` so it can't inflate forever once liquidatable. At demo scale the amounts are tiny (15% APR on 0.00225 ETH over 90 days is ~0.000083 ETH), which repeatedly looked like "no interest" but is correct.
- **Settlement stays ETH-denominated on purpose.** `repay()` owes principal + interest in ETH, and a price move does not restate what the borrower owes (there's a test asserting this). A fully USD-denominated loan would make the repayment float on every block, which is worse UX for a demo.
- **The USD debt freeze exists only to measure lender exposure and gate liquidation.** `principal/collateral` is a constant ratio when both legs are ETH, so an ETH price move mathematically cannot change it - the old client-side LTV bar was a no-op that could never signal risk. The fix: freeze `debtValueUsd = principal x priceAtFunding` while valuing collateral live. Liquidatable when `LTV >= maxLtvBps + liquidationBufferBps`.
- **Oracle fail-safe: unknown means safe.** If the oracle is missing, reverting, or returns 0, `currentLtvBps()` returns 0 meaning *unknown*, not "healthy", and price liquidation is disabled. Bad oracle data can never seize someone's collateral. All oracle reads go through a `try/catch` helper so a bad feed degrades gracefully instead of bricking every view.
- **Partial liquidation - seize the debt, refund the surplus.** Original `liquidate()` handed the lender the entire collateral, so a borrower who had repaid 90% still lost 100%, and even at zero repayment the lender got a ~1.75x windfall on an over-collateralised loan. Now seizes `min(outstandingBalance, collateralAmount)` and refunds the rest in the same tx. Because loans are over-collateralised at origination (max LTV 70%), the collateral in ETH always exceeds the debt in ETH, so the lender recovers principal + interest in full and the borrower keeps the rest - even a crash to $500 returns exactly the debt and no more (both legs are ETH). `liquidationPreview()` shows the split before anyone clicks.
- **Liquidation is not automatic, and that's a documented design position.** Contracts cannot self-execute. Real protocols pay liquidator bots a bonus or use a keeper network (Chainlink Automation). Ours requires a contributor to click (any of them, since Phase 3). Partial liquidation fixes *fairness*, not *timeliness*: if collateral fell below the debt while nobody acted, the lender would absorb the shortfall. Acceptable for an over-collateralised MVP.
- **`demoMode` read via try/catch view, not stored per-loan.** Adding a 12th constructor parameter blew the EVM stack limit ("stack too deep"), so `fastForward` reads `demoMode` from the factory to keep a single source of truth.
- **`fastForward` rewinds the loan's own timestamps.** `block.timestamp` can't be moved on a live chain, so demo time-travel rewinds the loan's stored timestamps instead (equivalent effect), gated by `demoMode`. Its participant gate is status-dependent: borrower-only while `Requested`, borrower or any contributor once `Funded`. The `Requested` restriction exists because rewinding `requestedAt` past the funding window is irreversible (see the pooling section).

## Transparency as the product's backbone

- **The app must be the source of truth, because the wallet cannot be.** Every payment - funding, repayment, seizure, refund - moves as an *internal contract transfer*, which MetaMask does not list. Both sides repeatedly concluded "nothing was received" when money had moved correctly. This drove the entire T1-T3 transparency effort and the earlier in-card "where the money is" panels.
- **Three things that looked like bugs and were not:** invisible-but-correct interest (elapsed-time accrual at tiny demo scale), a crash to $500 not enabling liquidation (that loan was *funded* at $500, so $500 was already its baseline), and "the lender took the whole collateral" (partial liquidation refund arrived as an invisible internal transfer). The fix was to expose the truth, not change behaviour.
- **Deployment block is derived, not pinned.** `findDeploymentBlock()` binary-searches the factory deployment block via `eth_getCode` because contracts get redeployed often here; a hardcoded block silently yields empty history the moment it goes stale. Logs fetched in 9,000-block chunks so a wide range never trips an RPC span limit.
- **Event-backed history replaced a localStorage hack.** The old tx-hash matching in `BorrowerLoansSection` only ever knew about loan creation and was fragile. Indexing real events is now the source of the timeline and the statement PDFs.

## Peer discovery (Phase 2)

- **A dedicated `public_profiles` view instead of opening `profiles` up.** The directory reads a Supabase view exposing only non-PII fields (display name, KYC status, role, verified primary wallet), joined so only users with a signature-verified primary wallet appear at all.
The underlying tables and their RLS stay untouched.
- **Views bypass RLS, so grants are the whole security model - and the default grant is the trap.** Supabase grants `ALL` on public-schema objects to `anon` by default, and a view has no RLS of its own.
The original migration granted `SELECT` to `authenticated` but never revoked `anon`, leaving every verified user's name, wallet, KYC status, and role readable with just the public anon key - caught only by the final whole-branch review after seven per-task reviews missed it.
The fix is explicit: `REVOKE ALL ON public_profiles FROM anon, PUBLIC`.
Lesson: for any future view, revoke first, then grant.
- **Nothing at the DB level enforces one primary wallet per user.** `linked_wallets` is `UNIQUE(wallet_address, chain_id)`, so the same address can be primary-and-verified on two chains (or, cross-chain, for two different users), and the view can return multiple rows per address.
The lookup route therefore orders deterministically and takes one row instead of `.maybeSingle()`, which throws (a 500) on multiple rows.
- **Search logic is pure and unit-tested; the page only debounces and guards staleness.** Matching, normalisation, and deterministic order-before-cap live in `lib/directory.ts` (results must be ordered before capping or pagination is nondeterministic).
The search page never renders results from a superseded query - a lint-driven restructure once reintroduced exactly that stale-UI bug, so it is now an explicit guard.
- **Profile pages are strictly read-only.** `PublicLoanSummary` has no write path and hides expired loan requests so nothing unfundable ever looks fundable.

## Multi-lender pooling (Phase 3)

- **A pure push loop would have handed one lender a hostage.** With N lenders, the obvious `repay()` is a loop that sends each share. But `sendValue` reverts on failure, so a single lender using a contract wallet with a reverting `receive()` makes the whole repayment revert for everyone. That lender could contribute the 1% minimum, block all repayment, drive the borrower delinquent, and then collect a pro-rata slice of the seized collateral. The chosen model is hybrid: try a gas-capped push, and on failure credit `pendingWithdrawals` for the lender to `withdraw()`. Normal EOA wallets keep instant settlement, and a reverting recipient can only hurt itself. A pure pull (claim-everything) model was rejected as primary because it would have reworked the entire T1-T3 transparency layer, which is built around instant settlement events.
- **Dust goes to the last lender, deliberately.** Each lender except the last gets `mulDiv(amount, contribution, principal)`, a floor. The last gets `amount - sum(previous)`. This guarantees the distributed total equals the applied amount exactly, with no wei stranded and none created. Giving everyone the floor would silently strand a few wei in the contract on every distribution.
- **Over-contribution is a feature, not a mistake to block.** When the remaining gap is smaller than the 1% minimum, a closing contributor *must* send more than the gap, because the contract's minimum applies to every call. The excess is refunded in the same transaction. A UI that "helpfully" clamped input to the visible gap would have made such loans permanently unfundable. This is the single most counterintuitive behaviour in the feature and it has dedicated UI copy.
- **Expiry is monotonic, which makes a rewind irreversible.** `requestedAt` only ever decreases (via `fastForward`), and `block.timestamp` only increases, so once a loan is past its funding window it can never return. The original spec widened `fastForward` to any contributor for both statuses; a review found that this let a 1% contributor expire an open request and reclaim in the same block, permanently bricking it for every other contributor at the cost of gas. Hence the borrower-only gate while `Requested`.
- **The contract never uses `address(this).balance` for accounting.** All state is explicit counters (`totalContributed`, `contributions`, `pendingWithdrawals`), so force-sent ETH (via `selfdestruct`, which cannot be prevented) inflates the balance harmlessly and can neither be swept nor double-counted. Had `contribute()` derived the accepted amount from balance rather than `msg.value`, it would have been attackable.
- **The vault did not need to change.** `liquidate()` passes the Loan itself as the seizure recipient and the Loan re-splits it, so `CollateralVault.liquidateCollateral(loanId, recipient, seizeAmount)` works unchanged. The Loan's `receive()` is gated to the vault so nothing else can push plain ETH in.
- **Cost basis comes from contract state, not from events.** A statement's P&L originally derived a lender's contribution by summing their `Contribution` events. That is wrong twice over: the event log is fetched in chunks and can silently come back partial, and more importantly the event list is already filtered by the statement's reporting period. Choosing any period that excludes the funding date collapsed the cost basis to zero and reported the entire repayment as pure profit in a document labelled Tax P&L. The contract's `contributions(address)` view has neither problem and is now the source.
- **Income is recognised once, at distribution.** A failed push emits `ShareDistributed(pending = true)` and the later `withdraw()` emits `Withdrawal` for the *same* wei. Counting both made the Tax P&L show double the acquisitions and disagree with the P&L in the same download by exactly the pending amount. The withdrawal is a transfer of already-recognised income, not new income.
- **Per-document filtering, not one rule everywhere.** A Tax P&L should contain only the viewer's own cash movements, so other lenders' slices are excluded. A Tradebook bills itself as a complete transaction record, so it keeps the loan's lifecycle events (funded, repaid, liquidated) as context while still dropping other lenders' individual rows. Applying either rule to both documents produces a wrong one.
- **A model migration needs a copy audit, not just a compile sweep.** Five separate tasks each found text still written for the single-lender model: "Loan funded!" shown after any partial contribution, "You funded" displaying the whole principal, "the lender would take", pool figures under a heading reading "Your protection". None of it fails to compile. `tsc` cannot see a sentence that has become a lie.
- **Loosely-typed contract wrappers defeat the typecheck gate.** `/demo` called the removed `lender()` through a helper whose parameter was a hand-written string union rather than an ABI-derived type, so the migration typechecked clean while that page would have thrown at runtime. Any wrapper that accepts a function name as a plain string is invisible to the compiler.
- **Read expiry from the field the contract actually gates on.** The UI computed the funding deadline from the factory's `createdAt`, which never changes, while the contract gates on `requestedAt`, which `fastForward` rewinds. Time-skips were therefore invisible to the lender UI: cards showed time remaining, Contribute reverted, and the Reclaim card never appeared, leaving escrowed ETH unreachable except through a block explorer.

## Parallel work on a shared branch

- **Two people independently fixed the same bugs (B2, B3) on `atharva` during Phase 1.** The merge decision was per-hunk on merit: the teammate's `EthPriceTicker` component won over the inline fix, but the inline fix's `marketData` key correction (`'ETH'` vs `'ethereum'`) was ported into it because their version had the identical broken lookup.
Never force-push over a teammate's commits; trial-merge, inspect, then merge.
- **Coordinate `planv2.md` phase ownership up front** - later phases touch files (`app/app/page.tsx`, `settings/page.tsx`) the teammate is active in, and Phase 3's contract redeploy changes shared Sepolia addresses for all four deployments at once.

## Identity, KYC, privacy

- **KYC is off-chain (Didit + Supabase), bound to wallet by signature.** `KYCRegistry.sol` exists as a documented M1 on-chain reference but is intentionally unused in the live flow - kept in place per the project brief, not accidental cruft.
- **Privacy by design, partially.** PII lives in Supabase behind the service-role key, no PII on-chain. This aligns conceptually with the spec but lacks the IPFS/hash-anchoring layer the official docs describe.
- **`setPrice` made permissionless for the demo.** Gating it to the deployer meant only one teammate could run the demo. It's a mock oracle on testnet; the note is: never ship it to a real network.

## Shared ABI - a real bug's root cause

- **`lib/loan-abi.ts` is the single shared Loan/LoanFactory ABI.** Three components previously hand-copied local ABI arrays that went stale, which was the root cause of `markLiquidatedForDemo` living on in two places after the contract changed. One shared ABI is the fix.

## Infrastructure decisions

- **Separate frontends, shared backend.** All four Vercel branch deployments (`main`, `afan`, `siddharth`, `atharva`) point at the *same* Sepolia contracts and *same* Supabase project - deliberate, so one person can borrow and another lend and actually see each other. Consequence: test data and any contract redeploy affect all four at once.
- **Vercel root directory must be `frontend`** (monorepo), Deployment Protection disabled so teammates on a Hobby team can reach preview URLs (fine for a no-funds testnet demo).
- **Contract verification gotchas.** Verify must run with `--build-profile production` (Ignition deploys with optimizer on, 200 runs) after `npx hardhat compile --build-profile production`; otherwise bytecode won't match. Etherscan verify is configured but disabled until an API key is set (enabling it keyless fails every run); Sourcify and Blockscout need no key.
- **Supabase is the sole off-chain DB.** Prisma/SQLite was fully removed.

## Cleanup stance

- Untracked `backend/venv/` (179MB) and deleted a duplicate virtualenv; archived superseded one-off docs to `docs/archive/`; removed dead Hardhat scaffold and dead frontend code confirmed by repo-wide grep to have zero import sites.
- `KYCRegistry.sol` and `MockERC20.sol` were deliberately *not* removed - forward-looking reference artifacts, not junk.
