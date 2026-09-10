# Paper ↔ Codebase Audit

Cross-check of `NexusFi_Research_Paper_v3.md` against the code on branch `ml-wallet-scoring`
(descended from `origin/atharva`, commit `07378f5` plus the pending-state work of 2026-08-23).

Both this file and the paper are gitignored and stay local.

Method: every numeric and behavioural claim in the paper was traced to the file that implements it,
and the codebase was walked in the other direction to find shipped work the paper never mentions.
Test counts are from actual runs, not from documentation.

**Headline:** the paper's *technical* claims hold up unusually well - the tier tables, the formulas,
the liquidation boundary and the fail-closed oracle are all exactly as described.
The problems are of three other kinds: numbers that have gone stale since it was written, one
genuine conflation of the two scoring paths, and a large amount of shipped work the paper simply
does not claim.

---

## 1. Claims verified as accurate

| Paper claim | Where it lives | Status |
|---|---|---|
| Table II tier→terms mapping (LTV, buffer, threshold, haircut, spread, APR) | `frontend/lib/loan-terms.ts:15-43` | Exact match, all three tiers, including derived APR (8/11/15%) and liquidation thresholds (80/72/65%) |
| Table I feature weights, eight features summing to 1.0 | `frontend/lib/risk-explainer.ts:138` | Exact match: `[0.15, 0.10, 0.10, 0.25, 0.10, 0.15, 0.10, 0.05]` - **but see §3.1** |
| Tier thresholds: ≥0.40 → A, ≥0.00 → B, else C | `frontend/lib/risk-explainer.ts:37` | `TIER_THRESHOLDS = { A: 0.40, B: 0.00 }` |
| Worked example: 1 ETH vs 2 ETH at $2,000 liquidates at $1,250; not at $1,251 | `contracts/test/LoanLifecycle.ts:334-339` | Test asserts exactly this boundary, both sides |
| Debt frozen in USD at funding, collateral floats | `contracts/contracts/Loan.sol` (`debtValueUsd`, `priceAtFunding`) | As described |
| Fail-closed oracle: missing/reverting/zero feed returns 0, treated as unknown not healthy | `contracts/contracts/Loan.sol:435-436` | `priceFeed == address(0)` short-circuits; `try/catch` around `latestPrice()` |
| Liquidation: lender-only, funded-only, two independent triggers, 2-day grace | `Loan.sol` `liquidate()` | As described |
| Seizure is `min(outstanding, collateral)`, surplus refunded same tx | `Loan.sol` `liquidate()` / `liquidationPreview()` | As described |
| Four core contracts, Solidity 0.8.28, OpenZeppelin 5, Hardhat Ignition | `contracts/contracts/` | Accurate for the live path (see §4.9 on the two unused extras) |
| Paginated registry of loan identifiers | `LoanFactory.sol:103-117` | `getLoanIds(offset, limit)` overload returning `(page, total)` |
| Row-level security on every table | migrations 001-004 | All six tables have `ENABLE ROW LEVEL SECURITY` - one nuance in §3.6 |
| Risk explanation persisted per loan address, readable by any signed-in user | migration 003 + `app/api/loans/risk/route.ts` | As described, and immutable by design (existing row wins) |
| Per-event price snapshots; pre-existing events labelled estimated | `lib/statements.ts`, migration 004 | `(est.)` labelling present in all three statement types |
| Multi-lender funding to a filled pool, then pro-rata splits | `Loan.sol` `contribute()` | Implemented |
| "When the scoring service is unreachable, the interface reports this rather than scoring silently" | `LoanRequestPanel.confirmWalletScore` | Correct - sets `backendUnavailable` and surfaces it; no silent substitution |
| 103 risk and terms tests | run | Exactly right: 29 + 62 + 12 = 103 |

---

## 2. Stale numbers - correct when written, wrong now

### 2.1 Test count (§V.B)

> "covered by 131 automated tests, of which 28 exercise the contracts and 103 exercise the risk and terms logic. All 131 tests pass."

Actual, measured:

| Suite | Count |
|---|---|
| Contracts (`npx hardhat test`) | **54** |
| Frontend (`lib/*.test.ts`) | **170** |
| Backend (`pytest`) | **9** |
| **Total** | **233** |

The 28 and 103 were both correct at time of writing (26 + 2 contract tests; 29 + 62 + 12 risk/terms).
Multi-lender pooling added `MultiLenderFunding.ts` and `MultiLenderSettlement.ts`, taking contracts
to 54, and the frontend gained directory, share-math, term-sheet, decode and query-defaults suites.
**The paper undersells the work by ~100 tests.** Update the number, and mention the backend suite,
which the paper omits entirely.

### 2.2 Manual testing evidence (§V.B)

> "two person manual testing across nine loans on live Sepolia is recorded as complete and verified against on-chain state."

