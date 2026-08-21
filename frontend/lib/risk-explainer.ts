import type { BorrowerPersona, SimulatedOnChainFeatures, OffChainMetadata } from './borrower-personas';
import type { RiskTier } from './loan-terms';

/** Where the feature data came from — persona JSON (MVP) or live mainnet extraction. */
export type DataSource = 'persona' | 'mainnet';

/**
 * Normalized feature vector — the single type crossing the Layer 1 → Layer 2 boundary.
 * In MVP mode, populated from synthetic persona JSON. In production, replace
 * extractFeatures() in feature-extractor.ts with an Alchemy/Etherscan API call.
 */
export type FeatureVector = SimulatedOnChainFeatures & OffChainMetadata & {
  source: DataSource;
  walletAddress?: string;
  personaId?: string;
};

export type FeatureContribution = {
  feature: string;
  category: 'on-chain' | 'off-chain';
  value: string;
  /** -1 (pushes toward Tier C) to +1 (pushes toward Tier A) */
  score: number;
  /** Proportion of the overall score this feature contributes (0–1, all weights sum to 1) */
  weight: number;
  description: string;
};

export type RiskExplanation = {
  tier: RiskTier;
  /** Weighted sum of all feature scores, clamped to [-1, +1] */
  overallScore: number;
  contributions: FeatureContribution[];
};

/** Tier boundaries: score ≥ A_THRESHOLD → A, ≥ B_THRESHOLD → B, else C */
export const TIER_THRESHOLDS = { A: 0.40, B: 0.00 } as const;

export type FeatureScoringGuide = {
  feature: string;
  weight: number;
  thresholds: Array<{ condition: string; score: number }>;
};

/**
 * Human-readable scoring guide: shows every breakpoint used in the scoring
 * functions below so the UI can render a full transparency table.
 * Order matches the contributions array built in explainPersonaRisk.
 *
 * Phase 2 features NOT YET SCORED (present in persona data but excluded from the model):
 *   - sanction_proximity: requires on-chain OFAC screening API
 *   - loan_purpose: requires underwriting model trained on purpose→default correlations
 */
export const FEATURE_SCORING_GUIDE: FeatureScoringGuide[] = [
  {
    feature: 'Wallet age',
    weight: 0.15,
    thresholds: [
      { condition: '≥ 365 days', score: 0.80 },
      { condition: '≥ 90 days',  score: 0.30 },
      { condition: '< 90 days',  score: -0.60 },
    ],
  },
  {
    feature: 'Transaction volume',
    weight: 0.10,
    thresholds: [
      { condition: '≥ 200 txs', score: 0.70 },
      { condition: '≥ 50 txs',  score: 0.40 },
      { condition: '≥ 10 txs',  score: 0.00 },
      { condition: '< 10 txs',  score: -0.50 },
    ],
  },
  {
    feature: 'DeFi breadth',
    weight: 0.10,
    thresholds: [
      { condition: '≥ 5 protocols', score: 0.60 },
      { condition: '≥ 2 protocols', score: 0.20 },
      { condition: '< 2 protocols', score: -0.30 },
    ],
  },
  {
    feature: 'DeFi loan history',
    weight: 0.25,
    thresholds: [
      { condition: '2+ repaid, 0 liquidations', score: 0.90 },
      { condition: '1 repaid, 0 liquidations',  score: 0.50 },
      { condition: 'Pending repayment',          score: 0.10 },
      { condition: 'No prior loans',             score: -0.20 },
      { condition: 'Any liquidation',            score: -0.80 },
    ],
  },
  {
    feature: 'Avg. balance (90d)',
    weight: 0.10,
    thresholds: [
      { condition: '≥ $20,000', score: 0.70 },
      { condition: '≥ $5,000',  score: 0.40 },
      { condition: '≥ $1,000',  score: 0.10 },
      { condition: '< $1,000',  score: -0.40 },
    ],
  },
  {
    feature: 'Mixer interaction',
    weight: 0.15,
    thresholds: [
      { condition: 'None detected', score: 0.30 },
      { condition: 'Detected',      score: -1.00 },
    ],
  },
  {
    feature: 'Income band',
    weight: 0.10,
    thresholds: [
      { condition: '> $100k / yr',        score: 0.80 },
      { condition: '$50k – $100k / yr',   score: 0.50 },
      { condition: '$30k – $50k / yr',    score: 0.10 },
      { condition: '< $30k / yr',         score: -0.30 },
    ],
  },
  {
    feature: 'Employment type',
    weight: 0.05,
    thresholds: [
      { condition: 'Full-time',     score: 0.50 },
      { condition: 'Self-employed', score: 0.20 },
      { condition: 'Freelance',     score: -0.10 },
      { condition: 'Student',       score: -0.20 },
    ],
  },
];

