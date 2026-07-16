import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignBaseRiskTier,
  assignRiskTier,
  adjustTierForLoanTerms,
  strictestTier,
  summarizeBorrowerLoans,
  tierSummary,
  LOAN_STATUS,
} from './borrower-risk.ts';

// ── summarizeBorrowerLoans ────────────────────────────────────────────────────

describe('summarizeBorrowerLoans', () => {
  it('empty array → all counts zero', () => {
    const stats = summarizeBorrowerLoans([]);
    assert.deepEqual(stats, {
      totalLoans: 0, repaid: 0, funded: 0, requested: 0, cancelled: 0, liquidated: 0,
    });
  });

  it('counts each status correctly', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(1), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(2), borrower: '0x1', status: LOAN_STATUS.Funded },
      { loanId: BigInt(3), borrower: '0x1', status: LOAN_STATUS.Requested },
      { loanId: BigInt(4), borrower: '0x1', status: LOAN_STATUS.Cancelled },
      { loanId: BigInt(5), borrower: '0x1', status: LOAN_STATUS.Liquidated },
    ]);
    assert.equal(stats.totalLoans, 6);
    assert.equal(stats.repaid, 2);
    assert.equal(stats.funded, 1);
    assert.equal(stats.requested, 1);
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.liquidated, 1);
  });
});

// ── assignBaseRiskTier ────────────────────────────────────────────────────────

describe('assignBaseRiskTier', () => {
  it('no loans → Tier C (conservative new wallet)', () => {
    const { tier } = assignBaseRiskTier(summarizeBorrowerLoans([]));
    assert.equal(tier, 'C');
  });

  it('any liquidation → Tier C regardless of repayments', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(1), borrower: '0x1', status: LOAN_STATUS.Liquidated },
    ]);
    assert.equal(assignBaseRiskTier(stats).tier, 'C');
  });

  it('2+ repaid loans, 0 liquidations → Tier A', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(1), borrower: '0x1', status: LOAN_STATUS.Repaid },
    ]);
    assert.equal(assignBaseRiskTier(stats).tier, 'A');
  });

  it('exactly 1 repaid loan → Tier B (not A)', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Repaid },
    ]);
    assert.equal(assignBaseRiskTier(stats).tier, 'B');
  });

  it('3 repaid loans → Tier A', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(1), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(2), borrower: '0x1', status: LOAN_STATUS.Repaid },
    ]);
    assert.equal(assignBaseRiskTier(stats).tier, 'A');
  });

  it('only funded (active) loan → Tier B', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Funded },
    ]);
    assert.equal(assignBaseRiskTier(stats).tier, 'B');
  });

  it('only requested (not yet funded) loan → Tier B', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Requested },
    ]);
    assert.equal(assignBaseRiskTier(stats).tier, 'B');
  });

  it('returns human-readable reasons', () => {
    const { reasons } = assignBaseRiskTier(summarizeBorrowerLoans([]));
    assert.ok(reasons.length > 0);
    assert.ok(typeof reasons[0] === 'string' && reasons[0].length > 0);
  });
});

// ── adjustTierForLoanTerms ────────────────────────────────────────────────────

describe('adjustTierForLoanTerms', () => {
  it('small loan, short tenor → tier unchanged', () => {
    const { tier } = adjustTierForLoanTerms('A', 1000, 30);
    assert.equal(tier, 'A');
  });

  it('large principal (> $5000) → one step stricter', () => {
    const { tier } = adjustTierForLoanTerms('A', 6000, 30);
    assert.equal(tier, 'B');
  });

  it('long tenor (≥ 90 days) → one step stricter', () => {
    const { tier } = adjustTierForLoanTerms('A', 1000, 90);
    assert.equal(tier, 'B');
  });

  it('large principal AND long tenor → two steps stricter (A→C)', () => {
    const { tier } = adjustTierForLoanTerms('A', 6000, 90);
    assert.equal(tier, 'C');
  });

  it('already Tier C with large principal → stays at C (floor)', () => {
    const { tier } = adjustTierForLoanTerms('C', 6000, 30);
    assert.equal(tier, 'C');
  });

  it('already Tier C with long tenor → stays at C, reason explains no further downgrade', () => {
    const { tier, reasons } = adjustTierForLoanTerms('C', 1000, 90);
    assert.equal(tier, 'C');
    assert.ok(
      reasons.some((r) => r.includes('already at maximum risk')),
      `Expected 'already at maximum risk' in reasons: ${JSON.stringify(reasons)}`
    );
  });

  it('includes tenor reason when tenor ≥ 90', () => {
    const { reasons } = adjustTierForLoanTerms('A', 1000, 90);
    assert.ok(reasons.some((r) => r.includes('90-day tenor')));
  });

  it('includes principal reason when principal > $5000', () => {
    const { reasons } = adjustTierForLoanTerms('A', 6000, 30);
    assert.ok(reasons.some((r) => r.includes('$6,000')));
  });
});

