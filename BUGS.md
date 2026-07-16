# Bug Report — NexusFi P2P Lending Platform

Reviewed: 2026-05-16  
Scope: all Solidity contracts, Next.js frontend, API routes, and library utilities.

Severity levels: **CRITICAL** (exploit or data loss) → **HIGH** (broken feature or security gap) → **MEDIUM** (incorrect behavior) → **LOW** (quality / edge case).

---

## CRITICAL

### BUG-01 — Lender can liquidate any funded loan at any time
**File:** `contracts/contracts/Loan.sol:123-129`

```solidity
function markLiquidatedForDemo() external onlyLender nonReentrant {
    require(status == LoanStatus.Funded, "Loan: not active");
    status = LoanStatus.Liquidated;
    ICollateralVault(collateralVault).liquidateCollateral(loanId, payable(lender));
    emit LoanLiquidated(loanId, msg.sender);
}
```

**Problem:** There is no check on loan maturity, elapsed time, or current collateral value. A lender can call this the moment after funding — stealing the borrower's collateral while the borrower still holds the full principal. There is no oracle feed or LTV threshold guard whatsoever.

**Fix:** Add a `block.timestamp > fundedAt + durationDays * 1 days` time guard at minimum, or a proper oracle-based LTV check before allowing liquidation.

---

### BUG-02 — KYC is never enforced — any authenticated user can borrow
**File:** `frontend/hooks/useCompliance.ts:29-31`

```ts
// KYC not required to borrow — any authenticated user with a connected wallet can borrow.
canBorrow: true,
```

**Problem:** `canBorrow` is unconditionally `true` for every signed-in user. KYC status (`user.kycStatus`) is fetched and available but never checked before granting access to the borrowing desk. The entire onboarding KYC step is bypassed.

**Fix:** Change `canBorrow` to check `data.user?.kycStatus === 'APPROVED'` (and optionally `hasVerifiedWallet`).

---

## HIGH

### BUG-03 — Integer division truncates interest to 0 for small or short loans
**File:** `contracts/contracts/Loan.sol:131-133`

```solidity
function interestDue() public view returns (uint256) {
    return (principalAmount * interestBps * durationDays) / (10_000 * 365);
}
```

**Problem:** Solidity integer division truncates toward zero. For a loan of `1 wei` principal at 800 bps for 1 day: `(1 × 800 × 1) / 3_650_000 = 0`. Any loan where `principalAmount × interestBps × durationDays < 3_650_000` will charge zero interest. More importantly, the formula has no accumulation of actual elapsed time — it uses `durationDays` even if the loan is repaid early, so interest is fixed at origination rather than accruing.

**Fix:** Use a higher-precision intermediate (e.g., multiply by `1e18` before dividing, or use a fixed-point library). Consider accruing interest based on elapsed time: `block.timestamp - fundedAt`.

---

### BUG-04 — Hardcoded localhost RPC URL
**File:** `frontend/app/page.tsx:471`

```ts
const response = await fetch('http://127.0.0.1:8545', {
```

**Problem:** The `fundLocalWallet` function hard-codes the Hardhat node URL instead of reading from `process.env.NEXT_PUBLIC_RPC_URL_LOCAL`. If the RPC port differs in a team member's environment or is proxied, funding always fails silently.

**Fix:** Replace with `resolveRpcUrl('local') ?? 'http://127.0.0.1:8545'` from `lib/network.ts`.

---

### BUG-05 — Wallet suffix spoofing bypasses KYT risk check
**File:** `frontend/lib/wallet-screening.ts:33-35`

```ts
const suffix = normalized.slice(-4);
if (suffix === '1111') return DEMO_RISK_WALLETS['111...'];   // always LOW
if (suffix === '2222') return DEMO_RISK_WALLETS['222...'];   // always MEDIUM
if (suffix === '3333') return DEMO_RISK_WALLETS['333...'];   // always HIGH
```

