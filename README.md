# NexusFi

A peer to peer lending protocol on Ethereum where borrowers lock ETH collateral, an explainable risk model assigns a tier that deterministically sets the loan terms, and a single lender funds the request wallet to wallet with the contract acting as escrow and enforcer.

## The problem

On chain lending is either pooled and anonymous, where a borrower is just an address and rates come from utilisation curves, or peer to peer with no underwriting at all, where the only protection is heavy over collateralisation. In both cases the ledger is transparent but the decision is not: a borrower cannot see why they were priced the way they were, and a lender funding a specific request has nothing to judge except the collateral ratio.

NexusFi scores each borrower against eight weighted features and publishes the full breakdown alongside the loan. The resulting tier maps deterministically to a max LTV, an interest spread and a liquidation buffer, and those three numbers are written into the loan contract at creation time, so the terms a lender reads on chain are the output of the same rule set the borrower saw. Settlement is equally explicit: every payment in the system moves as an internal contract transfer that wallets do not display, so the app indexes the event logs and generates receipts and statements from them rather than from balances.

## Architecture

```
 BROWSER (Next.js 16 App Router, React 19)
 ├── app/app/page.tsx ............ role toggle: borrower workspace / lender marketplace
 │    ├── LoanRequestPanel ....... 4-step wizard, scores borrower, calls createLoan()
 │    ├── LenderDashboard ........ open requests + own positions, fund() / liquidate()
 │    ├── BorrowerLoansSection ... own loans, live outstanding balance, repay()
 │    └── StatementsPanel ........ P&L, tax P&L, tradebook as PDF (jspdf)
 ├── app/demo/page.tsx ........... unlinked route: setPrice() and fastForward() controls
 └── wagmi v2 + viem
      │  writes: signed in the wallet, sent straight to Sepolia
      │  reads:  useReadContracts multicall, polled
      │
      ├──── /api/rpc/sepolia ─────────► configured Sepolia RPC
      │      (proxy: keeps the key server side, avoids CORS)
      │
      └──── /api/rpc/logs ────────────► separate upstream for eth_getLogs
             (the app RPC caps log range far below what loan history spans)

 NEXT ROUTE HANDLERS (server)
 ├── /api/prices ............ CoinGecko spot prices, 30s revalidate, static fallback
 ├── /api/market-pulse ...... fear/greed, DeFi TVL, gas
 ├── /api/news .............. CoinDesk / CoinTelegraph / Decrypt RSS
 ├── /api/wallets/{nonce,verify} .. EIP-191 nonce challenge, viem verifyMessage,
 │                                  mock KYT screen on success
 ├── /api/kyc/{session,status,webhook,demo-approve} .. Didit v2, HMAC webhook check
 ├── /api/profile ........... role selection (borrower / lender / both)
 ├── /api/loans/risk ........ persist and batch-read the risk explanation per loan
 ├── /api/loans/event-prices  ETH/USD snapshot per settlement event, first write wins
 └── /api/credit/score ...... proxy to the FastAPI scorer, 20s timeout

 SUPABASE POSTGRES (row level security on every table)
   profiles · linked_wallets · wallet_screenings · audit_logs
   loan_risk_assessments  (insert once by loan creator, readable by any signed in user)
   event_price_snapshots  (insert only, primary key tx_hash + log_kind)

 FASTAPI BACKEND (backend/, optional, not deployed)
   Alchemy mainnet + Sepolia  ->  wallet age, tx count, protocol breadth, balance,
   Aave V3 Repay/LiquidationCall logs, Tornado Cash contact, NexusFi loan history
        -> claim credibility scoring -> 10 feature vector -> LightGBM + SHAP -> tier

 SEPOLIA (chain 11155111)
   LoanFactory ──creates──► Loan (one contract per request)
        │                     │  reads latestPrice() ──► MockPriceFeed
        └──lockCollateral()──►│
                          CollateralVault ◄──release / liquidate (onlyLoan)
```

Two details worth calling out because they are not the obvious design. First, the borrower's feature breakdown is computed in the browser and would be lost on unmount, so it is written to `loan_risk_assessments` keyed by the deployed `Loan` address and made readable to every signed in user, which is what lets a lender see the reasoning behind a tier they did not compute. Second, `Loan.sol` stores only `priceAtFunding`, so fiat figures in statements come from `event_price_snapshots`, captured the first time the client observes an event and never rewritten; events that predate that table are labelled as estimated at the current price rather than silently valued.