The record is real, but those nine loans were created against the **previous** factory. The
2026-08-21 pooling redeploy changed all three contract addresses, and the current factory
(`0x0e3e…7d00`) has **zero loans**. As written the sentence implies the deployed system has been
manually exercised; it has not been since the redeploy. Either re-run the manual pass against the
current deployment before submission, or reword to make clear the manual testing covered the
pre-pooling contracts.

### 2.3 Source verification (§V.A)

> "source verification is configured through Sourcify and Blockscout"

Configured, yes - but per the project's own report the verification was performed for the *earlier*
factory address. The current pooled contracts should be verified before anyone follows the paper to
the explorer and finds unverified bytecode. This is a five-minute fix, and the exact invocation
(including the mandatory `--build-profile production`) is already documented in
`tests/MANUAL_TEST_PLAN.md`.

---

## 3. Overstated or imprecise

### 3.1 "The model scores eight weighted features" (§IV.B) - the two paths are conflated

This is the most substantive issue in the paper.

Section IV.A correctly describes **two** scoring paths. Section IV.B then says "The model scores
eight weighted features… the weights sum to one, and the weighted sum is clamped back to the same
range", and Table I lists eight features with weights.

That describes the **browser rule-based scorer only**. The LightGBM model scores **ten** features
(`backend/app/ml/features.py:24-35`):

```
wallet_age_days, tx_count, protocols_count, log_balance_usd, mixer_detected,
defi_repaid, defi_liquidations, income_adjusted, employment_adjusted, dishonesty_penalty
```

Three differences that matter:

- "DeFi loan history" is one weighted feature in the rule set; the model splits it into
  `defi_repaid` and `defi_liquidations`.
- `dishonesty_penalty` is a **model input feature** (F9), not a post-hoc adjustment. §IV.E's prose
  ("a dishonesty penalty is applied to the score") reads as if it were applied after scoring.
- `income_adjusted` / `employment_adjusted` are credibility-weighted, not the raw self-reported bands
  Table I implies.

Worse, **a gradient-boosted model has no weights at all**. The `weight` column shown next to each ML
contribution comes from `_NOMINAL_WEIGHTS` in `backend/app/ml/model.py`, a display-only constant that
the model never consults. So Table I, presented as "the feature set and weights" of the engine
described in IV.A, does not describe how the ML path actually reaches a tier - SHAP values do.

**Recommended fix:** split §IV.B into two clearly-labelled subsections, or retitle Table I
"Rule-based scorer feature set and weights" and add one sentence stating the model uses ten features
with SHAP attribution rather than fixed weights. This is a presentation fix, not a code defect - but
as written a reviewer who opens the repo will find the table doesn't match the model.

### 3.2 "Average balance over 90 days" (Table I) - it is a point-in-time balance

The rule-based field is named `avgBalanceUsd90d` and labelled "Avg. balance (90d)"
(`risk-explainer.ts:95`), but that field is only ever populated by the **synthetic personas**
(`borrower-personas.ts:49,73,99` - three hand-authored constants).

For a real wallet, the value comes from the backend's `_balance_eth`
(`chain_fetcher.py:119`), which is a single `eth_getBalance` call: the **current** balance, converted
to USD and log-scaled. There is no 90-day history, no averaging, no time series.

So the Table I row is accurate for the demonstration personas (where it is a made-up number anyway)
and **inaccurate for the connected-wallet path the paper presents as the real one**. Either implement
the average, or rename the feature to "Wallet balance" - which is what the backend's own label
already says (`features.py:42`).

### 3.3 SHAP attributions (§IV.A, §VI) - real, but fragile until today

The SHAP path is genuine (`shap.TreeExplainer`). Two caveats worth knowing:

- Until fixed on 2026-08-23, `shap >= 0.45`'s changed return layout meant SHAP either silently
  returned all zeros or crashed the whole scoring endpoint with `IndexError` - and only when the
  model predicted **Tier A**, so it presented as intermittent. Now handled for both layouts, with
  four regression tests in `backend/tests/test_score_shap.py`.
- The explainer is still wrapped in a bare `except: pass`. If it fails, every `shap_value` is `0.0`
  and the interface renders the breakdown anyway, showing nominal weights beside meaningless zeros.
  For a paper whose central claim is explainability, a silently unexplained score is the worst
  failure mode available. Worth surfacing "explanation unavailable" rather than rendering zeros.

### 3.4 "Only the inputs that cannot be sourced safely on a testnet are simulated" (§III.A)

The sentence names the price feed and the personas. It omits that the **model's training data is
also synthetic** - the classifier is trained on generated samples, not on any labelled default
dataset. §V.E does state this plainly and honestly, so the paper is not concealing it, but §III.A's
framing of the simulation boundary is narrower than the truth and the two paragraphs should agree.

