# NexusFi P2P Lending Platform — Implementation Plan

> Last updated: 2026-07-25
> Team: K.J. Somaiya School of Engineering final-year project (Afan Khan, Atharva Patil, Viren Rathod, Siddharth Singh). Stack: Next.js 16 + React 19 + wagmi v2 + viem + Solidity 0.8.28 + Hardhat 3 (Ignition) + Supabase + Tailwind v4. Optional FastAPI credit-scoring backend.
> Official reference docs (in `docs/archive/` unless noted): the literature review (`Literature Review_ P2P Blockchain Lending Platform`), the K.J. Somaiya project brief (`Blockchain_P2P_Lending_Platform.md`), and the borrower/lender user-journey spec. This file is the **living, code-accurate** status tracker — read it before the academic docs, since those describe intent and this describes what actually runs.

---

## What NexusFi is (one paragraph)

Borrowers lock ETH collateral on-chain and request a loan; an explainable risk engine (rule-based now, optional real ML backend) assigns a tier that deterministically sets max LTV / interest spread / liquidation buffer; the borrower signs an EIP-712 term sheet; lenders browse open requests and fund directly, wallet-to-wallet, with the smart contract as escrow/enforcer; repayment and liquidation settle automatically on-chain. KYC/auth/off-chain metadata live in Supabase. Currently deployed and working end-to-end on **Sepolia testnet**.

---

## How the official docs compare to the actual build

The literature review and project brief describe an ambitious target architecture (SHAP-based ML with model versioning/MLOps, IPFS-anchored term sheets, an on-chain event indexer with dashboards, oracle-driven automatic liquidation with a delinquency state machine, decentralized identity). The **live MVP is a deliberately smaller, honest subset** of that vision. This is fine for a milestone/demo but worth tracking explicitly so the report doesn't overclaim:

| Spec'd in official docs | Actual state |
|---|---|
| ML risk tiering (gradient-boosted + SHAP) | ✅ Rule-based explainable scorer (`lib/risk-explainer.ts`, `scoreFeatureVector`) live and wired. A real FastAPI model (`backend/`, has a trained `credit_model.pkl`) exists and is called via `/api/credit/score` **with graceful fallback** to the rule-based scorer if the backend is down. Not SHAP/versioned/MLOps-governed yet — that's real, but scoped down. |
| Risk tier → deterministic loan terms (max LTV / spread / liquidation buffer) | ✅ Implemented exactly as spec'd (Tier A/B/C mapping in `lib/loan-terms.ts`). |
| EIP-712 signed term sheet before loan creation | ✅ Implemented. |
| IPFS-anchored term sheets, hash-only PII references | ❌ Not built. Term sheets aren't persisted to IPFS; off-chain metadata lives in Supabase only. |
| On-chain event indexer + dashboards (default rate, liquidation count, avg APR, ML score distribution) | ❌ Not built. Current UI reads live via wagmi multicall on page load/refresh, not an indexer. Works fine at demo scale, won't scale to many loans. |
| Oracle-driven automatic liquidation with delinquency state machine (Delinquent → Default → Liquidated, buffer period, partial liquidation) | ❌ **Biggest gap.** Today `Loan.sol` only has a bare `markLiquidatedForDemo()` — the lender can seize collateral any time after funding, with zero price check, zero deadline check, zero delinquency logic. This is the current focus (see "Next Action" below). |
| Repayment deadline enforcement | ❌ Not built — `repay()` never checks time elapsed since funding. |
| Partial repayments | ❌ Not built — `repay()` is all-or-nothing (must send full `totalRepaymentDue` in one tx). |
| Funding deadline (`requestedAt + 7 days`) | ✅ **Actually already implemented** — `Loan.sol` has `FUNDING_WINDOW = 7 days` enforced inside `fund()`. Earlier versions of this doc incorrectly listed this as missing; verified in code 2026-07-25. |
| Multi-lender pooling (partial fills across several lenders) | ❌ Not built (single lender funds 100% in one tx). The lender-journey doc explicitly calls this "still MVP-feasible" as an alternative, not a stretch goal — **now tracked in scope**, see Backlog. |
| Decentralized identity / on-chain KYC | 🟡 Partial — off-chain KYC (Didit + Supabase) bound to wallet address via linked-wallet signature verification. `KYCRegistry.sol` exists as an on-chain reference contract but is intentionally unused in the live flow (documented in the project brief as a "M1 reference," not accidental cruft — left in place). |
| Privacy-by-design (PII off-chain, encrypted) | ✅ Conceptually aligned — Supabase holds PII, service-role key required, no PII on-chain — though without the IPFS/hash-anchoring layer the official docs describe. |

