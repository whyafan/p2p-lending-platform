# NexusFi P2P Lending Platform — Implementation Plan

> Last updated: 2026-05-18  
> Team: 3 college students. Stack: Next.js 15 + wagmi v2 + viem + Solidity 0.8.28 + Hardhat Ignition + Supabase + Tailwind CSS  
> Chosen codebase: **P2P-lending-platform** (scored 77/100 against 4 alternatives — see `/Users/afankhan/Developer/assessment.md`)

---

## What We Did This Session (2026-05-18)

1. **Evaluated all 4 codebases** against a 100-point rubric and wrote `assessment.md`. P2P-lending-platform won at 77/100.
2. **Verified all 4 "blocking" bugs** (BUG-02, BUG-04, BUG-07, BUG-10) are already fixed in the current codebase. BUGS.md was written against an older state. No code changes were needed.
3. **Configured Sepolia environment:**
   - `contracts/.env` — `SEPOLIA_RPC_URL` set to Alchemy Sepolia endpoint. `SEPOLIA_PRIVATE_KEY` slot created (user must fill).
   - `frontend/.env.local` — all env vars populated except `NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA` (filled after deploy).
4. **Compiled contracts** — `npx hardhat compile` → "Compiled 8 Solidity files with solc 0.8.28 (evm target: cancun)". Clean.
5. **User funded deployer wallet** with 0.5 Sepolia ETH from Alchemy faucet. Ready to deploy.

---

## Architecture Overview

```
Layer 1 (Inputs)     → Synthetic borrower personas (Alice/Charlie/Bob)
                         ↕ pluggable for real on-chain data later
Layer 2 (Risk)       → SHAP-like XAI scoring engine → Tier A / B / C
                         ↕
Layer 3 (Execution)  → Smart contracts on Sepolia testnet
                         CollateralVault + LoanFactory + Loan
```

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Done and wired end-to-end |
| 🟡 | Partially done — exists but incomplete |
| ❌ | Not started |

---

## ✅ DONE

### Smart Contracts

- ✅ `Loan.sol` — ETH-collateral loan with `repay()`, `cancel()`, `markLiquidatedForDemo()`, `totalRepaymentDue()`, `interestDue()`. Interest formula: `principal × interestBps × durationDays ÷ (10_000 × 365)`.
- ✅ `LoanFactory.sol` — creates and tracks all loans; emits `LoanCreated` event.
- ✅ `CollateralVault.sol` — holds ETH collateral; `lockCollateral()`, `releaseCollateral()`, `liquidateCollateral()`.
- ✅ `MockPriceFeed.sol` — owner calls `setPrice(uint256)` to simulate ETH price crash → triggers LTV breach in UI.
- ✅ `MockERC20.sol` — mintable ERC-20 test token (deployed but not yet wired as loan principal).
- ✅ `KYCRegistry.sol` — on-chain KYC whitelist contract.
- ✅ Hardhat Ignition module `NexusFiMilestone1.ts` — deploys CollateralVault + LoanFactory + MockPriceFeed and wires them together in one shot.
- ✅ Hardhat config — `localhost` (chain 31337) and `sepolia` (chain 11155111) networks defined.
- ✅ Contracts compile cleanly against solc 0.8.28.

### Frontend — Borrower (Layer 1 + 2 + 3)

- ✅ **Layer 1** `frontend/lib/borrower-personas.ts` — Alice (Tier A, 1247d wallet, 4/4 repaid, $47k balance), Charlie (Tier B, 180d, 1 liquidation), Bob (Tier C, 45d, 7 txs, $800).
- ✅ **Layer 2** `frontend/lib/risk-explainer.ts` — 8 features with explicit weights summing to 1.0, `FEATURE_WEIGHTS`, `FEATURE_SCORING_GUIDE` (all breakpoints), `TIER_THRESHOLDS` ({A: 0.40, B: 0.00}), `explainPersonaRisk()`.
- ✅ `RiskExplanationPanel.tsx` — weight%, numeric score, tier bar, formula (`Σ feature × weight`), tier boundary chips, collapsible per-feature threshold table.
- ✅ `TermTransparencyPanel.tsx` — all-tier comparison table (A/B/C × maxLTV/spread/haircut/liqBuffer), 6-step formula derivation, on-chain interest formula footnote.
- ✅ `PersonaSelector.tsx` — three-card persona picker, "Use my wallet" escape hatch, DEMO DATA notice.
- ✅ `/api/risk/score` — POST endpoint returning persona + explanation.
- ✅ **Layer 3** Borrower in `page.tsx`:
  - Create loan on-chain (ETH collateral, via `createLoan()`)
  - Cancel loan (status=Requested) via `cancel()`
  - Repay loan (status=Funded) via `repay()` sending exact `totalRepaymentDue` wei
  - Reads `totalRepaymentDue` and `interestDue` directly from contract
  - Refetch effects update status after each tx
