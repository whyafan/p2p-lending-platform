import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  explainPersonaRisk,
  FEATURE_WEIGHTS,
  FEATURE_SCORING_GUIDE,
  TIER_THRESHOLDS,
} from './risk-explainer.ts';
import { BORROWER_PERSONAS, getPersonaById } from './borrower-personas.ts';

const EPSILON = 1e-9;

function approxEqual(a: number, b: number, eps = EPSILON): boolean {
  return Math.abs(a - b) < eps;
}

describe('FEATURE_WEIGHTS', () => {
  it('8 weights sum to exactly 1.0', () => {
    const sum = FEATURE_WEIGHTS.reduce((a, b) => a + b, 0);
    assert.ok(
      approxEqual(sum, 1.0),
      `Expected weights to sum to 1.0, got ${sum}`
    );
  });

  it('has 8 entries matching FEATURE_SCORING_GUIDE length', () => {
    assert.equal(FEATURE_WEIGHTS.length, FEATURE_SCORING_GUIDE.length);
  });

  it('each guide entry weight matches FEATURE_WEIGHTS at same index', () => {
    FEATURE_SCORING_GUIDE.forEach((guide, i) => {
      assert.equal(
        guide.weight,
        FEATURE_WEIGHTS[i],
        `Weight mismatch at index ${i} (${guide.feature})`
      );
    });
  });
});

describe('TIER_THRESHOLDS', () => {
  it('A threshold is 0.40', () => assert.equal(TIER_THRESHOLDS.A, 0.40));
  it('B threshold is 0.00', () => assert.equal(TIER_THRESHOLDS.B, 0.00));
});

describe('BORROWER_PERSONAS', () => {
  it('has exactly 3 personas', () => assert.equal(BORROWER_PERSONAS.length, 3));

  it('each persona has a non-empty testnetWallet starting with 0x', () => {
    for (const p of BORROWER_PERSONAS) {
      assert.ok(
        typeof p.testnetWallet === 'string' && p.testnetWallet.startsWith('0x'),
        `${p.displayName} missing valid testnetWallet`
      );
    }
  });

  it('getPersonaById returns the correct persona', () => {
    const alice = getPersonaById('alice');
    assert.ok(alice !== undefined);
    assert.equal(alice!.displayName, 'Alice');
  });

  it('getPersonaById returns undefined for unknown id', () => {
    assert.equal(getPersonaById('unknown'), undefined);
  });
});

describe('explainPersonaRisk — Alice (Tier A)', () => {
  const alice = getPersonaById('alice')!;
  const result = explainPersonaRisk(alice);

  it('produces Tier A', () => assert.equal(result.tier, 'A'));

  it('overallScore is >= 0.40 (A threshold)', () => {
    assert.ok(
      result.overallScore >= TIER_THRESHOLDS.A,
      `Expected score >= 0.40, got ${result.overallScore}`
    );
  });

  it('overallScore is approximately 0.665', () => {
    assert.ok(
      approxEqual(result.overallScore, 0.665, 1e-6),
      `Expected ~0.665, got ${result.overallScore}`
    );
  });

  it('has 8 feature contributions', () => assert.equal(result.contributions.length, 8));

  it('all contributions have weights that sum to 1.0', () => {
    const sum = result.contributions.reduce((s, c) => s + c.weight, 0);
    assert.ok(approxEqual(sum, 1.0), `Weights sum to ${sum}`);
  });

  it('mixer interaction is on-chain category with score 0.30', () => {
    const mixer = result.contributions.find((c) => c.feature === 'Mixer interaction');
    assert.ok(mixer !== undefined, 'Mixer contribution not found');
    assert.equal(mixer!.category, 'on-chain');
    assert.ok(approxEqual(mixer!.score, 0.3));
  });

  it('DeFi loan history scores 0.90 (4/4 repaid, 0 liquidations)', () => {
    const loans = result.contributions.find((c) => c.feature === 'DeFi loan history');
    assert.ok(loans !== undefined);
    assert.ok(approxEqual(loans!.score, 0.9));
  });

  it('employment type is off-chain category', () => {
    const emp = result.contributions.find((c) => c.feature === 'Employment type');
    assert.ok(emp !== undefined);
    assert.equal(emp!.category, 'off-chain');
  });
});