### 3.5 "polling the contracts for reads through a server side proxy" (§III.B)

Accurate, with one wrinkle: there are **two** proxies, not one - `/api/rpc/[chain]` for general reads
and `/api/rpc/logs` for event queries, because the application RPC caps `eth_getLogs` at a 10-block
range. §V.A does describe the second one. Note also that the logs proxy was **untracked in git until
2026-08-23** (a `logs/` line in `.gitignore` silently swallowed it), so any clone taken before that
date has a broken event-history path. Fixed, but relevant if a reviewer clones an older commit.

### 3.6 "row level security on every table" (§III.D)

True of all six tables. The nuance: migration 005 adds a `public_profiles` **view** that deliberately
does *not* apply the caller's RLS - it is owned by the migrating role and relies on its own JOIN plus
an explicit `REVOKE ALL … FROM anon, PUBLIC` for safety. That is a sound design and the migration
documents it thoroughly, but "row level security on every table" is no longer the whole story of how
profile data is protected. One clause would cover it.

---

## 4. Shipped in code, absent from the paper

These are gaps in the *paper*, not the code. Several are things the paper's own related-work section
sets up and then never claims - which is a missed opportunity rather than an error.

1. **EIP-712 term-sheet signing and IPFS anchoring.** The borrower signs a canonical, hashed term
   sheet before loan creation; it is pinned to IPFS via Pinata and the lender verifies both the
   keccak256 hash and the recovered signer.
   (`lib/termsheet-typed-data.ts`, `lib/termsheet-canonical.ts`, `app/api/termsheet/pin/route.ts`,
   migration 006). The paper mentions IPFS **zero times**. This is the single largest omission - it
   is exactly the "hash-anchored, verifiable agreement" the transparency argument wants, and 13 tests
   already cover it.

2. **ML model versioning.** The model is versioned by SHA-256 content hash of the pickle
   (`v-8c9c64e`), stamped at train time, verified against the live file on every load, returned in
   the score response, and persisted per loan (migration 006). §II.D is titled *Model Lifecycle
   Reliability* and cites MLOps work - then §VI lists model governance as **future** work. The paper
   defers something it has partly built.

3. **Peer discovery.** `/directory` search by name or wallet, per-user profile pages, and the
   `public_profiles` view (migration 005), with 23 tests. Unmentioned.

4. **Pull-payment fallback.** `pendingWithdrawals` + `withdraw()` for when a push transfer to a
   lender fails (reverting recipient, or one exceeding the 50,000 gas forwarded). This is a real
   safety property - a single hostile lender contract cannot brick settlement for the rest of the
   pool - and it is exactly the kind of detail a reviewer looks for. Unmentioned.

5. **Lender cap and minimum contribution.** `MAX_LENDERS = 10` (`Loan.sol:32`) and a 1%-of-principal
   minimum. Both bound the pooling claim and neither appears in the paper.

6. **Loan cancellation and contribution reclaim.** `cancel()` (borrower, pre-funding) and
   `reclaimContribution()` (contributor, on a cancelled or expired request). Unmentioned.

7. **Downloadable statements.** P&L, Tax P&L and Tradebook as PDFs, built entirely from indexed
   events with per-event price snapshots and a selectable reporting period. §III.E alludes to
   "financial statements" in one clause; the feature is considerably larger than that implies and
   directly serves the transparency claim.

8. **Global Real/Demo mode with automatic wallet scoring** (2026-08-23). Demo personas are now an
   explicit global mode rather than an option inside the loan wizard, and a connected wallet is
   scored by the ML backend on page load. This materially strengthens §IV.A: connected-wallet mode is
   now the *default* path, not an alternative to persona mode.

9. **Two contracts exist but are unused.** `KYCRegistry.sol` (KYC is enforced off-chain) and
   `MockERC20.sol` (ETH is the only loan asset). The paper's "four contracts" is correct for the live
   system; a reviewer browsing the repo will find six plus a test helper. One footnote avoids the
   confusion.

10. **Demo time-skip controls.** `fastForward()` is gated on factory `demoMode` and callable only by
    that loan's borrower or lender. The paper mentions "the demonstration controls" once, in a list
    of what the tests cover, without saying what they are.

---

## 5. Editorial and structural defects

These are mechanical and would be caught in proofing, but they are the kind of thing a reviewer
notices immediately.

1. **Broken sentence in §VI.** The conclusion contains an orphaned fragment:
   *"denominated principal alongside the current ETH collateral."* - the beginning of the sentence is
   missing. Almost certainly a truncated "…support for token-denominated principal…".

