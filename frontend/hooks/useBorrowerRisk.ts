'use client';

import { useEffect, useMemo, useState } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import {
  assignRiskTier,
  normalizeWalletAddress,
  summarizeBorrowerLoans,
  type BorrowerLoanRecord,
  type RiskAssignment,
} from '../lib/borrower-risk';
import { FACTORY_ABI, LOAN_ABI } from '../lib/abis';

type LinkedProfileResponse = {
  linkedWallets: string[];
  profileName: string | null;
};

function parseFactoryLoan(
  loanId: bigint,
  data: readonly unknown[] | undefined
): { borrower: `0x${string}`; loanContract: `0x${string}` } | null {
  if (!data || data[0] === '0x0000000000000000000000000000000000000000') return null;
  return {
    loanContract: data[0] as `0x${string}`,
    borrower: normalizeWalletAddress(data[1] as string),
  };
}

export function useBorrowerRisk(
  factoryAddress: `0x${string}` | undefined,
  walletAddress: string | undefined,
  loanAmountUsd: number,
  tenorDays: number
) {
  const [linkedWallets, setLinkedWallets] = useState<string[]>([]);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);

  const connected = walletAddress ? normalizeWalletAddress(walletAddress) : undefined;

  useEffect(() => {
    if (!connected) {
      setLinkedWallets([]);
      setProfileName(null);
      return;
    }

    let cancelled = false;
    setLinkLoading(true);

    void fetch(`/api/profile?wallet=${encodeURIComponent(connected)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: LinkedProfileResponse | null) => {
        if (cancelled) return;
        const wallets = body?.linkedWallets?.length
          ? body.linkedWallets.map((w) => normalizeWalletAddress(w))
          : [connected];
        setLinkedWallets(wallets);
        setProfileName(body?.profileName ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setLinkedWallets([connected]);
          setProfileName(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLinkLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connected]);

  const identityWallets = useMemo(() => {
    if (!connected) return new Set<string>();
    const set = new Set(linkedWallets.length > 0 ? linkedWallets : [connected]);
    set.add(connected);
    return set;
  }, [connected, linkedWallets]);

  const { data: loanIds, isLoading: idsLoading } = useReadContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: 'getLoanIds',
    query: { enabled: !!factoryAddress && identityWallets.size > 0 },
  });

  const loanContracts =
    loanIds && loanIds.length > 0 && factoryAddress
      ? loanIds.map((loanId) => ({
          address: factoryAddress,
          abi: FACTORY_ABI,
          functionName: 'loans' as const,
          args: [loanId] as const,
        }))
      : [];

  const loanReads = useReadContracts({
    contracts: loanContracts,
    query: { enabled: loanContracts.length > 0 },
  });

  const identityLoans = useMemo(() => {
    if (!loanIds) return [] as { loanId: bigint; borrower: `0x${string}`; loanContract: `0x${string}` }[];

    return loanIds.flatMap((loanId, index) => {
      const parsed = parseFactoryLoan(loanId, loanReads.data?.[index]?.result as readonly unknown[]);
      if (!parsed || !identityWallets.has(parsed.borrower)) return [];
      return [{ loanId, ...parsed }];
    });
  }, [loanIds, loanReads.data, identityWallets]);

  const statusContracts =
    identityLoans.length > 0
      ? identityLoans.map((loan) => ({
          address: loan.loanContract,
          abi: LOAN_ABI,
          functionName: 'status' as const,
        }))
      : [];

  const statusReads = useReadContracts({
    contracts: statusContracts,
    query: { enabled: statusContracts.length > 0 },
  });

  const records: BorrowerLoanRecord[] = useMemo(() => {
    return identityLoans.map((loan, index) => ({
      loanId: loan.loanId,
      borrower: loan.borrower,
      status: Number(statusReads.data?.[index]?.result ?? 0),
    }));
  }, [identityLoans, statusReads.data]);

  const stats = useMemo(() => summarizeBorrowerLoans(records), [records]);

  const assignment: RiskAssignment | null = useMemo(() => {
    if (!connected) return null;
    return assignRiskTier({
      stats,
      loanAmountUsd,
      tenorDays,
      linkedWalletCount: identityWallets.size,
    });
  }, [connected, stats, loanAmountUsd, tenorDays, identityWallets.size]);

  const isLoading =
    linkLoading ||
    idsLoading ||
    loanReads.isLoading ||
    (identityLoans.length > 0 && statusReads.isLoading);

  return {
    assignment,
    stats,
    records,
    profileName,
    linkedWalletCount: identityWallets.size,
    isLoading,
    isConnected: !!connected,
  };
}
