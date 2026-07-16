import type { RiskTier } from './loan-terms.ts';
import { RISK_TIER_CONFIG } from './loan-terms.ts';
import { formatUsd } from './format.ts';

/** On-chain Loan.status() values */
export const LOAN_STATUS = {
  Requested: 0,
  Funded: 1,
  Repaid: 2,
  Cancelled: 3,
  Liquidated: 4,
} as const;

export type BorrowerLoanRecord = {
  loanId: bigint;
  borrower: `0x${string}`;
  status: number;
};

export type BorrowerLoanStats = {
  totalLoans: number;
  repaid: number;
  funded: number;
  requested: number;
  cancelled: number;
  liquidated: number;
};

export type RiskAssignment = {
  tier: RiskTier;
  baseTier: RiskTier;
  reasons: string[];
  linkedWalletCount: number;
  stats: BorrowerLoanStats;
};

const TIER_ORDER: RiskTier[] = ['A', 'B', 'C'];

export function normalizeWalletAddress(address: string): `0x${string}` {
  return address.toLowerCase() as `0x${string}`;
}

export function summarizeBorrowerLoans(records: BorrowerLoanRecord[]): BorrowerLoanStats {
  const stats: BorrowerLoanStats = {
    totalLoans: records.length,
    repaid: 0,
    funded: 0,
    requested: 0,
    cancelled: 0,
    liquidated: 0,
  };

  for (const record of records) {
    if (record.status === LOAN_STATUS.Repaid) stats.repaid += 1;
    else if (record.status === LOAN_STATUS.Funded) stats.funded += 1;
    else if (record.status === LOAN_STATUS.Requested) stats.requested += 1;
    else if (record.status === LOAN_STATUS.Cancelled) stats.cancelled += 1;
    else if (record.status === LOAN_STATUS.Liquidated) stats.liquidated += 1;
  }

  return stats;
}

/** Stricter tier = worse borrower terms (lower LTV, higher spread). */
export function stricterTier(current: RiskTier, bump = 1): RiskTier {
  const index = TIER_ORDER.indexOf(current);
  return TIER_ORDER[Math.min(index + bump, TIER_ORDER.length - 1)];
}

export function strictestTier(tiers: RiskTier[]): RiskTier {
  if (tiers.length === 0) return 'C';
  return tiers.reduce((acc, tier) => {
    return TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(acc) ? tier : acc;
  });
}

/**
 * Base tier from repayment / default history (factory + loan status).
 * New wallets with no history start at C (conservative).
 */
export function assignBaseRiskTier(stats: BorrowerLoanStats): { tier: RiskTier; reasons: string[] } {
  const reasons: string[] = [];

  if (stats.totalLoans === 0) {
    reasons.push('No prior loans on this identity — assigned conservative Tier C.');
    return { tier: 'C', reasons };
  }

  if (stats.liquidated > 0) {
    reasons.push(
      `${stats.liquidated} liquidated loan(s) on record — Tier C until history improves.`
    );
    return { tier: 'C', reasons };
  }

  if (stats.repaid >= 2) {
    reasons.push(`${stats.repaid} repaid loans — qualifies for Tier A.`);
    return { tier: 'A', reasons };
  }

  if (stats.repaid >= 1) {
    reasons.push('One repaid loan — Tier B. Two or more repaid loans unlock Tier A.');
    return { tier: 'B', reasons };
  }

  if (stats.funded > 0) {
    reasons.push('Active or past funded loan without repayment — Tier B.');
    return { tier: 'B', reasons };
  }

  reasons.push('Loan requests only (not yet repaid) — Tier B.');
  return { tier: 'B', reasons };
}

const LARGE_LOAN_USD = 5_000;
const LONG_TENOR_DAYS = 90;

export function adjustTierForLoanTerms(
  baseTier: RiskTier,
  loanAmountUsd: number,
  tenorDays: number
): { tier: RiskTier; reasons: string[] } {
  const reasons: string[] = [];
  let tier = baseTier;

  if (loanAmountUsd > LARGE_LOAN_USD) {
    tier = stricterTier(tier);
    reasons.push(
      `Principal ≈ ${formatUsd(loanAmountUsd, 0)} exceeds ${formatUsd(LARGE_LOAN_USD, 0)} — one tier stricter.`
    );
  }

  if (tenorDays >= LONG_TENOR_DAYS) {
    const before = tier;
    tier = stricterTier(tier);
    reasons.push(
      tier !== before
        ? `${tenorDays}-day tenor — one tier stricter.`
        : `${tenorDays}-day tenor — already at maximum risk (Tier C), no further downgrade.`
    );
  }

  return { tier, reasons };
}

export function assignRiskTier(params: {
  stats: BorrowerLoanStats;
  loanAmountUsd: number;
  tenorDays: number;
  linkedWalletCount: number;
}): RiskAssignment {
  const { stats, loanAmountUsd, tenorDays, linkedWalletCount } = params;
  const base = assignBaseRiskTier(stats);
  const adjusted = adjustTierForLoanTerms(base.tier, loanAmountUsd, tenorDays);

  const reasons = [...base.reasons, ...adjusted.reasons];

  if (linkedWalletCount > 1) {
    reasons.push(
      `${linkedWalletCount} wallets share this profile name — tier uses the strictest combined on-chain history.`
    );
  }

  return {
    tier: adjusted.tier,
    baseTier: base.tier,
    reasons,
    linkedWalletCount,
    stats,
  };
}

export function tierSummary(tier: RiskTier): string {
  const config = RISK_TIER_CONFIG[tier];
  return `${config.label} · ${config.borrowerRisk} · ${(config.maxLtv * 100).toFixed(0)}% max LTV`;
}
