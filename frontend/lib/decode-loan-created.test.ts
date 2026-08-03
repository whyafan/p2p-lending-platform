import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import { decodeLoanCreatedFromReceipt, LOAN_CREATED_EVENT_ABI } from './decode-loan-created.ts';

const BORROWER = '0x1111111111111111111111111111111111111111' as const;
const LOAN_CONTRACT = '0x2222222222222222222222222222222222222222' as const;

// Some other event (e.g. the vault's own CollateralLocked) that shares no
// shape with LoanCreated — the decode loop must skip it, not throw.
const UNRELATED_ABI = [
  {
    name: 'CollateralLocked',
    type: 'event',
    inputs: [{ name: 'amount', type: 'uint256', indexed: false }],
  },
] as const;

function loanCreatedLog(loanId: bigint, loanContract: `0x${string}`): Log {
  return {
    address: loanContract,
    blockHash: '0x0' as `0x${string}`,
    blockNumber: 1n,
    data: encodeAbiParameters(
      [{ name: 'principalAmount', type: 'uint256' }, { name: 'collateralAmount', type: 'uint256' }],
      [1000n, 2000n],
    ),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: LOAN_CREATED_EVENT_ABI,
      eventName: 'LoanCreated',
      args: { loanId, borrower: BORROWER, loanContract },
    }),
    transactionHash: '0x0' as `0x${string}`,
    transactionIndex: 0,
  } as Log;
}

function unrelatedLog(): Log {
  return {
    address: LOAN_CONTRACT,
    blockHash: '0x0' as `0x${string}`,
    blockNumber: 1n,
    data: encodeAbiParameters([{ name: 'amount', type: 'uint256' }], [500n]),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({ abi: UNRELATED_ABI, eventName: 'CollateralLocked' }),
    transactionHash: '0x0' as `0x${string}`,
    transactionIndex: 0,
  } as Log;
}

describe('decodeLoanCreatedFromReceipt (BUG-11 regression guard)', () => {
  it('decodes loanId and loanContract straight from this tx\'s own LoanCreated log, never from a counter', () => {
    const result = decodeLoanCreatedFromReceipt([loanCreatedLog(7n, LOAN_CONTRACT)]);
    assert.deepEqual(result, { loanId: 7n, loanContract: LOAN_CONTRACT });
  });

  it('skips unrelated logs (e.g. the vault\'s own event) instead of throwing', () => {
    const result = decodeLoanCreatedFromReceipt([unrelatedLog(), loanCreatedLog(42n, LOAN_CONTRACT)]);
    assert.deepEqual(result, { loanId: 42n, loanContract: LOAN_CONTRACT });
  });

  it('returns null when no LoanCreated log is present', () => {
    assert.equal(decodeLoanCreatedFromReceipt([unrelatedLog()]), null);
  });
});