2. **REFERENCES appear mid-section.** The final paragraph of §VI ("We also described the process that
   produced this design…") sits **after** the reference list. Section VI needs to close before
   REFERENCES opens.

3. **Incomplete citations.** [9] and [10] both carry the literal note
   *"[Author and volume details to be verified.]"*. These must be completed or removed - a reviewer
   will read them as unverified padding.

4. **Table II is split in two** with a duplicated header row, Tier C orphaned into a second table.
   A rendering artifact, but it makes the mapping harder to read.

5. **Malformed formulas.** The sizing block renders as
   `_− adjustedCollateralUsd = collateralEth × price × (1 haircut)_` - the minus sign has migrated to
   the front of the line and out of `(1 − haircut)`. Same in the `requiredCollateralEth` line. The
   formulas themselves are correct (verified against `loan-terms.ts:89-97`); only the typesetting is
   broken.

6. **Fig. 1 placeholder is still in the text.** `_[ Insert Fig. 1 system architecture diagram here ]_`

7. **Section headings use `##` for what are semantically sub-subsections** (e.g. `## _A. Design
   Approach_` under `## III.`), so the document has no heading hierarchy. Cosmetic in Markdown,
   but it will fight any conversion to a conference template.

---

## 6. Priority list

If only a few things get fixed before submission:

1. **§IV.B / Table I** - separate the rule-based scorer from the ML model, or retitle the table.
   This is the one place where an opened repo contradicts the paper (§3.1).
2. **Test counts** - 233, not 131, and say the backend suite exists (§2.1).
3. **§V.B manual testing** - re-run against the current deployment or reword (§2.2).
4. **Table I "Average balance over 90 days"** - rename to "Wallet balance" (§3.2).
5. **Add IPFS term sheets and model versioning** - two paragraphs would convert the largest gap into
   two of the paper's better contributions (§4.1, §4.2).
6. **Fix the broken sentence, reference ordering and the two placeholder citations** (§5.1-5.3).
7. **Verify the current contracts on Blockscout/Sourcify** (§2.3).

# Activity and pending states

New `ActivityProvider` + activity centre: a header indicator showing in-flight
count, bottom-right toasts, and a history panel. Wired into every path that
actually waits — loan creation, funding, repayment, cancellation, liquidation,
claim, reclaim, term-sheet signing, IPFS pinning, and wallet scoring.

Everything reflects real state. Durations are measured from actual start times
and tick live, so a slow confirmation reads "still working, 14s" instead of an
indeterminate spinner. No artificial delay anywhere.

Two things worth calling out:

- A reverted receipt is now reported as failure. Previously a transaction that
  reverted on-chain returned a successful RPC call and looked fine. That's the
  exact failure mode that makes balance-delta testing untrustworthy.
- Settlement receipts distinguish "indexing history" from "no transactions yet."
  They showed one message for both, so a broken log proxy was indistinguishable
  from an empty loan — relevant given drpc died mid-session.

Repayment toasts explicitly say MetaMask won't list the payment, since that's
the single most-repeated confusion in this project.

# Paper audit

The paper's technical claims hold up well: Table II matches `loan-terms.ts`
exactly, the $1,250/$1,251 liquidation boundary is asserted in a real test, the
fail-closed oracle behaves as described. Problems fall into four buckets:

**One real contradiction.** §IV.B says "the model scores eight weighted
features" and Table I lists them — but that describes the browser rule-based
scorer. The LightGBM model uses ten features, and a gradient-boosted model has
no weights at all; the `weight` column shown beside ML contributions is a
display-only constant the model never reads. A reviewer who opens the repo will
find the table doesn't match the model.

**Stale numbers.** The paper claims 131 tests; actual count is 233 (54
contracts, 170 frontend, 9 backend). The 28/103 split was correct when written.
It undersells the work by ~100 tests. Also: the "nine loans manually tested on
Sepolia" were on the pre-pooling factory — the current one has zero loans, so
that evidence no longer describes the deployed system.

**One inaccuracy.** Table I's "Average balance over 90 days" is a single
`eth_getBalance` call for real wallets — current balance, no averaging. The
90-day framing only holds for the synthetic personas, where it's a hand-authored
constant anyway.

**A large omission.** IPFS appears zero times in the paper, yet EIP-712
term-sheet signing with IPFS anchoring and lender-side verification is fully
built and tested. Same for model versioning — §II.D is titled Model Lifecycle
Reliability and §VI lists governance as future work, while the code already
versions the model by content hash and persists it per loan. Also unmentioned:
peer discovery, the pull-payment fallback, the 10-lender cap, cancellation/
reclaim, and the statements feature.

Plus mechanical defects: a truncated sentence in §VI, references appearing
before the section ends, and two citations still reading "[Author and volume
details to be verified]".

§6 of the audit has a priority list if you only fix a few things.

One item for your PLAN.md: the cancel button I queued last week already exists
on Atharva's branch — `cancelLoan()` is in `BorrowerLoansSection.tsx` with
confirmation copy about contributors reclaiming separately. That backlog entry
is stale.