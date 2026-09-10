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
import {
  hasShareData,
  myShareEvents,
  OUTBOUND_KINDS,
  splitSharesByLiquidation,
  sumAmounts,
  unclaimedPendingShares,
  viewerLedgerEvents,
} from '../lib/share-math';
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
  /** The connected wallet, lowercased or not - used to pick this lender's own ShareDistributed events out of the pool. */
  viewerAddress?: string;
  /** This lender's own contribution, when known - falls back to `principal` (single-lender assumption). */
  myContribution?: bigint;
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
  viewerAddress,
  myContribution,
}: Props) {
  const liquidated = statusVal === 4;
  const zero = BigInt(0);

  const repayEvents = events.filter(
    (e) => e.kind === 'partial-repayment' || e.kind === 'repaid',
  );
  const liqEvent = events.find((e) => e.kind === 'liquidated');

  const totalRepaid = repayEvents.reduce((sum, e) => sum + e.amount, zero);
  const seized = liqEvent?.amount ?? zero;
  const refunded = liqEvent?.refunded ?? zero;

  // Per-share gate: only lenders on a pooled loan that has actually been
  // indexed with ShareDistributed events get their own numbers. Everything
  // else (borrowers, or a loan with zero share-distributed events - old-loan
  // data or an index that hasn't caught up yet) falls back to the loan-level
  // totals computed above, unchanged.
  const usePerShare = role === 'lender' && Boolean(viewerAddress) && hasShareData(events);

  let myLent: bigint;
  let myRepaidShare: bigint;
  let mySeized: bigint;
  let myReceived: bigint;
  let pendingUnclaimed: bigint;

  if (usePerShare) {
    const mine = myShareEvents(events, viewerAddress as string);
    const { seizureShares, repaymentShares } = splitSharesByLiquidation(mine, liqEvent?.txHash);
    // Prefer the contribution prop over the loan-wide principal even here:
    // during event-indexing lag a pooled lender otherwise sees the full
    // principal as "You lent" the moment usePerShare flips true.
    myLent = myContribution ?? principal;
    myRepaidShare = sumAmounts(repaymentShares);
    mySeized = sumAmounts(seizureShares);
    myReceived = myRepaidShare + mySeized; // includes pending shares - still owed either way
    pendingUnclaimed = unclaimedPendingShares(events, viewerAddress as string);
  } else {
    // No per-share data yet (indexing lag, or a pre-pooling loan). myContribution
    // is still the best-known figure for a pooled lender when it's present -
    // falling straight to the loan-wide principal here showed the full pool's
    // principal as "You lent" during that gap.
    myLent = myContribution ?? principal;
    myRepaidShare = totalRepaid;
    mySeized = seized;
    myReceived = totalRepaid + seized;
    pendingUnclaimed = zero;
  }
  const lenderPnl = myReceived - myLent;

  // Borrower: they received the principal, paid back repayments, and either got
  // collateral released (repaid) or partially refunded (liquidated).
  // A repaid loan returns the whole collateral, a liquidated one returns only the
  // surplus the contract refunded. Everything the borrower did not get back counts as
  // part of what the loan cost them, alongside the repayments themselves.
  const collateralBack = liquidated ? refunded : collateral;
  const borrowerCost = totalRepaid + (collateral - collateralBack);

  // Each leg is valued at the price when it happened, not at one price for the receipt.
  // A loan funded at $2,000 and repaid at $3,000 moved the same ETH but not the same
  // money, and a receipt that hid that would misstate what the position actually did.
  const usdOf = (wei: bigint, e?: LoanEvent) => {
    const p = e ? priceFor(e) : { usd: 0, estimated: true };
    // No price at all yields null, which renders as an omitted figure. Showing $0.00
    // would read as a real valuation of zero.
    if (!p.usd) return null;
    return parseFloat(formatEther(wei)) * p.usd;
  };
  const anyEstimated = events.some((e) => priceFor(e).estimated);

  // Audit trail. For a lender (I2): the summary rows above are already
  // per-lender once usePerShare is true, so the trail below must match -
  // otherwise it lists other lenders' contributions and payouts, unlabelled,
  // alongside this lender's own totals. Strict (no keepLifecycle), matching
  // the Tax P&L: this is a per-lender receipt, not a whole-loan history.
  //
  // For a borrower: the only money a borrower ever receives is the loan
  // principal, and the only money they ever send is a repayment - every
  // individual contribution/share-distributed/withdrawal/reclaimed row
  // belongs to some lender's own accounting inside the pool, not the
  // borrower's. Passing the unfiltered event list here (as before) rendered
  // every lender's contribution and every lender's payout with the same
  // outbound arrow used for the borrower's own repayment - a 2-lender repaid
  // loan's trail read as roughly double the amount the summary above it
  // correctly showed. viewerLedgerEvents with keepLifecycle:true keeps the
  // loan-level lifecycle events (funded/repaid/liquidated - the borrower's
  // own inflow/outflow) while dropping every other lender's individual rows,
  // since those never match the borrower's own address.
  const auditEvents =
    role === 'lender'
      ? viewerLedgerEvents(events, viewerAddress)
      : viewerLedgerEvents(events, viewerAddress, { keepLifecycle: true });

  const rows =
    role === 'lender'
      ? [
          { label: 'You lent', value: `${eth(myLent)} ETH`, tone: 'out' as const },
          { label: 'Repayments received', value: `${eth(myRepaidShare)} ETH`, tone: 'in' as const },
          ...(liquidated
            ? [{ label: 'Collateral seized', value: `${eth(mySeized)} ETH`, tone: 'in' as const }]
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

      {role === 'lender' && pendingUnclaimed > zero && (
        <p className="text-[10px] text-amber-400/80">
          Includes {eth(pendingUnclaimed)} ETH claimable via Claim - a push delivery failed, so
          it&apos;s owed to you but still sitting in the contract.
        </p>
      )}

      {/* per-leg audit trail — the part MetaMask can't give you */}
      <div className="border-t border-slate-800/60 pt-2 space-y-1">
        <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">
          Every transaction
        </p>
        {auditEvents.length === 0 ? (
          <p className="text-[10px] text-slate-700">
            No events indexed yet — they appear once the history loads.
          </p>
        ) : (
          auditEvents.map((e, idx) => {
            const inbound = !OUTBOUND_KINDS[role].includes(e.kind);
            const usd = usdOf(e.amount, e);
            return (
              <div
                // Index included: N share-distributed rows from one tx (one
                // per lender) otherwise collide on txHash+kind alone.
                key={`${e.txHash}-${e.kind}-${idx}`}
                className="flex items-center gap-2 text-[11px]"
              >
                {inbound ? (
                  <ArrowDownLeft className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                ) : (
                  <ArrowUpRight className="h-3 w-3 text-amber-400 flex-shrink-0" />
                )}
                <span className="text-slate-400">
                  {EVENT_LABEL[e.kind]}
                  {e.kind === 'share-distributed' && e.pending && ' (pending)'}
                </span>
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
