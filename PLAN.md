# NexusFi P2P Lending Platform — Implementation Plan

> Last updated: 2026-07-29 — manual testing complete; transparency is the new baseline
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
| Oracle-driven automatic liquidation with delinquency state machine (Delinquent → Default → Liquidated, buffer period, partial liquidation) | 🟡 **Both triggers + partial liquidation done (2026-07-26).** `liquidate()` fires on either a missed deadline + 2-day grace period **or** an oracle-priced LTV breach, and seizes only the outstanding debt, refunding the surplus. Still missing: **automatic** execution (no keeper/liquidator-bot incentive — the lender must call it) and explicit named `Delinquent`/`Default` enum states, currently derived from views rather than stored. |
| Repayment deadline enforcement | ✅ **Done (2026-07-25).** `repaymentDueAt()` derives a fixed deadline from `fundedAt + durationDays`; `isDelinquent()`/`isLiquidatable()` expose the real-time state to the UI. |
| Partial repayments | ✅ **Done (2026-07-25).** `repay()` accepts any amount > 0, tracked via `amountRepaid`; the loan only closes once the full live `outstandingBalance()` is covered. Borrower UI has a repay control (custom amount or "Repay in full") in `BorrowerLoansSection.tsx`. |
| Overdue interest accrual | ✅ **Done (2026-07-25).** Interest now accrues continuously from `fundedAt` (not just over the fixed `durationDays` term) and keeps growing past the deadline — but is capped at `repaymentDueAt() + GRACE_PERIOD` so it doesn't inflate forever once a loan is liquidatable. |
| Funding deadline (`requestedAt + 7 days`) | ✅ **Actually already implemented** — `Loan.sol` has `FUNDING_WINDOW = 7 days` enforced inside `fund()`. Earlier versions of this doc incorrectly listed this as missing; verified in code 2026-07-25. |
| Multi-lender pooling (partial fills across several lenders) | ❌ Not built (single lender funds 100% in one tx). The lender-journey doc explicitly calls this "still MVP-feasible" as an alternative, not a stretch goal — **now tracked in scope**, see Backlog. |
| Decentralized identity / on-chain KYC | 🟡 Partial — off-chain KYC (Didit + Supabase) bound to wallet address via linked-wallet signature verification. `KYCRegistry.sol` exists as an on-chain reference contract but is intentionally unused in the live flow (documented in the project brief as a "M1 reference," not accidental cruft — left in place). |
| Privacy-by-design (PII off-chain, encrypted) | ✅ Conceptually aligned — Supabase holds PII, service-role key required, no PII on-chain — though without the IPFS/hash-anchoring layer the official docs describe. |

**How the oracle price trigger works (added 2026-07-26).** The original problem: `principalAmount` and `collateralAmount` are both ETH, so `principal/collateral` is a constant ratio that an ETH price move cannot change — the old LTV bar recomputed both legs at the current price, which is mathematically a no-op and could never signal real risk.

The fix is to **freeze the debt in USD at funding** while continuing to value collateral live:

```
debtValueUsd    = principalAmount x price AT FUNDING   (fixed)
collateralValue = collateralAmount x price NOW         (floats)
LTV             = debtValueUsd / collateralValueUsd
liquidatable    when LTV >= maxLtvBps + liquidationBufferBps
```

This reproduces the project brief's own worked example exactly: $1,400 borrowed against $2,000 of collateral at 70% max LTV / 80% threshold becomes liquidatable once the collateral falls to $1,750. Concretely, in the test fixture 1 ETH borrowed against 2 ETH at $2,000 sits at 50% LTV and becomes liquidatable when ETH hits $1,250.

