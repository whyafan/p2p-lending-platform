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
| Oracle-driven automatic liquidation with delinquency state machine (Delinquent → Default → Liquidated, buffer period, partial liquidation) | 🟡 **Delinquency half done (2026-07-25).** `liquidate()` now enforces a real deadline + 2-day grace period gate, replacing the old unconditional `markLiquidatedForDemo()`. Still missing: the oracle price-crash trigger (deliberately deferred — see note below) and partial liquidation (collateral release is still all-or-nothing, matching `CollateralVault`'s existing interface). |
| Repayment deadline enforcement | ✅ **Done (2026-07-25).** `repaymentDueAt()` derives a fixed deadline from `fundedAt + durationDays`; `isDelinquent()`/`isLiquidatable()` expose the real-time state to the UI. |
| Partial repayments | ✅ **Done (2026-07-25).** `repay()` accepts any amount > 0, tracked via `amountRepaid`; the loan only closes once the full live `outstandingBalance()` is covered. Borrower UI has a repay control (custom amount or "Repay in full") in `BorrowerLoansSection.tsx`. |
| Overdue interest accrual | ✅ **Done (2026-07-25).** Interest now accrues continuously from `fundedAt` (not just over the fixed `durationDays` term) and keeps growing past the deadline — but is capped at `repaymentDueAt() + GRACE_PERIOD` so it doesn't inflate forever once a loan is liquidatable. |
| Funding deadline (`requestedAt + 7 days`) | ✅ **Actually already implemented** — `Loan.sol` has `FUNDING_WINDOW = 7 days` enforced inside `fund()`. Earlier versions of this doc incorrectly listed this as missing; verified in code 2026-07-25. |
| Multi-lender pooling (partial fills across several lenders) | ❌ Not built (single lender funds 100% in one tx). The lender-journey doc explicitly calls this "still MVP-feasible" as an alternative, not a stretch goal — **now tracked in scope**, see Backlog. |
| Decentralized identity / on-chain KYC | 🟡 Partial — off-chain KYC (Didit + Supabase) bound to wallet address via linked-wallet signature verification. `KYCRegistry.sol` exists as an on-chain reference contract but is intentionally unused in the live flow (documented in the project brief as a "M1 reference," not accidental cruft — left in place). |
| Privacy-by-design (PII off-chain, encrypted) | ✅ Conceptually aligned — Supabase holds PII, service-role key required, no PII on-chain — though without the IPFS/hash-anchoring layer the official docs describe. |

**Note on the deferred oracle price-crash trigger:** wiring `MockPriceFeed` into `Loan.sol`'s liquidation logic was deliberately scoped out of the 2026-07-25 liquidation work. The reason is a real design snag, not just time pressure: `principalAmount` and `collateralAmount` are both denominated in ETH on-chain, so an ETH price move changes both sides of the LTV ratio equally and doesn't actually change the ratio. The frontend's LTV health bar recomputes the ratio using the *current* price on both sides, which is mathematically a no-op for triggering liquidation — it's a display effect, not a real risk signal yet. Fixing this properly needs either freezing a USD-denominated debt figure at loan origination or moving to a non-ETH principal asset; that's a separate redesign, not a quick add-on.

**Bottom line:** the demo's happy path (create → fund → repay/liquidate) is real and works on Sepolia, and as of 2026-07-25 so is the deadline/delinquency-based liquidation path, wired end-to-end from contract to UI. The remaining gap between "what the report describes" and "what runs" is the oracle-price liquidation trigger (needs a design fix, see note above), multi-lender pooling, and the observability/IPFS layer described in the backlog below.

---

## ✅ Confirmed working end-to-end on Sepolia (verified 2026-07-25)

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

Deployed contracts (redeployed 2026-07-25 for the `Loan.sol` liquidation rewrite — bytecode changed, so these addresses are new; the pre-2026-07-25 addresses below are abandoned):

- LoanFactory: `0x2005F0798c4B96361586b60BdBAdfB54570894e4`
- CollateralVault: `0x9b525FDb19cB1a1764acB5C58d171462Bec83C93`
- MockPriceFeed: `0x353AbD44C5e83bF441fbcCeCA5373A330F61CB61`

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

## ✅ Just completed: Liquidation & delinquency logic (2026-07-25)

Full stack, contract through UI through redeploy:

1. **Repayment deadline** — `repaymentDueAt() = fundedAt + durationDays` is fixed once a loan is funded.
2. **Partial repayment** — `repay()` accepts any positive amount, tracked in `amountRepaid`, forwarded to the lender instantly; the loan only closes (collateral released) once the running total covers the live `outstandingBalance()`.
3. **Overdue interest** — interest accrues continuously from `fundedAt` at the same `interestBps` rate (not just over the fixed original term), and is capped once the loan becomes liquidatable so it doesn't grow unbounded.
4. **Real liquidation eligibility** — `markLiquidatedForDemo()` is gone; `liquidate()` only succeeds once `block.timestamp > repaymentDueAt() + GRACE_PERIOD` (2 days) with an unpaid balance. The oracle price-crash trigger was deliberately **not** added — see the ETH/ETH LTV design note above.
5. **Frontend wired end-to-end** — `BorrowerLoansSection.tsx` gained a repay UI (there was none before); `LenderDashboard.tsx`'s liquidate button is now really gated with a live countdown; both share `frontend/lib/loan-abi.ts` instead of duplicating ABI arrays.
6. **Redeployed to Sepolia** — new `LoanFactory`/`CollateralVault`/`MockPriceFeed` addresses (bytecode changed), `frontend/.env.local` updated. See addresses above.
7. **Tested** — `contracts/test/LoanLifecycle.ts` (10 new tests) + the original `NexusFiMilestone1.ts` suite (2 tests), 12/12 passing. Frontend `tsc --noEmit` and `next build` both clean.

**Immediate next step:** a full manual click-through against the redeployed Sepolia contracts hasn't been done yet this session (only the automated test suite + successful deploy transaction were verified) — worth doing before calling this closed. After that, **BUG-VIS** (loan visibility between users) is the next thing to pick up.

---

## 📋 Backlog (not started, ordered roughly by value)

### In scope for the project (confirmed by official docs)

- **Multi-lender pooling** — the lender-journey doc explicitly describes partial fills across multiple lenders as "still MVP-feasible," not just a stretch goal. Needs: a contribution mapping per loan, a funding-closes-when-full condition, and pro-rata repayment distribution. ~1 day of contract + frontend work. Tracked in scope, not started.
- **Oracle price-crash liquidation trigger** — the actual design fix, not just wiring: `principalAmount`/`collateralAmount` are both ETH-denominated today, so a price move doesn't change the LTV ratio. Needs either freezing a USD-denominated debt figure at origination, or a non-ETH principal asset (ties into the MockERC20 item below). Not started.
- **Peer discovery** — there's no way for users to find/identify each other on the platform. A searchable directory of verified users (by display name or linked wallet address) would let teammates coordinate borrower/lender pairs instead of guessing loan IDs blind. Not started.

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

## Deployment (2026-07-26)

The frontend is deployed on **Vercel** so the team can test against the same live Sepolia contracts without each running `npm run dev`.

- **Live URL: https://frontend-gold-chi-89.vercel.app** — this is the public production URL. Use this one.
- `https://nexusfi-lending.vercel.app` is an alias pointing at the same deployment, but it currently sits behind Vercel's default deployment protection (SSO) and will 302 to a Vercel login. To make it usable, turn off Deployment Protection in the Vercel dashboard (Project → Settings → Deployment Protection). Until then, share the URL above.
- Vercel project: `afan1/frontend`, root directory `frontend/`, framework auto-detected as Next.js. Linked via `npx vercel link`; deployed via `npx vercel --prod`.
- All 15 env vars from `frontend/.env.local` are set in Vercel's Production environment (Supabase URL/anon/service-role, Sepolia RPC + the three contract addresses, WalletConnect project ID, the four Didit KYC vars, and `ALLOW_DEMO_KYC=1`). Verified the redeployed LoanFactory address is baked into the production client bundle.
- **Not deployed:** the FastAPI credit-scoring backend (`backend/`). `/api/credit/score` falls back to the client-side rule-based scorer when it's unreachable, so this is not a blocker — the risk scoring still works, just via the rule-based path.
- **Redeploying after a code change:** `cd frontend && npx vercel --prod`. The project was created via CLI, so it is **not** wired to auto-deploy on `git push` — connect the GitHub repo in the Vercel dashboard if that's wanted.
- **Known gap to check before team testing:** if Supabase has "Confirm email" enabled, confirmation links point at Supabase's configured Site URL (likely still `localhost:3000`), which would break signup for anyone not on the dev machine. Either disable email confirmation (Supabase → Authentication → Providers → Email) or add the Vercel URL to Supabase's Site URL / Redirect URLs.

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
| `contracts/test/LoanLifecycle.ts` | Repayment deadline, partial repayment, interest cap, liquidation behavior spec |
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
