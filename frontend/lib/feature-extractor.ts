import { getPersonaById } from './borrower-personas.ts';
import type { FeatureVector } from './risk-explainer.ts';

export type { FeatureVector, DataSource } from './risk-explainer.ts';

/**
 * Extract a FeatureVector for a given persona ID.
 *
 * MVP implementation: reads from static synthetic persona JSON.
 * To switch to live mainnet scoring, replace this function body with
 * an Alchemy/Etherscan API call that populates the same FeatureVector shape.
 *
 * Usage:
 *   const vector = extractFeatures('alice');
 *   const explanation = scoreFeatureVector(vector);
 */
export function extractFeatures(personaId: string): FeatureVector | null {
  const persona = getPersonaById(personaId);
  if (!persona) return null;

  return {
    ...persona.simulatedOnChainFeatures,
    ...persona.offChainMetadata,
    source: 'persona',
    personaId,
    walletAddress: persona.testnetWallet,
  };
}
