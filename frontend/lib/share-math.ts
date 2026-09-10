/**
 * Per-lender share math for pooled loans (T8).
 *
 * ShareDistributed(loanId, lender, amount, pending) is emitted once per lender
 * per distribution - for both repayments and liquidation seizures - and is the
 * per-share source of truth. Loan-level totals (principal, totalRepaid, seized)
 * are the whole pool's numbers and are wrong for a receipt or statement the
 * moment a loan has more than one lender.
 *
 * Loans created before pooling, or whose events have not been indexed yet,
 * carry no ShareDistributed events at all - callers gate on `hasShareData`
 * and fall back to the old loan-level computation unchanged in that case.
 */

import type { LoanEvent, LoanEventKind } from './loan-events.ts';

/**
 * Outbound (money leaving this viewer) event kinds, by role. Shared between
 * the settlement receipt's audit trail and the statement PDFs so both agree
 * on which direction a given event kind moves for a given role.
 *
 * Borrower: the only money a borrower ever receives is the loan principal
 * (`funded`). Everything else either leaves the borrower (`partial-repayment`,
 * `repaid`, `liquidated`) or belongs to a lender's own accounting inside the
 * pool (`contribution`, `share-distributed`, `withdrawal`, `reclaimed`) - none
 * of that is money the borrower received, so it must not read as inbound on
 * the borrower's receipt (I3).
 */
export const OUTBOUND_KINDS: Record<'lender' | 'borrower', LoanEventKind[]> = {
  lender: ['funded', 'contribution'],
  borrower: [
    'partial-repayment',
    'repaid',
    'liquidated',
    'contribution',
    'share-distributed',
    'withdrawal',
    'reclaimed',
  ],
};

/** Loan-wide events that move the whole pool's money, not just one lender's. */
const POOL_WIDE_KINDS: LoanEventKind[] = ['funded', 'partial-repayment', 'repaid', 'liquidated'];

function sameAddress(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Sum event amounts as bigint. Wei must never be summed as float. */
export function sumAmounts(events: LoanEvent[]): bigint {
  return events.reduce((sum, e) => sum + e.amount, BigInt(0));
}

/**
 * Whether this loan's events carry per-share data at all (the fallback gate).
 *
 * `ShareDistributed` is only emitted from `_distribute()` - repayment or
 * liquidation - so a pooled loan that is Funded and still running, or one
 * that was Cancelled, has `contribution` events but zero `share-distributed`
 * events. Gating on `share-distributed` alone (C2) made every lender's
 * statement fall back to loan-level totals for exactly those loans, handing
 * each lender the whole pool's principal as their own outflow. `contribution`
 * events exist the moment a lender funds, so counting them here closes that
 * gap; only a genuinely pre-pooling loan (or one the indexer hasn't reached
 * yet) has neither kind and still falls back correctly.
 */
export function hasShareData(events: LoanEvent[]): boolean {
  return events.some((e) => e.kind === 'share-distributed' || e.kind === 'contribution');
}

/** One viewer's ShareDistributed events - pending and delivered alike, since both are owed. */
export function myShareEvents(events: LoanEvent[], viewerAddress: string): LoanEvent[] {
  return events.filter((e) => e.kind === 'share-distributed' && sameAddress(e.actor, viewerAddress));
}

/**
 * Split a viewer's shares into the liquidation payout (same tx hash as the
 * loan's `liquidated` event) versus everything else (repayment shares).
 */
export function splitSharesByLiquidation(
  shares: LoanEvent[],
  liquidatedTxHash: string | undefined,
): { seizureShares: LoanEvent[]; repaymentShares: LoanEvent[] } {
  if (!liquidatedTxHash) return { seizureShares: [], repaymentShares: shares };
  return {
    seizureShares: shares.filter((e) => e.txHash === liquidatedTxHash),
    repaymentShares: shares.filter((e) => e.txHash !== liquidatedTxHash),
  };
}

/**
 * Sum of a viewer's pending shares still unclaimed - a push delivery failed,
 * so the amount sits in pendingWithdrawals until withdraw() is called.
 *
 * `withdraw()` drains the *entire* pendingWithdrawals balance in one call, so
 * treating "any withdrawal event exists" as "cleared" goes blind the moment a
 * SECOND push fails after the first withdrawal: that later pending amount was
 * never claimed, but the footnote this feeds never mentions it again (I1).
 * Instead, compare block numbers - a pending share only counts as unclaimed
 * if it landed strictly after the viewer's most recent withdrawal, since
 * everything up to and including that block was swept by it.
 *
 * Limitation: `LoanEvent` carries no `logIndex`, so a withdraw and a
 * ShareDistributed landing in the SAME block are indistinguishable in order.
 * This treats a same-block distribution as already covered by that block's
 * withdrawal (i.e. not pending) - the safer assumption, since it can only
 * under-report a brand-new pending amount for one block rather than nag the
 * user about money they already collected.
 */
export function unclaimedPendingShares(events: LoanEvent[], viewerAddress: string): bigint {
  const pending = myShareEvents(events, viewerAddress).filter((e) => e.pending);
  if (pending.length === 0) return BigInt(0);
  const withdrawals = events.filter((e) => e.kind === 'withdrawal' && sameAddress(e.actor, viewerAddress));
  if (withdrawals.length === 0) return sumAmounts(pending);
  const lastWithdrawBlock = withdrawals.reduce(
    (max, e) => (e.blockNumber > max ? e.blockNumber : max),
    withdrawals[0].blockNumber,
  );
  return sumAmounts(pending.filter((e) => e.blockNumber > lastWithdrawBlock));
}

/**
 * A lender's own ledger of events for one loan - their contribution, their
 * shares, their withdrawal and reclaim activity - with the pool-wide events
 * (funded, repayments, liquidation) dropped by default, since those carry the
 * whole pool's amount, not this lender's. Other lenders' individual rows are
 * always dropped.
 *
 * Pass `keepLifecycle: true` for the Tradebook (I4), which wants the loan's
 * lifecycle events kept as context - otherwise a payout shows up with no
 * originating "funded"/"repaid"/"liquidated" row above it, and the "Refunded
 * ETH" column can never be populated for a lender. The Tax P&L and the
 * settlement receipt keep the default (strict): a disposals ledger, or a
 * per-lender receipt, should contain only the viewer's own movements.
 *
 * Falls back to the full event list unchanged when there is no per-share
 * data to draw from (old-loan data or an index that hasn't caught up).
 */
export function viewerLedgerEvents(
  events: LoanEvent[],
  viewerAddress: string | undefined,
  opts?: { keepLifecycle?: boolean },
): LoanEvent[] {
  if (!viewerAddress || !hasShareData(events)) return events;
  const keepLifecycle = opts?.keepLifecycle ?? false;
  return events.filter((e) => {
    if (POOL_WIDE_KINDS.includes(e.kind)) return keepLifecycle;
    if (e.kind === 'cancelled') return true;
    return sameAddress(e.actor, viewerAddress);
  });
}

/**
 * Distinct lender addresses that have contributed to this loan.
 *
 * Derived from `Contribution` rather than `ShareDistributed`: `_distribute`
 * skips zero-share recipients, so a small contributor can go uncounted, and
 * no ShareDistributed events exist at all before the loan's first settlement.
 * Contribution events exist the moment a lender funds, so this count is
 * accurate and always available.
 */
export function distinctLenderActors(events: LoanEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    if (e.kind === 'contribution' && e.actor) set.add(e.actor.toLowerCase());
  }
  return [...set];
}
