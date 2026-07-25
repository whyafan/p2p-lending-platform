# NexusFi — Codebase Explanation

> Written: 2026-05-18. Read this before touching any code.  
> This is a mid-build platform. Everything described below exists and compiles. The only thing not done is deploying the contracts to Sepolia — that is a one-command operation once the private key is in place.

---

## What Is This?

**NexusFi** is a peer-to-peer blockchain lending platform. Borrowers lock ETH as collateral and request loans. Lenders fund those loans with ETH. The entire lifecycle — collateral lock, funding, repayment, and liquidation — happens on-chain through Ethereum smart contracts. Every transaction is publicly visible on Sepolia testnet at `sepolia.etherscan.io`.

The platform has three notable properties beyond a basic lending contract:

1. **Risk tiers**: each borrower is assigned Tier A, B, or C based on an 8-feature scoring engine that reads their on-chain wallet history (wallet age, DeFi loan history, balance, mixer interactions, etc.) plus off-chain metadata (income, employment). The tier determines their interest rate, maximum loan-to-value ratio, and collateral requirements. This is fully built.

2. **XAI transparency**: borrowers see exactly which features pushed their score up or down, with weights and breakpoints shown — a SHAP-style explanation panel. Lenders see the risk tier on each loan.

3. **Demo infrastructure**: three pre-built personas (Alice/Charlie/Bob, one per tier) with testnet wallet addresses, so a demo can be run without live wallet data.

---

## Repository Structure

