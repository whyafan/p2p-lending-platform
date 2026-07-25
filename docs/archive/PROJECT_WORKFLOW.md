# NexusFi P2P Blockchain Lending Platform — Project Workflow

## Project Overview

NexusFi is a Milestone 1 demo of a peer-to-peer lending platform where borrowers lock ETH collateral on-chain and lenders fund loans directly. Identity verification (KYC) and wallet screening are layered on top via Supabase, Prisma, and the Didit integration.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contracts | Solidity 0.8.28, OpenZeppelin 5.6.1, Hardhat 3.4.5 |
| Frontend | Next.js 16.2.2 (App Router), React 19, TypeScript 5 |
| Wallet / Web3 | Wagmi 2.19.5, Viem 2.47.10 |
| Styling | TailwindCSS 4 |
| Auth & DB (off-chain) | Supabase (email auth), Prisma 6 + SQLite |
| KYC | Didit API (with demo bypass) |
| Data Fetching | TanStack React Query 5 |
| Price Oracle | CoinGecko REST API (with fallback) |
| Networks | Hardhat local (chain 31337), Sepolia testnet (chain 11155111) |

---

## Repository Structure

```
p2p-blockchain-lending-platform-duplicate-main/
├── contracts/                    # Hardhat project
│   ├── contracts/
│   │   ├── Loan.sol              # Individual loan lifecycle
│   │   ├── LoanFactory.sol       # Loan creation & registry
│   │   ├── CollateralVault.sol   # ETH collateral custody
│   │   ├── KYCRegistry.sol       # On-chain KYC admin (M1 reference)
│   │   ├── MockERC20.sol         # Test tokens (USDC, WETH, WBTC)
│   │   └── NexusFiVault.sol      # Alternative incomplete implementation
│   ├── scripts/
│   │   ├── deploy-milestone1.ts  # Deploy vault + factory
│   │   └── deploy-mock-tokens.ts # Deploy ERC20 test tokens
│   ├── test/
│   │   └── NexusFiMilestone1.ts  # Integration tests
│   └── hardhat.config.ts
├── frontend/
│   ├── app/
│   │   ├── page.tsx              # Main dashboard (borrower + lender)
│   │   ├── layout.tsx            # Root layout with Wagmi providers
│   │   ├── providers.tsx         # Wagmi + React Query context
│   │   ├── wagmi-config.ts       # Wallet connector setup
│   │   ├── onboarding/page.tsx   # KYC onboarding flow
│   │   ├── profile/page.tsx      # User profile editor
│   │   ├── auth/                 # Login / signup pages
│   │   └── api/
│   │       ├── prices/route.ts   # CoinGecko price proxy
│   │       ├── profile/route.ts  # Display name + linked wallets
│   │       ├── wallets/route.ts  # Account + wallets endpoint
│   │       ├── wallets/nonce/    # EIP-191 nonce generation
│   │       ├── wallets/verify/   # Signature verification + KYT screen
│   │       ├── kyc/session/      # Start Didit KYC session
│   │       ├── kyc/status/       # Poll KYC status
│   │       ├── kyc/webhook/      # Didit webhook receiver
│   │       └── kyc/demo-approve/ # Dev-only KYC bypass
│   ├── components/
│   │   ├── NetworkModeToggle.tsx # Local ↔ Testnet switcher
│   │   └── PriceTicker.tsx       # Live ETH/WBTC/USDC prices
│   ├── hooks/
│   │   ├── useBorrowerRisk.ts    # On-chain risk tier computation
│   │   ├── useCompliance.ts      # Auth + KYC status query
│   │   ├── useNetworkMode.ts     # Network mode + wallet chain switch
│   │   ├── useTokenPrices.ts     # Price feed hook
│   │   └── useHydrated.ts        # SSR hydration guard
│   ├── lib/
│   │   ├── loan-terms.ts         # Risk tier config + term sheet math
│   │   ├── borrower-risk.ts      # Tier assignment logic
│   │   ├── format.ts             # USD / percent / number formatters
│   │   ├── network.ts            # Network mode config & env resolution
│   │   ├── tokens.ts             # Supported token definitions
│   │   ├── auth.ts               # Session → Prisma user upsert
│   │   ├── wallet-chain.ts       # Add/switch wallet chain
│   │   ├── wallet-screening.ts   # Mock KYT engine
│   │   ├── kyc.ts                # KYC status label helpers
│   │   ├── didit.ts              # Didit KYC API + webhook verification
│   │   ├── prisma.ts             # Prisma singleton client
│   │   └── supabase/             # Browser + server Supabase clients
│   └── middleware.ts             # Supabase auth session refresh
└── .env                          # Root environment variables
```

