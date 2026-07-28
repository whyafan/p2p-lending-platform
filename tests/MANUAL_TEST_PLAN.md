# NexusFi — Manual Test Plan

Living checklist for manually testing the deployed app against live Sepolia contracts.
Automated contract tests live in `contracts/test/` (`npx hardhat test`, 12 passing) — this file covers what those can't: the real UI, real wallets, two real people.

> **Status: session 1 (2026-07-26) partially run, then stopped.** A loan was created, funded,
> and time-skipped to liquidation — which exposed several real bugs (see Findings). Those are
> fixed and the contracts were redeployed, so **all earlier loans are gone and testing restarts
> from scratch.** Tick boxes as you go and fill in the findings table.

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

---

## Findings log

| Date | Track/step | What happened | Expected | Severity |
|---|---|---|---|---|
| 07-26 | A (repay) | Both users had to refresh constantly; lender's position vanished after repayment | Live updates; settled loans retained | **Fixed** — polling paused on unfocused tabs, and positions filtered to Funded only |
| 07-26 | B (liquidation) | Liquidation seized the entire collateral regardless of how much was repaid | Seize only the debt | **Fixed** — partial liquidation, surplus refunded |
| 07-26 | A (create) | "What happens next" never advanced past step 1 | Follows real loan status | **Fixed twice** — first the steps were hardcoded, then the loan address decode was gated behind the risk assessment |
| 07-28 | D (price crash) | Crashed ETH to \$500; lender received exactly the principal + interest, not the whole collateral | Correct — this is the intended partial-liquidation behaviour | Not a bug |
| | | | | |

---

## Known issues going in (don't re-report)

- **BUG-VIS** — loans not reliably visible across accounts. Open, undiagnosed. Track C targets it.
- **BUG-03** — interest rounds to 0 for tiny loans (<~3650 wei). Use ≥0.01 ETH.
- **BUG-11** — loan ID race if two loans are created simultaneously.
- **BUG-14** — `liquidationBufferBps` missing from some lender views (cosmetic).
- **Partial liquidation not supported** — liquidation always seizes the full collateral, never just enough to cover the debt (CollateralVault is one-shot/all-or-nothing).
- **Loan amounts are USD-framed in the UI but ETH-settled on-chain** — a price move changes the lender's USD exposure and can trigger liquidation, but never restates what the borrower owes in ETH. Deliberate; see PLAN.md.
