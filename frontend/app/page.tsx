'use client';

import Link from 'next/link';
import { PriceTicker } from '../components/PriceTicker';
import { useCompliance } from '../hooks/useCompliance';
import { createClient } from '../lib/supabase/client';

export default function LandingPage() {
  const compliance = useCompliance();
  const isLoading = compliance.isLoading;
  const isAuthenticated = compliance.data?.authenticated === true;
  const isOnboarded = compliance.data?.canBorrow === true;

  async function signOut() {
    const supabase = createClient();
    if (supabase) await supabase.auth.signOut();
    window.location.replace('/');
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#0a0e1a]">
      {/* Live price marquee */}
      <PriceTicker />

      {/* Nav bar */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-xs font-black text-slate-950">
            NF
          </div>
          <span className="text-sm font-black tracking-widest text-white uppercase">NexusFi</span>
        </div>

        <nav className="flex items-center gap-3">
          {isLoading ? (
            <div className="h-8 w-20 animate-pulse rounded-lg bg-slate-800" />
          ) : !isAuthenticated ? (
            <>
              <Link
                href="/auth/login"
                className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white transition-colors"
              >
                Log in
              </Link>
              <Link
                href="/auth/signup"
                className="px-4 py-2 text-xs font-black bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-lg transition-colors"
              >
                Get started
              </Link>
            </>
          ) : (
            <div className="flex items-center gap-4">
              {compliance.data?.user?.email && (
                <span className="text-xs text-slate-500">{compliance.data.user.email}</span>
              )}
              <button
                type="button"
                onClick={() => void signOut()}
                className="text-xs font-bold text-slate-500 hover:text-red-400 transition-colors"
              >
                Sign out
              </button>
            </div>
          )}
        </nav>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-bold text-emerald-400 tracking-widest uppercase">
            Live on Ethereum
          </span>
        </div>

        <h1 className="text-5xl sm:text-7xl font-black tracking-tight text-white leading-[1.05]">
          Peer-to-Peer<br />
          <span className="text-emerald-400">Crypto Lending</span>
        </h1>

        <p className="mt-6 max-w-md text-base font-medium text-slate-400 leading-relaxed">
          Borrow against your crypto with on-chain collateral. No banks, no intermediaries, no KYC middlemen.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          {isLoading ? (
            <div className="h-12 w-40 animate-pulse rounded-xl bg-slate-800" />
          ) : !isAuthenticated ? (
            <>
              <Link
                href="/auth/signup"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 px-8 text-sm font-black text-slate-950 transition-colors shadow-lg shadow-emerald-500/20"
              >
                Start borrowing →
              </Link>
              <Link
                href="/auth/login"
                className="inline-flex h-12 items-center rounded-xl border border-slate-700 hover:border-slate-500 bg-slate-900 px-8 text-sm font-bold text-slate-300 hover:text-white transition-colors"
              >
                Log in
              </Link>
            </>
          ) : isOnboarded ? (
            <Link
              href="/app"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 px-8 text-sm font-black text-slate-950 transition-colors shadow-lg shadow-emerald-500/20"
            >
              Go to App →
            </Link>
          ) : (
            <Link
              href="/onboarding"
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 px-8 text-sm font-black text-white transition-colors shadow-lg shadow-blue-500/20"
            >
              Finish onboarding →
            </Link>
          )}
        </div>

        {/* Stats row */}
        <div className="mt-20 flex flex-wrap items-center justify-center gap-12 text-center">
          {[
            { label: 'Protocol', value: 'Trustless' },
            { label: 'Custody', value: 'Non-custodial' },
            { label: 'Settlement', value: 'On-chain' },
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-lg font-black text-white">{value}</p>
              <p className="text-xs font-medium text-slate-600 mt-0.5 tracking-widest uppercase">{label}</p>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 px-8 py-4 text-center">
        <p className="text-xs text-slate-700">NexusFi Protocol · All positions settled on Ethereum</p>
      </footer>
    </div>
  );
}