**Bottom line:** the demo's happy path (create → fund → repay/liquidate) is real and works on Sepolia. The gap between "what the report describes" and "what runs" is concentrated almost entirely in **risk enforcement over time** — deadlines, partial payment, and real liquidation logic — which is exactly what's next.

---

## ✅ Confirmed working end-to-end on Sepolia (verified 2026-07-25)

The full loan lifecycle loop has been run and confirmed:

```
Borrower creates loan (locks ETH collateral in CollateralVault)
        │
        ▼
Lender funds loan  →  borrower receives principal ETH INSTANTLY
        │              (fund() forwards msg.value to borrower in the same tx —
        │               no separate settlement step, no pending state)
        ▼
   ┌────┴─────────────────────────────┐
   │                                   │
Borrower repays               Lender clicks "Liquidate (demo)"
→ lender receives principal   → lender receives the locked collateral
  + interest INSTANTLY          (no price/deadline check — demo-only button)
→ borrower's collateral
  released back to them
```

Every step (create, fund, repay, cancel, liquidate, set mock price) emits a transaction and the UI shows a live `sepolia.etherscan.io/tx/{hash}` link. Deployed contracts:

- LoanFactory: `0xD4cfc809B885e7c197d3cA6878746881c78d2cE5`
- CollateralVault: `0x99Cb30A1e862f817b7702432f3B409825Ed5cA09`
- MockPriceFeed: `0xC6faac19a11B7057AD42ce69429717f6AA7CEb3a`

All three are populated in `frontend/.env.local`.

---

## Architecture Overview

```
Layer 1 (Inputs)     → Synthetic borrower personas (Alice/Charlie/Bob) + real wallet feature extraction
Layer 2 (Risk)       → Rule-based explainable scoring engine → Tier A / B / C
                         ↕ optional real ML backend (FastAPI + trained model) with fallback
Layer 3 (Execution)  → Smart contracts on Sepolia testnet: CollateralVault + LoanFactory + Loan
Layer 4 (UI)         → app/app/page.tsx dashboard: role toggle, LoanRequestPanel (borrower),
                         LenderDashboard, BorrowerLoansSection
```

**Note:** the borrower/lender workspace described in earlier versions of this doc as living directly in `app/page.tsx` has since been refactored — `app/page.tsx` is now just the marketing landing page, and the real logic lives in `app/app/page.tsx` + `components/LoanRequestPanel.tsx` + `components/LenderDashboard.tsx` + `components/BorrowerLoansSection.tsx`.

---

## ✅ DONE

### Smart Contracts

- ✅ `Loan.sol` — ETH-collateral loan with `fund()`, `repay()`, `cancel()`, `markLiquidatedForDemo()`, `totalRepaymentDue()`, `interestDue()`, and a `FUNDING_WINDOW` (7-day) deadline on `fund()`. Interest formula: `principal × interestBps × durationDays ÷ (10_000 × 365)`.
- ✅ `LoanFactory.sol` — creates and tracks all loans; emits `LoanCreated`.
- ✅ `CollateralVault.sol` — holds ETH collateral; `lockCollateral()`, `releaseCollateral()`, `liquidateCollateral()`.
- ✅ `MockPriceFeed.sol` — owner calls `setPrice(uint256)` to simulate an ETH price crash → drives the LTV health bar in the UI.
- ✅ `MockERC20.sol` — mintable ERC-20 test token, deployed but not yet wired as a loan principal asset (Phase 2 — see Backlog).
- ✅ `KYCRegistry.sol` — on-chain KYC whitelist contract, kept as a documented M1 reference; not used by the live flow (KYC is enforced off-chain via Supabase + Didit).
- ✅ Hardhat Ignition module `NexusFiMilestone1.ts` — deploys CollateralVault + LoanFactory + MockPriceFeed and wires them together in one shot.
- ✅ Hardhat config — `localhost` (31337) and `sepolia` (11155111) networks.
- ✅ Contracts compile cleanly against solc 0.8.28 (re-verified 2026-07-25 after cruft removal — see Repo Cleanup Log).

