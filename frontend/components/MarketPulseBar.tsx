'use client';

import { useQuery } from '@tanstack/react-query';
import type { MarketPulse } from '../app/api/market-pulse/route';

function fgColor(v: number): string {
  if (v <= 25) return 'text-red-400';
  if (v <= 45) return 'text-orange-400';
  if (v <= 55) return 'text-amber-400';
  if (v <= 75) return 'text-lime-400';
  return 'text-emerald-400';
}

function fgBg(v: number): string {
  if (v <= 25) return 'bg-red-500/10 border-red-500/20';
  if (v <= 45) return 'bg-orange-500/10 border-orange-500/20';
  if (v <= 55) return 'bg-amber-500/10 border-amber-500/20';
  if (v <= 75) return 'bg-lime-500/10 border-lime-500/20';
  return 'bg-emerald-500/10 border-emerald-500/20';
}

function gasColor(g: number): string {
  if (g < 5) return 'text-emerald-400';
  if (g < 20) return 'text-amber-400';
  return 'text-red-400';
}

function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${className}`}>
      {children}
    </div>
  );
}

function Skeleton() {
  return <div className="h-9 w-32 rounded-xl bg-slate-800/60 animate-pulse" />;
}

export function MarketPulseBar() {
  const { data, isLoading } = useQuery<MarketPulse>({
    queryKey: ['market-pulse'],
    queryFn: async () => {
      const res = await fetch('/api/market-pulse');
      if (!res.ok) throw new Error('pulse failed');
      return res.json();
    },
    staleTime: 2 * 60_000,
    refetchInterval: 2 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="flex flex-wrap gap-2 mb-5">
        <Skeleton /><Skeleton /><Skeleton />
      </div>
    );
  }

  const fg = data?.fearGreed;
  const tvl = data?.defiTvl;
  const gas = data?.ethGasGwei;

  if (!fg && tvl === null && gas === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 mb-5">
      <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mr-1">Market</span>

      {fg && (
        <Pill className={fgBg(fg.value)}>
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Sentiment</span>
          <div className="h-3.5 w-3.5 relative">
            {/* mini arc indicator */}
            <svg viewBox="0 0 20 20" className="w-full h-full -rotate-90">
              <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="3" className="text-slate-800" strokeDasharray="22 22" />
              <circle
                cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="3"
                className={fgColor(fg.value)}
                strokeDasharray={`${(fg.value / 100) * 22} 22`}
              />
            </svg>
          </div>
          <span className={`text-xs font-black font-mono ${fgColor(fg.value)}`}>{fg.value}</span>
          <span className={`text-[10px] font-bold ${fgColor(fg.value)}`}>{fg.label}</span>
        </Pill>
      )}

      {tvl !== null && tvl !== undefined && (
        <Pill className="bg-blue-500/10 border-blue-500/20">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">ETH DeFi TVL</span>
          <span className="text-xs font-black font-mono text-blue-400">${tvl.toFixed(1)}B</span>
        </Pill>
      )}

      {gas !== null && gas !== undefined && (
        <Pill className="bg-slate-800/60 border-slate-700/60">
          <svg className="w-3 h-3 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
          </svg>
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Gas</span>
          <span className={`text-xs font-black font-mono ${gasColor(gas)}`}>{gas.toFixed(1)} gwei</span>
        </Pill>
      )}

      <div className="ml-auto flex items-center gap-1.5 text-[9px] font-mono text-slate-700">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-700 animate-pulse" />
        live market data
      </div>
    </div>
  );
}