## Contracts

Solidity 0.8.28, OpenZeppelin 5, Hardhat 3 with Ignition. Addresses below are from `contracts/ignition/deployments/chain-11155111/deployed_addresses.json` and match `frontend/.env.local`.

| Contract | Responsibility | Sepolia address | Status |
|---|---|---|---|
| `LoanFactory` | Deploys one `Loan` per request, forwards collateral to the vault, keeps the loan registry with a paginated `getLoanIds(offset, limit)`. Holds the shared price feed address and the `demoMode` flag passed to every loan. | `0x4dDB469155A8824FDCa64d2e706aFE6380C55fAd` | Live, deployed with `demoMode = true` |
| `CollateralVault` | Sole custodian of ETH collateral, one position per loan id. `lockCollateral` is `onlyFactory`, `releaseCollateral` and `liquidateCollateral` are `onlyLoan`, both one shot per position. | `0xeB137a592E5623D2750CEcf4Ad8421E2aA8FDf16` | Live |
| `Loan` | Full lifecycle for a single request: `fund`, `repay` (partial or full), `cancel`, `liquidate`, plus the view surface the UI polls (`outstandingBalance`, `currentLtvBps`, `isLiquidatable`, `liquidationPreview`). | Deployed by the factory per request, no fixed address | Live |
| `MockPriceFeed` | ETH/USD in whole dollars, read by every `Loan` through `latestPrice()`. `setPrice` is deliberately permissionless so any teammate can run the crash demo. | `0x5094c61F27B8b7538eeC330f9Ec013277E590a7c` | Live, testnet only by design |
| `MockERC20` | Mintable test token with configurable decimals. A deploy script exists (`scripts/deploy-mock-tokens.ts`, mUSDC/mWETH/mWBTC). | Not in the deployment files | Compiled and deployable, not wired as a loan asset |
| `KYCRegistry` | Admin gated on chain allowlist of approved wallets. | Not in the deployment files | Reference contract, unused by the live flow, which enforces KYC off chain |

Source verification is configured in `hardhat.config.ts`: Sourcify and Blockscout are enabled without a key, Etherscan stays disabled unless `ETHERSCAN_API_KEY` is set. Verification must run with `--build-profile production`, since Ignition deploys with the optimizer on at 200 runs.

## The risk engine

### Tier assignment, off chain

`frontend/lib/risk-explainer.ts` scores eight features. Each scorer returns a value in `[-1, +1]`, weights sum to 1.0, and the weighted sum is clamped to `[-1, +1]`.

| Feature | Weight | Category |
|---|---|---|
| DeFi loan history | 0.25 | on chain |
| Wallet age | 0.15 | on chain |
| Mixer interaction | 0.15 | on chain |
| Transaction volume | 0.10 | on chain |
| DeFi breadth | 0.10 | on chain |
| Average balance, 90d | 0.10 | on chain |
| Income band | 0.10 | off chain |
| Employment type | 0.05 | off chain |

Every breakpoint is exported as `FEATURE_SCORING_GUIDE` and rendered in the UI. Examples: a wallet older than 365 days scores +0.80 and one under 90 days scores -0.60; two or more repaid loans with zero liquidations scores +0.90 while any liquidation scores -0.80; a detected mixer interaction scores -1.00, the single largest penalty in the model. Tier boundaries are `score >= 0.40` for A, `score >= 0.00` for B, otherwise C. Two features present in the persona data, `sanctionProximity` and `loanPurpose`, are deliberately not scored and are documented as such in the source.

There are two scoring paths. Persona mode runs this rule set in the browser against three synthetic profiles (Alice, Charlie, Bob, one per tier). Connected wallet mode posts to `/api/credit/score`, which proxies the FastAPI service in `backend/`: that service pulls real mainnet history through Alchemy, cross checks the borrower's self reported claims against it (a claim of no mixer use against detected Tornado Cash contact, claimed DeFi history against Aave V3 `Repay` and `LiquidationCall` logs), applies a dishonesty penalty, and runs a LightGBM classifier with SHAP attributions. When that service is unreachable the wizard reports it rather than scoring silently.

### Tier to terms

`frontend/lib/loan-terms.ts`. `BASE_APR` is 6%.

