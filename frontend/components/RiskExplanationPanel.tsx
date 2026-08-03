'use client';

import { useState } from 'react';
import {
  Clock,
  ArrowUp,
  Globe,
  ClipboardList,
  Coins,
  Lock,
  Briefcase,
  BriefcaseBusiness,
  Trophy,
  ThumbsUp,
  AlertTriangle,
  Check,
  Link as LinkIcon,
  FileText,
  type LucideProps,
} from 'lucide-react';
import type { RiskExplanation, FeatureContribution } from '../lib/risk-explainer';
import { TIER_THRESHOLDS } from '../lib/risk-explainer';

type Props = {
  explanation: RiskExplanation;
  personaName: string;
};

type IconComponent = React.FC<LucideProps>;

const FEATURE_META: Record<string, {
  Icon: IconComponent;
  plainName: string;
  plainDesc: string;
  goodMsg: string;
  badMsg: string;
}> = {
  'Wallet age': {
    Icon: Clock,
    plainName: 'How long you\'ve had your wallet',
    plainDesc: 'Like a bank that trusts long-term customers more. Older wallet means more trustworthy.',
    goodMsg: 'Long history builds trust',
    badMsg: 'Newer wallets are harder to assess',
  },
  'Transaction volume': {
    Icon: ArrowUp,
    plainName: 'How active your wallet is',
    plainDesc: 'More transactions means more history for lenders to review. Think of it like your purchase history.',
    goodMsg: 'Lots of activity, good track record',
    badMsg: 'Very few transactions, harder to assess',
  },
  'DeFi breadth': {
    Icon: Globe,
    plainName: 'How many crypto apps you\'ve used',
    plainDesc: 'Using multiple DeFi apps shows experience. Like knowing your way around multiple financial tools.',
    goodMsg: 'Experienced across multiple platforms',
    badMsg: 'Limited to very few platforms',
  },
  'DeFi loan history': {
    Icon: ClipboardList,
    plainName: 'Your borrowing track record',
    plainDesc: 'Have you borrowed before and paid it back? This is the biggest factor, like your credit history at a bank.',
    goodMsg: 'Clean repayment history, this is huge!',
    badMsg: 'Missed payments or liquidations found',
  },
  'Avg. balance (90d)': {
    Icon: Coins,
    plainName: 'How much you usually keep in your wallet',
    plainDesc: 'A bigger cushion means lenders feel safer. Like having savings before taking out a loan.',
    goodMsg: 'Healthy savings buffer',
    badMsg: 'Low average balance, less cushion',
  },
  'Mixer interaction': {
    Icon: Lock,
    plainName: 'Privacy tool usage',
    plainDesc: 'Some tools hide where your money comes from. Lenders see this as a red flag, like always paying cash with no receipts.',
    goodMsg: 'No privacy tools detected, clean trail',
    badMsg: 'Privacy tool usage flagged',
  },
  'Income band': {
    Icon: Briefcase,
    plainName: 'Your income level',
    plainDesc: 'Higher income means better ability to repay. You tell us this yourself. Be honest for the best result.',
    goodMsg: 'Comfortable income level',
    badMsg: 'Lower income, tighter repayment capacity',
  },
  'Employment type': {
    Icon: BriefcaseBusiness,
    plainName: 'How stable your income is',
    plainDesc: 'A steady, predictable job means predictable payments. Simple as that.',
    goodMsg: 'Stable employment',
    badMsg: 'Variable income source',
  },
};

const TIER_SUMMARY: Record<string, { Icon: IconComponent; headline: string; detail: string; color: string; iconColor: string; bg: string; border: string }> = {
  A: {
    Icon: Trophy,
    headline: 'Excellent standing, lowest rates!',
    detail: 'You look great to lenders. You get the best interest rate and can borrow more relative to your collateral.',
    color: 'text-emerald-400',
    iconColor: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
  },
  B: {
    Icon: ThumbsUp,
    headline: 'Good standing, standard rates',
    detail: 'Solid profile with some room to grow. You get reasonable rates and can still borrow comfortably.',
    color: 'text-amber-400',
    iconColor: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
  },
  C: {
    Icon: AlertTriangle,
    headline: 'High-risk profile, higher rates',
    detail: 'Lenders see more risk here. You\'ll pay a higher interest rate and need more collateral to borrow.',
    color: 'text-red-400',
    iconColor: 'text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
  },
};

function statusFor(score: number): { label: string; color: string; dot: string } {
  if (score >= 0.3) return { label: 'Great', color: 'text-emerald-400', dot: 'bg-emerald-500' };
  if (score >= -0.1) return { label: 'OK', color: 'text-amber-400', dot: 'bg-amber-400' };
  return { label: 'Concern', color: 'text-red-400', dot: 'bg-red-500' };
}

