import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLoanTerms,
  calculateProtocolLoanTerms,
  inferRiskTierFromBps,
  RISK_TIER_CONFIG,
  BASE_APR,
} from './loan-terms.ts';

const EPSILON = 1e-9;
function approx(a: number, b: number, eps = EPSILON) {
  return Math.abs(a - b) < eps;
}

// ── RISK_TIER_CONFIG ──────────────────────────────────────────────────────────

describe('RISK_TIER_CONFIG', () => {
  it('Tier A maxLtv is 0.70', () => assert.equal(RISK_TIER_CONFIG.A.maxLtv, 0.70));
  it('Tier B maxLtv is 0.60', () => assert.equal(RISK_TIER_CONFIG.B.maxLtv, 0.60));
  it('Tier C maxLtv is 0.50', () => assert.equal(RISK_TIER_CONFIG.C.maxLtv, 0.50));

  it('Tier A haircut is 0 (no collateral discount)', () => assert.equal(RISK_TIER_CONFIG.A.haircut, 0));
  it('Tier B haircut is 0.05', () => assert.equal(RISK_TIER_CONFIG.B.haircut, 0.05));
  it('Tier C haircut is 0.10', () => assert.equal(RISK_TIER_CONFIG.C.haircut, 0.10));

  it('Tier A APR spread is 0.02', () => assert.equal(RISK_TIER_CONFIG.A.aprSpread, 0.02));
  it('Tier B APR spread is 0.05', () => assert.equal(RISK_TIER_CONFIG.B.aprSpread, 0.05));
  it('Tier C APR spread is 0.09', () => assert.equal(RISK_TIER_CONFIG.C.aprSpread, 0.09));

  it('BASE_APR is 6%', () => assert.equal(BASE_APR, 0.06));
});

// ── calculateLoanTerms — guard conditions ─────────────────────────────────────

describe('calculateLoanTerms — null guards', () => {
  const base = { riskTier: 'A' as const, loanAmountUsd: 1000, tenorDays: 30, collateralAmount: 1, oraclePriceUsd: 2000 };

  it('returns null for zero loanAmountUsd', () =>
    assert.equal(calculateLoanTerms({ ...base, loanAmountUsd: 0 }), null));

  it('returns null for negative loanAmountUsd', () =>
    assert.equal(calculateLoanTerms({ ...base, loanAmountUsd: -1 }), null));

  it('returns null for zero tenorDays', () =>
    assert.equal(calculateLoanTerms({ ...base, tenorDays: 0 }), null));

  it('returns null for zero oraclePriceUsd', () =>
    assert.equal(calculateLoanTerms({ ...base, oraclePriceUsd: 0 }), null));

  it('allows zero collateralAmount (protocol will set required amount)', () => {
    const result = calculateLoanTerms({ ...base, collateralAmount: 0 });
    assert.ok(result !== null);
  });
});

// ── calculateLoanTerms — Tier A ───────────────────────────────────────────────

