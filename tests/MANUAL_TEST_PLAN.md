# NexusFi — Manual Test Plan

Living checklist for manually testing the deployed app against live Sepolia contracts.
Automated contract tests live in `contracts/test/` (`npx hardhat test`, 28 passing) — this file covers what those can't: the real UI, real wallets, two real people.

> **Status: COMPLETE — all tracks passed (2026-07-26 → 29).**
> Two people, real wallets, live Sepolia, nine loans across the full lifecycle. Results verified
> against on-chain state rather than UI impressions.
>
> This file is now a **regression checklist**: re-run it after any contract change or redeploy.
> The findings table at the bottom is the permanent record of what testing uncovered.

## Results

| Track | Result | Evidence |
|---|---|---|
| **A** Repayment lifecycle | ✅ Pass | Partial, second partial, repay-in-full, **A6 overpay refund** — loans #4 and #6 closed with `amountRepaid` capped at the debt and all 0.005 ETH collateral released |
| **B** Deadline → grace → liquidation | ✅ Pass | Run via `/demo` Skip time |
| **C** Two-user visibility | ✅ Pass | After the background-polling fix |
| **D** Price-crash liquidation | ✅ Pass | Incl. the `$0` broken-oracle fail-safe blocking liquidation |
| **E** Partial-liquidation fairness | ✅ Pass | **E2** figures shrink on repayment · **E3** loans #5/#7 repaid 0.00125 → seized 0.001085, refunded 0.003915 · **E4** loans #2/#3/#8 no repayment → seized only ~0.002335, refunded ~0.002665 |

**Interest confirmed working and ETH-denominated.** Loans left to accrue show `0.000085068 ETH`
(90d @ 15% APR on 0.00225 ETH ≈ 0.0000832 — matches). Loans repaid immediately show ~1 wei, because
accrual is by *elapsed time*. It only looked missing because the UI renders it in USD and demo
amounts are tiny.

---

## 0. Setup (once)

**Who tests what:** Afan = borrower, Siddharth = lender. Both need their own account + wallet.

| Person | URL to use |
|---|---|
| Afan | https://nexusfi-afan.vercel.app |
| Siddharth | https://nexusfi-siddharth.vercel.app |
| Atharva | https://nexusfi-atharva.vercel.app |
| shared / stable | https://nexusfi-lending.vercel.app |

All four URLs share the **same Sepolia contracts and the same Supabase database** — that's what lets one person's loan show up in another person's dashboard. Use whichever URL you like; you'll still see each other.

- [ ] Both wallets funded with Sepolia test ETH (borrower: collateral + gas; lender: principal + gas). Faucet: <https://www.alchemy.com/faucets/ethereum-sepolia>
- [ ] Both signed up + logged in (email/password)
- [ ] Both completed onboarding: **pick "Both" as the role** so you can flip between borrower/lender views without re-onboarding
- [ ] Both linked a wallet (signature verification step)
- [ ] Both passed KYC via the demo bypass (`ALLOW_DEMO_KYC=1` is on — no real ID needed)
- [ ] Network toggle set to **testnet** on both

**Deployed contracts under test** (redeployed 2026-07-26, partial liquidation):
- LoanFactory `0x4dDB469155A8824FDCa64d2e706aFE6380C55fAd`
- CollateralVault `0xeB137a592E5623D2750CEcf4Ad8421E2aA8FDf16`
- MockPriceFeed `0x5094c61F27B8b7538eeC330f9Ec013277E590a7c`

