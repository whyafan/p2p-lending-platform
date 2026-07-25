# Blockchain-Based Peer-to-Peer Lending Platform

**Institution:** K.J. Somaiya School of Engineering, Somaiya Vidyavihar University  
**Mentor:** Mr. Gopal Sonune  
**Team:**
- Afan Khan — 16010124811
- Atharva Patil — 16010124814
- Viren Rathod — 16010124817
- Siddharth Singh — 16010124818

---

## Table of Contents
1. [Problem Statement](#1-problem-statement)
2. [Project Scope](#2-project-scope)
3. [Objectives](#3-objectives)
4. [Goals](#4-goals)
5. [Literature Review](#5-literature-review)
6. [Software Requirements Specification (SRS)](#6-software-requirements-specification-srs)
7. [Selected Domains & Strategic Focus](#7-selected-domains--strategic-focus)
8. [Methodology — 12-Step Workflow](#8-methodology--12-step-workflow)
9. [Proposed System & Multi-Layer Architecture](#9-proposed-system--multi-layer-architecture)
10. [System Architecture Blueprint](#10-system-architecture-blueprint)
11. [Layer-by-Layer Breakdown](#11-layer-by-layer-breakdown)
12. [Class Diagram — Core Smart Contract Entities](#12-class-diagram--core-smart-contract-entities)
13. [Existing Systems Comparison](#13-existing-systems-comparison)
14. [Novelty & Innovation](#14-novelty--innovation)
15. [Future Scope](#15-future-scope)
16. [Conclusion](#16-conclusion)

---

## 1. Problem Statement

The current P2P lending infrastructure is fundamentally broken across four dimensions:

### Opaque Underwriting
Borrowers have zero visibility into how credit decisions are made. The process is manual, inconsistent, and entirely institution-controlled — there is no transparency for the borrower.

### High Operational Overhead
Banks and NBFCs acting as intermediaries inflate costs, slow down loan approvals, and reduce lender yields. The traditional model is structurally inefficient.

### Information Asymmetry
Platforms score borrowers but lenders bear all default risk — a fundamental misalignment of incentives. Lenders make decisions without adequate insight into borrower risk.

### Static Credit Models
Traditional credit scoring depends solely on application-time data and completely fails to capture real-time borrower behavior, making it unsuitable for dynamic lending markets.

---

## 2. Project Scope

### In Scope — MVP
| Feature | Details |
|---|---|
| Loan Type | Fixed-rate, fixed-tenor, over-collateralized loans |
| Collateral | One on-chain collateral type (WETH on L2) |
| Risk Model | Gradient-boosted ML risk tiers: A / B / C |
| Wallets | MetaMask + WalletConnect support |
| KYC | Sandbox KYC — wallet-bound verified status |
| Storage | IPFS document storage (term sheets, non-PII) |
| Oracle | Chainlink price feed + liquidation keeper |
| Deployment | Testnet L2 deployment (Arbitrum / Optimism) |
| Explainability | SHAP-based risk explanations in UI |
| Beta | Closed beta — ≤500 wallets |

### Out of Scope
- Unsecured or under-collateralized lending
- Multi-asset collateral baskets
- BERT/NLP-based borrower narrative scoring
- Mobile-native wallet integrations
- Full regulatory compliance / live KYC
- Raw PII stored on-chain
- Custom oracle infrastructure
- Mainnet production launch
- Graph/network topology credit features
- Public open launch

---

## 3. Objectives

The platform targets six core technical objectives, each with measurable success criteria:

| Objective | Description | Success Metric |
|---|---|---|
| **Smart Contract Core** | Deploy LoanFactory, Loan & CollateralVault contracts | ≥90% unit test coverage + gas reports |
| **ML Risk Engine** | Train gradient-boosted classifier | AUC ≤ 0.75, Brier ≤ 0.18, weekly recalibration |
| **KYC & Identity** | Sandbox KYC with wallet-bound verified status | ≥95% automated pass rate |
| **Web3 UX** | End-to-end borrower + lender flows | Median time-to-fund ≤ 3 min on testnet |
| **Security & DevOps** | Threat model; CI/CD with Slither/Mithril | All Critical/High findings resolved |
| **Observability** | On-chain event indexer + Grafana dashboards | Data lag ≤ 30 seconds |

---

## 4. Goals

### Disintermediation
Enable direct borrower-lender interaction via smart contracts — no banks, no brokers, zero manual approval steps.

### Transparent Risk
Replace black-box underwriting with SHAP-based explainable ML risk tiers (A/B/C) mapping directly to LTV, APR, and collateral rules.

### On-Chain Enforcement
All loan lifecycle events — funding, repayment, delinquency, liquidation — enforced autonomously by smart contract logic. No human intervention required.

### Inclusive Governance
Support borrowers with on-chain history but thin traditional credit files. Full model governance: versioning, recalibration, drift monitoring.

---

## 5. Literature Review

Five key research papers informed the project design:

| # | Source | Paper | Key Finding | Learning Applied |
|---|---|---|---|---|
| 1 | Policy Research Journal, 2024 | AI in Geopolitical Decision-Making | AI enhances decisions but risks bias, misinformation & over-reliance on automated systems | Used rule-based + scoring models over black-box approaches for explainability |
| 2 | Journal of Military Horizons, 2024 | AI as a Strategic Asset in Geopolitics | AI is a key strategic tool in defense, intelligence & global power competition | Reinforced inclusion of military strength & strategic indicators in the decision model |
| 3 | IJMRI, 2024 | Geopolitics of AI: Competition, Control & Ethics | AI development linked to global competition, data control & ethical governance issues | Encouraged governance & ethical considerations in internal affairs analysis module |
| 4 | arXiv, 2025 | Brokerage in the Black Box: Swing States & AI Governance | Smaller/neutral countries play important roles in global AI governance decisions | Led to incorporating country comparison & relational factors in geopolitical analysis |
| 5 | CRSSS Journal, 2024 | The Geopolitical Impact of Artificial Intelligence | AI is reshaping economic power, international relations & global policy frameworks | Motivated integration of economic indicators & global relations in our model |

---

## 6. Software Requirements Specification (SRS)

### Overview & Purpose
To build a **secure, transparent, decentralized lending platform** that enables borrowers and lenders to transact without intermediaries.

### Functional Requirements
- User Registration & KYC Verification
- Loan Request Creation by Borrowers
- Lender Offer Creation & Management
- Smart Contract Deployment & Automation
- Escrow Management & Fund Transfer
- Repayment Tracking & Penalty Handling
- Credit Scoring & Risk Assessment (AI/ML)
- Dashboard for Portfolio & Transaction Tracking
- Notifications & Real-time Updates
- Dispute Resolution & Support System

### Non-Functional Requirements
- **Performance:** Fast, responsive platform (<3 sec response time)
- **Security:** End-to-end encryption, authentication, smart contract security
- **Usability:** Intuitive & user-friendly interface
- **Reliability:** High availability & data consistency
- **Scalability:** Scalable for growing users & transactions
- **Maintainability:** Modular code & easy to maintain

### Users & Roles
- **Borrowers:** Users who request loans
- **Lenders:** Users who provide funds
- **Admins:** Manage platform, users, and system settings
- **Auditors:** Monitor transactions & platform activities
- **Support Agents:** Handle user queries and disputes

### Technical Specifications
| Component | Technology |
|---|---|
| Operating System | Windows, Linux, or macOS |
| Programming Languages | Python / JavaScript / Solidity |
| Development Tools | VS Code or any standard IDE |
| Blockchain Platform | Ethereum or similar |
| Database | MySQL or MongoDB |
| Libraries/Frameworks | Web3.js, Pandas, NumPy, Scikit-learn |

---

## 7. Selected Domains & Strategic Focus

| Domain | Focus Area | Justification |
|---|---|---|
| **Blockchain & DeFi** | Smart Contract Enforcement | Immutable loan logic — creation, funding, repayment, and liquidation encoded as protocol rules. No intermediary required. |
| **Machine Learning & Credit Risk** | Explainable Risk Tiering | Gradient-boosted model (LightGBM) maps borrower signals to discrete risk tiers A/B/C, each driving LTV, APR, and collateral settings. |
| **Decentralized Identity** | KYC-Bound Wallets | Off-chain KYC verification anchored to wallet addresses. PII never on-chain. Selective disclosure via IPFS hashing. |
| **Oracle Infrastructure** | Collateral Monitoring | Chainlink price feeds provide real-time collateral valuation. Circuit breakers and multiple feed fallback handle oracle failures. |

---

## 8. Methodology — 12-Step Workflow

The platform operates as a **structured, transparent & automated lending ecosystem**:

**Step 1 — User Registration & KYC**
Users (borrowers/lenders) sign up on the platform and complete KYC verification to ensure trust and compliance. A wallet is created/linked for transactions.

**Step 2 — Loan Request / Offer Creation**
Borrowers create loan requests specifying amount, purpose, interest rate & tenure. Lenders create offers with amount, interest rate & terms.

**Step 3 — Smart Contract Deployment**
A smart contract is deployed on the blockchain containing the loan terms, conditions, repayment schedule & penalty clauses.

**Step 4 — Matching & Agreement**
The system matches suitable lenders with borrower requests based on terms, risk score & preferences. Both parties agree; smart contract is locked.

**Step 5 — Fund Transfer (Escrow)**
Lenders' funds are transferred to the smart contract escrow. Funds remain locked until loan disbursement conditions are met.

**Step 6 — Loan Disbursement**
Upon agreement and verification, the smart contract automatically disburses the loan amount to the borrower's wallet.

**Step 7 — Repayment via Smart Contract**
Borrower repays as per schedule. Smart contract automatically handles instalment collection, interest calculation & penalty (if any).

**Step 8 — Transaction Recording & Transparency**
All transactions are recorded on the blockchain ledger ensuring immutability, transparency & auditability for all participants.

**Step 9 — Analytics, Rating & Insights**
AI/ML models evaluate borrower risk & creditworthiness. Dashboard provides portfolio insights, repayment status, returns & platform analytics.

**Step 10 — Dispute Resolution**
In case of disputes, predefined rules & community governance (oracles/arbitration) are triggered to resolve issues fairly.

**Step 11 — Rewards & Incentives**
Platform tokens/incentives are distributed to active lenders, early repayers & referrers to encourage participation.

**Step 12 — Reporting & Compliance**
System generates compliance reports, transaction history & tax statements for users and regulatory purposes.

---

## 9. Proposed System & Multi-Layer Architecture

### Proposed System Summary
- Blockchain-based decentralized P2P lending platform
- Smart contract–based loan lifecycle management
- AI/ML risk scoring with explainable predictions
- KYC-bound wallet identity verification
- Real-time collateral monitoring via oracles
- Secure IPFS-based decentralized document storage
- Transparent on-chain audit trail & transaction tracking
- Dashboard for borrowers, lenders & analytics
- Automated liquidation and repayment enforcement

### Multi-Layer Architecture

**Layer 1 — Frontend Layer**
- React / Next.js
- Web3-enabled borrower & lender dashboard
- WalletConnect / MetaMask integration

**Layer 2 — Backend & Off-Chain Services**
- FastAPI microservices
- ML Risk Engine (LightGBM)
- SHAP Explainability Service
- User Service & Authentication Service

**Layer 3 — Blockchain Layer**
- Ethereum / Arbitrum / Optimism
- Solidity Smart Contracts
- Core contracts: LoanFactory, LoanContract, CollateralVault

**Layer 4 — Storage Layer**
- IPFS Decentralized Storage
- Encrypted metadata & loan documents

**Layer 5 — Oracle & Integration Layer**
- Chainlink Price Feeds
- Chainlink Keepers
- Real-time Collateral Monitoring

**Layer 6 — AI / ML Layer**
- Python, Scikit-learn, Pandas, NumPy
- Risk Tier Prediction (A/B/C)
- Fraud Detection
- Borrower Profiling

---

## 10. System Architecture Blueprint

### User Interface Layer
- **Borrower/Lender Dashboards** — Built on React / Next.js
  - Loan application UI
  - Risk score display
  - Encrypted PII submission

### Off-Chain Services Layer
- **User Service / DB**
  - `userRecords`, `encryptedPII`
  - Methods: `storeProfile()`, `fetchUser()`
- **FastAPI / ML Service** — XGBoost & LightGBM
  - Methods: `scoreRisk(data)`, `generateSHAP()`
- **XAI / SHAP Service**
  - Outputs: `shapValues`
  - Methods: `explain()`, `getReason()`

### Blockchain Network Layer (L2 — Arbitrum / Optimism)
- **Blockchain Node**
  - `nodeAddress`, `chainId: uint`
  - Method: `broadcastTx()`
- **LoanFactory**
  - `activeLoans: Loan[]`, `platformSettings`
  - Methods: `deployLoan(data)`, `getLoanCount()`, `getSettings()`
- **UserRegistry**
  - `users: Borrower()`
  - Methods: `createProfile()`, `getUserProfile()`, `updateKYC()`
- **Loan Contract**
  - Fields: `borrower: address`, `principal: uint`, `state: LoanState`
  - Methods: `fundLoan()`, `repayLoan()`
- **CollateralVault**
  - Fields: `collateralAmt: uint`, `liqThreshold`
  - Methods: `deposit()`, `lock()`, `liquidate()`

### AI Risk Engine Layer (L2 — Arbitrum / Optimism)
- **AIRiskEngine** — `borrowerDataInput`, `SHAPCache`
  - Methods: `analyzeBorrower()`, `generateRiskTier()`
- **XGBoost Model** — `featureWeights`, `threshold: float`
  - Methods: `predict(features)`, `explainSHAP()`
- **ChainlinkOracleInterface** — `oracleAddress`
  - Methods: `getLatestPrice()`, `callOracle()`

### Decentralized Storage Layer
- **IPFS Storage**
  - `gatewayUrl: string`, `encryptedMeta`
  - Methods: `storeFile(data)`, `retrieveFile(hash)`, `pinContent()`

### External Integrations
- **Chainlink Oracle** — `oracleAddress`, `priceFeed: map`
  - Methods: `getLatestPrice()`, `getRoundData()`, `provideFeed()`
- **Chainlink Keepers** — `upkeepId: uint`, `interval: uint`
  - Methods: `checkUpkeep()`, `performUpkeep()`, `triggerLiquidation()`

---

## 11. Layer-by-Layer Breakdown

### 1 — User Interface Layer
React / Next.js frontend renders role-aware dashboards for Borrowers and Lenders. User creates an application → encrypted PII is submitted. Risk score is returned from the ML service and displayed before any contract interaction.

### 2 — Off-Chain Services Layer
Three microservices handle off-chain logic:
- **User Service / DB** — stores user metadata securely
- **FastAPI ML Service (XGBoost / LightGBM)** — generates a risk score (Low / Med / High)
- **XAI Service** — produces SHAP explanations for each risk score

### 3 — External Integrations
- **Chainlink Oracle** — provides real-time collateral price feeds to smart contracts
- **Chainlink Keepers** — monitors loan health and automatically triggers liquidations or scheduled payments when thresholds are crossed

### 4 — Decentralized Storage (IPFS)
Encrypted application metadata, PII, and documents are stored on IPFS via a gateway. Only encrypted metadata and content-addressed hashes are written — **no plaintext PII is ever exposed on-chain or in public storage.**

### 5 — Blockchain Network Layer (L2: Arbitrum / Optimism)
The Blockchain Node receives encrypted data and transaction requests from the UI layer. Smart Contracts deployed on L2:
- **LoanFactory** — creates Loan Contracts and UserRegistry on demand
- **Loan Contract** — manages funding, repayment schedule, and delinquency states
- **CollateralVault** — locks collateral, monitors LTV, and executes liquidation logic
- **UserRegistry** — stores wallet-bound verified identity status

---

## 12. Class Diagram — Core Smart Contract Entities

### Entities & Relationships

**User** (base class)
- Subclasses: `Borrower`, `Lender`
- Methods: `createUserProfile()`, `getUserProfile()`, `updateKYCStatus()`

**LoanFactory**
- Fields: `activeLoans: Loan[]`, `userRegistryAddress`, `collateralVaultFactory`, `settings: PlatformSettings`
- Methods: `deployLoan(data)`, `getLoanCount()`, `getPlatformSettings()`
- Creates: `Loan`, `UserRegistry`

**UserRegistry**
- Stores: `Borrower/Lender` references

**Loan**
- Fields: `borrower: address`, `lender: address`, `principal: uint`, `interestRate: uint`, `dueDate: uint`, `riskTier: RiskTier`, `state: LoanState` (FUNDED, REPAID, DEFAULTED)
- Methods: `fundLoan()`, `repayLoan()`, `defaultLoan()`

**CollateralVault**
- Fields: `loanID: uint`, `collateralAmount: uint`, `collateralAsset`, `liquidationThreshold`
- Methods: `deposit()`, `lock()`, `liquidate()`

**AIRiskEngine**
- Fields: `borrowerDataInput`, `SHAPExplanationsCache`
- Methods: `analyzeBorrowerData(data)`, `generateRiskTier&SHAP()`, `callXGBoostModel()`

**XGBoostModel**
- Methods: `analyzeBorrowerData()`, `generateRiskTier&SHAP()`, `callXGBoostModel()`

**ChainlinkOracleInterface**
- Fields: `oracleAddress`
- Methods: `getLatestPrice(asset)`, `callOracle()`

**IPFS_Storage**
- Fields: `gatewayUrl`
- Methods: `storeFile()`, `retrieveFile(hash)`

---

## 13. Existing Systems Comparison

| Feature | Traditional Banks | Aave / Compound | LendingClub | **Our Platform** |
|---|---|---|---|---|
| Intermediary Required | Yes — full | No | Partial | **No** |
| Credit Scoring | Manual/FICO | None (over-col) | Traditional | **ML Risk Tiers A/B/C** |
| Explainability | Opaque | N/A | Opaque | **SHAP-based** |
| Smart Contract Logic | No | Yes (basic) | No | **Full lifecycle** |
| Risk-adjusted LTV | Manual | Fixed 150%+ | Not applicable | **Dynamic by tier** |
| On-chain Audit Trail | No | Partial | No | **Full event log** |
| Privacy Architecture | Centralised | Fully public | Centralised | **Off-chain PII, on-chain hashes** |
| Model Governance | N/A | N/A | Limited | **Versioned + recalibrated** |

---

## 14. Novelty & Innovation

### 1. Risk Tier → Contract Parameter Mapping
ML output is not just a score. It **deterministically drives LTV, APR spread, and collateral rules inside the smart contract.** Risk is enforced, not just displayed. No existing DeFi protocol does this.

### 2. Explainable ML in a DeFi Context
SHAP-based explanations are surfaced to users **before signing any contract.** Borrowers see why their tier exists. Lenders see ML summaries in the marketplace. This is virtually absent from all existing DeFi systems.

### 3. Hybrid Off-Chain / On-Chain Architecture
PII, ML inference, and KYC stay off-chain. Contract enforcement, collateral state, and audit events live on-chain. This is the correct architectural separation that the literature demands but prototypes rarely implement.

### 4. Full Lifecycle Model Governance
Versioned models, weekly recalibration, rollback paths, anomaly alerting, and champion-challenger evaluation. **The platform treats ML as a living system — not a one-time training artifact.**

---

## 15. Future Scope

The platform is architected from the ground up to support these extensions without re-engineering the core protocol.

### 01 — Network-Based Credit Scoring
Incorporate graph-centrality features (PageRank, Katz, betweenness) from marketplace loan similarity networks. Liu et al. (2024) showed AUC gains from 0.76 to 0.88 with this approach.

### 02 — NLP / LLM Risk Signals
Integrate BERT-based borrower narrative analysis as an additional feature layer. Sanz-Guerrero & Arroyo (2025) demonstrated measurable AUC improvement when textual signals complement tabular data.

### 03 — Under-Collateralized Lending
Extend the platform to support partial or unsecured loans for top-tier borrowers. The zScore paper (Udupi et al., 2025) proposes on-chain reputation systems that can unlock capital-efficient lending.

### 04 — Federated & Privacy-Preserving ML
Adopt federated learning to train risk models across institutions without sharing raw data. Jovanovic et al. (2024) explicitly propose this as the next frontier for blockchain-integrated credit assessment.

### 05 — Financial Inclusion & Thin-File Borrowers
Extend credit access to borrowers with limited traditional history using on-chain behavioral signals, mobile money records, and e-commerce activity — addressing the exclusion gap identified by Israel (n.d.).

### 06 — Mainnet & Cross-Chain Deployment
Graduate from testnet to mainnet on Arbitrum/Optimism. Future iterations can support cross-chain collateral bridging and interoperability with DeFi protocols like Aave and Compound.

---

## 16. Conclusion

> *"Not just AI + Blockchain — an explainable, auditable, and enforceable P2P lending system built on literature and engineering discipline."*

### Research Gap Addressed
No existing system combines explainable ML, privacy-aware KYC, over-collateralized smart contract enforcement, and lender transparency in one end-to-end architecture.

### Literature-Backed Design
- Gradient-boosted ML (Chang et al.)
- SHAP explainability (Jovanovic et al.)
- Blockchain as trust infrastructure (Kumar et al.)
- MLOps lifecycle governance (PDx, Amed et al.)

### Production-Minded MVP
CI/CD pipelines, threat model, gas-optimised L2 contracts, Chainlink oracle-aware liquidation, event-indexed dashboards, and weekly model recalibration built to engineering standards.

---

## Technology Stack Summary

| Layer | Technologies |
|---|---|
| Frontend | React, Next.js, Web3.js, WalletConnect, MetaMask |
| Backend | FastAPI (Python), Node.js / Express.js |
| Blockchain | Ethereum, Arbitrum, Optimism, Solidity |
| Smart Contracts | LoanFactory, LoanContract, CollateralVault, UserRegistry |
| ML / AI | Python, Scikit-learn, LightGBM, XGBoost, Pandas, NumPy, SHAP |
| Storage | IPFS, MySQL / MongoDB |
| Oracles | Chainlink Price Feeds, Chainlink Keepers |
| DevOps / Security | Slither, Mithril, Grafana, CI/CD pipelines |