---

## Smart Contract Architecture

### Loan Lifecycle

```
Borrower calls LoanFactory.createLoan() (with ETH collateral as msg.value)
    │
    ├── LoanFactory deploys new Loan contract
    ├── CollateralVault.lockCollateral() — ETH is held by vault
    └── LoanTerms stored in factory mapping
          │
          ▼ Status: Requested
    Lender calls Loan.fund() (sends exact principalAmount as msg.value)
          │
          ├── principal forwarded to borrower immediately
          └── lender recorded, fundedAt timestamp set
                │
                ▼ Status: Funded
          ┌─────┴──────────────────────────┐
          │                                │
    Borrower calls repay()          Lender calls markLiquidatedForDemo()
    (sends principal + interest)    (demo-only, no price check)
          │                                │
    Repayment forwarded to lender   Collateral forwarded to lender
    Collateral released to borrower
          │                                │
          ▼ Status: Repaid                 ▼ Status: Liquidated
```

### Contract Responsibilities

| Contract | Role |
|---|---|
| `LoanFactory` | Creates and registers loans; holds `LoanTerms` mapping; is authorized to call `lockCollateral` |
| `Loan` | Holds loan parameters (immutable); manages `fund()`, `repay()`, `cancel()`, `markLiquidatedForDemo()` |
| `CollateralVault` | Custody of ETH collateral; only the registered loan contract for each ID can release/liquidate |
| `KYCRegistry` | Admin-controlled on-chain KYC flags (M1 reference; not used in main flow) |

### Interest Formula

```
interestDue = (principalAmount × interestBps × durationDays) / (10,000 × 365)
```

### Risk Tiers & Parameters

| Tier | Max LTV | APR (base 6%) | Haircut | Liquidation Buffer |
|---|---|---|---|---|
| A | 70% | 8% | 0% | 10% |
| B | 60% | 11% | 5% | 12% |
| C | 50% | 15% | 10% | 15% |

---

## Frontend Flows

### 1. Onboarding (4-step)

```
Step 1: Account
  Supabase email + password signup/login
  → Prisma User record upserted on first API call

Step 2: Wallet Verification
  POST /api/wallets/nonce  → generates EIP-191 message with nonce
  User signs in MetaMask/other wallet
  POST /api/wallets/verify → verifyMessage() + mock KYT screening
  → LinkedWallet record created, signatureVerified = true

Step 3: KYC (Didit)
  POST /api/kyc/session → createDiditSession() → redirect user to Didit flow
  Didit POSTs webhook to /api/kyc/webhook (HMAC-verified)
  → User.kycStatus updated (APPROVED / REJECTED / MANUAL_REVIEW)
  Dev fallback: POST /api/kyc/demo-approve → directly sets kycStatus = APPROVED

Step 4: Ready
  Link back to dashboard / lending desk
```

### 2. Borrower Workspace

```
1. Connect wallet (MetaMask / Coinbase / Trust / Binance / WalletConnect)
2. Select collateral token (ETH, WETH, USDC, WBTC — M1 only locks native ETH)
3. Select borrow asset
4. Choose tenor (30 / 60 / 90 days)
5. Enter principal amount in ETH
6. Risk tier auto-assigned from on-chain loan history:
   - Reads getLoanIds() from factory
   - Reads loans() + status() for each loan belonging to connected wallets
   - assignBaseRiskTier() → adjustTierForLoanTerms() → final tier
7. Live term sheet calculated:
   - requiredCollateralEth = loanAmountUsd / (maxLtv × (1 - haircut)) / oraclePriceUsd
   - interestDue = principal × finalApr × (tenor / 365)
8. handleCreateLoan() → writeContract(LoanFactory.createLoan, { value: collateral })
9. After confirmation: createdLoanId set, term sheet panel shows loan ID
```

### 3. Lender Workspace

