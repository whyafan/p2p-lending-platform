'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

type MarketEntry = { usd: number; change24h: number };
type MarketResponse = {
  prices: Record<string, number>;
  marketData: Record<string, MarketEntry>;
  source: string;
  updatedAt: string;
};

const TICKER_ORDER = ['BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'LINK', 'UNI', 'MATIC', 'USDC'];

// Precision scales with magnitude so every row carries roughly the same information:
// four decimals on a sub-dollar token, none on a five-figure one. USDC is special-cased
// because the only interesting thing about a stablecoin's price is the depeg, which
// lives in digits a two-decimal format would round away.
function formatPrice(symbol: string, usd: number): string {
  if (usd === 0) return '···';
  if (symbol === 'USDC') return `$${usd.toFixed(4)}`;
  if (usd >= 10_000) return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (usd >= 1) return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${usd.toFixed(4)}`;
}

type TickerItem = { symbol: string; usd: number; change24h: number };

function TickerSlot({ item, ticked }: { item: TickerItem; ticked: boolean }) {
  const up = item.change24h >= 0;
  return (
    <span className="inline-flex items-center gap-2 px-5 border-r border-slate-800 last:border-r-0">
      <span className="text-xs font-bold tracking-widest text-slate-400">{item.symbol}</span>
      <span
        className={`text-xs font-mono font-bold transition-colors duration-300 ${
          ticked ? 'text-yellow-300' : 'text-white'
        }`}
      >
        {formatPrice(item.symbol, item.usd)}
      </span>
      <span className={`text-xs font-semibold ${up ? 'text-emerald-400' : 'text-red-400'}`}>
        {up ? '▲' : '▼'} {Math.abs(item.change24h).toFixed(2)}%
      </span>
    </span>
  );
}

export function PriceTicker() {
  const { data } = useQuery<MarketResponse>({
    queryKey: ['token-prices'],
    queryFn: async () => {
      const res = await fetch('/api/prices');
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const [items, setItems] = useState<TickerItem[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  // Previous prices live in a ref rather than state: they exist only to diff against
  // the incoming values, and storing them in state would trigger the render they are
  // meant to describe.
  const prevRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!data?.marketData) return;

    // Iterating TICKER_ORDER rather than the response keys fixes the order on screen.
    // A marquee whose contents reshuffle whenever the upstream response changes shape
    // is unreadable, and a coin missing from one poll must not shift every other one.
    const next = TICKER_ORDER
      .map((sym) => {
        const entry = data.marketData[sym];
        return entry ? { symbol: sym, usd: entry.usd, change24h: entry.change24h } : null;
      })
      .filter(Boolean) as TickerItem[];

    const changed = new Set<string>();
    for (const item of next) {
      if (prevRef.current[item.symbol] !== undefined && prevRef.current[item.symbol] !== item.usd) {
        changed.add(item.symbol);
      }
      prevRef.current[item.symbol] = item.usd;
    }

    setItems(next);

    if (changed.size > 0) {
      setTicked(changed);
      const t = setTimeout(() => setTicked(new Set()), 900);
      return () => clearTimeout(t);
    }
  }, [data]);

  if (items.length === 0) {
    return (
      <div className="h-9 w-full bg-[#0d1117] border-b border-slate-800 flex items-center px-4">
        <span className="text-[10px] text-slate-600 animate-pulse">Loading market data…</span>
      </div>
    );
  }

  // Duplicate items for a seamless loop: animate from 0 → -50% of total width
  const repeated = [...items, ...items];

  return (
    <div className="w-full overflow-hidden bg-[#0d1117] border-b border-slate-800 py-2 select-none">
      <div className="flex animate-ticker whitespace-nowrap">
        {repeated.map((item, i) => (
          <TickerSlot
            key={`${item.symbol}-${i}`}
            item={item}
            ticked={ticked.has(item.symbol)}
          />
        ))}
      </div>
    </div>
  );
}