**Deliberate simplification:** settlement stays ETH-denominated — `repay()` still owes principal + interest in ETH, and a price move does **not** restate what the borrower owes (there's a test asserting this). The USD figure exists solely to measure the *lender's* exposure and gate liquidation. A fully USD-denominated loan would make the repayment amount float with price on every block; that's a bigger change and worse UX for a demo. **Fail-safe:** if the oracle is missing, reverting, or returns 0, `currentLtvBps()` returns 0 meaning *unknown* (not "healthy") and price liquidation is disabled — bad oracle data can never seize someone's collateral.

**Bottom line:** the demo's happy path (create → fund → repay/liquidate) works on Sepolia, and both liquidation triggers — delinquency and collateral shortfall — are now live end-to-end from contract to UI. The remaining gaps versus the report are multi-lender pooling, automatic (keeper/bot-driven) liquidation, and the observability/IPFS layer in the backlog below.

---

## ✅ Confirmed working end-to-end on Sepolia (contract-level, verified 2026-07-26)

The full loan lifecycle loop, including the new deadline/delinquency logic, has been run and confirmed:

```
Borrower creates loan (locks ETH collateral in CollateralVault)
        │
        ▼
Lender funds loan  →  borrower receives principal ETH INSTANTLY
        │              (fund() forwards msg.value to borrower in the same tx —
        │               no separate settlement step, no pending state).
        │              repaymentDueAt() = fundedAt + durationDays is now fixed.
        ▼
   ┌────┴──────────────────────────────────────────────────┐
   │                                                        │
Borrower repays (partial or in full, any                Repayment deadline + 2-day
number of installments) → each payment                  grace period passes with an
forwarded to lender INSTANTLY → once the                unpaid balance → lender calls
live outstandingBalance() hits zero, loan                liquidate() → collateral moves
closes and collateral releases to borrower               to the lender. Blocked entirely
                                                          before the grace period ends,
                                                          and impossible once Repaid.
```

Every step (create, fund, repay — partial or full, cancel, liquidate, set mock price) emits a transaction and the UI shows a live `sepolia.etherscan.io/tx/{hash}` link. Contract-level correctness (partial repayment sequences, overpayment refunds, interest accrual matching the fixed-duration formula at the deadline boundary and staying flat past the liquidation cap, liquidate() reverting/succeeding at the right times) is covered by 10 new tests in `contracts/test/LoanLifecycle.ts`, all passing alongside the original `NexusFiMilestone1.ts` suite (12/12 total). Full manual click-through of the redeployed contracts via the live UI has not yet been done in this session — only the automated test suite and the deploy transaction itself have been verified.

Deployed contracts (redeployed 2026-07-26, twice — first for the price feed, then for the demo controls; earlier addresses are abandoned):

- LoanFactory: `0x4dDB469155A8824FDCa64d2e706aFE6380C55fAd`
- CollateralVault: `0xeB137a592E5623D2750CEcf4Ad8421E2aA8FDf16`
- MockPriceFeed: `0x5094c61F27B8b7538eeC330f9Ec013277E590a7c`

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

- ✅ `Loan.sol` — ETH-collateral loan with `fund()` (7-day `FUNDING_WINDOW` deadline), `repay()` (partial or full payments against a live `outstandingBalance()`), `cancel()`, `liquidate()` (real deadline + 2-day `GRACE_PERIOD` gate, replacing the old unconditional `markLiquidatedForDemo()`). Interest accrues continuously from `fundedAt` via `interestDue()`, capped once the loan becomes liquidatable; `totalRepaymentDue()`, `outstandingBalance()`, `repaymentDueAt()`, `isDelinquent()`, `isLiquidatable()`, `amountRepaid` expose the live state. See `contracts/test/LoanLifecycle.ts` for the full behavior spec.
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
- ✅ `BorrowerLoansSection.tsx` — borrower's own loans read live from `LoanFactory`, with status, a live outstanding-balance readout, repayment due date, a "past due" badge, and a repay control (custom amount, or "Repay in full" which safely overpays by a small buffer and relies on the contract's refund logic — see below).
- ✅ Live LTV health monitor (green/amber/red) with current LTV%, max LTV marker, liquidation threshold marker.
- ✅ Etherscan tx links after every on-chain action.

### Frontend — Lender

- ✅ Role toggle (Borrower/Lender) in `app/app/page.tsx`, gated by `canLend`/`userRole`.
- ✅ `LenderDashboard.tsx` — reads all `loanIds` from `LoanFactory` via multicall, "Open Requests" tab (fundable loans) + "My Positions" tab (funded loans, LTV bar, liquidate button).
- ✅ `fund()` wired with exact-principal payable call.
- ✅ Mock ETH/USD oracle panel — lender can crash price via `MockPriceFeed.setPrice()`; the LTV bar still updates, but note the ETH/ETH LTV caveat above — this doesn't currently drive real liquidation eligibility.
- ✅ "Liquidate" button → `liquidate()`, gated on-chain by `isLiquidatable()` (deadline + grace period); disabled with a live countdown until the borrower is actually delinquent, and a "LIQUIDATABLE" badge when eligible.
- ✅ Etherscan tx links after every on-chain action.
- ✅ `frontend/lib/loan-abi.ts` — shared `Loan`/`LoanFactory` ABI, replacing three independently hand-copied local ABI arrays that had already gone stale once (this was the root cause of `markLiquidatedForDemo` living on in two places after the contract changed).

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
| BUG-VIS | HIGH | **Loans aren't always visible between two different user accounts/wallets** — a loan created by one user has sometimes not reliably shown up for another user browsing the lender marketplace. Root cause not yet diagnosed (suspect: multicall read timing, wrong network mode, or a stale loanIds cache). | Still open — deprioritized during the liquidation work, revisit next. Noted here so it isn't forgotten. |
| BUG-01 | ~~CRITICAL~~ | ~~Lender can liquidate immediately via `markLiquidatedForDemo()` — no price/deadline check.~~ | **Fixed 2026-07-25** — replaced by `liquidate()`, gated on a real deadline + grace-period check. |
| BUG-03 | HIGH | Interest rounds to 0 for tiny loans (< ~3650 wei). | Low impact — use realistic loan amounts (≥ 0.01 ETH) during demo. |
| BUG-11 | MEDIUM | Loan ID inference race condition if two loans are created simultaneously. | Not yet fixed. |
| BUG-14 | MEDIUM | `liquidationBufferBps` missing from some lender-facing views. | Visual gap only. |

