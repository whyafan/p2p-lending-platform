import { NextResponse } from 'next/server';

export const revalidate = 120; // 2-minute cache

export interface MarketPulse {
  fearGreed: { value: number; label: string } | null;
  defiTvl: number | null; // USD billions
  ethGasGwei: number | null;
  fetchedAt: number;
}

async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 120 },
    });
    if (!res.ok) return null;
    const json = await res.json() as { data: Array<{ value: string; value_classification: string }> };
    const d = json.data?.[0];
    if (!d) return null;
    return { value: parseInt(d.value, 10), label: d.value_classification };
  } catch {
    return null;
  }
}

async function fetchDefiTvl(): Promise<number | null> {
  try {
    const res = await fetch('https://api.llama.fi/v2/historicalChainTvl/Ethereum', {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 120 },
    });
    if (!res.ok) return null;
    const arr = await res.json() as Array<{ tvl: number }>;
    const last = arr.at(-1);
    return last ? last.tvl / 1e9 : null; // convert to billions
  } catch {
    return null;
  }
}

async function fetchEthGas(): Promise<number | null> {
  try {
    const res = await fetch('https://ethereum.publicnode.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { result: string };
    return parseInt(json.result, 16) / 1e9; // wei → gwei
  } catch {
    return null;
  }
}

export async function GET() {
  const [fearGreed, defiTvl, ethGasGwei] = await Promise.all([
    fetchFearGreed(),
    fetchDefiTvl(),
    fetchEthGas(),
  ]);

  const pulse: MarketPulse = { fearGreed, defiTvl, ethGasGwei, fetchedAt: Date.now() };
  return NextResponse.json(pulse);
}
