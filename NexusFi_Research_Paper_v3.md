# **Encoding Explainable AI Risk Scores into Self Enforcing On-Chain Peer to Peer Loans** 

Afan Khan, Siddharth Singh, Atharva Patil, Viren Rathod 

_Computer Engineering, KJ Somaiya College of Engineering Mumbai, India_ 

**_Abstract._** Blockchain lending platforms face a transparency paradox. Every transaction is publicly verifiable, yet the lending decision itself stays opaque. Pooled protocols price borrowers through utilization curves that reduce them to an address, while peer to peer protocols usually skip underwriting and lean on heavy over collateralization. Either way, a lender funding a specific request has little to judge beyond a collateral ratio. This paper presents NexusFi, an over collateralized peer to peer lending protocol on Ethereum (Sepolia testnet) that links explainable credit prediction to enforceable on chain terms. An eight feature LightGBM model with SHAP attributions assigns each borrower a risk tier that maps directly to a maximum loan to value ratio, an interest spread, and a liquidation buffer. All three are written into the loan contract at creation, so the terms a lender reads on chain are the direct output of the rules the borrower saw. A claim credibility layer checks self reported borrower attributes against on chain history and penalizes inconsistency. The full loan lifecycle, covering funding by one or multiple lenders, interest accrual, partial and full repayment, and liquidation under either of two conditions, runs on audited smart contracts with a fail closed oracle path. We describe our design process, the research that shaped it, the resulting architecture, and evaluation through 131 tests and live end to end operation, then discuss limitations and paths to production. 

**_Index Terms._** _blockchain, decentralized finance, peer to peer lending, explainable artificial intelligence, smart contracts, credit risk, collateralization_ 

## I. INTRODUCTION 

Decentralized lending has grown into one of the largest applications of blockchain technology, promising faster access to credit, reduced intermediation, and publicly auditable execution. Yet the transparency that blockchains provide is transparency of record, not of reasoning. A borrower can verify that a loan exists and see its terms on chain, but cannot see why those terms were assigned. A lender can inspect every past transaction of a wallet, but is given no structured basis on which to price the risk of funding it. 

This produces two dominant but unsatisfying models. In pooled protocols, interest rates emerge from utilization curves and the borrower is treated as an anonymous address, so pricing is systematic but impersonal and unexplained. In direct peer to peer protocols, there is often no underwriting at all, and the lender's only protection is a large collateral cushion. Neither model equips a lender who is funding one specific request to answer a basic question. Is this borrower a better or worse risk than the collateral ratio alone suggests, and why. 

Our approach treats the risk decision as a first class, explainable, and enforceable artifact rather than a hidden backend step. We score each borrower against a small set of 

weighted on-chain and off-chain features, expose the full breakdown, and convert the resulting risk tier into three protocol parameters that are written directly into the loan contract at creation time. Because those same parameters govern how much can be borrowed, what interest accrues, and when liquidation triggers, the explanation a borrower sees and the terms a lender reads are two views of one rule set. What makes this integration non trivial, and distinguishes it from prior frameworks that stop at prediction or remain in simulation, is two mechanisms. The first is the deterministic binding of ML output to on chain terms. The second is a claim credibility layer that detects and penalizes borrowers whose self reported attributes contradict their observable on chain history. 

This paper makes the following contributions. 

- 1) A hybrid off-chain and on-chain architecture in which explainable ML risk scoring is bound deterministically to smart contract enforced loan terms, deployed and operated live on a public testnet. 

- 2) A claim credibility mechanism that cross references self reported borrower data against on chain evidence and applies a dishonesty penalty to the risk score. 

- 3) A collateral and liquidation design that freezes debt in USD at funding while collateral floats, using a fail closed oracle path and two independent liquidation triggers. 

- 4) A documented account of our design process, the literature study that informed it, and an evaluation covering correctness testing and live end to end operation, together with an honest discussion of limitations. 

The remainder of this paper is organized as follows. Section II reviews related work in credit scoring, explainable AI, and blockchain lending, and positions our system against it. Section III describes our design approach and the system architecture. Section IV details the risk engine. Section V covers implementation, results, and discussion. Section VI concludes with limitations and future work. 

## II. RELATED WORK 

