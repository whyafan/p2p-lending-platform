'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount, useBalance } from 'wagmi';
import { useHydrated } from '../../hooks/useHydrated';
import { formatEther } from 'viem';
import { PriceTicker } from '../../components/PriceTicker';
import { LoanRequestPanel } from '../../components/LoanRequestPanel';
import { LenderDashboard } from '../../components/LenderDashboard';
import { BorrowerLoansSection } from '../../components/BorrowerLoansSection';
import type { BorrowerPersona } from '../../lib/borrower-personas';
import { useCompliance } from '../../hooks/useCompliance';
import { useTokenPrices } from '../../hooks/useTokenPrices';
import { createClient } from '../../lib/supabase/client';
import { RISK_TIER_CONFIG, BASE_APR } from '../../lib/loan-terms';
import { formatUsd, formatPercent } from '../../lib/format';
import { BlockchainNews } from '../../components/BlockchainNews';
import { MarketPulseBar } from '../../components/MarketPulseBar';
import {
  Lock, UserRound, GraduationCap, Banknote, ShieldCheck,
  Handshake, CheckCircle2, Info,
} from 'lucide-react';

type RoleView = 'borrower' | 'lender';

const TIER_COLORS = {
  A: { ring: 'ring-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400', badge: 'bg-emerald-500 text-slate-950', dot: 'bg-emerald-400' },
  B: { ring: 'ring-amber-500/30', bg: 'bg-amber-500/10', text: 'text-amber-400', badge: 'bg-amber-500 text-slate-950', dot: 'bg-amber-400' },
  C: { ring: 'ring-red-500/30', bg: 'bg-red-500/10', text: 'text-red-400', badge: 'bg-red-500 text-white', dot: 'bg-red-400' },
} as const;

const TIER_DESC = { A: 'Low risk', B: 'Medium risk', C: 'High risk' };

function StatCard({ label, value, sub, accent, pulse, onClick, cta }: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  pulse?: boolean;
  onClick?: () => void;
  cta?: boolean;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`rounded-xl border border-slate-800 bg-[#111827] px-5 py-4 text-left w-full transition-all ${
        onClick ? 'hover:border-blue-500/30 hover:bg-blue-500/5 cursor-pointer group' : ''
      }`}
    >
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">{label}</p>
      <div className="flex items-baseline gap-2">
        {pulse && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />}
        <p className={`text-xl font-mono font-black ${accent ?? 'text-white'}`}>{value}</p>
      </div>
      {sub && (
        <p className={`text-[11px] mt-0.5 font-mono ${cta ? 'text-blue-400/70 group-hover:text-blue-400' : 'text-slate-600'}`}>
          {sub}
        </p>
      )}
    </Wrapper>
  );
}

function MarketRatesCard({ activeTier }: { activeTier: 'A' | 'B' | 'C' | null }) {
  const tiers = ['A', 'B', 'C'] as const;
  return (
    <div className="rounded-2xl border border-slate-800 bg-[#111827] p-5">
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Market Rates</p>
      <div className="space-y-1">
        <div className="grid grid-cols-4 gap-2 pb-2 border-b border-slate-800">
          {['Tier', 'APR', 'Max LTV', 'Liq. at'].map((h) => (
            <span key={h} className="text-[10px] font-bold text-slate-600 uppercase tracking-wide">{h}</span>
          ))}
        </div>
        {tiers.map((tier) => {
          const cfg = RISK_TIER_CONFIG[tier];
          const apr = BASE_APR + cfg.aprSpread;
          const isActive = activeTier === tier;
          const tc = TIER_COLORS[tier];
          return (
            <div
              key={tier}
              className={`grid grid-cols-4 gap-2 py-2 rounded-lg transition-colors ${isActive ? `${tc.bg} px-2 -mx-2` : ''}`}
            >
              <span className={`text-xs font-black ${tc.text}`}>
                {isActive && <span className={`inline-block h-1.5 w-1.5 rounded-full ${tc.dot} mr-1.5`} />}
                {cfg.label}
              </span>
              <span className={`text-xs font-mono font-bold ${isActive ? tc.text : 'text-white'}`}>{formatPercent(apr)}</span>
              <span className="text-xs font-mono text-slate-400">{(cfg.maxLtv * 100).toFixed(0)}%</span>
              <span className="text-xs font-mono text-slate-400">{((cfg.maxLtv + cfg.liquidationBuffer) * 100).toFixed(0)}%</span>
            </div>
          );
        })}
      </div>

      <div className="mt-4 pt-3 border-t border-slate-800 space-y-1.5">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">How APR is calculated</p>
        <p className="text-[11px] text-slate-600 font-mono">APR = Base (6%) + Tier spread</p>
        <p className="text-[11px] text-slate-600 font-mono">Collateral = Loan ÷ (LTV × (1 − haircut))</p>
        <p className="text-[11px] text-slate-600 font-mono">Interest = Principal × APR × (days ÷ 365)</p>
      </div>
    </div>
  );
}