### Frontend — Borrower

- ✅ Layer 1 personas (`frontend/lib/borrower-personas.ts`) + real feature extraction (`lib/feature-extractor.ts`).
- ✅ Layer 2 explainable scorer (`lib/risk-explainer.ts`, `scoreFeatureVector`), `FEATURE_WEIGHTS`, `TIER_THRESHOLDS`, wired through `/api/risk/score` and `/api/credit/score` (with fallback).
- ✅ `RiskExplanationPanel.tsx` — weight breakdown, tier bar, formula, threshold table.
- ✅ `LoanRequestPanel.tsx` — full wizard: choose mode → persona/wallet evaluation → loan config → review & submit → post-submission lifecycle explainer. Calls `LoanFactory.createLoan()` via wagmi.
- ✅ EIP-712 typed term-sheet signing before loan creation.
- ✅ `BorrowerLoansSection.tsx` — borrower's own loans read live from `LoanFactory`, with cancel/repay actions and status.
- ✅ Live LTV health monitor (green/amber/red) with current LTV%, max LTV marker, liquidation threshold marker.
- ✅ Etherscan tx links after every on-chain action.

### Frontend — Lender

- ✅ Role toggle (Borrower/Lender) in `app/app/page.tsx`, gated by `canLend`/`userRole`.
- ✅ `LenderDashboard.tsx` — reads all `loanIds` from `LoanFactory` via multicall, "Open Requests" tab (fundable loans) + "My Positions" tab (funded loans, LTV bar, liquidate button).
- ✅ `fund()` wired with exact-principal payable call.
- ✅ Mock ETH/USD oracle panel — lender can crash price via `MockPriceFeed.setPrice()` to demo an LTV breach.
- ✅ "Liquidate (demo)" button → `markLiquidatedForDemo()` (no price/deadline gate — see Next Action).
- ✅ Etherscan tx links after every on-chain action.

### Auth, KYC, Infrastructure

- ✅ Supabase auth (login/signup), server + client helpers.
- ✅ KYC API routes: `/api/kyc/session`, `/api/kyc/status`, `/api/kyc/webhook`, `/api/kyc/demo-approve`. Didit integration (`lib/didit.ts`) with `ALLOW_DEMO_KYC=1` dev bypass.
- ✅ `useCompliance` hook — `canBorrow = hasVerifiedWallet && kycApproved`, plus `userRole`, `hasRole`, `canLend`.
- ✅ Onboarding: 5 steps (Account → Role → Wallet → KYC → Ready), role saved via `PATCH /api/profile`.
- ✅ `NetworkModeToggle`-equivalent network switching, live ETH/USD `PriceTicker`.
- ✅ `wagmi-config.ts` — 5 wallet connectors, multi-chain (31337 + Sepolia).
- ✅ `lib/loan-terms.ts` — `RISK_TIER_CONFIG`, `BASE_APR`, `calculateProtocolLoanTerms()`.
- ✅ `settings/page.tsx` — wallet list, link new wallet, KYC badge, role picker, sign out.
- ✅ Supabase is the sole off-chain DB (Prisma/SQLite fully removed).

---

## 🐛 Known Bugs

| ID | Severity | Description | Status |
|---|---|---|---|
| BUG-VIS | HIGH | **Loans aren't always visible between two different user accounts/wallets** — a loan created by one user has sometimes not reliably shown up for another user browsing the lender marketplace. Root cause not yet diagnosed (suspect: multicall read timing, wrong network mode, or a stale loanIds cache). | Deprioritized for now, revisit after liquidation work — noted here so it isn't forgotten. |
| BUG-01 | CRITICAL | Lender can liquidate immediately via `markLiquidatedForDemo()` — no price/deadline check. | **This is exactly what the Next Action below fixes.** |
| BUG-03 | HIGH | Interest rounds to 0 for tiny loans (< ~3650 wei). | Low impact — use realistic loan amounts (≥ 0.01 ETH) during demo. |
| BUG-11 | MEDIUM | Loan ID inference race condition if two loans are created simultaneously. | Not yet fixed. |
| BUG-14 | MEDIUM | `liquidationBufferBps` missing from some lender-facing views. | Visual gap only. |

---

