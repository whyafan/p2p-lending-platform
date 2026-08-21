# Multi-lender pooling - design spec

> Phase 3 of `planv2.md`.
> Goal: several lenders each fund part of one loan, with pro-rata repayment and liquidation splits.
> Exit criteria: two lenders fund one loan, the borrower repays once, both receive their pro-rata share, and a liquidation splits correctly - all verified on-chain, not by UI impression.

## Summary

`Loan.sol`'s single atomic `fund()` becomes an accumulating `contribute()`.
Contributions escrow in the Loan contract until they sum to `principalAmount`; only then is the borrower paid and the loan funded.
Every repayment and every liquidation seizure is split pro-rata across contributors using a hybrid settlement model: instant push where the transfer succeeds, credited for pull withdrawal where it does not.
This is a contract change and a full Sepolia redeploy; old loans stay on the old factory.

## Settlement model (the load-bearing decision)

Three options were considered for distributing repayments to N lenders:

1. Pure push loop, matching today's instant settlement.
Rejected: `sendValue` reverts on failure, so one lender using a contract wallet with a reverting `receive()` would make `repay()` revert for everyone.
A malicious lender could contribute the minimum, block all repayment, force the borrower delinquent, and collect a pro-rata slice of the seized collateral.
That is a collateral-hostage exploit on a money path, not a theoretical concern.
2. Pure pull (claim model), where `repay()` only credits balances and every lender must `withdraw()`.
Rejected as primary: textbook-safe but changes lender UX everywhere and would rework the T1/T2/T3 transparency layer, which is built around instant settlement events.
3. **Chosen - hybrid push with pull fallback.**
Each lender's share is sent with a gas-capped low-level call.
On failure the share is credited to `pendingWithdrawals[lender]`, collectable via `withdraw()`.
Normal EOA wallets keep today's instant-settlement behavior; a reverting recipient can only hurt itself and can never block the borrower.

## Contract design

### Funding phase

- `contribute() external payable`, callable while status is `Requested` and `block.timestamp <= requestedAt + FUNDING_WINDOW`.
- The borrower cannot contribute.
- Minimum contribution: `principalAmount / 100` (1%), preventing dust shares.
- Maximum `MAX_LENDERS = 10` distinct contributors, bounding every later distribution loop's gas.
- A repeat contribution from an existing lender tops up their share and does not consume a new lender slot.
- The 1% minimum applies per `contribute()` call, top-ups included.
When the remaining gap is smaller than 1%, the closing contributor still sends at least the minimum and the over-fill refund returns the excess, so the minimum never blocks completion.
- Contributions escrow in the Loan contract (a structural change: today the contract never holds a balance).
- When a contribution makes the total reach `principalAmount`: any excess on that final contribution is refunded to its sender in the same tx, the full principal is forwarded to the borrower, `fundedAt` is set, the USD debt value is frozen from the oracle exactly as today, and status moves to `Funded`.
- One lender contributing the full principal in one call reproduces today's single-lender behavior exactly.

### Repayment

- `repay()` keeps its external behavior for the borrower: any partial or full amount against the live `outstandingBalance()`, overpayment refunded, collateral released on the final payment.
- Internally, each applied amount is split per lender as `share = mulDiv(applied, contributions[lender], principalAmount)` and delivered through the hybrid sender.
- Rounding dust (`applied - sum(shares)`, a few wei at most) goes to the last lender in the contributors array, deterministically, so the distributed sum equals the applied amount exactly.
- Because every applied wei splits by `contribution / principalAmount`, interest is automatically shared pro-rata; no separate interest accounting is needed.

### Liquidation

- `liquidate()` becomes callable by **any contributor** (the single-lender `onlyLender` modifier no longer applies; a pool must not depend on one specific person clicking).
- Seizure amount and borrower surplus refund are computed exactly as today.
- `CollateralVault` needs **no code change**: the Loan passes itself as the seizure recipient.
The Loan gains a `receive()` restricted to the vault, then distributes the received seizure pro-rata through the same hybrid sender.
- The vault continues to refund the borrower surplus directly, unchanged.

### Expiry and cancellation with a partial fill

- `cancel()` keeps working exactly as today (borrower-only, status `Requested`, releases collateral), including when partially filled.
- Contributors reclaim their escrowed contribution via a new pull-based `reclaimContribution()`, callable when the loan is `Cancelled`, or when it is still `Requested` past the funding window.
No refund loops; each contributor reclaims their own.
- `contribute()` reverts once the window has expired or the loan is cancelled.

### Misc

- `fastForward`'s participant gate becomes status-dependent.
While `Funded`, it extends from `borrower || lender` to `borrower || any contributor`, so a pooled loan's demo liquidation does not depend on one specific person.
While `Requested`, it stays **borrower-only**.

This last part corrects an earlier draft of this spec, which widened the gate for both statuses.
A review of the Task 1 implementation found the attack that opens: a contributor sends the 1% minimum, calls `fastForward(8 days)` to push the loan past its funding window, then calls `reclaimContribution()` to take the 1% back in the same block.
Because `requestedAt` only ever decreases, expiry is monotonic, so the loan is permanently unfundable; every other contributor's escrow is stranded until each individually reclaims, and the borrower must cancel and re-list.
Total attacker cost is gas.
Restricting the `Requested` branch to the borrower closes it completely and costs nothing, since no demo needs a lender to expire someone else's funding window.
- `withdraw()` pays out `pendingWithdrawals[msg.sender]` (from failed pushes) and is callable regardless of loan status.

