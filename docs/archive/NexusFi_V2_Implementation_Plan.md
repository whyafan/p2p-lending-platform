# NexusFi Protocol — Version 2 Implementation Plan

**Institution:** K.J. Somaiya School of Engineering, Somaiya Vidyavihar University
**Mentor:** Mr. Gopal Sonune
**Team:**
- Afan Khan — 16010124811
- Atharva Patil — 16010124814
- Viren Rathod — 16010124817
- Siddharth Singh — 16010124818

**Document Version:** 2.0
**Based On:** `Blockchain_P2P_Lending_Platform.md` (V1 Spec)

---

## Table of Contents

1. [Current Implementation Status](#1-current-implementation-status)
2. [Gap Analysis](#2-gap-analysis)
3. [V2 Architecture](#3-v2-architecture)
4. [Phase 1 — Smart Contract Hardening](#4-phase-1--smart-contract-hardening)
5. [Phase 2 — Python FastAPI ML Backend](#5-phase-2--python-fastapi-ml-backend)
6. [Phase 3 — Frontend: Repayment + Lender Dashboard + SHAP UI](#6-phase-3--frontend-repayment--lender-dashboard--shap-ui)
7. [Phase 4 — IPFS Document Storage](#7-phase-4--ipfs-document-storage)
8. [Phase 5 — Event Indexer + Observability](#8-phase-5--event-indexer--observability)
9. [Phase 6 — CI/CD + Security Automation](#9-phase-6--cicd--security-automation)
10. [Execution Order & Dependencies](#10-execution-order--dependencies)
11. [Skills Reference Map](#11-skills-reference-map)
12. [Files to Create / Modify](#12-files-to-create--modify)
13. [Verification Checklist](#13-verification-checklist)
14. [Updated Technology Stack](#14-updated-technology-stack)

---

## 1. Current Implementation Status

### Completion: ~15% of Full Spec

| Layer | Component | Status | Notes |
|-------|-----------|--------|-------|
| **Smart Contracts** | CollateralVault | ✅ Done | Lock, release, liquidate |
| | LoanFactory | ✅ Done | Deploy loans, track IDs |
| | Loan | ✅ Done | Create, fund, repay, cancel |
| | KYCRegistry | ⚠️ Exists, unused | Registry exists — NOT enforced in factory/loan |
| | MockERC20 | ✅ Done | Test tokens (USDC, WETH, WBTC) |
| | PriceOracle | ❌ Missing | No Chainlink integration |
| | LiquidationKeeper | ❌ Missing | Liquidation is demo-only manual trigger |
| **Frontend** | Borrower: Create Loan | ✅ Done | Risk tier, term sheet, collateral calc |
| | Lender: Fund Loan | ✅ Done | Browse open loans, fund by ID |
| | Auth (Supabase) | ✅ Done | Email/password login + signup |
| | KYC Onboarding (Didit) | ✅ Done | 4-step onboarding flow |
| | Wallet Linking | ✅ Done | EIP-191 signature verification |
| | Borrower: Repay Loan | ❌ Missing | No repay UI — lending cycle broken |
| | Lender: Portfolio | ❌ Missing | No funded loans dashboard |
| | SHAP Explanations | ❌ Missing | Text bullets only, no ML |
| | Collateral Health Monitor | ❌ Missing | No real-time LTV warnings |
| | Loan Search / Filtering | ❌ Missing | No marketplace filters |
| **Backend** | FastAPI Server | ❌ Missing | Zero Python code |
| | ML Risk Engine (LightGBM) | ❌ Missing | Client-side heuristic only |
| | SHAP Explainability | ❌ Missing | Not implemented |
| | Event Indexer | ❌ Missing | No on-chain data pipeline |
| **Infrastructure** | IPFS Storage | ❌ Missing | No document storage |
| | Grafana Dashboards | ❌ Missing | Zero observability |
| | CI/CD Pipeline | ❌ Missing | No automation |
| | Slither / Mythril | ❌ Missing | No security scanning |
| **Database** | User, Wallet, KYC, AuditLog | ✅ Done | Prisma + SQLite |
| | Loan records | ❌ Missing | Loans only on-chain, not indexed |

---

## 2. Gap Analysis

### Critical Blockers (break core functionality)
1. **No loan repayment UI** — Borrowers cannot repay. The entire lending cycle is incomplete.
2. **KYC not enforced in contracts** — Anyone can create/fund loans without KYC passing.
3. **No loan deadline** — Funded loans never expire, defaults are impossible.
4. **Liquidation is demo-only** — `markLiquidatedForDemo()` requires manual lender trigger.

### Core Innovation Gaps (define the project's novelty)
5. **No ML Risk Engine** — The entire FastAPI + LightGBM backend is missing (zero Python code).
6. **No SHAP Explainability** — The key differentiating feature from all competitors is absent.
7. **No Chainlink Oracle** — Collateral value is not verified on-chain; price feeds are CoinGecko-only.

### Production Readiness Gaps
8. **No IPFS Storage** — Loan term sheets not stored off-chain.
9. **No Event Indexer** — No pipeline from on-chain events to database.
10. **No Grafana Dashboards** — Zero observability into platform health.
11. **No CI/CD** — No automated testing, no Slither/Mythril security scans.
12. **No Lender Portfolio** — Lenders cannot track their funded loans or interest earned.

---

## 3. V2 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    LAYER 1: FRONTEND                            │
│  Next.js 16 + Wagmi + TailwindCSS                              │
│  • Borrower Dashboard (create loan, repay, collateral health)   │
│  • Lender Dashboard (browse, fund, portfolio, liquidate)        │
│  • SHAP Risk Explanation Panel                                  │
│  • KYC Onboarding (Didit)                                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │ REST + WebSocket
┌──────────────────────────▼──────────────────────────────────────┐
│                 LAYER 2: BACKEND SERVICES                        │
│  FastAPI (Python 3.10+)                                         │
│  • POST /risk/score      → LightGBM risk tier (A/B/C)          │
│  • POST /risk/explain    → SHAP feature importances             │
│  • GET  /events          → Indexed on-chain events              │
│  • GET  /health          → Service health check                 │
│                                                                  │
│  Prisma + SQLite (existing)                                     │
│  • Users, Wallets, KYC, AuditLog, Events                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│              LAYER 3: BLOCKCHAIN (Hardhat / Sepolia)            │
│  Solidity 0.8.28 + Hardhat 3 + OpenZeppelin v5                 │
│  • LoanFactory    — KYC-gated, fee-collecting, oracle-aware     │
│  • Loan           — Deadline-enforced, real liquidation         │
│  • CollateralVault — LTV monitoring, USD valuation              │
│  • PriceOracle    — Chainlink AggregatorV3 wrapper             │
│  • LiquidationKeeper — Chainlink Automation compatible         │
│  • KYCRegistry    — Enforced at factory + loan level           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│              LAYER 4: STORAGE                                    │
│  IPFS via Pinata                                                │
│  • Loan term sheets (JSON)                                      │
│  • CID stored on-chain in LoanFactory                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│              LAYER 5: ORACLE & AUTOMATION                        │
│  Chainlink Price Feeds   — ETH/USD, WBTC/USD real-time prices  │
│  Chainlink Automation    — Auto-trigger liquidations            │
│  MockAggregatorV3        — Local dev price simulation          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│              LAYER 6: OBSERVABILITY                              │
│  Event Indexer (web3.py) → SQLite events table                 │
│  Prometheus              → FastAPI metrics scraping             │
│  Grafana                 → Platform dashboards                  │
│  GitHub Actions          → CI/CD + Slither + Mythril           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Phase 1 — Smart Contract Hardening

**Skills:** `domain-driven-design`, `superpowers:test-driven-development`, `security-review`, `clean-code`
**Priority:** CRITICAL — unblocks Phase 3.1 (repayment UI)

### 1.1 — Enforce KYC at Contract Level

**File:** `contracts/contracts/LoanFactory.sol`

```
Changes:
- Add IKYCRegistry interface import
- Add `IKYCRegistry public kyc` state variable
- Add kyc address to constructor
- Add require(kyc.isKycApproved(msg.sender), "KYC required") in createLoan()

File: contracts/contracts/Loan.sol
- Add require(kyc.isKycApproved(msg.sender), "KYC required") in fund()

File: contracts/scripts/deploy-milestone1.ts
- Deploy KYCRegistry first
- Pass KYCRegistry address to LoanFactory constructor
- Update .env.local with NEXT_PUBLIC_KYC_REGISTRY_ADDRESS
```

### 1.2 — Add Loan Deadline Enforcement

**File:** `contracts/contracts/Loan.sol`

```
New state variable:
  uint256 public deadline;   // set at fund() time

Changes to fund():
  deadline = block.timestamp + (durationDays * 86400);

Changes to repay():
  require(block.timestamp <= deadline, "Loan past deadline");

New LoanState:
  enum LoanState { Requested, Funded, Repaid, Cancelled, Liquidated, Defaulted }

New function checkAndMarkDefault():
  - Callable by anyone
  - require(state == LoanState.Funded)
  - require(block.timestamp > deadline)
  - state = LoanState.Defaulted
  - emit LoanDefaulted(loanId)
```

### 1.3 — Replace Demo Liquidation with Real Liquidation

**File:** `contracts/contracts/Loan.sol`

```
Remove:  markLiquidatedForDemo()

New function liquidate():
  - Callable by lender OR LiquidationKeeper
  - Reads current ETH/USD price from PriceOracle
  - Calculates currentLtv = principal / (collateralAmount × price)
  - require(currentLtv >= liquidationThresholdBps / 10000, "Not undercollateralized")
  - state = LoanState.Liquidated
  - calls vault.liquidateCollateral(loanId, lender)
```

### 1.4 — Add Chainlink Price Oracle

**New file:** `contracts/contracts/PriceOracle.sol`

```solidity
interface AggregatorV3Interface { function latestRoundData() external view returns (...); }

contract PriceOracle {
    AggregatorV3Interface public feed;
    constructor(address _feed) { feed = AggregatorV3Interface(_feed); }
    function getLatestPriceUSD() external view returns (uint256) { ... }  // 8 decimals
}
```

**New file:** `contracts/contracts/MockAggregatorV3.sol` (for local testing)

```solidity
contract MockAggregatorV3 {
    int256 private _price;
    function setPrice(int256 price) external { _price = price; }
    function latestRoundData() external view returns (uint80,int256,uint256,uint256,uint80) {
        return (0, _price, 0, block.timestamp, 0);
    }
}
```

**File:** `contracts/contracts/CollateralVault.sol`

```
New function:
  getCollateralValueUSD(uint256 loanId) → returns (uint256 valueUSD)
  - positions[loanId].amount × oracle.getLatestPriceUSD() / 1e8
```

### 1.5 — Add LiquidationKeeper (Chainlink Automation)

**New file:** `contracts/contracts/LiquidationKeeper.sol`

```solidity
contract LiquidationKeeper {
    ILoanFactory public factory;
    IPriceOracle public oracle;

    // Chainlink Automation interface
    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        // Loop all active loans, find any below liquidation threshold
        // Return loanAddress array as performData
    }

    function performUpkeep(bytes calldata performData) external {
        // Decode loan addresses, call loan.liquidate() for each
    }
}
```

### 1.6 — Add Protocol Fee Mechanism

**File:** `contracts/contracts/LoanFactory.sol`

```
New state:
  uint256 public platformFeeBps = 50;   // 0.5%
  address public feeRecipient;

Change in repay():
  uint256 fee = (principal * platformFeeBps) / 10000;
  feeRecipient.transfer(fee);
  borrower.transfer(collateral);

New owner-only functions:
  setFee(uint256 bps)
  setFeeRecipient(address recipient)
  withdrawFees()
```

### 1.7 — Expand Test Coverage to 90%

**File:** `contracts/test/NexusFiMilestone1.ts`

```
New test cases (TDD — write failing tests first):
  ✓ KYC gate: non-KYC wallet cannot createLoan (expect revert)
  ✓ KYC gate: non-KYC wallet cannot fund loan (expect revert)
  ✓ Repay: borrower repays within deadline → collateral released
  ✓ Deadline: loan past deadline → checkAndMarkDefault() succeeds
  ✓ Deadline: repay after deadline → revert
  ✓ Liquidation: price drop below threshold → liquidate() succeeds
  ✓ Liquidation: healthy LTV → liquidate() reverts
  ✓ Fee: repayment sends 0.5% to feeRecipient
  ✓ Cancel: borrower cancels unfunded loan → ETH returned
  ✓ Interest: verify (principal × APR × tenor/365) calculation
  ✓ Collateral value: MockAggregatorV3 price → getCollateralValueUSD()
  ✓ State machine: all LoanState transitions verified
```

---

## 5. Phase 2 — Python FastAPI ML Backend

**Skills:** `system-design`, `clean-architecture`, `superpowers:test-driven-development`
**Priority:** HIGH — enables SHAP UI, replaces heuristic risk scoring

### 2.1 — Backend Project Structure

```
backend/
├── app/
│   ├── main.py                    # FastAPI app, CORS, router registration
│   ├── routers/
│   │   ├── risk.py                # POST /risk/score
│   │   ├── shap.py                # POST /risk/explain
│   │   └── health.py              # GET /health
│   ├── models/
│   │   ├── risk_model.py          # LightGBM inference wrapper
│   │   └── shap_model.py          # SHAP TreeExplainer wrapper
│   ├── schemas/
│   │   └── borrower.py            # Pydantic request/response models
│   └── ml/
│       ├── train.py               # Training script (run once)
│       ├── features.py            # Feature engineering functions
│       └── artifacts/             # Saved .pkl model files (gitignored)
├── indexer/
│   └── main.py                    # On-chain event subscriber (Phase 5)
├── tests/
│   ├── test_risk.py
│   └── test_shap.py
├── requirements.txt
├── Dockerfile
└── .env
```

### 2.2 — Pydantic Schemas

**File:** `backend/app/schemas/borrower.py`

```python
class BorrowerInput(BaseModel):
    wallet_age_days: int          # Days since first on-chain tx
    prior_loans_repaid: int       # Count of repaid loans on platform
    prior_loans_defaulted: int    # Count of defaulted loans
    principal_usd: float          # Requested loan amount in USD
    tenor_days: int               # 30 / 60 / 90
    collateral_ratio: float       # collateralValueUSD / principalUSD
    on_chain_balance_usd: float   # Wallet ETH balance in USD

class RiskScoreResponse(BaseModel):
    tier: Literal["A", "B", "C"]
    confidence: float             # 0.0 – 1.0
    reasons: list[str]            # Human-readable feature explanations

class SHAPResponse(BaseModel):
    tier: str
    feature_importances: list[FeatureImportance]

class FeatureImportance(BaseModel):
    feature: str                  # Human-readable label
    raw_value: float              # Input value
    shap_value: float             # SHAP contribution
    direction: Literal["increases_risk", "decreases_risk"]
```

### 2.3 — LightGBM Risk Model

**File:** `backend/app/ml/train.py`

```
Training data: 1000 synthetic borrowers (balanced across tiers A/B/C)

Features:
  wallet_age_days       → older = less risky
  prior_loans_repaid    → more repaid = Tier A
  prior_loans_defaulted → any default = pushes to C
  principal_usd         → higher = more risk
  tenor_days            → longer = more risk
  collateral_ratio      → higher = safer
  on_chain_balance_usd  → higher = safer

Target: tier (0=A, 1=B, 2=C)

Model: lightgbm.LGBMClassifier(
    n_estimators=200,
    max_depth=6,
    learning_rate=0.05,
    num_leaves=31,
    class_weight='balanced'
)

Save: joblib.dump(model, 'artifacts/risk_model.pkl')
      joblib.dump(label_encoder, 'artifacts/label_encoder.pkl')

Target metrics (per spec):
  AUC ≥ 0.75
  Brier score ≤ 0.18
```

### 2.4 — SHAP Explainability

**File:** `backend/app/models/shap_model.py`

```python
explainer = shap.TreeExplainer(model)

def explain(input_features: BorrowerInput) -> SHAPResponse:
    X = feature_vector(input_features)
    shap_values = explainer.shap_values(X)   # shape: (n_classes, n_features)
    class_shap = shap_values[predicted_class]

    return SHAPResponse(
        tier=predicted_tier,
        feature_importances=[
            FeatureImportance(
                feature=FEATURE_LABELS[i],
                raw_value=X[i],
                shap_value=class_shap[i],
                direction="increases_risk" if class_shap[i] > 0 else "decreases_risk"
            )
            for i in sorted_by_abs_shap
        ]
    )
```

**Feature labels mapping:**
```python
FEATURE_LABELS = {
    "wallet_age_days":       "Wallet age",
    "prior_loans_repaid":    "Repayment history",
    "prior_loans_defaulted": "Default history",
    "principal_usd":         "Loan size",
    "tenor_days":            "Loan duration",
    "collateral_ratio":      "Collateral coverage",
    "on_chain_balance_usd":  "Wallet balance"
}
```

### 2.5 — Connect Frontend to ML Backend

**File:** `frontend/lib/borrower-risk.ts`

```typescript
// Replace current heuristic with API call
export async function fetchRiskTier(input: BorrowerInput): Promise<RiskTierResult> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_ML_API_URL}/risk/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    })
    return await res.json()
  } catch {
    return computeHeuristicTier(input)  // fallback if backend unreachable
  }
}
```

**Add to `frontend/.env.local`:**
```
NEXT_PUBLIC_ML_API_URL=http://localhost:8000
```

**Run backend:**
```bash
cd backend
pip install -r requirements.txt
python app/ml/train.py        # train + save model once
uvicorn app.main:app --reload --port 8000
```

---

## 6. Phase 3 — Frontend: Repayment + Lender Dashboard + SHAP UI

**Skills:** `frontend-design`, `refactoring-ui`, `microinteractions`, `ux-heuristics`
**Priority:** CRITICAL (3.1) / HIGH (3.2–3.6)

### 3.1 — Loan Repayment UI (Critical Blocker)

**File:** `frontend/app/page.tsx` — Add to Borrower workspace
**New hook:** `frontend/hooks/useRepayLoan.ts`

```
New section: "My Active Loans"

For each Funded loan where borrower == connectedWallet:
  Display:
    • Loan ID, principal amount, APR
    • Interest due (calculated from contract)
    • Total repayment = principal + interest
    • Deadline: countdown timer (DD:HH:MM:SS)
    • Current collateral value (USD) + health bar
    • Status badge: FUNDED / DEFAULTED / REPAID

  Action:
    • "Repay Loan" button → useWriteContract({ functionName: 'repay' })
    • msg.value = totalRepaymentDue()
    • On success: toast "Loan repaid! Collateral released." + refresh
    • On fail: toast with error message

Hook: useRepayLoan(loanAddress)
  Returns: { repay, isPending, isSuccess, error, totalDue }
```

### 3.2 — Lender Portfolio Dashboard

**File:** `frontend/app/page.tsx` — Add to Lender workspace
**New hook:** `frontend/hooks/useLenderPortfolio.ts`

```
New section: "My Funded Loans"

For each loan where lender == connectedWallet:
  Display:
    • Borrower address (truncated), risk tier badge
    • Principal lent, APR, tenor, maturity date
    • Status: FUNDED / REPAID / DEFAULTED / LIQUIDATED
    • If Repaid: interest earned = totalRepayment - principal
    • Collateral health (live LTV %, color-coded)
    • Liquidation price (ETH price at which LTV = threshold)

  Actions:
    • "Liquidate" button (visible if LTV ≥ liquidationThreshold)
      → calls loan.liquidate()
    • "View on Explorer" → Hardhat local explorer or Sepolia Etherscan

Summary row:
  • Total lent, total earned, active positions, avg APR
```

### 3.3 — SHAP Risk Explanation Panel

**File:** `frontend/app/page.tsx` — Replace current risk tier text bullets

```
Current (remove):
  • "New wallet → Tier C"
  • "Large principal → downgraded to C"

New SHAP panel:
  ┌─────────────────────────────────────────┐
  │  Risk Tier C  ·  High Risk  ·  82% confidence      │
  ├─────────────────────────────────────────┤
  │  What drove this score:                            │
  │                                                    │
  │  Repayment history  ████████████  +0.42 ↑ risk   │
  │  Default history    ██████        +0.28 ↑ risk   │
  │  Loan size          ████          +0.18 ↑ risk   │
  │  Wallet balance     ██            -0.12 ↓ risk   │
  │  Wallet age         █             -0.08 ↓ risk   │
  └─────────────────────────────────────────┘

Implementation:
  - Horizontal bar chart using CSS flex (no chart library needed)
  - Green bars = decreases risk, Red bars = increases risk
  - Bar width = abs(shap_value) normalized to max
  - Tooltip: "This factor [increased/decreased] your risk score"
  - Show spinner while fetching from ML backend
  - Fallback: current text bullets if backend unreachable
```

### 3.4 — Real-Time Collateral Health Monitor

**New hook:** `frontend/hooks/useCollateralHealth.ts`

```typescript
// Poll every 30 seconds
function useCollateralHealth(loanId: bigint, principal: bigint, collateralAmount: bigint) {
  const { data: ethPrice } = useTokenPrices()  // existing hook

  const collateralValueUSD = collateralAmount * ethPrice
  const currentLtv = principal / collateralValueUSD

  const status =
    currentLtv >= liquidationThreshold ? 'danger' :
    currentLtv >= liquidationThreshold * 0.85 ? 'warning' : 'safe'

  return { currentLtv, liquidationLtv: liquidationThreshold, status, liquidationPriceETH }
}

// UI: Health bar
// Green (safe) → Amber (warning at 85%) → Red (danger at 100%)
// Warning: toast "⚠️ Collateral approaching liquidation threshold"
// Danger: toast "🚨 Collateral below safe level — at risk of liquidation"
```

### 3.5 — Loan Marketplace Filtering

**File:** `frontend/app/page.tsx` — Lender browse panel

```
Filter controls (above loan list):
  • Risk Tier: [All] [A] [B] [C]  (pill buttons)
  • Tenor: [All] [30d] [60d] [90d]
  • Principal: $0 ──●──────── $100k  (range slider)
  • APR: [Any] [<10%] [10-15%] [>15%]

Sort controls:
  Sort by: [APR ↓] [Principal ↓] [Newest] [Deadline soonest]

Pagination:
  Show 10 loans per page, prev/next buttons
  "Showing 1-10 of 43 open requests"
```

### 3.6 — UI Polish & Mobile Responsiveness

**Skills:** `refactoring-ui`, `ux-heuristics`, `microinteractions`

```
Loading states:
  • Skeleton cards while fetching loans (instead of blank space)
  • Spinner on all buttons during tx pending

Toast notifications:
  • Tx submitted: "Transaction submitted, waiting for confirmation..."
  • Tx confirmed: "✓ [Action] confirmed!"
  • Tx failed: "Transaction failed: [error reason]"

Mobile responsiveness:
  • Term sheet table → stacked cards on mobile (< 640px)
  • Loan list → single column on mobile
  • Wallet address → always truncated to 6+4 chars

Empty states:
  • Borrower "My Active Loans" empty: "No active loans. Create one below."
  • Lender "My Funded Loans" empty: "You haven't funded any loans yet."
  • Loan list empty: "No open loan requests match your filters."

Countdown timer for deadlines:
  • "23h 14m remaining" → "⚠️ 2h 3m remaining" (amber when < 24h)
  • "Expired" badge (red) when past deadline
```

---

## 7. Phase 4 — IPFS Document Storage

**Skills:** `system-design`, `clean-architecture`
**Priority:** MEDIUM

### 4.1 — Pinata IPFS Integration

**New file:** `frontend/lib/ipfs.ts`

```typescript
// Pin loan term sheet to IPFS on loan creation
export async function pinTermSheet(termSheet: LoanTermSheet): Promise<string> {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PINATA_JWT}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pinataContent: termSheet })
  })
  const { IpfsHash } = await res.json()
  return IpfsHash  // CID like "Qm..."
}
```

**New API route:** `frontend/app/api/ipfs/route.ts`

```typescript
// POST /api/ipfs — server-side to keep Pinata JWT secret
export async function POST(req: Request) {
  const termSheet = await req.json()
  const cid = await pinTermSheet(termSheet)
  return Response.json({ cid })
}
```

**LoanTermSheet structure:**
```typescript
interface LoanTermSheet {
  version: "1.0"
  createdAt: string              // ISO timestamp
  borrowerAddress: string
  principalUSD: number
  collateralAsset: string
  collateralAmountWei: string
  aprBps: number
  tenorDays: number
  maxLtvBps: number
  liquidationBufferBps: number
  riskTier: "A" | "B" | "C"
  riskConfidence: number
  shapExplanations: FeatureImportance[]
}
```

**Add to `frontend/.env.local`:**
```
PINATA_JWT=your_pinata_jwt_token
NEXT_PUBLIC_IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs
```

**Contract change:** `contracts/contracts/LoanFactory.sol`
```solidity
// Add to LoanTerms struct
bytes32 public termSheetCid;   // IPFS CID stored on-chain

// Add to createLoan()
event LoanCreated(uint256 indexed loanId, address indexed loanContract, bytes32 termSheetCid);
```

**UI:** "View Term Sheet ↗" link on every loan card → opens `${IPFS_GATEWAY}/${cid}` in new tab.

---

## 8. Phase 5 — Event Indexer + Observability

**Skills:** `system-design`, `ddia-systems`, `release-it`
**Priority:** MEDIUM

### 5.1 — On-Chain Event Indexer

**New file:** `backend/indexer/main.py`

```python
from web3 import Web3

w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8545"))

EVENTS_TO_INDEX = [
    "LoanCreated", "LoanFunded", "LoanRepaid",
    "LoanDefaulted", "LoanLiquidated", "LoanCancelled",
    "CollateralLocked", "CollateralReleased"
]

def index_events():
    # Poll for new blocks every 2 seconds
    # For each new block, scan factory + vault events
    # Write to SQLite: events(id, event_type, loan_id, wallet, amount_wei, timestamp, tx_hash, block_number)

# Run: python -m backend.indexer.main
```

**FastAPI route:** `backend/app/routers/events.py`
```
GET /events?loanId=&type=&wallet=&from=&to=&limit=50
→ Returns paginated event list for UI and dashboards
```

**Add to Prisma schema:** `frontend/prisma/schema.prisma`
```prisma
model OnChainEvent {
  id         Int      @id @default(autoincrement())
  eventType  String
  loanId     Int
  wallet     String
  amountWei  String?
  txHash     String   @unique
  blockNumber Int
  timestamp  DateTime
}
```

### 5.2 — Grafana + Prometheus Setup

**New file:** `backend/docker-compose.yml`

```yaml
services:
  fastapi:
    build: .
    ports: ["8000:8000"]

  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports: ["9090:9090"]

  grafana:
    image: grafana/grafana
    ports: ["3001:3000"]
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
```

**Dashboard panels:**
| Dashboard | Metric | Visualization |
|-----------|--------|---------------|
| Platform Overview | Total loans created | Stat card |
| Platform Overview | Total volume (ETH) | Stat card |
| Platform Overview | Active loans | Stat card |
| Platform Overview | Default rate | Gauge |
| Risk Distribution | Tier A/B/C breakdown | Pie chart |
| Liquidation Monitor | Loans near threshold | Table |
| ML Performance | /risk/score latency (p50/p95) | Line chart |
| ML Performance | Tier distribution over time | Stacked bar |
| Event Timeline | All platform events | Timeline |

**Run Grafana:** `docker compose up -d` → open `http://localhost:3001`

---

## 9. Phase 6 — CI/CD + Security Automation

**Skills:** `security-review`, `release-it`, `superpowers:verification-before-completion`
**Priority:** MEDIUM (implement after Phase 1 + 2)

### 6.1 — GitHub Actions CI Pipeline

**New file:** `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]

jobs:
  test-contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd contracts && npm ci && npx hardhat test

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd frontend && npm ci && npm run build && npm run lint

  test-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: cd backend && pip install -r requirements.txt && pytest
```

### 6.2 — Slither Static Analysis

**New file:** `.github/workflows/slither.yml`

```yaml
name: Slither
on: [push]

jobs:
  slither:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: crytic/slither-action@v0.4.0
        with:
          target: contracts/contracts/
          fail-on: high
          slither-args: --exclude-informational
```

### 6.3 — Mythril Symbolic Execution

**New file:** `.github/workflows/mythril.yml`

```yaml
name: Mythril
on: [push]

jobs:
  mythril:
    runs-on: ubuntu-latest
    container: mythril/myth:latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          myth analyze contracts/contracts/Loan.sol --solc-version 0.8.28
          myth analyze contracts/contracts/LoanFactory.sol --solc-version 0.8.28
          myth analyze contracts/contracts/CollateralVault.sol --solc-version 0.8.28
```

---

## 10. Execution Order & Dependencies

```
PARALLEL TRACK A                    PARALLEL TRACK B
────────────────────                ────────────────────
Phase 1: Smart Contracts            Phase 2: ML Backend
  1.1 KYC enforcement                 2.1 FastAPI setup
  1.2 Deadline logic                  2.2 LightGBM model
  1.3 Real liquidation                2.3 SHAP service
  1.4 Chainlink oracle                2.4 Connect frontend
  1.5 Protocol fees
  1.6 Test coverage (90%)
         │                                    │
         └──────────────┬─────────────────────┘
                        ▼
              Phase 3: Frontend
                3.1 Repayment UI   ← unblocked by Phase 1
                3.2 Lender portfolio
                3.3 SHAP panel     ← unblocked by Phase 2
                3.4 Collateral monitor
                3.5 Marketplace filters
                3.6 UI polish
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
     Phase 4         Phase 5       Phase 6
     IPFS            Indexer       CI/CD
     Storage         + Grafana     + Slither
```

**Can start immediately in parallel:**
- Phase 1 (contracts team) + Phase 2 (backend/ML team)

**Blocked until Phase 1 complete:**
- Phase 3.1 (repayment UI needs real `repay()` + deadline)
- Phase 6.2 Slither (needs final contract code)

**Blocked until Phase 2 complete:**
- Phase 3.3 (SHAP panel needs ML API)

---

## 11. Skills Reference Map

| Phase | Skills to Invoke |
|-------|-----------------|
| **Phase 1 — Contracts** | `domain-driven-design` — model loan lifecycle as domain entities |
| | `superpowers:test-driven-development` — write failing tests before implementation |
| | `security-review` — audit all contract changes before deployment |
| | `clean-code` — small focused functions, clear naming |
| **Phase 2 — ML Backend** | `system-design` — design FastAPI service with clear boundaries |
| | `clean-architecture` — separate routers / models / schemas / ml layers |
| | `superpowers:test-driven-development` — pytest for all endpoints |
| | `release-it` — circuit breaker if ML service unreachable |
| **Phase 3 — Frontend** | `frontend-design` — production-grade component structure |
| | `refactoring-ui` — fix visual hierarchy, spacing, typography |
| | `microinteractions` — loading states, toast notifications, countdown timers |
| | `ux-heuristics` — audit against Nielsen's 10 heuristics |
| **Phase 4 — IPFS** | `system-design` — design storage flow (frontend → API → Pinata → on-chain) |
| | `clean-architecture` — keep Pinata JWT server-side only |
| **Phase 5 — Observability** | `system-design` — event pipeline architecture |
| | `ddia-systems` — design event store for queryability |
| | `release-it` — health checks, graceful degradation |
| **Phase 6 — CI/CD** | `security-review` — configure Slither fail conditions |
| | `release-it` — production readiness checklist |
| | `superpowers:verification-before-completion` — gate before each merge |
| **Execution methodology** | `superpowers:executing-plans` — step-by-step task tracking |
| | `superpowers:dispatching-parallel-agents` — run Phase 1 + Phase 2 simultaneously |
| | `superpowers:subagent-driven-development` — delegate isolated tasks |
| **Code quality** | `simplify` — review after each phase for bloat |
| | `superpowers:requesting-code-review` — structured review at phase completion |

---

## 12. Files to Create / Modify

### Smart Contracts
| File | Action | Changes |
|------|--------|---------|
| `contracts/contracts/Loan.sol` | Modify | Add deadline, Defaulted state, real liquidate(), remove markLiquidatedForDemo() |
| `contracts/contracts/LoanFactory.sol` | Modify | Add KYC gate, fee mechanism, oracle reference, termSheetCid |
| `contracts/contracts/CollateralVault.sol` | Modify | Add getCollateralValueUSD(), oracle integration |
| `contracts/contracts/KYCRegistry.sol` | Modify | Add isKycApproved() view function for interface |
| `contracts/contracts/PriceOracle.sol` | **CREATE** | Chainlink AggregatorV3 wrapper |
| `contracts/contracts/LiquidationKeeper.sol` | **CREATE** | Chainlink Automation compatible keeper |
| `contracts/contracts/MockAggregatorV3.sol` | **CREATE** | Local dev price mock |
| `contracts/test/NexusFiMilestone1.ts` | Modify | Expand to 12+ test cases, 90% coverage |
| `contracts/scripts/deploy-milestone1.ts` | Modify | Deploy KYCRegistry + PriceOracle + Keeper |

### Backend (all NEW)
| File | Description |
|------|-------------|
| `backend/app/main.py` | FastAPI app entry point |
| `backend/app/routers/risk.py` | POST /risk/score endpoint |
| `backend/app/routers/shap.py` | POST /risk/explain endpoint |
| `backend/app/routers/health.py` | GET /health endpoint |
| `backend/app/routers/events.py` | GET /events endpoint |
| `backend/app/models/risk_model.py` | LightGBM inference wrapper |
| `backend/app/models/shap_model.py` | SHAP TreeExplainer wrapper |
| `backend/app/schemas/borrower.py` | Pydantic request/response schemas |
| `backend/app/ml/train.py` | Model training script |
| `backend/app/ml/features.py` | Feature engineering functions |
| `backend/indexer/main.py` | On-chain event subscriber |
| `backend/requirements.txt` | Python dependencies |
| `backend/Dockerfile` | Container definition |
| `backend/docker-compose.yml` | FastAPI + Prometheus + Grafana |
| `backend/prometheus.yml` | Prometheus scrape config |

### Frontend
| File | Action | Changes |
|------|--------|---------|
| `frontend/app/page.tsx` | Modify | Add repay UI, SHAP panel, lender portfolio, filtering |
| `frontend/hooks/useRepayLoan.ts` | **CREATE** | Wagmi hook for repay() contract call |
| `frontend/hooks/useCollateralHealth.ts` | **CREATE** | Live LTV monitoring hook |
| `frontend/hooks/useLenderPortfolio.ts` | **CREATE** | Funded loans tracker hook |
| `frontend/lib/borrower-risk.ts` | Modify | Replace heuristic with ML API call + fallback |
| `frontend/lib/ipfs.ts` | **CREATE** | Pinata IPFS pinning utility |
| `frontend/app/api/ipfs/route.ts` | **CREATE** | Server-side IPFS API route |
| `frontend/prisma/schema.prisma` | Modify | Add OnChainEvent model |
| `frontend/.env.local` | Modify | Add NEXT_PUBLIC_ML_API_URL, PINATA_JWT |

### CI/CD (all NEW)
| File | Description |
|------|-------------|
| `.github/workflows/ci.yml` | Main CI: contracts + frontend + backend tests |
| `.github/workflows/slither.yml` | Slither static analysis |
| `.github/workflows/mythril.yml` | Mythril symbolic execution |

---

## 13. Verification Checklist

### Phase 1 — Contracts
- [ ] `npx hardhat test` → all tests green, ≥90% branch coverage
- [ ] Non-KYC wallet cannot `createLoan()` → reverts with "KYC required"
- [ ] Non-KYC wallet cannot `fund()` → reverts with "KYC required"
- [ ] Borrower repays within deadline → collateral released, status = Repaid
- [ ] `checkAndMarkDefault()` succeeds after deadline passes
- [ ] `repay()` after deadline → reverts with "Loan past deadline"
- [ ] MockAggregatorV3 price drop → `liquidate()` succeeds
- [ ] Healthy LTV → `liquidate()` reverts with "Not undercollateralized"
- [ ] 0.5% fee sent to feeRecipient on repayment
- [ ] `getCollateralValueUSD()` returns correct USD value

### Phase 2 — ML Backend
- [ ] `python app/ml/train.py` → model saved to `artifacts/risk_model.pkl`
- [ ] `uvicorn app.main:app` → server running on port 8000
- [ ] `GET /health` → `{"status": "ok"}`
- [ ] `POST /risk/score` with Tier A inputs → returns `{"tier": "A", "confidence": 0.xx}`
- [ ] `POST /risk/explain` → returns list of feature_importances with shap_values
- [ ] Frontend risk tier panel shows ML tier (not heuristic) when backend is up
- [ ] Frontend falls back to heuristic when backend is unreachable

### Phase 3 — Frontend
- [ ] Borrower can see "My Active Loans" with funded loan listed
- [ ] "Repay Loan" button sends correct msg.value = principal + interest
- [ ] After repay tx: status shows "Repaid", toast shown, collateral released
- [ ] Lender sees "My Funded Loans" with correct loan details
- [ ] Lender "Liquidate" button appears when LTV ≥ threshold
- [ ] SHAP bar chart renders with correct green/red bars
- [ ] Collateral health bar turns amber at 85% of liquidation threshold
- [ ] Collateral health bar turns red at 100% of liquidation threshold
- [ ] Loan filters work correctly (by tier, tenor, principal range)
- [ ] UI is usable on 375px mobile width

### Phase 4 — IPFS
- [ ] Loan creation pins term sheet to IPFS → CID returned
- [ ] CID stored in LoanFactory event
- [ ] "View Term Sheet" link opens valid IPFS gateway URL

### Phase 5 — Observability
- [ ] Indexer picks up `LoanCreated` event and writes to events table
- [ ] `GET /events?type=LoanFunded` returns correct events
- [ ] Grafana loads at `http://localhost:3001`
- [ ] Platform Overview dashboard shows real loan count

### Phase 6 — CI/CD
- [ ] GitHub Actions CI pipeline green on all 3 jobs
- [ ] Slither finds zero High/Critical issues
- [ ] Mythril reports zero vulnerabilities

---

## 14. Updated Technology Stack

| Layer | Technology | Version | Status |
|-------|-----------|---------|--------|
| **Smart Contracts** | Solidity | 0.8.28 | ✅ Existing |
| | Hardhat | 3.3.0 | ✅ Existing |
| | OpenZeppelin | v5.6.1 | ✅ Existing |
| | Chainlink AggregatorV3 | latest | ❌ To add |
| | Chainlink Automation | latest | ❌ To add |
| **Frontend** | Next.js | 16.2.2 | ✅ Existing |
| | React | 19.2.4 | ✅ Existing |
| | Wagmi | 2.19.5 | ✅ Existing |
| | TailwindCSS | v4 | ✅ Existing |
| | Viem | 2.47.10 | ✅ Existing |
| **Backend** | FastAPI | 0.115+ | ❌ To build |
| | Python | 3.10+ | ❌ To build |
| | LightGBM | 4.x | ❌ To build |
| | XGBoost | 2.x | ❌ To build |
| | SHAP | 0.46+ | ❌ To build |
| | Uvicorn | latest | ❌ To build |
| **Database** | SQLite + Prisma | 6.19.3 | ✅ Existing |
| | web3.py (indexer) | 6.x | ❌ To add |
| **Storage** | IPFS via Pinata | latest | ❌ To add |
| **Auth** | Supabase | 2.x | ✅ Existing |
| | Didit KYC | v2 | ✅ Existing |
| **Observability** | Prometheus | latest | ❌ To add |
| | Grafana | latest | ❌ To add |
| | Docker Compose | v2 | ❌ To add |
| **Security** | Slither | latest | ❌ To add |
| | Mythril | latest | ❌ To add |
| **CI/CD** | GitHub Actions | latest | ❌ To add |

---

*NexusFi Protocol V2 — Implementation Plan*
*Generated: 2026-05-16*
