# NexusFi Credit Scoring — How It Works

This document explains the full credit scoring pipeline for all team members. It covers what data is fetched, why, how each signal affects the score, and what happens in edge cases like new wallets.

---

## 1. The Big Picture

When a borrower clicks **Score My Wallet**, the system runs this pipeline:

```
Browser (4 questions answered by user)
    ↓
Next.js API route  →  FastAPI backend
                            ↓
                  Fetch on-chain data (Alchemy)
                  Ethereum Mainnet  +  Sepolia testnet
                            ↓
                  Score off-chain claims for credibility
                            ↓
                  Build 10-feature vector
                            ↓
                  LightGBM model  (or rule-based fallback)
                            ↓
                  Risk tier: A / B / C  +  SHAP explanations
```

The core design principle: **the system fetches what it can verify, and applies scepticism to what it cannot.**

---

## 2. What Gets Fetched vs What Gets Asked

### Fetched automatically from Ethereum Mainnet
| Data point | How it's fetched | Why mainnet, not testnet |
|---|---|---|
| Wallet age | First outgoing tx timestamp via `alchemy_getAssetTransfers` | Testnet age is trivially gamed — anyone can create a new wallet and transact freely on Sepolia |
| Transaction count | `eth_getTransactionCount` | Same reason — testnet tx count has no cost |
| DeFi protocols used | `alchemy_getAssetTransfers` — checks `to` addresses against 15 known protocol contracts | Real financial activity, not test activity |
| ETH balance | `eth_getBalance` | Mainnet balance = real capital at stake |
| Tornado Cash usage | `alchemy_getAssetTransfers` — checks `to` addresses against 9 TC contract addresses | Compliance/AML signal |
| Aave V3 repayments | `eth_getLogs` on Aave V3 Pool — Repay event, topic[2] = user | Verified loan repayment history |
| Aave V3 liquidations | `eth_getLogs` on Aave V3 Pool — LiquidationCall event, topic[3] = user | Verified default/failure history |

### Fetched from Sepolia testnet
| Data point | Why Sepolia |
|---|---|
| NexusFi platform loans created | The NexusFi LoanFactory lives on Sepolia — this is the only place platform-specific history exists |
| NexusFi platform loans repaid | Same — tracks in-platform repayment track record |

### Asked to the user (4 questions only)
| Question | What we verify |
|---|---|
| Mixer / privacy protocol usage | Cross-checked on-chain immediately — see Dishonesty section |
| DeFi loan history (taken / repaid / liquidations) | Cross-checked against Aave V3 on-chain — see Dishonesty section |
| Annual income band | Cannot be verified on-chain — credibility-scored instead |
| Employment type | Cannot be verified on-chain — credibility-scored instead |

---

## 3. Why "No Mainnet History" = New Wallet

If a wallet has never transacted on Ethereum mainnet, the system cannot distinguish it from a wallet created five minutes ago. The score reflects maximum uncertainty:

- Wallet age → **0 days** → heavy negative signal
- Transaction count → **0** → negative signal
- DeFi protocols → **0** → negative signal
- Balance → whatever ETH the wallet holds on mainnet

**Testnet history is intentionally ignored for credit signals.** Gas is free on Sepolia. Anyone can run thousands of transactions, interact with every protocol, and fake years of history in minutes. Using testnet history would make the scoring trivially gameable.

The **only** exception is NexusFi's own platform loan history on Sepolia — because those loans require real collateral (testnet ETH that must be earned via faucet), and the LoanFactory contract enforces the rules.

---

## 4. The 10 Features

The credit model operates on a 10-element feature vector. Every feature is normalised to roughly the same scale before the model sees it.

### F0 — Wallet Age (days)
**Source:** Verified on-chain (mainnet)  
**Weight:** 15%

| Condition | Score |
|---|---|
| ≥ 365 days | +0.80 |
| ≥ 90 days | +0.30 |
| < 90 days | −0.60 |
| 0 (no mainnet history) | −0.60 |

A wallet that has existed for over a year signals consistent, committed presence on-chain. New wallets are high uncertainty — not necessarily bad actors, but unknown.

---

### F1 — Transaction Count
**Source:** Verified on-chain (mainnet)  
**Weight:** 10%

| Condition | Score |
|---|---|
| ≥ 200 transactions | +0.70 |
| ≥ 50 transactions | +0.40 |
| ≥ 10 transactions | +0.00 |
| < 10 transactions | −0.50 |

High transaction count signals an active, experienced user. Inactive wallets are harder to assess.

---

