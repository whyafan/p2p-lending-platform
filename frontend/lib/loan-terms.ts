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

export const BASE_APR = 0.06;

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
  const adjustedCollateralValueUsd = collateralValueUsd * (1 - tier.haircut);
  const maxBorrowUsd = adjustedCollateralValueUsd * tier.maxLtv;
  const collateralFactor = tier.maxLtv * (1 - tier.haircut);
  const requiredCollateralValueUsd =
    collateralFactor > 0 ? loanAmountUsd / collateralFactor : 0;
  const requiredCollateralEth = requiredCollateralValueUsd / oraclePriceUsd;

  const finalApr = BASE_APR + tier.aprSpread;
  const interestDueUsd = loanAmountUsd * finalApr * (tenorDays / 365);
  const totalRepaymentUsd = loanAmountUsd + interestDueUsd;

  const initialLtv =
    adjustedCollateralValueUsd > 0 ? loanAmountUsd / adjustedCollateralValueUsd : 0;

  const liquidationThreshold = tier.maxLtv + tier.liquidationBuffer;
  const liquidationCollateralValueUsd =
    liquidationThreshold > 0 ? loanAmountUsd / liquidationThreshold : 0;

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
    interestBps: Math.round(finalApr * 10_000),
    maxLtvBps: Math.round(tier.maxLtv * 10_000),
    liquidationBufferBps: Math.round(tier.liquidationBuffer * 10_000),
  };
}

export { formatUsd, formatPercent, formatNumber } from './format.ts';

/** Terms with protocol-assigned collateral (required minimum for the loan). */
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

export function inferRiskTierFromBps(maxLtvBps: number): RiskTier | null {
  const match = (Object.entries(RISK_TIER_CONFIG) as [RiskTier, RiskTierConfig][]).find(
    ([, config]) => Math.round(config.maxLtv * 10_000) === maxLtvBps
  );
  return match?.[0] ?? null;
}