Research relevant to this system spans four areas that have largely developed in isolation. Our design draws on all of them. 

## _A. Credit Risk Modeling_ 

Traditional scorecards built on logistic regression and similar statistical methods remain valued for interpretability and regulatory familiarity, but the literature consistently finds them too narrow for dynamic, data rich lending. Jovanovic et al. [1] argue that such models depend too heavily on static application time information and fail to capture broader behavioral signals. In the peer to peer setting, Chang et al. [2] 

show that gradient boosting methods such as XGBoost and LightGBM outperform logistic regression and neural baselines on Lending Club data, which supports the move toward tree based ensembles for structured credit data. Liu et al. [3] reinforce this while identifying the structural weakness specific to peer to peer markets, namely that the platform scores risk while the lender bears default, a misalignment that raises the stakes of accurate assessment. 

## _B. Richer Data and Explainability_ 

Recent work extends credit models beyond bureau style variables toward transactional, behavioral, and on chain signals, and toward methods such as SHAP and LIME that make model output inspectable. Jovanovic et al. [1] stress that modern credit assessment must be not only accurate but also transparent, traceable, and governable, and they note that many blockchain credit systems achieve ledger level transparency without achieving decision level transparency. Sanz-Guerrero and Arroyo [4] demonstrate that textual signals from loan descriptions can add predictive value, while cautioning that language model derived indicators introduce opacity and bias risks of their own. 

## _C. Blockchain as Lending Infrastructure_ 

Kumar et al. [5] present an Ethereum based peer to peer lending framework for small and medium enterprises, implemented in Solidity and simulated with Ganache, covering registration, bidding, repayment, and tokenized lender liquidity. Chowdhury [6] proposes a dual layer architecture combining machine learning risk prediction with blockchain backed verification and automated contract execution. Both establish feasibility, and both explicitly describe themselves as prototypes that remain short of production, with open issues around collateral design, oracle reliability, explainability, and post deployment governance. 

## _D. Model Lifecycle Reliability_ 

The PDx work of Amed et al. [7] shows that static credit models degrade after deployment and argues for continuous validation and champion challenger governance. This concern is amplified when model output drives enforceable contract parameters rather than advisory recommendations. 

## _E. Positioning of NexusFi_ 

Taken together, this body of work leaves a specific gap. Existing systems tend to solve one part of the problem in isolation. They improve prediction without showing how output becomes enforceable terms, they achieve immutability without decision transparency, or they demonstrate workflow feasibility without risk aware collateral logic and lender facing trust. The closest recent neighbors confirm both the momentum and the gap. Madugula, Esteva de la Rosa, and Shankar [8] integrate SHAP interpretable risk models with on-chain pricing on Ethereum, a framework that overlaps our aims but centers on a Reverse Kelly automated market maker for pricing rather than on deterministic tier binding and claim verification. Contemporary frameworks published through venues such as SJAIBT [9] and PeerJ [10] fuse on chain behavioral metrics, off chain data, and explainable AI for blockchain credit scoring, 

but remain at the level of proposed frameworks or classification studies rather than live end to end protocols. NexusFi sits within this same intersection. Its distinguishing choices are that the explainable risk tier is bound deterministically to the three parameters written into the loan contract at creation, that self reported borrower attributes are cross checked against on chain evidence and penalized when inconsistent, and that the complete lifecycle operates live on a public testnet rather than in simulation. 

## III. DESIGN APPROACH AND SYSTEM ARCHITECTURE 

## _A. Design Approach_ 

Our guiding principle was closed world simulation with real execution. Every component that a production protocol must get right is implemented for real, including the smart contracts, the wallet interactions, the collateral custody, the liquidation logic, and the on-chain reads that drive the interface. Only the inputs that cannot be sourced safely on a testnet are simulated, namely the collateral price feed and, in demonstration mode, a set of synthetic borrower personas. This boundary was a deliberate design position rather than a shortcut. It lets us prove that the enforcement layer behaves correctly under real conditions while keeping the parts that depend on live markets or private user data controllable and reproducible. 

The second principle was that the risk decision must survive contact with the chain. Many designs compute a score and then hand a borrower a set of terms through the interface alone. We instead required that the only numbers the risk engine is allowed to produce are the exact parameters the contract will enforce, and that those parameters are written into the loan at creation. This forced the risk model and the protocol to share one vocabulary and removed any gap between what a borrower is told and what the code does. 