| Tier | Max LTV | Liquidation buffer | Liquidation threshold | Collateral haircut | APR spread | Final APR |
|---|---|---|---|---|---|---|
| A | 70% | 10% | 80% | 0% | 2% | 8% |
| B | 60% | 12% | 72% | 5% | 5% | 11% |
| C | 50% | 15% | 65% | 10% | 9% | 15% |

```
adjustedCollateralUsd   = collateralEth * price * (1 - haircut)
maxBorrowUsd            = adjustedCollateralUsd * maxLtv
requiredCollateralEth   = loanUsd / (maxLtv * (1 - haircut)) / price
interestUsd             = loanUsd * (BASE_APR + spread) * tenorDays / 365
```

Only `interestBps`, `maxLtvBps` and `liquidationBufferBps` cross the boundary into the contract, as arguments to `createLoan`. The haircut never appears on chain; it shapes how much collateral the borrower is required to post in the first place.

### Liquidation, on chain

Principal and collateral are both denominated in ETH, so their ratio is constant and an ETH price move alone can never change it. `Loan.sol` fixes this by freezing the debt in USD at funding while the collateral keeps floating:

```
debtValueUsd        = principalAmount * price AT FUNDING     (fixed at fund())
collateralValueUsd  = collateralAmount * price NOW
currentLtvBps       = mulDiv(debtValueUsd, 10_000, collateralValueUsd)
liquidationThresholdBps = maxLtvBps + liquidationBufferBps
```

`liquidate()` is `onlyLender`, requires status `Funded`, and requires either trigger:

1. Delinquency: `block.timestamp > fundedAt + durationDays * 1 days + GRACE_PERIOD`, where `GRACE_PERIOD` is 2 days.
2. Collateral shortfall: `currentLtvBps >= liquidationThresholdBps`.

Seizure is `min(outstandingBalance(), collateralAmount)` and the surplus returns to the borrower in the same transaction, so partial repayments shrink the seizure one for one. `liquidationPreview()` exposes the same split as a view so both sides can see it before anyone acts. Worked example from the test fixture: 1 ETH borrowed against 2 ETH at $2,000 sits at 50% LTV against an 80% threshold and becomes liquidatable exactly when ETH reaches $1,250, asserted at both $1,251 (not liquidatable) and $1,250 (liquidatable).

Interest accrues continuously rather than over the fixed term:

```
interestDue = mulDiv(principalAmount, interestBps * elapsedSeconds, 10_000 * 365 days)
```

`elapsedSeconds` runs from `fundedAt` to now, capped at `repaymentDueAt() + GRACE_PERIOD` and frozen at `closedAt` once the loan settles. At exactly `durationDays` this is algebraically identical to a fixed duration calculation, so early repayment costs less and lateness costs more up to the cap, past which the lender's recourse is liquidation rather than an ever growing debt. `fund()` additionally enforces a 7 day `FUNDING_WINDOW` from `requestedAt` and requires exact principal.

### How prices are sourced and validated

The contract reads one interface, `IPriceFeed.latestPrice()`, returning whole dollars. On Sepolia that is `MockPriceFeed`, which is a mock: `setPrice` is permissionless, there is no staleness check, no decimals, no aggregation and no circuit breaker, and the source comments say plainly that it must never ship to a real network.

The validation that does exist is fail closed. `_readPrice()` wraps the call in `try/catch` and returns 0 for a missing or reverting feed, so a broken oracle degrades to disabled rather than reverting every view. `currentLtvBps()` returns 0 whenever the loan is not funded, `debtValueUsd` is 0 or the price is 0, and callers are instructed to read that as unknown rather than healthy. `isPriceLiquidatable()` returns false on a 0 LTV, so bad oracle data can never seize collateral, which is asserted by a test that sets the feed to $0 and confirms `liquidate()` reverts. `fund()` only sets `debtValueUsd` if the price is positive, so a loan funded while the oracle is down permanently runs on the deadline trigger alone. The factory also accepts `address(0)` for the feed, which disables price liquidation protocol wide by construction.

The market prices shown in the UI are a separate path: CoinGecko through `/api/prices`, polled every 10 seconds, with a static fallback if the request fails. Those figures drive display, term sheet sizing and statement valuation. They are never an input to liquidation.

## Stack