// ── strictestTier ─────────────────────────────────────────────────────────────

describe('strictestTier', () => {
  it('[A, B, C] → C', () => assert.equal(strictestTier(['A', 'B', 'C']), 'C'));
  it('[A, A, A] → A', () => assert.equal(strictestTier(['A', 'A', 'A']), 'A'));
  it('[B, C] → C', () => assert.equal(strictestTier(['B', 'C']), 'C'));
  it('[A] → A', () => assert.equal(strictestTier(['A']), 'A'));
  it('[] → C (conservative default)', () => assert.equal(strictestTier([]), 'C'));
});

// ── assignRiskTier ────────────────────────────────────────────────────────────

describe('assignRiskTier', () => {
  it('no loans → Tier C', () => {
    const result = assignRiskTier({
      stats: summarizeBorrowerLoans([]),
      loanAmountUsd: 1000,
      tenorDays: 30,
      linkedWalletCount: 1,
    });
    assert.equal(result.tier, 'C');
  });

  it('2 repaid loans, small loan, short tenor → Tier A', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(1), borrower: '0x1', status: LOAN_STATUS.Repaid },
    ]);
    const result = assignRiskTier({ stats, loanAmountUsd: 1000, tenorDays: 30, linkedWalletCount: 1 });
    assert.equal(result.tier, 'A');
  });

  it('liquidation → always Tier C even with large loan', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Liquidated },
    ]);
    const result = assignRiskTier({ stats, loanAmountUsd: 10_000, tenorDays: 90, linkedWalletCount: 1 });
    assert.equal(result.tier, 'C');
  });

  it('linkedWalletCount > 1 adds profile name reason', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Liquidated },
    ]);
    const result = assignRiskTier({ stats, loanAmountUsd: 1000, tenorDays: 30, linkedWalletCount: 3 });
    assert.ok(
      result.reasons.some((r) => r.includes('profile name')),
      `Expected profile name reason, got: ${JSON.stringify(result.reasons)}`
    );
  });

  it('linkedWalletCount = 1 does NOT add profile name reason', () => {
    const stats = summarizeBorrowerLoans([]);
    const result = assignRiskTier({ stats, loanAmountUsd: 1000, tenorDays: 30, linkedWalletCount: 1 });
    assert.ok(
      !result.reasons.some((r) => r.includes('profile name')),
      `Unexpected profile name reason with single wallet`
    );
  });

  it('result includes baseTier and stats', () => {
    const stats = summarizeBorrowerLoans([
      { loanId: BigInt(0), borrower: '0x1', status: LOAN_STATUS.Repaid },
      { loanId: BigInt(1), borrower: '0x1', status: LOAN_STATUS.Repaid },
    ]);
    const result = assignRiskTier({ stats, loanAmountUsd: 1000, tenorDays: 30, linkedWalletCount: 1 });
    assert.ok('baseTier' in result);
    assert.ok('stats' in result);
    assert.equal(result.stats.repaid, 2);
  });
});

// ── tierSummary ───────────────────────────────────────────────────────────────

describe('tierSummary', () => {
  it('Tier A summary includes "Tier A", "Low risk", "70%"', () => {
    const s = tierSummary('A');
    assert.ok(s.includes('Tier A'), s);
    assert.ok(s.includes('Low risk'), s);
    assert.ok(s.includes('70%'), s);
  });

  it('Tier B summary includes "Tier B", "Medium risk", "60%"', () => {
    const s = tierSummary('B');
    assert.ok(s.includes('Tier B'), s);
    assert.ok(s.includes('Medium risk'), s);
    assert.ok(s.includes('60%'), s);
  });

  it('Tier C summary includes "Tier C", "High risk", "50%"', () => {
    const s = tierSummary('C');
    assert.ok(s.includes('Tier C'), s);
    assert.ok(s.includes('High risk'), s);
    assert.ok(s.includes('50%'), s);
  });
});