---

## ✅ Recently completed (2026-07-25 → 26)

Four things landed back to back. All are live on Sepolia and deployed to every branch URL.

1. **Repayment deadlines, partial repayment, overdue interest, real liquidation** (25th) — `repaymentDueAt()` from `fundedAt + durationDays`; `repay()` takes any amount with `amountRepaid` tracking; interest accrues continuously and is capped once liquidatable; `markLiquidatedForDemo()` replaced by a properly gated `liquidate()`. Borrower repay UI built from scratch; lender liquidate button really gated with a countdown.
2. **Oracle price-crash liquidation** (26th) — debt frozen in USD at funding vs. live collateral value, so an ETH crash actually raises LTV. `liquidate()` now fires on *either* delinquency or collateral shortfall. LTV bar reads `currentLtvBps()` from the contract instead of the old price-independent client math.
3. **Deployment** (26th) — Vercel, git-connected, per-branch URLs, auto-deploy via GitHub Actions (see Deployment section).
4. **Demo controls** (26th) — `/demo` route to force both triggers on demand (see Demo controls section).

**24/24 contract tests passing.** `tsc --noEmit` and `next build` clean.

---

## ✅ Manual testing COMPLETE (2026-07-26 → 29)

Two people, real wallets, live Sepolia. **All tracks passed.** Verified against on-chain state, not UI impressions — nine loans across the full lifecycle.

