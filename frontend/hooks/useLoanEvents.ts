'use client';

/**
 * Shared loan settlement history (T2), used by both dashboards.
 *
 * Indexes on-chain events, attaches block timestamps, and snapshots the ETH
 * price the first time each event is seen so statements can later value it at
 * the time it happened rather than at today's price.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchBlockTimestamps,
  fetchLoanEvents,
  findBlockByTimestamp,
  getLogsClient,
  groupEventsByLoan,
  type LoanEvent,
} from '../lib/loan-events';

type Options = {
  factoryAddress?: string;
  loanContracts: `0x${string}`[];
  chainId: number;
  /** Current ETH/USD, used to snapshot newly-seen events. */
  ethPrice?: number;
  /**
   * Unix seconds of the earliest loan being indexed (its on-chain `createdAt`).
   * Used to pick a start block by timestamp — far more reliable than probing for
   * a contract's deployment block, which misreports on non-archive nodes.
   */
  fromTimestamp?: number;
  enabled?: boolean;
};

export type EventPrice = { ethUsd: number; eventAt: string | null };

export function useLoanEvents({
  factoryAddress,
  loanContracts,
  chainId,
  ethPrice,
  fromTimestamp,
  enabled = true,
}: Options) {
  // Log queries need an RPC that serves wide block ranges; the app's default
  // transport caps eth_getLogs at 10 blocks.
  const publicClient = useMemo(() => getLogsClient(), []);
  const [events, setEvents] = useState<LoanEvent[]>([]);
  const [prices, setPrices] = useState<Record<string, EventPrice>>({});
  const [isLoading, setIsLoading] = useState(false);
  // A ref, not state: this only exists to stop the same event being POSTed twice
  // within a session, and writing to it must not trigger the effect that reads it.
  const snapshotted = useRef<Set<string>>(new Set());

  // Stable key so we refetch when the set of loans changes, not on every render.
  // loanContracts is rebuilt by the caller on every render, so depending on the array
  // itself would re-run the whole index on each one. Sorted and lowercased so the same
  // set of loans in a different order produces the same key.
  const addressKey = useMemo(
    () => [...loanContracts].map((a) => a.toLowerCase()).sort().join(','),
    [loanContracts],
  );

  useEffect(() => {
    if (!enabled || !publicClient || !addressKey) return;
    // Guards against a slow index resolving after the loan set changed and writing
    // stale events over newer ones. Cheaper and more direct than an AbortController
    // here, since the work is several sequential requests rather than one.
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        // Start a little before the earliest loan was created. Derived from
        // on-chain createdAt rather than a hardcoded block, so redeploys and
        // new loans both keep working.
        // The trailing hour is slack, not a guess at block time: findBlockByTimestamp
        // returns the first block at or after the target, and starting exactly at the
        // creation timestamp risks landing one block past the LoanCreated log. An hour
        // of extra range is a handful of empty chunks; missing that log loses the loan.
        const target = (fromTimestamp ?? Math.floor(Date.now() / 1000) - 30 * 24 * 3600) - 3600;
        const fromBlock = await findBlockByTimestamp(publicClient, target);
        const raw = await fetchLoanEvents(
          publicClient,
          addressKey.split(',') as `0x${string}`[],
          fromBlock,
        );
        const withTimes = await fetchBlockTimestamps(publicClient, raw);
        if (!cancelled) setEvents(withTimes);
      } catch (err) {
        console.error('[useLoanEvents]', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, publicClient, addressKey, fromTimestamp]);

  // Load any prices we already recorded, then snapshot the ones we haven't.
  useEffect(() => {
    if (events.length === 0) return;
    let cancelled = false;

    (async () => {
      // Capped at 100 because these go into a query string, and an unbounded list of
      // 66-character hashes would eventually exceed what the server accepts in a URL.
      const hashes = [...new Set(events.map((e) => e.txHash.toLowerCase()))].slice(0, 100);
      let known: Record<string, EventPrice> = {};
      try {
        const res = await fetch(`/api/loans/event-prices?txHashes=${hashes.join(',')}`);
        if (res.ok) known = (await res.json()).prices ?? {};
      } catch {
        /* statements fall back to current price */
      }
      if (cancelled) return;
      setPrices(known);

      // No price, no snapshot. Writing a zero would poison the record permanently:
      // the server keeps the first write for a given event and never overwrites it.
      if (!ethPrice || ethPrice <= 0) return;
      // Keyed by hash and kind, not hash alone, because one transaction can emit two
      // events worth valuing separately, a liquidation's seizure and its refund.
      const missing = events.filter((e) => {
        const key = `${e.txHash.toLowerCase()}:${e.kind}`;
        return !known[key] && !snapshotted.current.has(key);
      });
      if (missing.length === 0) return;

      // Marked before the request, not after. Two dashboards mount this hook over the
      // same loans, and awaiting the POST first would let the second pass through
      // while the first is still in flight.
      missing.forEach((e) => snapshotted.current.add(`${e.txHash.toLowerCase()}:${e.kind}`));
      try {
        await fetch('/api/loans/event-prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            snapshots: missing.map((e) => ({
              txHash: e.txHash,
              kind: e.kind,
              loanContract: e.loanContract,
              ethUsd: ethPrice,
              eventAt: e.timestamp,
            })),
          }),
        });
      } catch {
        /* best effort — never block the UI on bookkeeping */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [events, ethPrice]);

  const byLoan = useMemo(() => groupEventsByLoan(events), [events]);

  /**
   * Price to value an event at: its snapshot if we have one, else today's.
   *
   * The `estimated` flag is the point. Events that predate the snapshot table cannot
   * be valued correctly, and the honest options are to omit them or to label them.
   * Statements label them, so a reader can tell a recorded rate from a substituted one
   * rather than being handed a figure that silently uses the wrong price.
   */
  function priceFor(e: LoanEvent): { usd: number; estimated: boolean } {
    const snap = prices[`${e.txHash.toLowerCase()}:${e.kind}`];
    if (snap) return { usd: snap.ethUsd, estimated: false };
    return { usd: ethPrice ?? 0, estimated: true };
  }

  return { events, byLoan, prices, priceFor, isLoading };
}