```
1. Connect wallet
2. Browse "Open requests" list (all Requested-status loans from getLoanIds())
3. Enter loan ID or click from list to fetch loan details
4. View: principal, collateral, duration, APR, max LTV, risk tier
5. handleFundLoan() → writeContract(Loan.fund, { value: principalAmount })
6. After confirmation: loan status updates to Funded, borrower receives principal
```

### 4. Price Feed

```
/api/prices (GET, revalidate 60s)
  → CoinGecko /simple/price?ids=ethereum,wrapped-bitcoin,usd-coin&vs_currencies=usd
  → Returns { prices: { ETH, WBTC, USDC }, source, updatedAt }
  Fallback: ETH = NEXT_PUBLIC_ETH_USD_PRICE (default $2000), WBTC = $60,000, USDC = $1
```

### 5. Network Mode Toggle

```
localStorage key: "nexusfi-network-mode"
  'local'   → Hardhat chain 31337, NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL
  'testnet' → Sepolia chain 11155111, NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA

On switch: wallet prompted to switch chains via wallet_switchEthereumChain
           If chain missing: wallet_addEthereumChain (adds Hardhat 31337)
```

---

## Deployment

### Local Development

```bash
# Terminal 1: Start Hardhat node
cd contracts && npx hardhat node

# Terminal 2: Deploy contracts
npx hardhat run scripts/deploy-milestone1.ts --network localhost
# Copy output addresses to .env

# Terminal 3: Start frontend
cd frontend && npm run dev
```

### Sepolia Testnet

```bash
cd contracts
npx hardhat run scripts/deploy-milestone1.ts --network sepolia
# Copy addresses to .env as NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA
```

### Environment Variables

```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
DIDIT_API_KEY=...                        # private
DIDIT_WORKFLOW_ID=...                    # private
DIDIT_WEBHOOK_SECRET=...                 # private
NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL=...
NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA=...
NEXT_PUBLIC_RPC_URL_LOCAL=http://127.0.0.1:8545
NEXT_PUBLIC_RPC_URL_SEPOLIA=...
NEXT_PUBLIC_ETH_USD_PRICE=2000           # fallback only
DATABASE_URL=file:./dev.db               # SQLite via Prisma
```

---

## Off-Chain Data Model (Prisma)

```
User
  id, email, supabaseId, displayName, kycStatus, verifiedAt, rejectionReason

LinkedWallet
  userId (→ User), walletAddress, chainId, signatureVerified, verifiedAt, isPrimary
  unique: (walletAddress, chainId)

WalletScreening
  userId, walletAddress, riskScore, riskLevel, flags, createdAt

AuditLog
  userId, action, metadata, createdAt
```

---

## Key Algorithms

### Risk Tier Assignment

```
1. Fetch all loanIds from factory
2. For each loanId: read loans() to get borrower + loanContract
3. Filter loans matching any wallet in the user's linked identity
4. Fetch status() from each matched loan contract
5. assignBaseRiskTier(stats):
     0 loans           → C
     any liquidated     → C
     ≥1 repaid          → A
     active funded      → B
     requested only     → B
6. adjustTierForLoanTerms(baseTier, loanAmountUsd, tenorDays):
     principal > $5,000 → bump stricter by 1
     tenor ≥ 90 days    → bump stricter by 1
7. Multi-wallet: use strictest tier across all linked wallets
```

### Collateral Calculation

```
requiredCollateralUsd = loanAmountUsd / (maxLtv × (1 - haircut))
requiredCollateralEth = requiredCollateralUsd / oraclePriceUsd
liquidationThreshold  = maxLtv + liquidationBuffer
```

---

## Milestone 1 Scope & Limitations

**Implemented:**
- ETH-only collateral locking and release
- Single-lender-per-loan model (full funding in one tx)
- On-chain loan registry via LoanFactory
- Risk tier assignment from on-chain history
- EIP-191 wallet signature verification
- Mock KYT screening (deterministic, not real Chainalysis)
- Didit KYC integration (with dev bypass)
- Local Hardhat + Sepolia testnet support
- Live CoinGecko price feed with fallback

**Not yet implemented (out of scope for M1):**
- ERC-20 collateral and borrowing
- Automated liquidation (price oracle + threshold check)
- Repayment deadline enforcement and late fees
- Partial / multi-lender funding
- Real KYT (Chainalysis, TRM Labs)
- On-chain KYC enforcement in LoanFactory
- Yield optimization / lending pools
- Loan secondary market