| Track | Result |
|---|---|
| **A** Repayment lifecycle | ✅ Pass, incl. **A6** overpay refund (loans #4, #6 closed with `amountRepaid` capped at the debt and all 0.005 collateral released) |
| **B** Deadline → grace → liquidation | ✅ Pass via `/demo` Skip time |
| **C** Two-user visibility | ✅ Pass after the polling fix |
| **D** Price-crash liquidation | ✅ Pass, incl. the `$0` broken-oracle fail-safe |
| **E** Partial-liquidation fairness | ✅ Pass — **E2** (figures shrink on repayment), **E3** (loans #5, #7: repaid 0.00125 → seized 0.001085, refunded 0.003915), **E4** (loans #2, #3, #8: no repayment → seized only the debt ~0.002335, refunded ~0.002665) |

**Interest is working and is ETH-denominated.** On-chain: loans left to accrue show `0.000085068 ETH` interest (90d @ 15% APR on 0.00225 ETH ≈ 0.0000832 — matches). Loans repaid immediately show ~1 wei, because accrual is *by elapsed time*. It only looked absent because the UI renders it in USD ($0.16) and because demo-scale amounts are tiny.

**Automatic liquidation is confirmed out of scope.** Contracts cannot self-execute. Real protocols pay liquidator bots a bonus to race for it, or use a keeper network. Ours requires the lender to click, and that is now a documented design position rather than a gap.

---

## 🎯 THE NEW BASELINE: settlement transparency

**The problem, stated plainly:** every payment in this system — funding, repayment, seizure, refund — moves as an *internal contract transfer*. MetaMask does not list internal transfers. So both sides watched their balances change with no record of what happened, and repeatedly concluded "nothing was received" when the money had in fact moved correctly. **The app must be the source of truth, because the wallet cannot be.**

This is the highest-priority work. Everything below it is secondary.

**All three shipped 2026-07-29.** Requires **migration `004_event_price_snapshots.sql`** to be run in Supabase before per-event prices are recorded; without it statements still generate, valued at the current price and labelled "(est.)".

**Permanent `getLogs` range.** `findDeploymentBlock()` in `lib/loan-events.ts` binary-searches the factory's deployment block via `eth_getCode` (`0x` before deployment, bytecode after), then caches it. Roughly 25 RPC calls once per session. This is derived rather than pinned in an env var precisely because contracts get redeployed often here — a hardcoded block silently yields an empty history the moment it goes stale. Logs are then fetched in 9,000-block chunks so a wide range never trips an RPC's span limit.

### ✅ T1 — Settlement receipts on every closed loan *(shipped 2026-07-29)*

For a **lender**, on any `Repaid`/`Liquidated` position, show:
- Total lent (principal) · total actually received · **interest earned, in ETH and USD** · whether it closed by repayment or liquidation
- If liquidated: amount seized vs. amount refunded to the borrower
- Etherscan links for *every* leg — the funding tx, each repayment, the liquidation

For a **borrower**, on any closed loan:
- Total borrowed · total repaid · interest paid · collateral returned or seized
- The same per-leg Etherscan links

Currently the lender only sees interest gained, which is the least useful number of the set.

### ✅ T2 — Event-backed history *(shipped 2026-07-29)*

The above needs the actual transaction hashes, which only exist in event logs. Index `LoanFunded`, `PartialRepayment`, `LoanRepaid`, `LoanLiquidated` and `CollateralReleased` per loan via `getLogs`, and render a timeline. This also removes the current `localStorage` tx-hash matching hack in `BorrowerLoansSection`, which is fragile and only ever knew about loan *creation*.

### ✅ T3 — Downloadable statements *(shipped 2026-07-29)*

Both roles, generated from the indexed events in T2:
- **P&L** — realised gains/losses per loan and in aggregate
- **Tax P&L** — disposals with dates, cost basis, and proceeds in fiat at the time of each event
- **Tradebook** — every action chronologically: funded, repaid, liquidated, with hashes

Settings page gains a Statements section. Note that the price *at the time of each event* is needed for fiat columns; only `priceAtFunding` is currently stored on-chain, so either snapshot prices per event off-chain or state plainly that fiat values use the current price.

---

## 🐛 Reported bugs, not yet fixed

| # | Issue | Notes |
|---|---|---|
| **B1** | **Risk tier / risk score not scored** | Needs a precise repro — which mode (demo persona vs. real wallet), and where it shows unscored. Demo personas do score correctly (see screenshots: Bob → −0.250 → Tier C), so this is likely the real-wallet path or the lender-side persisted assessment. |
| **B2** | ETH price on the dashboard is unlabelled and static | Should say explicitly it is the **current market** ETH price and tick live rather than only refreshing on load. |
| **B3** | "What went into your score" panel renders **light-on-white** | `RiskExplanationPanel.tsx` hardcodes `bg-white` / `bg-slate-50` / dark text while the rest of the app is dark. Restyle to match. |

---

## 🔭 Also queued

- **Cancel a loan request before it's funded — no Cancel button exists in the borrower UI.**

  **The gap:** a borrower who posts a request and changes their mind (wrong amount, wrong term, found funding elsewhere) has no way out. The request sits in the marketplace with their collateral locked until the 7-day funding window expires. Nothing in `BorrowerLoansSection.tsx` calls `cancel()` — the borrower's `Requested` loan cards render terms and a funding countdown only.

  **To build:** a Cancel button on each `Requested` loan card in `BorrowerLoansSection.tsx`, wired with the same `useWriteContract` / `useWaitForTransactionReceipt` pattern already used for repay. Needs a confirm step (irreversible), copy stating the collateral comes straight back, and an Etherscan link on success to match the rest of the app. `cancel` also has to be added to the shared `LOAN_ABI` in `lib/loan-abi.ts` — it isn't there yet. The button must not render for any status other than `Requested`, and it's worth re-reading `status` at click time rather than trusting the 5s-polled value: a lender can fund in the gap between render and confirmation, and the tx then reverts with `"Loan: cannot cancel"`, which should surface as a plain "this loan was just funded" message rather than a raw revert string.

  **Frontend-only — no contract change, no redeploy.** `cancel()` (`Loan.sol:217`) already exists: `onlyBorrower`, requires `status == Requested`, releases collateral to the borrower, emits `LoanCancelled`. The event is already decoded in `lib/loan-events.ts` and `Cancelled` is already in both dashboards' `STATUS_LABEL`, so history and receipts pick it up for free once the button ships.
- **Multi-lender pooling (1:N funding)** — several lenders contribute partial amounts to one loan; pro-rata repayment. Explicitly called "MVP-feasible" in the lender-journey doc. Biggest remaining architectural gap.

---

## 📋 Backlog (not started, ordered roughly by value)

### In scope for the project (confirmed by official docs)

- **Multi-lender pooling** — see "Also queued" above.
- **Peer discovery** — there's no way for users to find/identify each other on the platform. A searchable directory of verified users (by display name or linked wallet address) would let teammates coordinate borrower/lender pairs instead of guessing loan IDs blind. Not started.

### Kept intentionally low priority

- _(nothing parked here right now)_

### Optional polish

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

## Deployment (2026-07-26)

The frontend is deployed on **Vercel**, connected to the GitHub repo (`whyafan/p2p-lending-platform`) so **every push auto-deploys**. Each team branch gets its own stable URL, so everyone can test their own work in isolation while sharing the same Sepolia contracts.

| Branch | URL | Vercel environment |
|---|---|---|
| `main` | https://nexusfi-lending.vercel.app (also https://frontend-gold-chi-89.vercel.app) | Production |
| `afan` | https://nexusfi-afan.vercel.app | Preview |
| `siddharth` | https://nexusfi-siddharth.vercel.app | Preview |
| `atharva` | https://nexusfi-atharva.vercel.app | Preview |

Push to any of those branches → that branch's URL rebuilds automatically. No CLI step needed.

**Important: separate frontends, shared backend.** All four deployments point at the *same* Sepolia contracts and the *same* Supabase project. That's deliberate — it's what lets one person borrow and another lend and actually see each other's loans. It also means test data is shared across all four URLs, and any contract redeploy affects all of them at once.

### Vercel project config

- Project `afan1/frontend`, **Root Directory `frontend`** (required — the repo is a monorepo; without this, git builds clone the repo root and fail to find the Next.js app). Production Branch: `main`.
- All 15 env vars from `frontend/.env.local` are set in **both** Production and Preview environments (Supabase URL/anon/service-role, Sepolia RPC + the three contract addresses, WalletConnect project ID, the four Didit KYC vars, `ALLOW_DEMO_KYC=1`). Preview needs its own copy or branch deployments build with no config and break at runtime.
- **Deployment Protection is disabled.** By default Vercel puts preview deployments behind an SSO login, which would have blocked teammates (a Hobby team can't add members). Disabling it makes all four URLs publicly reachable — fine for a testnet demo app with no real funds, but worth knowing these URLs are open to anyone who has the link.
- **Not deployed:** the FastAPI credit-scoring backend (`backend/`). `/api/credit/score` falls back to the client-side rule-based scorer when unreachable, so risk scoring still works — just via the rule-based path.
- Manual deploy (rarely needed now): `cd frontend && npx vercel --prod`.

### Known gap to check before team testing

If Supabase has "Confirm email" enabled, confirmation links point at Supabase's configured Site URL (likely still `localhost:3000`), which would break signup for anyone not on the dev machine. Either disable email confirmation (Supabase → Authentication → Providers → Email) or add the deployed URLs to Supabase's Site URL / Redirect URLs.

---

## Partial liquidation — seize the debt, refund the surplus (2026-07-26)

Found during the first two-person manual test. Liquidation handed the lender the **entire** collateral no matter how much was still owed, so two things were wrong at once:

1. A borrower who had repaid 90% still lost 100% of their collateral, on top of what they had already paid.
2. Even at zero repayment the lender collected far more than the debt — roughly 1.75x on a typical over-collateralised loan — which is a windfall, not being made whole.

`liquidate()` now seizes `min(outstandingBalance, collateralAmount)` and returns the remainder to the borrower in the same transaction. Both debt and collateral are ETH-denominated, so no oracle conversion is needed for the lender to come out exactly whole. Partial repayments now shrink the seizure pound for pound, which is what makes paying something worthwhile.

- `CollateralVault.liquidateCollateral()` takes a `seizeAmount` and pays the surplus back to the borrower. Still one-shot — the position closes in a single call, it is not drawn down repeatedly.
- `Loan.liquidationPreview()` returns `(seizeAmount, refundAmount)` so both sides can see the split *before* anyone clicks Liquidate. The lender's button says what it will recover; the borrower's repay box says what they would keep.
- 4 new tests: exact seizure with surplus refunded, seizure shrinking as repayments land, a mostly-repaid loan surviving liquidation with most collateral returned, and the seizure capped at the posted collateral when the debt exceeds it. 28/28 passing.

**What the lender actually recovers.** Seizure is `min(outstandingBalance, collateralAmount)`, both in ETH. Because loans are over-collateralised at origination (max LTV 70%), the collateral is always larger than the debt in ETH terms, so **the lender recovers their principal plus accrued interest in full and the borrower keeps the rest**. A price crash triggers liquidation but does *not* change either leg — both are ETH-denominated — which is why a crash to $500 still returns exactly the debt and no more. If the debt ever did exceed the collateral (only reachable if interest ran up against a very thin collateral buffer), the seizure caps at whatever the vault holds and the lender absorbs the shortfall; that is the timeliness gap below, not a fairness one.

**Still not automatic.** Contracts cannot self-execute; real protocols pay liquidator bots a bonus to race for it (or use a keeper network like Chainlink Automation). Ours relies on the lender clicking. Partial liquidation fixes *fairness*, not *timeliness* — if collateral fell below the debt while nobody acted, the lender would still absorb the shortfall. Acceptable for an over-collateralised MVP; worth stating plainly in the report.

---

## Transparency pass — both sides can see the money (2026-07-28)

Session 2 surfaced confusion that turned out to be mostly invisible-but-correct behaviour, so the fix was to expose it rather than change it:

- **Lender position card** now shows *still owed to you*, *repaid so far*, and *if you liquidated now* (seize vs. refund), plus the explicit price this loan liquidates below.
- **Borrower repay box** now breaks out interest accrued so far, and shows the same liquidation price.
- Both note that payments arrive as **internal contract transfers**, so balances move but MetaMask's activity list stays empty — the single biggest source of "did anything happen?" during testing.

Three things that looked like bugs and were not:

1. **"No interest."** Interest accrues by elapsed time. 15% APR on 0.00225 ETH over 90 days is ~0.000083 ETH total; repaying minutes after funding earns a few hundred wei. Correct, just invisible at demo scale.
2. **"Crashing to \$500 doesn't enable liquidation."** The debt is frozen in USD *at funding*. The loan in question had `priceAtFunding = 500` — it was funded *after* the crash, so \$500 was already the baseline and LTV sat at 45% against a 65% threshold. It needed roughly \$346 to trigger.
3. **"The lender took the whole collateral."** On-chain the latest loan seized 0.001085 ETH and refunded 0.003915 ETH to the borrower — partial liquidation working exactly as intended. The refund was invisible because it arrived as an internal transfer.

The genuinely stale observations came from loans still sitting on the **previous factory** (`0xf345…`), which predates partial liquidation and does take everything.

---

## Lender-facing ML explainability (2026-07-26)

The borrower's 8-feature risk score was computed in the browser and discarded on unmount — only the tier survived, baked into the on-chain terms. Lenders therefore saw a letter grade with no reasoning, which is precisely the "ledger transparency is not decision transparency" gap the literature review calls out. Now persisted and surfaced.

- `supabase/migrations/003_loan_risk_assessments.sql` — **must be run once in the Supabase SQL editor.** Until then saving fails silently (by design: it never disrupts the borrower's flow) and lenders see "no assessment captured".
- Keyed by **Loan contract address**, not the numeric loan ID — globally unique across factory redeploys, and it's what the lender dashboard already holds.
- RLS: readable by **any signed-in user** (a lender must be able to read someone else's loan — the row holds no PII, only signals that already determine the public on-chain terms), insertable only by the loan's creator, and **immutable** afterwards so a borrower can't rewrite an explanation a lender already funded against.
- `app/api/loans/risk/route.ts` — POST to save, GET to batch-fetch by address.
- `LoanRequestPanel` saves **after the receipt confirms**, decoding the `Loan` address from the `LoanCreated` event: the address doesn't exist at submit time. Best-effort — a failure here never blocks the borrower, since the loan is already on-chain.
- `LoanSafetyPanel` renders the contributions sorted by weight, each with a centred bar (green toward Tier A, red toward Tier C), the weight %, and the overall score. Loans created before this existed say so plainly rather than showing a blank.

---

## Contract verification (2026-07-26)

All three contracts are source-verified on **Blockscout** and **Sourcify**:

| Contract | Blockscout |
|---|---|
| CollateralVault | [`0x0C0B…bf1f`](https://eth-sepolia.blockscout.com/address/0x0C0B2aa539Cbe0c3c93559508c46d0934fAbbf1f#code) |
| MockPriceFeed | [`0x39d8…81Cb`](https://eth-sepolia.blockscout.com/address/0x39d857c414585C5aAef96Ca82Ea5C5F671F381Cb#code) |
| LoanFactory | [`0xf345…10d0`](https://eth-sepolia.blockscout.com/address/0xf34505b3939374f8Cd71BE5D21c424c642c210d0#code) |

Config lives in `hardhat.config.ts` under `verify`. Sourcify and Blockscout need no API key; **Etherscan is configured but disabled** until `ETHERSCAN_API_KEY` is set in `contracts/.env` (free key from <https://etherscan.io/apis>) — enabling it keyless makes every verify run fail.

**Two gotchas worth remembering:**
1. Verify **must** run with `--build-profile production`. Ignition deploys with the production profile (optimizer on, 200 runs) while `verify` defaults to the `default` profile (no optimizer), producing "bytecode does not match any of your local contracts".
2. Run `npx hardhat compile --build-profile production` first — stale default-profile artifacts cause the same error even when the flag is passed.

```bash
cd contracts && npx hardhat compile --build-profile production
npx hardhat verify --build-profile production --network sepolia <address> [ctorArgs...]
# LoanFactory takes three: <vault> <priceFeed> true
```

Individual `Loan` contracts are deployed by the factory at runtime and aren't verified individually; their source is identical and covered by the verified factory.

---

## Lender risk transparency (2026-07-26)

Tier A/B/C badges already existed on the lender cards (PLAN.md previously claimed otherwise — that entry was stale). What was missing was the *reasoning*, so `components/LoanSafetyPanel.tsx` now expands the badge into a collapsible panel on both the Open Requests and My Positions cards:

- **Why this tier** — the tier→terms mapping made explicit (max LTV, APR split into base + risk spread, liquidation buffer, term), stressing the terms are rule-derived, not negotiated.
- **Your protection** — over-collateralisation with actual USD figures, the liquidation threshold, and **how far ETH must fall from today's price** before the position becomes liquidatable (derived from the live on-chain LTV).
- **What can go wrong** — liquidation isn't automatic and must be called; a fast crash can leave collateral short; repayment may arrive in instalments; a failed oracle disables price liquidation by design.

Collapsed by default so it doesn't crowd the cards. Honest about its limits: it states plainly that the borrower's feature-level breakdown isn't persisted and so can't be shown.

---

## Demo controls — forcing both triggers on demand (2026-07-26)

Neither liquidation trigger can normally be exercised on demand: one needs a real market crash, the other needs real days to pass. **`/demo`** (a deliberately unlinked route — kept off the dashboards so it doesn't clutter them) fakes both:

- **Price** → writes to `MockPriceFeed.setPrice`. Presets (−25%, −50%, crash to $500, reset) plus a custom field. `setPrice` is now **permissionless**: gating it to the deployer meant only one teammate could ever run the demo. It's a mock oracle on testnet; never ship it to a real network.
- **Time** → `Loan.fastForward(seconds)`. `block.timestamp` can't be moved on a live chain, so this rewinds the *loan's own* timestamps instead, which is equivalent. Buttons for +1 day / to deadline / past grace. Affects the funding window while `Requested` and the deadline, grace period and interest accrual once `Funded`.

Guards: `fastForward` requires the factory's `demoMode` (a deploy-time flag — a real deployment passes `false`), only the loan's own borrower or lender can call it (so nobody can shove a stranger's position into liquidation), and it reverts on closed loans.

`demoMode` is read from the factory via a `try/catch` view rather than stored per-loan — adding a 12th constructor parameter blew the EVM stack limit ("stack too deep"), and reading it keeps a single source of truth.

---

## Change Log — Oracle price-crash liquidation (2026-07-26)

- `Loan.sol` — added `priceFeed` (11th constructor arg, may be `address(0)`), `debtValueUsd` + `priceAtFunding` frozen in `fund()`, and views `currentPrice()`, `currentLtvBps()`, `liquidationThresholdBps()`, `isPriceLiquidatable()`, `isDelinquentLiquidatable()`. `liquidate()` now accepts either trigger; `isLiquidatable()` is their union. Oracle reads go through a `try/catch` helper so a missing or reverting feed degrades to "price liquidation disabled" instead of bricking every view.
- `LoanFactory.sol` — constructor takes `priceFeed_` and passes it to every `Loan`. **This changed the factory ABI, forcing a full redeploy.**
- `ignition/modules/NexusFiMilestone1.ts` — `MockPriceFeed` now deploys *before* `LoanFactory`.
- `contracts/test/LoanLifecycle.ts` — 7 new price tests (healthy start, LTV rising as price falls, threshold boundary at exactly $1,250, liquidation while not overdue, recovery un-liquidating, zero-price fail-safe, closed loans reporting 0). **Fixture changed** from 5 ETH principal / 2 ETH collateral (a 250% LTV that would have been instantly price-liquidatable and broke the deadline tests) to a realistic 1 ETH / 2 ETH. 19/19 passing.
- `frontend/lib/loan-abi.ts` + `LenderDashboard.tsx` — the LTV bar now reads `currentLtvBps()` from the contract instead of the old client-side `principalUsd/collateralUsd`, which was price-independent and could never show a crash. The liquidate badge names the reason ("overdue" vs "collateral shortfall"). Open Requests still shows the static origination LTV, which is correct there — the USD debt isn't frozen until funding.

---

## Change Log — Liquidation & delinquency rewrite (2026-07-25)

- `contracts/contracts/Loan.sol` — added `GRACE_PERIOD`, `amountRepaid`, `closedAt`; added `repaymentDueAt()`, `isDelinquent()`, `isLiquidatable()`, `outstandingBalance()`; changed `interestDue()`/`totalRepaymentDue()` to accrue continuously (capped) instead of using the fixed `durationDays` term; rewrote `repay()` for partial payments; replaced `markLiquidatedForDemo()` with `liquidate()`; added `PartialRepayment` event. No constructor change — `LoanFactory.sol`'s `new Loan(...)` call site untouched.
- `contracts/test/LoanLifecycle.ts` (new) — 10 tests covering partial repayment, full repayment, overpayment refunds, interest-formula boundary matching, interest capping, and all `liquidate()` gating conditions. Uses `networkHelpers.time.increaseTo()`. One important lesson from getting these green: Hardhat's EDR network timestamps auto-mined blocks with real wall-clock time, so a value read via `outstandingBalance()` moments before sending a tx can go stale by execution — tests read authoritative state *after* each tx rather than asserting pre-computed values.
- `frontend/lib/loan-abi.ts` (new), `frontend/components/LenderDashboard.tsx`, `frontend/components/BorrowerLoansSection.tsx` — see DONE sections above.
- Redeployed `CollateralVault`/`LoanFactory`/`MockPriceFeed` to Sepolia (`--reset` flag, since Ignition treats a module as already-complete otherwise); updated `frontend/.env.local`.

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
| `frontend/lib/loan-abi.ts` | Shared `Loan`/`LoanFactory` ABI (used by LenderDashboard + BorrowerLoansSection) |
| `contracts/test/LoanLifecycle.ts` | Repayment deadline, partial repayment, interest cap, both liquidation triggers |
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

---

## 🔧 Documentation/code mismatches to fix (found 2026-08-03 during README write)

| # | Item | Detail | Action |
|---|---|---|---|
| D1 | **EIP-712 signing claimed but absent** | PLAN lists "EIP-712 typed term-sheet signing" as ✅ twice, but there is no `signTypedData`/`typedData` anywhere in `frontend/`. `submitLoan()` (`LoanRequestPanel.tsx:632`) calls `createLoan` directly. | Either build it or strike the claim from PLAN and the report. |
| D2 | **Stale addresses in `.env.example`** | `frontend/.env.example` and `backend/.env.example` still list the abandoned 2026-05-18 deploy (`0xD4cfc8…`, `0x99Cb30…`, `0xC6faac…`). `backend/app/services/chain_fetcher.py:77` hardcodes the same stale factory as its default. | Update all three to the live `0x4dDB…` / `0xeB13…` / `0x5094…`. |
| D3 | **Real Alchemy key committed** | `backend/.env.example:3` contains what looks like a live key, not a placeholder. | Rotate the key, replace with `YOUR_ALCHEMY_API_KEY`. |
| D4 | **`scripts/deploy-milestone1.ts` is broken** | Deploys `LoanFactory` with 1 constructor arg; it now takes 3 (`vault`, `priceFeed`, `demoMode`), and the script never deploys `MockPriceFeed`. `npm run deploy:local` and `deploy:ephemeral` both fail. | Fix the script or delete it and point everything at the Ignition module. |
| D5 | **Verification table addresses don't match anything** | The Blockscout links (`0x0C0B…`, `0x39d8…`, `0xf345…`) are a third address set, neither the live deploy nor the May one. | Re-verify the live three and update the table. |
| D6 | **No frontend test script, no CI test run** | `frontend/package.json` has no `test` entry; `.github/workflows/deploy.yml` only deploys. Tests run today only via `node --experimental-strip-types --test lib/*.test.ts` (103 passing). | Add `"test"` script + a CI job running it and `npx hardhat test` (28 passing). |
| D7 | **Backend fallback claim is wrong** | PLAN says `/api/credit/score` falls back to the rule-based scorer. The route returns `{fallback:true}`, but `confirmWalletScore()` only shows a warning and never scores locally. | Implement the local fallback, or correct the claim. |
| D8 | **On-chain amounts decoupled from the term sheet** | `DEMO_MAX_COLLATERAL_ETH = 0.005` caps what is actually sent, so the USD loan the borrower configures is display-only. Undocumented outside the component. | Document it in the UI and PLAN, or scale it explicitly. |
