'use client';

/**
 * Downloadable statements (T3), rendered on the Settings page.
 *
 * Everything is built from indexed on-chain events, so each row traces back to a
 * transaction hash. Deliberately not derived from wallet balances: MetaMask
 * cannot show internal contract transfers, which is exactly why users could not
 * reconstruct what happened to their money.
 */

import { useMemo, useState } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { FACTORY_ABI, LOAN_ABI } from '../lib/loan-abi';
import { useLoanEvents } from '../hooks/useLoanEvents';
import { distinctLenderActors } from '../lib/share-math';
import {
  generatePnl,
  generateTaxPnl,
  generateTradebook,
  statementFilename,
  type StatementLoan,
  type StatementRole,
} from '../lib/statements';
import { FileText, Download, Loader2 } from 'lucide-react';
import { useHydrated } from '../hooks/useHydrated';

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

type MyLoan = Omit<StatementLoan, 'events'> & { createdAt: number };

type PeriodKey = 'all' | '30d' | '90d' | 'fy' | 'custom';

const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'fy', label: 'This financial year' },
  { key: 'custom', label: 'Custom range' },
];

type Range = { from?: number; to?: number; label: string };

/**
 * Turn the selected period into unix-second bounds.
 *
 * The financial year is Apr 1 -> Mar 31 (Indian FY), since that's the filing
 * period these statements are modelled on.
 */
function resolveRange(period: PeriodKey, customFrom: string, customTo: string): Range {
  const now = new Date();
  const day = 24 * 60 * 60;
  const nowSec = Math.floor(now.getTime() / 1000);

  switch (period) {
    case '30d':
      return { from: nowSec - 30 * day, to: nowSec, label: 'Last 30 days' };
    case '90d':
      return { from: nowSec - 90 * day, to: nowSec, label: 'Last 90 days' };
    case 'fy': {
      const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      const start = Math.floor(Date.UTC(y, 3, 1) / 1000);
      return { from: start, to: nowSec, label: `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}` };
    }
    case 'custom': {
      const from = customFrom ? Math.floor(new Date(`${customFrom}T00:00:00Z`).getTime() / 1000) : undefined;
      const to = customTo ? Math.floor(new Date(`${customTo}T23:59:59Z`).getTime() / 1000) : undefined;
      if (from === undefined && to === undefined) return { label: 'All time' };
      return { from, to, label: `${customFrom || 'start'} to ${customTo || 'today'}` };
    }
    default:
      return { label: 'All time' };
  }
}

