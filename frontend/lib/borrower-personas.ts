import type { RiskTier } from './loan-terms';

export type SimulatedOnChainFeatures = {
  walletAgeDays: number;
  totalTxCount: number;
  uniqueProtocolsUsed: number;
  aaveLoansTaken: number;
  aaveLoansRepaid: number;
  aaveLiquidations: number;
  avgBalanceUsd90d: number;
  mixerInteraction: boolean;
  sanctionProximity: boolean;
};

export type OffChainMetadata = {
  incomeBand: '<30k' | '30k-50k' | '50k-100k' | '>100k';
  employmentType: 'full-time' | 'freelance' | 'student' | 'self-employed';
  loanPurpose: 'business' | 'personal' | 'investment' | 'education';
};

export type BorrowerPersona = {
  id: string;
  displayName: string;
  description: string;
  expectedTier: RiskTier;
  /** Hardhat default address assigned to this persona — shown for display only. */
  testnetWallet: string;
  /** Fake ETH balance shown on the dashboard for demo purposes. Real wallet used for actual transactions. */
  demoEthBalance: number;
  simulatedOnChainFeatures: SimulatedOnChainFeatures;
  offChainMetadata: OffChainMetadata;
};

/**
 * One persona per tier, so the demo can show all three outcomes without needing three
 * real wallets with three different histories on mainnet.
 *
 * expectedTier is not an input to anything: the scorer runs over the features below
 * and arrives at a tier on its own. It is recorded so the unit tests can assert that
 * the model still lands where the fixture claims, which is how a weight or breakpoint
 * change gets caught.
 *
 * sanctionProximity and loanPurpose are carried on every persona but scored by
 * nothing. They come from the original spec and stay in the data as the shape the
 * screening and underwriting work would fill in.
 */
export const BORROWER_PERSONAS: BorrowerPersona[] = [
  {
    id: 'alice',
    displayName: 'Alice',
    description: 'Experienced DeFi user — 3+ yr wallet, 4 Aave loans repaid cleanly, $47k avg balance.',
    expectedTier: 'A',
    testnetWallet: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    demoEthBalance: 48.2,
    simulatedOnChainFeatures: {
      walletAgeDays: 1247,
      totalTxCount: 312,
      uniqueProtocolsUsed: 8,
      aaveLoansTaken: 4,
      aaveLoansRepaid: 4,
      aaveLiquidations: 0,
      avgBalanceUsd90d: 47200,
      mixerInteraction: false,
      sanctionProximity: false,
    },
    offChainMetadata: {
      incomeBand: '50k-100k',
      employmentType: 'full-time',
      loanPurpose: 'business',
    },
  },
  {
    id: 'charlie',
    displayName: 'Charlie',
    description: '6-month wallet, moderate DeFi activity, but one prior liquidation event.',
    expectedTier: 'B',
    testnetWallet: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    demoEthBalance: 12.74,
    simulatedOnChainFeatures: {
      walletAgeDays: 180,
      totalTxCount: 89,
      uniqueProtocolsUsed: 3,
      aaveLoansTaken: 2,
      aaveLoansRepaid: 1,
      aaveLiquidations: 1,
      avgBalanceUsd90d: 12000,
      // PDF spec shows mixer_interaction: true, but that scores Charlie at Tier C (−0.170).
      // Set to false so Charlie serves as the Tier B demo persona (score +0.025).
      mixerInteraction: false,
      sanctionProximity: false,
    },
    offChainMetadata: {
      incomeBand: '30k-50k',
      employmentType: 'full-time',
      loanPurpose: 'investment',
    },
  },
  {
    id: 'bob',
    displayName: 'Bob',
    description: 'Fresh 45-day wallet — only 7 transactions, no DeFi loans, $800 avg balance.',
    expectedTier: 'C',
    testnetWallet: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    demoEthBalance: 0.83,
    simulatedOnChainFeatures: {
      walletAgeDays: 45,
      totalTxCount: 7,
      uniqueProtocolsUsed: 1,
      aaveLoansTaken: 0,
      aaveLoansRepaid: 0,
      aaveLiquidations: 0,
      avgBalanceUsd90d: 800,
      mixerInteraction: false,
      sanctionProximity: false,
    },
    offChainMetadata: {
      incomeBand: '<30k',
      employmentType: 'freelance',
      loanPurpose: 'personal',
    },
  },
];

export function getPersonaById(id: string): BorrowerPersona | undefined {
  return BORROWER_PERSONAS.find((p) => p.id === id);
}