**Problem:** Any wallet whose last 4 hex characters are `1111` is permanently classified as `LOW` risk (score 15), regardless of its full address. A malicious actor who generates a vanity address ending in `1111` automatically passes screening. Even without the suffix shortcuts, the fallback hash (`charCodeAt` sum mod 100) is deterministic and easily pre-computed.

**Fix:** This is a known demo limitation, but it must be replaced with a real KYT API (Chainalysis, TRM Labs) before production. At minimum, document clearly that this check confers no real security.

---

### BUG-06 — `update()` throws if wallet record doesn't exist during verify
**File:** `frontend/app/api/wallets/verify/route.ts:55-67`

```ts
const wallet = await prisma.linkedWallet.update({
    where: {
      walletAddress_chainId: { walletAddress: normalized, chainId: Number(chainId) },
    },
    data: { signatureVerified: true, verifiedAt: new Date(), isPrimary: Boolean(setPrimary) },
});
```

**Problem:** `prisma.update()` throws `P2025 Record not found` if the wallet was never created in the nonce step (e.g., a client that POSTs directly to `/verify` without calling `/nonce` first, or if the nonce transaction rolled back). This is an unhandled exception — Next.js returns a 500 with no structured error body.

**Fix:** Use `prisma.linkedWallet.upsert()` here, or add a try-catch that returns `{ error: 'Wallet not registered', status: 404 }`.

---

### BUG-07 — Float precision error when computing collateral ETH for `parseEther`
**File:** `frontend/app/page.tsx:450`

```ts
value: parseEther(termSheet.requiredCollateralEth.toFixed(18)),
```

**Problem:** JavaScript `Number` (IEEE 754 double) has ~15–16 significant decimal digits. Calling `.toFixed(18)` pads the remaining digits with noise (e.g., `1.234567891234567890` becomes `1.234567891234568000` with garbage in the last digits). `parseEther` then converts those noisy digits to wei. The resulting collateral amount may be a few wei short, causing the `lockCollateral` call to revert if the Loan contract later uses strict equality.

**Fix:** Use `BigInt` arithmetic via `viem`'s `parseUnits` after rounding to 6 significant figures, e.g.:
```ts
value: parseEther(termSheet.requiredCollateralEth.toFixed(6)),
```

---

### BUG-08 — No funding deadline on loans
**File:** `contracts/contracts/Loan.sol:85-96`

**Problem:** A loan in `Requested` status can remain unfunded indefinitely. The borrower's collateral is locked in the vault forever until they cancel. There is no expiry timestamp forcing a cancel-or-fund decision.

**Fix:** Store `requestedAt` in the constructor and add a `require(block.timestamp <= requestedAt + FUNDING_WINDOW)` in `fund()`, with a `expire()` function callable by borrower after the window.

---

### BUG-09 — No repayment deadline — borrower can repay years late with no penalty
**File:** `contracts/contracts/Loan.sol:98-113`

**Problem:** The loan stays in `Funded` status forever. A borrower who doesn't repay on time faces no automated consequence — the lender must manually call `markLiquidatedForDemo()`. Late repayments pay the same fixed interest as on-time repayments (calculated at origination from `durationDays`).

**Fix:** Add elapsed-time interest accrual and a lender-callable `liquidateAfterMaturity()` that only triggers after `fundedAt + durationDays * 1 days`.

---

## MEDIUM

### BUG-10 — Redundant risk tier branches — `repaid >= 2` and `repaid >= 1` both return Tier A
**File:** `frontend/lib/borrower-risk.ts:96-103`

```ts
if (stats.repaid >= 2) {
    reasons.push(`${stats.repaid} repaid loans — qualifies for Tier A.`);
    return { tier: 'A', reasons };
}
if (stats.repaid >= 1) {
    reasons.push('At least one repaid loan — Tier A.');
    return { tier: 'A', reasons };
}
```

**Problem:** Both branches return the same tier (`A`). The intent was likely `>= 2 → A` and `>= 1 → B` (one repaid = acceptable track record, two = proven). As written, a borrower with a single repaid loan gets the same best tier as a veteran borrower with many repaid loans.