/**
 * Feature weights must sum to 1.0.
 * Order matches FEATURE_SCORING_GUIDE and the contributions array in explainPersonaRisk.
 */
export const FEATURE_WEIGHTS = [0.15, 0.10, 0.10, 0.25, 0.10, 0.15, 0.10, 0.05] as const;

// ─── individual feature scorers ────────────────────────────────────────────

function scoreWalletAge(days: number): Omit<FeatureContribution, 'weight'> {
  const score = days >= 365 ? 0.8 : days >= 90 ? 0.3 : -0.6;
  const value =
    days >= 365
      ? `${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}m`
      : `${days} days`;
  return {
    feature: 'Wallet age',
    category: 'on-chain',
    value,
    score,
    description:
      days >= 365
        ? 'Long-standing wallet signals consistent on-chain presence'
        : days >= 90
        ? 'Some history but relatively new wallet'
        : 'New wallet - high uncertainty for lenders',
  };
}

function scoreTxCount(count: number): Omit<FeatureContribution, 'weight'> {
  const score = count >= 200 ? 0.7 : count >= 50 ? 0.4 : count >= 10 ? 0.0 : -0.5;
  return {
    feature: 'Transaction volume',
    category: 'on-chain',
    value: `${count} txs`,
    score,
    description:
      count >= 200
        ? 'High transaction count indicates an active, engaged user'
        : count >= 50
        ? 'Moderate activity demonstrates regular chain usage'
        : 'Low volume limits risk-assessment confidence',
  };
}

function scoreProtocolUsage(count: number): Omit<FeatureContribution, 'weight'> {
  const score = count >= 5 ? 0.6 : count >= 2 ? 0.2 : -0.3;
  return {
    feature: 'DeFi breadth',
    category: 'on-chain',
    value: `${count} protocol${count !== 1 ? 's' : ''}`,
    score,
    description:
      count >= 5
        ? 'Broad DeFi participation signals financial sophistication'
        : count >= 2
        ? 'Some cross-protocol experience'
        : 'Limited to one protocol — thin DeFi footprint',
  };
}

function scoreDeFiLoans(
  taken: number,
  repaid: number,
  liquidations: number
): Omit<FeatureContribution, 'weight'> {
  let score: number;
  let value: string;
  if (liquidations > 0) {
    score = -0.8;
    value = `${liquidations} liquidation(s), ${repaid}/${taken} repaid`;
  } else if (repaid >= 2 && repaid === taken) {
    score = 0.9;
    value = `${repaid}/${taken} repaid — 0 liquidations`;
  } else if (repaid >= 1) {
    score = 0.5;
    value = `${repaid}/${taken} repaid — 0 liquidations`;
  } else if (taken === 0) {
    score = -0.2;
    value = 'No prior DeFi loans';
  } else {
    score = 0.1;
    value = `${taken} loan(s), pending repayment`;
  }
  return {
    feature: 'DeFi loan history',
    category: 'on-chain',
    value,
    score,
    description:
      liquidations > 0
        ? 'Prior liquidation significantly increases default risk estimate'
        : repaid >= 2
        ? 'Clean multi-loan repayment history — strongest positive signal'
        : repaid === 1
        ? 'One successful repayment on record — moderate positive'
        : 'No prior DeFi borrowing — treated as baseline risk',
  };
}

