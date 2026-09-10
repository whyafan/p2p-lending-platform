'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { NewsArticle } from '../app/api/news/route';

const CATEGORY_COLORS: Record<string, string> = {
  blockchain: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  defi:       'bg-purple-500/15 text-purple-400 border-purple-500/20',
  lending:    'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  eth:        'bg-indigo-500/15 text-indigo-400 border-indigo-500/20',
  btc:        'bg-amber-500/15 text-amber-400 border-amber-500/20',
  nft:        'bg-pink-500/15 text-pink-400 border-pink-500/20',
  regulation: 'bg-red-500/15 text-red-400 border-red-500/20',
  web3:       'bg-violet-500/15 text-violet-400 border-violet-500/20',
  crypto:     'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',
};

function categoryClass(cat: string) {
  return CATEGORY_COLORS[cat.toLowerCase()] ?? 'bg-slate-500/15 text-slate-400 border-slate-500/20';
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const SOURCE_DOTS: Record<string, string> = {
  'CoinDesk':     'bg-blue-500',
  'CoinTelegraph':'bg-orange-500',
  'Decrypt':      'bg-purple-500',
};

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 animate-pulse">
      <div className="flex gap-3">
        <div className="flex-1 space-y-2">
          <div className="h-2.5 bg-slate-800 rounded w-1/4" />
          <div className="h-3.5 bg-slate-800 rounded w-full" />
          <div className="h-3.5 bg-slate-800 rounded w-3/4" />
          <div className="h-2 bg-slate-800/60 rounded w-1/3 mt-2" />
        </div>
        <div className="flex-shrink-0 w-16 h-16 rounded-lg bg-slate-800" />
      </div>
    </div>
  );
}

function ArticleCard({ article }: { article: NewsArticle }) {
  // Feed image URLs are third-party and frequently dead or hotlink-blocked. Tracked per
  // card so one broken image collapses its own thumbnail instead of leaving a browser
  // placeholder icon in the middle of the list.
  const [imgError, setImgError] = useState(false);
  const dotColor = SOURCE_DOTS[article.source] ?? 'bg-slate-600';

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-3 rounded-xl border border-slate-800/80 bg-slate-900/30 p-4 transition-all duration-200
                 hover:border-slate-600/60 hover:bg-slate-800/40 hover:shadow-lg hover:shadow-black/20
                 hover:-translate-y-0.5 active:translate-y-0"
    >
      {/* Text */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {/* Source + time */}
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
          <span className="text-[10px] font-bold text-slate-500">{article.source}</span>
          <span className="text-slate-800 text-[10px]">·</span>
          <span className="text-[10px] font-mono text-slate-700">{timeAgo(article.publishedAt)}</span>
        </div>

        {/* Title */}
        <p className="text-[12.5px] font-semibold text-slate-300 group-hover:text-white leading-snug line-clamp-2 transition-colors">
          {article.title}
        </p>

        {/* Body snippet */}
        {article.body && (
          <p className="text-[10.5px] text-slate-600 leading-relaxed line-clamp-2 hidden sm:block">
            {article.body}
          </p>
        )}

        {/* Categories + external icon */}
        <div className="flex items-center gap-1.5 mt-auto pt-1">
          {article.categories.map((c) => (
            <span
              key={c}
              className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-full border ${categoryClass(c)}`}
            >
              {c}
            </span>
          ))}
          <span className="ml-auto text-slate-700 group-hover:text-slate-500 transition-colors">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </span>
        </div>
      </div>

      {/* Thumbnail */}
      {article.imageUrl && !imgError && (
        <div className="flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden bg-slate-800 border border-slate-700/40 self-start">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.imageUrl}
            alt=""
            className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity duration-200"
            loading="lazy"
            onError={() => setImgError(true)}
          />
        </div>
      )}
    </a>
  );
}

const SOURCES = ['All', 'CoinDesk', 'CoinTelegraph', 'Decrypt'] as const;
type Source = typeof SOURCES[number];

export function BlockchainNews() {
  const [filter, setFilter] = useState<Source>('All');

  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['blockchain-news'],
    queryFn: async (): Promise<{ articles: NewsArticle[]; fetchedAt: number }> => {
      const res = await fetch('/api/news');
      if (!res.ok) throw new Error('Failed to fetch news');
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const allArticles = data?.articles ?? [];
  const articles = filter === 'All' ? allArticles : allArticles.filter((a) => a.source === filter);
  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;

  return (
    <div className="rounded-2xl border border-slate-800 bg-[#111827] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-800">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-40" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
        </span>
        <p className="text-[11px] font-black text-slate-300 uppercase tracking-widest">Crypto &amp; Blockchain News</p>
        <span className="text-[9px] font-bold text-emerald-500/80 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-1.5 py-0.5 uppercase tracking-widest">
          LIVE
        </span>

        {/* Source filter pills */}
        <div className="ml-auto flex items-center gap-1">
          {SOURCES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                filter === s
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-600 hover:text-slate-400 hover:bg-slate-800/50'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {lastUpdated && !isLoading && (
          <span className="text-[9px] font-mono text-slate-700 hidden md:block">
            {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {/* Grid */}
      <div className="p-4">
        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {!isLoading && error && (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-slate-600">
            <span className="text-3xl">📡</span>
            <p className="text-sm font-bold">Could not load news</p>
            <p className="text-xs">Check your connection and try again</p>
          </div>
        )}

        {!isLoading && !error && articles.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-slate-600">
            <span className="text-3xl">📰</span>
            <p className="text-sm font-bold">No articles for this filter</p>
          </div>
        )}

        {!isLoading && !error && articles.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {articles.map((article) => (
              <ArticleCard key={article.id} article={article} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      {!isLoading && articles.length > 0 && (
        <div className="px-5 py-2.5 border-t border-slate-800 bg-slate-900/30 flex items-center justify-between">
          <p className="text-[9px] font-mono text-slate-700">
            {articles.length} articles · CoinDesk, CoinTelegraph, Decrypt
          </p>
          <p className="text-[9px] font-mono text-slate-700">refreshes every 5 min</p>
        </div>
      )}
    </div>
  );
}