**Fix:** Change the `>= 1` branch to return `{ tier: 'B', ... }` or adjust thresholds to match product intent.

---

### BUG-11 — Race condition when inferring `createdLoanId` from `loanCount`
**File:** `frontend/app/page.tsx:347-352`

```ts
useEffect(() => {
    if (!isConfirmed || loanCount === undefined || loanCount === BigInt(0)) return;
    const newId = String(loanCount - BigInt(1));
    setCreatedLoanId(newId);
}, [isConfirmed, loanCount]);
```

**Problem:** The loan ID is inferred as `loanCount - 1` after confirmation. If two users create loans simultaneously (or the user creates a second loan in quick succession), the displayed ID may be off-by-one or point to another user's loan. The correct ID is returned in the transaction receipt log (`LoanCreated` event), not from `loanCount`.

**Fix:** Parse the `LoanCreated` event from the transaction receipt using `viem`'s `parseEventLogs`, or use the return value from `simulateContract` which includes `result`.

---

### BUG-12 — Nonce is generated but never stored or validated
**File:** `frontend/app/api/wallets/nonce/route.ts:17, 50`

```ts
const nonce = randomBytes(16).toString('hex');
// ...
return NextResponse.json({ message, nonce });
```

**Problem:** The nonce is generated and included in the sign-in message, but it is never persisted. The `/verify` endpoint doesn't compare the submitted message against any stored nonce. This means a replay attack is possible: a captured signature can be resubmitted to link any wallet to any account.

**Fix:** Store the nonce (and expiry) in the `LinkedWallet` row or a separate `PendingNonce` table. In `/verify`, check that the nonce matches and hasn't expired, then invalidate it.

---

### BUG-13 — URI in nonce message always uses `https://` — wrong for local dev
**File:** `frontend/app/api/wallets/nonce/route.ts:43-44`

```ts
const domain = new URL(req.url).host;
// ...
`URI: https://${domain}`,
```

**Problem:** In local development, `req.url` is `http://localhost:3000/api/...`, so `domain` is `localhost:3000`. The URI is then `https://localhost:3000`, which doesn't match the actual origin. Some wallet signing UIs display this URI and users or auditors will see a mismatch.

**Fix:** Use `new URL(req.url).origin` instead of constructing the URI manually:
```ts
`URI: ${new URL(req.url).origin}`,
```

---

### BUG-14 — `NormalizedLoan` type is missing the `liquidationBufferBps` field
**File:** `frontend/app/page.tsx:124-132`

```ts
type NormalizedLoan = {
    loanContract: `0x${string}`;
    borrower: `0x${string}`;
    principalAmount: bigint;
    collateralAmount: bigint;
    durationDays: bigint;
    interestBps: bigint;
    maxLtvBps: bigint;
    // liquidationBufferBps missing!
};
```

**Problem:** The `loans()` ABI output at index 7 is `liquidationBufferBps` but `normalizeLoanData` (line 149) discards it. The lender detail view cannot display the liquidation buffer for a fetched loan. Additionally, if the lender ever needs to verify collateral safety on the frontend, this data is unavailable.

**Fix:** Add `liquidationBufferBps: loan[7]` to the type and the `normalizeLoanData` return value.

---

### BUG-15 — Stale WBTC fallback price ($60,000) baked in
**File:** `frontend/app/api/prices/route.ts:37`

```ts
token.coingeckoId === 'wrapped-bitcoin' ? 60_000 : fallback
```

**Problem:** The fallback price for WBTC is hard-coded at $60,000. This value is embedded in source code and will become increasingly wrong over time. If CoinGecko is down, loan term sheets shown to users are silently calculated against a potentially far-off price, leading to incorrect collateral requirements.

**Fix:** Make all fallback prices env-var driven (`NEXT_PUBLIC_WBTC_USD_PRICE`, etc.), and clearly surface a "prices unavailable" warning to the user when the fallback is active.

---