describe('calculateLoanTerms — Tier A', () => {
  // 1 ETH @ $2000, borrow $1000, 90-day tenor
  const sheet = calculateLoanTerms({
    riskTier: 'A',
    loanAmountUsd: 1000,
    tenorDays: 90,
    collateralAmount: 1,
    oraclePriceUsd: 2000,
  })!;

  it('sheet is not null', () => assert.ok(sheet !== null));
  it('collateralValueUsd = 2000 (1 ETH × $2000)', () => assert.equal(sheet.collateralValueUsd, 2000));
  it('adjustedCollateralValueUsd = 2000 (no Tier A haircut)', () => assert.equal(sheet.adjustedCollateralValueUsd, 2000));
  it('maxBorrowUsd = 1400 (2000 × 0.70)', () => assert.equal(sheet.maxBorrowUsd, 1400));
  it('requiredCollateralEth ≈ 0.71429 (1000 / 0.7 / 2000)', () =>
    assert.ok(approx(sheet.requiredCollateralEth, 1000 / 0.7 / 2000, 1e-6)));
  it('finalApr = 0.08 (6% base + 2% spread)', () => assert.equal(sheet.finalApr, 0.08));
  it('interestDueUsd ≈ 19.73 (1000 × 0.08 × 90/365)', () =>
    assert.ok(approx(sheet.interestDueUsd, 1000 * 0.08 * (90 / 365), 1e-6)));
  it('totalRepaymentUsd = principal + interest', () =>
    assert.ok(approx(sheet.totalRepaymentUsd, 1000 + sheet.interestDueUsd)));
  it('initialLtv = 0.5 (1000 / 2000)', () => assert.ok(approx(sheet.initialLtv, 0.5)));
  it('liquidationThreshold ≈ 0.80 (0.70 maxLtv + 0.10 buffer)', () =>
    assert.ok(approx(sheet.liquidationThreshold, 0.80), `got ${sheet.liquidationThreshold}`));
  it('liquidationCollateralValueUsd = 1250 (1000 / 0.80)', () => assert.equal(sheet.liquidationCollateralValueUsd, 1250));
  it('isWithinMaxBorrow = true (1000 ≤ 1400)', () => assert.equal(sheet.isWithinMaxBorrow, true));
  it('interestBps = 800 (8% × 10000)', () => assert.equal(sheet.interestBps, 800));
  it('maxLtvBps = 7000', () => assert.equal(sheet.maxLtvBps, 7000));
  it('liquidationBufferBps = 1000', () => assert.equal(sheet.liquidationBufferBps, 1000));

  it('flags loan above maxBorrow', () => {
    const over = calculateLoanTerms({
      riskTier: 'A',
      loanAmountUsd: 1500,
      tenorDays: 30,
      collateralAmount: 1,
      oraclePriceUsd: 2000,
    })!;
    assert.equal(over.isWithinMaxBorrow, false);
  });
});

// ── calculateLoanTerms — Tier B ───────────────────────────────────────────────

describe('calculateLoanTerms — Tier B', () => {
  // 1 ETH @ $1500, borrow $500, 30-day tenor
  const sheet = calculateLoanTerms({
    riskTier: 'B',
    loanAmountUsd: 500,
    tenorDays: 30,
    collateralAmount: 1,
    oraclePriceUsd: 1500,
  })!;

  it('sheet is not null', () => assert.ok(sheet !== null));
  it('collateralValueUsd = 1500', () => assert.equal(sheet.collateralValueUsd, 1500));
  it('adjustedCollateralValueUsd = 1425 (1500 × 0.95 haircut)', () => assert.equal(sheet.adjustedCollateralValueUsd, 1425));
  it('maxBorrowUsd = 855 (1425 × 0.60)', () => assert.equal(sheet.maxBorrowUsd, 855));
  it('finalApr = 0.11 (6% + 5% spread)', () => assert.equal(sheet.finalApr, 0.11));
  it('interestDueUsd ≈ 4.52 (500 × 0.11 × 30/365)', () =>
    assert.ok(approx(sheet.interestDueUsd, 500 * 0.11 * (30 / 365), 1e-6)));
  it('liquidationThreshold = 0.72 (0.60 + 0.12)', () => assert.equal(sheet.liquidationThreshold, 0.72));
  it('isWithinMaxBorrow = true (500 ≤ 855)', () => assert.equal(sheet.isWithinMaxBorrow, true));
  it('interestBps = 1100', () => assert.equal(sheet.interestBps, 1100));
  it('maxLtvBps = 6000', () => assert.equal(sheet.maxLtvBps, 6000));
  it('liquidationBufferBps = 1200', () => assert.equal(sheet.liquidationBufferBps, 1200));
});

// ── calculateLoanTerms — Tier C ───────────────────────────────────────────────

