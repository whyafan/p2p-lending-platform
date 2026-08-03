export type RiskTier = 'A' | 'B' | 'C';

export type RiskTierConfig = {
  label: string;
  borrowerRisk: string;
  maxLtv: number;
  aprSpread: number;
  liquidationBuffer: number;
  haircut: number;
  collateralRule: string;
};

/** Charged to every borrower regardless of tier; the tier only adds its spread. */
export const BASE_APR = 0.06;

/**
 * The whole pricing model. A tier maps to exactly these five numbers and nothing
 * else, which is what makes the terms reproducible: given a tier, anyone can derive
 * the same term sheet without access to the borrower's data.
 *
 * The four risk levers move together as risk rises: less can be borrowed against the
 * same collateral, the rate climbs, the liquidation buffer widens, and the collateral
 * itself is discounted before any of that is applied. Note that maxLtv, aprSpread and
 * liquidationBuffer are written into the Loan contract at creation, while haircut
 * never leaves the client: it shapes how much collateral is demanded up front rather
 * than anything the contract enforces afterwards.
 */
export const RISK_TIER_CONFIG: Record<RiskTier, RiskTierConfig> = {
  A: {
    label: 'Tier A',
    borrowerRisk: 'Low risk',
    maxLtv: 0.7,
    aprSpread: 0.02,
    liquidationBuffer: 0.1,
    haircut: 0,
    collateralRule: 'Flexible, high-quality collateral',
  },
  B: {
    label: 'Tier B',
    borrowerRisk: 'Medium risk',
    maxLtv: 0.6,
    aprSpread: 0.05,
    liquidationBuffer: 0.12,
    haircut: 0.05,
    collateralRule: 'Approved liquid collateral',
  },
  C: {
    label: 'Tier C',
    borrowerRisk: 'High risk',
    maxLtv: 0.5,
    aprSpread: 0.09,
    liquidationBuffer: 0.15,
    haircut: 0.1,
    collateralRule: 'Stablecoins only or strict collateral',
  },
};

export type LoanTermsInput = {
  riskTier: RiskTier;
  loanAmountUsd: number;
  tenorDays: number;
  collateralAmount: number;
  oraclePriceUsd: number;
};

export type LoanTermSheet = {
  riskTier: RiskTier;
  tierConfig: RiskTierConfig;
  collateralValueUsd: number;
  adjustedCollateralValueUsd: number;
  maxBorrowUsd: number;
  requiredCollateralValueUsd: number;
  requiredCollateralEth: number;
  finalApr: number;
  interestDueUsd: number;
  totalRepaymentUsd: number;
  initialLtv: number;
  liquidationThreshold: number;
  liquidationCollateralValueUsd: number;
  isWithinMaxBorrow: boolean;
  interestBps: number;
  maxLtvBps: number;
  liquidationBufferBps: number;
};

/**
 * Derive a full term sheet from a tier and a requested loan.
 *
 * Returns null rather than throwing on unusable input, because the caller is a live
 * form: every keystroke re-runs this, and a half-typed amount is an expected state,
 * not an error. A collateral amount of exactly 0 is allowed, since
 * calculateProtocolLoanTerms deliberately calls in that way.
 */