## _B. Architectural Overview_ 

The system is divided along a single boundary. On chain we keep loan state, collateral custody, interest accrual, and liquidation, because these are the operations that must be trustless and verifiable. Off chain we keep machine learning inference, identity verification, price display, and all personally identifying data, because these are either computationally heavy, privacy sensitive, or dependent on external sources. A browser client built on Next.js and wagmi mediates between the two, sending signed writes directly to Sepolia and polling the contracts for reads through a server side proxy. Fig. 1 shows the full arrangement. 

_[ Insert Fig. 1 system architecture diagram here ]_ Fig. 1. NexusFi system architecture showing the on chain and off chain boundary. 

## _C. Smart Contract Layer_ 

The on chain core is four contracts written in Solidity 0.8.28 against OpenZeppelin 5 and deployed with Hardhat Ignition. A LoanFactory deploys one Loan contract per request, forwards the borrower collateral to a shared vault, and maintains a paginated registry of loan identifiers. Each Loan governs the full lifecycle of a single request, exposing funding, partial and 

full repayment, cancellation, and liquidation, along with the view functions the interface polls for outstanding balance and current loan to value. A CollateralVault is the sole custodian of ETH collateral and holds one position per loan, with locking restricted to the factory and release or liquidation restricted to the owning loan. A MockPriceFeed supplies the ETH to USD value that each loan reads when it evaluates liquidation. The mock is testnet only by design, and its role is confined strictly to price input so that the surrounding enforcement logic is exactly what a production deployment would run. 

## _D. Off Chain Services and Data_ 

The off chain side comprises three parts. The first is a set of server route handlers that keep secrets and heavy reads away from the browser, covering price display, market data, news, identity sessions, and a proxy to the risk scorer. Identity uses a signature based wallet linking challenge and a sandbox know your customer flow with verified webhooks, and verified status is bound to the wallet rather than stored as public data. The second is a Supabase Postgres store with row level security on every table, holding profiles, linked wallets, screening results, audit logs, and the persisted risk explanation for each loan. The third is an optional risk scoring service that reads mainnet and testnet history, assembles a feature vector, and returns a tier with an explanation. Sensitive data never crosses onto the chain, and the chain never holds anything beyond loan state, collateral, and the enforced parameters. 

## _E. Notable Design Decisions_ 

First, the borrower feature breakdown is computed in the browser and would ordinarily be lost once the session ends, so it is persisted against the deployed loan address and made readable to any signed in user. This is what allows a lender to inspect the reasoning behind a tier they did not compute, which is central to the paper transparency claim. Second, each loan stores only the price observed at funding, so any figure expressed in dollars elsewhere in the system is drawn from price snapshots captured the first time the client observes an event and never rewritten. Events that predate this record are labelled as estimated at the current price rather than valued silently, which keeps the financial statements honest about what is measured and what is inferred. 

## IV. THE RISK ENGINE 

The risk engine is the component that turns a borrower into a set of enforceable terms. It runs entirely off chain and produces exactly three numbers that the contract will accept, which keeps the machine learning free to be as rich as the available data allows while the protocol stays simple and deterministic. 

## _A. Two Scoring Paths_ 

The engine operates in two modes. Persona mode runs a transparent rule set in the browser against three synthetic borrower profiles, one per tier, and is used for demonstration and testing where live wallet history would be unavailable or uninformative. Connected wallet mode posts the borrower request to a scoring service that pulls real mainnet history, cross checks the borrower self reported claims against it, applies a 

penalty for inconsistency, and runs a LightGBM classifier with SHAP attributions to produce the tier and its explanation. When the scoring service is unreachable, the interface reports this rather than scoring silently, so a borrower is never assigned terms from an unknown process. 

## _B. Feature Set and Scoring_ 

The model scores eight weighted features. Each feature scorer returns a value in the range negative one to positive one, the weights sum to one, and the weighted sum is clamped back to the same range. Six features are drawn from on chain behavior and two from off chain self reported metadata. Table I lists the features and their weights. 

### **TABLE I** 

_Risk Engine Feature Set and Weights_ 