- ✅ EIP-712 typed term sheet signing — borrower must sign `LoanTerms` struct before creating a loan.
- ✅ `effectiveTier` pattern — persona tier overrides on-chain tier; DEMO badge when active.
- ✅ Live LTV health monitor — color-coded health bar (green/amber/red) with current LTV%, max LTV marker, liquidation threshold.

### Frontend — Lender

- ✅ Role switcher (Borrower / Lender tabs) in `page.tsx`.
- ✅ Reads all `loanIds` from `LoanFactory`.
- ✅ Renders loan cards with status, principal, collateral.
- ✅ `handleFundLoan()` — sends ETH principal via `fund()`.
- ✅ Fund confirmation + status update on success.
- ✅ Liquidate button in lender workspace — calls `markLiquidatedForDemo()`.
- ✅ Mock ETH/USD oracle panel — lender can crash price via `setPrice()` on MockPriceFeed.
- ✅ Etherscan tx links after every on-chain action (create, fund, repay, cancel, liquidate, set-price). Sepolia links go to `sepolia.etherscan.io/tx/{hash}`.

### Auth, KYC, Infrastructure

- ✅ Supabase auth — login/signup pages, server + client helpers.
- ✅ KYC API routes — `/api/kyc/session`, `/api/kyc/status`, `/api/kyc/webhook`, `/api/kyc/demo-approve`.
- ✅ Didit KYC integration (`lib/didit.ts`).
- ✅ `useCompliance` hook — `canBorrow = hasVerifiedWallet && kycApproved` (BUG-02 already fixed).
- ✅ `NetworkModeToggle` — switches between `local` (Hardhat) and `testnet` (Sepolia).
- ✅ `PriceTicker` — live ETH/USD price display.
- ✅ `wagmi-config.ts` — 5 wallet connectors (MetaMask, WalletConnect, Coinbase, Binance, Trust Wallet), multi-chain (31337 + Sepolia 11155111).
- ✅ `lib/loan-terms.ts` — `RISK_TIER_CONFIG`, `BASE_APR`, `calculateProtocolLoanTerms()`.
- ✅ `lib/borrower-risk.ts` — `tierSummary()`, tier decision rules (BUG-10 already fixed — `>= 1` correctly returns Tier B).

---

## 🚨 IMMEDIATE NEXT STEPS (Do These Now — ~90 Minutes)

> You have 0.5 Sepolia ETH. This is all you need. Do these in order.

### Step 1 — Fill in the private key (2 minutes)

Open `contracts/.env` and paste your MetaMask deployer wallet private key (no `0x` prefix):

```
SEPOLIA_PRIVATE_KEY=your_private_key_here
```

**Never paste this into chat.** Edit the file directly.

### Step 2 — Deploy contracts to Sepolia (~15 minutes including confirmations)

```bash
cd /Users/afankhan/Developer/P2P-lending-platform/contracts
npx hardhat ignition deploy ignition/modules/NexusFiMilestone1.ts --network sepolia
```

This deploys CollateralVault, LoanFactory, and MockPriceFeed in one shot. Output will look like:

```
Deployed Addresses:
NexusFiMilestone1#CollateralVault - 0x...
NexusFiMilestone1#LoanFactory     - 0x...
NexusFiMilestone1#MockPriceFeed   - 0x...
```

Copy all three addresses.

### Step 3 — Populate frontend env (2 minutes)

Open `frontend/.env.local` and fill in:

```
NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA=0x...   ← LoanFactory address
NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS_SEPOLIA=0x... ← CollateralVault address
NEXT_PUBLIC_MOCK_PRICE_FEED_ADDRESS_SEPOLIA=0x...  ← MockPriceFeed address
```