function scoreBalance(avgUsd: number): Omit<FeatureContribution, 'weight'> {
  const score =
    avgUsd >= 20000 ? 0.7 : avgUsd >= 5000 ? 0.4 : avgUsd >= 1000 ? 0.1 : -0.4;
  return {
    feature: 'Avg. balance (90d)',
    category: 'on-chain',
    value: `$${avgUsd.toLocaleString()}`,
    score,
    description:
      avgUsd >= 20000
        ? 'Substantial balance indicates financial stability'
        : avgUsd >= 5000
        ? 'Moderate balance — adequate liquidity buffer'
        : 'Low average balance increases repayment risk',
  };
}

function scoreMixerInteraction(interaction: boolean): Omit<FeatureContribution, 'weight'> {
  return {
    feature: 'Mixer interaction',
    category: 'on-chain',
    value: interaction ? 'Detected' : 'None detected',
    score: interaction ? -1.0 : 0.3,
    description: interaction
      ? 'Privacy-mixer usage is a compliance and counterparty concern'
      : 'No interaction with privacy mixers or sanctioned contracts',
  };
}

function scoreIncomeBand(band: OffChainMetadata['incomeBand']): Omit<FeatureContribution, 'weight'> {
  const scoreMap: Record<string, number> = {
    '>100k': 0.8,
    '50k-100k': 0.5,
    '30k-50k': 0.1,
    '<30k': -0.3,
  };
  return {
    feature: 'Income band',
    category: 'off-chain',
    value: band === '>100k' ? '>$100k /yr' : `$${band} /yr`,
    score: scoreMap[band] ?? 0,
    description:
      band === '>100k' || band === '50k-100k'
        ? 'Higher income band correlates with lower default probability'
        : 'Lower income band increases repayment uncertainty',
  };
}

function scoreEmployment(type: OffChainMetadata['employmentType']): Omit<FeatureContribution, 'weight'> {
  const scoreMap: Record<string, number> = {
    'full-time': 0.5,
    'self-employed': 0.2,
    freelance: -0.1,
    student: -0.2,
  };
  const descMap: Record<string, string> = {
    'full-time': 'Stable employment — consistent, predictable income stream',
    'self-employed': 'Self-employed — income present but variable month-to-month',
    freelance: 'Freelance income is inherently variable by nature',
    student: 'Student status limits income predictability',
  };
  return {
    feature: 'Employment type',
    category: 'off-chain',
    value: type.charAt(0).toUpperCase() + type.slice(1),
    score: scoreMap[type] ?? 0,
    description: descMap[type] ?? '',
  };
}

/**
 * Score a FeatureVector and produce a full XAI explanation.
 * This is the core Layer 2 function — call it with any FeatureVector regardless
 * of whether the data came from a synthetic persona or live mainnet extraction.
 */
export function scoreFeatureVector(vector: FeatureVector): RiskExplanation {
  const rawContributions = [
    scoreWalletAge(vector.walletAgeDays),
    scoreTxCount(vector.totalTxCount),
    scoreProtocolUsage(vector.uniqueProtocolsUsed),
    scoreDeFiLoans(vector.aaveLoansTaken, vector.aaveLoansRepaid, vector.aaveLiquidations),
    scoreBalance(vector.avgBalanceUsd90d),
    scoreMixerInteraction(vector.mixerInteraction),
    scoreIncomeBand(vector.incomeBand),
    scoreEmployment(vector.employmentType),
  ];

  const contributions: FeatureContribution[] = rawContributions.map((c, i) => ({
    ...c,
    weight: FEATURE_WEIGHTS[i],
  }));

  const overallScore = Math.max(
    -1,
    Math.min(1, contributions.reduce((sum, c) => sum + c.score * c.weight, 0))
  );

  const tier: RiskTier =
    overallScore >= TIER_THRESHOLDS.A
      ? 'A'
      : overallScore >= TIER_THRESHOLDS.B
      ? 'B'
      : 'C';

  return { tier, overallScore, contributions };
}

/** Convenience adapter: score a BorrowerPersona by converting it to a FeatureVector first. */
export function explainPersonaRisk(persona: BorrowerPersona): RiskExplanation {
  return scoreFeatureVector({
    ...persona.simulatedOnChainFeatures,
    ...persona.offChainMetadata,
    source: 'persona',
    personaId: persona.id,
    walletAddress: persona.testnetWallet,
  });
}
