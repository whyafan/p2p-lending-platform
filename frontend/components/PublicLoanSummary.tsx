'use client';

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { FACTORY_ABI, LOAN_ABI } from '../lib/loan-abi';
import { formatUsd, formatPercent } from '../lib/format';

const POLL_MS = 5_000;

// Mirrors LenderDashboard.tsx's FUNDING_WINDOW_SECS/isExpired: a Requested
// loan whose funding window has passed will never actually fund (contribute()
// reverts on-chain), but nothing moves its status off Requested, so it has
// to be filtered out client-side the same way LenderDashboard does.
const FUNDING_WINDOW_SECS = 7 * 24 * 60 * 60;

function isExpired(createdAt: bigint): boolean {
  const deadline = Number(createdAt) + FUNDING_WINDOW_SECS;
  return Math.floor(Date.now() / 1000) > deadline;
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
  mode: 'borrower' | 'lender';
  targetAddress: `0x${string}`;
  factoryAddress: string | undefined;
  chainId: number;
  ethPrice: number;
};

/**
 * Read-only counterpart to BorrowerLoansSection / LenderDashboard: shows a
 * looked-up user's open loan requests (Requested status, borrower mode) or
 * active funded positions (Funded status, lender mode). No fund, repay, or
 * liquidate actions, since those only make sense for the connected wallet's
 * own loans, never someone else's.
 *
 * Mirrors the multi-round read pattern those two components already use
 * (getLoanIds -> loans(id) -> status/contributions per contract, joined back
 * by address so the result-array indices can never drift from loanIds), just
 * parameterized by an arbitrary target address instead of useAccount(). Since
 * targetAddress is fixed per render (not the connected wallet), it queries
 * contributions(targetAddress) directly - no active-account narrowing needed.
 */
export function PublicLoanSummary({ mode, targetAddress, factoryAddress, chainId, ethPrice }: Props) {
  const isDeployed = Boolean(
    factoryAddress &&
      factoryAddress !== '0xYourLocalLoanFactoryAddress' &&
      factoryAddress !== '0xYourSepoliaLoanFactoryAddress',
  );

  const { data: loanIds, isLoading: idsLoading } = useReadContract({
    address: isDeployed ? (factoryAddress as `0x${string}`) : undefined,
    abi: FACTORY_ABI,
    functionName: 'getLoanIds',
    chainId,
    query: { refetchInterval: POLL_MS },
  });

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

  const loanContractAddresses = useMemo(
    () =>
      (termsResults ?? []).map((r) =>
        r.status === 'success' ? (r.result as LoanTermsTuple).loanContract : undefined,
      ),
    [termsResults],
  );

  const statusContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'status' as const, chainId })),
    [loanContractAddresses, chainId],
  );

  const lenderContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({
          address: addr,
          abi: LOAN_ABI,
          functionName: 'contributions' as const,
          args: [targetAddress] as const,
          chainId,
        })),
    [loanContractAddresses, chainId, targetAddress],
  );

  const { data: statusResults } = useReadContracts({
    contracts: statusContracts,
    query: { enabled: statusContracts.length > 0, refetchInterval: POLL_MS },
  });

  const { data: lenderResults } = useReadContracts({
    contracts: lenderContracts,
    query: { enabled: lenderContracts.length > 0, refetchInterval: POLL_MS },
  });

  // Address-keyed maps so statusResults/lenderResults indices never drift
  // from loanIds indices, matching the pattern in LenderDashboard.tsx.
  const statusByAddress = useMemo(() => {
    const map = new Map<string, number>();
    statusContracts.forEach((c, i) => {
      const r = statusResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), Number(r.result as unknown as bigint));
    });
    return map;
  }, [statusContracts, statusResults]);

  const lenderByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    lenderContracts.forEach((c, i) => {
      const r = lenderResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [lenderContracts, lenderResults]);

  const matchingLoans = useMemo(() => {
    if (!loanIds || !termsResults) return [];
    const wantedStatus = mode === 'borrower' ? 0 : 1;
    return loanIds
      .map((id, i) => {
        const r = termsResults[i];
        if (r?.status !== 'success') return null;
        const terms = r.result as LoanTermsTuple;
        const addrKey = terms.loanContract.toLowerCase();
        if (statusByAddress.get(addrKey) !== wantedStatus) return null;
        if (mode === 'borrower') {
          if (terms.borrower.toLowerCase() !== targetAddress.toLowerCase()) return null;
          if (isExpired(terms.createdAt)) return null;
        } else {
          const contribution = lenderByAddress.get(addrKey);
          if (!contribution || contribution <= 0n) return null;
        }
        return { id, terms };
      })
      .filter((l): l is { id: bigint; terms: LoanTermsTuple } => l !== null);
  }, [loanIds, termsResults, statusByAddress, lenderByAddress, mode, targetAddress]);

  // idsLoading/termsLoading alone cover only the first two read rounds. The
  // status/lender round only starts once loanContractAddresses is populated
  // (its query is `enabled` on contracts.length > 0), so without also
  // waiting on it here, the component would render "No open requests." for
  // one extra RPC round trip on every load, right as matchingLoans becomes
  // computable off of not-yet-loaded status/lender data.
  const statusLoading = statusContracts.length > 0 && statusResults === undefined;
  const lenderLoading = lenderContracts.length > 0 && lenderResults === undefined;
  const isLoading = idsLoading || termsLoading || statusLoading || lenderLoading;

  if (!isDeployed) {
    return <p className="text-xs text-slate-600">Contracts not configured.</p>;
  }

  if (isLoading) {
    return <p className="text-xs text-slate-600">Loading...</p>;
  }

  if (matchingLoans.length === 0) {
    return (
      <p className="text-xs text-slate-600">
        {mode === 'borrower' ? 'No open requests.' : 'No active positions.'}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {matchingLoans.map(({ id, terms }) => {
        const principalEth = parseFloat(formatEther(terms.principalAmount));
        const collateralEth = parseFloat(formatEther(terms.collateralAmount));
        const principalUsd = ethPrice > 0 ? principalEth * ethPrice : null;
        const aprPct = Number(terms.interestBps) / 10_000;
        const maxLtvPct = Number(terms.maxLtvBps) / 10_000;

        return (
          <div
            key={id.toString()}
            className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-slate-600">#{id.toString()}</span>
              <span className="text-[10px] font-bold text-slate-500">
                {mode === 'borrower' ? 'Open request' : 'Active position'}
              </span>
            </div>
            <p className="text-sm font-mono font-bold text-white">
              {principalEth.toFixed(4)} ETH
              {principalUsd !== null && (
                <span className="text-slate-500 font-normal"> ({formatUsd(principalUsd)})</span>
              )}
            </p>
            <p className="text-[11px] text-slate-500">
              {formatPercent(aprPct)} APR, {Number(terms.durationDays)}d term, max {formatPercent(maxLtvPct)} LTV, {collateralEth.toFixed(4)} ETH collateral
            </p>
          </div>
        );
      })}
    </div>
  );
}
