# Peer discovery - design spec

> Phase 2 of `planv2.md`.
> Goal: stop making teammates coordinate borrower/lender pairs by guessing loan IDs.
> Exit criteria: a user can look up another verified user and see their open loans without knowing a loan ID in advance.

## Summary

A searchable directory of verified users, reachable from a new `/directory` page.
Search by display name or wallet address (partial match).
Results only include users with at least one signature-verified linked wallet.
Clicking a result opens `/directory/[walletAddress]`, showing that user's badges plus their open loan requests (if they are a borrower) and active funded positions (if they are a lender), read-only.

No smart contract changes.
All loan data is read live from the chain, the same way `BorrowerLoansSection` and `LenderDashboard` already do it, just parameterized by the looked-up address instead of the connected one.

## Data layer

New migration: `supabase/migrations/005_public_profiles_view.sql`.

Problem: the existing RLS policies (migration 002) restrict `profiles` and `linked_wallets` to `auth.uid() = id` / `user_id = auth.uid()`.
Nobody can currently read another user's row at all.

Three ways to open that up were considered:

1. A new RLS SELECT policy directly on `profiles` / `linked_wallets` for other users' rows.
Rejected: Postgres RLS is row-level, not column-level.
Any policy that lets another authenticated user read the row at all lets them read every column through it, including `email`, which the plan explicitly requires to stay private.
2. A new server route using the admin (service-role) client, matching the pattern already used by `/api/wallets` and `/api/loans/risk`.
Rejected: those routes fall back to the RLS-scoped client when `SUPABASE_SERVICE_ROLE_KEY` is not set, and migration 002's stated goal was that teammates can run the app without configuring that key.
Under this approach the directory would silently return nothing for anyone missing the service-role key.
3. **Chosen** - a dedicated database view, `public_profiles`, that itself only selects the safe columns, filtered to verified-wallet users, with `SELECT` granted to the `authenticated` Postgres role.

View definition (approximate, finalize exact SQL during implementation):

```sql
CREATE OR REPLACE VIEW public_profiles AS
SELECT
  p.id,
  p.display_name,
  p.kyc_status,
  p.user_role,
  lw.wallet_address
FROM profiles p
JOIN linked_wallets lw
  ON lw.user_id = p.id
 AND lw.is_primary = true
 AND lw.signature_verified = true;

GRANT SELECT ON public_profiles TO authenticated;
```

Notes:
- Only the primary verified wallet is exposed per user, matching what the settings page already treats as "the" wallet.
- A user with a verified wallet that is not marked primary will not appear until they mark one primary. This is an acceptable edge case for the MVP; the settings page already lets users set a primary wallet.
- The base tables (`profiles`, `linked_wallets`) keep their existing RLS. The view is the only read path for cross-user data, and it never exposes `email` or any other column not listed above, at the database level, regardless of what a client tries to select.

## API

### `GET /api/directory/search?q=<term>`

- Requires sign-in via `getSessionUser()`, same as every other route in this codebase. 401 if not signed in.
- `q` must be at least 2 characters after trimming; otherwise returns `{ results: [] }` without querying.
- Queries `public_profiles` via the caller's own RLS-scoped Supabase client (the view's grant makes this work without the admin client): `display_name ILIKE %q% OR wallet_address ILIKE %q%`.
- Excludes the caller's own `id` from results.
- Capped at 20 results, ordered by `display_name`.
- Response shape (camelCase, matching the `/api/wallets` convention):

```ts
{
  results: Array<{
    id: string;
    displayName: string | null;
    kycStatus: string;
    userRole: string | null;
    walletAddress: string;
  }>;
}
```

### `GET /api/directory/[walletAddress]`

- Requires sign-in. 401 if not signed in.
- Looks up `public_profiles` by `wallet_address`, matched exactly against the lowercased route param. `linked_wallets.wallet_address` is already stored lowercased on insert (see `/api/wallets/verify`), so this is an exact `.eq()`, not a substring match. No ILIKE here; ILIKE is only for the search endpoint's free-text query.
- 404 if no row matches, whether because the wallet does not exist, belongs to an unverified user, or belongs to a user with no primary verified wallet. The same 404 in every case, so the endpoint cannot be used to distinguish "does not exist" from "not verified."
- On success, returns the same per-user shape as one entry of the search response above.
- Does **not** return loan data. Loan data is public on-chain state; the frontend reads it directly from the chain (see UI section), so this route stays a thin profile lookup.

