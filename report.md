# NexusFi P2P Lending Platform - Implementation Report

> Generated 2026-07-29 from the live codebase and PLAN.md; last updated 2026-08-21 after Phase 3 (multi-lender pooling) and Phase 6 (ML deployment, model versioning, IPFS term sheets) shipped.
> This is a status snapshot of what actually runs, not a spec of intent.
> For the phased plan of remaining work see `planv2.md`; for the reasoning behind the design see `projectknowledge.md`.

## One-paragraph summary

Borrowers lock ETH collateral on-chain and request a loan.
An explainable rule-based risk engine (with an optional real ML backend and graceful fallback) assigns a Tier A/B/C that deterministically sets max LTV, interest spread, and liquidation buffer.
The borrower signs an EIP-712 term sheet, and up to 10 lenders each contribute part of one loan; the contract escrows contributions, pays the borrower only when the pool fills, and splits every repayment and liquidation seizure pro-rata.
Repayment (partial or full), deadline enforcement, and liquidation (delinquency or collateral shortfall) all settle on-chain.
KYC, auth, and off-chain metadata live in Supabase.
The full lifecycle is deployed and working end-to-end on the Sepolia testnet.

## Architecture at a glance

```
Layer 1 (Inputs)     Synthetic borrower personas (Alice/Charlie/Bob) + real wallet feature extraction
Layer 2 (Risk)       Rule-based explainable scoring engine -> Tier A / B / C
                       (optional FastAPI ML backend with fallback)
Layer 3 (Execution)  Sepolia contracts: CollateralVault + LoanFactory + Loan + MockPriceFeed
Layer 4 (UI)         Next.js dashboard (app/app/page.tsx): role toggle, borrower panel,
                       lender dashboard, borrower loans, statements
```

Off-chain: Supabase (auth, KYC, risk-assessment snapshots, per-event price snapshots), Didit KYC, optional FastAPI credit scorer.

## Deployed contracts (Sepolia, redeployed 2026-08-21 for multi-lender pooling)

| Contract | Address |
|---|---|
| LoanFactory | `0x0e3ea8f226434feadb267d05c9c4ef8f951c7d00` |
| CollateralVault | `0x084a1b982ac01cae891417dea52b27b0e2b79a0f` |
| MockPriceFeed | `0x43a39f432e38a7665db04a536c4d19460331bb6f` |

All three are populated in `frontend/.env`. Source-verified on Blockscout and Sourcify (earlier factory address).

## What is implemented

### Smart contracts (`contracts/contracts/`)

- **Loan.sol** - core lifecycle. `contribute()` accumulating pooled contributions within a 7-day funding window, `repay()` accepting any partial or full amount against a live `outstandingBalance()`, `cancel()`, `reclaimContribution()`, `withdraw()`, and `liquidate()` gated on a real deadline + 2-day grace period **or** an oracle-priced LTV breach.
- Interest accrues continuously from `fundedAt` via `interestDue()`, capped once the loan becomes liquidatable so it never inflates forever.
- Partial liquidation: `liquidate()` seizes only `min(outstandingBalance, collateralAmount)` and refunds the surplus to the borrower in the same tx. `liquidationPreview()` exposes the split before anyone clicks.
- Oracle price trigger: debt is frozen in USD at funding (`debtValueUsd`, `priceAtFunding`) while collateral is valued live, so an ETH crash actually raises LTV. Fail-safe: a missing, reverting, or zero-price oracle disables price liquidation rather than seizing collateral.
- Views: `repaymentDueAt()`, `isDelinquent()`, `isLiquidatable()`, `outstandingBalance()`, `currentLtvBps()`, `liquidationThresholdBps()`, `isPriceLiquidatable()`, `isDelinquentLiquidatable()`.
- Demo hooks: `fastForward(seconds)` (rewinds a loan's own timestamps, gated by factory `demoMode` and callable only by that loan's borrower/lender).
- **LoanFactory.sol** - creates and tracks all loans, emits `LoanCreated`, passes the price feed to every Loan.
- **CollateralVault.sol** - ETH custody: `lockCollateral()`, `releaseCollateral()`, `liquidateCollateral(seizeAmount)` with surplus refund.
- **MockPriceFeed.sol** - permissionless `setPrice()` for demo crash simulation.
- **MockERC20.sol** - deployed, not yet wired as a loan asset (Phase 2).
- **KYCRegistry.sol** - on-chain KYC reference, intentionally unused (KYC enforced off-chain).
- Hardhat Ignition module `NexusFiMilestone1.ts` deploys and wires all three in one shot; config has `localhost` and `sepolia` networks; compiles clean on solc 0.8.28.
- **54/54 contract tests passing** (`NexusFiMilestone1.ts`, `LoanLifecycle.ts`, `MultiLenderFunding.ts`, `MultiLenderSettlement.ts`) covering partial/full repayment, overpayment refunds, interest accrual and capping, both liquidation triggers, partial-liquidation fairness, and the full pooling surface: partial fills, over-fill refunds, the lender cap, pro-rata splits with exact-sum rounding-dust assertions, the hybrid push/pull fallback, and reclaim on cancel or expiry.

