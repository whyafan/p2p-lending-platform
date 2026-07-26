# NexusFi — Manual Test Plan

Living checklist for manually testing the deployed app against live Sepolia contracts.
Automated contract tests live in `contracts/test/` (`npx hardhat test`, 12 passing) — this file covers what those can't: the real UI, real wallets, two real people.

> **Status: not yet executed.** Written 2026-07-26, to be run as a full pass later.
> Tick boxes as you go and note anything odd at the bottom.

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

**Deployed contracts under test** (redeployed 2026-07-26):
- LoanFactory `0x3C4083D4C3E091aCf44bc7E13111fa219F5C4500`
- CollateralVault `0xF5903a5EF8A9226Df08b4079C72AACa38117c153`
- MockPriceFeed `0x06bfefD8ba2EdAC5157aE929a8E595aB90a33495`

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

## Track B — Delinquency + liquidation (multi-day)

Uses the **1-day** duration option → full arc is ~3 days (1d deadline + 2d grace period).
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

## Findings log

| Date | Track/step | What happened | Expected | Severity |
|---|---|---|---|---|
| | | | | |

---

## Known issues going in (don't re-report)

- **BUG-VIS** — loans not reliably visible across accounts. Open, undiagnosed. Track C targets it.
- **BUG-03** — interest rounds to 0 for tiny loans (<~3650 wei). Use ≥0.01 ETH.
- **BUG-11** — loan ID race if two loans are created simultaneously.
- **BUG-14** — `liquidationBufferBps` missing from some lender views (cosmetic).
- **Partial liquidation not supported** — liquidation always seizes the full collateral, never just enough to cover the debt (CollateralVault is one-shot/all-or-nothing).
- **Loan amounts are USD-framed in the UI but ETH-settled on-chain** — a price move changes the lender's USD exposure and can trigger liquidation, but never restates what the borrower owes in ETH. Deliberate; see PLAN.md.
