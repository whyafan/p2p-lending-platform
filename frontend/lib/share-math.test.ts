import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sumAmounts,
  hasShareData,
  myShareEvents,
  splitSharesByLiquidation,
  unclaimedPendingShares,
  distinctLenderActors,
  viewerLedgerEvents,
  OUTBOUND_KINDS,
} from './share-math.ts';
import type { LoanEvent, LoanEventKind } from './loan-events.ts';

const LENDER_A = '0xAAAA000000000000000000000000000000AAAA';
const LENDER_B = '0xBBBB000000000000000000000000000000BBBB';

let seq = 0;
function ev(partial: Partial<LoanEvent> & Pick<LoanEvent, 'kind' | 'amount'>): LoanEvent {
  seq += 1;
  return {
    loanContract: '0xloan',
    txHash: (partial.txHash ?? `0xtx${seq}`) as `0x${string}`,
    blockNumber: BigInt(seq),
    ...partial,
  };
}

// ── sumAmounts ─────────────────────────────────────────────────────────────

describe('sumAmounts', () => {
  it('sums bigint amounts exactly, no float involved', () => {
    const events = [
      ev({ kind: 'share-distributed', amount: 333333333333333333n }),
      ev({ kind: 'share-distributed', amount: 333333333333333333n }),
      ev({ kind: 'share-distributed', amount: 333333333333333334n }),
    ];
    // 3 * 333333333333333333 + 1 would lose precision as float; bigint must be exact.
    assert.equal(sumAmounts(events), 1000000000000000000n);
  });

  it('returns 0n for an empty list', () => {
    assert.equal(sumAmounts([]), 0n);
  });
});

// ── hasShareData ───────────────────────────────────────────────────────────

describe('hasShareData', () => {
  it('false when no share-distributed events exist (pre-pooling loan)', () => {
    const events = [ev({ kind: 'repaid', amount: 100n }), ev({ kind: 'funded', amount: 100n })];
    assert.equal(hasShareData(events), false);
  });

  it('true when at least one share-distributed event exists', () => {
    const events = [ev({ kind: 'repaid', amount: 100n }), ev({ kind: 'share-distributed', amount: 10n, actor: LENDER_A })];
    assert.equal(hasShareData(events), true);
  });

  it('true when only contribution events exist - a funded, still-running (or cancelled) pooled loan has no ShareDistributed yet (C2)', () => {
    const events = [ev({ kind: 'contribution', amount: 100n, actor: LENDER_A })];
    assert.equal(hasShareData(events), true);
  });
});

// ── myShareEvents ──────────────────────────────────────────────────────────

describe('myShareEvents', () => {
  it('filters to this viewer only, case-insensitively', () => {
    const events = [
      ev({ kind: 'share-distributed', amount: 10n, actor: LENDER_A.toLowerCase() }),
      ev({ kind: 'share-distributed', amount: 20n, actor: LENDER_B }),
    ];
    const mine = myShareEvents(events, LENDER_A);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].amount, 10n);
  });

  it('ignores non share-distributed kinds even for the same actor', () => {
    const events = [ev({ kind: 'contribution', amount: 10n, actor: LENDER_A })];
    assert.equal(myShareEvents(events, LENDER_A).length, 0);
  });
});

// ── splitSharesByLiquidation ───────────────────────────────────────────────

describe('splitSharesByLiquidation', () => {
  it('routes shares sharing the liquidation tx hash to seizure, rest to repayment', () => {
    const shares = [
      ev({ kind: 'share-distributed', amount: 5n, txHash: '0xrepay1' as `0x${string}` }),
      ev({ kind: 'share-distributed', amount: 7n, txHash: '0xliq' as `0x${string}` }),
    ];
    const { seizureShares, repaymentShares } = splitSharesByLiquidation(shares, '0xliq');
    assert.equal(seizureShares.length, 1);
    assert.equal(seizureShares[0].amount, 7n);
    assert.equal(repaymentShares.length, 1);
    assert.equal(repaymentShares[0].amount, 5n);
  });

  it('treats everything as repayment shares when there is no liquidation tx', () => {
    const shares = [ev({ kind: 'share-distributed', amount: 5n })];
    const { seizureShares, repaymentShares } = splitSharesByLiquidation(shares, undefined);
    assert.equal(seizureShares.length, 0);
    assert.equal(repaymentShares.length, 1);
  });
});

