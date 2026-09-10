import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, serializeMessage, type TermSheetMessage } from './termsheet-typed-data.ts';

const SAMPLE: TermSheetMessage = {
  borrower: '0x1234567890abcdef1234567890abcdef12345678',
  principalWei: 1000000000000000000n,
  collateralWei: 1500000000000000000n,
  tenorDays: 30n,
  interestBps: 850n,
  maxLtvBps: 6600n,
  liquidationBufferBps: 1000n,
  issuedAt: 1755772800n,
};

describe('serializeMessage / parseMessage', () => {
  it('round-trips a realistic message', () => {
    assert.deepEqual(parseMessage(serializeMessage(SAMPLE)), SAMPLE);
  });

  it('throws when a uint field is missing', () => {
    const bad = serializeMessage(SAMPLE) as Record<string, unknown>;
    delete bad.interestBps;
    assert.throws(() => parseMessage(bad));
  });

  it('throws when a uint field is not a decimal string', () => {
    const bad = { ...serializeMessage(SAMPLE), tenorDays: '30.5' };
    assert.throws(() => parseMessage(bad));
  });

  it('throws on a bad borrower address', () => {
    const bad = { ...serializeMessage(SAMPLE), borrower: 'not-an-address' };
    assert.throws(() => parseMessage(bad));
  });
});