export function calculateLoanTerms(input: LoanTermsInput): LoanTermSheet | null {
  const { riskTier, loanAmountUsd, tenorDays, collateralAmount, oraclePriceUsd } = input;

  if (
    !Number.isFinite(loanAmountUsd) ||
    loanAmountUsd <= 0 ||
    !Number.isFinite(tenorDays) ||
    tenorDays <= 0 ||
    !Number.isFinite(collateralAmount) ||
    collateralAmount < 0 ||
    !Number.isFinite(oraclePriceUsd) ||
    oraclePriceUsd <= 0
  ) {
    return null;
  }

  const tier = RISK_TIER_CONFIG[riskTier];

  const collateralValueUsd = collateralAmount * oraclePriceUsd;
  // Haircut first, LTV second. Applying them in the other order would give the same
  // borrow limit but a different notion of what the collateral is "worth", and the
  // haircut is meant to be a discount on the asset, not a second cut on the loan.
  const adjustedCollateralValueUsd = collateralValueUsd * (1 - tier.haircut);
  const maxBorrowUsd = adjustedCollateralValueUsd * tier.maxLtv;
  // The inverse of the two lines above, collapsed: this is what the borrower must
  // post to support loanAmountUsd. Kept as its own factor so the division has a
  // single guarded denominator.
  const collateralFactor = tier.maxLtv * (1 - tier.haircut);
  const requiredCollateralValueUsd =
    collateralFactor > 0 ? loanAmountUsd / collateralFactor : 0;
  const requiredCollateralEth = requiredCollateralValueUsd / oraclePriceUsd;

  const finalApr = BASE_APR + tier.aprSpread;
  // Simple pro-rata interest over the tenor. The contract accrues continuously
  // instead, but the two agree exactly at the deadline, so this is the honest figure
  // to quote for a loan repaid on time and an upper bound for one repaid early.
  const interestDueUsd = loanAmountUsd * finalApr * (tenorDays / 365);
  const totalRepaymentUsd = loanAmountUsd + interestDueUsd;

  // Measured against the haircut collateral, not the raw value, so the LTV shown here
  // is the one that matters for the borrow limit above. The contract's currentLtvBps
  // has no haircut and so reads lower for tiers B and C; they answer different
  // questions, one about sizing at origination and one about live solvency.
  const initialLtv =
    adjustedCollateralValueUsd > 0 ? loanAmountUsd / adjustedCollateralValueUsd : 0;

  const liquidationThreshold = tier.maxLtv + tier.liquidationBuffer;
  // The collateral value at which the position would be liquidated, quoted so the
  // borrower can see how far the market has to move against them before it happens.
  const liquidationCollateralValueUsd =
    liquidationThreshold > 0 ? loanAmountUsd / liquidationThreshold : 0;

  // Epsilon because maxBorrowUsd is the product of three floats: a borrower who asks
  // for exactly the maximum the UI just quoted them would otherwise be rejected by a
  // rounding error in the last bit.
  const isWithinMaxBorrow = loanAmountUsd <= maxBorrowUsd + 1e-9;

  return {
    riskTier,
    tierConfig: tier,
    collateralValueUsd,
    adjustedCollateralValueUsd,
    maxBorrowUsd,
    requiredCollateralValueUsd,
    requiredCollateralEth,
    finalApr,
    interestDueUsd,
    totalRepaymentUsd,
    initialLtv,
    liquidationThreshold,
    liquidationCollateralValueUsd,
    isWithinMaxBorrow,
    // The only three fields that become createLoan() arguments. Rounded to integer
    // bps here rather than at the call site so the number in the term sheet the
    // borrower approved is byte for byte the number written on chain.
    interestBps: Math.round(finalApr * 10_000),
    maxLtvBps: Math.round(tier.maxLtv * 10_000),
    liquidationBufferBps: Math.round(tier.liquidationBuffer * 10_000),
  };
}

export { formatUsd, formatPercent, formatNumber } from './format.ts';

/**
 * Terms with protocol-assigned collateral (required minimum for the loan).
 *
 * Two passes rather than one: requiredCollateralEth does not depend on the collateral
 * posted, so the first call computes it with zero collateral and the second builds the
 * real sheet around that answer. This keeps one formula for both flows, the borrower
 * naming their collateral and the protocol naming it for them, instead of a second
 * implementation that could drift.
 */
export function calculateProtocolLoanTerms(
  input: Omit<LoanTermsInput, 'collateralAmount'>
): LoanTermSheet | null {
  const draft = calculateLoanTerms({ ...input, collateralAmount: 0 });
  if (!draft) return null;
  return calculateLoanTerms({
    ...input,
    collateralAmount: draft.requiredCollateralEth,
  });
}

/**
 * Recover a tier from an on-chain loan.
 *
 * The tier itself is never stored on chain, only its consequences, so reading a loan
 * back means matching maxLtvBps against the tier table. This works because the three
 * tiers have distinct max LTVs; it would break if two tiers ever shared one, and it
 * returns null rather than guessing for a loan created under a different table.
 */
export function inferRiskTierFromBps(maxLtvBps: number): RiskTier | null {
  const match = (Object.entries(RISK_TIER_CONFIG) as [RiskTier, RiskTierConfig][]).find(
    ([, config]) => Math.round(config.maxLtv * 10_000) === maxLtvBps
  );
  return match?.[0] ?? null;
}