## On-chain interface (what the frontend reads)

### Removed

- `lender` (no single lender exists). Every frontend read of `lender()` is updated in this phase.

### Added storage/views

- `getLenders() -> address[]`
- `contributions(address) -> uint256`
- `totalContributed() -> uint256`
- `pendingWithdrawals(address) -> uint256`
- `fundingProgressBps() -> uint256`

All other views keep their signatures (`outstandingBalance`, `isLiquidatable`, LTV views, `liquidationPreview`, etc.), so most existing frontend reads carry over untouched.

### Events

- `Contribution(uint256 indexed loanId, address indexed contributor, uint256 amount, uint256 totalContributed)` - per contribution.
- `LoanFunded(uint256 indexed loanId, uint256 totalContributed)` - once, when the pool fills. Signature changes; there is no single lender to name.
- `ShareDistributed(uint256 indexed loanId, address indexed lender, uint256 amount, bool pending)` - one per lender per distribution, for both repayments and liquidation seizures. `pending = true` means credited for withdrawal instead of pushed. This is the per-share source of truth for receipts and statements: filter by address, sum.
- `Withdrawal(uint256 indexed loanId, address indexed lender, uint256 amount)`.
- `ContributionReclaimed(uint256 indexed loanId, address indexed contributor, uint256 amount)`.
- `PartialRepayment`, `LoanRepaid`, `LoanLiquidated`, `LoanCancelled` stay loan-level and unchanged, so the borrower-side timeline keeps working as-is.

### Unchanged elsewhere

- `LoanFactory.createLoan()` signature and the `LoanCreated` event are unchanged, so `lib/decode-loan-created.ts` and risk-assessment keying (by loan contract address) carry over.
- This is a fresh ABI on a fresh deployment; there is no old-loan compatibility to preserve. `lib/loan-abi.ts` and `lib/loan-events.ts` update in lockstep.

## Frontend

Full scope, per the phase decision: funding UX plus per-share receipts and statements.

- **LenderDashboard, Open Requests:** funding progress bar (`totalContributed / principalAmount`) and a contribute-amount input (min 1% of principal, max the remaining gap), replacing the fund-exact-principal button.
- **LenderDashboard, My Positions:** a loan is mine when `contributions[myAddress] > 0`.
Each card shows my share percentage and pro-rata figures (lent, expected interest, my slice of the liquidation preview).
A Claim banner appears whenever `pendingWithdrawals[me] > 0` - the pull-fallback path must be visible or that money is invisible to its owner.
- **Borrower side:** `BorrowerLoansSection` and `LoanRequestPanel`'s "what happens next" show funding progress on `Requested` loans. The repay flow is unchanged.
- **Transparency layer:** `lib/loan-events.ts` indexes the new events.
T1 settlement receipts and T3 statements compute per-share numbers from `ShareDistributed` filtered by the viewing wallet.
`PublicLoanSummary` lender mode switches from `lender()` to `contributions(target) > 0`.

## Testing (TDD, contract-first)

New Hardhat suite covering, at minimum:

- Partial fills accumulating to exactly full; funding completes on the boundary.
- Over-fill on the last contribution refunds the excess in the same tx.
- Single-lender parity: one lender funding in full behaves byte-for-byte like today's flow.
- Pro-rata repayment splits across 2 and 3 lenders, asserting each share AND that shares sum exactly to the applied amount (rounding dust to the last lender).
- Liquidation seizure split across N lenders, with borrower surplus refund intact.
- Hybrid fallback: a contract lender with a reverting `receive()` gets credited to `pendingWithdrawals`, `withdraw()` recovers it, and the borrower's `repay()` is never blocked.
- Expiry reclaim and cancel-with-partial-fill reclaim; double-reclaim reverts.
- `MAX_LENDERS` and 1%-minimum enforcement; borrower cannot contribute; contribute after expiry/cancel reverts.
- Existing 28 tests updated where `fund()`/`lender` changed; everything else must keep passing.

Frontend: `node --test` for any extracted pure logic (e.g. share-math helpers), consistent with the repo's existing test tooling.

## Deploy and migration

- New Ignition deployment to Sepolia; update factory/vault/price-feed addresses in `frontend/.env` and the Vercel project env.
- Old loans remain on the old factory; the marketplace starts empty on the new deployment. Plan demo data accordingly.
- All four deployed URLs share contract addresses: coordinate with teammates before flipping env vars.
- No off-chain migration: Supabase schema is untouched; risk assessments key by loan contract address and simply apply to new loans.

## Explicitly out of scope

- ERC-20 principal (MockERC20 wiring is Phase 6).
- Liquidator bonus / public liquidation (Phase 4 Option B); Phase 3 keeps liquidation restricted to contributors.
- Secondary transfer of lender shares.
- Off-chain schema changes.