// ── unclaimedPendingShares ─────────────────────────────────────────────────

describe('unclaimedPendingShares', () => {
  it('sums pending shares for the viewer when no withdrawal event exists yet', () => {
    const events = [
      ev({ kind: 'share-distributed', amount: 15n, actor: LENDER_A, pending: true }),
      ev({ kind: 'share-distributed', amount: 5n, actor: LENDER_A, pending: false }),
    ];
    assert.equal(unclaimedPendingShares(events, LENDER_A), 15n);
  });

  it('returns 0n once a withdrawal event exists for the viewer', () => {
    const events = [
      ev({ kind: 'share-distributed', amount: 15n, actor: LENDER_A, pending: true }),
      ev({ kind: 'withdrawal', amount: 15n, actor: LENDER_A }),
    ];
    assert.equal(unclaimedPendingShares(events, LENDER_A), 0n);
  });

  it('returns 0n when the viewer has no pending shares at all', () => {
    const events = [ev({ kind: 'share-distributed', amount: 15n, actor: LENDER_A, pending: false })];
    assert.equal(unclaimedPendingShares(events, LENDER_A), 0n);
  });

  it('I1: sums a new pending share that landed after the most recent withdrawal, instead of going blind forever', () => {
    // A first push fails (10 pending), the lender withdraws it, then a LATER
    // repayment's push also fails (5 pending). The reviewer confirmed today's
    // code returns 0n here - it must return 5n once the block-number fix
    // lands. This assertion is expected to FAIL against the pre-fix
    // "any withdrawal exists -> 0" implementation and PASS after.
    const events = [
      ev({ kind: 'share-distributed', amount: 10n, actor: LENDER_A, pending: true }), // block 1
      ev({ kind: 'withdrawal', amount: 10n, actor: LENDER_A }), // block 2 - claims the first 10
      ev({ kind: 'share-distributed', amount: 5n, actor: LENDER_A, pending: true }), // block 3 - new pending
    ];
    assert.equal(unclaimedPendingShares(events, LENDER_A), 5n);
  });

  it('still returns 0n for a pending share that landed before the withdrawal', () => {
    const events = [
      ev({ kind: 'share-distributed', amount: 10n, actor: LENDER_A, pending: true }), // block 1
      ev({ kind: 'withdrawal', amount: 10n, actor: LENDER_A }), // block 2
    ];
    assert.equal(unclaimedPendingShares(events, LENDER_A), 0n);
  });
});

// ── distinctLenderActors ───────────────────────────────────────────────────

describe('distinctLenderActors', () => {
  it('counts distinct contributors, case-insensitively, ignoring non-contribution events', () => {
    const events = [
      ev({ kind: 'contribution', amount: 40n, actor: LENDER_A }),
      ev({ kind: 'contribution', amount: 40n, actor: LENDER_A.toLowerCase() }),
      ev({ kind: 'contribution', amount: 60n, actor: LENDER_B }),
      ev({ kind: 'share-distributed', amount: 1n, actor: '0xCCCC' }),
    ];
    assert.equal(distinctLenderActors(events).length, 2);
  });

  it('returns an empty array when there are no contribution events', () => {
    assert.deepEqual(distinctLenderActors([ev({ kind: 'funded', amount: 1n })]), []);
  });

  it('still counts a small contributor _distribute skipped for a zero share', () => {
    const events = [
      ev({ kind: 'contribution', amount: 1n, actor: LENDER_A }),
      ev({ kind: 'contribution', amount: 99n, actor: LENDER_B }),
      // Only LENDER_B received a distribution - _distribute skips zero shares.
      ev({ kind: 'share-distributed', amount: 100n, actor: LENDER_B }),
    ];
    assert.equal(distinctLenderActors(events).length, 2);
  });

  it('is available before first settlement (no share-distributed events at all)', () => {
    const events = [ev({ kind: 'contribution', amount: 1n, actor: LENDER_A })];
    assert.equal(distinctLenderActors(events).length, 1);
  });
});

// ── viewerLedgerEvents ─────────────────────────────────────────────────────