> **Demo controls: `/demo`** (e.g. <https://nexusfi-afan.vercel.app/demo>) — not linked from the nav.
> Set any ETH price, and skip a loan's clock past its deadline/grace period. This makes Track B
> runnable in minutes instead of 3 days, and Track D instant. Time-skips must be sent by that
> loan's own borrower or lender; the price control works from any wallet.

---

## Track A — Repayment lifecycle (no waiting, do first)

Any duration works here; nothing depends on deadlines. Use small amounts (≥0.01 ETH principal — interest rounds to 0 below ~3650 wei, see BUG-03).

- [ ] **A1 Create** — Borrower creates a small loan. Collateral shows as locked; loan ID noted: `______`
- [ ] **A2 Fund** — Lender funds it from Open Requests. Verify: borrower's balance increases by *exactly* the principal, status flips to `Funded` in **both** dashboards
- [ ] **A3 Partial repay** — Borrower repays a small amount (well under the outstanding balance). Verify: status stays `Funded`, outstanding balance drops by exactly that amount, lender's balance rises by exactly that amount
- [ ] **A4 Second partial** — Repeat with a different amount. Verify the outstanding balance keeps decreasing cumulatively and correctly
- [ ] **A5 Repay in full** — Click "Repay in full". Verify: status → `Repaid`, collateral returns to borrower, outstanding reads 0, lender receives exactly the remainder (not more)
- [ ] **A6 Overpay refund** — On a *fresh* loan, type an amount noticeably larger than outstanding and repay. Verify the excess comes back to the borrower in the same tx (check the actual wallet balance delta, not just "it worked") and the loan still closes
- [ ] Every action produced a working `sepolia.etherscan.io` link

### A7 — Things that should fail cleanly (not silently succeed)

- [ ] Repay from the **lender's** wallet → reverts (`caller is not borrower`)
- [ ] Repay with `0` → rejected (`repayment must be non-zero`)
- [ ] Borrower tries to fund their **own** loan → blocked in UI ("Your request")
- [ ] Cancel an already-**funded** loan → not possible (cancel is pre-funding only)
- [ ] Create two loans back-to-back quickly → distinct IDs, no cross-contaminated state *(brushes BUG-11 and BUG-VIS — just note anything weird, don't chase it)*

---

## Track E — Partial liquidation fairness (new, do after A)

Liquidation seizes only the outstanding debt and refunds the surplus, so partial repayments
genuinely protect the borrower. Both dashboards show the split before anyone clicks.

- [ ] **E1** — Create + fund a loan. On the borrower's repay box, note the "if liquidated now"
      split; on the lender's card, note what Liquidate says it would recover
- [ ] **E2** — Borrower makes a partial repayment. Verify the **seize figure falls** by roughly
      that amount and the **refund figure rises** on both sides
- [ ] **E3** — Repay most of the loan, then `/demo` → Skip time past grace, and liquidate.
      Verify the lender receives only what was still owed and the **borrower gets the rest back**
      (check both wallet balances, not just the UI)
- [ ] **E4** — On a separate loan with **no** repayments, liquidate and confirm the lender still
      only recovers the debt, not the full collateral

---

## Track B — Delinquency + liquidation (multi-day)

Two ways to run this:
- **Fast (recommended for a first pass):** use `/demo` → "Skip time" to jump a loan past its
  deadline and grace period instantly. Verifies the exact same on-chain gates.
- **Real-time (do once, for confidence):** use the **1-day** duration and wait the real ~3 days
  (1d deadline + 2d grace). Proves nothing depends on the demo helper.

Do this on its own loan, separate from Track A. Note funding time — everything is relative to it.

**Funded at:** `____________`  → due `+24h` → liquidatable `+72h`

- [ ] **B1 T+0** — Borrower creates a **1-day** loan; lender funds it
- [ ] **B2 Before 24h** — No "PAST DUE" badge. Lender's Liquidate button is **disabled** showing a countdown
- [ ] **B3 ~24h (past due, inside grace)** — Borrower shows **"PAST DUE"** badge. Lender's Liquidate is **still disabled** with grace countdown. If forced directly, reverts `Loan: grace period not elapsed`
- [ ] **B4 Repay while delinquent** — On a *separate* delinquent loan, confirm the borrower can still repay normally and close it (being late ≠ being locked out)
- [ ] **B5 Interest cap** — On a loan left unpaid: note the outstanding balance right around the grace boundary (+72h), check again well after. It should be **flat, not still climbing**
- [ ] **B6 ~72h (liquidatable)** — Liquidate button now **enabled**, "LIQUIDATABLE" badge shows. Click it. Verify: collateral moves to lender, status → `Liquidated` in both dashboards
- [ ] **B7 After liquidation** — Borrower can no longer repay; a second liquidate attempt reverts (`Loan: not active`)
- [ ] **B8 Already-repaid guard** — On a short loan fully repaid *before* its deadline, once +72h passes anyway, Liquidate never enables for it (status is `Repaid`, not `Funded`)

---

## Track D — Price-crash liquidation (fast, no waiting)

The other liquidation trigger: an ETH price crash raising LTV past the threshold.
Unlike Track B this needs **no waiting** — you set the mock price directly.

How it works: the debt is frozen in USD at funding (principal x price-at-funding) while
collateral is valued at the live price. Drop the price and LTV climbs. With a 70% max LTV
and 10% buffer, the threshold is 80%; a loan at 50% LTV becomes liquidatable once the price
falls to ~62.5% of its funding value.

Only the deployer wallet (contract owner) can call `setPrice` on MockPriceFeed
(`0x06bfefD8ba2EdAC5157aE929a8E595aB90a33495`) — that's Afan's deployer key.

- [ ] **D1** — Create + fund a loan (any duration). Note the LTV shown on the lender's position card
- [ ] **D2** — Verify the LTV shown now comes from the contract (`currentLtvBps()`), not the old client-side math. Liquidate is disabled
- [ ] **D3** — Crash the price to ~70% of funding price. Verify LTV **rises** on the lender card and the borrower's owed amount does **not** change
- [ ] **D4** — Crash further, past the threshold. Verify the card shows **"LIQUIDATABLE — collateral shortfall"** and the button enables
- [ ] **D5** — Restore the price. Verify it becomes non-liquidatable again and the button disables
- [ ] **D6** — Crash again and actually liquidate. Verify collateral moves to the lender, status → `Liquidated`
- [ ] **D7 fail-safe** — Set price to `0`. Verify LTV shows as unknown/oracle-unavailable and liquidation is **blocked** (bad oracle data must never seize collateral)

---

## Track C — Two-user / cross-account sanity

This is where **BUG-VIS** (loans not always visible between accounts) is expected to show up. Log observations, we'll fix separately.

- [ ] Borrower's new loan appears in the lender's Open Requests **without** a manual refresh (note how long it takes)
- [ ] After funding, the loan disappears from Open Requests and appears under the lender's My Positions
- [ ] Borrower sees the status change reflected on their side
- [ ] Try the **same account from two browsers/devices** — consistent state?
- [ ] Try **different URLs** (Afan's vs Siddharth's deployment) — same loans visible on both? *(they share a backend, so they should be)*

---

## Gotchas worth remembering

Things that already cost time once. Not test steps — just don't relearn them the hard way.

**Redeploying contracts invalidates all existing loans.** Addresses change, so anything created
against the old factory silently disappears from the UI. If loans vanish mid-session, check whether
a redeploy happened rather than hunting a frontend bug.

**Verifying contracts on a block explorer:**
```bash
cd contracts
npx hardhat compile --build-profile production      # step 1 is not optional
npx hardhat verify --build-profile production --network sepolia <address> [ctorArgs...]
# LoanFactory takes three args: <vault> <priceFeed> true
```
- `--build-profile production` is **required**. Ignition deploys with the production profile
  (optimizer on, 200 runs); `verify` defaults to the profile *without* it, so you get
  `bytecode does not match any of your local contracts`.
- Recompiling with that profile first is also required — stale default-profile artifacts throw the
  same error even when the flag is passed, which makes it look like the flag didn't work.
- Etherscan is configured but **disabled** until `ETHERSCAN_API_KEY` is in `contracts/.env`
  (free key at <https://etherscan.io/apis>). Blockscout and Sourcify need no key and already work.

**Only the deployer wallet can't be assumed for demo actions.** `setPrice` is permissionless
(any wallet), but `fastForward` must come from that specific loan's borrower or lender.

**Interest rounds to 0 on tiny loans** (< ~3650 wei). Use ≥ 0.01 ETH or the numbers look broken.

**Interest accrues by elapsed time, not per loan.** A 90-day loan at 15% APR on 0.00225 ETH earns
~0.000083 ETH *over the full 90 days*. Repay after ten minutes and you owe a few hundred wei of
interest — that is correct, not a bug. To see meaningful interest, use `/demo` → Skip time first.

**The liquidation price is relative to the price at FUNDING, not $2,000.** The debt is frozen in USD
when the lender funds. If you crash to \$500 and *then* fund, \$500 becomes the baseline and nothing
is liquidatable; you would have to crash further still. Both dashboards now print the exact price
this loan liquidates below — trust that number, not a mental \$2,000 anchor.

**MetaMask never shows these payments.** Repayments, seizures and refunds all arrive as *internal*
contract transfers. Wallet balances change but no entry appears in MetaMask's activity list. Verify
with the balance itself or the contract on a block explorer.

---

## Track F - Peer discovery (do after A)

Needs two accounts that can already see each other in Track A/C, at least one with an open loan
request and one with a funded position so both sections of the profile page have something to show.

- [ ] **F1 Search by name** - From account 1, go to Find a user (or `/directory`), search the first
      few characters of account 2's display name. Verify account 2 appears, account 1 does not
      appear in its own results, and typing a single character shows no results and fires no request
- [ ] **F2 Search by wallet** - Search the last 6 characters of account 2's wallet address instead.
      Verify the same result appears
- [ ] **F3 View profile** - Click into account 2's result. Verify display name, KYC badge, role
      badge, and full wallet address (with working copy + Etherscan link) all match what account 2
      sees on their own `/settings` page
- [ ] **F4 Open requests visible** - If account 2 has an open (unfunded) loan request, verify it
      shows under "Open loan requests" on their profile, with no fund/repay/liquidate button anywhere
      on the page
- [ ] **F5 Active positions visible** - If account 2 has funded someone else's loan, verify it shows
      under "Active positions" the same way
- [ ] **F6 Unverified/unknown wallet** - Visit `/directory/0x0000000000000000000000000000000000dead`
      directly. Verify "User not found or not verified", not a crash or blank page
- [ ] **F7 Signed out** - Log out, then visit `/directory` and `/directory/<any wallet>` directly.
      Verify both redirect to `/`

---

## Track G - Multi-lender pooling (do after A; 2 lender wallets minimum, 3 if available)

Uses the redeployed pooled Loan.sol. Several lenders can now fund one request in pieces, the
borrower is paid only once the pool reaches the full principal, and every payout after that
splits pro-rata by contribution. Keep every contribution at or above 1% of principal except
where G3 deliberately tests that edge, and use a small principal (>=0.01 ETH, per BUG-03) so
interest doesn't round to zero.

- [ ] **G1 Partial fill** - Borrower creates a small loan. Lender 1 contributes roughly 60% of
      the principal. Verify: the funding progress bar reads about 60% on both the lender's Open
      Requests card and the borrower's own Loans section ("NN% funded - waiting for lenders"),
      status stays `Requested` on both dashboards, and the borrower's wallet balance has NOT
      increased
- [ ] **G2 Fill completes the pool, with an over-contribution refund** - Lender 2 sends
      noticeably more than the remaining gap. Verify by WALLET BALANCE, not the input box:
      Lender 2 is debited only the remaining gap, the excess comes back in the same transaction,
      the loan flips to `Funded` on every dashboard, and the borrower's wallet balance rises by
      exactly the principal
- [ ] **G3 Minimum-contribution edge case** - On a fresh small loan, have Lender 1 contribute
      until less than 1% of the principal remains (watch the live funding readout - e.g. on a
      0.01 ETH loan, stop just above 99% funded). Verify the amber notice appears explaining that
      the Remaining button offers more than what's actually left because the contract enforces a
      minimum, that the difference comes back automatically, and that completing the contribution
      succeeds with the difference refunded and the loan reaching `Funded`
- [ ] **G4 Pro-rata repayment** - On the loan from G1/G2 (roughly 60/40 between two lenders),
      Borrower repays in full. Verify by WALLET BALANCES, not the UI: Lender 1's balance rises by
      about 60% of the repayment and Lender 2's by about 40%, and the two amounts sum exactly to
      what the borrower paid
- [ ] **G5 Pro-rata liquidation, triggered by the smaller contributor** - Fund a fresh pooled
      loan with Lender 1 taking the larger share and Lender 2 the smaller. Skip time via `/demo`
      past the deadline and grace period, then have Lender 2 (not the largest or first
      contributor) click Liquidate. Verify the transaction succeeds from Lender 2's wallet, both
      lenders' wallets rise by their pro-rata share of the seizure, and the borrower's wallet
      rises by the refunded surplus
- [ ] **G6 Per-share settlement receipt** - On the now-closed pooled loan, each lender opens
      their own settlement receipt (My Positions > Completed). Verify each receipt shows only
      that lender's own lent/received/interest figures, not the pool's totals, and that the
      per-leg audit trail below lists only their own contribution/share/withdrawal rows (plus
      loan-level context), not another lender's payouts appearing as unlabeled money in their
      column
- [ ] **G7 Per-share statements** - Each lender downloads a Profit & Loss and a Tax P&L from
      Statements (role: Lender) and checks the figures against their own wallet deltas from
      G4/G5. Then, using a loan whose funding and repayment/settlement happened on different
      calendar days (an earlier test session works, or fund now and close it in a later
      session), set the reporting period to a custom range that starts AFTER the funding date but
      still covers the settlement date. Verify the Tax P&L still shows the lender's real
      contribution as the cost basis, not zero, and not the whole repayment reported as pure
      profit
- [ ] **G8 Reclaim from a dead pool** - Borrower creates a request, Lender 1 contributes a
      partial amount, Borrower cancels before it fills. Verify Lender 1 sees a Reclaim card in My
      Positions ("This request was cancelled by the borrower... your X ETH contribution is
      waiting in the contract") and that Reclaim returns exactly their contribution. Separately,
      on another partially-filled request, let it expire instead of cancelling (the borrower can
      repeatedly skip `+1 day` via `/demo` until past the 7-day funding window) and verify the
      same Reclaim flow appears once it has expired
- [ ] **G9 Claim path (undelivered share)** - `pendingWithdrawals` only fills when a push
      transfer fails, which needs a recipient that reverts or exceeds the 50,000 gas forwarded.
      An ordinary MetaMask (EOA) wallet always accepts a plain ETH transfer well under that
      limit, so this cannot be triggered with the wallets used for this checklist. Do not attempt
      it manually - confirm instead that after G4/G5's payouts, no lender sees the amber "could
      not be delivered to your wallet" banner in My Positions (both push transfers succeeded, as
      expected for EOAs). If a rejecting smart-contract wallet is ever available as a
      contributor, that is the real way to exercise Claim - the banner and the Claim button
      calling `withdraw()` already exist for it
- [ ] **G10 Demo time-skip gate** - While a loan is still `Requested` with at least one
      non-borrower contributor, have that contributor open `/demo`. Verify: no skip-time buttons
      are shown for that loan, replaced by "This loan is still collecting contributions. Only the
      borrower can skip its clock until it's funded." (not a generic "you are not involved"
      message), while the borrower still sees and can use the skip controls. Once the loan is
      `Funded`, verify the same contributor now sees and can use the skip controls too

---

## Findings log

| Date | Track/step | What happened | Expected | Severity |
|---|---|---|---|---|
| 07-26 | A (repay) | Both users had to refresh constantly; lender's position vanished after repayment | Live updates; settled loans retained | **Fixed** — polling paused on unfocused tabs, and positions filtered to Funded only |
| 07-26 | B (liquidation) | Liquidation seized the entire collateral regardless of how much was repaid | Seize only the debt | **Fixed** — partial liquidation, surplus refunded |
| 07-26 | A (create) | "What happens next" never advanced past step 1 | Follows real loan status | **Fixed twice** — first the steps were hardcoded, then the loan address decode was gated behind the risk assessment |
| 07-28 | D (price crash) | Crashed ETH to \$500; lender received exactly the principal + interest, not the whole collateral | Correct — intended partial-liquidation behaviour | Not a bug |
| 07-28 | D | Crashing to \$500 did not enable liquidation | The loan was *funded* at \$500, so that became the baseline; it needed ~\$346 | Not a bug — UI now prints the real trigger price |
| 07-28 | A/E | "Neither side received anything" | Money moved correctly every time; MetaMask does not list internal contract transfers | **Root cause of most confusion — drives the T1/T2 transparency work** |
| 07-29 | — | Lender only sees interest gained on a closed loan | Should show lent, received, interest, seized/refunded, and tx links | Open — PLAN.md T1 |
| 07-29 | — | Risk tier / score not scored | Demo personas score fine; needs repro for the failing path | Open — PLAN.md B1 |
| 07-29 | — | ETH price unlabelled and static | Should say "current market price" and tick live | Open — PLAN.md B2 |
| 07-29 | — | "What went into your score" panel is white-on-light | `RiskExplanationPanel` hardcodes `bg-white`; rest of app is dark | Open — PLAN.md B3 |

---

## Known issues going in (don't re-report)

- **BUG-VIS** — loans not reliably visible across accounts. Open, undiagnosed. Track C targets it.
- **BUG-03** — interest rounds to 0 for tiny loans (<~3650 wei). Use ≥0.01 ETH.
- **BUG-11** — loan ID race if two loans are created simultaneously.
- **BUG-14** — `liquidationBufferBps` missing from some lender views (cosmetic).
- **Partial liquidation not supported** — liquidation always seizes the full collateral, never just enough to cover the debt (CollateralVault is one-shot/all-or-nothing).
- **Loan amounts are USD-framed in the UI but ETH-settled on-chain** — a price move changes the lender's USD exposure and can trigger liquidation, but never restates what the borrower owes in ETH. Deliberate; see PLAN.md.
- **Contract redeploy (2026-08-21)** - addresses changed for the pooling upgrade; loans created against the previous factory no longer appear in the new marketplace. Expected after any redeploy (see Gotchas above), not a new bug.
- **Single global funding-tx state (LenderDashboard)** - fundingLoanId/fundingHash/isFundPending is one shared value, not per-card; starting a contribution on one loan then clicking Contribute on another before the first wallet prompt resolves can make the first card's confirmation banner disappear. Pre-existing pattern (same as the old FundButton), not introduced by pooling.
- **My Positions follows only the active wallet account** - contributions() is queried for the single connected address, not every account across a multi-account wallet connection; a contribution made from a different account than the one currently active won't show until you switch back to it.
