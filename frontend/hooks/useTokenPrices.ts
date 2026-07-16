'use client';

import { useQuery } from '@tanstack/react-query';
import type { TokenSymbol } from '../lib/tokens';

type PricesResponse = {
  prices: Record<string, number>;
  marketData?: Record<string, { usd: number; change24h: number }>;
  source: string;
  updatedAt: string;
};

export function useTokenPrices() {
  return useQuery({
    queryKey: ['token-prices'],
    queryFn: async (): Promise<PricesResponse> => {
      const res = await fetch('/api/prices');
      if (!res.ok) throw new Error('Failed to load prices');
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useTokenUsdPrice(symbol: TokenSymbol) {
  const { data, isLoading, error } = useTokenPrices();
  const priceUsd = data?.prices[symbol] ?? 0;

  return {
    priceUsd,
    isPriceAvailable: !isLoading && !error && priceUsd > 0,
    source: data?.source ?? 'loading',
    updatedAt: data?.updatedAt,
    isLoading,
    error,
  };
}
