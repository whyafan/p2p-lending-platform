# NexusFi P2P Lending Platform - Implementation Report

> Generated 2026-07-29 from the live codebase and PLAN.md; last updated 2026-08-20 after Phase 2 (peer discovery) shipped.
> This is a status snapshot of what actually runs, not a spec of intent.
> For the phased plan of remaining work see `planv2.md`; for the reasoning behind the design see `projectknowledge.md`.

## One-paragraph summary

Borrowers lock ETH collateral on-chain and request a loan.
An explainable rule-based risk engine (with an optional real ML backend and graceful fallback) assigns a Tier A/B/C that deterministically sets max LTV, interest spread, and liquidation buffer.
The borrower signs an EIP-712 term sheet, lenders browse open requests and fund wallet-to-wallet, and the smart contract acts as escrow and enforcer.
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

- **Loan.sol** - core lifecycle. `fund()` with a 7-day funding window, `repay()` accepting any partial or full amount against a live `outstandingBalance()`, `cancel()`, and `liquidate()` gated on a real deadline + 2-day grace period **or** an oracle-priced LTV breach.
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
- **28/28 contract tests passing** (`NexusFiMilestone1.ts` + `LoanLifecycle.ts`) covering partial/full repayment, overpayment refunds, interest accrual and capping, both liquidation triggers, and partial-liquidation fairness.

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

- Liquidation is not automatic (lender must click; no keeper/bot) - deferred to Phase 4.
- Single-lender funding only (no multi-lender pooling) - deferred to Phase 3.
- No IPFS-anchored term sheets, no on-chain event indexer/dashboards, no SHAP/versioned ML - deferred to Phase 5/6.
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
