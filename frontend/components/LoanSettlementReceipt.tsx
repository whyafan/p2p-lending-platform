'use client';

/**
 * Settlement receipt for a closed loan (T1).
 *
 * MetaMask does not list internal contract transfers, so a user who funded,
 * repaid or was liquidated sees their balance move with no record of why. This
 * is the record: what went out, what came back, what it cost or earned, and a
 * verifiable link for every single leg.
 */

import { formatEther } from 'viem';
import { EVENT_LABEL, type LoanEvent } from '../lib/loan-events';
import { formatUsd } from '../lib/format';
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Receipt } from 'lucide-react';

type Props = {
  role: 'lender' | 'borrower';
  /** Loan-level facts from the factory/contract. */
  principal: bigint;
  collateral: bigint;
  /** Every indexed event for this loan, oldest first. */
  events: LoanEvent[];
  /** 2 = Repaid, 4 = Liquidated. */
  statusVal: number;
  /** Values an event in USD, using its price snapshot where available. */
  priceFor: (e: LoanEvent) => { usd: number; estimated: boolean };
  explorerBase?: string;
};

const eth = (w: bigint) => parseFloat(formatEther(w)).toFixed(6);

export function LoanSettlementReceipt({
  role,
  principal,
  collateral,
  events,
  statusVal,
  priceFor,
  explorerBase = 'https://sepolia.etherscan.io',
}: Props) {
  const liquidated = statusVal === 4;
  const zero = BigInt(0);

  const repayEvents = events.filter(
    (e) => e.kind === 'partial-repayment' || e.kind === 'repaid',
  );
  const liqEvent = events.find((e) => e.kind === 'liquidated');
  const fundEvent = events.find((e) => e.kind === 'funded');

  const totalRepaid = repayEvents.reduce((sum, e) => sum + e.amount, zero);
  const seized = liqEvent?.amount ?? zero;
  const refunded = liqEvent?.refunded ?? zero;

  // Lender: everything that came back vs. the principal they put in.
  const lenderReceived = totalRepaid + seized;
  const lenderPnl = lenderReceived - principal;

  // Borrower: they received the principal, paid back repayments, and either got
  // collateral released (repaid) or partially refunded (liquidated).
  const collateralBack = liquidated ? refunded : collateral;
  const borrowerCost = totalRepaid + (collateral - collateralBack);

  const usdOf = (wei: bigint, e?: LoanEvent) => {
    const p = e ? priceFor(e) : { usd: 0, estimated: true };
    if (!p.usd) return null;
    return parseFloat(formatEther(wei)) * p.usd;
  };
  const anyEstimated = events.some((e) => priceFor(e).estimated);

  const rows =
    role === 'lender'
      ? [
          { label: 'You lent', value: `${eth(principal)} ETH`, tone: 'out' as const },
          { label: 'Repayments received', value: `${eth(totalRepaid)} ETH`, tone: 'in' as const },
          ...(liquidated
            ? [{ label: 'Collateral seized', value: `${eth(seized)} ETH`, tone: 'in' as const }]
            : []),
          {
            label: lenderPnl >= zero ? 'Interest earned' : 'Shortfall',
            value: `${lenderPnl >= zero ? '+' : '−'}${eth(lenderPnl >= zero ? lenderPnl : -lenderPnl)} ETH`,
            tone: (lenderPnl >= zero ? 'in' : 'out') as 'in' | 'out',
            emphasis: true,
          },
        ]
      : [
          { label: 'You borrowed', value: `${eth(principal)} ETH`, tone: 'in' as const },
          { label: 'You repaid', value: `${eth(totalRepaid)} ETH`, tone: 'out' as const },
          {
            label: liquidated ? 'Collateral returned' : 'Collateral released',
            value: `${eth(collateralBack)} ETH`,
            tone: 'in' as const,
          },
          ...(liquidated
            ? [{ label: 'Collateral lost', value: `${eth(seized)} ETH`, tone: 'out' as const }]
            : []),
          {
            label: 'Total cost of this loan',
            value: `${eth(borrowerCost > principal ? borrowerCost - principal : zero)} ETH`,
            tone: 'out' as const,
            emphasis: true,
          },
        ];

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Receipt className="h-3.5 w-3.5 text-slate-500" />
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
          Settlement receipt
        </p>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
            liquidated
              ? 'border-red-500/40 bg-red-500/20 text-red-400'
              : 'border-emerald-500/40 bg-emerald-500/20 text-emerald-400'
          }`}
        >
          {liquidated ? 'Closed by liquidation' : 'Closed by repayment'}
        </span>
      </div>

      {/* money in / out */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {rows.map(({ label, value, tone, emphasis }) => (
          <div key={label}>
            <p className="text-[10px] text-slate-600">{label}</p>
            <p
              className={`text-sm font-mono font-bold ${
                emphasis
                  ? tone === 'in'
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                  : 'text-white'
              }`}
            >
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* per-leg audit trail — the part MetaMask can't give you */}
      <div className="border-t border-slate-800/60 pt-2 space-y-1">
        <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">
          Every transaction
        </p>
        {events.length === 0 ? (
          <p className="text-[10px] text-slate-700">
            No events indexed yet — they appear once the history loads.
          </p>
        ) : (
          events.map((e) => {
            const inbound =
              role === 'lender'
                ? e.kind !== 'funded'
                : e.kind === 'funded';
            const usd = usdOf(e.amount, e);
            return (
              <div
                key={`${e.txHash}-${e.kind}`}
                className="flex items-center gap-2 text-[11px]"
              >
                {inbound ? (
                  <ArrowDownLeft className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                ) : (
                  <ArrowUpRight className="h-3 w-3 text-amber-400 flex-shrink-0" />
                )}
                <span className="text-slate-400">{EVENT_LABEL[e.kind]}</span>
                <span className="font-mono text-slate-300">{eth(e.amount)} ETH</span>
                {usd !== null && <span className="text-slate-600">({formatUsd(usd)})</span>}
                {e.kind === 'liquidated' && e.refunded !== undefined && e.refunded > zero && (
                  <span className="text-slate-600">
                    · {eth(e.refunded)} ETH refunded to borrower
                  </span>
                )}
                {e.timestamp && (
                  <span className="text-slate-700">
                    {new Date(e.timestamp * 1000).toLocaleString()}
                  </span>
                )}
                <a
                  href={`${explorerBase}/tx/${e.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 font-mono text-blue-500/70 hover:text-blue-400"
                >
                  {e.txHash.slice(0, 10)}… <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
            );
          })
        )}
      </div>

      <p className="text-[10px] text-slate-700 leading-relaxed">
        These move as internal contract transfers, so they change your balance but never appear in
        MetaMask&apos;s activity list — this receipt and the links above are the record.
        {anyEstimated && ' USD figures for events recorded before price tracking existed use the current price.'}
      </p>
    </div>
  );
}
