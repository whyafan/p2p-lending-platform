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
  const snapshotted = useRef<Set<string>>(new Set());

  // Stable key so we refetch when the set of loans changes, not on every render.
  const addressKey = useMemo(
    () => [...loanContracts].map((a) => a.toLowerCase()).sort().join(','),
    [loanContracts],
  );

  useEffect(() => {
    if (!enabled || !publicClient || !addressKey) return;
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        // Start a little before the earliest loan was created. Derived from
        // on-chain createdAt rather than a hardcoded block, so redeploys and
        // new loans both keep working.
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

      if (!ethPrice || ethPrice <= 0) return;
      const missing = events.filter((e) => {
        const key = `${e.txHash.toLowerCase()}:${e.kind}`;
        return !known[key] && !snapshotted.current.has(key);
      });
      if (missing.length === 0) return;

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

  /** Price to value an event at: its snapshot if we have one, else today's. */
  function priceFor(e: LoanEvent): { usd: number; estimated: boolean } {
    const snap = prices[`${e.txHash.toLowerCase()}:${e.kind}`];
    if (snap) return { usd: snap.ethUsd, estimated: false };
    return { usd: ethPrice ?? 0, estimated: true };
  }

  return { events, byLoan, prices, priceFor, isLoading };
}