### F2 — DeFi Protocols Used
**Source:** Verified on-chain (mainnet) via asset transfer destination addresses  
**Weight:** 10%

Checks outgoing transfers against 15 known protocol contracts: Uniswap V2/V3, Aave V2/V3, Compound V2/V3, Curve, Balancer, Lido, 1inch, Yearn, GMX, Synthetix, MakerDAO.

| Condition | Score |
|---|---|
| ≥ 5 protocols | +0.60 |
| ≥ 2 protocols | +0.20 |
| < 2 protocols | −0.30 |

Breadth of DeFi participation signals financial sophistication and comfort with on-chain lending mechanics.

---

### F3 — Balance (log-scaled)
**Source:** Verified on-chain (mainnet)  
**Weight:** 10%

Raw ETH balance is converted to USD using the price at scoring time, then log-scaled: `log10(balance_usd + 1)`. Log scaling is used because balance spans 4+ orders of magnitude ($10 to $1,000,000+) and linear scaling would let large balances dominate.

| Balance USD | Score |
|---|---|
| ≥ $20,000 | +0.70 |
| ≥ $5,000 | +0.40 |
| ≥ $1,000 | +0.10 |
| < $1,000 | −0.40 |

Capital on hand signals ability to repay. Low balance doesn't make someone a bad borrower, but it increases repayment risk from the lender's perspective.

---

### F4 — Mixer / Tornado Cash Detected
**Source:** Verified on-chain (mainnet)  
**Weight:** 15%

Checks all outgoing transfers against 9 known Tornado Cash contract addresses.

| Condition | Score |
|---|---|
| None detected | +0.30 |
| Detected | −1.00 |

Mixer usage is a hard compliance flag. The −1.00 score is the most extreme single penalty in the model. It does not disqualify a borrower outright, but it drags the overall score significantly toward Tier C. Lenders are informed.

---

### F5 — DeFi Loan Repayments
**Source:** Verified on-chain (mainnet Aave V3) + NexusFi platform history (Sepolia)  
**Weight:** 15%

Combined count of:
- Aave V3 `Repay` events where topic[2] matches the borrower's address
- NexusFi `LoanRepaid` events where topic[2] matches the borrower's address

| Condition | Score |
|---|---|
| ≥ 2 repaid loans | +0.90 |
| 1 repaid loan | +0.50 |
| 0 loans taken | −0.20 |

A clean multi-loan repayment history is the strongest single positive signal in the model.

> **Free tier note:** Alchemy's free plan limits `eth_getLogs` to a 10-block range. Aave history cannot be fetched on the free tier and defaults to 0/0. Upgrade to Alchemy Growth ($49/mo) or switch to Ankr (free, no block limit) to enable this.

---

### F6 — DeFi Liquidations
**Source:** Verified on-chain (mainnet Aave V3)  
**Weight:** 10%

`LiquidationCall` events where topic[3] matches the borrower's address.

| Condition | Score |
|---|---|
| 0 liquidations | +0.20 |
| > 0 liquidations | −0.80 |

Prior liquidations are a strong default signal — the borrower was unable to maintain collateral above the liquidation threshold on a prior loan. Each liquidation is weighted heavily regardless of count.

---

### F7 — Income Band (credibility-adjusted)
**Source:** Self-reported (off-chain), credibility-scored  
**Weight:** 8%

The user selects: `<$30k`, `$30k–$50k`, `$50k–$100k`, or `>$100k` annual income.

Raw income score before credibility adjustment:
| Band | Raw score |
|---|---|
| > $100k | +0.80 |
| $50k–$100k | +0.50 |
| $30k–$50k | +0.10 |
| < $30k | −0.30 |

**Credibility adjustment:** The system computes `P(claim is true)` using a sigmoid function centred on the expected savings ratio. If `balance_usd / expected_savings` is plausible for the claimed income band, credibility is high. If the balance is far below what someone earning that income would typically hold, credibility is discounted.

`F7 = raw_income_score × credibility_probability`

Example: claiming `>$100k` income but holding $50 on mainnet results in ~15% credibility → F7 ≈ 0.12 instead of 0.80.

> People rarely lie *downward* (claiming less income than they have), so `<$30k` has a credibility floor of 0.70.

---

### F8 — Employment Type (credibility-adjusted)
**Source:** Self-reported (off-chain), credibility-scored  
**Weight:** 4%

| Type | Raw score |
|---|---|
| Full-time | +0.50 |
| Self-employed | +0.20 |
| Freelance | −0.10 |
| Student | −0.20 |

