'use client';

import { useMemo, useEffect, useState } from 'react';
import {
  useReadContract,
  useReadContracts,
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi';
import { formatEther, parseEther } from 'viem';
import { sepolia } from 'wagmi/chains';
import { inferRiskTierFromBps } from '../lib/loan-terms';
import { formatUsd } from '../lib/format';
import { FACTORY_ABI, LOAN_ABI } from '../lib/loan-abi';
import { LoanSettlementReceipt } from './LoanSettlementReceipt';
import { useLoanEvents } from '../hooks/useLoanEvents';
import { Hexagon, Check, AlertTriangle } from 'lucide-react';
import { useHydrated } from '../hooks/useHydrated';

export const MAX_OPEN_REQUESTS = 3;
// Both sides of a loan watch each other act, so poll briskly rather than
// every 15-30s. Handfuls of loans on Sepolia — the RPC cost is trivial.
const POLL_MS = 5_000;

const FUNDING_WINDOW_SECS = 7 * 24 * 60 * 60;

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
  // wagmi restores the connection asynchronously after hydration. Checking only
  // `!address` meant that window rendered "Connect a wallet" to people who were
  // already connected — distinguish "still restoring" from "genuinely absent".
  const { address, isConnecting, isReconnecting } = useAccount();
  const hydrated = useHydrated();
  const walletSettling = !hydrated || isConnecting || isReconnecting;
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync, isPending: isRepayPending } = useWriteContract();

  const [repayingLoanId, setRepayingLoanId] = useState<bigint | null>(null);
  const [repayHash, setRepayHash] = useState<`0x${string}` | undefined>(undefined);
  const [repayError, setRepayError] = useState<string | null>(null);
  const [repayErrorLoanId, setRepayErrorLoanId] = useState<bigint | null>(null);
  const [repayAmountInputs, setRepayAmountInputs] = useState<Record<string, string>>({});

  const { isLoading: isRepayConfirming, isSuccess: isRepayConfirmed } = useWaitForTransactionReceipt({
    hash: repayHash,
  });

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
    query: { refetchInterval: POLL_MS },
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
    query: { enabled: termsContracts.length > 0, refetchInterval: POLL_MS },
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

  // Addresses of every loan contract belonging to this borrower
  const myLoanAddresses = useMemo(
    () =>
      myLoanIndices
        .map((i) => {
          const r = termsResults?.[i];
          return r?.status === 'success'
            ? (r.result as LoanTermsTuple).loanContract
            : undefined;
        })
        .filter((a): a is `0x${string}` => Boolean(a)),
    [myLoanIndices, termsResults],
  );

  // Round 3: status for each of the borrower's loan contracts
  const statusContracts = useMemo(
    () => myLoanAddresses.map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'status' as const, chainId })),
    [myLoanAddresses, chainId],
  );

  const { data: statusResults, refetch: refetchStatus } = useReadContracts({
    contracts: statusContracts,
    query: { enabled: statusContracts.length > 0, refetchInterval: POLL_MS },
  });

  // Round 4: live repayment state — read for all of the borrower's loans; only
  // Funded ones display it, but there's no harm reading it for the rest.
  const outstandingContracts = useMemo(
    () =>
      myLoanAddresses.map((addr) => ({
        address: addr,
        abi: LOAN_ABI,
        functionName: 'outstandingBalance' as const,
        chainId,
      })),
    [myLoanAddresses, chainId],
  );
  const repaymentDueAtContracts = useMemo(
    () =>
      myLoanAddresses.map((addr) => ({
        address: addr,
        abi: LOAN_ABI,
        functionName: 'repaymentDueAt' as const,
        chainId,
      })),
    [myLoanAddresses, chainId],
  );
  const isDelinquentContracts = useMemo(
    () =>
      myLoanAddresses.map((addr) => ({
        address: addr,
        abi: LOAN_ABI,
        functionName: 'isDelinquent' as const,
        chainId,
      })),
    [myLoanAddresses, chainId],
  );

  const { data: outstandingResults, refetch: refetchOutstanding } = useReadContracts({
    contracts: outstandingContracts,
    query: { enabled: outstandingContracts.length > 0, refetchInterval: POLL_MS },
  });
  const { data: repaymentDueAtResults, refetch: refetchRepaymentDueAt } = useReadContracts({
    contracts: repaymentDueAtContracts,
    query: { enabled: repaymentDueAtContracts.length > 0, refetchInterval: POLL_MS },
  });
  const { data: isDelinquentResults, refetch: refetchIsDelinquent } = useReadContracts({
    contracts: isDelinquentContracts,
    query: { enabled: isDelinquentContracts.length > 0, refetchInterval: POLL_MS },
  });

  // Liquidation seizes only the outstanding debt, so the borrower keeps the rest.
  // Showing this makes clear that every partial payment protects more collateral.
  const previewContracts = useMemo(
    () =>
      myLoanAddresses.map((addr) => ({
        address: addr,
        abi: LOAN_ABI,
        functionName: 'liquidationPreview' as const,
        chainId,
      })),
    [myLoanAddresses, chainId],
  );
  const priceAtFundingContracts = useMemo(
    () =>
      myLoanAddresses.map((addr) => ({
        address: addr,
        abi: LOAN_ABI,
        functionName: 'priceAtFunding' as const,
        chainId,
      })),
    [myLoanAddresses, chainId],
  );
  const { data: priceAtFundingResults } = useReadContracts({
    contracts: priceAtFundingContracts,
    query: { enabled: priceAtFundingContracts.length > 0, refetchInterval: 60_000 },
  });
  const priceAtFundingByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    priceAtFundingContracts.forEach((c, i) => {
      const r = priceAtFundingResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [priceAtFundingContracts, priceAtFundingResults]);
  const { data: previewResults, refetch: refetchPreview } = useReadContracts({
    contracts: previewContracts,
    query: { enabled: previewContracts.length > 0, refetchInterval: POLL_MS },
  });
  const previewByAddress = useMemo(() => {
    const map = new Map<string, { seize: bigint; refund: bigint }>();
    previewContracts.forEach((c, i) => {
      const r = previewResults?.[i];
      if (r?.status === 'success') {
        const [seize, refund] = r.result as readonly [bigint, bigint];
        map.set(c.address.toLowerCase(), { seize, refund });
      }
    });
    return map;
  }, [previewContracts, previewResults]);

  // Address-keyed maps so result indices never drift from myLoanIndices
  const statusByAddress = useMemo(() => {
    const map = new Map<string, number>();
    statusContracts.forEach((c, i) => {
      const r = statusResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), Number(r.result as unknown as bigint));
    });
    return map;
  }, [statusContracts, statusResults]);

  const outstandingByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    outstandingContracts.forEach((c, i) => {
      const r = outstandingResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [outstandingContracts, outstandingResults]);

  const repaymentDueAtByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    repaymentDueAtContracts.forEach((c, i) => {
      const r = repaymentDueAtResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [repaymentDueAtContracts, repaymentDueAtResults]);

  const isDelinquentByAddress = useMemo(() => {
    const map = new Map<string, boolean>();
    isDelinquentContracts.forEach((c, i) => {
      const r = isDelinquentResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as boolean);
    });
    return map;
  }, [isDelinquentContracts, isDelinquentResults]);

  async function refetchAll() {
    await Promise.all([
      refetchStatus(), refetchOutstanding(), refetchRepaymentDueAt(), refetchIsDelinquent(), refetchPreview(),
    ]);
  }

  // Combine and sort newest-first
  const myLoans = useMemo(() => {
    if (!loanIds || !termsResults) return [];
    return myLoanIndices
      .map((globalIdx) => {
        const id = loanIds[globalIdx]!;
        const terms = (termsResults[globalIdx]!.result as LoanTermsTuple);
        const loanAddr = terms?.loanContract?.toLowerCase();
        const statusVal = loanAddr ? statusByAddress.get(loanAddr) : undefined;
        const outstandingVal = loanAddr ? outstandingByAddress.get(loanAddr) : undefined;
        const repaymentDueAtVal = loanAddr ? repaymentDueAtByAddress.get(loanAddr) : undefined;
        const isDelinquentVal = loanAddr ? isDelinquentByAddress.get(loanAddr) : undefined;
        const previewVal = loanAddr ? previewByAddress.get(loanAddr) : undefined;
        const priceAtFundingVal = loanAddr ? priceAtFundingByAddress.get(loanAddr) : undefined;
        return { id, terms, statusVal, outstandingVal, repaymentDueAtVal, isDelinquentVal, previewVal, priceAtFundingVal };
      })
      .sort((a, b) => Number(b.terms.createdAt) - Number(a.terms.createdAt));
  }, [
    loanIds,
    termsResults,
    myLoanIndices,
    statusByAddress,
    outstandingByAddress,
    repaymentDueAtByAddress,
    isDelinquentByAddress,
    previewByAddress,
    priceAtFundingByAddress,
  ]);

  // Settlement history for closed loans — the record MetaMask can't give them.
  const settledAddresses = useMemo(
    () =>
      myLoans
        .filter((l) => l.statusVal === 2 || l.statusVal === 4)
        .map((l) => l.terms.loanContract),
    [myLoans],
  );
  const { byLoan: eventsByLoan, priceFor } = useLoanEvents({
    factoryAddress,
    loanContracts: settledAddresses,
    chainId,
    ethPrice,
    enabled: settledAddresses.length > 0,
  });

  const pendingCount = myLoans.filter((l) => l.statusVal === 0).length;

  useEffect(() => {
    onPendingCountChange?.(pendingCount);
  }, [pendingCount, onPendingCountChange]);

  // Immediately refresh contract state after a confirmed repayment
  useEffect(() => {
    if (isRepayConfirmed) void refetchAll();
  }, [isRepayConfirmed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sends `amountWei` toward a loan's live outstanding balance. Overpaying is
  // safe — the contract caps what it applies and refunds the rest in the same
  // transaction, which is how the "repay in full" quick action guarantees
  // closure despite outstandingBalance() ticking up slightly between the last
  // read and when the transaction actually mines.
  async function repayLoan(loanContractAddr: `0x${string}`, loanId: bigint, amountWei: bigint) {
    setRepayError(null);
    setRepayErrorLoanId(null);
    setRepayingLoanId(loanId);
    setRepayHash(undefined);
    try {
      await switchChainAsync({ chainId });
      const hash = await writeContractAsync({
        address: loanContractAddr,
        abi: LOAN_ABI,
        functionName: 'repay',
        value: amountWei,
        chainId,
      });
      setRepayHash(hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setRepayError(msg.length > 160 ? msg.slice(0, 157) + '…' : msg);
      setRepayErrorLoanId(loanId);
      setRepayingLoanId(null);
    }
  }

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
      ) : walletSettling ? (
        <div className="py-8 text-center">
          <p className="text-sm text-slate-600">Restoring your wallet connection…</p>
        </div>
      ) : !address ? (
        <div className="py-8 text-center">
          <p className="text-sm text-slate-600">Connect a wallet to see your loans.</p>
          <p className="text-xs text-slate-700 mt-1">
            If your wallet is already connected, reload the page — the session is still being restored.
          </p>
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
          {loansWithTx.map(({ id, terms, statusVal, outstandingVal, repaymentDueAtVal, isDelinquentVal, previewVal, priceAtFundingVal, txHash }) => {
            const tier = inferRiskTierFromBps(Number(terms.maxLtvBps));
            const aprNum = Number(terms.interestBps) / 100;
            const principalEth = parseFloat(formatEther(terms.principalAmount));
            const collateralEth = parseFloat(formatEther(terms.collateralAmount));
            const principalUsd = ethPrice > 0 ? principalEth * ethPrice : null;
            const collateralUsd = ethPrice > 0 ? collateralEth * ethPrice : null;
            const statusNum = statusVal ?? 0;
            const statusText = STATUS_LABEL[statusNum] ?? 'Unknown';
            const isOpen = statusNum === 0;
            const isFunded = statusNum === 1;
            const interestUsd =
              principalUsd !== null
                ? principalUsd * (aprNum / 100) * (Number(terms.durationDays) / 365)
                : null;

            const createdDate = new Date(Number(terms.createdAt) * 1000).toLocaleDateString(
              'en-US',
              { month: 'short', day: 'numeric', year: 'numeric' },
            );

            const dueDate =
              repaymentDueAtVal !== undefined
                ? new Date(Number(repaymentDueAtVal) * 1000).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : null;
            const outstandingEth = outstandingVal !== undefined ? formatEther(outstandingVal) : null;
            const isRepayingThis = repayingLoanId === id;
            const idKey = id.toString();
            const inputValue = repayAmountInputs[idKey] ?? (outstandingEth ?? '');

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

                    {isFunded && isDelinquentVal && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/20 text-red-400 flex items-center gap-1">
                        <AlertTriangle className="h-2.5 w-2.5" /> PAST DUE
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

                {/* Repay — only meaningful once the loan is Funded */}
                {isFunded && (
                  <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 mb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div>
                        <p className="text-[10px] text-slate-600">Outstanding balance (live)</p>
                        <p className="text-sm font-mono font-bold text-amber-400">
                          {outstandingEth !== null ? `${parseFloat(outstandingEth).toFixed(6)} ETH` : '…'}
                        </p>
                        {outstandingVal !== undefined && (() => {
                          // Interest accrues by elapsed time, so repaying early means
                          // almost none — worth showing so it doesn't look ignored.
                          const zero = BigInt(0);
                          const paid = terms.principalAmount > outstandingVal
                            ? terms.principalAmount - outstandingVal
                            : zero;
                          const interest =
                            outstandingVal + paid > terms.principalAmount
                              ? outstandingVal + paid - terms.principalAmount
                              : zero;
                          return (
                            <p className="text-[10px] text-slate-600">
                              incl. <span className="font-mono text-slate-500">{parseFloat(formatEther(interest)).toFixed(8)} ETH</span> interest accrued so far
                            </p>
                          );
                        })()}
                      </div>
                      {dueDate && (
                        <p className="text-[11px] text-slate-500">
                          Due <span className={isDelinquentVal ? 'text-red-400 font-bold' : 'text-slate-400'}>{dueDate}</span>
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        step="0.000001"
                        value={inputValue}
                        onChange={(e) => setRepayAmountInputs((prev) => ({ ...prev, [idKey]: e.target.value }))}
                        placeholder="Amount in ETH"
                        className="h-9 w-40 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-mono text-white focus:outline-none focus:border-blue-500/60"
                      />
                      <button
                        onClick={() => {
                          const parsed = parseFloat(inputValue);
                          if (!parsed || parsed <= 0) return;
                          void repayLoan(terms.loanContract, id, parseEther(inputValue));
                        }}
                        disabled={isRepayingThis && (isRepayPending || isRepayConfirming || !repayHash)}
                        className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-bold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
                      >
                        {isRepayingThis && !repayHash ? (
                          <>
                            <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                            Confirm…
                          </>
                        ) : isRepayingThis && isRepayConfirming ? (
                          <>
                            <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                            Confirming…
                          </>
                        ) : isRepayingThis && isRepayConfirmed ? (
                          <>
                            <Check className="h-3.5 w-3.5" /> Repaid
                          </>
                        ) : (
                          'Repay'
                        )}
                      </button>
                      {outstandingVal !== undefined && (
                        <button
                          onClick={() => {
                            // Deliberately overpay by a small buffer over the live
                            // outstanding balance — outstandingBalance() ticks up
                            // slightly between this read and when the tx actually
                            // mines, and the contract caps what it applies and
                            // refunds the exact excess in the same transaction, so
                            // this reliably closes the loan in one click.
                            const full = outstandingVal + parseEther('0.0001');
                            setRepayAmountInputs((prev) => ({ ...prev, [idKey]: formatEther(full) }));
                            void repayLoan(terms.loanContract, id, full);
                          }}
                          disabled={isRepayingThis && (isRepayPending || isRepayConfirming || !repayHash)}
                          className="h-9 px-3 rounded-lg border border-slate-700 text-[11px] font-bold text-slate-400 hover:text-white hover:border-slate-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          Repay in full
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-700 mt-1.5">
                      Partial payments are fine — pay what you can now and the rest later, before the deadline.
                      {previewVal && (
                        <>
                          {' '}If this were liquidated right now the lender would take{' '}
                          <span className="font-mono text-amber-500/80">
                            {parseFloat(formatEther(previewVal.seize)).toFixed(6)} ETH
                          </span>{' '}
                          and you would keep{' '}
                          <span className="font-mono text-emerald-500/80">
                            {parseFloat(formatEther(previewVal.refund)).toFixed(6)} ETH
                          </span>{' '}
                          — every payment you make shrinks the first number.
                        </>
                      )}
                      {priceAtFundingVal && Number(priceAtFundingVal) > 0 && (() => {
                        const thresholdFrac =
                          (Number(terms.maxLtvBps) + Number(terms.liquidationBufferBps)) / 10_000;
                        const liqPrice =
                          (parseFloat(formatEther(terms.principalAmount)) * Number(priceAtFundingVal)) /
                          (parseFloat(formatEther(terms.collateralAmount)) * thresholdFrac);
                        return (
                          <>
                            {' '}Funded when ETH was ${Number(priceAtFundingVal).toLocaleString()}; a price
                            crash only puts you at risk below{' '}
                            <span className="font-mono text-amber-500/80">
                              ${liqPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>.
                          </>
                        );
                      })()}
                    </p>

                    {isRepayingThis && repayHash && (
                      <div className="mt-2">
                        <a
                          href={`https://sepolia.etherscan.io/tx/${repayHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-mono text-blue-400"
                        >
                          {repayHash.slice(0, 18)}… ↗
                        </a>
                      </div>
                    )}
                    {repayError && repayErrorLoanId === id && (
                      <p className="mt-2 text-[11px] text-red-400 font-mono break-all">{repayError}</p>
                    )}
                  </div>
                )}

                {(statusNum === 2 || statusNum === 4) && (
                  <div className="mb-3">
                    <LoanSettlementReceipt
                      role="borrower"
                      principal={terms.principalAmount}
                      collateral={terms.collateralAmount}
                      events={eventsByLoan.get(terms.loanContract.toLowerCase()) ?? []}
                      statusVal={statusNum}
                      priceFor={priceFor}
                    />
                  </div>
                )}

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
