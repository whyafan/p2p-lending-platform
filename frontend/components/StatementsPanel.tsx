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
  const lenderContracts = useMemo(
    () => allAddresses.map((a) => ({ address: a, abi: LOAN_ABI, functionName: 'lender' as const, chainId })),
    [allAddresses, chainId],
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
    if (!loanIds || !termsResults) return [] as Omit<StatementLoan, 'events'>[];
    const me = address?.toLowerCase();
    if (!me) return [];
    const out: Omit<StatementLoan, 'events'>[] = [];
    loanIds.forEach((id, i) => {
      const r = termsResults[i];
      if (r?.status !== 'success') return;
      const t = r.result as LoanTermsTuple;
      const idx = allAddresses.indexOf(t.loanContract);
      const statusVal = idx >= 0 && statusRes?.[idx]?.status === 'success' ? Number(statusRes[idx].result) : 0;
      const lenderAddr =
        idx >= 0 && lenderRes?.[idx]?.status === 'success' ? (lenderRes[idx].result as string) : undefined;

      const mine =
        role === 'borrower' ? t.borrower.toLowerCase() === me : lenderAddr?.toLowerCase() === me;
      if (!mine) return;

      out.push({
        loanId: id.toString(),
        loanContract: t.loanContract as string,
        principal: t.principalAmount,
        collateral: t.collateralAmount,
        interestBps: Number(t.interestBps),
        durationDays: Number(t.durationDays),
        statusVal,
        counterparty: role === 'borrower' ? lenderAddr : t.borrower,
      });
    });
    return out;
  }, [loanIds, termsResults, allAddresses, statusRes, lenderRes, address, role]);

  const { byLoan, priceFor, isLoading } = useLoanEvents({
    factoryAddress,
    loanContracts: myLoans.map((l) => l.loanContract as `0x${string}`),
    chainId,
    ethPrice,
    enabled: myLoans.length > 0,
  });

  const statementLoans: StatementLoan[] = useMemo(
    () => myLoans.map((l) => ({ ...l, events: byLoan.get(l.loanContract.toLowerCase()) ?? [] })),
    [myLoans, byLoan],
  );

  function download(kind: 'pnl' | 'tax' | 'tradebook') {
    setBusy(kind);
    try {
      const meta = { role, walletAddress: address, email, priceFor, currentEthUsd: ethPrice };
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
            {myLoans.length} loan{myLoans.length === 1 ? '' : 's'} as {role} · {eventCount} recorded
            transaction{eventCount === 1 ? '' : 's'}
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