## 🚨 NEXT ACTION (single focus): Liquidation & delinquency logic

This is the one thing being worked on next. Everything else below is backlog, not in progress.

**Problem:** `Loan.sol` currently has no concept of time-based risk after funding. `repay()` accepts payment any time, in full only. `markLiquidatedForDemo()` lets the lender seize collateral at any moment for any reason. None of this reflects the actual lending risk the rest of the platform (tiers, LTV, liquidation buffer) is built around.

**Scope of this task:**
1. **Repayment deadline enforcement** — track `durationDays` from `fundedAt`; once the due date passes without full repayment, the loan should be flagged delinquent rather than silently staying `Funded` forever.
2. **Partial repayment support** — `repay()` is currently all-or-nothing. Add a running `amountRepaid` (or similar) so a borrower can pay down principal/interest incrementally instead of needing the full `totalRepaymentDue` in one transaction.
3. **Interest/penalty on overdue balances** — once past the repayment deadline, interest (or a late-fee penalty rate) should keep accruing on the outstanding balance until it's paid or the loan is liquidated.
4. **Real liquidation eligibility on the lender side** — replace (or gate) `markLiquidatedForDemo()` so liquidation is only callable once a real condition is met: repayment deadline passed (delinquency) **or** oracle price crash breaching the liquidation threshold (this half already has UI support via `MockPriceFeed` — needs to be read by the contract, not just the frontend).

**Out of scope for this task** (tracked separately below): multi-lender pooling, lender risk-tier badges, deployment/user search, Etherscan verification, and any other polish.

---

## 📋 Backlog (not started, ordered roughly by value)

### In scope for the project (confirmed by official docs)

- **Multi-lender pooling** — the lender-journey doc explicitly describes partial fills across multiple lenders as "still MVP-feasible," not just a stretch goal. Needs: a contribution mapping per loan, a funding-closes-when-full condition, and pro-rata repayment distribution. ~1 day of contract + frontend work. Tracked in scope, not started.
- **Deployment for team testing + peer discovery** — currently the app only runs on `localhost:3000` for whoever is running `npm run dev`. To let teammates test against the same live Sepolia contracts independently:
  - Deploy the frontend somewhere reachable (e.g. Vercel) instead of only local dev.
  - Add a lightweight way for users to find/identify each other on the platform (e.g. a searchable directory of verified users by display name or linked wallet address) so teammates testing together can coordinate borrower/lender pairs instead of guessing loan IDs blind.
  - Not the current focus — parked here as the next thing after liquidation is done.

### Kept intentionally low priority (explicitly requested to stay "at bay")

- **Lender loan cards don't show borrower risk tier** — lenders currently see amount/collateral but not the tier (A/B/C) that produced the terms. ~1hr of work, high visual value, but deliberately not prioritized right now.

### Optional polish

- Contracts verified on Sepolia Etherscan (`--verify` flag).
- Network-switch prompt when MetaMask is on the wrong chain.
- Loan filter/sort in the marketplace (by status, tier, APR).
- Real `extract_features(wallet_address)` pipeline reading live from Alchemy/Etherscan (Phase 2).
- Events indexer + dashboards (default rate, liquidation count, avg APR, ML score distribution) as described in the official docs — currently reads live via multicall instead.
- IPFS-anchored term sheets (currently EIP-712 signature only, no IPFS persistence).
- MockERC20 wired as an alternative loan principal asset instead of native ETH only.

---

## Bugs Fixed Historically (kept for record)

| Bug | Original claim | Actual state |
|---|---|---|
| BUG-02 | `canBorrow: true` hardcoded | Fixed — `canBorrow: hasVerifiedWallet && kycApproved` |
| BUG-04 | Hardcoded localhost RPC URL | Fixed — uses env var |
| BUG-07 | `.toFixed(18)` float noise | Fixed — uses `.toFixed(6)` |
| BUG-08 | No funding deadline | **Correction (2026-07-25): this was already fixed** — `FUNDING_WINDOW = 7 days` is enforced in `Loan.sol::fund()`. Earlier plan versions listed this as outstanding in error. |
| BUG-10 | `>= 1` returns Tier A (wrong) | Fixed — correctly returns Tier B |

---

## Repo Cleanup Log (2026-07-25)