function SimpleBar({ score }: { score: number }) {
  const pct = ((score + 1) / 2) * 100;
  const color = score >= 0.3 ? '#10b981' : score >= -0.1 ? '#f59e0b' : '#ef4444';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function FeatureRow({ c }: { c: FeatureContribution }) {
  const meta = FEATURE_META[c.feature];
  const status = statusFor(c.score);
  if (!meta) return null;

  return (
    <div className="py-3 border-b border-slate-800 last:border-0">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 pt-0.5">
          <meta.Icon className="h-5 w-5 text-slate-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <p className="text-sm font-bold text-slate-200 leading-snug">{meta.plainName}</p>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className={`h-2 w-2 rounded-full flex-shrink-0 ${status.dot}`} />
              <span className={`text-xs font-bold ${status.color}`}>{status.label}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 mb-1.5">
            <span className="text-xs font-mono font-semibold text-slate-500 flex-shrink-0">{c.value}</span>
            <SimpleBar score={c.score} />
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">{meta.plainDesc}</p>
        </div>
      </div>
    </div>
  );
}

export function RiskExplanationPanel({ explanation, personaName }: Props) {
  const { tier, overallScore, contributions } = explanation;
  const [showTechDetails, setShowTechDetails] = useState(false);

  const tierInfo = TIER_SUMMARY[tier];
  const onChain = contributions.filter((c) => c.category === 'on-chain');
  const offChain = contributions.filter((c) => c.category === 'off-chain');

  return (
    <div className="bg-slate-950/40 p-5 space-y-4">

      {/* Overall grade */}
      <div className={`rounded-xl border ${tierInfo.border} ${tierInfo.bg} p-4`}>
        <div className="flex items-center gap-3">
          <tierInfo.Icon className={`h-8 w-8 flex-shrink-0 ${tierInfo.iconColor}`} />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-lg font-black text-white">Grade: {tier}</span>
              <span className={`text-sm font-bold ${tierInfo.color}`}>{tierInfo.headline}</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">{tierInfo.detail}</p>
          </div>
        </div>
        <p className="text-[10px] text-slate-500 mt-2 font-medium uppercase tracking-wider">
          For: {personaName} &bull; Score: {overallScore >= 0 ? '+' : ''}{overallScore.toFixed(3)} (A &ge; {TIER_THRESHOLDS.A} &middot; B &ge; {TIER_THRESHOLDS.B} &middot; C below)
        </p>
      </div>

      {/* On-chain signals */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="h-px flex-1 bg-slate-800" />
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <LinkIcon className="h-3 w-3 text-slate-500" />
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              Blockchain signals
            </p>
          </div>
          <div className="h-px flex-1 bg-slate-800" />
        </div>
        <p className="text-[11px] text-slate-500 mb-3 text-center">
          Pulled directly from your on-chain activity. These cannot be faked.
        </p>
        <div>
          {onChain.map((c) => <FeatureRow key={c.feature} c={c} />)}
        </div>
      </div>

      {/* Off-chain signals */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="h-px flex-1 bg-slate-800" />
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <FileText className="h-3 w-3 text-slate-500" />
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              Personal info (self-reported)
            </p>
          </div>
          <div className="h-px flex-1 bg-slate-800" />
        </div>
        <p className="text-[11px] text-slate-500 mb-3 text-center">
          You provided this info. Being accurate gets you better terms.
        </p>
        <div>
          {offChain.map((c) => <FeatureRow key={c.feature} c={c} />)}
        </div>
      </div>

      {/* Technical breakdown */}
      <div className="border-t border-slate-800 pt-3">
        <button
          type="button"
          onClick={() => setShowTechDetails((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 hover:text-slate-300 transition-colors"
        >
          <span>{showTechDetails ? '▼' : '▶'}</span>
          Show technical score details
        </button>

        {showTechDetails && (
          <div className="mt-3 rounded-lg bg-slate-900/40 border border-slate-800 p-3 space-y-2">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Score formula</p>
            <p className="text-[11px] font-mono text-slate-400 break-all">
              {contributions.map((c) => `(${(c.weight * 100).toFixed(0)}%×${(c.score >= 0 ? '+' : '')}${c.score.toFixed(2)})`).join(' + ')}
            </p>
            <p className="text-[11px] font-mono font-bold text-white">
              = {overallScore.toFixed(4)} &rarr; Tier {tier}
            </p>
            <div className="grid grid-cols-2 gap-1 pt-1 border-t border-slate-800">
              {contributions.map((c) => (
                <div key={c.feature} className="text-[10px] text-slate-500 flex justify-between pr-2">
                  <span>{c.feature}</span>
                  <span className={`font-mono font-bold ${c.score >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {(c.score >= 0 ? '+' : '')}{c.score.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
