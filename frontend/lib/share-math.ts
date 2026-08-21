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
 */
export const OUTBOUND_KINDS: Record<'lender' | 'borrower', LoanEventKind[]> = {
  lender: ['funded', 'contribution'],
  borrower: ['partial-repayment', 'repaid', 'liquidated'],
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

/** Whether this loan's events carry per-share data at all (the fallback gate). */
export function hasShareData(events: LoanEvent[]): boolean {
  return events.some((e) => e.kind === 'share-distributed');
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
 * so the amount sits in pendingWithdrawals until withdraw() is called. Once
 * any Withdrawal event exists for this viewer on this loan, treat the pending
 * balance as cleared (the contract pays out the whole bucket in one call, so
 * there is no per-share withdrawal record to match against individually).
 */
export function unclaimedPendingShares(events: LoanEvent[], viewerAddress: string): bigint {
  const pending = myShareEvents(events, viewerAddress).filter((e) => e.pending);
  if (pending.length === 0) return BigInt(0);
  const hasWithdrawal = events.some((e) => e.kind === 'withdrawal' && sameAddress(e.actor, viewerAddress));
  return hasWithdrawal ? BigInt(0) : sumAmounts(pending);
}

/**
 * A lender's own ledger of events for one loan - their contribution, their
 * shares, their withdrawal and reclaim activity - with the pool-wide events
 * (funded, repayments, liquidation) dropped, since those carry the whole
 * pool's amount, not this lender's. Falls back to the full event list
 * unchanged when there is no per-share data to draw from (old-loan data or
 * an index that hasn't caught up), matching the receipt's fallback rule.
 */
export function viewerLedgerEvents(events: LoanEvent[], viewerAddress: string | undefined): LoanEvent[] {
  if (!viewerAddress || !hasShareData(events)) return events;
  return events.filter((e) => {
    if (POOL_WIDE_KINDS.includes(e.kind)) return false;
    if (e.kind === 'cancelled') return true;
    return sameAddress(e.actor, viewerAddress);
  });
}

/** Distinct lender addresses that have received a share distribution on this loan. */
export function distinctShareActors(events: LoanEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    if (e.kind === 'share-distributed' && e.actor) set.add(e.actor.toLowerCase());
  }
  return [...set];
}