(Check `frontend/app/wagmi-config.ts` or `page.tsx` for the exact env var names — they may differ slightly.)

### Step 4 — Start the frontend (~5 minutes)

```bash
cd /Users/afankhan/Developer/P2P-lending-platform/frontend
npm install   # if not done
npm run dev
```

Open http://localhost:3000. Connect MetaMask to Sepolia. Switch the NetworkModeToggle to "testnet."

### Step 5 — Run the demo flow end-to-end

1. Log in with Supabase auth (email/password)
2. Call `/api/kyc/demo-approve` or use the demo-approve button (ALLOW_DEMO_KYC=1 is set)
3. Select Alice persona → see Tier A risk explanation → see term sheet
4. Sign EIP-712 term sheet
5. Click "Create loan" → MetaMask pops up → confirm → see Sepolia Etherscan link
6. Switch to Lender tab → see the loan appear → click "Fund" → confirm in MetaMask
7. Switch back to Borrower → click "Repay" → confirm → see collateral returned
8. (Demo liquidation) Lender sets mock ETH price to $100 → LTV bar turns red → Lender clicks "Liquidate"

All transactions appear at `sepolia.etherscan.io` automatically.

---

## ⚠️ KNOWN GAP: Multi-Lender Pooling

The current `Loan.sol` has a **single-lender model**: one lender calls `fund()` and sends the full principal amount. There is no pooling mechanism where multiple lenders contribute partial amounts to one loan.

**To add pooling, you would need:**
- A new `LoanPool.sol` contract with a contribution mapping (`mapping(address => uint256) contributions`)
- A funding deadline after which the pool closes
- Pro-rata repayment distribution when the borrower repays
- ~1 day of contract + frontend work

**For the demo, the single-lender model is fine.** Multiple wallets can each fund *different* loans. If pooling is a hard requirement, scope it as Phase 2.

---

## 🟡 PARTIALLY DONE

### Layer 1 — Persona Data Model

- 🟡 `testnetWallet` field missing — personas don't have a `0x...` address field, so the UI can't auto-populate MetaMask with a demo wallet address.
- 🟡 Feature extraction abstraction — `explainPersonaRisk(persona)` takes a persona directly instead of going through `extract_features(wallet_address)` → `FeatureVector` abstraction. Phase 2.
- 🟡 `sanctionProximity` and `loanPurpose` fields exist but have no scorer — deferred to Phase 2.
- 🟡 No unit tests for `risk-explainer.ts`.

### Lender Marketplace

- 🟡 Loan list exists but no filtering (by status, tier, APR), no sort, no search.
- 🟡 No risk summary for lenders — lender sees loan amounts but not borrower tier.
- 🟡 No repayment notification when a funded loan gets repaid.

### KYC End-to-End

- 🟡 `ALLOW_DEMO_KYC=1` is set. The demo-approve endpoint exists. Whether the full Didit → Supabase webhook is wired without Didit credentials is unclear — test it with `demo-approve` first.

### Contract Tests

- 🟡 `test/NexusFiMilestone1.ts` exists but requires deployment to local Hardhat first. Run `npx hardhat ignition deploy ignition/modules/NexusFiMilestone1.ts --network localhost` before running tests.

---

## ❌ NOT DONE (Post-Demo Backlog)

| Item | Effort | Priority |
|---|---|---|
| **Multi-lender pooling** — partial contributions per loan, pro-rata repayment | 1 day | High (if required for demo) |
| **Contracts verified on Sepolia Etherscan** — `--verify` flag | 30 min | Medium |
| **Lender loan cards show borrower risk tier** — currently missing | 1 hr | High |
| **Network-switch prompt** — MetaMask on wrong chain → auto-prompt | 1 hr | Medium |
| **Loan filter / sort** — filter by status, sort by APR | 1 hr | Medium |
| **Real `extract_features(wallet_address)` pipeline** — reads from Alchemy/Etherscan | 2 days | Phase 2 |
| **Funding deadline** (BUG-08) — `requestedAt` + 7-day window, `expire()` function | 2 hr | Phase 2 |
| **Repayment deadline + late penalty** (BUG-09) | 2 hr | Phase 2 |
| **Events indexer** — index `LoanCreated` logs; show transaction history | 3 hr | Phase 2 |
| **MockERC20 as loan principal** — ERC-20 funding instead of native ETH | 3 hr | Phase 2 |
| **Mainnet wallet linking** — EIP-712 to prove mainnet wallet ownership | 4 hr | Phase 2 |