| Layer | Technology |
|---|---|
| Contracts | Solidity 0.8.28, OpenZeppelin 5 (`Ownable`, `ReentrancyGuard`, `Address`, `Math`), Hardhat 3, Hardhat Ignition, viem based toolbox |
| Chain access | wagmi v2, viem, Sepolia and a local Hardhat node (31337), server side RPC proxies for reads and for logs |
| Client | Next.js 16 App Router, React 19, TypeScript, Tailwind v4, TanStack Query, lucide-react, jspdf and jspdf-autotable for statements |
| Off chain data | Supabase Postgres with RLS, Supabase Auth, `@supabase/ssr` with cookie based sessions and a middleware refresh |
| Identity and screening | Didit v2 KYC with HMAC verified webhooks, EIP-191 signature wallet linking, deterministic mock KYT scorer |
| Risk service (optional) | FastAPI, LightGBM, SHAP, scikit-learn, numpy, joblib, httpx, Alchemy JSON-RPC |
| Delivery | Vercel via GitHub Actions, per branch preview URLs aliased explicitly by the workflow |

## Local setup

Prerequisites: Node 22, npm, and Python 3.12 only if you want the ML scorer.

```bash
# contracts
cd contracts
npm install
npx hardhat build
npx hardhat node                     # terminal 1, chain 31337
npm run deploy:ignition:local        # terminal 2, deploys vault + feed + factory and wires them

# frontend
cd ../frontend
npm install
cp .env.example .env.local           # fill in the addresses printed by the deploy
npm run dev                          # http://localhost:3000
```

For Sepolia instead of a local node, set `SEPOLIA_PRIVATE_KEY` and `SEPOLIA_RPC_URL` in `contracts/.env` and run `npx hardhat ignition deploy ignition/modules/NexusFiMilestone1.ts --network sepolia`, then copy the three addresses into `frontend/.env.local` and set `NEXT_PUBLIC_NETWORK_MODE=testnet`.

Supabase is required for auth, KYC state, persisted risk explanations and statements. Run `frontend/supabase/migrations/001` through `004` in the Supabase SQL editor in order. Without 003 the risk explanation fails to save silently by design, and without 004 statements still generate but value every event at the current price and label it estimated.

The FastAPI scorer is optional. Without it, persona mode still works end to end and connected wallet mode reports the service as unavailable.

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                 # needs your own ALCHEMY_API_KEY
uvicorn app.main:app --reload --port 8000
```

### Tests

```bash
cd contracts && npx hardhat test
```

28 tests, all passing. `NexusFiMilestone1.ts` covers loan creation and funding. `LoanLifecycle.ts` covers partial repayment sequences, overpayment refunds, the interest formula at the deadline boundary and its cap past the grace period, every `liquidate()` gate, the price trigger including the exact threshold boundary, price recovery un liquidating a position, the zero price fail safe, partial liquidation fairness, and the demo `fastForward` guards.

```bash
cd frontend
node --experimental-strip-types --test lib/loan-terms.test.ts lib/risk-explainer.test.ts lib/feature-extractor.test.ts
```

103 tests, all passing, covering the tier configuration, the term sheet formulas, every feature scorer and its breakpoints, tier boundaries, and the persona fixtures. These use the Node test runner directly, so imports inside the test files carry explicit `.ts` extensions.

## Current state

Live on Sepolia at the three addresses above. The complete lifecycle runs end to end from the UI: create a request with collateral locked, fund it with the principal forwarded to the borrower in the same transaction, repay in instalments or in full with the surplus refunded, and liquidate on either trigger with only the outstanding debt seized. Settlement receipts, event backed history and downloadable P&L, tax P&L and tradebook statements are shipped. `/demo` is an unlinked route that forces both liquidation triggers on demand, gated by the factory's `demoMode` flag and restricted to a loan's own borrower or lender. Two person manual testing across nine loans on live Sepolia is recorded as complete, verified against on chain state.

In progress and not yet built: multi lender pooling, which is the largest remaining architectural gap, since today a single lender funds 100% in one transaction. The borrower side cancel button is queued: `Loan.cancel()` exists and is tested, `LoanCancelled` is already decoded by the event indexer, but no UI calls it, so a borrower who changes their mind waits out the 7 day funding window. Liquidation requires the lender to call it, with no keeper or liquidator incentive, and that is a documented design position rather than an open task. Also outstanding: an events indexer to replace the multicall reads that will not scale past demo volume, IPFS anchored term sheets, ERC-20 principal assets, and a real oracle in place of `MockPriceFeed`.

The source is private until the pooled lending module ships.
