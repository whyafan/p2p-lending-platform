# Peer Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user search for another verified user by display name or wallet address, and view that user's badges plus their open loan requests / active funded positions, without knowing a loan ID in advance.

**Architecture:** A new Postgres view (`public_profiles`) exposes only non-PII columns for users with a verified wallet, reachable by every authenticated user without a service-role key. Two new API routes read that view. Two new pages (`/directory`, `/directory/[walletAddress]`) search it and render a looked-up user's profile, reusing the existing on-chain loan-reading pattern (from `BorrowerLoansSection` / `LenderDashboard`) in a new small read-only component instead of touching those two working, tested components.

**Tech Stack:** Next.js 16 (App Router, client components), Supabase (Postgres + RLS + a plain view for cross-user reads), wagmi/viem for on-chain reads, `@tanstack/react-query`, Tailwind. Tests: `node --test` for pure TypeScript logic (this repo's only automated test tooling - no jsdom/RTL, no API-route test harness); everything else (API routes, React components, pages) is verified manually against the running dev server, matching this repo's existing practice in `tests/MANUAL_TEST_PLAN.md`.

## Global Constraints

- Never use an em dash. Use a plain dash (`-`) instead, in any file this plan touches, including code comments and this plan itself, per the project's `CLAUDE.md`.
- Never add Claude attribution, co-author trailers, or session links to commits.
- Do not run `git commit` - stage and prepare commits are fine, but the user handles git themselves per `CLAUDE.md`'s git policy. Each task's "commit" step below should be read as "stage the change and stop" unless the user has explicitly said otherwise for this session.
- Relative imports inside `lib/*.ts` files that have a co-located `*.test.ts` must use an explicit `.ts` extension (Node's native TypeScript loader requires it for `node --test` to resolve them); imports from `app/` or `components/` into `lib/` do not use the extension. This matches the existing split in the codebase (compare `lib/feature-extractor.ts`'s internal imports vs. how `app/api/risk/score/route.ts` imports it).
- No new npm dependencies. No new test framework or component-testing infra.
- No smart contract changes.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/supabase/migrations/005_public_profiles_view.sql` | New view exposing non-PII profile + primary verified wallet, granted to `authenticated`. |
| `frontend/lib/supabase/types.ts` (modified) | Adds the `PublicProfile` row type for the new view. |
| `frontend/lib/directory.ts` | Pure, unit-tested logic: query normalization, LIKE-pattern escaping, wallet-address validation, row-to-camelCase shaping, search-result merging. |
| `frontend/lib/directory.test.ts` | Tests for the above. |
| `frontend/app/api/directory/search/route.ts` | `GET` search endpoint over `public_profiles`. |
| `frontend/app/api/directory/[walletAddress]/route.ts` | `GET` single-profile lookup by wallet address. |
| `frontend/components/KycBadge.tsx` | Extracted from `app/settings/page.tsx`, unchanged behavior, now shared. |
| `frontend/app/settings/page.tsx` (modified) | Uses the extracted `KycBadge` instead of its own inline copy. |
| `frontend/components/PublicLoanSummary.tsx` | Read-only, on-chain loan list for an arbitrary target address (no fund/repay/liquidate actions). |
| `frontend/app/directory/page.tsx` | Search page. |
| `frontend/app/directory/[walletAddress]/page.tsx` | Profile page: badges + `PublicLoanSummary`. |
| `frontend/app/app/page.tsx` (modified) | Adds a "Find a user" nav link. |
| `tests/MANUAL_TEST_PLAN.md` (modified) | Adds a peer-discovery regression track. |

---

### Task 1: Database migration - `public_profiles` view

**Files:**
- Create: `frontend/supabase/migrations/005_public_profiles_view.sql`
- Test: none (SQL migrations have no automated harness in this repo - see `report.md`'s note that migrations 003/004 "must be run manually in the Supabase SQL editor"). Verified manually below.

**Interfaces:**
- Produces: a Postgres view `public_profiles(id, display_name, kyc_status, user_role, wallet_address)`, `SELECT`-granted to the `authenticated` role. Later tasks query it by these exact column names.

- [ ] **Step 1: Write the migration file**

```sql
-- Run this in the Supabase dashboard SQL editor (or via: supabase db push).
-- Migration 005: peer discovery directory.
--
-- Exposes a narrow, non-PII slice of profiles + linked_wallets to every
-- authenticated user, without changing the existing RLS policies on the
-- base tables (migration 002). Postgres RLS is row-level, not column-level:
-- a policy that let other users read a profiles row at all would let them
-- read every column through it, including email. A view that only ever
-- selects the safe columns avoids that regardless of what a client asks for.
--
-- This view is created (and therefore owned) by the role running this SQL
-- editor script, which is not subject to the profiles/linked_wallets RLS
-- policies. That is intentional and required: the view has to see every
-- user's rows to build the directory, then its own JOIN condition below is
-- what actually restricts the result to verified-wallet users. Do not add
-- `WITH (security_invoker = true)` to this view - that would make it
-- re-apply the caller's RLS instead, and the directory would silently
-- return nothing for every user except themselves.

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

- [ ] **Step 2: Apply it and verify manually**

Run the file's contents in the Supabase project's SQL editor (dashboard → SQL Editor → paste → Run).

Then, still in the SQL editor, run:

```sql
SELECT * FROM public_profiles;
```

Expected: one row per user who has at least one `linked_wallets` row with `is_primary = true AND signature_verified = true`. Exactly 5 columns (`id, display_name, kyc_status, user_role, wallet_address`) - confirm `email` is not among them.

- [ ] **Step 3: Commit**

```bash
git add frontend/supabase/migrations/005_public_profiles_view.sql
git commit -m "feat: add public_profiles view for peer discovery"
```

---

### Task 2: Directory pure-logic library (TDD)

**Files:**
- Modify: `frontend/lib/supabase/types.ts` (add `PublicProfile` type)
- Create: `frontend/lib/directory.ts`
- Test: `frontend/lib/directory.test.ts`

**Interfaces:**
- Consumes: `PublicProfile` type added to `frontend/lib/supabase/types.ts` in this task.
- Produces (used by Task 3's API routes):
  - `normalizeSearchQuery(raw: string | null): string | null`
  - `buildLikePattern(query: string): string`
  - `normalizeWalletAddressParam(raw: string): string | null`
  - `type DirectoryProfile = { id: string; displayName: string | null; kycStatus: string; userRole: string | null; walletAddress: string }`
  - `shapeDirectoryProfile(row: PublicProfile): DirectoryProfile`
  - `mergeSearchResults(byName: PublicProfile[], byWallet: PublicProfile[], limit: number): DirectoryProfile[]`
  - `export type { PublicProfile as PublicProfileRow }` (re-exported for the test file and route handlers to reference without a second import path)

- [ ] **Step 1: Add the `PublicProfile` type**

Add to `frontend/lib/supabase/types.ts` (append at the end of the file):

```ts
export type PublicProfile = {
  id: string;
  display_name: string | null;
  kyc_status: string;
  user_role: string | null;
  wallet_address: string;
};
```

- [ ] **Step 2: Write the failing test file**

Create `frontend/lib/directory.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSearchQuery,
  buildLikePattern,
  normalizeWalletAddressParam,
  shapeDirectoryProfile,
  mergeSearchResults,
  type PublicProfileRow,
} from './directory.ts';

describe('normalizeSearchQuery', () => {
  it('returns null for null input', () => {
    assert.equal(normalizeSearchQuery(null), null);
  });
  it('returns null for empty string', () => {
    assert.equal(normalizeSearchQuery(''), null);
  });
  it('returns null for a single trimmed character', () => {
    assert.equal(normalizeSearchQuery(' a '), null);
  });
  it('trims and returns strings of 2+ characters', () => {
    assert.equal(normalizeSearchQuery('  ali  '), 'ali');
  });
  it('returns null when trimming drops the length below 2 characters', () => {
    assert.equal(normalizeSearchQuery(' a  '), null);
  });
});

describe('buildLikePattern', () => {
  it('wraps the query in wildcards', () => {
    assert.equal(buildLikePattern('ali'), '%ali%');
  });
  it('escapes literal percent signs', () => {
    assert.equal(buildLikePattern('50%'), '%50\\%%');
  });
  it('escapes literal underscores', () => {
    assert.equal(buildLikePattern('a_b'), '%a\\_b%');
  });
  it('escapes literal backslashes', () => {
    assert.equal(buildLikePattern('a\\b'), '%a\\\\b%');
  });
});

describe('normalizeWalletAddressParam', () => {
  it('lowercases a valid mixed-case address', () => {
    assert.equal(
      normalizeWalletAddressParam('0xAbC1230000000000000000000000000000dEaD'),
      '0xabc1230000000000000000000000000000dead',
    );
  });
  it('rejects a value missing the 0x prefix', () => {
    assert.equal(normalizeWalletAddressParam('abc1230000000000000000000000000000dead'), null);
  });
  it('rejects a value of the wrong length', () => {
    assert.equal(normalizeWalletAddressParam('0xabc123'), null);
  });
  it('rejects non-hex characters', () => {
    assert.equal(normalizeWalletAddressParam('0xzzz1230000000000000000000000000000dead'), null);
  });
});

describe('shapeDirectoryProfile', () => {
  it('converts a snake_case row to camelCase', () => {
    const row: PublicProfileRow = {
      id: 'user-1',
      display_name: 'Alice',
      kyc_status: 'APPROVED',
      user_role: 'borrower',
      wallet_address: '0xabc1230000000000000000000000000000dead',
    };
    assert.deepEqual(shapeDirectoryProfile(row), {
      id: 'user-1',
      displayName: 'Alice',
      kycStatus: 'APPROVED',
      userRole: 'borrower',
      walletAddress: '0xabc1230000000000000000000000000000dead',
    });
  });
  it('passes through a null display name and null role', () => {
    const row: PublicProfileRow = {
      id: 'user-2',
      display_name: null,
      kyc_status: 'NOT_STARTED',
      user_role: null,
      wallet_address: '0xdead000000000000000000000000000000beef',
    };
    const shaped = shapeDirectoryProfile(row);
    assert.equal(shaped.displayName, null);
    assert.equal(shaped.userRole, null);
  });
});

describe('mergeSearchResults', () => {
  const alice: PublicProfileRow = {
    id: 'u1', display_name: 'Alice', kyc_status: 'APPROVED', user_role: 'borrower',
    wallet_address: '0x1111111111111111111111111111111111111a',
  };
  const bob: PublicProfileRow = {
    id: 'u2', display_name: 'Bob', kyc_status: 'APPROVED', user_role: 'lender',
    wallet_address: '0x2222222222222222222222222222222222222b',
  };

  it('deduplicates a row that matched both queries by id', () => {
    const result = mergeSearchResults([alice], [alice], 20);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'u1');
  });
  it('sorts by display name', () => {
    const result = mergeSearchResults([bob], [alice], 20);
    assert.deepEqual(result.map((r) => r.id), ['u1', 'u2']);
  });
  it('respects the limit after merging', () => {
    const result = mergeSearchResults([alice], [bob], 1);
    assert.equal(result.length, 1);
  });
  it('returns camelCase shapes, not raw rows', () => {
    const result = mergeSearchResults([alice], [], 20);
    assert.equal(result[0].displayName, 'Alice');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && node --test lib/directory.test.ts`
Expected: FAIL - `Cannot find module './directory.ts'` (the file does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `frontend/lib/directory.ts`:

```ts
import type { PublicProfile } from './supabase/types.ts';

export type { PublicProfile as PublicProfileRow } from './supabase/types.ts';

export type DirectoryProfile = {
  id: string;
  displayName: string | null;
  kycStatus: string;
  userRole: string | null;
  walletAddress: string;
};

const WALLET_ADDRESS_RE = /^0x[a-f0-9]{40}$/;

/** Returns the trimmed query, or null if it is under 2 characters (too short to search). */
export function normalizeSearchQuery(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length >= 2 ? trimmed : null;
}

/** Escapes ILIKE wildcard/escape characters and wraps the query for a substring match. */
export function buildLikePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Lowercases and validates a route-param wallet address. Returns null if malformed. */
export function normalizeWalletAddressParam(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  return WALLET_ADDRESS_RE.test(trimmed) ? trimmed : null;
}

export function shapeDirectoryProfile(row: PublicProfile): DirectoryProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    kycStatus: row.kyc_status,
    userRole: row.user_role,
    walletAddress: row.wallet_address,
  };
}

/**
 * Merges two row sets (a display-name match and a wallet-address match),
 * dedupes by id, sorts by display name, and caps the result at `limit`.
 */
export function mergeSearchResults(
  byName: PublicProfile[],
  byWallet: PublicProfile[],
  limit: number,
): DirectoryProfile[] {
  const byId = new Map<string, PublicProfile>();
  for (const row of [...byName, ...byWallet]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return Array.from(byId.values())
    .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''))
    .slice(0, limit)
    .map(shapeDirectoryProfile);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && node --test lib/directory.test.ts`
Expected: PASS, all `describe` blocks green, 0 failures.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/supabase/types.ts frontend/lib/directory.ts frontend/lib/directory.test.ts
git commit -m "feat: add directory search/lookup pure logic with tests"
```

---

### Task 3: Directory API routes

**Files:**
- Create: `frontend/app/api/directory/search/route.ts`
- Create: `frontend/app/api/directory/[walletAddress]/route.ts`
- Test: none automated (Next.js route handlers use `next/headers`, which requires a request context this repo has no harness for - every existing route in `app/api/` is verified the same way, manually). Verified manually below.

**Interfaces:**
- Consumes: `normalizeSearchQuery`, `buildLikePattern`, `mergeSearchResults`, `normalizeWalletAddressParam`, `shapeDirectoryProfile`, `type PublicProfileRow` from `../../../../lib/directory` (Task 2). `getSessionUser` from `../../../../lib/auth` (existing).
- Produces:
  - `GET /api/directory/search?q=<term>` → `{ results: DirectoryProfile[] }` on success, `{ error }` with 401/500.
  - `GET /api/directory/[walletAddress]` → `{ profile: DirectoryProfile }` on success, `{ error }` with 401/404/500.

- [ ] **Step 1: Write the search route**

Create `frontend/app/api/directory/search/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import {
  normalizeSearchQuery,
  buildLikePattern,
  mergeSearchResults,
  type PublicProfileRow,
} from '../../../../lib/directory';

const MAX_RESULTS = 20;
const SELECT_COLUMNS = 'id, display_name, kyc_status, user_role, wallet_address';

export async function GET(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const q = normalizeSearchQuery(req.nextUrl.searchParams.get('q'));
  if (!q) return NextResponse.json({ results: [] });

  const pattern = buildLikePattern(q);

  // The public_profiles view (migration 005) grants SELECT to the
  // authenticated role directly, so the RLS-scoped session client is
  // enough here. No admin/service-role client needed, matching migration
  // 002's goal that teammates can run the app without one.
  const [byName, byWallet] = await Promise.all([
    session.serverClient
      .from('public_profiles')
      .select(SELECT_COLUMNS)
      .neq('id', session.profile.id)
      .ilike('display_name', pattern)
      .limit(MAX_RESULTS),
    session.serverClient
      .from('public_profiles')
      .select(SELECT_COLUMNS)
      .neq('id', session.profile.id)
      .ilike('wallet_address', pattern)
      .limit(MAX_RESULTS),
  ]);

  if (byName.error || byWallet.error) {
    console.error('[GET /api/directory/search]', byName.error?.message ?? byWallet.error?.message);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }

  const results = mergeSearchResults(
    (byName.data ?? []) as PublicProfileRow[],
    (byWallet.data ?? []) as PublicProfileRow[],
    MAX_RESULTS,
  );

  return NextResponse.json({ results });
}
```

- [ ] **Step 2: Write the profile lookup route**

Create `frontend/app/api/directory/[walletAddress]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import {
  normalizeWalletAddressParam,
  shapeDirectoryProfile,
  type PublicProfileRow,
} from '../../../../lib/directory';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ walletAddress: string }> },
) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const { walletAddress } = await params;
  const normalized = normalizeWalletAddressParam(walletAddress);
  if (!normalized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Exact match against the lowercased column (linked_wallets.wallet_address
  // is stored lowercased on insert, see /api/wallets/verify), not ILIKE.
  const { data, error } = await session.serverClient
    .from('public_profiles')
    .select('id, display_name, kyc_status, user_role, wallet_address')
    .eq('wallet_address', normalized)
    .maybeSingle();

  if (error) {
    console.error('[GET /api/directory/[walletAddress]]', error.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }

  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ profile: shapeDirectoryProfile(data as PublicProfileRow) });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Verify manually against the running app**

Run: `cd frontend && npm run dev`

Sign in in the browser (any existing account with a verified wallet works for the search results to be non-empty; the signed-in account itself doesn't need one to *call* the endpoints). With that tab open, open the browser devtools console on any page of the app and run:

```js
fetch('/api/directory/search?q=a').then((r) => r.json()).then(console.log)
```

Expected: `{ results: [...] }` containing verified users whose display name or wallet address contains "a", case-insensitively, excluding yourself. Empty `q` or a 1-character `q` should return `{ results: [] }` without a network round trip mattering (still returns instantly):

```js
fetch('/api/directory/search?q=a').then((r) => r.json()).then(console.log)
fetch('/api/directory/[some verified wallet address from the result above]').then((r) => r.json()).then(console.log)
fetch('/api/directory/0x0000000000000000000000000000000000dead').then((r) => r.status)
```

Expected: the middle call returns `{ profile: { id, displayName, kycStatus, userRole, walletAddress } }`; the last returns `404`.

Also confirm signed-out behavior: open an incognito window to the dev server without logging in, open devtools, run the same `fetch('/api/directory/search?q=a')`. Expected: `401`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/api/directory
git commit -m "feat: add directory search and profile lookup API routes"
```

---

### Task 4: Extract shared `KycBadge`

**Files:**
- Create: `frontend/components/KycBadge.tsx`
- Modify: `frontend/app/settings/page.tsx:32-48` (remove the inline definition, add the import)
- Test: none automated (no component-testing infra in this repo). Verified manually below.

**Interfaces:**
- Produces (used by Task 6 and Task 7): `KycBadge({ status: string }): JSX.Element`, imported as `import { KycBadge } from '../components/KycBadge'` (or the appropriately relative path).

- [ ] **Step 1: Create the shared component**

Create `frontend/components/KycBadge.tsx`:

```tsx
'use client';

import { kycStatusLabel } from '../lib/kyc';

const COLOR_MAP: Record<string, string> = {
  APPROVED: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  PENDING: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  REJECTED: 'bg-red-500/20 text-red-400 border-red-500/30',
  MANUAL_REVIEW: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  NOT_STARTED: 'bg-slate-500/20 text-slate-400 border-slate-700',
  EXPIRED: 'bg-slate-500/20 text-slate-400 border-slate-700',
};

export function KycBadge({ status }: { status: string }) {
  const cls = COLOR_MAP[status] ?? COLOR_MAP.NOT_STARTED;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${cls}`}>
      {status === 'APPROVED' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {kycStatusLabel(status)}
    </span>
  );
}
```

- [ ] **Step 2: Wire it into the settings page**

In `frontend/app/settings/page.tsx`, remove the inline `KycBadge` function (currently lines 32-48):

```tsx
function KycBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    APPROVED: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    PENDING: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    REJECTED: 'bg-red-500/20 text-red-400 border-red-500/30',
    MANUAL_REVIEW: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    NOT_STARTED: 'bg-slate-500/20 text-slate-400 border-slate-700',
    EXPIRED: 'bg-slate-500/20 text-slate-400 border-slate-700',
  };
  const cls = colorMap[status] ?? colorMap.NOT_STARTED;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${cls}`}>
      {status === 'APPROVED' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {kycStatusLabel(status)}
    </span>
  );
}
```

Replace the file's existing import line:

```tsx
import { kycStatusLabel } from '../../lib/kyc';
```

with:

```tsx
import { KycBadge } from '../../components/KycBadge';
```

(The rest of `settings/page.tsx` already calls `<KycBadge status={...} />` the same way, so no other changes are needed in that file. `kycStatusLabel` is no longer used directly in this file once the inline definition is gone; if `tsc`/`eslint` in Step 3 flags anything else importing it, leave those alone, that import is only being replaced, not removed elsewhere.)

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Verify manually**

Run: `cd frontend && npm run dev`, sign in, open `/settings`. Expected: the KYC status badge renders exactly as before (same colors, same pulsing dot on `APPROVED`) - this step should be a visual no-op.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/KycBadge.tsx frontend/app/settings/page.tsx
git commit -m "refactor: extract shared KycBadge component"
```

---

### Task 5: Read-only `PublicLoanSummary` component

**Files:**
- Create: `frontend/components/PublicLoanSummary.tsx`
- Test: none automated (wagmi-wired component, no component-testing infra). Verified manually below.

**Interfaces:**
- Consumes: `FACTORY_ABI`, `LOAN_ABI` from `../lib/loan-abi` (existing). `formatUsd`, `formatPercent` from `../lib/format` (existing).
- Produces (used by Task 7):

```ts
type PublicLoanSummaryProps = {
  mode: 'borrower' | 'lender';
  targetAddress: `0x${string}`;
  factoryAddress: string | undefined;
  chainId: number;
  ethPrice: number;
};
export function PublicLoanSummary(props: PublicLoanSummaryProps): JSX.Element;
```

- [ ] **Step 1: Write the component**

Create `frontend/components/PublicLoanSummary.tsx`:

```tsx
'use client';

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { FACTORY_ABI, LOAN_ABI } from '../lib/loan-abi';
import { formatUsd, formatPercent } from '../lib/format';

const POLL_MS = 5_000;

type LoanTermsTuple = {
  loanContract: `0x${string}`;
  borrower: `0x${string}`;
  principalAmount: bigint;
  collateralAmount: bigint;
  durationDays: bigint;
  interestBps: bigint;
  maxLtvBps: bigint;
  liquidationBufferBps: bigint;
  createdAt: bigint;
};

type Props = {
  mode: 'borrower' | 'lender';
  targetAddress: `0x${string}`;
  factoryAddress: string | undefined;
  chainId: number;
  ethPrice: number;
};

/**
 * Read-only counterpart to BorrowerLoansSection / LenderDashboard: shows a
 * looked-up user's open loan requests (Requested status, borrower mode) or
 * active funded positions (Funded status, lender mode). No fund, repay, or
 * liquidate actions, since those only make sense for the connected wallet's
 * own loans, never someone else's.
 *
 * Mirrors the multi-round read pattern those two components already use
 * (getLoanIds -> loans(id) -> status/lender per contract, joined back by
 * address so the result-array indices can never drift from loanIds), just
 * parameterized by an arbitrary target address instead of useAccount().
 */
export function PublicLoanSummary({ mode, targetAddress, factoryAddress, chainId, ethPrice }: Props) {
  const isDeployed = Boolean(
    factoryAddress &&
      factoryAddress !== '0xYourLocalLoanFactoryAddress' &&
      factoryAddress !== '0xYourSepoliaLoanFactoryAddress',
  );

  const { data: loanIds, isLoading: idsLoading } = useReadContract({
    address: isDeployed ? (factoryAddress as `0x${string}`) : undefined,
    abi: FACTORY_ABI,
    functionName: 'getLoanIds',
    chainId,
    query: { refetchInterval: POLL_MS },
  });

  const termsContracts = useMemo(
    () =>
      (loanIds ?? []).map((id) => ({
        address: factoryAddress as `0x${string}`,
        abi: FACTORY_ABI,
        functionName: 'loans' as const,
        args: [id] as const,
        chainId,
      })),
    [loanIds, factoryAddress, chainId],
  );

  const { data: termsResults, isLoading: termsLoading } = useReadContracts({
    contracts: termsContracts,
    query: { enabled: termsContracts.length > 0, refetchInterval: POLL_MS },
  });

  const loanContractAddresses = useMemo(
    () =>
      (termsResults ?? []).map((r) =>
        r.status === 'success' ? (r.result as LoanTermsTuple).loanContract : undefined,
      ),
    [termsResults],
  );

  const statusContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'status' as const, chainId })),
    [loanContractAddresses, chainId],
  );

  const lenderContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'lender' as const, chainId })),
    [loanContractAddresses, chainId],
  );

  const { data: statusResults } = useReadContracts({
    contracts: statusContracts,
    query: { enabled: statusContracts.length > 0, refetchInterval: POLL_MS },
  });

  const { data: lenderResults } = useReadContracts({
    contracts: lenderContracts,
    query: { enabled: lenderContracts.length > 0, refetchInterval: POLL_MS },
  });

  // Address-keyed maps so statusResults/lenderResults indices never drift
  // from loanIds indices, matching the pattern in LenderDashboard.tsx.
  const statusByAddress = useMemo(() => {
    const map = new Map<string, number>();
    statusContracts.forEach((c, i) => {
      const r = statusResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), Number(r.result as unknown as bigint));
    });
    return map;
  }, [statusContracts, statusResults]);

  const lenderByAddress = useMemo(() => {
    const map = new Map<string, `0x${string}`>();
    lenderContracts.forEach((c, i) => {
      const r = lenderResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as `0x${string}`);
    });
    return map;
  }, [lenderContracts, lenderResults]);

  const matchingLoans = useMemo(() => {
    if (!loanIds || !termsResults) return [];
    const wantedStatus = mode === 'borrower' ? 0 : 1;
    return loanIds
      .map((id, i) => {
        const r = termsResults[i];
        if (r?.status !== 'success') return null;
        const terms = r.result as LoanTermsTuple;
        const addrKey = terms.loanContract.toLowerCase();
        if (statusByAddress.get(addrKey) !== wantedStatus) return null;
        if (mode === 'borrower') {
          if (terms.borrower.toLowerCase() !== targetAddress.toLowerCase()) return null;
        } else {
          const lenderAddr = lenderByAddress.get(addrKey);
          if (lenderAddr?.toLowerCase() !== targetAddress.toLowerCase()) return null;
        }
        return { id, terms };
      })
      .filter((l): l is { id: bigint; terms: LoanTermsTuple } => l !== null);
  }, [loanIds, termsResults, statusByAddress, lenderByAddress, mode, targetAddress]);

  const isLoading = idsLoading || termsLoading;

  if (!isDeployed) {
    return <p className="text-xs text-slate-600">Contracts not configured.</p>;
  }

  if (isLoading) {
    return <p className="text-xs text-slate-600">Loading...</p>;
  }

  if (matchingLoans.length === 0) {
    return (
      <p className="text-xs text-slate-600">
        {mode === 'borrower' ? 'No open requests.' : 'No active positions.'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {matchingLoans.map(({ id, terms }) => {
        const principalEth = parseFloat(formatEther(terms.principalAmount));
        const collateralEth = parseFloat(formatEther(terms.collateralAmount));
        const principalUsd = ethPrice > 0 ? principalEth * ethPrice : null;
        const aprPct = Number(terms.interestBps) / 10_000;
        const maxLtvPct = Number(terms.maxLtvBps) / 10_000;

        return (
          <div
            key={id.toString()}
            className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-slate-600">#{id.toString()}</span>
              <span className="text-[10px] font-bold text-slate-500">
                {mode === 'borrower' ? 'Open request' : 'Active position'}
              </span>
            </div>
            <p className="text-sm font-mono font-bold text-white">
              {principalEth.toFixed(4)} ETH
              {principalUsd !== null && (
                <span className="text-slate-500 font-normal"> ({formatUsd(principalUsd)})</span>
              )}
            </p>
            <p className="text-[11px] text-slate-500">
              {formatPercent(aprPct)} APR, {Number(terms.durationDays)}d term, max {formatPercent(maxLtvPct)} LTV, {collateralEth.toFixed(4)} ETH collateral
            </p>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Read-through check**

This component has no page to render it in yet; it is not mounted anywhere until Task 7. There is nothing to run beyond Step 2's typecheck. Re-read the component against `LenderDashboard.tsx`'s Round 1-3 read pattern (`getLoanIds` -> `loans(id)` -> `status`/`lender` per contract, joined back through address-keyed maps) and confirm every field name and status integer used here (`0` = Requested, `1` = Funded) matches that existing component exactly. Full behavioral verification (does it actually render the right loans for a real target address, with no action buttons) happens in Task 7's manual verification, where this component gets mounted twice against real on-chain data.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/PublicLoanSummary.tsx
git commit -m "feat: add read-only PublicLoanSummary component"
```

---

### Task 6: `/directory` search page

**Files:**
- Create: `frontend/app/directory/page.tsx`
- Test: none automated. Verified manually below.

**Interfaces:**
- Consumes: `useCompliance` from `../../hooks/useCompliance` (existing). `KycBadge` from `../../components/KycBadge` (Task 4). `GET /api/directory/search` (Task 3).

- [ ] **Step 1: Write the page**

Create `frontend/app/directory/page.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCompliance } from '../../hooks/useCompliance';
import { KycBadge } from '../../components/KycBadge';
import { Search, ArrowLeft } from 'lucide-react';

type SearchResult = {
  id: string;
  displayName: string | null;
  kycStatus: string;
  userRole: string | null;
  walletAddress: string;
};

const ROLE_LABEL: Record<string, string> = {
  borrower: 'Borrower',
  lender: 'Lender',
  both: 'Borrower & Lender',
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function DirectoryPage() {
  const router = useRouter();
  const compliance = useCompliance();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (compliance.isLoading) return;
    if (!compliance.data?.authenticated) router.replace('/');
  }, [compliance.isLoading, compliance.data, router]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }

    setIsSearching(true);
    setSearchError(null);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/directory/search?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        setResults(data.results ?? []);
      } catch {
        setSearchError('Search failed. Try again.');
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  if (compliance.isLoading || !compliance.data?.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/app" className="text-slate-500 hover:text-white transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-black text-white">Find a user</h1>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-600" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by display name or wallet address"
            className="w-full h-11 pl-10 pr-4 rounded-xl border border-slate-800 bg-slate-900/50 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/60"
            autoFocus
          />
        </div>

        {isSearching && <p className="text-xs text-slate-600">Searching...</p>}

        {searchError && <p className="text-xs text-red-400">{searchError}</p>}

        {!isSearching && !searchError && query.trim().length >= 2 && results.length === 0 && (
          <p className="text-xs text-slate-600">No verified users found for &quot;{query.trim()}&quot;.</p>
        )}

        <div className="space-y-2">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => router.push(`/directory/${r.walletAddress}`)}
              className="w-full flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-left hover:border-emerald-500/40 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-white truncate">
                  {r.displayName ?? shortAddress(r.walletAddress)}
                </p>
                <p className="text-[11px] font-mono text-slate-500">{shortAddress(r.walletAddress)}</p>
              </div>
              <KycBadge status={r.kycStatus} />
              {r.userRole && (
                <span className="text-[10px] font-bold text-slate-500 border border-slate-700 px-2 py-1 rounded-full flex-shrink-0">
                  {ROLE_LABEL[r.userRole] ?? r.userRole}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Verify manually**

Run: `cd frontend && npm run dev`, sign in, navigate to `/directory`.

Expected:
- Page loads with just the search box, no results, no error.
- Typing 1 character shows nothing (no request fires - confirm in the Network tab).
- Typing 2+ characters that match an existing verified user's display name or wallet fires one debounced request (~300ms after you stop typing) and shows a result row with name/wallet/KYC badge/role badge.
- Typing something that matches nobody shows the "No verified users found" message.
- Clicking a result navigates to `/directory/<their wallet address>` (this page doesn't exist until Task 7 - a 404 here is expected and fine for this task).
- Signed out (incognito, no login): navigating to `/directory` redirects to `/`.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/directory/page.tsx
git commit -m "feat: add /directory search page"
```

---

### Task 7: `/directory/[walletAddress]` profile page and nav link

**Files:**
- Create: `frontend/app/directory/[walletAddress]/page.tsx`
- Modify: `frontend/app/app/page.tsx:401-407` (add the "Find a user" link right after the existing "Change role" link)
- Test: none automated. Verified manually below.

**Interfaces:**
- Consumes: `useCompliance` (existing), `useTokenPrices` from `../../../hooks/useTokenPrices` (existing), `KycBadge` (Task 4), `PublicLoanSummary` (Task 5), `GET /api/directory/[walletAddress]` (Task 3).

- [ ] **Step 1: Write the profile page**

Create `frontend/app/directory/[walletAddress]/page.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useCompliance } from '../../../hooks/useCompliance';
import { useTokenPrices } from '../../../hooks/useTokenPrices';
import { KycBadge } from '../../../components/KycBadge';
import { PublicLoanSummary } from '../../../components/PublicLoanSummary';
import { ArrowLeft, ExternalLink, Copy } from 'lucide-react';

type DirectoryProfile = {
  id: string;
  displayName: string | null;
  kycStatus: string;
  userRole: string | null;
  walletAddress: string;
};

const ROLE_LABEL: Record<string, string> = {
  borrower: 'Borrower',
  lender: 'Lender',
  both: 'Borrower & Lender',
};

export default function DirectoryProfilePage() {
  const router = useRouter();
  const params = useParams<{ walletAddress: string }>();
  const compliance = useCompliance();
  const { data: priceData } = useTokenPrices();
  const ethPrice = priceData?.prices?.['ETH'] ?? priceData?.prices?.['ethereum'] ?? 0;

  useEffect(() => {
    if (compliance.isLoading) return;
    if (!compliance.data?.authenticated) router.replace('/');
  }, [compliance.isLoading, compliance.data, router]);

  const { data: profile, isLoading: profileLoading, error } = useQuery<DirectoryProfile>({
    queryKey: ['directory-profile', params.walletAddress],
    queryFn: async () => {
      const res = await fetch(`/api/directory/${params.walletAddress}`);
      if (res.status === 404) throw new Error('NOT_FOUND');
      if (!res.ok) throw new Error('LOAD_FAILED');
      const data = await res.json();
      return data.profile as DirectoryProfile;
    },
    enabled: Boolean(params.walletAddress) && Boolean(compliance.data?.authenticated),
    retry: false,
  });

  const networkMode: 'local' | 'testnet' =
    (process.env.NEXT_PUBLIC_NETWORK_MODE as 'local' | 'testnet') ?? 'testnet';
  const factoryAddress =
    networkMode === 'testnet'
      ? process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA
      : process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL;
  const chainId = networkMode === 'testnet' ? 11155111 : 31337;

  if (compliance.isLoading || !compliance.data?.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/directory" className="text-slate-500 hover:text-white transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-black text-white">User profile</h1>
        </div>

        {profileLoading && <p className="text-xs text-slate-600">Loading...</p>}

        {error && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-8 text-center">
            <p className="text-sm font-bold text-slate-400">User not found or not verified.</p>
          </div>
        )}

        {profile && (
          <>
            <div className="rounded-2xl border border-slate-800 bg-[#111827] p-5 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-base font-black text-white">{profile.displayName ?? 'Unnamed user'}</p>
                <KycBadge status={profile.kycStatus} />
                {profile.userRole && (
                  <span className="text-[10px] font-bold text-slate-500 border border-slate-700 px-2 py-1 rounded-full">
                    {ROLE_LABEL[profile.userRole] ?? profile.userRole}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                <span>{profile.walletAddress}</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(profile.walletAddress)}
                  className="text-slate-600 hover:text-white transition-colors"
                  title="Copy address"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <a
                  href={`https://sepolia.etherscan.io/address/${profile.walletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-600 hover:text-white transition-colors"
                  title="View on Etherscan"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>

            {(profile.userRole === 'borrower' || profile.userRole === 'both') && (
              <div>
                <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                  Open loan requests
                </p>
                <PublicLoanSummary
                  mode="borrower"
                  targetAddress={profile.walletAddress as `0x${string}`}
                  factoryAddress={factoryAddress}
                  chainId={chainId}
                  ethPrice={ethPrice}
                />
              </div>
            )}

            {(profile.userRole === 'lender' || profile.userRole === 'both') && (
              <div>
                <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                  Active positions
                </p>
                <PublicLoanSummary
                  mode="lender"
                  targetAddress={profile.walletAddress as `0x${string}`}
                  factoryAddress={factoryAddress}
                  chainId={chainId}
                  ethPrice={ethPrice}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the nav link**

In `frontend/app/app/page.tsx`, immediately after the existing "Change role" link (currently lines 401-407):

```tsx
          <Link
            href="/settings#role"
            className="text-xs font-bold text-slate-600 hover:text-white transition-colors"
            title="Switch between Borrow, Lend or Both"
          >
            Change role
          </Link>
```

add:

```tsx
          <Link
            href="/directory"
            className="text-xs font-bold text-slate-600 hover:text-white transition-colors"
            title="Search for another verified user"
          >
            Find a user
          </Link>
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Verify manually**

Run: `cd frontend && npm run dev`, sign in, and on `/app` confirm the "Find a user" link appears next to "Change role" and navigates to `/directory`.

From `/directory`, search for a verified user (a second test account with a linked+verified wallet, role set, and at least one loan created in earlier Phase 1 testing works well here) and click their result.

Expected on `/directory/<their wallet>`:
- Their display name (or "Unnamed user" if they never set one), KYC badge, and role badge render.
- Their full wallet address shows with a working copy button and a working Etherscan link.
- If their role is `borrower` or `both`: an "Open loan requests" section shows any of their loans currently in `Requested` status, with no fund/repay/liquidate buttons anywhere on the page.
- If their role is `lender` or `both`: an "Active positions" section shows any loans they have funded that are currently `Funded`.
- If they have no matching loans for a shown section, that section reads "No open requests." / "No active positions." instead of erroring.
- Navigating to `/directory/0x0000000000000000000000000000000000dead` (a wallet nobody has linked) shows "User not found or not verified."
- Signed out (incognito): visiting `/directory/<any wallet>` redirects to `/`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/directory frontend/app/app/page.tsx
git commit -m "feat: add directory profile page and nav link"
```

---

### Task 8: Manual regression checklist

**Files:**
- Modify: `tests/MANUAL_TEST_PLAN.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Add a new track**

In `tests/MANUAL_TEST_PLAN.md`, insert a new section immediately before the `## Findings log` heading (currently line 202):

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add tests/MANUAL_TEST_PLAN.md
git commit -m "test: add peer discovery regression track"
```

---

## Plan Self-Review

**Spec coverage:**
- Data layer / RLS approach (view, not a raw policy, not admin-only) → Task 1.
- Search API + matching rules (partial, case-insensitive, 2-char minimum, 20-result cap, excludes self) → Task 2 + Task 3.
- Profile lookup API + same-404-either-way → Task 3.
- Shared `KycBadge` → Task 4.
- `/directory` page, empty-until-2-chars, debounced → Task 6.
- `/directory/[walletAddress]` page, badges, wallet + Etherscan link → Task 7.
- Read-only loan summary (open requests / active positions, no action buttons) → Task 5, wired in Task 7.
- Nav entry point → Task 7, Step 2.
- Not-signed-in redirect, unverified/unknown wallet handling, empty-loans state → Task 6 and Task 7 manual verification steps.
- Out-of-scope items from the spec (closed loan history, messaging, pagination, contract changes) are not present anywhere in this plan - confirmed no task touches them.

**Placeholder scan:** No TBD/TODO markers. Every code step has complete, runnable code. Every manual-verification step names exact URLs, exact console commands, and exact expected results rather than "test it works."

**Type consistency:** `DirectoryProfile` (Task 2) is used verbatim by name in Task 3's route handlers and as the inline `SearchResult` / `DirectoryProfile` shape in Task 6/7's pages (the frontend pages redeclare the same shape locally rather than importing Task 2's type, since `lib/directory.ts` is a server-only-safe module but nothing stops a client component from importing it - redeclaring keeps the pages' JSON contract explicit and independent of a server lib's internals, matching how this codebase already redeclares row shapes per component, e.g. `LoanTermsTuple` is redefined in both `BorrowerLoansSection.tsx` and `LenderDashboard.tsx` rather than shared). Field names (`id`, `displayName`, `kycStatus`, `userRole`, `walletAddress`) match exactly across Task 2, Task 3, Task 6, and Task 7. `PublicLoanSummary`'s prop names (`mode`, `targetAddress`, `factoryAddress`, `chainId`, `ethPrice`) match exactly between its Task 5 definition and its Task 7 call sites. Loan status integers (0 = Requested/open, 1 = Funded/active) match the enum already used throughout `LenderDashboard.tsx` and `BorrowerLoansSection.tsx`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-03-peer-discovery.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