### BUG-16 — `assignBaseRiskTier` skips adding reason message when tier is already C and tenor bumps it
**File:** `frontend/lib/borrower-risk.ts:133-138`

```ts
if (tenorDays >= LONG_TENOR_DAYS) {
    const before = tier;
    tier = stricterTier(tier);
    if (tier !== before) {         // ← never true when already at C
        reasons.push(`${tenorDays}-day tenor — one tier stricter.`);
    }
}
```

**Problem:** When a Tier C borrower requests a ≥ 90-day loan, `stricterTier('C')` returns `'C'` (capped). The `tier !== before` check is false, so no reason is added to the list. The borrower sees no explanation for why the tenor doesn't change their tier, which is confusing.

**Fix:** Add the reason regardless of whether the tier actually changed:
```ts
if (tenorDays >= LONG_TENOR_DAYS) {
    const before = tier;
    tier = stricterTier(tier);
    reasons.push(
        tier !== before
            ? `${tenorDays}-day tenor — one tier stricter.`
            : `${tenorDays}-day tenor — already at maximum risk (Tier C).`
    );
}
```

---

## LOW

### BUG-17 — Demo KYC endpoint has no admin or scope check
**File:** `frontend/app/api/kyc/demo-approve/route.ts:6-9`

```ts
if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_DEMO_KYC) {
    return NextResponse.json({ error: 'Not available' }, { status: 403 });
}
```

**Problem:** In `development` mode (or any non-`production` `NODE_ENV`), any authenticated session can self-approve KYC. A staging deployment with `NODE_ENV=development` would expose this to all test users. There is also no rate limit.

**Fix:** Gate on `ALLOW_DEMO_KYC=true` alone (irrespective of `NODE_ENV`) and restrict to admin emails or a separate admin session check.

---

### BUG-18 — `CollateralVault.setFactory()` is one-time with no upgrade path
**File:** `contracts/contracts/CollateralVault.sol:44-50`

```solidity
function setFactory(address newFactory) external onlyOwner {
    require(factory == address(0), "CollateralVault: factory already set");
    // ...
}
```

**Problem:** Once a factory is registered, it can never be updated. If a bug is found in `LoanFactory` and a new factory is deployed, a new `CollateralVault` must also be deployed, breaking all existing locked positions.

**Fix:** Remove the `factory == address(0)` guard and emit a `FactoryUpdated` event. Consider a two-step owner + timelock pattern for upgrades.

---

### BUG-19 — `useTokenUsdPrice` returns `0` silently when price is unavailable
**File:** `frontend/hooks/useTokenPrices.ts:28`

```ts
priceUsd: data?.prices[symbol] ?? 0,
```

**Problem:** If the price query is still loading or has errored, `priceUsd` is `0`. The dashboard (`page.tsx:258-261`) computes `loanAmountUsd = eth * ethUsdPrice`, which will be `0`, and the term sheet will be `null`. The user sees no loan terms with no indication of why. A `0` price could also cause division-by-zero in `requiredCollateralEth = ... / oraclePriceUsd`.

**Fix:** Expose `isLoading` and `error` from `useTokenUsdPrice` to callers, and block term sheet calculation + show an error banner when `isLoading` or `error` is set.

---

### BUG-20 — Factory address not validated in `Loan` constructor
**File:** `contracts/contracts/Loan.sol:72-73`

```solidity
factory = msg.sender;
```

**Problem:** The `factory` address is set to `msg.sender` with no validation that `msg.sender` is a legitimate `LoanFactory`. Any contract or EOA can deploy a `Loan` directly, set itself as factory, and produce a loan record that doesn't appear in the factory registry but has a valid `collateralVault` address. The vault's `onlyLoan` modifier only checks that the caller matches `positions[loanId].loanContract`, so a rogue loan contract that previously locked collateral via the real factory could still call `releaseCollateral`.

**Fix:** Pass the factory address as a constructor argument and add a check that it matches an expected interface, or restrict `CollateralVault.lockCollateral` more tightly.