function RiskProfileCard({
  tier,
  score,
  onExpand,
}: {
  tier: 'A' | 'B' | 'C' | null;
  score: number | null;
  onExpand: () => void;
}) {
  if (!tier || score === null) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-[#111827] p-5">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Risk Profile</p>
        <div className="flex items-center gap-3 py-4">
          <div className="h-10 w-10 rounded-full border-2 border-dashed border-slate-700 flex items-center justify-center text-slate-600 text-lg">?</div>
          <div>
            <p className="text-sm text-slate-500">No profile selected</p>
            <p className="text-xs text-slate-700">Select a demo persona to see your risk score</p>
          </div>
        </div>
      </div>
    );
  }

  const tc = TIER_COLORS[tier];
  const pct = ((score + 1) / 2) * 100;
  const cfg = RISK_TIER_CONFIG[tier];

  return (
    <div className={`rounded-2xl border bg-[#111827] p-5 ring-1 ${tc.ring}`}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Risk Profile</p>
        <button onClick={onExpand} className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition-colors">
          Full breakdown ↗
        </button>
      </div>

      <div className="flex items-start gap-4">
        <div className={`flex-shrink-0 h-12 w-12 rounded-xl ${tc.bg} flex items-center justify-center`}>
          <span className={`text-xl font-black ${tc.text}`}>{tier}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-base font-black ${tc.text}`}>{cfg.label}</p>
          <p className="text-xs text-slate-500">{TIER_DESC[tier]}</p>
        </div>
      </div>

      <div className="mt-4 space-y-1">
        <div className="flex justify-between text-[10px] font-mono text-slate-500">
          <span>Risk score</span>
          <span className={`font-bold ${tc.text}`}>{score >= 0 ? '+' : ''}{score.toFixed(3)}</span>
        </div>
        <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, backgroundColor: tier === 'A' ? '#10b981' : tier === 'B' ? '#f59e0b' : '#ef4444' }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-slate-700 font-mono">
          <span>−1.0</span>
          <span>0</span>
          <span>+1.0</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 pt-3 border-t border-slate-800">
        <div>
          <p className="text-[10px] text-slate-500">Max LTV</p>
          <p className={`text-sm font-mono font-bold ${tc.text}`}>{(cfg.maxLtv * 100).toFixed(0)}%</p>
        </div>
        <div>
          <p className="text-[10px] text-slate-500">APR</p>
          <p className={`text-sm font-mono font-bold ${tc.text}`}>{formatPercent(BASE_APR + cfg.aprSpread)}</p>
        </div>
      </div>
    </div>
  );
}


function LockScreen({ onActivate }: { onActivate: () => void }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-[#111827] p-10 text-center max-w-lg mx-auto">
      <div className="inline-flex h-16 w-16 items-center justify-center rounded-full border border-slate-700 bg-slate-900 mb-5">
          <Lock className="h-7 w-7 text-slate-500" />
        </div>
      <h2 className="text-lg font-black text-white mb-2">Lending not activated</h2>
      <p className="text-sm text-slate-500 mb-6">
        Enable lending to browse open loan requests and earn interest on-chain.
      </p>
      <button
        onClick={onActivate}
        className="h-11 px-8 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-black text-white transition-colors"
      >
        Activate lending →
      </button>
    </div>
  );
}

export default function AppPage() {
  const router = useRouter();
  const hydrated = useHydrated();
  const compliance = useCompliance();
  const { address, isConnected, isReconnecting } = useAccount();
  const { data: balance } = useBalance({ address, chainId: 11155111 });
  const { data: priceData } = useTokenPrices();

  const ethPrice = priceData?.prices?.['ETH'] ?? priceData?.prices?.['ethereum'] ?? 0;
  const ethChange24h = (priceData?.marketData as Record<string, { usd: number; change24h: number }> | undefined)
    ?.['ethereum']?.change24h ?? null;

  const userRole = compliance.data?.userRole ?? 'borrower';
  const canLend = compliance.data?.canLend ?? false;
  const canBorrowRole = userRole === 'borrower' || userRole === 'both';

  const [activeView, setActiveView] = useState<RoleView>(
    userRole === 'lender' ? 'lender' : 'borrower'
  );
  const [borrowerTier, setBorrowerTier] = useState<'A' | 'B' | 'C' | null>(null);
  const [borrowerScore, setBorrowerScore] = useState<number | null>(null);
  const [showRiskPanel, setShowRiskPanel] = useState(false);
  const [isActivatingRole, setIsActivatingRole] = useState(false);
  const [activePersona, setActivePersona] = useState<BorrowerPersona | null>(null);
  const [pendingLoanCount, setPendingLoanCount] = useState(0);

  useEffect(() => {
    if (compliance.isLoading) return;
    if (!compliance.data?.authenticated) { router.replace('/'); return; }
    if (!compliance.data.canBorrow) { router.replace('/onboarding'); }
  }, [compliance.isLoading, compliance.data, router]);

  useEffect(() => {
    if (userRole === 'lender') setActiveView('lender');
  }, [userRole]);

  const handleTierChange = useCallback((tier: 'A' | 'B' | 'C' | null, score: number | null) => {
    setBorrowerTier(tier);
    setBorrowerScore(score);
    setShowRiskPanel(false);
  }, []);

  const handlePersonaChange = useCallback((persona: BorrowerPersona | null) => {
    setActivePersona(persona);
  }, []);

  const handleLoanCreated = useCallback((txHash: string) => {
    console.log('[dashboard] Loan submitted:', txHash);
  }, []);

  const handlePendingCountChange = useCallback((count: number) => {
    setPendingLoanCount(count);
  }, []);

  async function activateLending() {
    setIsActivatingRole(true);
    try {
      await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userRole: 'both' }),
      });
      await compliance.refetch();
      setActiveView('lender');
    } finally {
      setIsActivatingRole(false);
    }
  }

  async function signOut() {
    const supabase = createClient();
    if (supabase) await supabase.auth.signOut();
    window.location.replace('/');
  }

  if (compliance.isLoading || !compliance.data?.canBorrow) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500" />
      </div>
    );
  }

  const ethBalanceEth = balance ? parseFloat(formatEther(balance.value)) : null;
  const ethBalanceUsd = ethBalanceEth !== null && ethPrice > 0 ? ethBalanceEth * ethPrice : null;

  const networkMode: 'local' | 'testnet' =
    (process.env.NEXT_PUBLIC_NETWORK_MODE as 'local' | 'testnet') ?? 'testnet';

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <PriceTicker />

      {/* ── Sticky Header ── */}
      <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-[#0a0e1a]/95 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-xs font-black text-slate-950">NF</div>
          <span className="text-sm font-black tracking-widest text-white uppercase">NexusFi</span>
          <span className="ml-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-400 uppercase tracking-widest">
            {networkMode === 'testnet' ? 'Sepolia' : 'Local'}
          </span>
        </div>

        <div className="flex items-center gap-4">
          {isConnected && address && (
            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-mono text-slate-400">{address.slice(0, 6)}…{address.slice(-4)}</span>
              {ethBalanceEth !== null && (
                <span className="text-xs font-mono font-bold text-white">{ethBalanceEth.toFixed(4)} ETH</span>
              )}
            </div>
          )}
          {compliance.data?.user?.email && (
            <span className="hidden sm:block text-xs text-slate-600">{compliance.data.user.email}</span>
          )}
          <Link
            href="/settings"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/50 text-slate-400 hover:border-slate-500 hover:text-white transition-colors"
            title="Account settings"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </Link>
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-xs font-bold text-slate-500 hover:text-red-400 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-6 max-w-[1440px] mx-auto w-full">

        {/* ── Role Toggle ── */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex rounded-xl border border-slate-800 bg-slate-900/50 p-1 gap-1">
            <button
              onClick={() => canBorrowRole && setActiveView('borrower')}
              className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${
                activeView === 'borrower'
                  ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                  : canBorrowRole
                  ? 'text-slate-400 hover:text-white'
                  : 'text-slate-700 cursor-not-allowed'
              }`}
            >
              {!canBorrowRole && <Lock className="h-3 w-3 mr-1 inline" />}Borrow
            </button>
            <button
              onClick={() => canLend && setActiveView('lender')}
              className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${
                activeView === 'lender'
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                  : canLend
                  ? 'text-slate-400 hover:text-white'
                  : 'text-slate-700 cursor-not-allowed'
              }`}
            >
              {!canLend && <Lock className="h-3 w-3 mr-1 inline" />}Lend
            </button>
          </div>

          {(userRole === 'borrower' || userRole === 'lender') && (
            <button
              onClick={() => void activateLending()}
              disabled={isActivatingRole}
              className="text-xs font-bold text-slate-500 hover:text-emerald-400 transition-colors disabled:opacity-40"
            >
              {isActivatingRole ? '…' : `+ Activate ${userRole === 'borrower' ? 'lending' : 'borrowing'}`}
            </button>
          )}

          {/* ETH Price quick-view */}
          {ethPrice > 0 && (
            <div className="ml-auto flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-1.5">
              <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">ETH</span>
              <span className="text-sm font-mono font-bold text-white">{formatUsd(ethPrice)}</span>
              {ethChange24h !== null && (
                <span className={`text-[11px] font-bold font-mono ${ethChange24h >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {ethChange24h >= 0 ? '+' : ''}{ethChange24h.toFixed(2)}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── Borrower View ── */}
        {activeView === 'borrower' && (
          <div className="space-y-6">

            {/* Stats Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard
                label="Risk Tier"
                value={borrowerTier ?? 'N/A'}
                sub={borrowerTier ? TIER_DESC[borrowerTier] : 'Click to get scored →'}
                accent={borrowerTier ? TIER_COLORS[borrowerTier].text : 'text-slate-600'}
                onClick={!borrowerTier ? () => document.getElementById('loan-request-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : undefined}
                cta={!borrowerTier}
              />
              <StatCard
                label={activePersona ? `${activePersona.displayName}'s Balance ★ Demo` : 'Wallet Balance (Sepolia)'}
                value={
                  activePersona
                    ? `${activePersona.demoEthBalance.toFixed(2)} ETH`
                    : ethBalanceEth !== null
                    ? `${ethBalanceEth.toFixed(4)} ETH`
                    : 'N/A'
                }
                sub={
                  activePersona
                    ? `${activePersona.testnetWallet.slice(0, 8)}…${activePersona.testnetWallet.slice(-6)} · demo`
                    : ethBalanceUsd !== null
                    ? formatUsd(ethBalanceUsd)
                    : ethBalanceEth !== null
                    ? 'Fetching price…'
                    : (isReconnecting || !hydrated || isConnected)
                    ? 'Fetching balance…'
                    : 'Wallet not connected'
                }
                accent={activePersona ? 'text-amber-400' : undefined}
                pulse={!activePersona && hydrated && isConnected}
                onClick={
                  activePersona
                    ? () => window.open(`https://sepolia.etherscan.io/address/${activePersona.testnetWallet}`, '_blank')
                    : isConnected && address
                    ? () => window.open(`https://sepolia.etherscan.io/address/${address}`, '_blank')
                    : undefined
                }
                cta={activePersona !== null || (isConnected && address !== undefined)}
              />
              <StatCard
                label="Pending Requests"
                value={String(pendingLoanCount)}
                sub="View all loans below →"
                accent={pendingLoanCount > 0 ? 'text-blue-400' : 'text-white'}
                onClick={() => document.getElementById('active-loans')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                cta
              />
              <StatCard
                label="Risk Score"
                value={borrowerScore !== null ? `${borrowerScore >= 0 ? '+' : ''}${borrowerScore.toFixed(3)}` : 'N/A'}
                sub={borrowerScore !== null ? '8-feature breakdown →' : 'Click to get scored →'}
                accent={borrowerTier ? TIER_COLORS[borrowerTier].text : 'text-slate-600'}
                onClick={() => {
                  if (borrowerScore !== null) {
                    setShowRiskPanel(true);
                  } else {
                    document.getElementById('loan-request-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                cta
              />
            </div>

            {/* Market Pulse — live sentiment strip */}
            <MarketPulseBar />

            {/* Main Grid */}
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5 items-start">

              {/* Left: Loan Request Wizard + Borrower Loans + News */}
              <div className="space-y-5">
                <div id="loan-request-panel">
                  <LoanRequestPanel
                    ethPrice={ethPrice}
                    networkMode={networkMode}
                    onTierChange={handleTierChange}
                    onLoanCreated={handleLoanCreated}
                    onPersonaChange={handlePersonaChange}
                    pendingLoanCount={pendingLoanCount}
                  />
                </div>
                <div id="active-loans">
                  <BorrowerLoansSection
                    factoryAddress={
                      networkMode === 'testnet'
                        ? process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA
                        : process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL
                    }
                    chainId={networkMode === 'testnet' ? 11155111 : 31337}
                    ethPrice={ethPrice}
                    onPendingCountChange={handlePendingCountChange}
                  />
                </div>
                <BlockchainNews />
              </div>

              {/* Right: Risk Profile + Market Rates */}
              <div className="space-y-4">
                <RiskProfileCard
                  tier={borrowerTier}
                  score={borrowerScore}
                  onExpand={() => setShowRiskPanel(true)}
                />
                <MarketRatesCard activeTier={borrowerTier} />

                {/* How It Works — plain English */}
                <div className="rounded-2xl border border-slate-800 bg-[#111827] p-4">
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">How borrowing works</p>
                  <p className="text-[11px] text-slate-600 mb-3">Like a bank loan, but on-chain with no middleman.</p>
                  <ol className="space-y-3">
                    {[
                      { Icon: UserRound,     label: 'Pick a profile',              desc: 'Use a demo character to explore, or connect your own wallet.' },
                      { Icon: GraduationCap, label: 'Get your grade',              desc: 'We check 8 things about you (wallet age, history) and give you a grade: A, B, or C.' },
                      { Icon: Banknote,      label: 'Choose how much you want',    desc: 'Pick an amount and how long you need it. We show the exact interest upfront, no surprises.' },
                      { Icon: ShieldCheck,   label: 'Put up a security deposit',   desc: 'Like renting a flat: lock some ETH as security. You get it all back when you repay.' },
                      { Icon: Handshake,     label: 'A lender sends you the money', desc: 'Someone on the other side sees your request and sends you the funds directly.' },
                      { Icon: CheckCircle2,  label: 'Repay & get your deposit back', desc: 'Pay back the loan and interest on time, and your security deposit is returned instantly.' },
                    ].map(({ Icon, label, desc }) => (
                      <li key={label} className="flex items-start gap-3">
                        <Icon className="flex-shrink-0 h-4 w-4 text-slate-500 mt-0.5" />
                        <div>
                          <p className="text-xs font-bold text-slate-300">{label}</p>
                          <p className="text-[11px] text-slate-500 leading-relaxed">{desc}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-4 pt-3 border-t border-slate-800 rounded-lg bg-slate-900/50 px-3 py-2">
                    <p className="text-[10px] text-slate-600 leading-relaxed flex items-start gap-1.5">
                      <Info className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-slate-500" />
                      <span><span className="font-bold text-slate-500">On Sepolia testnet:</span> Everything here uses test ETH (worth $0). Transactions are near-free, ideal for exploring without risk.</span>
                    </p>
                  </div>
                </div>

              </div>
            </div>
          </div>
        )}

        {/* ── Lender View ── */}
        {activeView === 'lender' && (
          canLend ? (
            <LenderDashboard
              factoryAddress={
                networkMode === 'testnet'
                  ? process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA
                  : process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL
              }
              ethPrice={ethPrice}
              networkMode={networkMode}
            />
          ) : (
            <LockScreen onActivate={() => void activateLending()} />
          )
        )}
      </main>

      {/* Floating Risk Breakdown Panel */}
      {showRiskPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-white shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <p className="text-sm font-bold text-slate-700">Full Risk Breakdown</p>
              <button
                onClick={() => setShowRiskPanel(false)}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="p-1">
              {/* RiskExplanationPanel would go here if we have the data — handled via LoanRequestPanel state */}
              <p className="p-6 text-sm text-slate-500 text-center">
                Select a demo persona in the loan request panel to see the full risk breakdown.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