### Frontend - borrower

- Layer 1 personas (`lib/borrower-personas.ts`) + real wallet feature extraction (`lib/feature-extractor.ts`).
- Layer 2 explainable scorer (`lib/risk-explainer.ts`) with `FEATURE_WEIGHTS` and `TIER_THRESHOLDS`, wired through `/api/risk/score` and `/api/credit/score` (with ML fallback).
- `RiskExplanationPanel.tsx` - weight breakdown, tier bar, formula, threshold table.
- `LoanRequestPanel.tsx` - full wizard (mode -> persona/wallet evaluation -> config -> review -> lifecycle explainer), calls `LoanFactory.createLoan()`, and EIP-712 term-sheet signing before creation.
- `BorrowerLoansSection.tsx` - own loans read live, status, live outstanding balance, due date, past-due badge, and a repay control (custom amount or repay-in-full).
- Live LTV health monitor (green/amber/red) with current LTV%, max-LTV marker, liquidation-threshold marker.
- Etherscan tx links after every on-chain action.

### Frontend - lender

- Role toggle in `app/app/page.tsx`, gated by `canLend`/`userRole`.
- `LenderDashboard.tsx` - reads all loan IDs via multicall, "Open Requests" and "My Positions" tabs, LTV bar reading `currentLtvBps()`, funding via exact-principal payable call.
- Mock ETH/USD oracle panel to crash price; liquidate button gated on-chain by `isLiquidatable()` with a live countdown and a "LIQUIDATABLE" badge naming the reason.
- `LoanSafetyPanel.tsx` - collapsible per-loan explainer (why this tier, your protection, what can go wrong).
- `LoanSettlementReceipt.tsx` - settlement receipts on closed loans (T1): total lent/received, interest earned in ETH and USD, seize vs refund if liquidated, per-leg Etherscan links.

### Transparency layer (T1-T3, shipped 2026-07-29)

- **T1 settlement receipts** - full close-out breakdown for both roles on every closed loan.
- **T2 event-backed history** - `lib/loan-events.ts` indexes `LoanFunded`, `PartialRepayment`, `LoanRepaid`, `LoanLiquidated`, `CollateralReleased` via `getLogs`, with `findDeploymentBlock()` binary-searching the factory deployment block and chunked 9,000-block fetches. Rendered as a per-loan timeline; replaces the old `localStorage` tx-hash hack. Hook: `useLoanEvents.ts`.
- **T3 downloadable statements** - `lib/statements.ts` + `StatementsPanel.tsx` generate P&L, Tax P&L, and Tradebook PDFs (jsPDF + autoTable) built entirely from indexed events. Surfaced in Settings.
- Requires migration `004_event_price_snapshots.sql`; without it statements value at current price and label "(est.)".