describe('viewerLedgerEvents', () => {
  it('returns the full list unchanged when there is no per-share data', () => {
    const events = [ev({ kind: 'funded', amount: 100n }), ev({ kind: 'repaid', amount: 100n })];
    const result = viewerLedgerEvents(events, LENDER_A);
    assert.deepEqual(result.map((e) => e.kind), ['funded', 'repaid']);
  });

  it('returns the full list unchanged when no viewer address is given', () => {
    const events = [
      ev({ kind: 'contribution', amount: 40n, actor: LENDER_A }),
      ev({ kind: 'share-distributed', amount: 40n, actor: LENDER_A }),
    ];
    assert.deepEqual(viewerLedgerEvents(events, undefined).map((e) => e.kind), [
      'contribution',
      'share-distributed',
    ]);
  });

  it('strict (default): keeps only the viewer\'s own rows, dropping pool-wide rows and other lenders\' slices (I2)', () => {
    const events = [
      ev({ kind: 'contribution', amount: 40n, actor: LENDER_A }),
      ev({ kind: 'contribution', amount: 60n, actor: LENDER_B }),
      ev({ kind: 'funded', amount: 100n }),
      ev({ kind: 'repaid', amount: 100n }),
      ev({ kind: 'share-distributed', amount: 44n, actor: LENDER_A }),
      ev({ kind: 'share-distributed', amount: 66n, actor: LENDER_B }),
    ];
    const result = viewerLedgerEvents(events, LENDER_A);
    assert.deepEqual(result.map((e) => e.kind), ['contribution', 'share-distributed']);
    assert.equal(result.every((e) => e.actor?.toLowerCase() === LENDER_A.toLowerCase()), true);
  });

  it('keepLifecycle (I4): keeps loan-level lifecycle rows for the Tradebook while still excluding other lenders\' individual slices', () => {
    const events = [
      ev({ kind: 'contribution', amount: 40n, actor: LENDER_A }),
      ev({ kind: 'contribution', amount: 60n, actor: LENDER_B }),
      ev({ kind: 'funded', amount: 100n }),
      ev({ kind: 'repaid', amount: 100n }),
      ev({ kind: 'share-distributed', amount: 44n, actor: LENDER_A }),
      ev({ kind: 'share-distributed', amount: 66n, actor: LENDER_B }),
      ev({ kind: 'liquidated', amount: 100n, refunded: 0n, actor: LENDER_A }),
    ];
    const result = viewerLedgerEvents(events, LENDER_A, { keepLifecycle: true });
    assert.deepEqual(result.map((e) => e.kind), [
      'contribution',
      'funded',
      'repaid',
      'share-distributed',
      'liquidated',
    ]);
    assert.equal(
      result.some((e) => e.actor?.toLowerCase() === LENDER_B.toLowerCase()),
      false,
      'other lender\'s individual contribution/share row must still be dropped',
    );
  });

  it('always keeps a cancelled event regardless of keepLifecycle', () => {
    const events = [ev({ kind: 'contribution', amount: 40n, actor: LENDER_A }), ev({ kind: 'cancelled', amount: 0n })];
    assert.deepEqual(viewerLedgerEvents(events, LENDER_A).map((e) => e.kind), ['contribution', 'cancelled']);
  });
});

// ── OUTBOUND_KINDS ─────────────────────────────────────────────────────────

describe('OUTBOUND_KINDS', () => {
  it('classifies a lender\'s contribution as outbound (money leaving the lender)', () => {
    assert.equal(OUTBOUND_KINDS.lender.includes('contribution'), true);
  });

  it('classifies a borrower\'s events correctly per I3: only "funded" is inbound, every pooling kind is outbound', () => {
    const allKinds: LoanEventKind[] = [
      'funded',
      'contribution',
      'share-distributed',
      'withdrawal',
      'reclaimed',
      'partial-repayment',
      'repaid',
      'liquidated',
    ];
    const inboundToBorrower = (kind: LoanEventKind) => !OUTBOUND_KINDS.borrower.includes(kind);
    assert.equal(inboundToBorrower('funded'), true);
    for (const kind of allKinds.filter((k) => k !== 'funded')) {
      assert.equal(inboundToBorrower(kind), false, `${kind} must not read as inbound (received) to a borrower`);
    }
  });
});