describe('explainPersonaRisk — Charlie (Tier B)', () => {
  const charlie = getPersonaById('charlie')!;
  const result = explainPersonaRisk(charlie);

  it('produces Tier B', () => assert.equal(result.tier, 'B'));

  it('overallScore is >= 0.00 and < 0.40 (Tier B band)', () => {
    assert.ok(
      result.overallScore >= TIER_THRESHOLDS.B && result.overallScore < TIER_THRESHOLDS.A,
      `Expected 0.00 <= score < 0.40, got ${result.overallScore}`
    );
  });

  it('overallScore is approximately 0.025', () => {
    assert.ok(
      approxEqual(result.overallScore, 0.025, 1e-6),
      `Expected ~0.025, got ${result.overallScore}`
    );
  });

  it('DeFi loan history penalizes for liquidation (score -0.80)', () => {
    const loans = result.contributions.find((c) => c.feature === 'DeFi loan history');
    assert.ok(loans !== undefined);
    assert.ok(approxEqual(loans!.score, -0.8));
  });

  it('mixer interaction returns score 0.30 (no mixer detected)', () => {
    // mixerInteraction is false for Charlie — deliberate deviation from PDF spec
    // to keep Charlie as Tier B for the three-tier demo.
    const mixer = result.contributions.find((c) => c.feature === 'Mixer interaction');
    assert.ok(mixer !== undefined);
    assert.ok(approxEqual(mixer!.score, 0.3));
  });
});

describe('explainPersonaRisk — Bob (Tier C)', () => {
  const bob = getPersonaById('bob')!;
  const result = explainPersonaRisk(bob);

  it('produces Tier C', () => assert.equal(result.tier, 'C'));

  it('overallScore is < 0.00 (below Tier B threshold)', () => {
    assert.ok(
      result.overallScore < TIER_THRESHOLDS.B,
      `Expected score < 0.00, got ${result.overallScore}`
    );
  });

  it('overallScore is approximately -0.250', () => {
    assert.ok(
      approxEqual(result.overallScore, -0.25, 1e-6),
      `Expected ~-0.250, got ${result.overallScore}`
    );
  });

  it('wallet age penalized as new wallet', () => {
    const age = result.contributions.find((c) => c.feature === 'Wallet age');
    assert.ok(age !== undefined);
    assert.ok(approxEqual(age!.score, -0.6));
  });

  it('no prior DeFi loans scores -0.20', () => {
    const loans = result.contributions.find((c) => c.feature === 'DeFi loan history');
    assert.ok(loans !== undefined);
    assert.ok(approxEqual(loans!.score, -0.2));
  });
});

describe('explainPersonaRisk — all personas expectedTier matches computed tier', () => {
  it('every persona computes the tier declared in expectedTier', () => {
    for (const persona of BORROWER_PERSONAS) {
      const result = explainPersonaRisk(persona);
      assert.equal(
        result.tier,
        persona.expectedTier,
        `${persona.displayName}: expected ${persona.expectedTier}, got ${result.tier} (score=${result.overallScore.toFixed(4)})`
      );
    }
  });
});

describe('explainPersonaRisk — mixer edge cases', () => {
  it('mixer=true pushes score to -1.0 contribution', () => {
    const charlie = getPersonaById('charlie')!;
    const withMixer = {
      ...charlie,
      simulatedOnChainFeatures: { ...charlie.simulatedOnChainFeatures, mixerInteraction: true },
    };
    const result = explainPersonaRisk(withMixer);
    const mixer = result.contributions.find((c) => c.feature === 'Mixer interaction');
    assert.ok(mixer !== undefined);
    assert.ok(approxEqual(mixer!.score, -1.0));
    // With mixer=true Charlie scores Tier C (this confirms the deliberate deviation)
    assert.equal(result.tier, 'C');
  });
});
