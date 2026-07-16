import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from './feature-extractor.ts';
import { scoreFeatureVector, explainPersonaRisk } from './risk-explainer.ts';
import { BORROWER_PERSONAS, getPersonaById } from './borrower-personas.ts';

describe('extractFeatures', () => {
  it('returns null for unknown persona id', () => {
    assert.equal(extractFeatures('nobody'), null);
  });

  it('returns a FeatureVector for each known persona', () => {
    for (const persona of BORROWER_PERSONAS) {
      const vector = extractFeatures(persona.id);
      assert.ok(vector !== null, `Expected vector for ${persona.id}`);
    }
  });

  it('source is "persona" for all built-in personas', () => {
    for (const persona of BORROWER_PERSONAS) {
      const vector = extractFeatures(persona.id)!;
      assert.equal(vector.source, 'persona');
    }
  });

  it('personaId matches the requested id', () => {
    const vector = extractFeatures('alice')!;
    assert.equal(vector.personaId, 'alice');
  });

  it('walletAddress matches the persona testnetWallet', () => {
    const alice = BORROWER_PERSONAS.find((p) => p.id === 'alice')!;
    const vector = extractFeatures('alice')!;
    assert.equal(vector.walletAddress, alice.testnetWallet);
  });

  it('on-chain features are preserved exactly', () => {
    const alice = BORROWER_PERSONAS.find((p) => p.id === 'alice')!;
    const vector = extractFeatures('alice')!;
    assert.equal(vector.walletAgeDays, alice.simulatedOnChainFeatures.walletAgeDays);
    assert.equal(vector.totalTxCount, alice.simulatedOnChainFeatures.totalTxCount);
    assert.equal(vector.uniqueProtocolsUsed, alice.simulatedOnChainFeatures.uniqueProtocolsUsed);
    assert.equal(vector.aaveLoansTaken, alice.simulatedOnChainFeatures.aaveLoansTaken);
    assert.equal(vector.aaveLoansRepaid, alice.simulatedOnChainFeatures.aaveLoansRepaid);
    assert.equal(vector.aaveLiquidations, alice.simulatedOnChainFeatures.aaveLiquidations);
    assert.equal(vector.avgBalanceUsd90d, alice.simulatedOnChainFeatures.avgBalanceUsd90d);
    assert.equal(vector.mixerInteraction, alice.simulatedOnChainFeatures.mixerInteraction);
    assert.equal(vector.sanctionProximity, alice.simulatedOnChainFeatures.sanctionProximity);
  });

  it('off-chain features are preserved exactly', () => {
    const bob = BORROWER_PERSONAS.find((p) => p.id === 'bob')!;
    const vector = extractFeatures('bob')!;
    assert.equal(vector.incomeBand, bob.offChainMetadata.incomeBand);
    assert.equal(vector.employmentType, bob.offChainMetadata.employmentType);
    assert.equal(vector.loanPurpose, bob.offChainMetadata.loanPurpose);
  });
});

describe('extractFeatures + scoreFeatureVector pipeline', () => {
  it('alice: pipeline produces Tier A', () => {
    const vector = extractFeatures('alice')!;
    const result = scoreFeatureVector(vector);
    assert.equal(result.tier, 'A');
  });

  it('charlie: pipeline produces Tier B', () => {
    const vector = extractFeatures('charlie')!;
    const result = scoreFeatureVector(vector);
    assert.equal(result.tier, 'B');
  });

  it('bob: pipeline produces Tier C', () => {
    const vector = extractFeatures('bob')!;
    const result = scoreFeatureVector(vector);
    assert.equal(result.tier, 'C');
  });

  it('pipeline result matches explainPersonaRisk for the same persona', () => {
    // Both paths produce identical output — proving the abstraction is a
    // transparent wrapper with no scoring logic of its own.
    for (const persona of BORROWER_PERSONAS) {
      const via_pipeline = scoreFeatureVector(extractFeatures(persona.id)!);
      const via_direct = explainPersonaRisk(getPersonaById(persona.id)!);
      assert.equal(via_pipeline.tier, via_direct.tier, `${persona.id} tier mismatch`);
      assert.ok(
        Math.abs(via_pipeline.overallScore - via_direct.overallScore) < 1e-9,
        `${persona.id} score mismatch: ${via_pipeline.overallScore} vs ${via_direct.overallScore}`
      );
    }
  });

  it('scoreFeatureVector works with a manually constructed FeatureVector', () => {
    // Proves the abstraction is truly pluggable — you can pass any data, not just persona data.
    const result = scoreFeatureVector({
      source: 'mainnet',
      walletAddress: '0xdeadbeef',
      walletAgeDays: 1000,
      totalTxCount: 500,
      uniqueProtocolsUsed: 10,
      aaveLoansTaken: 5,
      aaveLoansRepaid: 5,
      aaveLiquidations: 0,
      avgBalanceUsd90d: 100_000,
      mixerInteraction: false,
      sanctionProximity: false,
      incomeBand: '>100k',
      employmentType: 'full-time',
      loanPurpose: 'business',
    });
    assert.equal(result.tier, 'A');
    assert.ok(result.overallScore >= 0.4);
  });
});