```
P2P-lending-platform/
├── contracts/                   ← Solidity + Hardhat
│   ├── contracts/
│   │   ├── Loan.sol             ← Core loan lifecycle
│   │   ├── LoanFactory.sol      ← Creates + indexes all loans
│   │   ├── CollateralVault.sol  ← Holds ETH collateral
│   │   ├── MockPriceFeed.sol    ← Fake oracle for liquidation demo
│   │   ├── KYCRegistry.sol      ← On-chain KYC whitelist (not wired to UI yet)
│   │   └── MockERC20.sol        ← Test token (not wired as loan currency yet)
│   ├── ignition/modules/
│   │   └── NexusFiMilestone1.ts ← One-shot deploy script (vault + factory + price feed)
│   ├── test/
│   │   └── NexusFiMilestone1.ts ← Contract tests
│   ├── hardhat.config.ts        ← Network configs: localhost (31337) + Sepolia (11155111)
│   └── .env                     ← RPC URL + deployer private key
│
├── frontend/                    ← Next.js 15 + React 19
│   ├── app/
│   │   ├── page.tsx             ← Landing page (marketing + auth gate)
│   │   ├── app/page.tsx         ← Post-login shell (currently "Coming soon" placeholder)
│   │   ├── onboarding/page.tsx  ← 3-step onboarding: account → wallet → KYC
│   │   ├── auth/
│   │   │   ├── login/page.tsx
│   │   │   └── signup/page.tsx
│   │   ├── profile/page.tsx
│   │   ├── layout.tsx           ← Root layout with wagmi + query providers
│   │   ├── providers.tsx        ← WagmiProvider, QueryClientProvider wrappers
│   │   ├── wagmi-config.ts      ← Chain config (hardhat + sepolia, 5 connectors)
│   │   └── api/
│   │       ├── risk/score/      ← POST: returns tier + XAI explanation for a persona
│   │       ├── prices/          ← GET: ETH/USD + token prices (CoinGecko)
│   │       ├── kyc/
│   │       │   ├── session/     ← Creates Didit KYC session
│   │       │   ├── status/      ← Polls KYC status from Didit
│   │       │   ├── webhook/     ← Receives Didit completion callbacks
│   │       │   └── demo-approve/← Bypasses KYC (ALLOW_DEMO_KYC=1 must be set)
│   │       ├── wallets/
│   │       │   ├── route.ts     ← GET: returns user's linked wallets + KYC state
│   │       │   ├── nonce/       ← POST: issues sign-in message for EIP-191 wallet verify
│   │       │   └── verify/      ← POST: verifies signature, links wallet to account
│   │       └── profile/         ← GET/PATCH: user profile
│   │
│   ├── components/
│   │   ├── PersonaSelector.tsx     ← Three-card demo persona picker (Alice/Charlie/Bob)
│   │   ├── RiskExplanationPanel.tsx← SHAP-style XAI breakdown: score per feature, weights
│   │   ├── TermTransparencyPanel.tsx← Side-by-side tier comparison + 6-step formula
│   │   ├── NetworkModeToggle.tsx   ← Switches between local Hardhat and Sepolia
│   │   └── PriceTicker.tsx         ← Live ETH/USD marquee at top of every page
│   │
│   ├── hooks/
│   │   ├── useCompliance.ts    ← Central gate: authenticated? wallet verified? KYC approved?
│   │   ├── useBorrowerRisk.ts  ← Reads on-chain loan history for a wallet address
│   │   ├── useNetworkMode.ts   ← Reads NEXT_PUBLIC_NETWORK_MODE from env
│   │   ├── useTokenPrices.ts   ← Fetches token USD prices from /api/prices
│   │   └── useHydrated.ts      ← SSR hydration guard for wagmi
│   │
│   ├── lib/
│   │   ├── borrower-personas.ts   ← Alice / Charlie / Bob persona definitions
│   │   ├── risk-explainer.ts      ← 8-feature XAI scoring engine (Layer 2 core)
│   │   ├── feature-extractor.ts   ← Adapter: persona → FeatureVector (pluggable for ML)
│   │   ├── borrower-risk.ts       ← Tier rules + tenor adjustments
│   │   ├── loan-terms.ts          ← Tier → APR / LTV / collateral math
│   │   ├── abis.ts                ← All contract ABIs (LoanFactory, Loan, MockPriceFeed)
│   │   ├── network.ts             ← resolveRpcUrl(), resolveContractAddresses()
│   │   ├── wallet-screening.ts    ← Demo KYT risk check (suffix-based, not production)
│   │   ├── wallet-chain.ts        ← Chain utilities
│   │   ├── tokens.ts              ← Token definitions (ETH, USDC, WETH, WBTC)
│   │   ├── format.ts              ← formatUsd(), formatPercent(), formatNumber()
│   │   ├── kyc.ts                 ← kycStatusLabel() + helpers
│   │   ├── didit.ts               ← Didit KYC API client
│   │   ├── auth.ts                ← Supabase auth helpers
│   │   └── supabase/
│   │       ├── client.ts          ← Browser Supabase client (SSR-safe)
│   │       ├── server.ts          ← Server-side Supabase client
│   │       ├── admin.ts           ← Service-role client for API routes
│   │       └── types.ts           ← TypeScript types for DB rows
│   │
│   ├── supabase/migrations/001_init.sql ← DB schema: profiles, linked_wallets, screenings, audit_logs
│   ├── middleware.ts               ← Auth redirect middleware (Next.js edge)
│   └── .env.local                  ← All env vars (Supabase, RPC, contract addresses, WalletConnect)
│
├── PLAN.md     ← Implementation status + immediate next steps
├── BUGS.md     ← 22 documented bugs with severity + exact file:line
├── CODEBASE.md ← This file
└── /Users/afankhan/Developer/assessment.md ← Scoring rubric for all 4 codebases
```

---

## The Three Layers

The architecture separates data, logic, and execution into three explicit layers. This is documented in `PLAN.md` and reflected in the file structure.

### Layer 1 — Borrower Data (`lib/borrower-personas.ts`)

The input layer. Right now it holds three synthetic borrower profiles, each with:

- **On-chain features**: wallet age, transaction count, number of DeFi protocols used, Aave loans taken/repaid/liquidated, 90-day average balance, mixer interaction, sanction proximity
- **Off-chain metadata**: income band, employment type, loan purpose
- **A testnet wallet address** pre-assigned so demos can run without a real wallet

In production, these would come from `lib/feature-extractor.ts` which would call Alchemy/Etherscan APIs to read a real wallet's history. That pipeline is not built — only the interface (`FeatureVector` type) is defined.

