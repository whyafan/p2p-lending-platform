'use client';

import { useMemo, useState, useEffect } from 'react';
import {
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
  useAccount,
  useSwitchChain,
  useConfig,
} from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { formatEther, parseEther } from 'viem';
import { sepolia, hardhat } from 'wagmi/chains';
import { inferRiskTierFromBps, RISK_TIER_CONFIG, BASE_APR } from '../lib/loan-terms';
import { formatUsd, formatPercent } from '../lib/format';
import { FACTORY_ABI, LOAN_ABI } from '../lib/loan-abi';
import { LoanSafetyPanel } from './LoanSafetyPanel';
import { LoanSettlementReceipt } from './LoanSettlementReceipt';
import { useLoanEvents } from '../hooks/useLoanEvents';
import type { FeatureContribution } from '../lib/risk-explainer';
import type { RiskTier } from '../lib/loan-terms';

type StoredAssessment = {
  tier: RiskTier;
  overallScore: number;
  contributions: FeatureContribution[];
  source?: string | null;
  personaId?: string | null;
};
import { ClipboardList, TrendingUp, Check, Hexagon, AlertTriangle } from 'lucide-react';

// Both sides of a loan watch each other act, so poll briskly rather than
// every 15-30s. Handfuls of loans on Sepolia — the RPC cost is trivial.
const POLL_MS = 5_000;

const FUNDING_WINDOW_SECS = 7 * 24 * 60 * 60;
// Mirrors Loan.sol's GRACE_PERIOD constant, for client-side countdown display only —
// the contract's isLiquidatable() is always the source of truth for the actual gate.
const GRACE_PERIOD_SECS = 2 * 24 * 60 * 60;

// LoanStatus enum values from Loan.sol
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

function timeLeft(createdAt: bigint): string {
  const deadline = Number(createdAt) + FUNDING_WINDOW_SECS;
  const remaining = deadline - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return 'Expired';
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h left` : `${h}h left`;
}

function isExpired(createdAt: bigint): boolean {
  const deadline = Number(createdAt) + FUNDING_WINDOW_SECS;
  return Math.floor(Date.now() / 1000) > deadline;
}

// Scales a loan-wide wei amount down to the caller's pro-rata share, mirroring
// Loan.sol's own _distribute() formula (value * contribution / principal).
// Bigint math throughout - converting to float first would reintroduce the
// precision loss this exists to avoid.
function myShareOfWei(
  value: bigint | undefined,
  myContribution: bigint | undefined,
  principal: bigint,
): bigint | null {
  if (value === undefined || myContribution === undefined || principal <= 0n) return null;
  return (value * myContribution) / principal;
}

type TxStatus = 'pending' | 'confirming' | 'confirmed' | 'error';
type TxState = { status: TxStatus; hash?: `0x${string}`; error?: string };

// Countdown until liquidate() actually becomes callable (repaymentDueAt + grace
// period). repaymentDueAt is undefined while state is still loading.
function liquidationCountdown(repaymentDueAt: bigint | undefined): string | null {
  if (repaymentDueAt === undefined) return null;
  const eligibleAt = Number(repaymentDueAt) + GRACE_PERIOD_SECS;
  const remaining = eligibleAt - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return null;
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h until liquidatable` : `${h}h until liquidatable`;
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
  ethPrice: number;
  networkMode?: 'local' | 'testnet';
};

