'use client';

import { useState, useMemo, useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance, useSwitchChain, useReadContract } from 'wagmi';
import { decodeEventLog } from 'viem';
import { parseEther } from 'viem';
import { sepolia, hardhat } from 'wagmi/chains';
import { BORROWER_PERSONAS, type BorrowerPersona } from '../lib/borrower-personas';
import { scoreFeatureVector, type RiskExplanation, type FeatureVector } from '../lib/risk-explainer';
import type { OffChainMetadata } from '../lib/borrower-personas';
import { RISK_TIER_CONFIG, BASE_APR, calculateProtocolLoanTerms, type LoanTermSheet } from '../lib/loan-terms';
import { formatUsd, formatPercent } from '../lib/format';
import { RiskExplanationPanel } from './RiskExplanationPanel';
import { storeLoanTx, MAX_OPEN_REQUESTS } from './BorrowerLoansSection';
import {
  Clock, ArrowUp, Globe, ClipboardList, Coins, Lock, Briefcase, BriefcaseBusiness,
  Search, UserRound, Zap, Check, AlertTriangle, ShieldCheck,
} from 'lucide-react';

type Props = {
  ethPrice: number;
  networkMode?: 'local' | 'testnet';
  onTierChange?: (tier: 'A' | 'B' | 'C' | null, score: number | null) => void;
  onLoanCreated?: (txHash: string, loanId: string) => void;
  onPersonaChange?: (persona: BorrowerPersona | null) => void;
  pendingLoanCount?: number;
};

type WizardStep = 0 | 1 | 2 | 3;
type EvalMode = 'persona' | 'wallet';

// Max collateral we'll actually send on-chain for any demo tx (keeps Sepolia cost near-zero)
const DEMO_MAX_COLLATERAL_ETH = 0.005;