|**Feature**|**Weight**|**Source**|
|---|---|---|
|DeFi loan history|0.25|On chain|
|Wallet age|0.15|On chain|
|Mixer interaction|0.15|On chain|
|Transaction volume|0.10|On chain|
|DeFi breadth|0.10|On chain|
|Average balance over 90 days|0.10|On chain|
|Income band|0.10|Off chain|
|Employment type|0.05|Off chain|



Every breakpoint in every scorer is exported and rendered in the interface, so the mapping from a raw value to a feature score is public rather than hidden. For example, a wallet older than 365 days scores positive 0.80 while one under 90 days scores negative 0.60, and a borrower with two or more repaid loans and no liquidations scores positive 0.90 while any prior liquidation scores negative 0.80. A detected mixer interaction scores negative 1.00, the single largest penalty in the model, reflecting that contact with a coin mixer is the strongest available negative signal. Two attributes in the borrower data, sanction proximity and loan purpose, are deliberately excluded from scoring, since neither could be scored without introducing bias or unverifiable assumptions. 

## _C. Tier Assignment_ 

The clamped weighted sum is reduced to a discrete tier. A score of at least 0.40 assigns Tier A, a score of at least 0.00 assigns Tier B, and any lower score assigns Tier C. Reducing a continuous score to three tiers is intentional, because the contract needs a small, stable set of parameter bundles rather than a continuously varying rate, and because a tier is far easier for a borrower and a lender to reason about than a raw number. 

## _D. Tier to Terms Mapping_ 

Each tier maps deterministically to a fixed bundle of loan parameters. The base annual rate is six percent for every borrower, and the tier sets the spread added on top of it, the maximum loan to value ratio, the liquidation buffer, and a collateral haircut. Table II gives the full mapping. 

### **TABLE II** 

||_Dete_|_rministic Ti_|_er to Loan Pa_|_rameter Map_|_ping_||
|---|---|---|---|---|---|---|
|**Tier**|**Max**<br>**LTV**|**Buffer**|**Liq.**<br>**Thresh.**|**Haircut**|**Spread**|**APR**|
|A|70%|10%|80%|0%|2%|8%|
|B|60%|12%|72%|5%|5%|11%|



|**Tier**|**Max**<br>**LTV**|**Buffer**|**Liq.**<br>**Thresh.**|**Haircut**|**Spread**|**APR**|
|---|---|---|---|---|---|---|
|C|50%|15%|65%|10%|9%|15%|



From these parameters the engine computes the collateral requirement and the interest owed. Writing collateral value in dollars as the product of collateral in ETH, price, and one minus the haircut, the sizing follows 

_− adjustedCollateralUsd = collateralEth × price × (1 haircut)_ 

## _maxBorrowUsd = adjustedCollateralUsd × maxLtv_ 

## _− requiredCollateralEth = loanUsd / (maxLtv × (1 haircut) × price)_ 

_interestUsd = loanUsd × (baseApr + spread) × tenorDays / 365_ 

Only three of these quantities ever cross onto the chain, namely the interest rate, the maximum loan to value ratio, and the liquidation buffer, each passed as an argument when the loan is created. The haircut never appears on-chain. It shapes how much collateral the borrower is required to post in the first place and then plays no further role, which keeps the contract stored state minimal while still letting risk influence collateralization. 

## _E. Claim Credibility Layer_ 

The mechanism that most distinguishes this engine is its treatment of self reported data. A borrower supplies attributes that a naive system would simply trust, such as a claim of no mixer use or a claim of prior DeFi borrowing. In connected wallet mode the scoring service verifies each such claim against on chain evidence before it is used. A claim of no mixer use is checked against detected contact with a coin mixer, and a claim of prior DeFi history is checked against actual repayment and liquidation logs on a major lending protocol. When a claim contradicts the on chain record, a dishonesty penalty is applied to the score, so a borrower who misrepresents their history is treated as a worse risk than one who reports the same history truthfully. This turns the public and difficult to falsify nature of on chain data into a defense against misreporting, and it does so within the same explainable pipeline, because the penalty appears in the feature attribution alongside every other contribution to the final tier. 

## V. IMPLEMENTATION, RESULTS, AND DISCUSSION 

## _A. Deployment_ 