### Peer discovery (Phase 2, shipped 2026-08-20)

- **`public_profiles` Supabase view** (`005_public_profiles_view.sql`) - non-PII directory source: display name, KYC status, role, and the verified primary wallet address, joined from `profiles` + `linked_wallets`.
`SELECT` granted to `authenticated` only; `anon` and `PUBLIC` explicitly revoked (a final review caught that Supabase's default grants would otherwise have exposed the directory without login - if migration 005 was applied before commit `589c6fd`, re-run it).
- **Pure search/lookup logic** in `lib/directory.ts` with 23 unit tests (`lib/directory.test.ts`): query normalisation, name vs wallet-address matching, deterministic ordering before capping.
- **API routes** - `/api/directory/search` and a profile lookup route; lookup orders deterministically and takes one row instead of assuming one primary wallet per address (DB does not enforce it).
- **`/directory` search page** with debounced search and a stale-query guard (results from a superseded query never render), plus a nav link.
- **Profile page** `/directory/[walletAddress]` - `KycBadge` (extracted shared component) and read-only `PublicLoanSummary` showing the user's open loans; expired loan requests are not shown as fundable.
- Exit criterion met: a user can find another verified user by name or wallet and see their open loans without knowing a loan ID.
- Verified statically: 132/132 tests, `tsc --noEmit` clean, eslint clean.
Track F manual browser verification (`tests/MANUAL_TEST_PLAN.md`, needs two accounts) is still outstanding.

### Phase 6 - ML deployment, model versioning, IPFS term sheets (shipped 2026-08-21)

- **Credit backend deployable via `render.yaml`** (Render free tier). Wallet-mode scoring now
  runs the real LightGBM + SHAP pipeline with live Alchemy chain fetching when
  `CREDIT_BACKEND_URL` is set; the rule-based scorer remains the automatic fallback.
  Free-tier note: the service sleeps after 15 min idle (~50s wake); the wizard fires a
  warm-up ping on wallet-mode entry and the fallback copy explains the wake.
- **Model versioning**: `train.py` stamps `model_meta.json` (version = content hash of the
  model file); every score response carries `model_version`; migration 006 persists it per
  loan and the lender safety panel shows which scorer priced the loan.
- **EIP-712 term-sheet signing + IPFS anchoring**: correction - before Phase 6 no EIP-712
  signing existed despite earlier claims in this report; the "term sheet" was an unsigned
  computed object. Wallet-mode borrowers now sign a LoanTermSheet typed message; the signed
  document is pinned to Pinata, the CID + keccak256 canonical hash persist with the risk
  assessment, and lenders can fetch, re-hash, and verify the signer from the safety panel.
  Best-effort: declined signature or failed pin never blocks loan creation. Persona/demo
  loans do not sign or pin.
- **Manual setup**: (1) Render Blueprint from `render.yaml` + paste `ALCHEMY_API_KEY`;
  (2) set `CREDIT_BACKEND_URL` and `PINATA_JWT` on all four Vercel deployments;
  (3) run migration `006_model_version_and_termsheets.sql` in the Supabase SQL editor.
- Deferred from Phase 6 (documented in planv2.md): ERC-20 principal and on-chain KYC
  (batch with a Phase 4 Option B redeploy), real KYT (paid APIs).

### Multi-lender pooling (Phase 3, shipped 2026-08-21)

Contract change, so this forced a full Sepolia redeploy; the addresses in the table above are the pooled set.
Loans on the previous factory stay there and do not appear in the new marketplace.

- **`Loan.sol` rewritten around a pool.** `contribute()` escrows partial contributions in the Loan contract while the loan is `Requested`; the borrower is paid, and status flips to `Funded`, only when contributions reach `principalAmount` exactly.
Over-contribution is accepted and the excess refunded in the same transaction, which is what lets a closing contributor cover a gap smaller than the 1% minimum.
`MAX_LENDERS = 10` bounds every later distribution loop; a repeat contribution tops up an existing share rather than taking a new slot.
- **Pro-rata distribution with exact-sum dust handling.** Every repayment and every liquidation seizure splits by `contribution / principalAmount`. Each lender except the last receives the exact floor via `Math.mulDiv`; the last receives the remainder, so the distributed total always equals the applied amount to the wei.
- **Hybrid settlement: push where possible, pull where not.** Each share is sent with a gas-capped call. On failure the share is credited to `pendingWithdrawals` for the lender to `withdraw()`, so a lender using a contract wallet that reverts on receive can only affect their own share and can never block the borrower's repayment. A pure push loop would have let one hostile contributor hold a borrower's collateral hostage.
- **Liquidation is callable by any contributor**, not one designated lender, and routes the seizure through the Loan (its `receive()` is gated to the vault) so the same pro-rata split applies. `CollateralVault.sol` needed no change.
- **Reclaim for dead pools.** `reclaimContribution()` returns an escrowed contribution when the borrower cancels or the funding window expires while still `Requested`. Pull-based, so no refund loop.
- **`fastForward`'s gate is status-dependent**: borrower-only while `Requested`, borrower or any contributor once `Funded`. A review found that the wider gate would have let a 1% contributor rewind an open request past its window and permanently brick it for the cost of gas.
- **Frontend.** Funding progress and a contribute-amount input on Open Requests (with the 1%-minimum edge case explained in place), per-share figures throughout My Positions, a claim banner for undelivered shares and a reclaim card for dead pools, per-share settlement receipts and PDF statements driven by the `ShareDistributed` event, borrower-side funding progress, and a borrower Cancel control.
- **157/157 frontend unit tests**, including `lib/share-math.test.ts` covering share summing, viewer filtering, and pending-share detection.

### Auth, KYC, infrastructure

- Supabase auth (login/signup + forgot-password), server + client helpers.
- KYC routes `/api/kyc/{session,status,webhook,demo-approve}`, Didit integration with `ALLOW_DEMO_KYC=1` dev bypass.
- `useCompliance` hook: `canBorrow = hasVerifiedWallet && kycApproved`, plus role gates.
- Onboarding: Account -> Role -> Wallet -> KYC -> Ready.
- `wagmi-config.ts` - 5 connectors, Sepolia + local (31337).
- `lib/loan-terms.ts` - tier -> term mapping.
- `settings/page.tsx` - wallet list, link wallet, KYC badge, role picker, statements, sign out.
- Supabase is the sole off-chain DB (Prisma/SQLite removed).

### Extra features present in code, not tracked in PLAN.md

- **Blockchain news feed** - `/api/news` + `BlockchainNews.tsx` (categorised crypto news).
- **Market pulse bar** - `/api/market-pulse` + `MarketPulseBar.tsx` (fear/greed-style sentiment).
- **Wallet screening / mock KYT** - `lib/wallet-screening.ts` (deterministic demo risk score, flagged as mock, replace with real KYT before production).
- **Live ETH/USD price ticker** - `PriceTicker.tsx`, `useTokenPrices`, `/api/prices`.

## Persisted off-chain data (Supabase migrations)

| Migration | Purpose |
|---|---|
| `001_init.sql` | base schema |
| `002_rls_and_user_role.sql` / `002_user_role.sql` | RLS + user role |
| `003_loan_risk_assessments.sql` | borrower risk breakdown keyed by loan contract address, immutable |
| `004_event_price_snapshots.sql` | per-event ETH/USD price snapshots for fiat statement columns |
| `005_public_profiles_view.sql` | non-PII `public_profiles` view for the directory, `authenticated`-only access |

> Migrations 003 and 004 must be run manually in the Supabase SQL editor or their features degrade silently by design.
> Migration 005 must be run at its final version (includes `REVOKE ALL ... FROM anon, PUBLIC`); an earlier applied version left the view readable by `anon`.

## Verified end-to-end

Manual testing complete (2026-07-26 to 29): two people, real wallets, live Sepolia, nine loans across the full lifecycle.
All five tracks passed - repayment, deadline/grace/liquidation, two-user visibility, price-crash liquidation, and partial-liquidation fairness - verified against on-chain state, not UI impressions.

## Known limitations (see `planv2.md` for the plan)

Phase 1 (bug fixes and correctness) is done as of 2026-08-02.
Every row below is closed or explicitly deferred with a reason; see the item for detail.

- **BUG-VIS** - closed.
Root cause diagnosed: React Query pauses polling for a backgrounded tab by default, and checking cross-account visibility inherently means one browser window is backgrounded relative to the other.
`app/providers.tsx` already forces `refetchIntervalInBackground: true`, `refetchOnWindowFocus: true`, `staleTime: 0` (the "polling fix" mentioned previously); this is now the diagnosed reason for that fix, not just an empirical patch.
Guarded by `lib/query-defaults.test.ts` so the config can't silently regress.
- **B1** - closed.
Root cause: real-wallet scoring depends entirely on the optional FastAPI credit-scoring backend (`backend/`), which is not deployed alongside the app (`CREDIT_BACKEND_URL` defaults to `localhost:8000` and is unconfigured everywhere) - so for any real visitor on the live deployment, wallet-mode scoring failed 100% of the time while persona mode (fully client-side) always worked.
Fixed the degrade path: the wallet wizard now clearly explains the service is unavailable and offers a one-click switch to demo/persona mode instead of leaving the user stuck; see `components/LoanRequestPanel.tsx`.
Deploying the backend itself remains Phase 6 scope.
- **B2** - closed.
`ethChange24h` in `app/app/page.tsx` looked up `marketData['ethereum']`, but the API keys `marketData` by symbol (`'ETH'`), so the 24h change never rendered and the widget looked static even though the price itself refetches every 30s.
Final merged state (2026-08-03): a teammate independently built a dedicated `EthPriceTicker.tsx` component (directional flash colors, staleness counter); the merge kept their component and ported the `'ETH'` key fix into it, since their version had the same broken lookup.
- **B3** - closed.
`RiskExplanationPanel.tsx` restyled to the app's dark theme; the `bg-white` wrapper in `LoanRequestPanel.tsx` that was forcing it light has been removed too.
Phase 2 (peer discovery) is code-complete and pushed as of 2026-08-20; see the "Peer discovery" section above.

- Liquidation is not automatic (a contributor must click; no keeper/bot) - deferred to Phase 4.
- **Multi-lender pooling - closed 2026-08-21.**
Shipped as Phase 3; see the section above. Track G manual verification remains open.
- **IPFS-anchored term sheets and SHAP/versioned ML - closed 2026-08-21.**
Shipped as Phase 6; see the section above.
No on-chain event indexer/dashboards - still deferred to Phase 5.
- **Peer discovery - closed 2026-08-20** (was "users find each other by loan ID").
Directory search and public profile pages shipped as Phase 2; only Track F manual browser verification remains open.
- **BUG-03** - documented, not fixed.
`interestDue()` already uses a single end-of-period `mulDiv` (maximum precision available in wei-integer accounting); for a small enough principal/duration product the true interest is under 1 wei and floor-divides to 0.
Accepted MVP limitation, documented in `contracts/contracts/Loan.sol`; a real fix would need a fixed-point interest unit, out of scope for this phase.
- **BUG-11** - closed, was already fixed.
Loan ID/contract are decoded from this transaction's own `LoanCreated` receipt log (`lib/decode-loan-created.ts`), never inferred from a global counter, so simultaneous creation by different accounts cannot race.
Extracted into a tested helper (`lib/decode-loan-created.test.ts`); report/plan text just hadn't caught up to the existing fix.
- **BUG-14** - closed.
`liquidationBufferBps` is now shown on the lender's "Completed" (settled positions) card in `components/LenderDashboard.tsx`, which previously omitted it even though the active-positions view already had it via `LoanSafetyPanel`.