## UI

### Shared component: `components/KycBadge.tsx`

Extracted from the inline `KycBadge` currently defined in `app/settings/page.tsx`, with no behavior change.
Both the settings page and the new directory pages import it from this shared location.

### `/directory` (new page, `app/directory/page.tsx`)

- Gated the same way as the dashboard: if `!compliance.data?.authenticated`, `router.replace('/')`.
- A search input. Empty state (just the input, no results, no error) until the trimmed query is at least 2 characters.
- Debounced fetch to `/api/directory/search` (roughly 300ms, plain `setTimeout`, no new dependency).
- Results list: each row shows display name (or a shortened wallet address if no display name is set), truncated wallet address, `KycBadge`, and a role badge (borrower / lender / both).
- Empty-results state: "No verified users found for '<query>'."
- Clicking a row navigates to `/directory/[walletAddress]`.

### `/directory/[walletAddress]` (new page, `app/directory/[walletAddress]/page.tsx`)

- Same auth gate as above.
- Fetches the profile from `GET /api/directory/[walletAddress]`. On 404, shows a "User not found or not verified" state instead of erroring.
- Header: display name, `KycBadge`, role badge, full wallet address with a copy button and an Etherscan link (matching the pattern already used elsewhere for tx hashes and contract addresses).
- If the user's role is `borrower` or `both`: an "Open loan requests" section.
- If the user's role is `lender` or `both`: an "Active positions" section.
- Both sections are rendered by a new component, `components/PublicLoanSummary.tsx`, described below.
- If a section's role applies but there is currently no matching loan activity, that section shows a plain empty state ("No open requests" / "No active positions"), not an error.

### `components/PublicLoanSummary.tsx` (new, read-only)

Deliberately a new, small component rather than a refactor of `BorrowerLoansSection` or `LenderDashboard`.
Those two components are large, already working, already tested through Phase 1, and carry write actions (repay, fund, liquidate) that have no place on someone else's public profile.
Reusing their internals would mean either threading a "read-only" flag through components that were not designed for it, or extracting shared hooks out of components that are not part of this phase's scope.
Both add risk to working code for a feature that only needs read access.

`PublicLoanSummary` mirrors the same on-chain query shape those components already use (`getLoanIds()` from the factory, then `loans(id)` for terms, filtered client-side by `terms.borrower` or a separate `lender()` read, exactly as `BorrowerLoansSection` and `LenderDashboard` already do it) but:
- Takes a target wallet address as a prop instead of reading the connected `address` from `useAccount()`.
- Filters to open/funded (active) loans only, per the approved design; closed (repaid/liquidated) loans are out of scope for this phase.
- Renders status, terms (principal, APR, LTV, duration), and a live countdown/LTV bar where relevant, using the existing formatting helpers (`lib/format.ts`, `lib/loan-terms.ts`).
- Renders no action buttons. No fund, repay, or liquidate controls.

### Nav entry point

`app/app/page.tsx` gets a new "Find a user" link next to the existing "Change role" link, pointing at `/directory`. This is the only change to the existing dashboard page.

## Error handling and edge cases

- Not signed in: redirected to `/`, same as the main dashboard.
- Viewing someone else's profile does not require the viewer to have a connected wallet; it is pure Supabase auth plus public on-chain reads.
- Search excludes the caller's own profile.
- Unknown or unverified wallet at `/directory/[walletAddress]`: a single "not found" state, not a distinguishing error, so the route cannot be used to enumerate who is or is not verified.
- A verified user with zero matching loans: empty state per section, not an error.
- Search is capped at 20 results with a 2-character minimum; no pagination in this phase, consistent with the existing 20-item cap on wallet screenings in `/api/wallets`.

## Explicitly out of scope for this phase

- Closed (repaid/liquidated) loan history on the profile page.
- Messaging or any other user-to-user interaction beyond viewing.
- Pagination or infinite scroll on search results.
- Any change to the smart contracts.
