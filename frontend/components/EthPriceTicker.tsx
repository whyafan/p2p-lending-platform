'use client';

/**
 * Live ETH price for the dashboard header.
 *
 * The old version showed a bare "ETH $x" that only moved on page load, so there
 * was no way to tell whether it was the current market price or a stale figure
 * baked in at render. This says explicitly what it is, flashes on change, and
 * shows how long ago it updated.
 */

import { useEffect, useRef, useState } from 'react';
import { formatUsd } from '../lib/format';

type Props = { price: number; change24h?: number | null; updatedAt?: string | number };

export function EthPriceTicker({ price, change24h, updatedAt }: Props) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const [ago, setAgo] = useState('just now');
  const prev = useRef(price);

  useEffect(() => {
    if (price > 0 && prev.current > 0 && price !== prev.current) {
      setFlash(price > prev.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 1200);
      prev.current = price;
      return () => clearTimeout(t);
    }
    prev.current = price;
  }, [price]);

  // Ticks independently of fetches so "12s ago" keeps counting between polls.
  useEffect(() => {
    const stamp = updatedAt ? new Date(updatedAt).getTime() : Date.now();
    const tick = () => {
      const secs = Math.max(0, Math.round((Date.now() - stamp) / 1000));
      setAgo(secs < 5 ? 'just now' : secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [updatedAt]);

  if (!price) return null;

  return (
    <div
      className="ml-auto flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-1.5"
      title="Live ETH/USD market price — updates automatically"
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">
        ETH price now
      </span>
      <span
        className={`text-sm font-mono font-bold transition-colors duration-300 ${
          flash === 'up' ? 'text-emerald-400' : flash === 'down' ? 'text-red-400' : 'text-white'
        }`}
      >
        {formatUsd(price)}
      </span>
      {change24h !== null && change24h !== undefined && (
        <span
          className={`text-[11px] font-bold font-mono ${
            change24h >= 0 ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          {change24h >= 0 ? '+' : ''}
          {change24h.toFixed(2)}%
        </span>
      )}
      <span className="text-[10px] text-slate-700 whitespace-nowrap">{ago}</span>
    </div>
  );
}