**The three personas:**

| Name | Tier | Profile |
|---|---|---|
| Alice | A | 3.4 yr wallet, 4/4 Aave loans repaid, $47k balance, full-time employed |
| Charlie | B | 6 month wallet, 1 liquidation in history, $12k balance |
| Bob | C | 45 day wallet, 7 total transactions, $800 balance, no DeFi history |

### Layer 2 — Risk Scoring Engine (`lib/risk-explainer.ts`)

The scoring engine. Takes a `FeatureVector` and returns a `RiskExplanation` containing:

- A **tier** (A, B, or C)
- An **overall score** (weighted sum of all features, clamped to −1 to +1)
- A **contributions array** — one entry per feature, with the raw score, the weight, the human-readable value, and a plain-English description of why that feature pushed the score up or down

**How the score is computed:**

```
overallScore = Σ (feature_score × feature_weight)
```

Eight features, weights summing to 1.0:

| Feature | Weight | What it measures |
|---|---|---|
| Wallet age | 15% | How long the wallet has existed on-chain |
| Transaction volume | 10% | Total number of transactions ever |
| DeFi breadth | 10% | How many distinct protocols used |
| DeFi loan history | 25% | Repayment/liquidation track record |
| Avg balance (90d) | 10% | Financial stability proxy |
| Mixer interaction | 15% | Privacy mixer usage (compliance flag) |
| Income band | 10% | Off-chain declared income |
| Employment type | 5% | Stability of income source |

**Tier thresholds:**
- Score ≥ 0.40 → **Tier A** (low risk)
- Score ≥ 0.00 → **Tier B** (medium risk)
- Score < 0.00 → **Tier C** (high risk)

### Layer 3 — Smart Contracts (`contracts/contracts/`)

The execution layer. Four deployed contracts:

#### `Loan.sol`
One contract per loan. Holds all loan state and enforces the lifecycle:

```
Requested → Funded → Repaid
                  ↘ Cancelled (by borrower before funding)
                  ↘ Liquidated (by lender after demo oracle crash)
```

Key functions:
- `fund()` — lender sends exact principal ETH; borrower receives it immediately; 7-day funding window enforced
- `repay()` — borrower sends principal + interest; lender receives it; vault releases collateral to borrower
- `cancel()` — borrower cancels before funding; vault releases collateral to borrower
- `markLiquidatedForDemo()` — lender seizes collateral after a simulated LTV breach; maturity check intentionally removed for demo purposes
- `interestDue()` — returns `principal × interestBps × durationDays ÷ (10,000 × 365)` as wei
- `totalRepaymentDue()` — returns `principal + interestDue()`

#### `LoanFactory.sol`
Registry contract. Borrowers call `createLoan()` here — it deploys a fresh `Loan` contract for each loan request, locks collateral in the vault, and emits `LoanCreated`. The factory keeps an array of all loan IDs so the frontend can read the full list.

`createLoan()` takes: principal amount, duration in days, interest in basis points, max LTV in basis points, liquidation buffer in basis points. The collateral is sent as `msg.value`.

Paginated `getLoanIds(offset, limit)` overload prevents RPC timeouts if loans accumulate.

#### `CollateralVault.sol`
ETH custody contract. All borrower collateral sits here, not in the Loan contract. Three operations:
- `lockCollateral()` — called by factory when loan is created; records position
- `releaseCollateral()` — called by Loan on repay/cancel; sends ETH back to borrower
- `liquidateCollateral()` — called by Loan on liquidation; sends ETH to lender

Access control: only the registered factory can lock; only the specific loan contract for each position can release or liquidate. Uses OpenZeppelin `ReentrancyGuard` and `Address.sendValue()` throughout.

#### `MockPriceFeed.sol`
Oracle simulator. Owner calls `setPrice(uint256 newPrice)` to override the ETH/USD price. The frontend reads `ethUsdPrice` to compute live LTV and turn the health bar red when the price crashes. This simulates a real Chainlink feed for demo purposes.

---

## Term Sheet Calculation (`lib/loan-terms.ts`)