- Removed `backend/venv/` (179MB, ~5,850 files) from git tracking — it's a rebuildable Python virtualenv that should never have been committed. Deleted the duplicate `backend/env/` virtualenv from disk entirely. Added `venv/`, `env/`, `*.tsbuildinfo`, `artifacts/`, `cache/` to `.gitignore`.
- Archived superseded/one-off docs into `docs/archive/`: `BUGS.md`, `CODEBASE.md`, `PROJECT_WORKFLOW.md`, `NexusFi_V2_Implementation_Plan.md`, `Blockchain_P2P_Lending_Platform.md`, `CREDIT_SCORING.md`, `skills-reference.md`. This file (`PLAN.md`) remains the single live reference at the repo root.
- Removed empty `work.md` and stray `.DS_Store` files.
- Removed dead Hardhat scaffold/template code: `Counter.sol`, `Counter.t.sol`, `test/Counter.ts`, `ignition/modules/Counter.ts` (never-touched default Hardhat sample contract), and a duplicate nested `contracts/contracts/ignition/` + `contracts/contracts/scripts/` directory referencing a dead early prototype contract (`NexusFiVault.sol`, superseded by the real `Loan.sol`/`LoanFactory.sol`/`CollateralVault.sol` design). Verified `npx hardhat compile` still succeeds (6 Solidity files) after removal.
- Removed dead frontend code, confirmed via repo-wide grep to have zero import sites: `hooks/useBorrowerRisk.ts`, `lib/borrower-risk.ts` + its test, `lib/abis.ts` (its only consumer, `LenderDashboard`/`LoanRequestPanel`/`BorrowerLoansSection`, each define their own local ABI constants instead), `components/TermTransparencyPanel.tsx`, `components/PersonaSelector.tsx`, `components/WalletIcons.tsx`, `components/NetworkModeToggle.tsx`. These were superseded when the borrower/lender workspace was refactored out of the old `app/page.tsx` into `app/app/page.tsx` + `LoanRequestPanel`/`LenderDashboard`/`BorrowerLoansSection`. Verified `tsc --noEmit` and `npm run build` both pass after removal.
- Not touched (documented-but-unused, not junk): `KYCRegistry.sol` and `MockERC20.sol` — both are intentional forward-looking / reference artifacts per the official project docs, not accidental cruft.

---

## Key File Reference

| File | Purpose |
|------|---------|
| `contracts/contracts/Loan.sol` | Core loan lifecycle |
| `contracts/contracts/LoanFactory.sol` | Loan creation + registry |
| `contracts/contracts/CollateralVault.sol` | ETH collateral custody |
| `contracts/contracts/MockPriceFeed.sol` | Oracle simulation for liquidation demo |
| `contracts/contracts/MockERC20.sol` | Test USDC token (not wired yet) |
| `contracts/contracts/KYCRegistry.sol` | On-chain KYC reference (unused in live flow) |
| `contracts/ignition/modules/NexusFiMilestone1.ts` | One-shot Sepolia deploy script |
| `contracts/.env` | RPC URL + private key for deployer wallet |
| `frontend/lib/borrower-personas.ts` | Layer 1 — synthetic profiles (Alice/Charlie/Bob) |
| `frontend/lib/feature-extractor.ts` | Real wallet feature extraction |
| `frontend/lib/risk-explainer.ts` | Layer 2 — explainable scoring engine |
| `frontend/lib/loan-terms.ts` | Tier → loan term mapping |
| `frontend/components/RiskExplanationPanel.tsx` | XAI transparency UI |
| `frontend/components/LoanRequestPanel.tsx` | Borrower loan creation wizard |
| `frontend/components/LenderDashboard.tsx` | Lender marketplace + funding + liquidation |
| `frontend/components/BorrowerLoansSection.tsx` | Borrower's own loans view |
| `frontend/app/app/page.tsx` | Main dashboard shell (role toggle, layout) |
| `frontend/app/page.tsx` | Marketing landing page only (not the workspace) |
| `frontend/app/wagmi-config.ts` | Wagmi chain config (5 connectors, Sepolia + local) |
| `frontend/hooks/useCompliance.ts` | KYC + wallet verification gate |
| `frontend/.env.local` | All frontend env vars (Supabase, RPC, contract addresses) |
| `backend/` | Optional FastAPI credit-scoring service, called with fallback |
| `docs/archive/` | Superseded docs + academic literature review, kept for reference |