describe('calculateLoanTerms — Tier C', () => {
  // 1 ETH @ $2000, borrow $500, 30-day tenor
  const sheet = calculateLoanTerms({
    riskTier: 'C',
    loanAmountUsd: 500,
    tenorDays: 30,
    collateralAmount: 1,
    oraclePriceUsd: 2000,
  })!;

  it('sheet is not null', () => assert.ok(sheet !== null));
  it('adjustedCollateralValueUsd = 1800 (2000 × 0.90 haircut)', () => assert.equal(sheet.adjustedCollateralValueUsd, 1800));
  it('maxBorrowUsd = 900 (1800 × 0.50)', () => assert.equal(sheet.maxBorrowUsd, 900));
  it('finalApr = 0.15 (6% + 9% spread)', () => assert.equal(sheet.finalApr, 0.15));
  it('liquidationThreshold = 0.65 (0.50 + 0.15)', () => assert.equal(sheet.liquidationThreshold, 0.65));
  it('liquidationCollateralValueUsd ≈ 769.23 (500 / 0.65)', () =>
    assert.ok(approx(sheet.liquidationCollateralValueUsd, 500 / 0.65, 1e-6)));
  it('isWithinMaxBorrow = true (500 ≤ 900)', () => assert.equal(sheet.isWithinMaxBorrow, true));
  it('maxLtvBps = 5000', () => assert.equal(sheet.maxLtvBps, RISK_TIER_CONFIG.C.maxLtv * 10_000));
  it('interestBps = 1500', () => assert.equal(sheet.interestBps, 1500));
  it('liquidationBufferBps = 1500', () => assert.equal(sheet.liquidationBufferBps, 1500));
});

// ── calculateProtocolLoanTerms ────────────────────────────────────────────────

describe('calculateProtocolLoanTerms', () => {
  it('returns a valid sheet for Tier A', () => {
    const sheet = calculateProtocolLoanTerms({
      riskTier: 'A',
      loanAmountUsd: 1000,
      tenorDays: 90,
      oraclePriceUsd: 2000,
    });
    assert.ok(sheet !== null);
  });

  it('initialLtv equals maxLtv when protocol sets collateral (Tier A)', () => {
    const sheet = calculateProtocolLoanTerms({
      riskTier: 'A',
      loanAmountUsd: 1000,
      tenorDays: 90,
      oraclePriceUsd: 2000,
    })!;
    // With minimum collateral, initialLtv = maxLtv exactly
    assert.ok(
      approx(sheet.initialLtv, RISK_TIER_CONFIG.A.maxLtv, 1e-6),
      `initialLtv ${sheet.initialLtv} should equal maxLtv ${RISK_TIER_CONFIG.A.maxLtv}`
    );
  });

  it('initialLtv equals maxLtv when protocol sets collateral (Tier C)', () => {
    const sheet = calculateProtocolLoanTerms({
      riskTier: 'C',
      loanAmountUsd: 500,
      tenorDays: 30,
      oraclePriceUsd: 2000,
    })!;
    assert.ok(
      approx(sheet.initialLtv, RISK_TIER_CONFIG.C.maxLtv, 1e-6),
      `initialLtv ${sheet.initialLtv} should equal maxLtv ${RISK_TIER_CONFIG.C.maxLtv}`
    );
  });

  it('isWithinMaxBorrow is true (protocol guarantees this)', () => {
    const sheet = calculateProtocolLoanTerms({
      riskTier: 'B',
      loanAmountUsd: 800,
      tenorDays: 60,
      oraclePriceUsd: 3000,
    })!;
    assert.equal(sheet.isWithinMaxBorrow, true);
  });

  it('returns null for invalid inputs', () => {
    const result = calculateProtocolLoanTerms({
      riskTier: 'A',
      loanAmountUsd: 0,
      tenorDays: 30,
      oraclePriceUsd: 2000,
    });
    assert.equal(result, null);
  });
});

// ── inferRiskTierFromBps ──────────────────────────────────────────────────────

describe('inferRiskTierFromBps', () => {
  it('7000 bps → Tier A', () => assert.equal(inferRiskTierFromBps(7000), 'A'));
  it('6000 bps → Tier B', () => assert.equal(inferRiskTierFromBps(6000), 'B'));
  it('5000 bps → Tier C', () => assert.equal(inferRiskTierFromBps(5000), 'C'));
  it('unknown bps → null', () => assert.equal(inferRiskTierFromBps(9999), null));
  it('0 bps → null', () => assert.equal(inferRiskTierFromBps(0), null));
});
