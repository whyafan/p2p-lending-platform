/**
 * Mock KYT engine — demo risk scores only (no real Chainalysis / TRM Labs API).
 * Replace with a real KYT API before going to production.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type ScreeningResult = {
  riskScore: number;
  riskLevel: RiskLevel;
  flags: string[];
};

/**
 * Score a wallet 0-99 from its own characters.
 *
 * Deterministic on purpose. A random score would give the same wallet a different
 * answer on every screen, which makes the compliance flow impossible to demo or test:
 * here, a given address always lands in the same band, so a HIGH-risk address stays
 * HIGH across sessions and machines and the rejection path can be shown on demand.
 */
export function screenWallet(address: string): ScreeningResult {
  const normalized = address.toLowerCase().replace('0x', '');

  // Deterministic but non-gameable hash: sum of all char codes across the full
  // address (not just the suffix).
  const hash = normalized.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const riskScore = hash % 100;

  if (riskScore <= 30) {
    return { riskScore, riskLevel: 'LOW', flags: ['CLEAN'] };
  }
  if (riskScore <= 70) {
    return { riskScore, riskLevel: 'MEDIUM', flags: ['NEW_WALLET'] };
  }
  return { riskScore, riskLevel: 'HIGH', flags: ['SCAM_EXPOSURE'] };
}

/**
 * Gate used when linking a wallet: LOW and MEDIUM pass, HIGH is refused.
 *
 * Compares the score rather than the level so the boundary lives in one place, and
 * matches the upper edge of MEDIUM above. MEDIUM passing is the deliberate part: a new
 * wallet with no history is not evidence of anything, and refusing it would lock out
 * exactly the borrowers the risk model exists to price.
 */
export function isWalletRiskAcceptable(result: ScreeningResult): boolean {
  return result.riskScore <= 70;
}