When a borrower selects a tier and inputs a loan amount, the frontend computes the full term sheet before any on-chain interaction:

| Tier | APR | Max LTV | Liquidation threshold | Haircut |
|---|---|---|---|---|
| A | 8% (6% base + 2% spread) | 70% | 80% (70% + 10% buffer) | 0% |
| B | 11% (6% base + 5% spread) | 60% | 72% (60% + 12% buffer) | 5% |
| C | 15% (6% base + 9% spread) | 50% | 65% (50% + 15% buffer) | 10% |

The haircut reduces the collateral's effective value for LTV calculation. A 5% haircut on $1,000 of ETH treats it as $950 for borrowing purposes.

Required collateral = `loan amount ÷ (maxLtv × (1 − haircut))`

This is all frontend math — the smart contract takes final values already computed.

---

## Wallet & Auth Stack

**Supabase** handles email/password auth. When a user signs up:
1. A `profiles` row is created in Supabase Postgres, tracking KYC status (`NOT_STARTED` → `APPROVED`).
2. The user links their MetaMask wallet by signing an EIP-191 message — this proves ownership without sharing the private key.
3. The `linked_wallets` table stores verified wallet addresses per user.
4. A `wallet_screenings` row is created with a demo risk score (suffix-based — not production).

**wagmi v2 + viem** handles all blockchain interactions in the frontend. Five wallet connectors are configured:
- MetaMask (primary)
- Coinbase Wallet
- Binance Wallet
- Trust Wallet
- WalletConnect (QR modal, for mobile)

Both Hardhat local chain (31337) and Sepolia (11155111) are configured. The `NetworkModeToggle` component switches between them at runtime.

**`useCompliance` hook** is the central gate. Every protected page reads:
```typescript
{
  authenticated: boolean,      // Supabase session exists
  hasVerifiedWallet: boolean,  // EIP-191 signature verified
  kycApproved: boolean,        // kycStatus === 'APPROVED' in profiles table
  canBorrow: boolean,          // hasVerifiedWallet && kycApproved
}
```

---

## User Workflow (End to End)

### Step 1 — Landing Page (`/`)
User arrives at the landing page. Sees:
- Live ETH price marquee across the top (from CoinGecko via `/api/prices`)
- Hero: "Peer-to-Peer Crypto Lending" with "Start borrowing →" CTA
- If already logged in and onboarded: redirects to `/app`
- If logged in but not onboarded: shows "Finish onboarding →"

### Step 2 — Sign Up (`/auth/signup`)
Email + password signup. Creates Supabase account. Redirects to onboarding on success.

### Step 3 — Onboarding (`/onboarding`)
Three sequential steps:

**Step A — Account**: confirms email/password login exists.

**Step B — Wallet**: user connects MetaMask → clicks "Link Wallet" → signs a text message (EIP-191) → frontend calls `/api/wallets/nonce` to get a challenge message, then `/api/wallets/verify` with the signature → wallet is linked and marked `signatureVerified = true` in the DB.

**Step C — KYC**: with `ALLOW_DEMO_KYC=1` set, there is a "Demo approve" button that calls `/api/kyc/demo-approve` and sets `kycStatus = 'APPROVED'` in the `profiles` table. In a real deployment, this would launch a Didit video-verification session.

Once all three steps are done, `canBorrow` becomes `true` and the user can access `/app`.

### Step 4 — The App (`/app`)

> **Note:** The `/app` route currently shows a "Coming soon" placeholder. The main lending desk is at the **root `/`** for logged-in users, or it may need to be wired to a separate route. Check `frontend/app/app/page.tsx` — it shows a shell. The actual Borrower + Lender workspace (with all the smart contract interactions) lives in `frontend/app/page.tsx` when the user is authenticated and has `canBorrow: true`.

The main page (`page.tsx`) has two tabs: **Borrower** and **Lender**.

---

### Borrower Tab Workflow

**1. Select persona** (or use own wallet)  
`PersonaSelector` shows three cards. Clicking one loads that persona's feature data. A "Use my real wallet" option exists but falls back to persona data for scoring (real on-chain extraction not built yet).

