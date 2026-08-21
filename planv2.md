# NexusFi - Phasewise Plan v2 (remaining work)

> Generated 2026-07-29. Divides everything not yet done into phases to implement one at a time.
> Ordered by value and by dependency: quick correctness fixes first, then the biggest architectural gaps, then optional polish.
> For current status see `report.md`; for design reasoning see `projectknowledge.md`.

## Snapshot of what is left

The happy path (create -> fund -> repay/liquidate) works end-to-end on Sepolia with both liquidation triggers, partial repayment, partial liquidation, and the full T1-T3 transparency layer.
What remains is a handful of reported bugs, three genuine architectural gaps (multi-lender pooling, automatic liquidation, on-chain event indexer), and a spec-alignment tail (IPFS term sheets, real ML/MLOps, decentralized identity).

---

## Phase 1 - Bug fixes and correctness (smallest, highest confidence)

Goal: clear every open reported bug before adding features. Each is small and independently shippable.

1. **B3 - RiskExplanationPanel light-on-white.** `RiskExplanationPanel.tsx` hardcodes `bg-white`/`bg-slate-50` and dark text against a dark app. Restyle to match the dark theme. (Pure CSS, do first.)
2. **B2 - dashboard ETH price unlabelled and static.** Label it explicitly as current market ETH price and make it tick live rather than refreshing only on load. `PriceTicker.tsx` + `useTokenPrices`.
3. **B1 - risk tier/score not scored on the real-wallet path.** Reproduce first (which mode, where it shows unscored) - demo personas score correctly, so the fault is likely the real-wallet extraction path or the lender-side persisted assessment. Root-cause in an E2E setting, then fix.
4. **BUG-VIS - cross-account loan visibility.** Marked passed after a polling fix but the root cause was never diagnosed (multicall read timing / wrong network mode / stale loanIds cache). Add a regression check and confirm two fresh accounts reliably see each other's loans.
5. **BUG-14 - `liquidationBufferBps` missing from some lender views.** Visual gap; add the field.
6. **BUG-11 - loan-ID inference race** if two loans are created simultaneously. Decode the loan address from the `LoanCreated` event receipt instead of inferring the ID (the event already carries it). Medium.
7. **BUG-03 - interest rounds to 0 below ~3650 wei.** Low impact; document the floor or use higher-precision accrual math. Lowest priority in this phase.

**Exit criteria:** every row in the Known Bugs and Reported Bugs tables is closed or explicitly deferred with a reason.

---

## Phase 2 - Peer discovery (small feature, real usability win)

Goal: stop making teammates coordinate borrower/lender pairs by guessing loan IDs.

- A searchable directory of verified users (by display name or linked wallet address), so a lender can find a specific borrower and vice versa.
- Read from Supabase profiles + linked wallets (already exist); no contract change.
- RLS: expose only non-PII fields (display name, verified wallet address, KYC badge, role).

**Exit criteria:** a user can look up another verified user and see their open loans without knowing a loan ID in advance.

---

## Phase 3 - Multi-lender pooling (biggest architectural gap)

Goal: let several lenders each fund part of one loan, with pro-rata repayment. Explicitly called MVP-feasible in the lender-journey doc.

This is a contract change and forces a redeploy, so treat it as its own phase.

- **Contract:** `Loan.sol` tracks per-lender contributions (`mapping(address => uint256)`), funding completes when the sum reaches `principalAmount`, and each `repay()` distributes pro-rata to contributors. Liquidation seizure/refund splits pro-rata too.
- **Edge cases to nail with tests first (TDD):** partial fills, over-fill on the last contribution (refund the excess), funding-window expiry with a partially filled loan (refund all contributors), pro-rata rounding dust, and liquidation split across N lenders.
- **Frontend:** Open Requests shows a funding progress bar and a "contribute" amount input; My Positions shows each lender's share and pro-rata figures; settlement receipts and statements extend to per-share numbers.
- **Migration:** none off-chain, but risk-assessment and event indexing already key by loan contract address, so they carry over.

**Exit criteria:** two lenders fund one loan, the borrower repays once, both receive their pro-rata share, and a liquidation splits correctly - all verified on-chain, not by UI impression.

---

## Phase 4 - Automatic / incentivised liquidation (timeliness gap)

Goal: close the one fairness-adjacent gap - collateral falling below debt while nobody clicks liquidate.

- **Option A (lazy, recommended first):** a keeper script (off-chain cron/bot) that scans open loans via the existing views and calls `liquidate()` when `isLiquidatable()` is true. No contract change; ships fast; documents the "not truly trustless" caveat honestly.
- **Option B (full):** an on-chain liquidator bonus - `liquidate()` pays a small percentage of seized collateral to `msg.sender`, so any third party is incentivised to race for it (the real-protocol pattern). Contract change + redeploy + tests.
- Decide A vs B based on whether the report needs "decentralised" or just "timely". Start with A.

**Exit criteria:** an under-water loan gets liquidated without the specific lender manually clicking.

---

## Phase 5 - On-chain event indexer + dashboards (observability, scale)

Goal: replace the live wagmi multicall on page load with a proper indexer, and add the analytics the official docs describe.

- Index events into Supabase (or a lightweight indexer) instead of reading everything on each page load - the current approach works at demo scale but won't scale to many loans.
- Dashboards: default rate, liquidation count, average APR, ML-score distribution.
- Builds directly on the T2 event indexing already in `lib/loan-events.ts` - extend it from per-loan reads to a persisted aggregate.

**Exit criteria:** the marketplace and dashboards read from the index, not a full-chain multicall, and the four aggregate metrics render.

---

## Phase 6 - Spec-alignment tail (optional, for full academic parity)

These close the remaining gaps versus the literature review. Each is independent; pick per report needs.

- **IPFS-anchored term sheets** - DONE 2026-08-21 (hash + CID off-chain in Supabase; on-chain anchoring deferred to a Phase 4 Option B redeploy).
- **Real ML with SHAP + versioning/MLOps** - DONE 2026-08-21 (Render deploy via render.yaml, content-hash model versioning; rule-based path kept as fallback).
- **MockERC20 as an alternative loan asset** - DEFERRED: every value path in the pooled Loan.sol is ETH-native; batch with the Phase 4 Option B redeploy.
- **Real `extract_features(wallet_address)` pipeline** - DONE (already implemented in backend/app/services/chain_fetcher.py via Alchemy mainnet+Sepolia; now actually reachable in production).
- **Decentralized identity / on-chain KYC** - DEFERRED: enforcing KYCRegistry in createLoan() needs a redeploy; batch with Phase 4 Option B.
- **Real KYT** - DEFERRED: Chainalysis/TRM APIs are paid; mock stays, still flagged as mock.

---

## Phase 7 - Optional polish (do anytime)

- Network-switch prompt when MetaMask is on the wrong chain.
- Loan filter/sort in the marketplace (by status, tier, APR).
- Confirm Supabase "Confirm email" Site URL points at the deployed URLs, not `localhost:3000` (would break signup for anyone off the dev machine).

---

## Suggested order

Phase 1 (bugs) -> Phase 2 (peer discovery) -> Phase 3 (multi-lender pooling) -> Phase 4 (auto liquidation).
Phases 5-7 are value-dependent and can be interleaved or dropped based on what the final report needs to claim.