---

### BUG-21 — No pagination for `getLoanIds()` — will degrade with scale
**File:** `contracts/contracts/LoanFactory.sol:90-92`

```solidity
function getLoanIds() external view returns (uint256[] memory) {
    return loanIds;
}
```

**Problem:** The entire `loanIds` array is returned in a single call. At thousands of loans, this will exceed the `eth_call` response size limit of many RPC providers and cause JSON-RPC timeouts. The `useBorrowerRisk` hook also calls this and loops over all returned IDs to find matching borrower addresses — O(n) with no caching.

**Fix:** Add pagination parameters (`offset`, `limit`) or use an event-based approach where the frontend indexes `LoanCreated` events via `getLogs`.

---

### BUG-22 — Wallet risk screening creates a new `WalletScreening` record on every verify
**File:** `frontend/app/api/wallets/verify/route.ts:31-39`

```ts
await prisma.walletScreening.create({
    data: { userId, walletAddress, riskScore, riskLevel, flags },
});
```

**Problem:** Each call to `/verify` unconditionally creates a new screening record. Re-verifying the same wallet (e.g., after a session expiry) accumulates duplicate screening rows. Query-time audits will see multiple records per wallet, and the most recent might disagree with the one used to accept/reject.

**Fix:** Use `upsert` on `(userId, walletAddress)` or only screen if no existing record exists.

---

## Summary Table

| ID | Severity | Location | Title |
|---|---|---|---|
| BUG-01 | CRITICAL | `Loan.sol:123` | Lender can liquidate at any time |
| BUG-02 | CRITICAL | `useCompliance.ts:30` | KYC never enforced — `canBorrow: true` hardcoded |
| BUG-03 | HIGH | `Loan.sol:131` | Interest truncates to 0 for small loans |
| BUG-04 | HIGH | `page.tsx:471` | Hardcoded localhost RPC URL |
| BUG-05 | HIGH | `wallet-screening.ts:33` | Wallet suffix spoofing bypasses KYT |
| BUG-06 | HIGH | `wallets/verify/route.ts:55` | `update()` throws if wallet not pre-registered |
| BUG-07 | HIGH | `page.tsx:450` | Float precision noise in `parseEther` call |
| BUG-08 | HIGH | `Loan.sol:85` | No funding deadline on Requested loans |
| BUG-09 | HIGH | `Loan.sol:98` | No repayment deadline — borrower can repay years late |
| BUG-10 | MEDIUM | `borrower-risk.ts:96` | Redundant tier branches — `>= 2` and `>= 1` both return A |
| BUG-11 | MEDIUM | `page.tsx:347` | Race condition inferring loan ID from `loanCount` |
| BUG-12 | MEDIUM | `wallets/nonce/route.ts:17` | Nonce never stored — replay attack possible |
| BUG-13 | MEDIUM | `wallets/nonce/route.ts:43` | URI forced to `https://` — wrong in local dev |
| BUG-14 | MEDIUM | `page.tsx:124` | `NormalizedLoan` missing `liquidationBufferBps` field |
| BUG-15 | MEDIUM | `api/prices/route.ts:37` | Stale WBTC fallback price ($60,000) in source |
| BUG-16 | MEDIUM | `borrower-risk.ts:133` | Silent tier bump when already at C — no reason emitted |
| BUG-17 | LOW | `kyc/demo-approve/route.ts:7` | Demo KYC has no admin check |
| BUG-18 | LOW | `CollateralVault.sol:44` | Factory is one-time-set with no upgrade path |
| BUG-19 | LOW | `useTokenPrices.ts:28` | Silent `0` price causes invisible term sheet failure |
| BUG-20 | LOW | `Loan.sol:72` | Factory address unvalidated in Loan constructor |
| BUG-21 | LOW | `LoanFactory.sol:90` | No pagination on `getLoanIds()` |
| BUG-22 | LOW | `wallets/verify/route.ts:31` | Duplicate `WalletScreening` rows on re-verify |