The system is deployed live on the Ethereum Sepolia testnet, with the factory, vault, and price feed each at a fixed public address and one loan contract deployed per request. The contracts are built with Solidity 0.8.28, OpenZeppelin 5, and Hardhat Ignition with the optimizer enabled, and source verification is configured through Sourcify and Blockscout. The client is a Next.js and React application using wagmi and viem, with server side proxies that keep the RPC key private 

and that serve the event log queries whose range exceeds what the application RPC allows. The complete lifecycle runs end to end from the interface. A borrower creates a request with collateral locked in the same transaction, one or more lenders fund it until the requested principal is met, which is forwarded to the borrower atomically, the borrower repays in installments or in full with any surplus refunded, and either party sees liquidation resolve with only the outstanding debt seized. 

## _B. Correctness Evaluation_ 

Because the borrower inputs in demonstration mode are synthetic, our evaluation targets correctness of enforcement rather than predictive accuracy on a labelled loan dataset, which we return to in the limitations. The protocol is covered by 131 automated tests, of which 28 exercise the contracts and 103 exercise the risk and terms logic. The contract tests cover loan creation and funding, partial repayment sequences, overpayment refunds, the interest formula at the deadline boundary and its cap past the grace period, every liquidation gate, the price trigger including its exact threshold, price recovery returning a position to health, the zero price fail safe, partial liquidation fairness, and the demonstration controls. The risk and terms tests cover the tier configuration, the sizing formulas, every feature scorer and its breakpoints, the tier boundaries, and the synthetic personas. All 131 tests pass. Beyond automated testing, two person manual testing across nine loans on live Sepolia is recorded as complete and verified against on-chain state. 

## _C. Worked Liquidation Example_ 

A borrower takes one ETH against two ETH of collateral when ETH is worth 2,000 dollars, which places the loan at fifty percent loan to value against an eighty percent threshold. Because principal and collateral are both denominated in ETH, their ratio alone can never move, so the contract freezes the debt in dollars at funding while the collateral value continues to float with price. Solving for the price at which the position reaches the threshold gives 1,250 dollars, and the test asserts the boundary exactly, confirming that the loan is not liquidatable at 1,251 dollars and is liquidatable at 1,250 dollars. When liquidation fires, the amount seized is the smaller of the outstanding balance and the collateral, and any surplus returns to the borrower in the same transaction, so partial repayments reduce the seizure one for one. 

## _D. Liquidation and Oracle Safety_ 

Liquidation can be called only by the lender, only on a funded loan, and only when one of two independent conditions holds. The first is delinquency, which occurs once the current time passes the funding time plus the loan duration plus a two day grace period. The second is collateral shortfall, which occurs once the current loan to value reaches the liquidation threshold. Interest accrues continuously from funding, capped once the loan passes its due date and grace period, past which the lender recourse is liquidation rather than an unbounded debt. 

The oracle path is deliberately fail closed. Every price read is wrapped so a missing or reverting feed returns zero, and the logic treats zero as unknown, not healthy. Loan to value returns 

zero when the loan is unfunded or the price is zero, and the liquidation check returns false on zero, so bad oracle data can never trigger a seizure, confirmed by a test that sets the feed to zero. Interface prices come from a separate source used only for display and term sizing, never as a liquidation input. 

## _E. Discussion and Limitations_ 

The results support the central claim that an explainable risk decision can be bound directly to enforceable on chain terms and operated live rather than in simulation, but several limitations bound what we have shown. Liquidation must be called by the lender, since there is no keeper or third party incentive, which is a documented design position rather than an oversight but does place a monitoring burden on the lender. The collateral price on the testnet comes from a mock feed with no staleness check or aggregation, so the fail closed behavior we tested is a substitute for, and not a demonstration of, a production oracle. Finally, and most important for the risk claim, connected wallet scoring has been exercised against real mainnet history but the model has not been evaluated for predictive accuracy on a labelled default dataset, because the demonstration path relies on synthetic personas. The tier assignment is therefore best understood as a transparent and consistent rule set rather than as a validated default predictor, and closing that gap is the first priority for future work. 

## VI. CONCLUSION AND FUTURE WORK 

