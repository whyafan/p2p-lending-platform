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

export function isWalletRiskAcceptable(result: ScreeningResult): boolean {
  return result.riskScore <= 70;
}
