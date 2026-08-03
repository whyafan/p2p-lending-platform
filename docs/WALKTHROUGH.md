# NexusFi walkthrough

Study notes. One entry per contract, module and script: what it is, what it does, why it
exists, what breaks if you delete it, and the questions someone is most likely to press
you on, with the answers.

Read the contracts section first. Everything else in the system exists to produce inputs
for those five functions or to explain their outputs.

---

## Contents

- [The one-paragraph version](#the-one-paragraph-version)
- [Contracts](#contracts)
- [Contract tooling and tests](#contract-tooling-and-tests)
- [The risk engine, browser side](#the-risk-engine-browser-side)
- [The risk engine, service side](#the-risk-engine-service-side)
- [Chain access and event indexing](#chain-access-and-event-indexing)
- [Statements and receipts](#statements-and-receipts)
- [Identity, wallets and compliance](#identity-wallets-and-compliance)
- [Route handlers](#route-handlers)
- [Hooks](#hooks)
- [Components](#components)
- [Pages and app shell](#pages-and-app-shell)
- [Database migrations](#database-migrations)
- [CI](#ci)
- [Cross-cutting questions](#cross-cutting-questions)

---

## The one-paragraph version

A borrower is scored against eight weighted features and lands in tier A, B or C. The
tier maps deterministically to three numbers (max LTV, interest, liquidation buffer)
which are written into a freshly deployed `Loan` contract along with their collateral. A
single lender funds it in one transaction and the principal goes straight to the
borrower. The borrower repays in instalments or in full; the lender can liquidate on two
triggers, missing the deadline or the collateral falling too far against a USD debt
frozen at funding. Every payment moves as an internal contract transfer that wallets do
not display, so the app indexes event logs and builds receipts and statements from them.

---

## Contracts

### `contracts/contracts/Loan.sol`

**What it is.** One contract per borrow request. The escrow and enforcer for a single
loan's whole life.

**What it does.** Holds the agreed terms as immutables, then implements `fund`, `repay`,
`cancel` and `liquidate`, plus the view surface the UI polls (`outstandingBalance`,
`currentLtvBps`, `isLiquidatable`, `liquidationPreview`). It never custodies collateral;
it instructs `CollateralVault` to release or seize.

**Why it exists.** A per-loan contract means every request has its own address, its own
state and its own access control. A lender funding request 7 cannot touch request 8, and
the loan's terms are readable on chain by anyone without trusting an off-chain index.

**What breaks if you remove it.** Everything. This is the protocol.

The three ideas worth memorising:

1. **Debt is frozen in USD at funding.** Principal and collateral are both ETH, so their
   ratio never moves with price. `fund()` records `debtValueUsd = principalAmount * price
   at funding` and leaves the collateral to float. LTV is then frozen-debt over
   current-collateral-value, which does move when ETH falls. Without this the oracle
   would be decorative.

2. **Interest accrues continuously, with a cap.** `interestDue()` is `principal *
   interestBps * elapsedSeconds / (10_000 * 365 days)`. At exactly `durationDays` this
   equals a fixed-term calculation, so early repayment costs less and lateness costs
   more. Accrual stops at `repaymentDueAt() + GRACE_PERIOD`, because past that point the
   lender's remedy is to liquidate, not to watch an unbounded debt grow.

3. **Liquidation seizes only what is owed.** `min(outstandingBalance(), collateralAmount)`
   goes to the lender and the surplus returns to the borrower in the same transaction.
   Partial repayments shrink the seizure one for one.

**Interview questions**

> *An ETH-collateralised loan denominated in ETH cannot become undercollateralised.
> Why do you have a price oracle at all?*

Correct, and that is exactly the problem the contract solves. If both legs are ETH, the
ratio is constant and no price move can ever trigger anything. So at `fund()` the debt is
converted to USD once and stored: `debtValueUsd = principalAmount * priceAtFunding`. From
then on the debt is a fixed dollar figure and the collateral is valued live. If ETH
halves, the collateral securing that fixed debt is worth half as much, LTV doubles and
the position becomes liquidatable. Settlement stays in ETH throughout, so the borrower
never owes a different number of wei because the price moved. The USD figure exists only
to measure the lender's exposure.

> *What happens if the oracle returns garbage or reverts?*

Everything fails closed. `_readPrice()` wraps the call in try/catch and returns 0 for a
missing or reverting feed, so a broken oracle degrades to disabled instead of bricking
every view that touches price. `currentLtvBps()` returns 0 when the loan is not funded,
when `debtValueUsd` is 0, or when the price is 0, and callers are told to read 0 as
"unknown", never "healthy". `isPriceLiquidatable()` returns false on a 0 LTV, so bad
oracle data can never seize collateral. `fund()` only sets `debtValueUsd` when the price
is positive, so a loan funded while the oracle is down permanently runs on the deadline
trigger alone. There is a test that sets the feed to $0 and asserts `liquidate()` reverts.

> *Why is `liquidate()` restricted to the lender, when every real protocol pays keepers?*

Because there is no liquidation incentive in this design. A keeper who calls
`liquidate()` here gets nothing, so opening it up would only let a stranger close a
position they have no stake in, and in a system where the seizure is capped at the debt
there is no bonus to fund one with. The honest version of this answer is that it is a
documented limitation: liveness depends on the lender paying attention, and a real
deployment would need either a liquidation bonus or a protocol-run keeper. It is a
design position, not an oversight.

> *Why can a settled loan not drift?*

`closedAt` is stamped when status becomes Repaid or Liquidated, and
`_interestAccrualEnd()` freezes accrual there. Otherwise `outstandingBalance()` on a
repaid loan would keep ticking up forever and every statement would disagree with itself
depending on when it was generated.

---

### `contracts/contracts/LoanFactory.sol`

**What it is.** The single entry point for borrowers and the registry of every loan.

**What it does.** `createLoan()` takes the terms, claims the next id, deploys a `Loan`,
records the terms in a mapping, appends the id to an array, then forwards the attached
ETH to the vault. Also holds the shared price feed address and the `demoMode` flag that
every loan reads back.

**Why it exists.** Three reasons. It makes loan ids sequential and globally meaningful.
It gives the marketplace something enumerable to read, since a mapping is not iterable.
And it is the only address the vault trusts to lock collateral, so a Loan cannot be
created outside this path with a vault position attached to it.

**What breaks if you remove it.** No enumeration, so the lender marketplace has nothing
to list. No shared configuration, so every loan would have to be handed a feed address by
whoever deployed it. And the vault's `onlyFactory` guard would have nothing to point at.

**Interview questions**

> *Why does the factory not validate that the terms match the tier?*

Because the tier is an off-chain judgement and the contract has no way to verify it. The
factory enforces only structural bounds: non-zero principal, collateral, duration, and an
LTV in (0, 10000]. It does not check the principal against the collateral value at all,
which is why a test can create a 5 ETH loan against 2 ETH of collateral. Sizing is the
client's job in `lib/loan-terms.ts`. What the chain guarantees is not that the terms are
*correct*, it is that they are *fixed and public from creation*, so a lender reads the
same numbers the borrower was shown and neither side can revise them afterwards.

> *Why is there both `getLoanIds()` and `getLoanIds(offset, limit)`?*

The unpaginated one is convenient at demo volume and the app uses it. The paginated one
exists because the return value of the first grows without bound and will eventually
exceed what an RPC will serialise in one response. The paginated version also returns
`total` so a client can page without a second call, and returns an empty page rather than
reverting when the offset runs past the end.

> *Why is collateral moved to the vault last?*

Checks-effects-interactions. By the time `lockCollateral` is called the id is claimed, the
terms are stored and the registry is appended, so the external call cannot re-enter into
a half-built registry. The vault also only accepts this call from the factory, which
means the loan contract address it is told to trust is the one deployed two statements
earlier and cannot be substituted by a caller.

---

### `contracts/contracts/CollateralVault.sol`

**What it is.** The sole custodian of ETH collateral. One position per loan id.

**What it does.** `lockCollateral` is `onlyFactory` and records the borrower, the loan
contract and the amount. `releaseCollateral` and `liquidateCollateral` are `onlyLoan`,
meaning callable only by the exact loan contract recorded at lock time, and each is
one-shot per position.

**Why it exists.** Concentrating custody puts all the money behind one access-control
surface instead of one per request. A bug in a single `Loan` cannot drain another loan's
collateral, because the vault will not accept instructions about a position from a
contract that is not that position's own loan.

**What breaks if you remove it.** Each `Loan` would have to hold its own ETH, which means
auditing the withdrawal path once per deployed contract rather than once.

**Interview questions**

> *`onlyLoan` checks `msg.sender == positions[loanId].loanContract`. Why not keep an
> owner-managed allowlist?*

Because an allowlist is a privilege, and a privilege can be abused or lost. Authorising
against the address recorded when the position was created means a Loan can only ever
move its own collateral, and no admin role can move anyone's. The owner's only power in
this contract is `setFactory`, which decides who may *create* positions, never who may
drain them.

> *Why does `setFactory` exist at all instead of taking the factory in the constructor?*

Circular dependency. The factory needs the vault's address to deploy, so the vault must
exist first and be told about the factory afterwards. The Ignition module does exactly
that, and until that call lands `lockCollateral` reverts for everyone.

> *Walk me through the partial liquidation fix.*

Originally `liquidateCollateral` handed the lender the entire collateral regardless of
how much was still owed. A borrower who had repaid 90% of a loan and then went delinquent
lost everything, and the lender collected far more than the debt. Now the `Loan` computes
`min(outstanding, collateral)` and passes it in, the vault sends that to the lender and
the remainder to the *recorded* borrower, not to a caller-supplied address. Both are
covered by tests: one asserts the seizure falls by roughly the amount repaid, another
that a 90%-repaid loan returns more than it seizes.

---

### `contracts/contracts/MockPriceFeed.sol`

**What it is.** An ETH/USD price in whole dollars, with a setter anyone can call.

**What it does.** Stores a number. `latestPrice()` returns it. That is the entire
interface `Loan` depends on.

**Why it exists.** So a price crash can be demonstrated on demand. `setPrice` is
deliberately permissionless because gating it to the deployer would mean only one person
could ever run the liquidation demo.

**What breaks if you remove it.** The factory accepts `address(0)` for the feed, so the
protocol still runs, with price-based liquidation disabled and only the deadline trigger
live.

**Interview question**

> *This is a mock with no staleness check, no decimals, no aggregation, no circuit
> breaker and a permissionless setter. What would production need?*

Chainlink or an equivalent aggregator, read through the same `IPriceFeed` boundary so
only this one contract is replaced. Concretely you would need: multiple independent
sources with median aggregation, a staleness window after which the price is treated as
unavailable rather than stale, decimal handling instead of whole dollars, a deviation
circuit breaker so a single bad update cannot mass-liquidate, and ideally a TWAP for
liquidation decisions so a one-block wick cannot trigger seizures. The reason the current
mock is survivable is that `Loan` already treats an unavailable price as "do not
liquidate" rather than as a valid reading, so tightening the oracle only removes false
positives, it does not change the failure mode.

---

### `contracts/contracts/MockERC20.sol`

**What it is.** A mintable test token with a configurable decimals value.

**What it does.** Mints a billion units to the deployer, lets anyone mint more, and
reports whatever decimals it was constructed with.

**Why it exists.** So there are test tokens to work against on a local node or Sepolia.
The decimals are a constructor argument specifically so one contract can stand in for a
6-decimal USDC as well as an 18-decimal token, which is where decimal-handling bugs
actually show up.

**What breaks if you remove it.** Nothing in the live flow. The loan contracts are
ETH-only and no `Loan` ever touches an ERC-20. It is compiled and deployable
(`scripts/deploy-mock-tokens.ts`) but not wired in.

---

### `contracts/contracts/KYCRegistry.sol`

**What it is.** An admin-gated on-chain allowlist of approved wallets.

**What it does.** `approveWallet`, `approveWallets`, `revokeWallet`, `setAdmin`. Nothing
reads it.

**Why it exists.** It is the reference version of the compliance gate. The live flow
enforces KYC off chain, in Supabase, via `useCompliance`.

**What breaks if you remove it.** Nothing today.

**Interview question**

> *Why is KYC off chain when you have a contract for it?*

Because putting an identity allowlist on chain publishes the set of verified addresses
forever, which is a privacy problem, and because the check has to happen before the
transaction is signed anyway. The registry is what you would use if the *contract* needed
to refuse unverified callers. Here the app refuses first, so the on-chain copy would be
a second source of truth that can drift from the first. Keeping it in the repo
uncommitted to the flow is the honest position: it shows the design was considered and
rejected for this milestone, not overlooked.

---

## Contract tooling and tests

### `contracts/hardhat.config.ts`

Two Solidity profiles: `default` (no optimizer, fast compiles, readable traces for tests)
and `production` (optimizer on, 200 runs), which is what Ignition deploys with.
Verification must run with `--build-profile production` or the recompiled bytecode will
not match what is on chain. Etherscan verification stays disabled unless
`ETHERSCAN_API_KEY` is set, because enabling it keyless makes every verify run fail;
Sourcify and Blockscout need no key. Sepolia falls back to a public RPC so the network is
usable for reads with no `.env`, but deploys still need `SEPOLIA_PRIVATE_KEY`.

### `contracts/ignition/modules/NexusFiMilestone1.ts`

The deployment of record. Deploys the vault, then `MockPriceFeed` at $2,000, then the
factory with `demoMode = true`, then calls `setFactory` to close the circular reference.
Ignition tracks what it has already deployed per chain id, so re-running resumes rather
than duplicating, and the addresses it writes into `ignition/deployments/` are what
`frontend/.env.local` points at.

**What breaks if you remove it.** No reproducible deployment. `scripts/deploy-milestone1.ts`
is not a substitute; see below.

### `contracts/scripts/deploy-milestone1.ts`

Predates the Ignition module and has not been kept up to date: `LoanFactory` now takes
three constructor arguments and this passes one, so a run fails on the constructor. Still
referenced by `npm run deploy:local` and `deploy:ephemeral`. Use
`deploy:ignition:local` instead.

### `contracts/scripts/deploy-mock-tokens.ts`

Deploys mUSDC (6 decimals), mWETH (18) and mWBTC (8) and prints them as
`NEXT_PUBLIC_TOKEN_*` env lines ready to paste. Detects local versus Sepolia from the
chain id, compared in both bigint and number form because the runtime type varies with
the client.

### `contracts/test/NexusFiMilestone1.ts` and `LoanLifecycle.ts`

28 tests. The first file covers creation and funding. The second covers everything after:
partial repayment sequences, overpayment refunds, the interest formula at the deadline
boundary and its cap past the grace period, every `liquidate()` gate, the price trigger
including the exact `$1,250` boundary, price recovery un-liquidating a position, the zero
price fail-safe, partial liquidation fairness, and the `fastForward` guards.

The fixture is chosen so the arithmetic is checkable by hand: 1 ETH against 2 ETH at
$2,000 is 50% LTV, and 70% + 10% puts the threshold at 80%, which is exactly $1,250/ETH.
The boundary is asserted at both $1,251 (not liquidatable) and $1,250 (liquidatable).

**Interview question**

> *There is a long comment about timing in `LoanLifecycle.ts`. What is it protecting
> against?*

Hardhat's EDR network timestamps auto-mined blocks with real wall-clock time, and
`interestDue()` is now genuinely sensitive down to the second. A value read moments
before sending a transaction can be stale by the time it mines. So the tests never assert
against a pre-computed exact "owed" figure for anything time-sensitive. They use flat,
deliberately-safe amounts well clear of any realistic drift, and verify outcomes by
reading authoritative contract state *after* each transaction. Where drift is
unavoidable, for example checking that the seizure falls by the amount repaid, they
assert a tolerance rather than equality.

---

## The risk engine, browser side

### `frontend/lib/risk-explainer.ts`

**What it is.** The scoring model. Eight features, each scored to `[-1, +1]`, weighted,
summed, clamped, and cut into three tiers.

**What it does.** `scoreFeatureVector(vector)` returns `{ tier, overallScore,
contributions }` where every contribution carries its own score, weight, human-readable
value and a sentence explaining it. `FEATURE_SCORING_GUIDE` exports every breakpoint so
the UI can render the whole rule set.

**Why it exists.** This is the "explainable" in explainable risk. A tier on its own is a
letter grade with no reasoning behind it; the contributions array is what lets both the
borrower and the lender see why.

**The weights**

| Feature | Weight |
|---|---|
| DeFi loan history | 0.25 |
| Wallet age | 0.15 |
| Mixer interaction | 0.15 |
| Transaction volume | 0.10 |
| DeFi breadth | 0.10 |
| Average balance (90d) | 0.10 |
| Income band | 0.10 |
| Employment type | 0.05 |

Tiers: `>= 0.40` is A, `>= 0.00` is B, otherwise C.

**What breaks if you remove it.** No tier, so no terms, so no loan. The three components
that render explanations all consume its output type.

**Interview questions**

> *Justify the weights.*

They are hand-set, not learned, and that is a deliberate trade. Repayment history is the
single strongest predictor of repayment in any credit model, so it carries a quarter of
the decision on its own. Wallet age and mixer interaction are next at 0.15 each, for
different reasons: age is the cheapest defence against a borrower spinning up a fresh
address to escape a bad history, and mixer contact is a compliance signal rather than a
creditworthiness one. The three behavioural features sit at 0.10 because they are
correlated with each other, so weighting each of them heavily would triple-count the same
underlying "is this a real user" signal. The self-reported features are last, at 0.10 and
0.05, because nothing verifies them in this path. The weights sum to exactly 1.0, which
is what keeps the total inside `[-1, +1]` and makes each weight readable as "this feature
is a quarter of the decision".

> *Why does a detected mixer interaction score -1.00, the only one in the model?*

Because it should be able to override good behaviour. At weight 0.15 a mixer detection
subtracts 0.15 from the total on its own, which is enough to move a borderline A to B or
a B to C with nothing else changing. Every other feature is a statement about
creditworthiness and can reasonably be offset by a strong showing elsewhere. This one is
a statement about compliance risk, and a lender who cannot lend to a sanctioned
counterparty does not care that the wallet is otherwise well-behaved.

> *Why is loan history a chain of conditions instead of a formula?*

Ordering. Liquidations are tested first and short-circuit everything below, so a borrower
with ten clean repayments and one liquidation scores as the liquidation, not as an
average. Being liquidated once is the event this feature exists to catch, and letting
volume dilute it would defeat the heaviest weight in the model. The top score also
requires `repaid === taken`, not just `repaid >= 2`, because two repaid out of five means
three are still outstanding, which is a different position entirely.

> *You clamp `overallScore` to `[-1, 1]`, but the weights sum to 1 and every scorer is
> already in range. Is the clamp dead code?*

Yes, while both invariants hold. It stays because if either is ever broken, a weight
changed without adjusting the others or a scorer returning something out of range, the
failure shows up as a saturated tier rather than as a number outside its own scale being
rendered in the UI and compared against thresholds calibrated for `[-1, 1]`.

---

### `frontend/lib/loan-terms.ts`

**What it is.** Tier to terms. The pricing model.

**What it does.** `RISK_TIER_CONFIG` maps each tier to five numbers. `calculateLoanTerms`
turns a tier plus a requested loan into a full term sheet.
`calculateProtocolLoanTerms` does the same when the protocol picks the collateral.
`inferRiskTierFromBps` recovers a tier from an on-chain loan.

| Tier | Max LTV | Buffer | Threshold | Haircut | Spread | Final APR |
|---|---|---|---|---|---|---|
| A | 70% | 10% | 80% | 0% | 2% | 8% |
| B | 60% | 12% | 72% | 5% | 5% | 11% |
| C | 50% | 15% | 65% | 10% | 9% | 15% |

```
adjustedCollateralUsd = collateralEth * price * (1 - haircut)
maxBorrowUsd          = adjustedCollateralUsd * maxLtv
requiredCollateralEth = loanUsd / (maxLtv * (1 - haircut)) / price
interestUsd           = loanUsd * (BASE_APR + spread) * tenorDays / 365
```

**Why it exists.** It is the bridge between an opinion (a tier) and a contract (three
integers in basis points). Only `interestBps`, `maxLtvBps` and `liquidationBufferBps`
cross into `createLoan`.

**What breaks if you remove it.** The wizard cannot size a loan and the lender dashboard
cannot label one, since it reverse-maps `maxLtvBps` back to a tier.

**Interview questions**

> *What is the haircut for, if the contract never sees it?*

It is a discount on the collateral before any LTV is applied, and it is the second lever
on the same risk. Max LTV says how much of the collateral's value you may borrow against;
the haircut says how much of the collateral's value you are willing to believe in the
first place. For tier C both apply: the collateral is marked down 10% and then only 50%
of the remainder is lendable, so the effective collateral factor is 45%, not 50%. It
never reaches the chain because it only shapes how much collateral the borrower is
required to post at origination. Once posted, the contract's job is to enforce the LTV
against what is actually there.

> *The term sheet's LTV and the contract's `currentLtvBps` disagree. Is that a bug?*

No, they answer different questions. The term sheet measures against haircut collateral,
because that is what determines how much can be borrowed at origination. The contract
measures against the real collateral at the live price, because that is what determines
whether the position is still solvent. For tier A the haircut is 0 and they agree; for B
and C the contract's figure reads lower. The one that gates liquidation is the contract's,
and the UI reads it from the chain rather than recomputing it.

> *Why does `inferRiskTierFromBps` exist? Why not store the tier on chain?*

Because the tier is not a fact about the loan, it is a summary of the terms, and the
terms are already on chain. Storing it would add a field that could contradict the
numbers next to it. Reverse-mapping from `maxLtvBps` works because the three tiers have
distinct max LTVs, and it returns `null` rather than guessing for a loan created under a
different table. The honest weakness is that it breaks if two tiers ever share a max LTV.

> *Why `+ 1e-9` in `isWithinMaxBorrow`?*

`maxBorrowUsd` is the product of three floats. A borrower who asks for exactly the maximum
the UI just quoted them would otherwise be rejected by a rounding error in the last bit.

---

### `frontend/lib/borrower-personas.ts` and `feature-extractor.ts`

**What they are.** Three synthetic borrowers, one per tier, and the adapter that turns
one into a `FeatureVector`.

**Why they exist.** Demonstrating all three tiers needs three real wallets with three
genuinely different mainnet histories. Personas remove that dependency, and the unit
tests use them as fixtures.

**What breaks if you remove them.** Persona mode, which is the only scoring path that
works without the FastAPI backend running.

**Interview question**

> *`expectedTier` is stored on each persona. Isn't that circular?*

It is not an input to anything. The scorer runs over the features and arrives at a tier on
its own; `expectedTier` is what the unit tests assert against. That is how a change to a
weight or a breakpoint gets caught: if someone retunes the model and Charlie stops
landing in B, a test fails. Note also the comment on Charlie: the original spec had
`mixerInteraction: true`, which scored him at -0.170 and therefore tier C, leaving no
tier B persona. It is set to false and the reason is recorded in the source.

---

## The risk engine, service side

The FastAPI service in `backend/` is optional and not deployed. Without it, persona mode
works end to end and connected-wallet mode reports the service as unavailable.

### `backend/app/main.py`

App setup. `load_dotenv()` runs before any other import because `chain_fetcher` reads
`ALCHEMY_API_KEY` at module scope. The `/health` handler imports `CreditScorer` inside the
function so starting the app does not pull in lightgbm, shap and a pickled model. CORS is
wide open, which is tolerable only because no browser talks to this service directly:
`/api/credit/score` proxies it server to server.

### `backend/app/routers/credit.py`

The pipeline: fetch chain data, score claim credibility, build the feature vector, run
inference, assemble contributions and warnings.

The one failure it refuses to absorb is an unreachable RPC. Individual fetchers already
degrade to zeros internally, so reaching the 502 means the chain is unreadable, and
scoring a wallet as if it had no history would quietly hand the borrower a tier C.

### `backend/app/services/chain_fetcher.py`

**What it does.** Six concurrent Alchemy queries: transaction count, balance, wallet age,
protocol breadth and mixer contact, Aave V3 repay and liquidation logs, and NexusFi
platform history on Sepolia.

**Interview questions**

> *Your Aave log queries have `None` in different positions. Explain.*

Those are positional wildcards over indexed event topics, and the user sits at a different
index in each event. `Repay(address indexed reserve, address indexed user, address indexed
repayer, ...)` puts the user at indexed slot 2, after the reserve. `LiquidationCall` puts
it at slot 3, after both the collateral and debt assets. Getting either index wrong
returns an empty result set, not an error, which is the dangerous part: the borrower would
silently score as having no Aave history at all.

> *Why is the block range bounded to ~1.5 million blocks?*

An unbounded `eth_getLogs` over the Aave pool is rejected outright on the free tier. Six
months is long enough that an active borrower's repayment history shows up, and a wallet
whose only DeFi activity is older than that reads as inactive, which is the intent rather
than a compromise.

> *Wallet age is measured from the first outgoing transfer. Why not the first transaction
> of any kind?*

Anyone can send funds to a fresh address. Receiving proves nothing about how long that
wallet has been in use, and an attacker gaming wallet age would do exactly that. An
outgoing transfer requires the private key.

> *Every fetcher swallows exceptions and returns zero. Isn't that hiding failures?*

It is a deliberate trade and it errs against the borrower. A partially unreadable history
produces a lower score, never a higher one, so the failure mode is a borrower being
under-rated rather than a lender being misled. The alternative, failing the whole request,
would mean one flaky sub-query blocks scoring entirely. The compromise is the warnings
list: `"No mainnet transaction history found"` is surfaced so the result is not presented
as a confident read of a rich history.

### `backend/app/services/believability.py`

**What it does.** For each self-reported claim, computes `P(claim is true | on-chain
signals)`. Income is checked against balance through a sigmoid centred on an assumed 20%
savings rate. Employment has no direct proof, so it uses activity as a weak proxy with
conservative baselines. Mixer and DeFi claims are directly verifiable, so they are
compared against reality and produce a dishonesty flag.

**Why it exists.** Self-reported data is worthless if you either trust it outright or
discard it. Multiplying the claim's score by its credibility is the middle path: an
unbacked income claim contributes proportionally less rather than being binary.

**Interview questions**

> *Why is dishonesty asymmetric?*

Only self-serving mismatches count. Claiming no mixer use when the chain shows Tornado
Cash contact is a lie that helps the claimant, so it costs 0.70. Admitting mixer use when
there is none is unusual but costs them, so it is not penalised. Same for DeFi:
overclaiming repayments or underclaiming liquidations is dishonesty; understating your own
record is not. Penalising both directions would punish honest self-deprecation and,
worse, would make the penalty a poor signal.

> *Why the ±1 tolerance on the DeFi claim comparison?*

It is not just leniency. `chain_repaid` only covers Aave V3 over roughly the last six
months, so a borrower recalling one extra loan is as likely to be right as lying. The
penalty for a false positive is a whole tier, so the tolerance is sized to the known
incompleteness of the verification data.

### `backend/app/ml/features.py`, `model.py`, `train.py`

**`features.py`** builds the 10-dimensional vector. Balance goes in as `log10`, floored at
1.0, because raw USD spans four orders of magnitude. Income and employment enter already
multiplied by their credibility. Dishonesty is its own explicit feature.

**`model.py`** loads the LightGBM booster and a SHAP `TreeExplainer` once per process, and
falls back to a rule-based scorer mirroring the TypeScript model when no trained artifacts
exist. SHAP attribution is taken for the *predicted* class, because the features that
argue for tier C are not the negation of those that argue for tier A.

**`train.py`** generates 3,000 synthetic borrowers, 1,000 per tier, from per-tier
distributions with deliberate overlap at the boundaries, then trains a 3-class LightGBM
with early stopping.

**Interview questions**

> *You trained on synthetic data. What does the reported AUC actually mean?*

Almost nothing about real credit risk. It measures whether the model recovered the
generator that produced the data, not whether the tiers predict repayment. That is stated
in the source. What the model does buy is a non-linear decision surface with real SHAP
attributions instead of the linear weighted sum, which is a demonstration of the
explainability plumbing rather than a claim of predictive power. Real training data would
need actual loan outcomes, which this protocol has not accumulated.

> *`_NOMINAL_WEIGHTS` sits next to a gradient-boosted tree. A tree has no coefficients.
> What are those for?*

Display only, as far as the model is concerned. A GBM has no per-feature coefficient, so
SHAP is what actually explains a prediction. The nominal weights exist so the UI can show
a stable "how much does this feature normally matter" figure next to the per-borrower
attribution. The rule-based fallback does use them as real weights, because it genuinely
is a linear model. The sharp edge is that the fallback zips them positionally against
`FEATURE_NAMES` order, so reordering either one silently mis-weights everything.

> *Why does the browser scorer and the service scorer both exist, and do they agree?*

They are two paths to a tier over different data. The browser model runs against persona
fixtures with no chain access; the service runs against real mainnet history with claim
cross-checking and a trained classifier. They share the tier cutoffs (0.40 and 0.00),
which is deliberate so a borrower is not handed a different tier by an implementation
detail. What they cannot share is inputs, which is why the wizard refuses to silently fall
back from one to the other: substituting the local scorer when the backend is down would
present a tier as if it came from mainnet analysis when it did not.

---

## Chain access and event indexing

### `frontend/lib/loan-events.ts`

**What it is.** The event indexer.

**What it does.** `findBlockByTimestamp` binary-searches block headers for a start block.
`fetchLoanEvents` walks the range in 9,000-block chunks, one `getLogs` per chunk covering
every loan contract at once, decodes the five lifecycle events and returns them sorted.
`fetchBlockTimestamps` attaches wall-clock times, deduplicating block lookups.

**Why it exists.** Every payment in this system moves as an internal contract transfer,
and MetaMask does not list those. A user watches their balance change with no record of
what happened. The only place the transaction hashes live is the event logs, so the app
has to index them itself.

**What breaks if you remove it.** Settlement receipts, event history and all three
statements. The dashboards still show live contract state; the record of how it got there
disappears.

**Interview questions**

> *Why is there a second RPC just for logs?*

The app's normal transport is Alchemy, whose free tier caps `eth_getLogs` at a 10-block
range. Loan history spans tens of thousands of blocks, which is why event lists came back
empty. Log queries go through `/api/rpc/logs` to an endpoint that serves wide ranges;
everything else, contract reads and balances, still goes through Alchemy. Splitting by
query shape rather than moving everything is what keeps the reliable provider on the calls
that matter.

> *Why binary-search block headers instead of asking for the contract's deployment block?*

The obvious approach is to probe `eth_getCode` backwards. It fails on non-archive nodes,
which answer `0x` for blocks they cannot serve. That is indistinguishable from "not yet
deployed", so the search walks past the real start and the history comes back partially
empty with no error. Block headers are available on every node, so the timestamp search is
reliable anywhere, and callers already know when their earliest loan was created because
the factory stores `createdAt`.

> *Why 9,000 and not 10,000?*

The range is inclusive at both ends and providers differ on whether they count it that
way. The margin avoids tripping a limit by one block on some endpoint and silently losing
that chunk. Note also that a failed chunk logs and continues rather than aborting: the
result is a gap in history rather than no history, and the console line is what makes that
distinguishable from a loan genuinely having no activity.

---

### `frontend/lib/loan-abi.ts`

Shared ABI fragments for `LoanFactory` and `Loan`. It exists because these were once
hand-copied into `LenderDashboard.tsx` and `BorrowerLoansSection.tsx` independently, and
that duplication is exactly what let one copy go stale when
`markLiquidatedForDemo()` was replaced by `liquidate()`.

### `frontend/lib/network.ts` and `wallet-chain.ts`

`network.ts` describes both supported networks as data: label, chain id, and the env keys
holding the factory and RPC for each.

`wallet-chain.ts` handles the messy part, getting a wallet onto the right chain.
`ensureWalletChain` has two paths on purpose. Sepolia is a chain every wallet already
knows, so the ordinary switch is tried first and adding is the recovery path. Hardhat
skips straight to add-then-switch, because trying the switch first there reliably fails
and costs the user a rejected prompt before the one that works. `isMissingChainError`
checks both the standard 4902 code and message text, because wallets are inconsistent
about returning the code and wagmi wraps the original error besides.

### `frontend/app/wagmi-config.ts`

Creates the wagmi config once and stashes it on `globalThis` so it survives dev-mode
module re-evaluation. Two details worth knowing:

- **Storage is `cookieStorage`, not localStorage.** `layout.tsx` calls
  `cookieToInitialState()`, which can only see state written to a cookie. With
  localStorage the server always hydrated as disconnected and every page load had to
  reconnect from scratch, which is what showed connected users a "connect a wallet"
  prompt.
- **Transport differs by environment.** In the browser, Sepolia reads go to
  `/api/rpc/sepolia` so the key stays server-side and there is no CORS. On the server they
  go direct, because server-to-server calls have no CORS restrictions.

---

## Statements and receipts

### `frontend/lib/statements.ts`

**What it does.** Builds three PDFs with jspdf: P&L, Tax P&L and a Tradebook.
`computeLoanPnl` is the shared accounting.

**Why it exists.** Same reason as the event indexer, one level up. A user cannot
reconstruct what happened to their money from wallet balances, so the app produces the
record, and every row carries a transaction hash a reader can verify on Etherscan.

**Interview questions**

> *Why are the lender and borrower P&L calculations not mirror images?*

Because collateral only moves on the borrower's side. The lender's ledger is principal out
against repayments plus any seizure in. The borrower's counts collateral as an outflow
when it is posted and an inflow when it comes back, so a loan repaid in full nets to
exactly the interest paid rather than to zero, and a liquidated one nets to the collateral
that did not return. Modelling both sides identically would make a fully repaid loan look
free to the borrower.

> *The tradebook values each event at its own price, but the P&L values net at today's
> price. Why the inconsistency?*

They are different kinds of number. An event happened at a moment and has one correct
exchange rate, the one at that moment, which is what a tax authority asks for. A net
result is a position held now; there is no single historical rate that would be correct
for it, because it is the residue of several events at several rates. Using the funding
price would be arbitrary, and using an average would invent a rate that never existed.

> *What happens for events that predate the snapshot table?*

They are labelled. `priceFor` returns `estimated: true` when there is no snapshot, the
value falls back to the current price, the row is marked `(est.)` and the footer changes
to say so. The alternative, silently valuing an old event at today's price, would produce
a document that looks authoritative and is wrong. The alternative of omitting them would
produce an incomplete ledger. Labelling is the only honest option.

> *Why is `liquidated` read from contract status rather than from the presence of a
> liquidation event?*

Because a chunk of logs that failed to fetch would otherwise silently reclassify a
liquidated loan as open and drop the collateral loss from the statement. Status comes from
the chain and cannot be lost by a missing log.

### `frontend/components/LoanSettlementReceipt.tsx`

Per-loan receipt for a closed position: what went out, what came back, what it cost or
earned, and a link for every leg. Each leg is valued at its own snapshot price, because a
loan funded at $2,000 and repaid at $3,000 moved the same ETH but not the same money. A
leg with no price renders as omitted rather than as `$0.00`, which would read as a real
valuation of zero.

---

## Identity, wallets and compliance

### `frontend/lib/auth.ts`

`getSessionUser()` returns the authenticated user plus their profile. Uses `getUser()`,
never `getSession()`: `getSession` trusts the cookie as it stands, `getUser` revalidates
the token against Supabase, and on the server that is the difference between an identity
and a claim. The profile row is created lazily by upsert, so a user who exists in Supabase
Auth but has no profile row is a normal state that heals itself. A failed upsert degrades
to an in-memory profile with the restrictive defaults (no KYC, no role) rather than
signing the user out.

### `frontend/lib/didit.ts`

The KYC provider client. Three things worth knowing:

- `getDiditSessionStatus` tries four candidate URL paths in order, because the v2 API does
  not expose a documented single-session endpoint on the free plan. A 404 moves to the
  next path; any other status stops, because a 401 or 500 is an answer about this account
  and retrying would replace a useful error with "all paths 404".
- `verifyDiditWebhookSignature` compares HMACs with `timingSafeEqual`, tries hex then
  base64 because providers differ, and returns false when the secret or header is missing.
- `mapDiditStatus` normalises punctuation and collapses a wide vocabulary onto six
  statuses. Unrecognised values fall through to `PENDING`, never `APPROVED`.

**Interview question**

> *Why does the webhook handler read the raw body instead of parsing it first?*

Because the HMAC covers the exact bytes that were sent. Parsing to JSON and re-serialising
produces a different string, key order and whitespace included, and every legitimate
signature would fail. The route reads `req.text()`, verifies, and only then parses.

### `frontend/lib/wallet-screening.ts`

A deterministic mock KYT scorer: sums the address's character codes, mod 100, bands into
LOW / MEDIUM / HIGH. Deterministic on purpose. A random score would give the same wallet a
different answer on every screen, which makes the compliance flow impossible to demo or
test; here a given address always lands in the same band, so the rejection path can be
shown on demand. `isWalletRiskAcceptable` passes LOW and MEDIUM: a new wallet with no
history is not evidence of anything, and refusing it would lock out exactly the borrowers
the risk model exists to price.

### `frontend/lib/supabase/{client,server,admin}.ts`

`client` is the browser client. `server` is request-scoped and reads and writes session
cookies, swallowing the write error that Next throws during a Server Component render,
which is safe only because middleware performs the same refresh where it is legal.
`admin` is the service-role client that bypasses row level security entirely; it is
server-only because `SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix, and it
returns `null` rather than throwing so every caller can fall back to the user-scoped
client.

**Interview question**

> *If the admin client bypasses RLS, what stops one user reading another's wallets?*

The explicit `.eq('user_id', session.profile.id)` filter on every query that uses it. That
is the whole defence, which is why it is stated in a comment at the top of the wallets
route. RLS is the backstop for the anon-key path; when the service key is present, the
handler is the enforcement point. The one intentional exception is
`loan_risk_assessments`, which has no ownership filter by design.

---

## Route handlers

### `/api/rpc/[chain]` and `/api/rpc/logs`

Server-side JSON-RPC proxies. The key never reaches the browser and there is no CORS.
Body and response pass through as raw text and are never parsed, because JSON-RPC carries
numbers that exceed what `JSON.parse` represents exactly, so a round trip through an
object would corrupt block numbers and wei amounts. The chain name is resolved against an
allowlist, which is what stops the route being pointed at an arbitrary host.

The separate logs route exists because Alchemy's free tier caps `eth_getLogs` at 10
blocks. See the event indexer above.

### `/api/prices`

CoinGecko spot prices with a 30-second server cache and a static fallback. The cache
matters because CoinGecko rate-limits per IP and every browser session polls every 10
seconds. On failure it returns fallback values with `source: 'fallback'` rather than
erroring, because a dead price feed would otherwise take down the term sheet, both
dashboards and statement valuation at once.

### `/api/wallets/nonce` and `/api/wallets/verify`

The EIP-191 wallet linking handshake, and the security-critical pair in this codebase.

`nonce` requires a session, generates 16 random bytes with `crypto.randomBytes`, stores it
with a 10-minute expiry, and returns a human-readable message shaped after EIP-4361. The
origin is read from the request rather than configured, so the message names the
deployment the user is actually on.

`verify` runs four gates in a fixed order: an active nonce must exist, it must not have
expired, the signed message must contain that exact nonce, and only then is the signature
checked. It then screens the wallet, records the screening, refuses a HIGH result, and
clears the nonce.

**Interview questions**

> *Why check the nonce before the signature? Verifying first would be cheaper to reason
> about.*

Verifying the signature first proves the caller controls the key, but not that they were
answering *this server's challenge*. Without the nonce check, a signature captured
anywhere else, from another site, another session, or an old request, would verify
perfectly. The nonce is what binds the signature to one server-issued challenge, which is
the property that makes it unreplayable.

> *What makes the nonce single-use?*

It is set to `null` on successful verification. Replaying the same signature then fails
the "no active nonce" check at the top rather than verifying a second time. The 10-minute
expiry bounds the abandoned case, where the user never signs.

> *Why is screening recorded before the acceptance test?*

So a refused wallet still leaves an audit trail of why it was refused, rather than
vanishing on the early return.

### `/api/kyc/{session,status,webhook,demo-approve}`

`session` creates a Didit session, passing the profile id as `vendor_data` so the verdict
can find its user later. `webhook` is the authoritative path. `status` is reconciliation:
it handles the case where the user is back on the page before the webhook has arrived, by
reading the verdict from the redirect parameters or by polling Didit directly. Both write
paths skip once the stored status is APPROVED or REJECTED, because those are terminal and
a stale redirect parameter must not walk a decided user backwards.

`demo-approve` is gated on `ALLOW_DEMO_KYC` and approves only the caller's own profile.

**Interview questions**

> *The webhook is a public endpoint that can mark a user KYC-approved. What stops anyone
> POSTing to it?*

The HMAC signature, and nothing else, which is why it is checked before the body is even
parsed. The important caveat is that verification is skipped entirely when
`DIDIT_WEBHOOK_SECRET` is unset, so a local setup can replay a captured webhook. That
makes the secret the whole control: any deployment reachable from the internet must have
it set.

> *`status` accepts a `sessionId` query parameter. Isn't that attacker-controlled?*

Yes, which is why the stored `didit_session_id` takes precedence over it. Polling an
arbitrary session id would report someone else's verdict as this user's. The parameter is
only used when the profile has no stored id yet, which is the case where the user is
returning from the redirect for the first time.

> *Why does a failed profile write in the webhook log rather than return a 500?*

A non-2xx makes Didit retry a webhook that has already been accepted and verified. The
audit row still records that the verdict arrived even if the profile write did not land,
so the failure is visible without triggering a retry storm.

### `/api/loans/risk`

Persists the borrower's risk explanation at loan creation and serves it back in batch.

**Interview questions**

> *Why does this exist at all? The tier is already on chain.*

The tier is, the reasoning is not. The eight-feature breakdown is computed in the
borrower's browser and would be thrown away on unmount, leaving lenders with a letter
grade and no reasoning. That is precisely the "ledger transparency is not decision
transparency" gap. This table keeps the explanation alongside the loan, keyed by the
deployed `Loan` address because the address is globally unique across chains and
redeploys, and it is what the lender dashboard already has in hand.

> *You just said every query filters by owner. This one does not. Why?*

That is the point of the table. A lender deciding whether to fund a request has to be able
to read the reasoning behind a tier they did not compute. Authentication is still
required, so it is readable by any signed-in user rather than by the public. The write
side is the other half: inserts are `insert`, never `upsert`, so an existing row wins and
a borrower cannot rewrite the explanation a lender already funded against. A duplicate
insert returns unique-violation 23505, which is treated as success because it means a
retry.

### `/api/loans/event-prices`

Records the ETH/USD price the first time the client observes a settlement event, and
serves known snapshots back keyed `txHash:kind`.

**Interview question**

> *What stops two browsers writing different prices for the same event?*

The primary key on `(tx_hash, log_kind)` plus `ignoreDuplicates`. First write wins, and it
is enforced in the database rather than by a read-then-write in the handler, so two
clients observing the same event at once cannot both decide the row is missing and race.
The key includes the event kind because one transaction can emit two events worth valuing
separately, a liquidation's seizure and its refund. Non-positive prices are rejected on
the way in, since first-write-wins means a bad value would be the permanent record.

### `/api/credit/score`

Proxies the FastAPI scorer with a 20-second timeout, which is generous because the backend
fans out to six Alchemy queries and a cold model load. Returns `{ fallback: true }` with a
503 when the backend is unreachable, so the client can report it rather than hang.

### Others

`/api/profile` handles role selection against an allowlist of borrower / lender / both,
and returns 410 on the removed POST rather than 404, so an old client is told the endpoint
was removed rather than left guessing at a routing mistake. `/api/market-pulse` and
`/api/news` aggregate third-party data and degrade per field rather than as a whole:
market-pulse returns `null` for any source that failed, news uses `allSettled` so one dead
feed does not empty the panel. `/api/risk/score` scores a persona server-side and is a
thin wrapper over the browser model.

---

## Hooks

### `useCompliance`

The user's standing: signed in, wallet verified, KYC approved, role chosen. Derives
`canBorrow`, `canLend` and `hasRole` once so no call site re-derives half the condition.
Every failure path returns the same fully-denied shape, so a failed compliance read never
leaves a gate open. Refetches on window focus with no stale window, because KYC approval
and wallet verification both complete outside the tab.

**Interview question**

> *Why does borrowing require more than lending?*

A borrower takes on a debt and posts collateral, so they must be both identified (KYC) and
provably in control of the wallet (signature). A lender risks only their own funds and the
contract holds them to nothing afterwards, so the role alone is enough. The asymmetry is
in `canBorrow: hasVerifiedWallet && kycApproved` versus `canLend: userRole includes
lender`.

### `useLoanEvents`

Indexes events, attaches timestamps, and snapshots the ETH price the first time each event
is seen.

**Interview questions**

> *Why is `snapshotted` a ref and why is it marked before the POST rather than after?*

A ref because writing to it must not trigger the effect that reads it. Marked before the
request because both dashboards mount this hook over the same loans, and awaiting the POST
first would let the second pass through while the first is still in flight, producing
duplicate writes.

> *Why does the effect depend on a joined string instead of the address array?*

`loanContracts` is rebuilt by the caller on every render, so depending on the array itself
would re-run the whole index every time. The key is sorted and lowercased so the same set
of loans in a different order produces the same key.

> *Why is the start block offset by an extra hour?*

`findBlockByTimestamp` returns the first block at or after the target. Starting exactly at
the loan's creation timestamp risks landing one block past its `LoanCreated` log. An hour
of extra range is a handful of empty chunks; missing that log loses the loan.

### `useNetworkMode`, `useTokenPrices`, `useHydrated`

`useNetworkMode` owns the app's network selection and asks the wallet to follow, but does
not force the reverse, so a user switching network in MetaMask is not fought by the app.
App state moves first and is not rolled back if the wallet refuses; the failure surfaces
as `walletError`. `ready` exists because the stored mode is only readable after mount.

`useTokenPrices` polls `/api/prices` every 10 seconds, which is faster than the route's
30-second cache and costs nothing extra.

`useHydrated` returns true after mount. It exists because wagmi restores connections
asynchronously, and checking only `!address` told already-connected users to connect.

---

## Components

### `LoanRequestPanel.tsx`

The four-step borrow wizard: mode, profile, configure, review. Scores the borrower (via
persona or the backend), computes the term sheet, calls `createLoan`, then decodes the new
loan address from the receipt and persists the risk explanation.

**Interview questions**

> *There are two sets of amounts in this component. Explain.*

`termSheet` is the loan as priced: the USD amount the borrower asked for and the collateral
the tier demands. `demoTxAmounts` is what actually moves on chain, capped at 0.005 ETH so
a Sepolia demo costs almost nothing. The ratio between principal and collateral is
preserved, so the LTV, interest accrual and liquidation behaviour of the real contract
match the quoted terms even though the magnitudes do not. The principal is derived from
the capped collateral rather than scaled from the quoted principal, so the pair always
satisfies the tier's collateral factor exactly.

> *Why decode the loan address from the receipt instead of saving the risk explanation at
> submit time?*

Because the `Loan` address does not exist until the transaction mines. The factory deploys
it inside `createLoan`, so the only way to learn it is to decode `LoanCreated` from the
receipt logs. Note that the decode and the save are two separate effects: they were once
one effect gated on `riskExpl`, so a missing assessment meant the address was never
decoded, which left the "what happens next" timeline frozen on step 1 forever.

> *Why does the backend being down not fall back to the browser scorer?*

The two paths look at different data. The local scorer has no access to the borrower's
real chain history, so silently substituting it would hand out a tier while the UI claims
it came from mainnet analysis. The wizard reports the service as unavailable instead.

### `LenderDashboard.tsx`

The marketplace and the lender's own positions. Funds requests and liquidates positions.

**Interview questions**

> *Walk me through how this reads state.*

Four dependent rounds, each a single multicall. The factory knows the ids; the ids yield
the terms; the terms carry the per-loan contract addresses; only those addresses can be
asked for status, lender, liquidation state, LTV, outstanding balance and liquidation
preview. Within a round everything batches. Round 4 alone is eight calls per loan on every
five-second poll, which is the read pattern that will not scale past demo volume. An
events indexer replaces it eventually; the multicall is what keeps it to a handful of
requests rather than hundreds today.

> *Why are results stored in address-keyed maps rather than read by index?*

Because the arrays do not line up. `statusContracts` filters out entries where the terms
call failed, so its length is less than `loanIds.length` whenever anything fails, and
direct index access then maps the wrong result to the wrong loan. Silently, and in a way
that shows a lender someone else's LTV. Keying by contract address removes the
possibility.

> *Why does `isMine` check every connected account instead of the active one?*

A user who funds from one MetaMask account and then switches to another would otherwise
watch their own positions disappear. It falls back to the active address when the
connector reports no account list.

### `BorrowerLoansSection.tsx`

The borrower's own loans, live outstanding balance, and repayment.

**Interview questions**

> *The "repay in full" button deliberately overpays. Why is that safe?*

`outstandingBalance()` ticks up between the read and when the transaction mines, so an
exact payment would land short and leave the loan open by a few wei of interest. The
contract caps what it applies at the live outstanding balance and refunds the exact excess
in the same transaction, so overpaying by a small buffer reliably closes the loan in one
click and costs nothing.

> *`matchTxHash` pairs a loan with a stored transaction hash by timestamp proximity.
> That's a heuristic. Why is it acceptable?*

Because the cost of being wrong is bounded. The only thing linking the two is that they
happened at roughly the same time, within five minutes, with a used-set so one transaction
cannot claim two loans. If it mismatches, an Etherscan link points at the neighbouring
transaction. The real settlement record comes from `useLoanEvents`, which is event-derived
and exact; this only covers loan *creation*, which emits an event this component does not
index. The right fix is to index `LoanCreated` too.

> *`MAX_OPEN_REQUESTS` is enforced in the client. Doesn't that make it meaningless?*

Against a determined user, yes: nothing stops them calling `createLoan` directly. It is
not a security control, it is a UX and marketplace-quality one. It stops a borrower
accidentally filling the marketplace with requests nobody will fund, each of which locks
their own collateral for seven days. If it needed to be enforceable, the factory would
have to track open requests per borrower.

### `LoanSafetyPanel.tsx` and `RiskExplanationPanel.tsx`

`LoanSafetyPanel` is lender-facing: what the tier means, how it produced these terms, what
protects the lender, and what happens when it goes wrong. It computes how far ETH can fall
before liquidation (`1 - currentLtv / threshold`) and what the lender recovers at the
threshold, because "you are protected by collateral" is meaningless without the number.

`RiskExplanationPanel` is borrower-facing and holds a second register of copy, keyed by
the display names the scorers emit. A feature it has no copy for renders nothing rather
than falling back to the model's technical wording. Note that its per-feature status bands
(0.3 / -0.1) are unrelated to the tier thresholds: they read a single unweighted feature
score, so a feature can be "Great" on a profile that still lands in tier C.

### `StatementsPanel.tsx`

Role toggle, reporting period, and three download buttons. Ownership depends on the
selected role, so the same wallet produces two different statements. All-time keeps every
loan; any bounded period drops loans with no events in the window, because a loan that did
nothing in a period has no place in its statement.

### `PriceTicker`, `EthPriceTicker`, `MarketPulseBar`, `BlockchainNews`

Display components over the aggregation routes. Two details worth remembering:
`PriceTicker` iterates a fixed `TICKER_ORDER` rather than the response keys, so a marquee
does not reshuffle when the upstream response changes shape; `EthPriceTicker` runs its
"12s ago" counter on its own interval so the timestamp keeps counting between polls.

---

## Pages and app shell

### `app/layout.tsx` and `app/providers.tsx`

`layout` calls `cookieToInitialState()` so the server renders the page as connected for a
user who already is. Without it the first paint is always the disconnected variant and
every reload flashes a "connect a wallet" prompt.

`providers` creates the wagmi config and the QueryClient through `useState` initialisers,
so neither is recreated on render. The QueryClient defaults have
`refetchIntervalInBackground: true` because chain state is shared between two people in
real time: a borrower repays and the lender must see it without reloading, and React Query
pauses polling for unfocused tabs by default, which is precisely the two-window demo case.
`AuthStateSync` invalidates the compliance query on every Supabase auth event, so the
header and the borrower gate update within one round trip of login or logout.

### `middleware.ts`

Refreshes the Supabase session on every non-static request. Server Components cannot write
cookies, so `lib/supabase/server.ts` can rotate a token but not persist it; this is the one
place in the request cycle allowed to set them. It writes to both the request and the
response: the request copy is what same-cycle Server Components read, the response copy is
what reaches the browser. It refreshes only; nothing here redirects or authorises, so it
is not a route guard.

### `app/app/page.tsx`

The main workspace, with a borrower / lender toggle. Gated by an effect that waits for
compliance to resolve, then redirects an unauthenticated visitor to `/` and an
un-onboarded user to `/onboarding`, using `replace` so neither is reachable with the back
button. Seeds the borrower's tier from the last persisted assessment through functional
state updates, so a stored assessment landing late cannot overwrite a freshly scored one.

### `app/onboarding/page.tsx`

Four steps: account, role, wallet, KYC.

**Interview question**

> *How does the wizard know which step the user is on?*

It derives it from compliance state on every change rather than advancing it from the
buttons. The user's real position is whatever the server says, so a step completed in
another tab or a KYC approval that arrives by webhook moves the wizard forward on its own,
and no local counter can drift out of step with it. The KYC return path adds a bounded
poll: three seconds for up to ninety, only in the window right after the redirect, because
the verdict arrives by webhook and may not have landed yet. Past ninety seconds it stops
and offers an explicit check button, since a manual review will not resolve on that
timescale.

### `app/demo/page.tsx`

Unlinked route. Forces both liquidation triggers: `setPrice` on the mock feed, and
`fastForward` per loan. Every write goes through one `send()` wrapper so the chain switch,
the busy label and the error truncation are identical for every control. The
participant check mirrors the contract's own, so the button is disabled rather than offered
and then reverted; the contract remains the enforcement point.

### `app/settings/page.tsx`

Wallet management, role changes, KYC status and the statements panel. The first wallet
linked becomes primary automatically and later ones do not, since silently demoting the
wallet a user already borrows from would change which address the app treats as theirs
without them asking.

### `app/auth/*`

Login, signup, forgot password, reset password.

Signup checks for a session after `signUp` succeeds, because with email confirmation
enabled Supabase creates the account but issues no session, and sending an unconfirmed
user to onboarding would bounce them straight back. All auth transitions use
`window.location.replace` rather than a router push, because the session cookie was just
written and only a fresh request runs it through middleware.

Reset password both listens for `onAuthStateChange` and calls `getSession`: checking only
`getSession` races the URL fragment parse and shows "invalid link" on a link that is fine,
while listening only would never resolve for a session already established.

---

## Database migrations

Run `001` through `004` in order in the Supabase SQL editor.

- **001** base tables: `profiles`, `linked_wallets`, `wallet_screenings`, `audit_logs`.
- **002** row level security and the `user_role` column.
- **003** `loan_risk_assessments`. Keyed by `Loan` contract address rather than numeric id,
  because the address is globally unique with no chain or factory ambiguity across
  redeploys, and it is what the lender dashboard already has. Without it the risk
  explanation fails to save silently by design.
- **004** `event_price_snapshots`, primary key `(tx_hash, log_kind)`, insert-only. Without
  it statements still generate but value every event at the current price and label it
  estimated.

---

## CI

`.github/workflows/deploy.yml` deploys to Vercel with a token rather than through Vercel's
Git integration, because Vercel blocks any git-triggered build whose commit author is not
a member of the Vercel team, and a Hobby-plan team has exactly one member, so every
teammate's push would be rejected. Deploys run from the repo root, not `frontend/`, because
the Vercel project has Root Directory set to `frontend` and deploying from inside it would
make Vercel look for `frontend/frontend`. Preview branches are aliased explicitly, because
Vercel's git-branch matching only applies to git-triggered builds and these are CLI
uploads.

---

## Cross-cutting questions

> *What is the single biggest architectural gap?*

Multi-lender pooling. Today a single lender funds 100% of a request in one transaction, so
the market has no depth: a request either finds one counterparty willing to take all of it
or it expires. Everything downstream assumes one lender, `Loan.lender` is a single address,
`repay()` forwards to that one address, and `liquidate()` is `onlyLender`. Supporting
pooling means shares, pro-rata distribution on repayment, and a decision about who may
trigger liquidation when there are many lenders. That is the reason the source is private
until it ships.

> *What would you fix first if this were going to production?*

The oracle, then the read pattern. `MockPriceFeed` has a permissionless setter and no
staleness check, and while `Loan` treats a bad price as "do not liquidate" rather than
trusting it, an attacker who can set the price can force liquidations by setting it low.
That is a total compromise of the collateral. Second, the multicall read cascade in
`LenderDashboard` is eight calls per loan every five seconds and will fall over well
before real volume; it needs an events indexer.

> *Where is the trust boundary between the client and the chain?*

The three basis-point arguments to `createLoan`. Everything upstream of that, the scoring,
the tier, the haircut, the sizing, happens in the browser and the contract takes it on
faith. What the chain guarantees is that once written, those numbers are fixed, public and
enforced identically for both parties. The contract is not the underwriter; it is the
escrow agent and the enforcer of terms it was handed. Being clear about that boundary is
more useful than pretending it is not there.

> *You compute the risk score in the browser. Couldn't a borrower fake their tier?*

Yes, in the current design, and it is worth saying so plainly. A borrower who called
`createLoan` directly could pass tier A parameters regardless of their history. Three
things limit the damage: the terms are public before anyone funds, so a lender can read
them and refuse; the persisted assessment is insert-once and readable by lenders, so a
loan with no assessment or an implausible one is visible as such; and the collateral
requirement is enforced by the borrower's own wallet, so faking a tier means posting less
collateral for the same loan and finding someone willing to fund it anyway. The real fix
is signing the scoring result server-side and having the factory verify the signature,
which is the natural next step once the scorer is a deployed service rather than an
optional one.

> *Why does so much of this system exist to work around wallets not showing internal
> transfers?*

Because every payment in the protocol is an internal contract transfer: funding forwards
the principal from the `Loan` to the borrower, repayment forwards from the `Loan` to the
lender, liquidation moves collateral out of the vault. None of those appear in MetaMask's
activity list. So a user watches their balance change with no record of why. The app has to
be the ledger, and the only authoritative source for those movements is the event logs.
That single fact is the reason `loan-events.ts`, `event_price_snapshots`, the settlement
receipts and all three statements exist.