export function LenderDashboard({ factoryAddress, ethPrice, networkMode = 'testnet' }: Props) {
  const { address } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const wagmiConfig = useConfig();
  const [activeTab, setActiveTab] = useState<'open' | 'positions'>('open');
  const [fundingLoanId, setFundingLoanId] = useState<bigint | null>(null);
  const [fundingHash, setFundingHash] = useState<`0x${string}` | undefined>(undefined);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [fundingErrorLoanId, setFundingErrorLoanId] = useState<bigint | null>(null);
  const [contributionInputs, setContributionInputs] = useState<Record<string, string>>({});
  const [liqLoanId, setLiqLoanId] = useState<bigint | null>(null);
  const [liqHash, setLiqHash] = useState<`0x${string}` | undefined>(undefined);

  const isDeployed = Boolean(
    factoryAddress &&
      factoryAddress !== '0xYourLocalLoanFactoryAddress' &&
      factoryAddress !== '0xYourSepoliaLoanFactoryAddress',
  );

  // Always query the chain the contracts are deployed on, regardless of which
  // chain MetaMask happens to be connected to.
  const chainId = networkMode === 'testnet' ? sepolia.id : hardhat.id;

  // ── Round 1: read all loan IDs ──
  const { data: loanIds, isLoading: idsLoading, refetch: refetchIds } = useReadContract({
    address: isDeployed ? (factoryAddress as `0x${string}`) : undefined,
    abi: FACTORY_ABI,
    functionName: 'getLoanIds',
    chainId,
    query: { refetchInterval: POLL_MS },
  });

  // ── Round 2: read LoanTerms for each ID ──
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

  // ── Round 3: read status + lender for each loan contract ──
  const loanContractAddresses = useMemo(
    () =>
      (termsResults ?? []).map(
        (r) => (r.status === 'success' ? (r.result as LoanTermsTuple)?.loanContract : undefined),
      ),
    [termsResults],
  );

  const statusContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({
          address: addr,
          abi: LOAN_ABI,
          functionName: 'status' as const,
          chainId,
        })),
    [loanContractAddresses, chainId],
  );

  // Narrowing (deliberate): the pooled contract's contributions() takes one
  // address, so we query only the ACTIVE connected account (`address`), not
  // every account across every connected wallet (as the old single-lender
  // `lender()` comparison did). Querying per connected account would multiply
  // this read round by the number of accounts, so positions shown here follow
  // the active account only, not the full multi-wallet breadth.
  const lenderContracts = useMemo(
    () =>
      address
        ? loanContractAddresses
            .filter((a): a is `0x${string}` => Boolean(a))
            .map((addr) => ({
              address: addr,
              abi: LOAN_ABI,
              functionName: 'contributions' as const,
              args: [address] as const,
              chainId,
            }))
        : [],
    [loanContractAddresses, chainId, address],
  );

  const { data: statusResults, refetch: refetchStatus } = useReadContracts({
    contracts: statusContracts,
    query: { enabled: statusContracts.length > 0, refetchInterval: POLL_MS },
  });

  const { data: lenderResults, refetch: refetchLenders } = useReadContracts({
    contracts: lenderContracts,
    query: { enabled: lenderContracts.length > 0, refetchInterval: POLL_MS },
  });

  // Shares that a push transfer failed to deliver (repayment or liquidation
  // distribution) - real money that otherwise sits invisible until withdraw()
  // is called. Same active-account narrowing as lenderContracts above.
  const pendingWithdrawalContracts = useMemo(
    () =>
      address
        ? loanContractAddresses
            .filter((a): a is `0x${string}` => Boolean(a))
            .map((addr) => ({
              address: addr,
              abi: LOAN_ABI,
              functionName: 'pendingWithdrawals' as const,
              args: [address] as const,
              chainId,
            }))
        : [],
    [loanContractAddresses, chainId, address],
  );
  const { data: pendingWithdrawalResults, refetch: refetchPendingWithdrawals } = useReadContracts({
    contracts: pendingWithdrawalContracts,
    query: { enabled: pendingWithdrawalContracts.length > 0, refetchInterval: POLL_MS },
  });
  const pendingWithdrawalByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    pendingWithdrawalContracts.forEach((c, i) => {
      const r = pendingWithdrawalResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [pendingWithdrawalContracts, pendingWithdrawalResults]);

  // ── Pooled funding progress: how much of the principal each loan already has ──
  const totalContributedContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'totalContributed' as const, chainId })),
    [loanContractAddresses, chainId],
  );
  const { data: totalContributedResults, refetch: refetchTotalContributed } = useReadContracts({
    contracts: totalContributedContracts,
    query: { enabled: totalContributedContracts.length > 0, refetchInterval: POLL_MS },
  });
  const totalContributedByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    totalContributedContracts.forEach((c, i) => {
      const r = totalContributedResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [totalContributedContracts, totalContributedResults]);

  // Read per loan rather than assuming principal/100, so the UI stays correct
  // if the contract's minimum-contribution rule ever changes.
  const minContributionContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'minContribution' as const, chainId })),
    [loanContractAddresses, chainId],
  );
  const { data: minContributionResults, refetch: refetchMinContribution } = useReadContracts({
    contracts: minContributionContracts,
    query: { enabled: minContributionContracts.length > 0, refetchInterval: POLL_MS },
  });
  const minContributionByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    minContributionContracts.forEach((c, i) => {
      const r = minContributionResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [minContributionContracts, minContributionResults]);

  // ── Round 4: real delinquency/liquidation state for funded loans only ──
  const isLiquidatableContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({
          address: addr,
          abi: LOAN_ABI,
          functionName: 'isLiquidatable' as const,
          chainId,
        })),
    [loanContractAddresses, chainId],
  );

  const repaymentDueAtContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({
          address: addr,
          abi: LOAN_ABI,
          functionName: 'repaymentDueAt' as const,
          chainId,
        })),
    [loanContractAddresses, chainId],
  );

  // Live LTV straight from the contract: frozen USD debt over current USD
  // collateral value. The old client-side principalUsd/collateralUsd was
  // price-independent (both legs are ETH) and so could never show a crash.
  const ltvContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'currentLtvBps' as const, chainId })),
    [loanContractAddresses, chainId],
  );

  const priceLiqContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'isPriceLiquidatable' as const, chainId })),
    [loanContractAddresses, chainId],
  );

  const delinqLiqContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'isDelinquentLiquidatable' as const, chainId })),
    [loanContractAddresses, chainId],
  );

  const { data: isLiquidatableResults, refetch: refetchIsLiquidatable } = useReadContracts({
    contracts: isLiquidatableContracts,
    query: { enabled: isLiquidatableContracts.length > 0, refetchInterval: POLL_MS },
  });

  const { data: ltvResults, refetch: refetchLtv } = useReadContracts({
    contracts: ltvContracts,
    query: { enabled: ltvContracts.length > 0, refetchInterval: POLL_MS },
  });

  const { data: priceLiqResults, refetch: refetchPriceLiq } = useReadContracts({
    contracts: priceLiqContracts,
    query: { enabled: priceLiqContracts.length > 0, refetchInterval: POLL_MS },
  });

  const { data: delinqLiqResults, refetch: refetchDelinqLiq } = useReadContracts({
    contracts: delinqLiqContracts,
    query: { enabled: delinqLiqContracts.length > 0, refetchInterval: POLL_MS },
  });

  // What liquidating right now would actually take vs. hand back. Liquidation
  // seizes only the outstanding debt, so this is not simply "all the collateral".
  const outstandingContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'outstandingBalance' as const, chainId })),
    [loanContractAddresses, chainId],
  );
  const priceAtFundingContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'priceAtFunding' as const, chainId })),
    [loanContractAddresses, chainId],
  );
  const { data: outstandingResults, refetch: refetchOutstanding } = useReadContracts({
    contracts: outstandingContracts,
    query: { enabled: outstandingContracts.length > 0, refetchInterval: POLL_MS },
  });
  const { data: priceAtFundingResults, refetch: refetchPriceAtFunding } = useReadContracts({
    contracts: priceAtFundingContracts,
    query: { enabled: priceAtFundingContracts.length > 0, refetchInterval: 60_000 },
  });
  const outstandingByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    outstandingContracts.forEach((c, i) => {
      const r = outstandingResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [outstandingContracts, outstandingResults]);
  const priceAtFundingByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    priceAtFundingContracts.forEach((c, i) => {
      const r = priceAtFundingResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [priceAtFundingContracts, priceAtFundingResults]);

  const previewContracts = useMemo(
    () =>
      loanContractAddresses
        .filter((a): a is `0x${string}` => Boolean(a))
        .map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: 'liquidationPreview' as const, chainId })),
    [loanContractAddresses, chainId],
  );
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

  const { data: repaymentDueAtResults, refetch: refetchRepaymentDueAt } = useReadContracts({
    contracts: repaymentDueAtContracts,
    query: { enabled: repaymentDueAtContracts.length > 0, refetchInterval: POLL_MS },
  });

  // Address-keyed maps so statusResults/lenderResults indices never drift from loanIds indices
  // (statusContracts filters out undefined entries, making its length < loanIds.length when any
  //  terms call fails — direct index access then maps the wrong result to the wrong loan.)
  const statusByAddress = useMemo(() => {
    const map = new Map<string, number>();
    statusContracts.forEach((c, i) => {
      const r = statusResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), Number(r.result as unknown as bigint));
    });
    return map;
  }, [statusContracts, statusResults]);

  const myContributionByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    lenderContracts.forEach((c, i) => {
      const r = lenderResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [lenderContracts, lenderResults]);

  const isLiquidatableByAddress = useMemo(() => {
    const map = new Map<string, boolean>();
    isLiquidatableContracts.forEach((c, i) => {
      const r = isLiquidatableResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as boolean);
    });
    return map;
  }, [isLiquidatableContracts, isLiquidatableResults]);

  const repaymentDueAtByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    repaymentDueAtContracts.forEach((c, i) => {
      const r = repaymentDueAtResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [repaymentDueAtContracts, repaymentDueAtResults]);

  const ltvByAddress = useMemo(() => {
    const map = new Map<string, bigint>();
    ltvContracts.forEach((c, i) => {
      const r = ltvResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as bigint);
    });
    return map;
  }, [ltvContracts, ltvResults]);

  const priceLiqByAddress = useMemo(() => {
    const map = new Map<string, boolean>();
    priceLiqContracts.forEach((c, i) => {
      const r = priceLiqResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as boolean);
    });
    return map;
  }, [priceLiqContracts, priceLiqResults]);

  const delinqLiqByAddress = useMemo(() => {
    const map = new Map<string, boolean>();
    delinqLiqContracts.forEach((c, i) => {
      const r = delinqLiqResults?.[i];
      if (r?.status === 'success') map.set(c.address.toLowerCase(), r.result as boolean);
    });
    return map;
  }, [delinqLiqContracts, delinqLiqResults]);

  // Borrower risk explanations, persisted at loan creation. Fetched in one batch
  // keyed by loan contract address; loans created before this feature existed
  // simply have no row and the panel says so.
  const [assessments, setAssessments] = useState<Record<string, StoredAssessment>>({});
  const addressKey = useMemo(
    () => loanContractAddresses.filter(Boolean).join(','),
    [loanContractAddresses],
  );

  useEffect(() => {
    if (!addressKey) return;
    let cancelled = false;
    fetch(`/api/loans/risk?loanContracts=${addressKey}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.assessments) setAssessments(d.assessments);
      })
      .catch(() => { /* non-critical: panel degrades to terms-only */ });
    return () => { cancelled = true; };
  }, [addressKey]);

  async function refetchAll() {
    await Promise.all([
      refetchIds(),
      refetchStatus(),
      refetchLenders(),
      refetchPendingWithdrawals(),
      refetchTotalContributed(),
      refetchMinContribution(),
      refetchIsLiquidatable(),
      refetchRepaymentDueAt(),
      refetchLtv(),
      refetchPriceLiq(),
      refetchDelinqLiq(),
      refetchPreview(),
      refetchOutstanding(),
      refetchPriceAtFunding(),
    ]);
  }

  // ── Fund tx ──
  const { writeContractAsync, isPending: isFundPending } = useWriteContract();
  const { isLoading: isFundConfirming, isSuccess: isFundConfirmed } = useWaitForTransactionReceipt({
    hash: fundingHash,
  });
  const { isLoading: isLiqConfirming, isSuccess: isLiqConfirmed } = useWaitForTransactionReceipt({
    hash: liqHash,
  });

  // Immediately refresh contract state after any confirmed tx so positions update without waiting 30s
  useEffect(() => {
    if (isFundConfirmed) void refetchAll();
  }, [isFundConfirmed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isLiqConfirmed) void refetchAll();
  }, [isLiqConfirmed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Combine into unified loan list ──
  const loans = useMemo(() => {
    if (!loanIds || !termsResults) return [];
    return loanIds.map((id, i) => {
      const termsResult = termsResults[i];
      const terms =
        termsResult?.status === 'success' ? (termsResult.result as LoanTermsTuple) : null;
      const loanAddr = terms?.loanContract?.toLowerCase();
      const statusVal = loanAddr !== undefined ? statusByAddress.get(loanAddr) : undefined;
      const myContribution = loanAddr !== undefined ? myContributionByAddress.get(loanAddr) : undefined;
      const totalContributedVal = loanAddr !== undefined ? totalContributedByAddress.get(loanAddr) : undefined;
      const minContributionVal = loanAddr !== undefined ? minContributionByAddress.get(loanAddr) : undefined;
      const isLiquidatableVal = loanAddr !== undefined ? isLiquidatableByAddress.get(loanAddr) : undefined;
      const repaymentDueAtVal = loanAddr !== undefined ? repaymentDueAtByAddress.get(loanAddr) : undefined;
      const ltvBpsVal = loanAddr !== undefined ? ltvByAddress.get(loanAddr) : undefined;
      const priceLiqVal = loanAddr !== undefined ? priceLiqByAddress.get(loanAddr) : undefined;
      const delinqLiqVal = loanAddr !== undefined ? delinqLiqByAddress.get(loanAddr) : undefined;
      const previewVal = loanAddr !== undefined ? previewByAddress.get(loanAddr) : undefined;
      const outstandingVal = loanAddr !== undefined ? outstandingByAddress.get(loanAddr) : undefined;
      const priceAtFundingVal = loanAddr !== undefined ? priceAtFundingByAddress.get(loanAddr) : undefined;
      const pendingWithdrawalVal = loanAddr !== undefined ? pendingWithdrawalByAddress.get(loanAddr) : undefined;
      return {
        id, terms, statusVal, myContribution, totalContributedVal, minContributionVal, isLiquidatableVal, repaymentDueAtVal,
        ltvBpsVal, priceLiqVal, delinqLiqVal, previewVal, outstandingVal, priceAtFundingVal, pendingWithdrawalVal,
      };
    });
  }, [
    loanIds, termsResults, statusByAddress, myContributionByAddress, totalContributedByAddress, minContributionByAddress, isLiquidatableByAddress,
    repaymentDueAtByAddress, ltvByAddress, priceLiqByAddress, delinqLiqByAddress, previewByAddress, outstandingByAddress, priceAtFundingByAddress,
    pendingWithdrawalByAddress,
  ]);

  const settledAddresses = useMemo(
    () =>
      loans
        .filter((l) => (l.statusVal === 2 || l.statusVal === 4) && l.terms)
        .map((l) => l.terms!.loanContract),
    [loans],
  );
  // Earliest loan creation — where the event scan should start.
  const earliestCreatedAt = useMemo(() => {
    const times = loans.filter((l) => l.terms).map((l) => Number(l.terms!.createdAt));
    return times.length > 0 ? Math.min(...times) : undefined;
  }, [loans]);

  const { byLoan: eventsByLoan, priceFor } = useLoanEvents({
    factoryAddress,
    loanContracts: settledAddresses,
    chainId,
    ethPrice,
    fromTimestamp: earliestCreatedAt,
    enabled: settledAddresses.length > 0,
  });

  const openLoans = useMemo(
    () => loans.filter((l) => l.statusVal === 0 && l.terms && !isExpired(l.terms.createdAt)),
    [loans],
  );

  // Position ownership now follows contributions(activeAddress) > 0, so it
  // only reflects the active connected account (see the narrowing comment on
  // lenderContracts above), not every account in allAddresses.
  const isMine = (contribution: bigint | undefined) => (contribution ?? 0n) > 0n;

  // Settled loans (Repaid / Liquidated) the user funded. Previously these were
  // filtered out entirely, so the moment a borrower repaid, the lender's position
  // vanished with no trace that it had ever existed or been paid back.
  const settledPositions = useMemo(
    () => loans.filter((l) => (l.statusVal === 2 || l.statusVal === 4) && isMine(l.myContribution)),
    [loans],
  );

  const myPositions = useMemo(
    () => loans.filter((l) => l.statusVal === 1 && isMine(l.myContribution)),
    [loans],
  );

  // Shares a push transfer failed to deliver. Not scoped to myPositions -
  // a loan can be Repaid/Liquidated (and gone from the active list) while
  // still holding an undelivered share for this account.
  const claimableLoans = useMemo(
    () => loans.filter((l) => l.terms && (l.pendingWithdrawalVal ?? 0n) > 0n),
    [loans],
  );

  // Pools that can no longer complete, where this account still has an
  // escrowed contribution sitting in the contract: cancelled by the borrower,
  // or the funding window ran out while still Requested.
  const reclaimableLoans = useMemo(
    () =>
      loans.filter(
        (l) =>
          l.terms &&
          isMine(l.myContribution) &&
          (l.statusVal === 3 || (l.statusVal === 0 && isExpired(l.terms.createdAt))),
      ),
    [loans],
  );

  async function contributeLoan(loanContractAddr: `0x${string}`, amountWei: bigint, loanId: bigint) {
    setFundingError(null);
    setFundingErrorLoanId(null);
    setFundingLoanId(loanId);
    setFundingHash(undefined);
    try {
      await switchChainAsync({ chainId });
      const hash = await writeContractAsync({
        address: loanContractAddr,
        abi: LOAN_ABI,
        functionName: 'contribute',
        value: amountWei,
        chainId,
      });
      setFundingHash(hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setFundingError(msg.length > 160 ? msg.slice(0, 157) + '…' : msg);
      setFundingErrorLoanId(loanId);
      setFundingLoanId(null);
    }
  }

  // Client-side check mirroring contribute()'s own require()s, so a bad
  // amount fails with a readable message here instead of a wallet revert.
  // over-contributing is deliberately NOT rejected - the contract caps what
  // it accepts at the remaining gap and refunds the rest in the same tx.
  function validateContribution(raw: string, minWei: bigint): { amountWei: bigint } | { error: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { error: 'Enter an amount' };
    let amountWei: bigint;
    try {
      amountWei = parseEther(trimmed);
    } catch {
      return { error: 'Enter a valid ETH amount' };
    }
    if (amountWei <= 0n) return { error: 'Amount must be greater than zero' };
    if (amountWei < minWei) {
      return { error: `Minimum contribution is ${formatEther(minWei)} ETH` };
    }
    return { amountWei };
  }

  // Withdraw and reclaim state is keyed per loan id (not a single shared
  // scalar like fundingLoanId/liqLoanId above) so acting on one loan's card
  // never reassigns or clobbers another card's in-flight tx feedback.
  const [withdrawState, setWithdrawState] = useState<Record<string, TxState>>({});
  const [reclaimState, setReclaimState] = useState<Record<string, TxState>>({});

  async function withdrawLoan(loanContractAddr: `0x${string}`, loanId: bigint) {
    const key = loanId.toString();
    setWithdrawState((prev) => ({ ...prev, [key]: { status: 'pending' } }));
    try {
      await switchChainAsync({ chainId });
      const hash = await writeContractAsync({
        address: loanContractAddr,
        abi: LOAN_ABI,
        functionName: 'withdraw',
        chainId,
      });
      setWithdrawState((prev) => ({ ...prev, [key]: { status: 'confirming', hash } }));
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
      setWithdrawState((prev) => ({ ...prev, [key]: { status: 'confirmed', hash } }));
      void refetchAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setWithdrawState((prev) => ({
        ...prev,
        [key]: { status: 'error', error: msg.length > 160 ? msg.slice(0, 157) + '…' : msg },
      }));
    }
  }

  async function reclaimLoan(loanContractAddr: `0x${string}`, loanId: bigint) {
    const key = loanId.toString();
    setReclaimState((prev) => ({ ...prev, [key]: { status: 'pending' } }));
    try {
      await switchChainAsync({ chainId });
      const hash = await writeContractAsync({
        address: loanContractAddr,
        abi: LOAN_ABI,
        functionName: 'reclaimContribution',
        chainId,
      });
      setReclaimState((prev) => ({ ...prev, [key]: { status: 'confirming', hash } }));
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
      setReclaimState((prev) => ({ ...prev, [key]: { status: 'confirmed', hash } }));
      void refetchAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setReclaimState((prev) => ({
        ...prev,
        [key]: { status: 'error', error: msg.length > 160 ? msg.slice(0, 157) + '…' : msg },
      }));
    }
  }

  async function liquidateLoan(loanContractAddr: `0x${string}`, loanId: bigint) {
    setLiqLoanId(loanId);
    setLiqHash(undefined);
    try {
      await switchChainAsync({ chainId });
      const hash = await writeContractAsync({
        address: loanContractAddr,
        abi: LOAN_ABI,
        functionName: 'liquidate',
        chainId,
      });
      setLiqHash(hash);
    } catch (err) {
      console.error('[liquidate]', err);
      setLiqLoanId(null);
    }
  }

  const isLoading = idsLoading || termsLoading;

  // ── Not deployed ──
  if (!isDeployed) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-[#111827] p-10 text-center max-w-2xl mx-auto">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-slate-700 bg-slate-900 mb-5">
          <ClipboardList className="h-7 w-7 text-slate-500" />
        </div>
        <h2 className="text-lg font-black text-white mb-2">Contracts not deployed</h2>
        <p className="text-sm text-slate-500 mb-4">Deploy to Sepolia to start browsing loan requests.</p>
        <code className="block text-[11px] font-mono text-slate-500 bg-slate-900 rounded-xl px-4 py-3 text-left">
          cd contracts && npx hardhat ignition deploy ignition/modules/NexusFiMilestone1.ts --network sepolia
        </code>
        <p className="text-xs text-slate-600 mt-2">Then set NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA in frontend/.env.local</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Header + tab bar */}
      <div className="flex items-center justify-between">
        <div className="flex rounded-xl border border-slate-800 bg-slate-900/50 p-1 gap-1">
          <button
            onClick={() => setActiveTab('open')}
            className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${
              activeTab === 'open'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Open Requests
            {openLoans.length > 0 && (
              <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-400 text-[10px] font-black text-slate-950 px-1">
                {openLoans.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('positions')}
            className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${
              activeTab === 'positions'
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            My Positions
            {myPositions.length > 0 && (
              <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-black text-white px-1">
                {myPositions.length}
              </span>
            )}
          </button>
        </div>

        <button
          onClick={() => void refetchAll()}
          className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-white transition-colors"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl border border-slate-800 bg-[#111827] h-32 animate-pulse" />
          ))}
        </div>
      )}

      {/* ── Open Requests Tab ── */}
      {!isLoading && activeTab === 'open' && (
        <>
          {openLoans.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-[#111827] py-16 text-center">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-slate-700 mb-4">
                <Hexagon className="h-7 w-7 text-slate-700" />
              </div>
              <p className="text-sm font-bold text-slate-500">No open loan requests</p>
              <p className="text-xs text-slate-700 mt-1 max-w-xs mx-auto">
                Borrowers who submit a loan request will appear here. Check back soon.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Column headers */}
              <div className="hidden md:grid grid-cols-[2fr_1.2fr_1.2fr_1fr_1fr_auto] gap-3 px-5 text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                <span>Borrower / Tier</span>
                <span>Principal</span>
                <span>Total interest</span>
                <span>Duration</span>
                <span>Current LTV</span>
                <span>Funded</span>
              </div>

              {openLoans.map(({ id, terms, totalContributedVal, minContributionVal }) => {
                if (!terms) return null;
                const tier = inferRiskTierFromBps(Number(terms.maxLtvBps));
                const tierCfg = tier ? RISK_TIER_CONFIG[tier] : null;
                const aprNum = Number(terms.interestBps) / 100;

                const principalEth = parseFloat(formatEther(terms.principalAmount));
                const collateralEth = parseFloat(formatEther(terms.collateralAmount));
                const principalUsd = ethPrice > 0 ? principalEth * ethPrice : null;
                const collateralUsd = ethPrice > 0 ? collateralEth * ethPrice : null;

                // Pooled funding progress. totalContributedVal is undefined only
                // while the read is still in flight, not "zero" - but 0n is the
                // correct starting value for a brand-new request either way.
                const fundedWei = totalContributedVal ?? 0n;
                const fundedPct =
                  terms.principalAmount > 0n
                    ? Number((fundedWei * 10_000n) / terms.principalAmount) / 100
                    : 0;
                const remainingWei =
                  terms.principalAmount > fundedWei ? terms.principalAmount - fundedWei : 0n;
                // Fallback mirrors the contract's own formula for the brief window
                // before minContribution() resolves, so the input isn't blocked.
                const minWei =
                  minContributionVal ?? (terms.principalAmount / 100n === 0n ? 1n : terms.principalAmount / 100n);
                // "Fill the rest" must be at least minWei even when the remaining
                // gap is smaller than that - contribute() checks msg.value against
                // minContribution() regardless of how much of it is actually needed,
                // and refunds the surplus in the same transaction.
                const remainingOrMinWei = remainingWei > minWei ? remainingWei : minWei;
                // Quick-fill shortcuts, each floored at minWei for the same reason.
                const quickFill25Wei = (() => {
                  const v = (remainingWei * 25n) / 100n;
                  return v > minWei ? v : minWei;
                })();
                const quickFill50Wei = (() => {
                  const v = (remainingWei * 50n) / 100n;
                  return v > minWei ? v : minWei;
                })();
                // Only true when the remaining gap is smaller than the minimum,
                // meaning the Remaining quick-fill necessarily offers more than
                // what's actually left (the contract floors at minWei and
                // refunds the surplus) - the one case worth calling out.
                const isNearFullEdgeCase = remainingWei > 0n && remainingWei < minWei;
                const idKey = id.toString();
                const contributionInput = contributionInputs[idKey] ?? formatEther(remainingOrMinWei);

                // Origination LTV = principal / collateral. Price-independent by
                // design (both legs are ETH) — correct for a not-yet-funded loan,
                // since the USD debt is only frozen at funding time.
                const currentLtv =
                  collateralUsd && collateralUsd > 0 ? (principalUsd ?? 0) / collateralUsd : null;
                const liqThreshold =
                  (Number(terms.maxLtvBps) + Number(terms.liquidationBufferBps)) / 10_000;
                const ltvColor =
                  currentLtv !== null && liqThreshold !== null
                    ? currentLtv < liqThreshold * 0.8
                      ? 'text-emerald-400'
                      : currentLtv < liqThreshold * 0.95
                      ? 'text-amber-400'
                      : 'text-red-400'
                    : 'text-slate-400';

                // Interest the lender earns
                const interestEarned =
                  principalUsd !== null
                    ? principalUsd * (aprNum / 100) * (Number(terms.durationDays) / 365)
                    : null;

                const isFunding = fundingLoanId === id;
                const isTxInFlight = isFunding && (isFundPending || isFundConfirming);
                const isTxDone = isFunding && isFundConfirmed;
                const isSelfLoan =
                  Boolean(address) &&
                  terms.borrower.toLowerCase() === address!.toLowerCase();

                return (
                  <div
                    key={id.toString()}
                    className="rounded-2xl border border-slate-800 bg-[#111827] p-5 transition-colors hover:border-blue-500/20"
                  >
                    {/* Mobile layout */}
                    <div className="md:hidden space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold text-slate-500 font-mono">#{id.toString()}</span>
                          {tier && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${TIER_BADGE[tier]}`}>
                              Tier {tier}
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-500 font-mono">
                          {timeLeft(terms.createdAt)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div>
                          <p className="text-slate-600 text-[10px]">Borrower</p>
                          <p className="font-mono text-white">{terms.borrower.slice(0, 8)}…{terms.borrower.slice(-6)}</p>
                        </div>
                        <div>
                          <p className="text-slate-600 text-[10px]">Principal</p>
                          <p className="font-mono font-bold text-white">{principalEth.toFixed(4)} ETH</p>
                          {principalUsd && <p className="text-slate-500">{formatUsd(principalUsd)}</p>}
                        </div>
                      </div>
                      {isSelfLoan && (
                        <div
                          className="inline-flex h-7 px-3 rounded-lg border border-slate-700 bg-slate-900/50 items-center text-[11px] font-bold text-slate-600 whitespace-nowrap cursor-not-allowed"
                          title="You cannot fund your own loan request"
                        >
                          Your request
                        </div>
                      )}
                    </div>

                    {/* Desktop layout */}
                    <div className="hidden md:grid grid-cols-[2fr_1.2fr_1.2fr_1fr_1fr_auto] gap-3 items-center">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-mono text-slate-600">#{id.toString()}</span>
                          {tier && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${TIER_BADGE[tier]}`}>
                              Tier {tier}
                            </span>
                          )}
                          <span className="text-[10px] text-slate-600">{timeLeft(terms.createdAt)}</span>
                        </div>
                        <p className="text-xs font-mono text-slate-400 truncate">
                          {terms.borrower.slice(0, 10)}…{terms.borrower.slice(-8)}
                        </p>
                      </div>

                      <div>
                        <p className="text-sm font-mono font-bold text-white">{principalEth.toFixed(4)} ETH</p>
                        {principalUsd && <p className="text-[11px] font-mono text-slate-500">{formatUsd(principalUsd)}</p>}
                      </div>

                      <div>
                        {interestEarned !== null ? (
                          <>
                            <p className="text-sm font-mono font-bold text-emerald-400">+{formatUsd(interestEarned)}</p>
                            <p className="text-[11px] text-slate-500">{aprNum.toFixed(1)}% APR</p>
                          </>
                        ) : (
                          <p className="text-xs text-slate-700">N/A</p>
                        )}
                      </div>

                      <div>
                        <p className="text-sm font-mono font-bold text-white">{terms.durationDays.toString()}d</p>
                      </div>

                      <div>
                        {currentLtv !== null ? (
                          <>
                            <p className={`text-sm font-mono font-bold ${ltvColor}`}>{formatPercent(currentLtv)}</p>
                            {liqThreshold && (
                              <p className="text-[11px] text-slate-600">liq. at {formatPercent(liqThreshold)}</p>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-slate-700">N/A</p>
                        )}
                      </div>

                      <div className="text-right">
                        {isSelfLoan ? (
                          <span className="text-[11px] font-bold text-slate-600 whitespace-nowrap">Your request</span>
                        ) : (
                          <>
                            <p className="text-sm font-mono font-bold text-emerald-400">{fundedPct.toFixed(0)}%</p>
                            <p className="text-[10px] text-slate-600">funded</p>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Collateral detail row */}
                    <div className="mt-3 pt-3 border-t border-slate-800/60 flex flex-wrap items-center gap-4 text-[11px] text-slate-600">
                      <span>
                        Collateral locked:{' '}
                        <span className="font-mono text-slate-400">{collateralEth.toFixed(4)} ETH</span>
                        {collateralUsd && <span className="ml-1">({formatUsd(collateralUsd)})</span>}
                      </span>
                      <span>
                        Max LTV: <span className="font-mono text-slate-400">{formatPercent(Number(terms.maxLtvBps) / 10_000)}</span>
                      </span>
                      <a
                        href={`https://sepolia.etherscan.io/address/${terms.loanContract}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500/60 hover:text-blue-400 font-mono"
                      >
                        Contract ↗
                      </a>
                    </div>

                    {/* Funding progress + contribute control */}
                    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500 mb-1.5">
                        <span>Funding progress</span>
                        <span className="font-mono text-slate-400">
                          {parseFloat(formatEther(fundedWei)).toFixed(4)} / {principalEth.toFixed(4)} ETH funded
                        </span>
                      </div>
                      <div className="relative h-2.5 w-full rounded-full bg-slate-800 overflow-hidden mb-3">
                        <div
                          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                          style={{ width: `${Math.min(fundedPct, 100)}%` }}
                        />
                      </div>

                      {isSelfLoan ? (
                        <p className="text-[11px] font-bold text-slate-600">
                          You cannot fund your own loan request.
                        </p>
                      ) : isTxDone ? (
                        <div className="flex items-center gap-2 text-xs font-bold text-emerald-400">
                          <Check className="h-3.5 w-3.5" /> Contribution sent
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="number"
                              min="0"
                              step="0.000001"
                              value={contributionInput}
                              onChange={(e) =>
                                setContributionInputs((prev) => ({ ...prev, [idKey]: e.target.value }))
                              }
                              placeholder="Amount in ETH"
                              className="h-9 w-40 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-mono text-white focus:outline-none focus:border-blue-500/60"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setContributionInputs((prev) => ({ ...prev, [idKey]: formatEther(quickFill25Wei) }))
                              }
                              disabled={isTxInFlight}
                              className="h-9 px-3 rounded-lg border border-slate-700 text-[11px] font-bold text-slate-400 hover:text-white hover:border-slate-500 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              25%
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setContributionInputs((prev) => ({ ...prev, [idKey]: formatEther(quickFill50Wei) }))
                              }
                              disabled={isTxInFlight}
                              className="h-9 px-3 rounded-lg border border-slate-700 text-[11px] font-bold text-slate-400 hover:text-white hover:border-slate-500 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              50%
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setContributionInputs((prev) => ({ ...prev, [idKey]: formatEther(remainingOrMinWei) }))
                              }
                              disabled={isTxInFlight}
                              className="h-9 px-3 rounded-lg border border-slate-700 text-[11px] font-bold text-slate-400 hover:text-white hover:border-slate-500 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Remaining
                            </button>
                            <button
                              onClick={() => {
                                const result = validateContribution(contributionInput, minWei);
                                if ('error' in result) {
                                  setFundingError(result.error);
                                  setFundingErrorLoanId(id);
                                  return;
                                }
                                void contributeLoan(terms.loanContract, result.amountWei, id);
                              }}
                              disabled={isTxInFlight}
                              className="h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-bold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap shadow-lg shadow-blue-500/20"
                            >
                              {isTxInFlight ? (
                                <>
                                  <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                                  {isFundConfirming ? 'Confirming…' : 'Confirm…'}
                                </>
                              ) : (
                                'Contribute'
                              )}
                            </button>
                          </div>
                          {isNearFullEdgeCase ? (
                            <p className="text-[10px] text-amber-400/90 mt-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5">
                              Only <span className="font-mono">{formatEther(remainingWei)} ETH</span> is left to fund this loan, but the minimum contribution is{' '}
                              <span className="font-mono">{formatEther(minWei)} ETH</span>. The Remaining button offers{' '}
                              <span className="font-mono">{formatEther(remainingOrMinWei)} ETH</span> - the extra{' '}
                              <span className="font-mono">{formatEther(minWei - remainingWei)} ETH</span> comes back automatically.
                            </p>
                          ) : (
                            <p className="text-[10px] text-slate-700 mt-1.5">
                              Minimum contribution: <span className="font-mono text-slate-500">{formatEther(minWei)} ETH</span>.
                              {' '}Sending more than what is left is fine, the contract only takes what is needed and refunds the rest.
                            </p>
                          )}
                        </>
                      )}
                    </div>

                    {/* Why this tier + what protects the lender, before they commit capital */}
                    <div className="mt-3">
                      <LoanSafetyPanel
                        tier={tier}
                        maxLtvBps={Number(terms.maxLtvBps)}
                        liquidationBufferBps={Number(terms.liquidationBufferBps)}
                        interestBps={Number(terms.interestBps)}
                        durationDays={Number(terms.durationDays)}
                        currentLtv={currentLtv}
                        collateralUsd={collateralUsd}
                        principalUsd={principalUsd}
                        assessment={assessments[terms.loanContract.toLowerCase()] ?? null}
                      />
                    </div>

                    {/* Tx feedback */}
                    {isFunding && fundingHash && (
                      <div className="mt-3 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-2.5 flex items-center gap-3">
                        {!isFundConfirmed && (
                          <span className="h-3.5 w-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin flex-shrink-0" />
                        )}
                        {isFundConfirmed && <Check className="h-4 w-4 text-emerald-400 flex-shrink-0" />}
                        <div>
                          <p className="text-xs font-bold text-white">
                            {!isFundConfirmed
                              ? 'Confirming…'
                              : remainingWei === 0n
                              ? 'Loan funded!'
                              : 'Contribution confirmed'}
                          </p>
                          <a
                            href={`https://sepolia.etherscan.io/tx/${fundingHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-mono text-blue-400"
                          >
                            {fundingHash.slice(0, 18)}… ↗
                          </a>
                        </div>
                      </div>
                    )}
                    {fundingError && fundingErrorLoanId === id && (
                      <p className="mt-2 text-[11px] text-red-400 font-mono break-all">{fundingError}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Info box */}
          <div className="rounded-2xl border border-slate-800 bg-[#111827] p-5">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">How lending works</p>
            <ol className="space-y-2">
              {[
                { n: '1', text: 'Browse open requests. Borrowers have already locked collateral.' },
                { n: '2', text: 'Contribute any amount at or above the minimum. Several lenders can fund the same loan; once contributions reach the full principal, it goes to the borrower.' },
                { n: '3', text: 'The borrower repays principal + interest within the loan duration' },
                { n: '4', text: 'Repayment is sent to your wallet, split by your share of the pool. Their collateral is released.' },
                { n: '5', text: "If the borrower misses the repayment deadline (plus a short grace period), Liquidate becomes available to seize their collateral." },
              ].map(({ n, text }) => (
                <li key={n} className="flex items-start gap-3">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-slate-800 text-[10px] font-black text-slate-500">{n}</span>
                  <p className="text-[11px] text-slate-600">{text}</p>
                </li>
              ))}
            </ol>
            <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2.5">
              <p className="text-[11px] text-amber-400/80">
                <span className="font-bold">Risk note:</span> Collateral covers principal at max LTV. ETH price drops increase your risk. Monitor the LTV bar on each position.
              </p>
            </div>
          </div>
        </>
      )}

      {/* ── My Positions Tab ── */}
      {!isLoading && activeTab === 'positions' && (
        <>
          {/* Claim banner — undelivered shares. Shown above everything else,
              regardless of whether the loan still has an active position,
              since money can be waiting here even on an already-settled loan. */}
          {claimableLoans.length > 0 && (
            <div className="space-y-2">
              {claimableLoans.map((l) => {
                if (!l.terms) return null;
                const key = l.id.toString();
                const amountWei = l.pendingWithdrawalVal ?? 0n;
                const tx = withdrawState[key];
                const isBusy = tx?.status === 'pending' || tx?.status === 'confirming';
                return (
                  <div
                    key={key}
                    className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex flex-wrap items-center gap-3"
                  >
                    <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
                    <p className="text-xs font-bold text-amber-200">
                      <span className="font-mono">{parseFloat(formatEther(amountWei)).toFixed(6)} ETH</span> from
                      loan #{key} could not be delivered to your wallet automatically.
                    </p>
                    <button
                      onClick={() => void withdrawLoan(l.terms!.loanContract, l.id)}
                      disabled={isBusy}
                      className="ml-auto h-8 px-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-xs font-bold text-slate-950 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {isBusy ? (
                        <>
                          <span className="h-3 w-3 rounded-full border-2 border-slate-950 border-t-transparent animate-spin" />
                          {tx?.status === 'confirming' ? 'Confirming…' : 'Confirm…'}
                        </>
                      ) : tx?.status === 'confirmed' ? (
                        'Claimed'
                      ) : (
                        'Claim it'
                      )}
                    </button>
                    {tx?.hash && (
                      <a
                        href={`https://sepolia.etherscan.io/tx/${tx.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full text-[10px] font-mono text-blue-500 hover:text-blue-400"
                      >
                        {tx.hash.slice(0, 18)}… ↗
                      </a>
                    )}
                    {tx?.status === 'error' && tx.error && (
                      <p className="w-full text-[11px] text-red-400 font-mono break-all">{tx.error}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Reclaim section — dead pools (cancelled, or expired while still
              Requested) where this account has an escrowed contribution. */}
          {reclaimableLoans.length > 0 && (
            <div className="space-y-2">
              {reclaimableLoans.map((l) => {
                if (!l.terms) return null;
                const key = l.id.toString();
                const cancelled = l.statusVal === 3;
                const myContribEth =
                  l.myContribution !== undefined ? parseFloat(formatEther(l.myContribution)) : null;
                const tx = reclaimState[key];
                const isBusy = tx?.status === 'pending' || tx?.status === 'confirming';
                return (
                  <div
                    key={key}
                    className="rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3 flex flex-wrap items-center gap-3"
                  >
                    <p className="text-xs text-slate-300">
                      <span className="font-mono text-slate-600">#{key}</span>{' '}
                      {cancelled
                        ? 'This request was cancelled by the borrower'
                        : 'This request expired'}{' '}
                      before funding completed. Your{' '}
                      <span className="font-mono font-bold text-white">
                        {myContribEth !== null ? myContribEth.toFixed(4) : '…'} ETH
                      </span>{' '}
                      contribution is waiting in the contract.
                    </p>
                    <button
                      onClick={() => void reclaimLoan(l.terms!.loanContract, l.id)}
                      disabled={isBusy}
                      className="ml-auto h-8 px-3 rounded-lg border border-slate-600 hover:border-slate-400 text-xs font-bold text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {isBusy ? (
                        <>
                          <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                          {tx?.status === 'confirming' ? 'Confirming…' : 'Confirm…'}
                        </>
                      ) : tx?.status === 'confirmed' ? (
                        'Reclaimed'
                      ) : (
                        'Reclaim'
                      )}
                    </button>
                    {tx?.hash && (
                      <a
                        href={`https://sepolia.etherscan.io/tx/${tx.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full text-[10px] font-mono text-blue-500 hover:text-blue-400"
                      >
                        {tx.hash.slice(0, 18)}… ↗
                      </a>
                    )}
                    {tx?.status === 'error' && tx.error && (
                      <p className="w-full text-[11px] text-red-400 font-mono break-all">{tx.error}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {myPositions.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-[#111827] py-16 text-center">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-slate-700 mb-4">
                <TrendingUp className="h-7 w-7 text-slate-700" />
              </div>
              <p className="text-sm font-bold text-slate-500">No active positions</p>
              <p className="text-xs text-slate-700 mt-1 max-w-xs mx-auto">
                Fund a loan request to see your position here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {myPositions.map(({ id, terms, myContribution, isLiquidatableVal, repaymentDueAtVal, ltvBpsVal, priceLiqVal, delinqLiqVal, previewVal, outstandingVal, priceAtFundingVal }) => {
                if (!terms) return null;
                const tier = inferRiskTierFromBps(Number(terms.maxLtvBps));
                const tierCfg = tier ? RISK_TIER_CONFIG[tier] : null;
                const aprNum = Number(terms.interestBps) / 100;

                const principalEth = parseFloat(formatEther(terms.principalAmount));
                const collateralEth = parseFloat(formatEther(terms.collateralAmount));
                const principalUsd = ethPrice > 0 ? principalEth * ethPrice : null;
                const collateralUsd = ethPrice > 0 ? collateralEth * ethPrice : null;

                // Pooled funding: this position may only be a fraction of the
                // principal, not the whole loan. "You funded" and "Interest to
                // earn" below must reflect that share, not the full loan.
                const myContribEth = myContribution !== undefined ? parseFloat(formatEther(myContribution)) : null;
                const myContribUsd = myContribEth !== null && ethPrice > 0 ? myContribEth * ethPrice : null;
                const myShareFrac =
                  myContribution !== undefined && terms.principalAmount > 0n
                    ? Number(myContribution) / Number(terms.principalAmount)
                    : 0;
                // Basis-point precision share, for the "Your share: X%" readout.
                const myShareBps =
                  myContribution !== undefined && terms.principalAmount > 0n
                    ? (myContribution * 10_000n) / terms.principalAmount
                    : null;

                // LTV read from the contract (frozen USD debt / live USD collateral).
                // 0 means "unknown" (no oracle data), not "healthy" — fall back to
                // the static ratio only for display in that case.
                const onChainLtv =
                  ltvBpsVal !== undefined && Number(ltvBpsVal) > 0 ? Number(ltvBpsVal) / 10_000 : null;
                const staticLtv =
                  collateralUsd && collateralUsd > 0 ? (principalUsd ?? 0) / collateralUsd : null;
                const currentLtv = onChainLtv ?? staticLtv;
                const liqThreshold =
                  (Number(terms.maxLtvBps) + Number(terms.liquidationBufferBps)) / 10_000;
                const isLtvBreached = priceLiqVal === true;

                const interestEarned =
                  principalUsd !== null
                    ? principalUsd * myShareFrac * (aprNum / 100) * (Number(terms.durationDays) / 365)
                    : null;

                const isLiquidating = liqLoanId === id;
                // The real, on-chain gate: liquidate() only succeeds once this is true.
                const canLiquidate = isLiquidatableVal === true;
                const liqReason = priceLiqVal
                  ? 'collateral shortfall'
                  : delinqLiqVal
                  ? 'overdue'
                  : null;
                const countdown = liquidationCountdown(repaymentDueAtVal);

                // The debt is frozen in USD at FUNDING, so what matters is the price
                // relative to that, not to $2,000. Crashing to the same price you
                // funded at changes nothing — this makes the real trigger explicit.
                const thresholdFrac =
                  (Number(terms.maxLtvBps) + Number(terms.liquidationBufferBps)) / 10_000;
                const fundingPrice = priceAtFundingVal ? Number(priceAtFundingVal) : null;
                const liqPriceUsd =
                  fundingPrice && fundingPrice > 0 && thresholdFrac > 0
                    ? (Number(formatEther(terms.principalAmount)) * fundingPrice) /
                      (Number(formatEther(terms.collateralAmount)) * thresholdFrac)
                    : null;

                // "Still owed to you", "Repaid so far" and "If you liquidated
                // now" are this lender's pro-rata slice of the loan-wide
                // figures, scaled with the same mulDiv-style bigint math the
                // contract itself uses to split every repayment and seizure -
                // never via a float intermediate.
                const myOutstandingWei = myShareOfWei(outstandingVal, myContribution, terms.principalAmount);
                const repaidSoFarWei =
                  outstandingVal === undefined
                    ? undefined
                    : terms.principalAmount > outstandingVal
                    ? terms.principalAmount - outstandingVal
                    : 0n;
                const myRepaidSoFarWei = myShareOfWei(repaidSoFarWei, myContribution, terms.principalAmount);
                const mySeizeWei = previewVal
                  ? myShareOfWei(previewVal.seize, myContribution, terms.principalAmount)
                  : null;
                const dueDate =
                  repaymentDueAtVal !== undefined
                    ? new Date(Number(repaymentDueAtVal) * 1000).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })
                    : null;

                return (
                  <div
                    key={id.toString()}
                    className={`rounded-2xl border bg-[#111827] p-5 ${isLtvBreached ? 'border-red-500/30' : 'border-slate-800'}`}
                  >
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-slate-500">#{id.toString()}</span>
                        {tier && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${TIER_BADGE[tier]}`}>
                            Tier {tier}
                          </span>
                        )}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_COLORS[1]}`}>
                          Funded
                        </span>
                        {canLiquidate && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/20 text-red-400 flex items-center gap-1">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            LIQUIDATABLE{liqReason ? ` — ${liqReason}` : ''}
                          </span>
                        )}
                      </div>
                      <a
                        href={`https://sepolia.etherscan.io/address/${terms.loanContract}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-mono text-blue-500/60 hover:text-blue-400"
                      >
                        Contract ↗
                      </a>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                      <div>
                        <p className="text-[10px] text-slate-600">Borrower</p>
                        <p className="text-xs font-mono text-slate-400">{terms.borrower.slice(0, 8)}…{terms.borrower.slice(-6)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-600">You funded</p>
                        <p className="text-sm font-mono font-bold text-white">
                          {myContribEth !== null ? myContribEth.toFixed(4) : '…'} ETH
                        </p>
                        {myContribUsd && <p className="text-[11px] text-slate-500">{formatUsd(myContribUsd)}</p>}
                        <p className="text-[10px] text-slate-700">
                          Your share:{' '}
                          <span className="font-mono text-slate-500">
                            {myShareBps !== null ? (Number(myShareBps) / 100).toFixed(2) : '…'}%
                          </span>{' '}
                          ({myContribEth !== null ? myContribEth.toFixed(4) : '…'} / {principalEth.toFixed(4)} ETH)
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-600">Interest to earn</p>
                        {interestEarned !== null ? (
                          <p className="text-sm font-mono font-bold text-emerald-400">+{formatUsd(interestEarned)}</p>
                        ) : (
                          <p className="text-xs text-slate-700">N/A</p>
                        )}
                        <p className="text-[11px] text-slate-500">{aprNum.toFixed(1)}% APR</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-600">Duration</p>
                        <p className="text-sm font-mono font-bold text-white">{terms.durationDays.toString()}d</p>
                      </div>
                    </div>

                    {/* LTV bar — driven by the contract's own currentLtvBps() */}
                    {currentLtv !== null && (
                      <div className="space-y-1 mb-4">
                        <div className="flex justify-between text-[10px] text-slate-500">
                          <span>
                            Current LTV: <span className="font-mono font-bold text-white">{formatPercent(currentLtv)}</span>
                            {onChainLtv === null && <span className="ml-1 text-slate-600">(oracle unavailable)</span>}
                          </span>
                          <span>Liquidation at <span className="font-mono text-red-400">{formatPercent(liqThreshold)}</span></span>
                        </div>
                        <div className="relative h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(currentLtv * 100, 100)}%`,
                              backgroundColor:
                                isLtvBreached ? '#ef4444' : currentLtv < liqThreshold * 0.8 ? '#10b981' : '#f59e0b',
                            }}
                          />
                          <div
                            className="absolute top-0 h-full w-0.5 bg-red-500/70"
                            style={{ left: `${liqThreshold * 100}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Money picture — what's owed, what's been paid, what you'd recover */}
                    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 mb-3">
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                        Where the money stands
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <div>
                          <p className="text-[10px] text-slate-600">Still owed to you</p>
                          <p className="text-sm font-mono font-bold text-amber-400">
                            {myOutstandingWei !== null ? `${parseFloat(formatEther(myOutstandingWei)).toFixed(6)} ETH` : '…'}
                          </p>
                          <p className="text-[10px] text-slate-700">your share of principal + interest so far</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-600">Repaid so far</p>
                          <p className="text-sm font-mono font-bold text-emerald-400">
                            {myRepaidSoFarWei !== null ? `${parseFloat(formatEther(myRepaidSoFarWei)).toFixed(6)} ETH` : '…'}
                          </p>
                          <p className="text-[10px] text-slate-700">your share, already in your wallet</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-600">If you liquidated now</p>
                          <p className="text-sm font-mono font-bold text-white">
                            {mySeizeWei !== null ? `${parseFloat(formatEther(mySeizeWei)).toFixed(6)} ETH` : '…'}
                          </p>
                          <p className="text-[10px] text-slate-700">
                            {previewVal
                              ? `${parseFloat(formatEther(previewVal.refund)).toFixed(6)} ETH back to borrower`
                              : 'you recover only what is owed'}
                          </p>
                        </div>
                      </div>

                      {liqPriceUsd !== null && (
                        <p className="text-[10px] text-slate-600 mt-2 pt-2 border-t border-slate-800/60">
                          Funded when ETH was{' '}
                          <span className="font-mono text-slate-400">${fundingPrice?.toLocaleString()}</span>. The debt
                          is fixed in USD at that price, so this becomes liquidatable once ETH falls below{' '}
                          <span className="font-mono text-amber-400">
                            ${liqPriceUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </span>
                          {' '}— dropping the price to the level it was funded at changes nothing.
                        </p>
                      )}

                      <p className="text-[10px] text-slate-700 mt-1.5">
                        Payments arrive as internal contract transfers, so your balance changes but
                        MetaMask&apos;s activity list won&apos;t show a new entry.
                      </p>
                    </div>

                    {/* Collateral info */}
                    <div className="flex flex-wrap gap-4 text-[11px] text-slate-600 pt-3 border-t border-slate-800/60">
                      <span>
                        Collateral: <span className="font-mono text-slate-400">{collateralEth.toFixed(4)} ETH</span>
                        {collateralUsd && <span className="ml-1">({formatUsd(collateralUsd)})</span>}
                      </span>
                      {dueDate && (
                        <span>
                          Repayment due: <span className="font-mono text-slate-400">{dueDate}</span>
                        </span>
                      )}
                    </div>

                    <div className="mt-3">
                      <LoanSafetyPanel
                        tier={tier}
                        maxLtvBps={Number(terms.maxLtvBps)}
                        liquidationBufferBps={Number(terms.liquidationBufferBps)}
                        interestBps={Number(terms.interestBps)}
                        durationDays={Number(terms.durationDays)}
                        currentLtv={currentLtv}
                        collateralUsd={collateralUsd}
                        principalUsd={principalUsd}
                        isLiquidatable={canLiquidate}
                        assessment={assessments[terms.loanContract.toLowerCase()] ?? null}
                      />
                    </div>

                    {/* Liquidate button — gated on-chain by isLiquidatable() (deadline + grace period) */}
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        onClick={() => void liquidateLoan(terms.loanContract, id)}
                        disabled={!canLiquidate || (isLiquidating && (isLiqConfirming || !liqHash))}
                        title={!canLiquidate ? 'Not liquidatable yet — the borrower is still within the repayment deadline or grace period' : undefined}
                        className="h-9 px-4 rounded-lg border border-red-500/30 bg-red-500/10 text-xs font-bold text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {isLiquidating && !liqHash ? (
                          <>
                            <span className="h-3 w-3 rounded-full border-2 border-red-400 border-t-transparent animate-spin" />
                            Confirm…
                          </>
                        ) : isLiquidating && isLiqConfirming ? (
                          <>
                            <span className="h-3 w-3 rounded-full border-2 border-red-400 border-t-transparent animate-spin" />
                            Confirming…
                          </>
                        ) : isLiquidating && isLiqConfirmed ? (
                          'Liquidated'
                        ) : (
                          'Liquidate'
                        )}
                      </button>
                      <span className="text-[10px] text-slate-700">
                        {canLiquidate
                          ? previewVal && mySeizeWei !== null
                            ? `Recovers ${parseFloat(formatEther(mySeizeWei)).toFixed(6)} ETH (your share of what's owed). The pool's total seizure is ${parseFloat(formatEther(previewVal.seize)).toFixed(6)} ETH; the remaining ${parseFloat(formatEther(previewVal.refund)).toFixed(6)} ETH goes back to the borrower.`
                            : 'Recovers only what you are owed; the surplus returns to the borrower.'
                          : countdown ?? 'Not yet liquidatable.'}
                      </span>
                    </div>

                    {isLiquidating && liqHash && (
                      <div className="mt-2">
                        <a
                          href={`https://sepolia.etherscan.io/tx/${liqHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-mono text-blue-400"
                        >
                          {liqHash.slice(0, 18)}… ↗
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Settled positions — keeps the record after a loan closes */}
          {settledPositions.length > 0 && (
            <div className="mt-6">
              <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                Completed ({settledPositions.length})
              </p>
              <div className="space-y-2">
                {settledPositions.map(({ id, terms, statusVal, myContribution, previewVal }) => {
                  if (!terms) return null;
                  const repaid = statusVal === 2;
                  const myContribEth = myContribution !== undefined ? parseFloat(formatEther(myContribution)) : null;
                  // Frozen at liquidation time (Loan.sol stops interest accrual at
                  // closedAt once the loan is no longer Funded), so this is the
                  // actual pro-rata seizure, not a live estimate.
                  const mySeizeWei = previewVal
                    ? myShareOfWei(previewVal.seize, myContribution, terms.principalAmount)
                    : null;
                  return (
                    <div
                      key={id.toString()}
                      className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 flex flex-wrap items-center gap-3"
                    >
                      <span className="text-[10px] font-mono text-slate-600">#{id.toString()}</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                          repaid ? STATUS_COLORS[2] : STATUS_COLORS[4]
                        }`}
                      >
                        {repaid ? 'Repaid' : 'Liquidated'}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {repaid ? (
                          <>Borrower repaid - you received your {myContribEth !== null ? myContribEth.toFixed(4) : '…'} ETH contribution plus interest.</>
                        ) : (
                          <>
                            You seized{' '}
                            {mySeizeWei !== null ? parseFloat(formatEther(mySeizeWei)).toFixed(4) : '…'} ETH of
                            collateral (your share).
                          </>
                        )}
                      </span>
                      <span className="text-[10px] text-slate-700">
                        Liq. buffer: {formatPercent(Number(terms.liquidationBufferBps) / 10_000)}
                      </span>
                      <a
                        href={`https://sepolia.etherscan.io/address/${terms.loanContract}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto text-[10px] font-mono text-blue-500/60 hover:text-blue-400"
                      >
                        Contract ↗
                      </a>

                      <div className="w-full">
                        <LoanSettlementReceipt
                          role="lender"
                          principal={terms.principalAmount}
                          collateral={terms.collateralAmount}
                          events={eventsByLoan.get(terms.loanContract.toLowerCase()) ?? []}
                          statusVal={statusVal ?? 2}
                          priceFor={priceFor}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
