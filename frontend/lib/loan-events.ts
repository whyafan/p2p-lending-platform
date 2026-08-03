/**
 * On-chain event history for loans (T2).
 *
 * Why this exists: every payment in this system — funding, repayment, seizure,
 * refund — moves as an *internal contract transfer*, and MetaMask does not list
 * those. Users watch balances change with no record of what happened. The app
 * has to be the source of truth, and the only place the transaction hashes
 * actually live is the event logs.
 *
 * Also replaces the old localStorage tx-hash matching in BorrowerLoansSection,
 * which guessed by timestamp proximity and only ever knew about loan creation.
 */

import type { PublicClient } from 'viem';
import { createPublicClient, decodeEventLog, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';

export type LoanEventKind =
  | 'funded'
  | 'partial-repayment'
  | 'repaid'
  | 'liquidated'
  | 'cancelled';

export type LoanEvent = {
  kind: LoanEventKind;
  loanContract: string;
  txHash: `0x${string}`;
  blockNumber: bigint;
  /** Seconds since epoch. Filled in by fetchBlockTimestamps. */
  timestamp?: number;
  /** Primary ETH amount this event moved, in wei. */
  amount: bigint;
  /** Liquidations only: what went back to the borrower. */
  refunded?: bigint;
  /** Who acted (lender for funded/liquidated, borrower for repayments). */
  actor?: string;
};

const LOAN_EVENT_ABI = [
  parseAbiItem('event LoanFunded(uint256 indexed loanId, address indexed lender, uint256 amount)'),
  parseAbiItem(
    'event PartialRepayment(uint256 indexed loanId, address indexed payer, uint256 amountApplied, uint256 totalRepaidSoFar, uint256 remainingOwed)',
  ),
  parseAbiItem('event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 repaymentAmount)'),
  parseAbiItem(
    'event LoanLiquidated(uint256 indexed loanId, address indexed lender, uint256 seizedAmount, uint256 refundedToBorrower)',
  ),
  parseAbiItem('event LoanCancelled(uint256 indexed loanId)'),
] as const;

// Public RPCs cap how many blocks a single eth_getLogs may span.
const LOG_CHUNK = 9_000n;

/**
 * Dedicated client for log queries.
 *
 * The app's normal transport is Alchemy, whose free tier caps eth_getLogs at a
 * **10 block range** — far too narrow for loan history spanning tens of
 * thousands of blocks, and the reason event lists came back empty. Log queries
 * go through /api/rpc/logs instead, which proxies to an endpoint that serves
 * wide ranges. Everything else still uses the default client.
 */
export function getLogsClient() {
  return createPublicClient({ chain: sepolia, transport: http('/api/rpc/logs') });
}

const timestampBlockCache = new Map<string, bigint>();

/**
 * Find the first block at or after `targetTimestamp`, by binary search on block
 * headers.
 *
 * Deliberately timestamp-based rather than probing eth_getCode for a contract's
 * deployment block: nodes without archive state answer "0x" for blocks they
 * cannot serve, which is indistinguishable from "not yet deployed" and silently
 * walks the search past the real start — the history then comes back partially
 * empty. Block headers are available on every node, so this is reliable
 * anywhere, and callers already know when their earliest loan was created.
 */
export async function findBlockByTimestamp(
  client: PublicClient,
  targetTimestamp: number,
): Promise<bigint> {
  const key = String(targetTimestamp);
  const cached = timestampBlockCache.get(key);
  if (cached !== undefined) return cached;

  const latest = await client.getBlock();
  if (Number(latest.timestamp) <= targetTimestamp) {
    return latest.number ?? BigInt(0);
  }

  let low = BigInt(0);
  let high = latest.number ?? BigInt(0);
  while (low < high) {
    const mid = (low + high) / BigInt(2);
    let ts: number;
    try {
      const block = await client.getBlock({ blockNumber: mid });
      ts = Number(block.timestamp);
    } catch {
      // Can't read this header — assume it's too early and search later.
      low = mid + BigInt(1);
      continue;
    }
    if (ts < targetTimestamp) low = mid + BigInt(1);
    else high = mid;
  }

  timestampBlockCache.set(key, low);
  return low;
}

/**
 * Fetch every lifecycle event for the given loan contracts.
 * Chunked so a wide range never trips an RPC's block-span limit.
 */
export async function fetchLoanEvents(
  client: PublicClient,
  loanContracts: `0x${string}`[],
  fromBlock: bigint,
): Promise<LoanEvent[]> {
  if (loanContracts.length === 0) return [];

  const latest = await client.getBlockNumber();
  const events: LoanEvent[] = [];

  for (let start = fromBlock; start <= latest; start += LOG_CHUNK + 1n) {
    const end = start + LOG_CHUNK > latest ? latest : start + LOG_CHUNK;
    let logs;
    try {
      logs = await client.getLogs({ address: loanContracts, fromBlock: start, toBlock: end });
    } catch (err) {
      console.error('[loan-events] getLogs failed', start, end, err);
      continue;
    }

    for (const log of logs) {
      let decoded;
      try {
        decoded = decodeEventLog({ abi: LOAN_EVENT_ABI, data: log.data, topics: log.topics });
      } catch {
        continue; // not one of ours
      }

      const base = {
        loanContract: (log.address as string).toLowerCase(),
        txHash: log.transactionHash as `0x${string}`,
        blockNumber: log.blockNumber as bigint,
      };
      const a = decoded.args as Record<string, unknown>;

      switch (decoded.eventName) {
        case 'LoanFunded':
          events.push({ ...base, kind: 'funded', amount: a.amount as bigint, actor: a.lender as string });
          break;
        case 'PartialRepayment':
          events.push({
            ...base,
            kind: 'partial-repayment',
            amount: a.amountApplied as bigint,
            actor: a.payer as string,
          });
          break;
        case 'LoanRepaid':
          events.push({
            ...base,
            kind: 'repaid',
            amount: a.repaymentAmount as bigint,
            actor: a.borrower as string,
          });
          break;
        case 'LoanLiquidated':
          events.push({
            ...base,
            kind: 'liquidated',
            amount: a.seizedAmount as bigint,
            refunded: a.refundedToBorrower as bigint,
            actor: a.lender as string,
          });
          break;
        case 'LoanCancelled':
          events.push({ ...base, kind: 'cancelled', amount: BigInt(0) });
          break;
      }
    }
  }

  events.sort((x, y) => (x.blockNumber === y.blockNumber ? 0 : x.blockNumber < y.blockNumber ? -1 : 1));
  return events;
}

/** Attach wall-clock timestamps, de-duplicating block lookups. */
export async function fetchBlockTimestamps(
  client: PublicClient,
  events: LoanEvent[],
): Promise<LoanEvent[]> {
  const unique = [...new Set(events.map((e) => e.blockNumber.toString()))];
  const times = new Map<string, number>();

  await Promise.all(
    unique.map(async (bn) => {
      try {
        const block = await client.getBlock({ blockNumber: BigInt(bn) });
        times.set(bn, Number(block.timestamp));
      } catch {
        /* leave undefined rather than guessing */
      }
    }),
  );

  return events.map((e) => ({ ...e, timestamp: times.get(e.blockNumber.toString()) }));
}

export function groupEventsByLoan(events: LoanEvent[]): Map<string, LoanEvent[]> {
  const map = new Map<string, LoanEvent[]>();
  for (const e of events) {
    const list = map.get(e.loanContract) ?? [];
    list.push(e);
    map.set(e.loanContract, list);
  }
  return map;
}

export const EVENT_LABEL: Record<LoanEventKind, string> = {
  funded: 'Loan funded',
  'partial-repayment': 'Partial repayment',
  repaid: 'Repaid in full',
  liquidated: 'Liquidated',
  cancelled: 'Cancelled',
};
