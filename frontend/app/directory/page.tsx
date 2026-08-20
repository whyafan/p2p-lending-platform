'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCompliance } from '../../hooks/useCompliance';
import { KycBadge } from '../../components/KycBadge';
import { Search, ArrowLeft } from 'lucide-react';

type SearchResult = {
  id: string;
  displayName: string | null;
  kycStatus: string;
  userRole: string | null;
  walletAddress: string;
};

const ROLE_LABEL: Record<string, string> = {
  borrower: 'Borrower',
  lender: 'Lender',
  both: 'Borrower & Lender',
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function DirectoryPage() {
  const router = useRouter();
  const compliance = useCompliance();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (compliance.isLoading) return;
    if (!compliance.data?.authenticated) router.replace('/');
  }, [compliance.isLoading, compliance.data, router]);

  useEffect(() => {
    const trimmed = query.trim();
    // Below the minimum length there is nothing to synchronize with the
    // server, so the effect does nothing. Stale results/error/loading
    // state from a longer query is simply not rendered (see trimmedQuery
    // below) rather than reset here, since a plain reset with no external
    // synchronization is state that belongs in render, not in an effect.
    if (trimmed.length < 2) return;

    // A request kicked off by an earlier keystroke can still be in flight
    // when a later one resolves first. Guard with a per-run "cancelled"
    // flag (same pattern as app/app/page.tsx) so a slow stale response
    // can never overwrite fresher results after the query has moved on.
    let cancelled = false;

    const timer = setTimeout(async () => {
      if (cancelled) return;
      setIsSearching(true);
      setSearchError(null);
      try {
        const res = await fetch(`/api/directory/search?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        if (cancelled) return;
        setResults(data.results ?? []);
      } catch {
        if (cancelled) return;
        setSearchError('Search failed. Try again.');
        setResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (compliance.isLoading || !compliance.data?.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500" />
      </div>
    );
  }

  const trimmedQuery = query.trim();
  const showQueryState = trimmedQuery.length >= 2;

  return (
    <div className="min-h-screen bg-[#0a0e1a] px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/app" className="text-slate-500 hover:text-white transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-black text-white">Find a user</h1>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-600" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by display name or wallet address"
            className="w-full h-11 pl-10 pr-4 rounded-xl border border-slate-800 bg-slate-900/50 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/60"
            autoFocus
          />
        </div>

        {showQueryState && isSearching && <p className="text-xs text-slate-600">Searching...</p>}

        {showQueryState && searchError && <p className="text-xs text-red-400">{searchError}</p>}

        {showQueryState && !isSearching && !searchError && results.length === 0 && (
          <p className="text-xs text-slate-600">No verified users found for &quot;{trimmedQuery}&quot;.</p>
        )}

        <div className="space-y-2">
          {showQueryState && results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => router.push(`/directory/${r.walletAddress}`)}
              className="w-full flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-left hover:border-emerald-500/40 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-white truncate">
                  {r.displayName ?? shortAddress(r.walletAddress)}
                </p>
                <p className="text-[11px] font-mono text-slate-500">{shortAddress(r.walletAddress)}</p>
              </div>
              <KycBadge status={r.kycStatus} />
              {r.userRole && (
                <span className="text-[10px] font-bold text-slate-500 border border-slate-700 px-2 py-1 rounded-full flex-shrink-0">
                  {ROLE_LABEL[r.userRole] ?? r.userRole}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