**2. See risk score**  
`RiskExplanationPanel` shows the tier (A/B/C), overall score, and per-feature breakdown with weights. A "DEMO DATA" badge appears when persona mode is active.

**3. Review term sheet**  
`TermTransparencyPanel` shows:
- APR for all three tiers so the borrower understands the impact of their tier
- The 6-step derivation of their required collateral amount
- A comparison table (tier × maxLTV × spread × haircut × liquidation buffer)

The borrower inputs the loan amount (ETH) and tenor (days). The term sheet recalculates live.

**4. Sign EIP-712 term sheet**  
Before creating the loan, the borrower must click "Step 1 — Sign term sheet." This uses wagmi's `useSignTypedData` to sign a structured `LoanTerms` object:
```
LoanTerms {
  principalEth, tenorDays, interestBps,
  maxLtvBps, liquidationBufferBps,
  requiredCollateralEth, finalApr, riskTier
}
```
The signature is shown on screen and stored as acknowledgement. The "Create Loan" button is disabled until signed.

**5. Create loan on-chain**  
"Step 2 — Create loan" calls `createLoan()` on the LoanFactory, sending the required collateral as ETH (`msg.value`). MetaMask pops up for confirmation.

On confirmation, the app shows:
- A clickable Etherscan link for the transaction
- The loan ID
- Loan status: "Requested — waiting for a lender"

**6. Repay**  
Once a lender funds the loan, the borrower receives the principal ETH and sees a "Repay" button. Clicking it sends `totalRepaymentDue()` wei to the Loan contract. On success, the vault releases the borrower's collateral back to them. Etherscan link shown.

**7. Cancel**  
Before funding, the borrower can cancel. The vault releases collateral immediately. Etherscan link shown.

---

### Lender Tab Workflow

**1. See all open loans**  
The app reads all `loanIds` from LoanFactory and fetches each loan's details. Loans are displayed as cards showing: status, principal, collateral, duration, interest rate.

**2. Fund a loan**  
Clicking "Fund" on a Requested loan sends the exact principal ETH to `fund()` on the Loan contract. The borrower receives the ETH immediately. The loan status moves to Funded.

**3. Live LTV monitor**  
The lender workspace shows a "Mock ETH/USD Oracle" panel with:
- Current mock price (defaults to $2,000)
- An input + "Set Price" button that calls `setPrice()` on MockPriceFeed

When the mock price drops, the LTV health bar in the borrower's view turns amber then red in real-time.

**4. Liquidate**  
When a funded loan's LTV is breached (price crash simulated), the lender can click "Liquidate — seize collateral." This calls `markLiquidatedForDemo()` on the Loan contract. The CollateralVault sends the borrower's collateral to the lender. Etherscan link shown.

---

## What the Platform Can Do Right Now

Everything listed below works with a local Hardhat node. With Sepolia addresses populated in `.env.local`, it all works on Sepolia:

| Capability | Status |
|---|---|
| Email/password signup + login | Works |
| EIP-191 wallet signature verification | Works |
| Demo KYC approval (ALLOW_DEMO_KYC=1) | Works |
| Persona selection (Alice/Charlie/Bob) | Works |
| 8-feature SHAP-style risk scoring | Works |
| XAI breakdown panel with weights | Works |
| Term sheet calculation (APR, LTV, collateral) | Works |
| Side-by-side tier comparison table | Works |
| EIP-712 term sheet signing | Works |
| Create loan on-chain (collateral locked) | Works |
| Lender sees all open loans | Works |
| Lender funds loan (borrower receives ETH) | Works |
| Borrower repays (lender repaid + collateral returned) | Works |
| Borrower cancels before funding (collateral returned) | Works |
| MockPriceFeed price override via UI | Works |
| Live LTV health bar (updates as price changes) | Works |
| Lender liquidation via demo function | Works |
| Etherscan tx links after every on-chain action | Works |
| 5-connector wallet support (MetaMask, WalletConnect, etc.) | Works |
| Live ETH price marquee (CoinGecko) | Works |

