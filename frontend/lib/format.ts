import { formatEther as viemFormatEther } from 'viem';

/** Fixed locale so SSR and browser render identical currency/number text. */
export const APP_LOCALE = 'en-US';

export function formatUsd(value: number, maximumFractionDigits = 2) {
  return value.toLocaleString(APP_LOCALE, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'symbol',
    maximumFractionDigits,
  });
}

export function formatNumber(value: number, maximumFractionDigits = 2) {
  return value.toLocaleString(APP_LOCALE, { maximumFractionDigits });
}

export function formatPercent(value: number, maximumFractionDigits = 1) {
  return `${(value * 100).toLocaleString(APP_LOCALE, { maximumFractionDigits })}%`;
}

export function formatEth(value?: bigint): string {
  if (value === undefined) return '-';
  return `${formatNumber(Number(viemFormatEther(value)), 4)} ETH`;
}

export function shortAddress(address?: string): string {
  if (!address) return 'Not connected';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function loanStatusLabel(status?: number): string {
  // Index order is the LoanStatus enum in Loan.sol and must not be rearranged: the
  // contract returns the ordinal, and this array is the only thing giving it meaning.
  const LABELS = ['Requested', 'Funded', 'Repaid', 'Cancelled', 'Liquidated'] as const;
  if (status === undefined) return '-';
  return LABELS[status] ?? 'Unknown';
}

/** Returns null in local mode: a Hardhat transaction exists on no public explorer. */
export function txExplorerUrl(hash: string | undefined, networkMode: string): string | null {
  if (!hash) return null;
  if (networkMode === 'testnet') return `https://sepolia.etherscan.io/tx/${hash}`;
  return null;
}