Credibility is based on whether on-chain behaviour (balance level, transaction frequency, wallet age) is consistent with the claimed employment type. A student wallet with $200k on mainnet and 500 transactions looks unusual; a full-time employee wallet with 3 transactions looks similarly inconsistent.

`F8 = raw_employment_score × credibility_probability`

---

### F9 — Dishonesty Penalty
**Source:** Derived from cross-checking user claims against on-chain data  
**Weight:** 3%

This is a unique feature — it is not a score *input* but a score *modifier* computed from the verification process itself.

| Lie detected | Penalty |
|---|---|
| Claimed no mixer usage, but TC interaction found on-chain | 0.70 |
| Overclaimed DeFi repayments or underclaimed liquidations | 0.45 |
| Both | 1.00 (capped) |

The penalty is fed directly into the feature vector (not applied as a post-hoc adjustment), so the LightGBM model learns its interaction with other features. A dishonesty penalty alongside other negative signals compounds significantly.

The system warns the borrower when a claim contradicts on-chain data. Lenders see the dishonesty flag in the score breakdown.

---

## 5. How the Tier is Determined

The LightGBM model outputs a probability distribution across 3 classes:

```
P(Tier A) + P(Tier B) + P(Tier C) = 1.0
```

**Overall score** = `P(A) − P(C)` → range [−1.0, +1.0]

| Overall score | Tier |
|---|---|
| ≥ +0.40 | **A** — Low risk |
| ≥ 0.00 | **B** — Moderate risk |
| < 0.00 | **C** — High risk |

Each tier maps to different loan terms:
- **Tier A**: Lowest APR, highest max LTV, smallest haircut
- **Tier B**: Mid APR, moderate LTV, moderate haircut
- **Tier C**: Highest APR, lowest LTV, largest haircut (or potentially no offer)

---

## 6. What If the ML Model Isn't Trained?

Run `python -m app.ml.train` from the `backend/` directory to train the LightGBM model on 3,000 synthetic samples. Until then, a **rule-based fallback** is used that mirrors the same thresholds described above. The score breakdown will include a warning: *"ML model not yet trained — rule-based scoring used."*

The fallback produces reasonable scores but lacks SHAP explanations and the interaction effects the LightGBM model captures.

---

## 7. Free Tier vs Full Data

| Feature | Free Alchemy tier | Full data (paid / Ankr) |
|---|---|---|
| Wallet age | ✓ (via `alchemy_getAssetTransfers`) | ✓ |
| Transaction count | ✓ (standard RPC) | ✓ |
| ETH balance | ✓ (standard RPC) | ✓ |
| DeFi protocols used | ✓ (via `alchemy_getAssetTransfers`) | ✓ |
| Tornado Cash detection | ✓ (via `alchemy_getAssetTransfers`) | ✓ |
| Aave V3 repayments | ✗ → defaults to 0 | ✓ |
| Aave V3 liquidations | ✗ → defaults to 0 | ✓ |
| NexusFi Sepolia history | ✗ → defaults to 0 (same key restriction) | ✓ with separate Sepolia key |

**To unlock full data:** either upgrade the Alchemy app to Growth plan, or add a second Alchemy app for Sepolia and set `ALCHEMY_SEPOLIA_API_KEY` in `backend/.env`. Alternatively, switch to [Ankr](https://www.ankr.com/) which has no `eth_getLogs` block range restriction on its free tier.

---

## 8. Scoring a New Wallet (No Mainnet History)

A wallet with zero mainnet transactions is not rejected — it receives a score reflecting maximum uncertainty:

- F0 (wallet age) = −0.60
- F1 (tx count) = −0.50
- F2 (protocols) = −0.30
- F3 (balance) = depends on actual mainnet balance
- F4 (mixer) = +0.30 (none detected)
- F5 (Aave repaid) = −0.20 (no prior loans)
- F6 (liquidations) = +0.20 (none detected)
- F7–F9 = driven by off-chain answers

A new wallet with a good income claim and no red flags typically lands in **Tier C** (high risk, high APR, lower max LTV). The lender is compensated for the uncertainty through the higher spread.

Building on-chain history on mainnet — even small activity like a few Uniswap swaps — meaningfully improves the score over time.

---

## 9. Environment Variables

```env
# backend/.env

ALCHEMY_API_KEY=your_mainnet_key           # Required — mainnet RPC
ALCHEMY_SEPOLIA_API_KEY=your_sepolia_key   # Optional — if separate Sepolia app
NEXUSFI_FACTORY_SEPOLIA=0x...              # LoanFactory address on Sepolia
```

```env
# frontend/.env.local

CREDIT_BACKEND_URL=http://localhost:8000   # FastAPI backend URL
```