const LOAN_STATUS_ABI = [
  { name: 'status', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
] as const;

const LOAN_FACTORY_ABI = [
  {
    name: 'createLoan',
    type: 'function',
    inputs: [
      { name: 'principalAmount', type: 'uint256' },
      { name: 'durationDays', type: 'uint256' },
      { name: 'interestBps', type: 'uint256' },
      { name: 'maxLtvBps', type: 'uint256' },
      { name: 'liquidationBufferBps', type: 'uint256' },
    ],
    outputs: [
      { name: 'loanId', type: 'uint256' },
      { name: 'loanContract', type: 'address' },
    ],
    stateMutability: 'payable',
  },
  {
    name: 'LoanCreated',
    type: 'event',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'loanContract', type: 'address', indexed: true },
      { name: 'principalAmount', type: 'uint256', indexed: false },
      { name: 'collateralAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;

const TIER_BADGE: Record<string, string> = {
  A: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  B: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  C: 'bg-red-500/20 text-red-400 border-red-500/40',
};

const TIER_GLOW: Record<string, string> = {
  A: 'border-emerald-500/30 bg-emerald-500/5',
  B: 'border-amber-500/30 bg-amber-500/5',
  C: 'border-red-500/30 bg-red-500/5',
};

const DURATIONS = [
  // 1d is a short duration for manually testing the repayment-deadline /
  // liquidation path on a real network without waiting 7+ days. Keep or
  // remove once that testing is done — it's genuinely useful for demos too.
  { days: 1, label: '1d' },
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
  { days: 60, label: '60d' },
  { days: 90, label: '90d' },
];

// Off-chain answers — the only 4 questions we ask the user.
// Everything else is auto-fetched on-chain by the backend.
type OffChainAnswers = {
  claimedNoMixer: boolean;
  defiLoansTaken: number;
  defiLoansRepaid: number;
  defiLiquidations: number;
  incomeBand: OffChainMetadata['incomeBand'];
  employment: OffChainMetadata['employmentType'];
};

// Shape returned by the credit-scoring backend
type BackendScoreResult = {
  tier: 'A' | 'B' | 'C';
  overall_score: number;
  confidence: number;
  on_chain: {
    wallet_age_days: number;
    tx_count: number;
    protocols_count: number;
    balance_eth: number;
    balance_usd: number;
    mixer_detected: boolean;
    defi_repaid: number;
    defi_liquidations: number;
    platform_loans_repaid: number;
    platform_loans_defaulted: number;
  };
  credibility: {
    income_probability: number;
    employment_probability: number;
    mixer_claim_matches_chain: boolean;
    defi_claim_matches_chain: boolean;
    dishonesty_detected: boolean;
  };
  contributions: Array<{
    feature: string;
    category: 'on-chain' | 'off-chain' | 'integrity';
    source: string;
    value: string;
    score: number;
    weight: number;
    shap_value: number;
  }>;
  warnings: string[];
  fallback_used: boolean;
};

function ScoreGauge({ score, tier }: { score: number; tier: string }) {
  const pct = ((score + 1) / 2) * 100;
  const color = score >= 0.4 ? '#10b981' : score >= 0 ? '#f59e0b' : '#ef4444';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono text-slate-500">
        <span>−1.0 High risk</span>
        <span className="font-bold text-xs" style={{ color }}>
          {score >= 0 ? '+' : ''}{score.toFixed(3)} → Tier {tier}
        </span>
        <span>+1.0 Low risk</span>
      </div>
      <div className="relative h-3 w-full rounded-full bg-slate-800 overflow-hidden">
        <div className="absolute top-0 h-full w-px bg-slate-600" style={{ left: '50%' }} />
        <div className="absolute top-0 h-full w-px bg-emerald-700" style={{ left: '70%' }} />
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="flex justify-between text-[10px] text-slate-700 font-mono px-0.5">
        <span>C</span>
        <span>B ≥0.00</span>
        <span>A ≥0.40</span>
      </div>
    </div>
  );
}

function LTVBar({ ltv, threshold }: { ltv: number; threshold: number }) {
  const ltvPct = Math.min(ltv * 100, 100);
  const thresholdPct = threshold * 100;
  const color = ltv < threshold * 0.8 ? '#10b981' : ltv < threshold * 0.95 ? '#f59e0b' : '#ef4444';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-slate-500">
        <span>Current LTV: <span className="font-mono font-bold text-white">{formatPercent(ltv)}</span></span>
        <span>Liquidation at <span className="font-mono text-red-400">{formatPercent(threshold)}</span></span>
      </div>
      <div className="relative h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${ltvPct}%`, backgroundColor: color }} />
        <div className="absolute top-0 h-full w-0.5 bg-red-500/70" style={{ left: `${thresholdPct}%` }} />
      </div>
    </div>
  );
}

function WalletEvaluationForm({
  form,
  onChange,
}: {
  form: OffChainAnswers;
  onChange: (data: OffChainAnswers) => void;
}) {
  function update<K extends keyof OffChainAnswers>(key: K, value: OffChainAnswers[K]) {
    onChange({ ...form, [key]: value });
  }

  return (
    <div className="space-y-5">
      {/* Chain fetch notice */}
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
        <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Auto-fetched from Ethereum Mainnet + Sepolia</p>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Wallet age · tx count · DeFi protocols · balance · Aave V3 history · Tornado Cash. All fetched automatically when you score.
        </p>
      </div>

      {/* Q1: Mixer claim */}
      <div className="space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-white">Mixer / privacy protocol usage</p>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
              Have you ever sent funds through Tornado Cash or a privacy mixer?{' '}
              <span className="text-blue-400">We verify this on-chain.</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => update('claimedNoMixer', !form.claimedNoMixer)}
            className={`flex-shrink-0 relative h-6 w-11 rounded-full transition-colors ${!form.claimedNoMixer ? 'bg-red-600' : 'bg-emerald-700'}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${!form.claimedNoMixer ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
        <p className={`text-[11px] font-bold flex items-center gap-1 ${form.claimedNoMixer ? 'text-emerald-500' : 'text-red-400'}`}>
          {form.claimedNoMixer
            ? <><Check className="h-3 w-3 flex-shrink-0" /> Claiming: no mixer usage</>
            : <><AlertTriangle className="h-3 w-3 flex-shrink-0" /> Claiming: mixer / privacy protocol used</>}
        </p>
      </div>

      {/* Q2: DeFi loan history */}
      <div className="space-y-2">
        <div>
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">DeFi loan history (Aave, Compound, etc.)</label>
          <p className="text-[11px] text-slate-500 mt-0.5">
            How many loans taken / repaid / liquidated on DeFi protocols?{' '}
            <span className="text-blue-400">We verify on-chain.</span>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {([
            { key: 'defiLoansTaken'   as const, label: 'Loans taken',    opts: [0, 1, 2, 4], danger: false },
            { key: 'defiLoansRepaid'  as const, label: 'Repaid cleanly', opts: [0, 1, 2, 4], danger: false },
            { key: 'defiLiquidations' as const, label: 'Liquidations',   opts: [0, 1, 2],    danger: true  },
          ]).map(({ key, label, opts, danger }) => (
            <div key={key} className="space-y-1">
              <p className="text-[10px] text-slate-600">{label}</p>
              <div className="flex gap-1 flex-wrap">
                {opts.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => update(key, n)}
                    className={`px-2.5 py-1 rounded text-xs font-bold transition-all ${
                      form[key] === n
                        ? danger && n > 0 ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                        : 'border border-slate-700 text-slate-500 hover:border-slate-500'
                    }`}
                  >
                    {n === 4 ? '4+' : n}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {form.defiLiquidations > 0 && (
          <p className="text-[11px] text-red-400 font-medium flex items-center gap-1"><AlertTriangle className="h-3 w-3 flex-shrink-0" /> Prior liquidations are the heaviest negative signal in the model</p>
        )}
      </div>

      {/* Off-chain separator */}
      <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 px-4 py-3">
        <p className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">Off-chain: credibility-scored</p>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Cannot be verified on-chain. Model computes P(claim is true) from your wallet signals.
        </p>
      </div>

      {/* Q3: Income band */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Annual income band</label>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: '<30k'     as const, label: '< $30k / yr' },
            { value: '30k-50k'  as const, label: '$30k – $50k' },
            { value: '50k-100k' as const, label: '$50k – $100k' },
            { value: '>100k'    as const, label: '> $100k' },
          ]).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => update('incomeBand', value)}
              className={`py-2.5 rounded-xl text-xs font-bold transition-all ${
                form.incomeBand === value
                  ? 'bg-purple-600 text-white'
                  : 'border border-slate-700 text-slate-500 hover:border-purple-500/50 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Q4: Employment type */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Employment type</label>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: 'full-time'     as const, label: 'Full-time' },
            { value: 'self-employed' as const, label: 'Self-employed' },
            { value: 'freelance'     as const, label: 'Freelance' },
            { value: 'student'       as const, label: 'Student' },
          ]).map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => update('employment', value)}
              className={`py-2.5 rounded-xl text-xs font-bold transition-all ${
                form.employment === value
                  ? 'bg-purple-600 text-white'
                  : 'border border-slate-700 text-slate-500 hover:border-purple-500/50 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Compact summary of what was auto-fetched and credibility-scored. */
function ChainDataSummary({ data, credibility }: {
  data: BackendScoreResult['on_chain'];
  credibility: BackendScoreResult['credibility'];
}) {
  const ageStr = (() => {
    const d = data.wallet_age_days;
    if (d >= 365) return `${Math.floor(d / 365)}y ${Math.floor((d % 365) / 30)}m`;
    return d === 0 ? 'No mainnet history' : `${d} days`;
  })();
  const rows: Array<{ label: string; value: string; ok?: boolean }> = [
    { label: 'Wallet age',     value: ageStr },
    { label: 'Tx count',       value: `${data.tx_count}` },
    { label: 'DeFi protocols', value: `${data.protocols_count}` },
    { label: 'Balance',        value: `${data.balance_eth.toFixed(4)} ETH ($${data.balance_usd.toLocaleString('en-US', { maximumFractionDigits: 0 })})` },
    { label: 'Mixer / TC',     value: data.mixer_detected ? 'Detected' : 'None', ok: !data.mixer_detected },
    { label: 'Aave history',   value: `${data.defi_repaid} repaid · ${data.defi_liquidations} liquidated`, ok: data.defi_liquidations === 0 },
    { label: 'Platform loans', value: `${data.platform_loans_repaid} repaid · ${data.platform_loans_defaulted} pending` },
  ];
  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 space-y-1.5">
      <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wider mb-2 flex items-center gap-1"><Check className="h-3 w-3" /> Fetched from chain</p>
      {rows.map(({ label, value, ok }) => (
        <div key={label} className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] text-slate-500 shrink-0">{label}</span>
          <span className={`text-[11px] font-mono font-bold truncate ${ok === false ? 'text-red-400' : ok === true ? 'text-emerald-400' : 'text-white'}`}>{value}</span>
        </div>
      ))}
      <div className="pt-1.5 mt-1 border-t border-blue-500/20 grid grid-cols-2 gap-x-3 gap-y-1">
        <p className="col-span-2 text-[10px] font-bold text-purple-400 uppercase tracking-wider mb-0.5">Credibility</p>
        <span className="text-[11px] text-slate-500">Income claim</span>
        <span className="text-[11px] font-mono font-bold text-white text-right">{(credibility.income_probability * 100).toFixed(0)}% likely</span>
        <span className="text-[11px] text-slate-500">Employment</span>
        <span className="text-[11px] font-mono font-bold text-white text-right">{(credibility.employment_probability * 100).toFixed(0)}% likely</span>
        <span className="text-[11px] text-slate-500">Mixer claim</span>
        <span className={`text-[11px] font-mono font-bold text-right ${credibility.mixer_claim_matches_chain ? 'text-emerald-400' : 'text-red-400'}`}>
          {credibility.mixer_claim_matches_chain ? 'Matches' : 'Contradicts chain'}
        </span>
        <span className="text-[11px] text-slate-500">DeFi claim</span>
        <span className={`text-[11px] font-mono font-bold text-right ${credibility.defi_claim_matches_chain ? 'text-emerald-400' : 'text-amber-400'}`}>
          {credibility.defi_claim_matches_chain ? 'Consistent' : 'Minor mismatch'}
        </span>
      </div>
    </div>
  );
}

export function LoanRequestPanel({ ethPrice, networkMode = 'testnet', onTierChange, onLoanCreated, onPersonaChange, pendingLoanCount = 0 }: Props) {
  const { address, isReconnecting } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const chainId = networkMode === 'testnet' ? sepolia.id : hardhat.id;
  const { data: walletBalance } = useBalance({ address, chainId });

  const [wizardStep, setWizardStep] = useState<WizardStep>(0);
  const [evalMode, setEvalMode] = useState<EvalMode>('persona');
  const [selectedPersona, setSelectedPersona] = useState<BorrowerPersona | null>(null);
  const [riskExpl, setRiskExpl] = useState<RiskExplanation | null>(null);
  const [loanAmountUsd, setLoanAmountUsd] = useState(200);
  const [tenorDays, setTenorDays] = useState(30);
  const [txError, setTxError] = useState<string | null>(null);
  const [submittedHash, setSubmittedHash] = useState<`0x${string}` | undefined>(undefined);

  const [offChainAnswers, setOffChainAnswers] = useState<OffChainAnswers>({
    claimedNoMixer: true,
    defiLoansTaken: 0,
    defiLoansRepaid: 0,
    defiLiquidations: 0,
    incomeBand: '30k-50k',
    employment: 'full-time',
  });
  const [isScoring, setIsScoring] = useState(false);
  const [backendResult, setBackendResult] = useState<BackendScoreResult | null>(null);
  const [scoringWarnings, setScoringWarnings] = useState<string[]>([]);

  // Real wallet ETH balance (Sepolia)
  const realWalletEth = walletBalance ? parseFloat(walletBalance.formatted) : null;

  // Maximum loan USD the real wallet can afford (based on current tier, used to cap slider)
  const maxAffordableLoanUsd = useMemo(() => {
    if (!riskExpl || !realWalletEth || ethPrice <= 0) return 5000;
    const tier = RISK_TIER_CONFIG[riskExpl.tier];
    const collateralFactor = tier.maxLtv * (1 - tier.haircut);
    return Math.floor(realWalletEth * 0.9 * ethPrice * collateralFactor);
  }, [riskExpl, realWalletEth, ethPrice]);

  // termSheet must come before demoTxAmounts (depends on it)
  const termSheet = useMemo<LoanTermSheet | null>(() => {
    if (!riskExpl || ethPrice <= 0) return null;
    return calculateProtocolLoanTerms({
      riskTier: riskExpl.tier,
      loanAmountUsd,
      tenorDays,
      oraclePriceUsd: ethPrice,
    });
  }, [riskExpl, loanAmountUsd, tenorDays, ethPrice]);

  // Actual ETH amounts sent on-chain — capped to DEMO_MAX_COLLATERAL_ETH so Sepolia is near-free
  const demoTxAmounts = useMemo(() => {
    if (!riskExpl || !termSheet || ethPrice <= 0) return null;
    const tier = RISK_TIER_CONFIG[riskExpl.tier];
    const collateralFactor = tier.maxLtv * (1 - tier.haircut);
    const walletCap = realWalletEth ? realWalletEth * 0.5 : DEMO_MAX_COLLATERAL_ETH;
    const actualCollateral = Math.min(
      termSheet.requiredCollateralEth,
      walletCap,
      DEMO_MAX_COLLATERAL_ETH,
    );
    const actualPrincipal = actualCollateral * collateralFactor;
    return { actualCollateral, actualPrincipal };
  }, [riskExpl, termSheet, realWalletEth, ethPrice]);

  const { writeContractAsync, isPending: isTxPending } = useWriteContract();

  const { data: txReceipt, isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: submittedHash,
  });

  // Persist the risk explanation once the loan contract actually exists.
  //
  // The score is computed in this component and would otherwise die on unmount,
  // leaving lenders with a bare A/B/C badge. It can't be saved at submit time
  // because the Loan address only comes into existence when the transaction
  // mines, so we decode it out of the LoanCreated event in the receipt.
  // Best-effort: a failure here must never disrupt the borrower's flow — the
  // loan itself is already safely on-chain.
  const [riskSaved, setRiskSaved] = useState(false);
  const [createdLoanContract, setCreatedLoanContract] = useState<`0x${string}` | undefined>(undefined);

  // Decode the new Loan address from the receipt. Kept SEPARATE from the risk
  // save below: these were previously one effect gated on `riskExpl`, so a
  // missing assessment meant the address was never decoded, which in turn left
  // the "What happens next" timeline frozen on step 1 forever.
  useEffect(() => {
    if (!isConfirmed || !txReceipt || createdLoanContract) return;

    for (const log of txReceipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: LOAN_FACTORY_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'LoanCreated') {
          setCreatedLoanContract((decoded.args as { loanContract: `0x${string}` }).loanContract);
          return;
        }
      } catch {
        // Not a LoanCreated log (the vault emits its own) — keep looking.
      }
    }
  }, [isConfirmed, txReceipt, createdLoanContract]);

  // Persist the risk explanation once we know which loan it belongs to.
  // Best-effort: a failure here must never disrupt the borrower's flow — the
  // loan itself is already safely on-chain.
  useEffect(() => {
    if (!createdLoanContract || !riskExpl || riskSaved) return;

    setRiskSaved(true);
    void fetch('/api/loans/risk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loanContract: createdLoanContract,
        chainId,
        borrowerWallet: address,
        tier: riskExpl.tier,
        overallScore: riskExpl.overallScore,
        contributions: riskExpl.contributions,
        source: evalMode === 'persona' ? 'persona' : 'wallet',
        personaId: selectedPersona?.id ?? null,
      }),
    }).catch((err) => console.error('[risk-persist]', err));
  }, [createdLoanContract, riskExpl, riskSaved, chainId, address, evalMode, selectedPersona]);

  // "What happens next" used to be a static list with `done` hardcoded, so it
  // never moved past step 1 no matter what happened on-chain. Follow the real
  // loan status instead.
  const { data: createdLoanStatus } = useReadContract({
    address: createdLoanContract,
    abi: LOAN_STATUS_ABI,
    functionName: 'status',
    chainId,
    query: { enabled: Boolean(createdLoanContract), refetchInterval: 5_000 },
  });

  const factoryAddress =
    networkMode === 'testnet'
      ? process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA
      : process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL;

  const isContractDeployed = Boolean(
    factoryAddress &&
      factoryAddress !== '0xYourLocalLoanFactoryAddress' &&
      factoryAddress !== '0xYourSepoliaLoanFactoryAddress'
  );

  // Cap loan amount if it exceeds affordability (when there's a real wallet)
  useEffect(() => {
    if (maxAffordableLoanUsd < loanAmountUsd && maxAffordableLoanUsd > 0) {
      setLoanAmountUsd(Math.max(50, maxAffordableLoanUsd));
    }
  }, [maxAffordableLoanUsd, loanAmountUsd]);

  function handlePersonaSelect(persona: BorrowerPersona) {
    setSelectedPersona(persona);
    onPersonaChange?.(persona);
    const vector: FeatureVector = {
      ...persona.simulatedOnChainFeatures,
      ...persona.offChainMetadata,
      source: 'persona',
      personaId: persona.id,
      walletAddress: persona.testnetWallet,
    };
    const expl = scoreFeatureVector(vector);
    setRiskExpl(expl);
    onTierChange?.(expl.tier, expl.overallScore);
    setWizardStep(2);
  }

  function backendResultToRiskExpl(result: BackendScoreResult): RiskExplanation {
    return {
      tier: result.tier,
      overallScore: result.overall_score,
      contributions: result.contributions.map((c) => ({
        feature: c.feature,
        category: c.category === 'on-chain' ? 'on-chain' : 'off-chain',
        value: c.value,
        score: c.score,
        weight: c.weight,
        description:
          c.shap_value > 0.01
            ? `Positive contribution to tier (SHAP: +${c.shap_value.toFixed(3)})`
            : c.shap_value < -0.01
            ? `Negative contribution to tier (SHAP: ${c.shap_value.toFixed(3)})`
            : 'Minimal contribution to overall score',
      })),
    };
  }

  async function confirmWalletScore() {
    if (!address) return;
    setIsScoring(true);
    setScoringWarnings([]);
    try {
      const res = await fetch('/api/credit/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: address,
          eth_price_usd: ethPrice,
          off_chain: {
            income_band: offChainAnswers.incomeBand,
            employment_type: offChainAnswers.employment,
            claimed_no_mixer: offChainAnswers.claimedNoMixer,
            defi_loans: {
              taken: offChainAnswers.defiLoansTaken,
              repaid: offChainAnswers.defiLoansRepaid,
              liquidations: offChainAnswers.defiLiquidations,
            },
          },
        }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (data.fallback) {
        setScoringWarnings(['Credit scoring backend unavailable. Start the backend server and try again.']);
      } else if (res.ok) {
        const result = data as unknown as BackendScoreResult;
        setBackendResult(result);
        setScoringWarnings(result.warnings ?? []);
        const expl = backendResultToRiskExpl(result);
        setRiskExpl(expl);
        onTierChange?.(expl.tier, expl.overallScore);
        setWizardStep(2);
      } else {
        const detail = data.detail ? `: ${String(data.detail)}` : '';
        setScoringWarnings([`Scoring error: ${String(data.error ?? 'Unknown error')}${detail}`]);
      }
    } catch {
      setScoringWarnings(['Failed to reach credit scoring service.']);
    } finally {
      setIsScoring(false);
    }
  }

  // Switch between persona and wallet mode (can be called from any step)
  function switchMode() {
    const nextMode: EvalMode = evalMode === 'persona' ? 'wallet' : 'persona';
    setEvalMode(nextMode);
    setSelectedPersona(null);
    setRiskExpl(null);
    onTierChange?.(null, null);
    onPersonaChange?.(null);
    setWizardStep(nextMode === 'wallet' && !address ? 0 : 1);
  }

  async function submitLoan() {
    if (!termSheet || !address || !demoTxAmounts) return;
    setTxError(null);

    if (!isContractDeployed) {
      setTxError('Contracts not deployed yet. Run `npx hardhat ignition deploy` and update NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA in your env.');
      return;
    }

    // Use demo (near-free) amounts for the actual on-chain tx
    const principalWei = parseEther(demoTxAmounts.actualPrincipal.toFixed(18));
    const collateralWei = parseEther(demoTxAmounts.actualCollateral.toFixed(18));

    try {
      await switchChainAsync({ chainId });
      const hash = await writeContractAsync({
        address: factoryAddress as `0x${string}`,
        abi: LOAN_FACTORY_ABI,
        functionName: 'createLoan',
        args: [
          principalWei,
          BigInt(tenorDays),
          BigInt(termSheet.interestBps),
          BigInt(termSheet.maxLtvBps),
          BigInt(termSheet.liquidationBufferBps),
        ],
        value: collateralWei,
        chainId,
      });
      setSubmittedHash(hash);
      if (address) storeLoanTx(address, hash);
      onLoanCreated?.(hash, 'pending');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setTxError(msg.length > 140 ? msg.slice(0, 137) + '…' : msg);
    }
  }

  function reset() {
    setWizardStep(0);
    setEvalMode('persona');
    setSelectedPersona(null);
    setRiskExpl(null);
    setTxError(null);
    setSubmittedHash(undefined);
    setRiskSaved(false);
    setCreatedLoanContract(undefined);
    onTierChange?.(null, null);
    onPersonaChange?.(null);
  }

  function startWalletMode() {
    setEvalMode('wallet');
    setWizardStep(1);
  }

  const STEP_LABELS = ['Mode', 'Profile', 'Configure', 'Review'];

  const sliderMax = Math.min(riskExpl && realWalletEth ? maxAffordableLoanUsd : 5000, 5000);

  return (
    <div className="rounded-2xl border border-slate-800 bg-[#111827] flex flex-col overflow-hidden">

      {/* Header + step progress */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-800">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-black text-white uppercase tracking-widest">New Loan Request</h2>
          <div className="flex items-center gap-3">
            {/* Mode switcher — visible from step 1 onwards */}
            {wizardStep >= 1 && (
              <button
                onClick={switchMode}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-900/50 hover:border-slate-500 transition-colors"
                title="Switch between demo profile and real wallet mode"
              >
                {evalMode === 'persona'
                  ? <UserRound className="h-4 w-4" />
                  : <Search className="h-4 w-4" />}
                <span className="text-[10px] font-bold text-slate-400">
                  {evalMode === 'persona' ? 'Demo' : 'My Wallet'}
                </span>
                <span className="text-[10px] text-slate-600">↔ switch</span>
              </button>
            )}
            {wizardStep > 0 && (
              <button onClick={reset} className="text-xs text-slate-600 hover:text-slate-400 transition-colors">
                ← Start over
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className="flex items-center gap-1 flex-1">
              <div className={`flex items-center gap-1.5 flex-1 ${i <= wizardStep ? 'opacity-100' : 'opacity-30'}`}>
                <div className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${i < wizardStep ? 'bg-emerald-400' : i === wizardStep ? 'bg-blue-400 animate-pulse' : 'bg-slate-700'}`} />
                <span className={`text-[10px] font-bold tracking-wider ${i < wizardStep ? 'text-emerald-500' : i === wizardStep ? 'text-blue-400' : 'text-slate-600'}`}>
                  {label}
                </span>
              </div>
              {i < STEP_LABELS.length - 1 && (
                <div className={`h-px flex-1 mx-1 ${i < wizardStep ? 'bg-emerald-500/40' : 'bg-slate-800'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="p-6 overflow-y-auto">

        {/* ── Step 0: Choose mode ── */}
        {wizardStep === 0 && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">How would you like to get your risk score?</p>
            <div className="grid grid-cols-2 gap-3">

              {/* Demo persona — shown first to encourage exploration */}
              <button
                onClick={() => { setEvalMode('persona'); setWizardStep(1); }}
                className="group p-5 rounded-xl border border-emerald-500/20 hover:border-emerald-500/40 hover:bg-emerald-500/5 bg-emerald-500/5 text-left transition-all"
              >
                <div className="mb-3"><UserRound className="h-7 w-7 text-emerald-400" /></div>
                <p className="text-sm font-black text-white mb-1">Demo Profile</p>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Explore loan terms with pre-built borrower profiles. All three risk tiers covered, no wallet needed.
                </p>
                <div className="mt-3 flex gap-1.5">
                  {['Tier A', 'Tier B', 'Tier C'].map((t) => (
                    <span key={t} className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">{t}</span>
                  ))}
                </div>
              </button>

              {/* My Wallet */}
              <button
                onClick={startWalletMode}
                disabled={!address}
                className="group p-5 rounded-xl border border-slate-700 hover:border-slate-500/50 hover:bg-slate-800/50 text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <div className="mb-3"><Search className="h-7 w-7 text-slate-400 group-hover:text-white transition-colors" /></div>
                <p className="text-sm font-black text-white mb-1">My Wallet</p>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Score your real on-chain history. Transaction count is auto-fetched; off-chain fields are self-reported.
                </p>
                {!address && (
                  <span className={`mt-3 inline-block text-[10px] font-bold px-2 py-0.5 rounded border ${
                    isReconnecting
                      ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
                      : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                  }`}>
                    {isReconnecting ? 'Connecting…' : 'Connect wallet first'}
                  </span>
                )}
                {address && (
                  <div className="mt-3 flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    <span className="text-[10px] font-mono text-slate-400">
                      {address.slice(0, 6)}…{address.slice(-4)}
                    </span>
                  </div>
                )}
              </button>
            </div>

            {/* Model transparency note */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-4">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">How the risk model works</p>
              <p className="text-xs text-slate-600 leading-relaxed">
                Your score is computed from <span className="text-white font-bold">8 weighted factors</span>, a transparent rules-based model you can fully audit.
                Every factor&apos;s contribution to your score is shown in plain English.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-1 text-[11px] text-slate-600">
                {[
                  { Icon: Clock,             label: 'Wallet age (15%)' },
                  { Icon: ClipboardList,     label: 'Loan history (25%)' },
                  { Icon: ArrowUp,           label: 'Activity level (10%)' },
                  { Icon: Coins,             label: 'Avg. balance (10%)' },
                  { Icon: Globe,             label: 'Apps used (10%)' },
                  { Icon: Lock,              label: 'Privacy tools (15%)' },
                  { Icon: Briefcase,         label: 'Income (10%)' },
                  { Icon: BriefcaseBusiness, label: 'Job type (5%)' },
                ].map(({ Icon, label }) => (
                  <span key={label} className="flex items-center gap-1">
                    <Icon className="h-3 w-3 flex-shrink-0" />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 1A: Select Demo Persona ── */}
        {wizardStep === 1 && evalMode === 'persona' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">Select a demo borrower profile</p>
              <button onClick={() => setWizardStep(0)} className="text-xs text-slate-600 hover:text-slate-400 transition-colors">← Back</button>
            </div>

            <div className="space-y-2">
              {BORROWER_PERSONAS.map((p) => {
                const tierCfg = RISK_TIER_CONFIG[p.expectedTier];
                const apr = (BASE_APR + tierCfg.aprSpread) * 100;
                return (
                  <button
                    key={p.id}
                    onClick={() => handlePersonaSelect(p)}
                    className={`w-full p-4 rounded-xl border transition-all text-left ${TIER_GLOW[p.expectedTier]}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-sm font-black text-white">{p.displayName}</span>
                          <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded border ${TIER_BADGE[p.expectedTier]}`}>
                            Tier {p.expectedTier}
                          </span>
                          <span className="text-[10px] text-slate-600 font-mono">
                            {p.expectedTier === 'A' ? '+0.500' : p.expectedTier === 'B' ? '+0.025' : '−0.370'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 leading-relaxed">{p.description}</p>
                        {/* Fake address + demo balance */}
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-[10px] font-mono text-slate-600">
                            {p.testnetWallet.slice(0, 8)}…{p.testnetWallet.slice(-6)}
                          </span>
                          <span className="text-[10px] font-mono font-bold text-amber-400">{p.demoEthBalance} ETH ★</span>
                          <span className="text-[10px] text-slate-700">(demo balance)</span>
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right space-y-0.5">
                        <p className="text-xs font-mono font-bold text-white">{apr.toFixed(1)}% APR</p>
                        <p className="text-[11px] text-slate-500">Max LTV: {(tierCfg.maxLtv * 100).toFixed(0)}%</p>
                        <p className="text-[11px] text-slate-600">Haircut: {(tierCfg.haircut * 100).toFixed(0)}%</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step 1B: My Wallet Form ── */}
        {wizardStep === 1 && evalMode === 'wallet' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-white">Wallet Evaluation</p>
                <p className="text-[11px] text-slate-500 mt-0.5">Answer 4 questions. Everything else is fetched on-chain.</p>
              </div>
              <button onClick={() => setWizardStep(0)} className="text-xs text-slate-600 hover:text-slate-400 transition-colors">← Back</button>
            </div>

            <WalletEvaluationForm
              form={offChainAnswers}
              onChange={setOffChainAnswers}
            />

            {scoringWarnings.length > 0 && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 space-y-1">
                {scoringWarnings.map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-400">{w}</p>
                ))}
              </div>
            )}

            <button
              onClick={() => void confirmWalletScore()}
              disabled={isScoring || !address}
              className="w-full h-11 rounded-xl bg-purple-600 hover:bg-purple-500 text-sm font-black text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isScoring ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Analyzing Ethereum Mainnet + Sepolia…
                </>
              ) : (
                'Score My Wallet →'
              )}
            </button>
          </div>
        )}

        {/* ── Step 2: Loan Configuration ── */}
        {wizardStep === 2 && riskExpl && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-black text-white">
                  {evalMode === 'persona' ? selectedPersona?.displayName ?? 'Profile' : 'My Wallet'}
                </span>
                <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded border ${TIER_BADGE[riskExpl.tier]}`}>
                  Tier {riskExpl.tier}
                </span>
              </div>
              <button
                onClick={() => setWizardStep(1)}
                className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
              >
                ← Change
              </button>
            </div>

            {/* Score gauge */}
            <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3 space-y-2">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Risk Score</span>
              <ScoreGauge score={riskExpl.overallScore} tier={riskExpl.tier} />
            </div>

            {/* On-chain data summary — only shown after real wallet scoring */}
            {evalMode === 'wallet' && backendResult && (
              <ChainDataSummary data={backendResult.on_chain} credibility={backendResult.credibility} />
            )}

            {/* Warnings from backend */}
            {evalMode === 'wallet' && scoringWarnings.length > 0 && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 space-y-1">
                {scoringWarnings.map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-400">{w}</p>
                ))}
              </div>
            )}

            {/* Plain-English feature breakdown */}
            <div className="rounded-xl border border-slate-700 overflow-hidden">
              <div className="px-3 py-2 bg-slate-900/50 border-b border-slate-700">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  What went into your score: {evalMode === 'persona' ? 'demo data' : 'your wallet'}
                </p>
              </div>
              <div className="bg-[#111827]">
                <RiskExplanationPanel
                  explanation={riskExpl}
                  personaName={evalMode === 'persona' ? (selectedPersona?.displayName ?? 'Profile') : 'My Wallet'}
                />
              </div>
            </div>

            {/* Loan amount */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Loan Amount (USD)</label>
                {realWalletEth !== null && riskExpl && (
                  <span className="text-[10px] text-emerald-400 font-mono">
                    Wallet max: {formatUsd(maxAffordableLoanUsd)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3">
                <span className="text-slate-500 font-bold text-sm">$</span>
                <input
                  type="number"
                  min={50}
                  max={sliderMax}
                  step={50}
                  value={loanAmountUsd}
                  onChange={(e) => setLoanAmountUsd(Math.min(sliderMax, Math.max(50, Number(e.target.value))))}
                  className="flex-1 bg-transparent text-white font-mono text-lg font-bold outline-none"
                />
                {ethPrice > 0 && (
                  <span className="text-xs text-slate-600 font-mono">{(loanAmountUsd / ethPrice).toFixed(4)} ETH</span>
                )}
              </div>
              <input
                type="range"
                min={50}
                max={sliderMax}
                step={50}
                value={loanAmountUsd}
                onChange={(e) => setLoanAmountUsd(Number(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] font-mono text-slate-600">
                <span>$50</span>
                <span>{formatUsd(sliderMax / 2)}</span>
                <span>{formatUsd(sliderMax)}</span>
              </div>
            </div>

            {/* Duration */}
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Duration</label>
              <div className="flex gap-2">
                {DURATIONS.map(({ days, label }) => (
                  <button
                    key={days}
                    onClick={() => setTenorDays(days)}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                      tenorDays === days
                        ? 'bg-blue-600 text-white'
                        : 'border border-slate-700 text-slate-500 hover:border-blue-500/50 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Computed terms */}
            {termSheet && (
              <div className="rounded-xl border border-slate-700 bg-slate-900/30 p-4 space-y-3">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Computed Terms</p>
                <LTVBar ltv={termSheet.initialLtv} threshold={termSheet.liquidationThreshold} />
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 pt-2">
                  {[
                    { label: 'Required collateral', value: `${termSheet.requiredCollateralEth.toFixed(4)} ETH`, sub: formatUsd(termSheet.requiredCollateralValueUsd) },
                    { label: 'APR', value: formatPercent(termSheet.finalApr), sub: `Base 6% + ${formatPercent(termSheet.tierConfig.aprSpread)} tier spread` },
                    { label: 'Interest due', value: formatUsd(termSheet.interestDueUsd), sub: `over ${tenorDays} days` },
                    { label: 'Total repayment', value: formatUsd(termSheet.totalRepaymentUsd), sub: 'principal + interest' },
                  ].map(({ label, value, sub }) => (
                    <div key={label}>
                      <p className="text-[10px] text-slate-500">{label}</p>
                      <p className="text-sm font-mono font-bold text-white">{value}</p>
                      <p className="text-[10px] text-slate-600">{sub}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => setWizardStep(3)}
              disabled={!termSheet}
              className="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-black text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Review & Submit →
            </button>
          </div>
        )}

        {/* ── Step 3: Review & Submit ── */}
        {wizardStep === 3 && riskExpl && termSheet && (
          <div className="space-y-4">
            {!submittedHash && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-500">Review all terms before submitting to Sepolia</p>
                  <button onClick={() => setWizardStep(2)} className="text-xs text-slate-600 hover:text-slate-400 transition-colors">← Edit</button>
                </div>

                {/* Display values (what's shown in the UI) */}
                <div className={`rounded-xl border p-4 ${TIER_GLOW[riskExpl.tier]}`}>
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Loan Summary (Display Values)</p>
                  {[
                    { label: 'Profile', value: evalMode === 'persona' ? `${selectedPersona?.displayName ?? 'Demo'} (simulated data)` : 'My Wallet (self-reported)' },
                    { label: 'Risk tier', value: `${RISK_TIER_CONFIG[riskExpl.tier].label}: ${RISK_TIER_CONFIG[riskExpl.tier].borrowerRisk}` },
                    { label: 'Risk score', value: `${riskExpl.overallScore >= 0 ? '+' : ''}${riskExpl.overallScore.toFixed(3)}` },
                    { label: 'Principal (display)', value: `${formatUsd(loanAmountUsd)} ≈ ${(loanAmountUsd / ethPrice).toFixed(4)} ETH` },
                    { label: 'Duration', value: `${tenorDays} days` },
                    { label: 'APR', value: formatPercent(termSheet.finalApr) },
                    { label: 'Collateral (display)', value: `${termSheet.requiredCollateralEth.toFixed(4)} ETH (${formatUsd(termSheet.requiredCollateralValueUsd)})` },
                    { label: 'Interest owed', value: formatUsd(termSheet.interestDueUsd) },
                    { label: 'Total repayment', value: formatUsd(termSheet.totalRepaymentUsd) },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between items-baseline py-1.5 border-b border-slate-800/50 last:border-0">
                      <span className="text-xs text-slate-500">{label}</span>
                      <span className="text-xs font-mono font-bold text-white">{value}</span>
                    </div>
                  ))}
                </div>

                {/* Actual Sepolia transaction amounts — near-free */}
                {demoTxAmounts && (
                  <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 px-4 py-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-blue-400 flex-shrink-0" />
                      <p className="text-xs font-bold text-blue-400">Actual Sepolia Transaction (near-free)</p>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      Display values above are for illustration. The actual on-chain transaction uses the minimum viable amounts so you don&apos;t need lots of testnet ETH.
                    </p>
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <p className="text-[10px] text-slate-500">On-chain principal</p>
                        <p className="text-sm font-mono font-bold text-white">{demoTxAmounts.actualPrincipal.toFixed(6)} ETH</p>
                        <p className="text-[10px] text-slate-600">{formatUsd(demoTxAmounts.actualPrincipal * ethPrice)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500">Collateral you lock</p>
                        <p className="text-sm font-mono font-bold text-blue-300">{demoTxAmounts.actualCollateral.toFixed(6)} ETH</p>
                        <p className="text-[10px] text-slate-600">{formatUsd(demoTxAmounts.actualCollateral * ethPrice)}</p>
                      </div>
                    </div>
                    <p className="text-[10px] text-emerald-400/80">
                      Get free Sepolia ETH at <a href="https://sepoliafaucet.com" target="_blank" rel="noopener noreferrer" className="underline">sepoliafaucet.com</a> if needed. 0.01 ETH is more than enough.
                    </p>
                  </div>
                )}

                {/* Real wallet notice for persona mode */}
                {evalMode === 'persona' && address && (
                  <div className="rounded-xl border border-slate-700 bg-slate-900/30 px-4 py-3">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Transaction wallet</p>
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                      <span className="text-xs font-mono text-white">{address.slice(0, 8)}…{address.slice(-6)}</span>
                      <span className="text-[10px] text-slate-500">(your real Sepolia wallet; demo profile used for scoring only)</span>
                    </div>
                  </div>
                )}

                {!isContractDeployed && (
                  <div className="rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3">
                    <p className="text-xs font-bold text-slate-400">Contracts not deployed yet</p>
                    <p className="text-[11px] text-slate-600 mt-1 font-mono">
                      cd contracts && npx hardhat ignition deploy ignition/modules/NexusFiMilestone1.ts --network sepolia
                    </p>
                    <p className="text-[11px] text-slate-600 mt-0.5">Then set NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA in frontend/.env.local</p>
                  </div>
                )}

                {txError && (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
                    <p className="text-xs font-bold text-red-400">Transaction error</p>
                    <p className="text-[11px] text-red-300/70 mt-0.5 font-mono break-all">{txError}</p>
                  </div>
                )}

                {pendingLoanCount >= MAX_OPEN_REQUESTS && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                    <p className="text-xs font-bold text-amber-400">
                      Limit reached: {MAX_OPEN_REQUESTS} pending requests maximum
                    </p>
                    <p className="text-[11px] text-amber-300/70 mt-0.5">
                      You have {pendingLoanCount} open loan requests. A lender must fund (or one must expire) before you can submit another.
                    </p>
                  </div>
                )}

                <button
                  onClick={() => void submitLoan()}
                  disabled={isTxPending || !address || pendingLoanCount >= MAX_OPEN_REQUESTS}
                  className="w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-sm font-black text-slate-950 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
                >
                  {isTxPending ? (
                    <>
                      <span className="h-4 w-4 rounded-full border-2 border-slate-800 border-t-transparent animate-spin" />
                      Confirm in wallet…
                    </>
                  ) : !address ? (
                    'Connect wallet to submit'
                  ) : pendingLoanCount >= MAX_OPEN_REQUESTS ? (
                    `Max ${MAX_OPEN_REQUESTS} pending requests reached`
                  ) : (
                    <><Lock className="h-4 w-4" /> Submit Loan Request to Sepolia</>

                  )}
                </button>
              </>
            )}

            {/* Post-submission state */}
            {submittedHash && (
              <div className="space-y-4">
                <div className={`rounded-xl border px-5 py-4 ${isConfirmed ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-blue-500/30 bg-blue-500/5'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {!isConfirmed && <span className="h-3.5 w-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin flex-shrink-0" />}
                    {isConfirmed && <Check className="h-4 w-4 text-emerald-400 flex-shrink-0" />}
                    <p className="text-sm font-black text-white">
                      {isConfirmed ? 'Loan request live on Sepolia!' : 'Waiting for confirmation…'}
                    </p>
                  </div>
                  <a
                    href={`https://sepolia.etherscan.io/tx/${submittedHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-mono text-blue-400 hover:text-blue-300 break-all"
                  >
                    {submittedHash.slice(0, 22)}…{submittedHash.slice(-8)} ↗
                  </a>
                </div>

                {isConfirmed && demoTxAmounts && (
                  <div className="rounded-xl border border-slate-700 bg-slate-900/30 p-4">
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-4">What happens next</p>
                    <ol className="space-y-3">
                      {(() => {
                        const st = createdLoanStatus === undefined ? 0 : Number(createdLoanStatus);
                        const funded = st >= 1 && st !== 3;
                        const closed = st === 2;
                        const liquidated = st === 4;
                        return [
                          { Icon: Check, done: true, label: 'Loan contract deployed', desc: `CollateralVault holds your ${demoTxAmounts.actualCollateral.toFixed(6)} ETH` },
                          { Icon: funded ? Check : Clock, done: funded, label: funded ? 'Lender funded your request' : 'Awaiting a lender (up to 7 days)', desc: `Lender sends ${demoTxAmounts.actualPrincipal.toFixed(6)} ETH to fund your request` },
                          { Icon: Check, done: funded, label: 'You receive the principal', desc: `${demoTxAmounts.actualPrincipal.toFixed(6)} ETH sent to your wallet` },
                          { Icon: ShieldCheck, done: closed, label: 'Repay to unlock collateral', desc: liquidated ? 'Loan was liquidated — collateral went to the lender' : `Repay within ${tenorDays} days to get your ETH back` },
                          { Icon: Check, done: closed, label: 'Collateral returned', desc: `Your ${demoTxAmounts.actualCollateral.toFixed(6)} ETH released from vault` },
                        ];
                      })().map(({ Icon, done, label, desc }) => (
                        <li key={label} className="flex items-start gap-3">
                          <span className={`flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full ${done ? 'bg-emerald-500 text-slate-950' : 'border border-slate-700 text-slate-500'}`}>
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <div>
                            <p className={`text-xs font-bold ${done ? 'text-emerald-400' : 'text-slate-400'}`}>{label}</p>
                            <p className="text-[11px] text-slate-600">{desc}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <button onClick={reset} className="w-full text-xs font-bold text-slate-500 hover:text-emerald-400 transition-colors py-2">
                  + Request another loan
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