This paper presented NexusFi, an over collateralized peer to peer lending protocol that treats the risk decision as an explainable and enforceable artifact rather than a hidden step. An eight feature model with SHAP attributions assigns each borrower a discrete tier, that tier maps deterministically to a maximum loan to value ratio, an interest spread, and a liquidation buffer, and those three numbers are written into the loan contract at creation, so the explanation a borrower sees and the terms a lender reads are two views of one rule set. A claim credibility layer turns the public nature of on chain history into a defense against misreporting by penalizing self reported attributes that contradict the record. The complete lifecycle, covering funding by one or multiple lenders, continuous accrual, repayment, and liquidation under two independent triggers with a fail closed oracle path, runs live on the Ethereum Sepolia testnet and is covered by a passing suite of 131 tests. 

denominated principal alongside the current ETH collateral. Together these steps would move the system from a working and honestly bounded prototype toward a protocol that could be considered for a regulated pilot. 

## REFERENCES 

- [1] Z. Jovanovic, Z. Hou, K. Biswas, and V. Muthukkumarasamy, "Robust integration of blockchain and explainable federated learning for automated credit scoring," _Computer Networks_ , vol. 243, art. 110303, 2024. 

- [2] A.-H. Chang, L.-K. Yang, R.-H. Tsaih, and S.-K. Lin, "Machine learning and artificial neural networks to construct P2P lending credit-scoring model: A case using Lending Club data," _Quantitative Finance and Economics_ , vol. 6, no. 2, pp. 303-325, 2022. 

- [3] Y. Liu, L. J. Baals, J. Osterrieder, and B. Hadji-Misheva, "Leveraging network topology for credit risk assessment in P2P lending: A comparative study under the lens of machine learning," _Expert Systems with Applications_ , vol. 252, art. 124100, 2024. 

- [4] M. Sanz-Guerrero and J. Arroyo, "Credit risk meets large language models: Building a risk indicator from loan descriptions in P2P lending," _Inteligencia Artificial_ , vol. 28, no. 75, pp. 220-247, 2025. 

- [5] D. Kumar, B. V. Phani, N. Chilamkurti, S. Saurabh, and V. Ratten, "A blockchain-based decentralized peer-to-peer lending framework for SMEs," in _Proc. Int. Conf. Intelligent Computing and Its Emerging Applications (ICEA 2023)_ , ACM, 2023, pp. 130-140. 

- [6] R. H. Chowdhury, "A machine learning framework for credit risk mitigation: Assessing the impact of AI and blockchain integration," _Int. J. Research and Innovation in Applied Science (IJRIAS)_ , vol. 10, no. 6, pp. 233-263, 2025. 

- [7] S. Amed, C. Y. Hang, and S. Banerjee, "PDx: Adaptive credit risk forecasting model in digital lending using machine learning operations," _arXiv preprint arXiv:2512.22305_ , 2025. 

- [8] S. S. Madugula, P. Esteva de la Rosa, and D. Shankar, "Explainable AIdriven dynamic loan pricing on Ethereum: Integration of SHAPinterpretable risk models, Reverse Kelly AMM, and blockchain trust mechanisms," _Preprints_ , 2026, doi:10.20944/preprints202605.1749.v1. 

- [9] "AI-based credit risk scoring in blockchain-enabled lending platforms," _Scientific Journal of Artificial Intelligence and Blockchain Technologies (SJAIBT)_ , 2025. [Author and volume details to be verified.] 

- [10] "AI-driven blockchain lending for sustainable development: A machine learning framework for loan risk and eligibility classification," _PeerJ Computer Science_ , art. cs-3686, 2026. [Author details to be verified.] 

We also described the process that produced this design. The literature study showed that prior work tends to solve prediction, infrastructure, and transparency in isolation, and that guided our decision to keep machine learning, identity, and sensitive data off chain while reserving the chain for state, collateral, and enforcement. That same study clarified what we have not yet shown, which shapes our future work. The immediate priorities are replacement of the mock price feed with a production oracle, and evaluation of the risk model for predictive accuracy on a labelled default dataset so that the tier assignment can be validated as a predictor rather than presented as a consistent rule set. Beyond these, we intend to add continuous model governance with drift monitoring and periodic recalibration, an events indexer to support scale beyond demonstration volume, and support for token 

