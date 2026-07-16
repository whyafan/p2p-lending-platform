import { NextResponse } from 'next/server';
import { SUPPORTED_TOKENS } from '../../../lib/tokens';

export const revalidate = 30;

// Coins shown in the marquee ticker (symbol → coingecko id)
const TICKER_COINS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  UNI: 'uniswap',
  USDC: 'usd-coin',
  MATIC: 'matic-network',
};

const TICKER_IDS = Object.values(TICKER_COINS);

export async function GET() {
  const appIds = [...new Set(SUPPORTED_TOKENS.map((t) => t.coingeckoId))];
  const allIds = [...new Set([...appIds, ...TICKER_IDS])].join(',');

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${allIds}&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 30 } }
    );

    if (!response.ok) {
      throw new Error(`CoinGecko ${response.status}`);
    }

    const raw = (await response.json()) as Record<
      string,
      { usd: number; usd_24h_change?: number }
    >;

    // Backward-compat prices map keyed by token symbol (ETH, WBTC, USDC…)
    const prices: Record<string, number> = {};
    for (const token of SUPPORTED_TOKENS) {
      prices[token.symbol] = raw[token.coingeckoId]?.usd ?? 0;
    }

    // Extended market data for the ticker (symbol → { usd, change24h })
    const marketData: Record<string, { usd: number; change24h: number }> = {};
    for (const [symbol, id] of Object.entries(TICKER_COINS)) {
      const entry = raw[id];
      if (entry?.usd) {
        marketData[symbol] = { usd: entry.usd, change24h: entry.usd_24h_change ?? 0 };
      }
    }

    return NextResponse.json({
      prices,
      marketData,
      source: 'coingecko',
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Price fetch failed', error);

    const fallbackEth = Number(process.env.NEXT_PUBLIC_ETH_USD_PRICE ?? '2500');
    const fallbackWbtc = Number(process.env.NEXT_PUBLIC_WBTC_USD_PRICE ?? '95000');
    const fallbackUsdc = Number(process.env.NEXT_PUBLIC_USDC_USD_PRICE ?? '1');

    const prices: Record<string, number> = {};
    for (const token of SUPPORTED_TOKENS) {
      if (token.coingeckoId === 'usd-coin') prices[token.symbol] = fallbackUsdc;
      else if (token.coingeckoId === 'wrapped-bitcoin') prices[token.symbol] = fallbackWbtc;
      else prices[token.symbol] = fallbackEth;
    }

    const marketData: Record<string, { usd: number; change24h: number }> = {
      BTC: { usd: fallbackWbtc, change24h: 0 },
      ETH: { usd: fallbackEth, change24h: 0 },
      SOL: { usd: 175, change24h: 0 },
      BNB: { usd: 620, change24h: 0 },
      AVAX: { usd: 38, change24h: 0 },
      LINK: { usd: 14, change24h: 0 },
      UNI: { usd: 8, change24h: 0 },
      USDC: { usd: fallbackUsdc, change24h: 0 },
      MATIC: { usd: 0.45, change24h: 0 },
    };

    return NextResponse.json({
      prices,
      marketData,
      source: 'fallback',
      updatedAt: new Date().toISOString(),
    });
  }
}
