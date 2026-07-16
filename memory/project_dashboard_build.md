---
name: project-dashboard-build
description: Dashboard build — role selection in onboarding, LoanRequestPanel wizard, full borrower dashboard
metadata:
  type: project
---

Dashboard (Layer 4 UI) built on top of the existing 3-layer borrower architecture.

**Why:** User requested a crypto-exchange-like borrower dashboard with role toggle, transparent risk scoring, LTV info, and an on-chain loan request flow.

**What was built:**

1. `supabase/migrations/002_user_role.sql` — adds `user_role TEXT` (NULL = not yet set) to profiles table. Run in Supabase dashboard SQL editor.

2. Onboarding now has 5 steps: Account → **Role** → Wallet → KYC → Ready. Role step shows Borrow / Lend / Both cards and calls `PATCH /api/profile` with `{ userRole }`.

3. `app/api/profile/route.ts` — new PATCH endpoint saves `user_role` to profiles.

4. `hooks/useCompliance.ts` — returns `userRole`, `hasRole`, `canLend` alongside existing fields.

5. `components/LoanRequestPanel.tsx` — 4-step wizard: Choose Mode → Select Persona → Loan Config → Review & Submit. Uses wagmi `useWriteContract` calling `LoanFactory.createLoan()`. Needs `NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA` set to submit on-chain.

6. `app/app/page.tsx` — full dashboard: sticky header, role toggle (Borrower/Lender tabs, locked if role not selected), 4 stat cards, 2-column grid (LoanRequestPanel | RiskProfileCard + MarketRatesCard + HowItWorksCard), Active Loans table placeholder.

7. `components/LenderDashboard.tsx` — full lender interface: reads LoanFactory via 3-round wagmi multicall (getLoanIds → loans(id) → status+lender per contract), "Open Requests" tab shows fundable loans with tier badge + LTV + interest earned, fund via `loan.fund()` payable. "My Positions" tab shows funded loans with LTV bar and demo liquidation button (`markLiquidatedForDemo`). 30s auto-refresh.

8. `components/LoanRequestPanel.tsx` — extended with: WalletEvaluationForm (8-feature form, tx count auto-fetched via usePublicClient, balance auto-filled from useBalance), live risk score preview via useMemo + scoreFeatureVector(), post-submission lifecycle explainer (5-step timeline after tx confirms). `submittedHash` typed as `0x${string} | undefined` (wagmi v2 compat).

9. `app/globals.css` — added `@source "../components"`, `@source "../hooks"`, `@source "../lib"` for Tailwind v4 to scan those directories.

**How to apply:** Role toggle drives `activeView`. Lender view renders `LenderDashboard` when `canLend`, else `LockScreen`. Factory address prop flows from env var based on `networkMode`.

**Deployed Sepolia contracts (2026-05-18):**
- LoanFactory: `0xD4cfc809B885e7c197d3cA6878746881c78d2cE5`
- CollateralVault: `0x99Cb30A1e862f817b7702432f3B409825Ed5cA09`
- MockPriceFeed: `0xC6faac19a11B7057AD42ce69429717f6AA7CEb3a`
- All three addresses written into `frontend/.env.local`
- Alchemy Sepolia RPC required — `contracts/.env` must have `SEPOLIA_RPC_URL` pointing to Alchemy; Hardhat 3 needs explicit `dotenv.config()` call in hardhat.config.ts (now added)

**2026-05-18 — Account settings + gap fix:**
- `app/settings/page.tsx` — new settings page: wallet list, link new wallet (nonce→verify), KYC badge, role picker, sign out
- Dashboard header now has a user icon (SVG) linking to `/settings`
- LoanRequestPanel gap fixed: removed `flex-1 max-h-[calc(100vh-240px)]` from inner content div; added `self-start` to the grid item in page.tsx so the panel card doesn't stretch to match the taller right sidebar

**Next steps:**
- Run `002_user_role.sql` migration in Supabase dashboard (one-time, if not already done)
- Wire Active Loans table (borrower side) to read from LoanFactory on-chain — same multicall pattern as LenderDashboard
- Wallet age in WalletEvaluationForm is a dropdown approximation — first-tx timestamp lookup via Etherscan API is Phase 2
