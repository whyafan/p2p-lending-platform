'use client';

import { useMemo, useEffect } from 'react';
import { useReadContract, useReadContracts, useAccount } from 'wagmi';
import { formatEther } from 'viem';
import { sepolia, hardhat } from 'wagmi/chains';
import { inferRiskTierFromBps } from '../lib/loan-terms';
import { formatUsd } from '../lib/format';
import { Hexagon } from 'lucide-react';

export const MAX_OPEN_REQUESTS = 3;
const FUNDING_WINDOW_SECS = 7 * 24 * 60 * 60;

const FACTORY_ABI = [
  {
    name: 'getLoanIds',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
    stateMutability: 'view',
  },
  {
    name: 'loans',
    type: 'function',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'loanContract', type: 'address' },
          { name: 'borrower', type: 'address' },
          { name: 'principalAmount', type: 'uint256' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'durationDays', type: 'uint256' },
          { name: 'interestBps', type: 'uint256' },
          { name: 'maxLtvBps', type: 'uint256' },
          { name: 'liquidationBufferBps', type: 'uint256' },
          { name: 'createdAt', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

const LOAN_ABI = [
  {
    name: 'status',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
] as const;

const STATUS_LABEL = ['Requested', 'Funded', 'Repaid', 'Cancelled', 'Liquidated'] as const;
const STATUS_COLORS: Record<number, string> = {
  0: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  1: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  2: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
  3: 'bg-slate-700/50 text-slate-500 border-slate-700',
  4: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const TIER_BADGE: Record<string, string> = {
  A: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  B: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  C: 'bg-red-500/20 text-red-400 border-red-500/40',
};

export type StoredLoanTx = { txHash: string; submittedAt: number };

export function storeLoanTx(walletAddress: string, txHash: string) {
  try {
    const key = `nexusfi_loans_${walletAddress.toLowerCase()}`;
    const stored: StoredLoanTx[] = JSON.parse(localStorage.getItem(key) ?? '[]');
    stored.push({ txHash, submittedAt: Date.now() });
    localStorage.setItem(key, JSON.stringify(stored.slice(-20)));
  } catch {}
}

function getStoredTxs(walletAddress: string): StoredLoanTx[] {
  try {
    return JSON.parse(
      localStorage.getItem(`nexusfi_loans_${walletAddress.toLowerCase()}`) ?? '[]',
    ) as StoredLoanTx[];
  } catch {
    return [];
  }
}

function matchTxHash(
  createdAt: bigint,
  storedTxs: StoredLoanTx[],
  usedHashes: Set<string>,
): string | null {
  const createdAtMs = Number(createdAt) * 1000;
  // Match greedily: pick the first unused tx whose submittedAt is within 5 min of chain createdAt
  for (const tx of storedTxs) {
    if (usedHashes.has(tx.txHash)) continue;
    if (Math.abs(createdAtMs - tx.submittedAt) < 5 * 60 * 1000) {
      usedHashes.add(tx.txHash);
      return tx.txHash;
    }
  }
  return null;
}

function timeLeft(createdAt: bigint): string {
  const deadline = Number(createdAt) + FUNDING_WINDOW_SECS;
  const remaining = deadline - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return 'Expired';
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h left` : `${h}h left`;
}

type LoanTermsTuple = {
  loanContract: `0x${string}`;
  borrower: `0x${string}`;
  principalAmount: bigint;
  collateralAmount: bigint;
  durationDays: bigint;
  interestBps: bigint;
  maxLtvBps: bigint;
  liquidationBufferBps: bigint;
  createdAt: bigint;
};

type Props = {
  factoryAddress: string | undefined;
  chainId?: number;
  ethPrice: number;
  onPendingCountChange?: (count: number) => void;
};

export function BorrowerLoansSection({ factoryAddress, chainId = sepolia.id, ethPrice, onPendingCountChange }: Props) {
  const { address } = useAccount();

  const isDeployed = Boolean(
    factoryAddress &&
      factoryAddress !== '0xYourLocalLoanFactoryAddress' &&
      factoryAddress !== '0xYourSepoliaLoanFactoryAddress',
  );

  // Round 1: all loan IDs
  const { data: loanIds, isLoading: idsLoading } = useReadContract({
    address: isDeployed ? (factoryAddress as `0x${string}`) : undefined,
    abi: FACTORY_ABI,
    functionName: 'getLoanIds',
    chainId,
    query: { refetchInterval: 15_000 },
  });

  // Round 2: terms for every ID
  const termsContracts = useMemo(
    () =>
      (loanIds ?? []).map((id) => ({
        address: factoryAddress as `0x${string}`,
        abi: FACTORY_ABI,
        functionName: 'loans' as const,
        args: [id] as const,
        chainId,
      })),
    [loanIds, factoryAddress, chainId],
  );

  const { data: termsResults, isLoading: termsLoading } = useReadContracts({
    contracts: termsContracts,
    query: { enabled: termsContracts.length > 0, refetchInterval: 15_000 },
  });

  // Indices of loans that belong to this borrower
  const myLoanIndices = useMemo(() => {
    if (!loanIds || !termsResults || !address) return [];
    return loanIds
      .map((_, i) => {
        const r = termsResults[i];
        if (r?.status !== 'success') return null;
        const terms = r.result as LoanTermsTuple;
        return terms.borrower.toLowerCase() === address.toLowerCase() ? i : null;
      })
      .filter((i): i is number => i !== null);
  }, [loanIds, termsResults, address]);

  // Round 3: status for each of the borrower's loan contracts
  const statusContracts = useMemo(
    () =>
      myLoanIndices
        .map((i) => {
          const r = termsResults?.[i];
          return r?.status === 'success'
            ? (r.result as LoanTermsTuple).loanContract
            : undefined;
        })
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'status' as const, chainId })),
    [myLoanIndices, termsResults, chainId],
  );

  const { data: statusResults } = useReadContracts({
    contracts: statusContracts,
    query: { enabled: statusContracts.length > 0, refetchInterval: 15_000 },
  });

  // Address-keyed map so statusResults indices never drift from myLoanIndices
  const statusByAddress = useMemo(() => {
    const map = new Map<string, number>();
    statusContracts.forEach((c, i) => {
      const r = statusResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), Number(r.result as unknown as bigint));
    });
    return map;
  }, [statusContracts, statusResults]);

  // Combine and sort newest-first
  const myLoans = useMemo(() => {
    if (!loanIds || !termsResults) return [];
    return myLoanIndices
      .map((globalIdx) => {
        const id = loanIds[globalIdx]!;
        const terms = (termsResults[globalIdx]!.result as LoanTermsTuple);
        const loanAddr = terms?.loanContract?.toLowerCase();
        const statusVal = loanAddr ? statusByAddress.get(loanAddr) : undefined;
        return { id, terms, statusVal };
      })
      .sort((a, b) => Number(b.terms.createdAt) - Number(a.terms.createdAt));
  }, [loanIds, termsResults, myLoanIndices, statusByAddress]);

  const pendingCount = myLoans.filter((l) => l.statusVal === 0).length;

  useEffect(() => {
    onPendingCountChange?.(pendingCount);
  }, [pendingCount, onPendingCountChange]);

  const storedTxs = useMemo(
    () => (address ? getStoredTxs(address) : []),
    // Re-compute when address changes; storedTxs update happens via storeLoanTx() in parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, myLoans.length],
  );

  const loansWithTx = useMemo(() => {
    const usedHashes = new Set<string>();
    return myLoans.map((loan) => ({
      ...loan,
      txHash: matchTxHash(loan.terms.createdAt, storedTxs, usedHashes),
    }));
  }, [myLoans, storedTxs]);

  const isLoading = idsLoading || termsLoading;

  return (
    <div className="rounded-2xl border border-slate-800 bg-[#111827] p-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-black text-white uppercase tracking-widest">Loans</h3>
          {myLoans.length > 0 && (
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-slate-800 text-[10px] font-black text-slate-400 px-1.5">
              {myLoans.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {pendingCount >= MAX_OPEN_REQUESTS && (
            <span className="text-[10px] font-bold text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-2 py-0.5">
              {MAX_OPEN_REQUESTS} pending max reached
            </span>
          )}
          <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
          <span className="text-[10px] font-bold text-slate-600">Sepolia testnet</span>
        </div>
      </div>

      {!isDeployed ? (
        <p className="text-xs text-slate-600">
          Deploy contracts first. Loans will appear here automatically.
        </p>
      ) : isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-24 rounded-xl border border-slate-800 animate-pulse" />
          ))}
        </div>
      ) : !address ? (
        <div className="py-8 text-center">
          <p className="text-sm text-slate-600">Connect a wallet to see your loans.</p>
        </div>
      ) : myLoans.length === 0 ? (
        <div className="py-8 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-slate-700 mb-3">
            <Hexagon className="h-6 w-6 text-slate-700" />
          </div>
          <p className="text-sm font-bold text-slate-500">No loan requests yet</p>
          <p className="text-xs text-slate-700 mt-1 max-w-xs mx-auto">
            Loan requests you submit above will appear here with live status updates.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {loansWithTx.map(({ id, terms, statusVal, txHash }) => {
            const tier = inferRiskTierFromBps(Number(terms.maxLtvBps));
            const aprNum = Number(terms.interestBps) / 100;
            const principalEth = parseFloat(formatEther(terms.principalAmount));
            const collateralEth = parseFloat(formatEther(terms.collateralAmount));
            const principalUsd = ethPrice > 0 ? principalEth * ethPrice : null;
            const collateralUsd = ethPrice > 0 ? collateralEth * ethPrice : null;
            const statusNum = statusVal ?? 0;
            const statusText = STATUS_LABEL[statusNum] ?? 'Unknown';
            const isOpen = statusNum === 0;
            const interestUsd =
              principalUsd !== null
                ? principalUsd * (aprNum / 100) * (Number(terms.durationDays) / 365)
                : null;

            const createdDate = new Date(Number(terms.createdAt) * 1000).toLocaleDateString(
              'en-US',
              { month: 'short', day: 'numeric', year: 'numeric' },
            );

            return (
              <div
                key={id.toString()}
                className="rounded-xl border border-slate-800 bg-slate-900/30 p-4 transition-colors hover:border-slate-700"
              >
                {/* Top row: badges + date */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-mono text-slate-600">#{id.toString()}</span>

                    {/* Status — always visible inline */}
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_COLORS[statusNum] ?? ''}`}
                    >
                      {statusText}
                    </span>

                    {tier && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${TIER_BADGE[tier]}`}>
                        Tier {tier}
                      </span>
                    )}

                    {isOpen && (
                      <span className="text-[10px] text-slate-500 font-mono">
                        {timeLeft(terms.createdAt)}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-600">{createdDate}</span>
                </div>

                {/* Loan details grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
                  <div>
                    <p className="text-[10px] text-slate-600">Principal</p>
                    <p className="text-sm font-mono font-bold text-white">
                      {principalEth.toFixed(6)} ETH
                    </p>
                    {principalUsd !== null && (
                      <p className="text-[11px] text-slate-500">{formatUsd(principalUsd)}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-600">Collateral locked</p>
                    <p className="text-sm font-mono font-bold text-blue-300">
                      {collateralEth.toFixed(6)} ETH
                    </p>
                    {collateralUsd !== null && (
                      <p className="text-[11px] text-slate-500">{formatUsd(collateralUsd)}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-600">Duration / APR</p>
                    <p className="text-sm font-mono font-bold text-white">
                      {terms.durationDays.toString()}d
                    </p>
                    <p className="text-[11px] text-slate-500">{aprNum.toFixed(1)}% APR</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-600">Interest owed</p>
                    {interestUsd !== null ? (
                      <>
                        <p className="text-sm font-mono font-bold text-amber-400">
                          {formatUsd(interestUsd)}
                        </p>
                        {principalUsd !== null && (
                          <p className="text-[11px] text-slate-500">
                            Total: {formatUsd(principalUsd + interestUsd)}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-slate-700">N/A</p>
                    )}
                  </div>
                </div>

                {/* Etherscan links */}
                <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-800/60 text-[11px]">
                  <a
                    href={`https://sepolia.etherscan.io/address/${terms.loanContract}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500/70 hover:text-blue-400 font-mono transition-colors"
                  >
                    Loan contract ↗
                  </a>
                  {txHash ? (
                    <a
                      href={`https://sepolia.etherscan.io/tx/${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500/70 hover:text-blue-400 font-mono transition-colors"
                    >
                      Creation TX ↗
                    </a>
                  ) : null}
                  <span className="text-slate-700 font-mono truncate max-w-[200px]" title={terms.loanContract}>
                    {terms.loanContract.slice(0, 10)}…{terms.loanContract.slice(-8)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