---

## Bugs Fixed Before This Session

These bugs were documented in BUGS.md but are already corrected in the current code:

| Bug | BUGS.md claim | Actual state |
|---|---|---|
| BUG-02 | `canBorrow: true` hardcoded | Fixed — `canBorrow: hasVerifiedWallet && kycApproved` |
| BUG-04 | Hardcoded localhost RPC URL | Fixed — uses env var |
| BUG-07 | `.toFixed(18)` float noise | Fixed — uses `.toFixed(6)` |
| BUG-10 | `>= 1` returns Tier A (wrong) | Fixed — correctly returns Tier B |

## Open Bugs Relevant to Demo

| ID | Severity | Impact on demo | Mitigation |
|---|---|---|---|
| BUG-01 | CRITICAL | Lender can liquidate immediately — **intentional for demo** | `markLiquidatedForDemo()` is the function name; this is by design |
| BUG-03 | HIGH | Interest rounds to 0 for tiny loans (< ~3650 wei) | Use realistic loan amounts (≥ 0.01 ETH) during demo |
| BUG-08 | HIGH | No funding deadline | No visible impact during demo |
| BUG-09 | HIGH | No repayment deadline | No visible impact during demo |
| BUG-11 | MEDIUM | Loan ID inference race condition | Only matters if two loans created simultaneously |
| BUG-14 | MEDIUM | `liquidationBufferBps` missing from lender view | Visual gap only |

---

## Demo Day Readiness Checklist

- [ ] `contracts/.env` — `SEPOLIA_PRIVATE_KEY` filled in
- [ ] `npx hardhat ignition deploy ... --network sepolia` — ran successfully
- [ ] `frontend/.env.local` — `NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA` (+ vault + price feed) populated with real addresses
- [ ] `npm run dev` starts without errors
- [ ] Alice persona → Tier A score → EIP-712 sign → `createLoan()` → Sepolia Etherscan link visible
- [ ] Lender tab → loan appears → `fund()` → Sepolia Etherscan link visible
- [ ] Borrower → `repay()` → collateral returned → Sepolia Etherscan link visible
- [ ] MockPriceFeed → set price to $100 → LTV bar turns red → Liquidate → Sepolia Etherscan link visible
- [ ] KYC demo-approve flow (`ALLOW_DEMO_KYC=1`) works end-to-end
- [ ] Contracts verified on Sepolia Etherscan (optional but nice for demo)

---

## Key File Reference

| File | Purpose |
|------|---------|
| `contracts/contracts/Loan.sol` | Core loan lifecycle |
| `contracts/contracts/LoanFactory.sol` | Loan creation + registry |
| `contracts/contracts/CollateralVault.sol` | ETH collateral custody |
| `contracts/contracts/MockPriceFeed.sol` | Oracle simulation for liquidation demo |
| `contracts/contracts/MockERC20.sol` | Test USDC token (not wired yet) |
| `contracts/ignition/modules/NexusFiMilestone1.ts` | One-shot Sepolia deploy script |
| `contracts/.env` | RPC URL + private key for deployer wallet |
| `frontend/lib/borrower-personas.ts` | Layer 1 — synthetic profiles (Alice/Charlie/Bob) |
| `frontend/lib/risk-explainer.ts` | Layer 2 — XAI scoring engine |
| `frontend/lib/borrower-risk.ts` | Tier decision rules |
| `frontend/lib/loan-terms.ts` | Tier → loan term mapping |
| `frontend/components/RiskExplanationPanel.tsx` | XAI transparency UI |
| `frontend/components/TermTransparencyPanel.tsx` | Term formula UI |
| `frontend/components/PersonaSelector.tsx` | Persona picker |
| `frontend/app/page.tsx` | Main borrower + lender workspace |
| `frontend/app/wagmi-config.ts` | Wagmi chain config (5 connectors, Sepolia + local) |
| `frontend/hooks/useCompliance.ts` | KYC + wallet verification gate |
| `frontend/.env.local` | All frontend env vars (Supabase, RPC, contract addresses) |
| `BUGS.md` | 22 documented bugs — read before production |
| `/Users/afankhan/Developer/assessment.md` | Codebase scoring rubric (all 4 codebases) |