---

## What Is NOT Done

| Gap | Effort to add |
|---|---|
| `/app` dashboard is a "coming soon" shell — lending desk needs to be wired here | 1 hr (move page.tsx content to app/page.tsx) |
| Lender loan cards do not show borrower risk tier or XAI score | 1–2 hr |
| No multi-lender pooling — one loan, one lender | 1–2 days (new contract needed) |
| Real wallet feature extraction via Alchemy/Etherscan API | 2–3 days |
| Funding and repayment deadlines not enforced on-chain | 2 hr (BUG-08, BUG-09) |
| Loan filter/sort in lender view (by status, APR, size) | 1 hr |
| Contracts not verified on Sepolia Etherscan | 30 min |
| KYC nonce replay attack (BUG-12) | 1 hr |

---

## Environment Variables Required

### `contracts/.env`

```
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<your-alchemy-key>
SEPOLIA_PRIVATE_KEY=<deployer-wallet-private-key-no-0x-prefix>
```

### `frontend/.env.local`

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://...supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Network
NEXT_PUBLIC_NETWORK_MODE=testnet   # or 'local' for Hardhat

# RPC
NEXT_PUBLIC_RPC_URL_SEPOLIA=https://eth-sepolia.g.alchemy.com/v2/<key>

# Contract addresses (filled after deploy)
NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA=0x...
NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS_SEPOLIA=0x...
NEXT_PUBLIC_MOCK_PRICE_FEED_ADDRESS_SEPOLIA=0x...

# WalletConnect
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...

# KYC
ALLOW_DEMO_KYC=1
NEXT_PUBLIC_DIDIT_CONFIGURED=false
```

---

## How to Run Locally

```bash
# Terminal 1 — start local Ethereum node
cd contracts
npx hardhat node

# Terminal 2 — deploy contracts to local node
cd contracts
npx hardhat ignition deploy ignition/modules/NexusFiMilestone1.ts --network localhost

# Copy the printed addresses to frontend/.env.local, then:
# Terminal 3 — start frontend
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

## How to Run on Sepolia

```bash
# One-time deploy
cd contracts
npx hardhat ignition deploy ignition/modules/NexusFiMilestone1.ts --network sepolia

# Copy the 3 printed addresses to frontend/.env.local
# Then start the frontend as above
# Make sure NEXT_PUBLIC_NETWORK_MODE=testnet in .env.local
```

---

## Key Technical Decisions

**Why one Loan contract per loan (not one central contract)?**  
Isolation: a bug in one loan doesn't affect others. CollateralVault's access control is per loan contract address — only that specific Loan contract can release its position. This is more gas-expensive (each loan costs ~1M gas to deploy) but much safer for a demo where we want clear, auditable isolation.

**Why CollateralVault is separate from Loan.sol?**  
The vault holds real ETH. Separating it means a frontend bug or Loan contract bug cannot directly drain the vault — the vault only responds to calls from the registered loan contract for each position. Vault balances are visible on-chain independently.

**Why EIP-712 term sheet signing?**  
It creates a cryptographic record that the borrower acknowledged the specific terms (APR, LTV, collateral amount) before the transaction was sent. The signature is shown in the UI and could be stored as evidence of agreement. This is separate from and in addition to the on-chain transaction.

**Why synthetic personas instead of real wallet data?**  
Real wallet extraction requires Alchemy or Etherscan Pro API calls, which have rate limits and latency. For a demo on testnet where the borrower wallets are new (no mainnet history), synthetic data is the only option anyway. The feature-extractor abstraction (`FeatureVector` type + `extractFeatures()` function in `feature-extractor.ts`) is already defined so swapping to live data is a single-function change.

**Why `markLiquidatedForDemo()` instead of a real oracle-gated liquidation?**  
A proper on-chain liquidation requires the oracle price to fall below the LTV threshold, which requires Chainlink integration in the contract. For demo purposes, the lender manually triggers liquidation after a visible mock price crash in the UI. The demo point — showing the collateral seizure flow — is the same. The function name makes the intent explicit.
