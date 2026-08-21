import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sumAmounts,
  hasShareData,
  myShareEvents,
  splitSharesByLiquidation,
  unclaimedPendingShares,
  distinctShareActors,
} from './share-math.ts';
import type { LoanEvent } from './loan-events.ts';

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
});

// ── distinctShareActors ────────────────────────────────────────────────────

describe('distinctShareActors', () => {
  it('counts distinct lenders, case-insensitively, ignoring non-share events', () => {
    const events = [
      ev({ kind: 'share-distributed', amount: 1n, actor: LENDER_A }),
      ev({ kind: 'share-distributed', amount: 1n, actor: LENDER_A.toLowerCase() }),
      ev({ kind: 'share-distributed', amount: 1n, actor: LENDER_B }),
      ev({ kind: 'contribution', amount: 1n, actor: '0xCCCC' }),
    ];
    assert.equal(distinctShareActors(events).length, 2);
  });

  it('returns an empty array when there are no share-distributed events', () => {
    assert.deepEqual(distinctShareActors([ev({ kind: 'funded', amount: 1n })]), []);
  });
});