export function StatementsPanel({ email, ethPrice }: { email?: string; ethPrice: number }) {
  // Same rehydration caveat as the dashboards: don't tell an already-connected
  // user to connect while wagmi is still restoring the session.
  const { address, isConnecting, isReconnecting } = useAccount();
  const hydrated = useHydrated();
  const walletSettling = !hydrated || isConnecting || isReconnecting;
  const chainId = sepolia.id;
  const factoryAddress = process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA;
  const [role, setRole] = useState<StatementRole>('lender');
  const [busy, setBusy] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Resolved reporting window in unix seconds; undefined bound = open-ended.
  const range = useMemo(
    () => resolveRange(period, customFrom, customTo),
    [period, customFrom, customTo],
  );

  const { data: loanIds } = useReadContract({
    address: factoryAddress as `0x${string}` | undefined,
    abi: FACTORY_ABI,
    functionName: 'getLoanIds',
    chainId,
    query: { enabled: Boolean(factoryAddress) },
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
  const { data: termsResults } = useReadContracts({
    contracts: termsContracts,
    query: { enabled: termsContracts.length > 0 },
  });

  const allAddresses = useMemo(
    () =>
      (termsResults ?? [])
        .map((r) => (r.status === 'success' ? (r.result as LoanTermsTuple).loanContract : undefined))
        .filter((a): a is `0x${string}` => Boolean(a)),
    [termsResults],
  );

  // status + lender, to work out which loans belong to this user in each role
  const statusContracts = useMemo(
    () => allAddresses.map((a) => ({ address: a, abi: LOAN_ABI, functionName: 'status' as const, chainId })),
    [allAddresses, chainId],
  );
  // Narrowing (deliberate, same as LenderDashboard): contributions() takes one
  // address, so this queries only the active connected account, not every
  // account across every connected wallet.
  const lenderContracts = useMemo(
    () =>
      address
        ? allAddresses.map((a) => ({
            address: a,
            abi: LOAN_ABI,
            functionName: 'contributions' as const,
            args: [address] as const,
            chainId,
          }))
        : [],
    [allAddresses, chainId, address],
  );
  const { data: statusRes } = useReadContracts({
    contracts: statusContracts,
    query: { enabled: statusContracts.length > 0 },
  });
  const { data: lenderRes } = useReadContracts({
    contracts: lenderContracts,
    query: { enabled: lenderContracts.length > 0 },
  });

  const myLoans = useMemo(() => {
    if (!loanIds || !termsResults) return [] as MyLoan[];
    const me = address?.toLowerCase();
    if (!me) return [];
    const out: MyLoan[] = [];
    loanIds.forEach((id, i) => {
      const r = termsResults[i];
      if (r?.status !== 'success') return;
      const t = r.result as LoanTermsTuple;
      const idx = allAddresses.indexOf(t.loanContract);
      const statusVal = idx >= 0 && statusRes?.[idx]?.status === 'success' ? Number(statusRes[idx].result) : 0;
      const contribution =
        idx >= 0 && lenderRes?.[idx]?.status === 'success' ? (lenderRes[idx].result as bigint) : undefined;

      // Ownership depends on the selected role, so the same wallet produces two
      // different statements: as borrower it matches the terms' borrower field, as
      // lender the contract's lender. A user who has been both on different loans gets
      // each set separately rather than one merged ledger they cannot reconcile.
      const mine =
        role === 'borrower' ? t.borrower.toLowerCase() === me : (contribution ?? 0n) > 0n;
      if (!mine) return;

      out.push({
        loanId: id.toString(),
        loanContract: t.loanContract as string,
        principal: t.principalAmount,
        collateral: t.collateralAmount,
        interestBps: Number(t.interestBps),
        durationDays: Number(t.durationDays),
        statusVal,
        // Pooled loans have many lenders, not one counterparty; refined to an
        // actual lender count below once this loan's events are indexed.
        counterparty: role === 'borrower' ? 'pooled' : t.borrower,
        createdAt: Number(t.createdAt),
        // Contract-read contribution (C1): survives the reporting period
        // filter applied to `events` below, unlike summing contribution
        // events would.
        myContribution: contribution,
      });
    });
    return out;
  }, [loanIds, termsResults, allAddresses, statusRes, lenderRes, address, role]);

  const earliestCreatedAt = useMemo(() => {
    const times = myLoans.map((l) => l.createdAt);
    return times.length > 0 ? Math.min(...times) : undefined;
  }, [myLoans]);

  const { byLoan, priceFor, isLoading } = useLoanEvents({
    factoryAddress,
    loanContracts: myLoans.map((l) => l.loanContract as `0x${string}`),
    chainId,
    ethPrice,
    fromTimestamp: earliestCreatedAt,
    enabled: myLoans.length > 0,
  });

  // Apply the reporting period: keep only events inside it, then drop loans that
  // had no activity at all in the window — a statement for a period shouldn't
  // list loans that did nothing during it.
  const statementLoans: StatementLoan[] = useMemo(() => {
    const withEvents = myLoans.map((l) => {
      const events = (byLoan.get(l.loanContract.toLowerCase()) ?? []).filter((e) => {
        if (e.timestamp === undefined) return true; // don't silently drop unknowns
        if (range.from !== undefined && e.timestamp < range.from) return false;
        if (range.to !== undefined && e.timestamp > range.to) return false;
        return true;
      });
      // Replace the 'pooled' placeholder with an actual lender count, when
      // this loan's ShareDistributed events have been indexed.
      let counterparty = l.counterparty;
      if (role === 'borrower') {
        const n = distinctLenderActors(events).length;
        counterparty = n > 0 ? `${n} lender${n === 1 ? '' : 's'}` : l.counterparty;
      }
      return { ...l, events, counterparty };
    });
    if (range.from === undefined && range.to === undefined) return withEvents;
    return withEvents.filter((l) => l.events.length > 0);
  }, [myLoans, byLoan, range, role]);

  function download(kind: 'pnl' | 'tax' | 'tradebook') {
    setBusy(kind);
    try {
      const meta = {
        role,
        walletAddress: address,
        email,
        priceFor,
        currentEthUsd: ethPrice,
        periodLabel: range.label,
      };
      const doc =
        kind === 'pnl'
          ? generatePnl(statementLoans, meta)
          : kind === 'tax'
          ? generateTaxPnl(statementLoans, meta)
          : generateTradebook(statementLoans, meta);
      doc.save(statementFilename(kind, role));
    } catch (err) {
      console.error('[statements]', err);
    } finally {
      setBusy(null);
    }
  }

  const eventCount = statementLoans.reduce((n, l) => n + l.events.length, 0);

  return (
    <div className="rounded-2xl border border-slate-800 bg-[#111827] p-6">
      <div className="mb-5">
        <h2 className="text-sm font-black text-white uppercase tracking-widest">Statements</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Downloadable records of everything you&apos;ve lent, borrowed, repaid or had liquidated.
          Every row carries its transaction hash — MetaMask can&apos;t show these, because they move
          as internal contract transfers.
        </p>
      </div>

      {/* role switch — the same wallet can be both sides */}
      <div className="flex rounded-xl border border-slate-800 bg-slate-900/50 p-1 gap-1 mb-4 w-fit">
        {(['lender', 'borrower'] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRole(r)}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold capitalize transition-all ${
              role === r ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            As {r}
          </button>
        ))}
      </div>

      {/* reporting period */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          Period
        </label>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as PeriodKey)}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white focus:border-blue-500 focus:outline-none"
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>

        {period === 'custom' && (
          <>
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
            />
            <span className="text-xs text-slate-600">to</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
            />
          </>
        )}
      </div>

      <p className="text-[11px] text-slate-600 mb-4">
        {walletSettling ? (
          'Restoring your wallet connection…'
        ) : !address ? (
          'Connect a wallet to generate statements.'
        ) : isLoading ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Indexing on-chain history…
          </span>
        ) : (
          <>
            {statementLoans.length} loan{statementLoans.length === 1 ? '' : 's'} as {role} ·{' '}
            {eventCount} recorded transaction{eventCount === 1 ? '' : 's'} · {range.label}
          </>
        )}
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { kind: 'pnl' as const, title: 'Profit & Loss', desc: 'Realised result per loan, with totals.' },
          { kind: 'tax' as const, title: 'Tax P&L', desc: 'Acquisitions and disposals with the rate at each event.' },
          { kind: 'tradebook' as const, title: 'Tradebook', desc: 'Every action in order, with hashes.' },
        ].map(({ kind, title, desc }) => (
          <button
            key={kind}
            onClick={() => download(kind)}
            disabled={!address || busy !== null}
            className="text-left p-4 rounded-xl border border-slate-700 hover:border-blue-500/50 hover:bg-slate-800/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2 mb-1">
              <FileText className="h-3.5 w-3.5 text-blue-400" />
              <p className="text-sm font-black text-white">{title}</p>
              {busy === kind ? (
                <Loader2 className="h-3 w-3 animate-spin text-slate-500 ml-auto" />
              ) : (
                <Download className="h-3 w-3 text-slate-600 ml-auto" />
              )}
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">{desc}</p>
          </button>
        ))}
      </div>

      <p className="text-[10px] text-slate-700 mt-3">
        Sepolia test ETH has no market value — these demonstrate the reporting format. USD figures
        use the price captured at each event where one was recorded, and today&apos;s price otherwise
        (marked &quot;est.&quot;).
      </p>
    </div>
  );
}
