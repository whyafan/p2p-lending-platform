'use client';

/**
 * Demo control room — deliberately NOT linked from the main navigation.
 *
 * Both liquidation triggers depend on things you can't normally force: a real
 * market crash, or real days passing. This page fakes both on demand so the
 * system can be demoed or tested at any moment:
 *
 *   - Price:  writes straight to MockPriceFeed.setPrice (permissionless on testnet)
 *   - Time:   calls Loan.fastForward(), which rewinds a loan's own timestamps
 *             (block.timestamp can't be moved on a live chain)
 *
 * Kept on its own route so none of this clutters the borrower/lender dashboards.
 */

import { useMemo, useState, useEffect } from 'react';
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi';
import { formatEther } from 'viem';
import { sepolia, hardhat } from 'wagmi/chains';
import Link from 'next/link';
import { FACTORY_ABI, LOAN_ABI, PRICE_FEED_ABI } from '../../lib/loan-abi';
import { FlaskConical, ArrowLeft, Zap, Clock, AlertTriangle } from 'lucide-react';

const DAY = 24 * 60 * 60;

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

const STATUS_LABEL = ['Requested', 'Funded', 'Repaid', 'Cancelled', 'Liquidated'] as const;

export default function DemoPage() {
  const { address, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const chainId = sepolia.id;
  const factoryAddress = process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA as `0x${string}` | undefined;
  const priceFeedAddress = process.env.NEXT_PUBLIC_MOCK_PRICE_FEED_ADDRESS_SEPOLIA as `0x${string}` | undefined;

  const [priceInput, setPriceInput] = useState('');
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { isLoading: confirming, isSuccess: confirmed } = useWaitForTransactionReceipt({ hash: txHash });

  // ── current oracle price ──
  const { data: price, refetch: refetchPrice } = useReadContract({
    address: priceFeedAddress,
    abi: PRICE_FEED_ABI,
    functionName: 'latestPrice',
    chainId,
    query: { refetchInterval: 10_000 },
  });

  // ── all loans ──
  const { data: loanIds, refetch: refetchIds } = useReadContract({
    address: factoryAddress,
    abi: FACTORY_ABI,
    functionName: 'getLoanIds',
    chainId,
    query: { refetchInterval: 15_000 },
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
  const { data: termsResults, refetch: refetchTerms } = useReadContracts({
    contracts: termsContracts,
    query: { enabled: termsContracts.length > 0, refetchInterval: 15_000 },
  });

  const loanAddresses = useMemo(
    () =>
      (termsResults ?? [])
        .map((r) => (r.status === 'success' ? (r.result as LoanTermsTuple).loanContract : undefined))
        .filter((a): a is `0x${string}` => Boolean(a)),
    [termsResults],
  );

  const buildReads = (fn: 'status' | 'currentLtvBps' | 'isLiquidatable' | 'lender' | 'repaymentDueAt') =>
    loanAddresses.map((addr) => ({ address: addr, abi: LOAN_ABI, functionName: fn, chainId }));

  const { data: statusRes, refetch: refetchStatus } = useReadContracts({
    contracts: useMemo(() => buildReads('status'), [loanAddresses]),
    query: { enabled: loanAddresses.length > 0, refetchInterval: 15_000 },
  });
  const { data: ltvRes, refetch: refetchLtv } = useReadContracts({
    contracts: useMemo(() => buildReads('currentLtvBps'), [loanAddresses]),
    query: { enabled: loanAddresses.length > 0, refetchInterval: 15_000 },
  });
  const { data: liqRes, refetch: refetchLiq } = useReadContracts({
    contracts: useMemo(() => buildReads('isLiquidatable'), [loanAddresses]),
    query: { enabled: loanAddresses.length > 0, refetchInterval: 15_000 },
  });
  const { data: lenderRes, refetch: refetchLender } = useReadContracts({
    contracts: useMemo(() => buildReads('lender'), [loanAddresses]),
    query: { enabled: loanAddresses.length > 0, refetchInterval: 15_000 },
  });

  async function refetchAll() {
    await Promise.all([
      refetchPrice(), refetchIds(), refetchTerms(),
      refetchStatus(), refetchLtv(), refetchLiq(), refetchLender(),
    ]);
  }

  useEffect(() => {
    if (confirmed) void refetchAll();
  }, [confirmed]); // eslint-disable-line react-hooks/exhaustive-deps

  const loans = useMemo(() => {
    if (!loanIds || !termsResults) return [];
    return loanIds.map((id, i) => {
      const r = termsResults[i];
      const terms = r?.status === 'success' ? (r.result as LoanTermsTuple) : null;
      const idx = terms ? loanAddresses.indexOf(terms.loanContract) : -1;
      const pick = <T,>(res: typeof statusRes, fallback: T): T =>
        idx >= 0 && res?.[idx]?.status === 'success' ? (res[idx].result as T) : fallback;
      return {
        id,
        terms,
        statusVal: idx >= 0 && statusRes?.[idx]?.status === 'success' ? Number(statusRes[idx].result) : undefined,
        ltvBps: pick<bigint | undefined>(ltvRes, undefined),
        liquidatable: pick<boolean | undefined>(liqRes, undefined),
        lenderAddr: pick<`0x${string}` | undefined>(lenderRes, undefined),
      };
    });
  }, [loanIds, termsResults, loanAddresses, statusRes, ltvRes, liqRes, lenderRes]);

  // One wrapper around every write on this page, so the chain switch, the busy label
  // and the error truncation are identical whichever control was clicked. `label`
  // doubles as the key of the button that is currently pending, which is how a page of
  // buttons shows a spinner on exactly one of them.
  async function send(label: string, fn: () => Promise<`0x${string}`>) {
    setError(null);
    setBusy(label);
    setTxHash(undefined);
    try {
      await switchChainAsync({ chainId });
      setTxHash(await fn());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction failed';
      setError(msg.length > 200 ? msg.slice(0, 197) + '…' : msg);
    } finally {
      setBusy(null);
    }
  }

  const setPrice = (value: number) =>
    send(`price-${value}`, () =>
      writeContractAsync({
        address: priceFeedAddress as `0x${string}`,
        abi: PRICE_FEED_ABI,
        functionName: 'setPrice',
        // Whole dollars, floored at 0: the feed's interface has no decimals, and a
        // negative price would underflow the uint256 conversion rather than revert.
        args: [BigInt(Math.max(0, Math.round(value)))],
        chainId,
      }),
    );

  const fastForward = (loanContract: `0x${string}`, seconds: number, key: string) =>
    send(key, () =>
      writeContractAsync({
        address: loanContract,
        abi: LOAN_ABI,
        functionName: 'fastForward',
        args: [BigInt(seconds)],
        chainId,
      }),
    );

  const currentPrice = price !== undefined ? Number(price) : null;
  const configured = Boolean(factoryAddress && priceFeedAddress);

  return (
    <main className="min-h-screen bg-[#0a0e1a] text-white p-6">
      <div className="mx-auto max-w-5xl space-y-5">

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10">
              <FlaskConical className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-lg font-black">Demo controls</h1>
              <p className="text-[11px] text-slate-500">Force liquidation conditions without waiting for time or the market.</p>
            </div>
          </div>
          <Link href="/app" className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-white">
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </Link>
        </div>

        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2.5">
          <p className="text-[11px] text-amber-400/80">
            <span className="font-bold">Testnet only.</span> These actions write to real Sepolia contracts and affect
            every deployment (all branch URLs share the same contracts). The mock oracle is intentionally
            permissionless so any teammate can run the demo.
          </p>
        </div>

        {!configured ? (
          <p className="text-sm text-slate-500">Contract addresses are not configured for this environment.</p>
        ) : !isConnected ? (
          <div className="rounded-2xl border border-slate-800 bg-[#111827] p-8 text-center">
            <p className="text-sm font-bold text-slate-400">Connect a wallet to use the demo controls.</p>
            <p className="text-xs text-slate-600 mt-1">Time-skips must be sent by that loan&apos;s borrower or lender.</p>
          </div>
        ) : (
          <>
            {/* ── Price control ── */}
            <section className="rounded-2xl border border-slate-800 bg-[#111827] p-5">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="h-4 w-4 text-amber-400" />
                <h2 className="text-sm font-black uppercase tracking-widest">ETH price</h2>
              </div>
              <p className="text-[11px] text-slate-600 mb-4">
                Debt is frozen in USD at funding while collateral is valued live — so dropping this raises every
                funded loan&apos;s LTV. At 70% max LTV + 10% buffer, a loan becomes liquidatable once the price
                falls to roughly 62.5% of its funding price.
              </p>

              <div className="flex items-baseline gap-3 mb-4">
                <span className="text-3xl font-black font-mono">
                  {currentPrice !== null ? `$${currentPrice.toLocaleString()}` : '…'}
                </span>
                <span className="text-[11px] text-slate-600">current mock price</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {[
                  { label: 'Reset $2,000', value: 2000 },
                  { label: '−25%', value: currentPrice ? currentPrice * 0.75 : 1500 },
                  { label: '−50%', value: currentPrice ? currentPrice * 0.5 : 1000 },
                  { label: 'Crash to $500', value: 500 },
                ].map(({ label, value }) => (
                  <button
                    key={label}
                    onClick={() => void setPrice(value)}
                    disabled={busy !== null}
                    className="h-9 px-3 rounded-lg border border-slate-700 text-xs font-bold text-slate-300 hover:border-amber-500/50 hover:text-white disabled:opacity-40"
                  >
                    {label}
                  </button>
                ))}
                <div className="flex items-center gap-2 ml-auto">
                  <input
                    type="number"
                    min="0"
                    value={priceInput}
                    onChange={(e) => setPriceInput(e.target.value)}
                    placeholder="Custom $"
                    className="h-9 w-32 rounded-lg border border-slate-700 bg-slate-900 px-3 text-xs font-mono focus:outline-none focus:border-amber-500/60"
                  />
                  <button
                    onClick={() => {
                      const v = parseFloat(priceInput);
                      if (!isNaN(v) && v >= 0) void setPrice(v);
                    }}
                    disabled={busy !== null || priceInput === ''}
                    className="h-9 px-4 rounded-lg bg-amber-500 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
                  >
                    Set
                  </button>
                </div>
              </div>
              <p className="text-[10px] text-slate-700 mt-2">
                Setting $0 simulates a broken oracle — liquidation should be blocked, not triggered.
              </p>
            </section>

            {/* ── Time control ── */}
            <section className="rounded-2xl border border-slate-800 bg-[#111827] p-5">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-4 w-4 text-blue-400" />
                <h2 className="text-sm font-black uppercase tracking-widest">Skip time</h2>
              </div>
              <p className="text-[11px] text-slate-600 mb-4">
                Rewinds a loan&apos;s own clock (block time can&apos;t be moved on a live chain). Only that loan&apos;s
                borrower or lender can do it. Interest accrues over the skipped period, exactly as if the time had
                really passed.
              </p>

              {loans.length === 0 ? (
                <p className="text-xs text-slate-600">No loans yet. Create one from the dashboard first.</p>
              ) : (
                <div className="space-y-2">
                  {loans.map(({ id, terms, statusVal, ltvBps, liquidatable, lenderAddr }) => {
                    if (!terms) return null;
                    const me = address?.toLowerCase();
                    // Mirrors the contract's own participant check so the button is
                    // disabled rather than offered and then reverted. The contract
                    // remains the enforcement point; this is only the affordance.
                    const isParticipant =
                      me === terms.borrower.toLowerCase() || me === lenderAddr?.toLowerCase();
                    const closed = statusVal !== undefined && statusVal >= 2;
                    const ltv = ltvBps !== undefined && Number(ltvBps) > 0 ? Number(ltvBps) / 100 : null;
                    const durSecs = Number(terms.durationDays) * DAY;

                    return (
                      <div key={id.toString()} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                        <div className="flex flex-wrap items-center gap-2 mb-2 text-[11px]">
                          <span className="font-mono text-slate-500">#{id.toString()}</span>
                          <span className="font-bold text-slate-300">{STATUS_LABEL[statusVal ?? 0]}</span>
                          <span className="text-slate-600">{formatEther(terms.principalAmount)} ETH / {terms.durationDays.toString()}d</span>
                          {ltv !== null && (
                            <span className={`font-mono ${liquidatable ? 'text-red-400' : 'text-slate-400'}`}>
                              LTV {ltv.toFixed(1)}%
                            </span>
                          )}
                          {liquidatable && (
                            <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/20 text-red-400">
                              <AlertTriangle className="h-2.5 w-2.5" /> LIQUIDATABLE
                            </span>
                          )}
                        </div>

                        {closed ? (
                          <p className="text-[10px] text-slate-700">Loan is closed — nothing to skip.</p>
                        ) : !isParticipant ? (
                          <p className="text-[10px] text-slate-700">
                            You are not the borrower or lender on this loan, so you can&apos;t skip its clock.
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {[
                              { label: '+1 day', secs: DAY },
                              { label: 'To deadline', secs: durSecs + 60 },
                              { label: 'Past grace (liquidatable)', secs: durSecs + 2 * DAY + 120 },
                            ].map(({ label, secs }) => {
                              const key = `ff-${id}-${secs}`;
                              return (
                                <button
                                  key={label}
                                  onClick={() => void fastForward(terms.loanContract, secs, key)}
                                  disabled={busy !== null}
                                  className="h-8 px-3 rounded-lg border border-slate-700 text-[11px] font-bold text-slate-300 hover:border-blue-500/50 hover:text-white disabled:opacity-40"
                                >
                                  {busy === key ? 'Confirm…' : label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── tx feedback ── */}
            {txHash && (
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-2.5 flex items-center gap-3">
                {confirming && <span className="h-3.5 w-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />}
                <p className="text-xs font-bold">{confirmed ? 'Done — state refreshed.' : 'Confirming…'}</p>
                <a
                  href={`https://sepolia.etherscan.io/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-blue-400 ml-auto"
                >
                  {txHash.slice(0, 18)}… ↗
                </a>
              </div>
            )}
            {error && <p className="text-[11px] text-red-400 font-mono break-all">{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}
