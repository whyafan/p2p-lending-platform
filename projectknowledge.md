# NexusFi - Project Knowledge

> The major design decisions taken while building NexusFi, and why.
> This captures the reasoning that the code and commit history do not make obvious.
> For current status see `report.md`; for remaining work see `planv2.md`.

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

- **Instant settlement, no pending state.** `fund()` forwards `msg.value` to the borrower in the same tx; each `repay()` forwards to the lender instantly. There is no separate settlement step.
- **Interest accrues by elapsed time, capped.** Interest accrues continuously from `fundedAt` (not only over the fixed `durationDays` term) and keeps growing past the deadline, but is capped at `repaymentDueAt() + GRACE_PERIOD` so it can't inflate forever once liquidatable. At demo scale the amounts are tiny (15% APR on 0.00225 ETH over 90 days is ~0.000083 ETH), which repeatedly looked like "no interest" but is correct.
- **Settlement stays ETH-denominated on purpose.** `repay()` owes principal + interest in ETH, and a price move does not restate what the borrower owes (there's a test asserting this). A fully USD-denominated loan would make the repayment float on every block, which is worse UX for a demo.
- **The USD debt freeze exists only to measure lender exposure and gate liquidation.** `principal/collateral` is a constant ratio when both legs are ETH, so an ETH price move mathematically cannot change it - the old client-side LTV bar was a no-op that could never signal risk. The fix: freeze `debtValueUsd = principal x priceAtFunding` while valuing collateral live. Liquidatable when `LTV >= maxLtvBps + liquidationBufferBps`.
- **Oracle fail-safe: unknown means safe.** If the oracle is missing, reverting, or returns 0, `currentLtvBps()` returns 0 meaning *unknown*, not "healthy", and price liquidation is disabled. Bad oracle data can never seize someone's collateral. All oracle reads go through a `try/catch` helper so a bad feed degrades gracefully instead of bricking every view.
- **Partial liquidation - seize the debt, refund the surplus.** Original `liquidate()` handed the lender the entire collateral, so a borrower who had repaid 90% still lost 100%, and even at zero repayment the lender got a ~1.75x windfall on an over-collateralised loan. Now seizes `min(outstandingBalance, collateralAmount)` and refunds the rest in the same tx. Because loans are over-collateralised at origination (max LTV 70%), the collateral in ETH always exceeds the debt in ETH, so the lender recovers principal + interest in full and the borrower keeps the rest - even a crash to $500 returns exactly the debt and no more (both legs are ETH). `liquidationPreview()` shows the split before anyone clicks.
- **Liquidation is not automatic, and that's a documented design position.** Contracts cannot self-execute. Real protocols pay liquidator bots a bonus or use a keeper network (Chainlink Automation). Ours requires the lender to click. Partial liquidation fixes *fairness*, not *timeliness*: if collateral fell below the debt while nobody acted, the lender would absorb the shortfall. Acceptable for an over-collateralised MVP.
- **`demoMode` read via try/catch view, not stored per-loan.** Adding a 12th constructor parameter blew the EVM stack limit ("stack too deep"), so `fastForward` reads `demoMode` from the factory to keep a single source of truth.
- **`fastForward` rewinds the loan's own timestamps.** `block.timestamp` can't be moved on a live chain, so demo time-travel rewinds the loan's stored timestamps instead (equivalent effect), gated by `demoMode` and callable only by that loan's own borrower or lender so nobody can shove a stranger into liquidation.

## Transparency as the product's backbone

- **The app must be the source of truth, because the wallet cannot be.** Every payment - funding, repayment, seizure, refund - moves as an *internal contract transfer*, which MetaMask does not list. Both sides repeatedly concluded "nothing was received" when money had moved correctly. This drove the entire T1-T3 transparency effort and the earlier in-card "where the money is" panels.
- **Three things that looked like bugs and were not:** invisible-but-correct interest (elapsed-time accrual at tiny demo scale), a crash to $500 not enabling liquidation (that loan was *funded* at $500, so $500 was already its baseline), and "the lender took the whole collateral" (partial liquidation refund arrived as an invisible internal transfer). The fix was to expose the truth, not change behaviour.
- **Deployment block is derived, not pinned.** `findDeploymentBlock()` binary-searches the factory deployment block via `eth_getCode` because contracts get redeployed often here; a hardcoded block silently yields empty history the moment it goes stale. Logs fetched in 9,000-block chunks so a wide range never trips an RPC span limit.
- **Event-backed history replaced a localStorage hack.** The old tx-hash matching in `BorrowerLoansSection` only ever knew about loan creation and was fragile. Indexing real events is now the source of the timeline and the statement PDFs.

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
