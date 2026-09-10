import { decodeEventLog, type Log } from 'viem';

export const LOAN_CREATED_EVENT_ABI = [
  {
    name: 'LoanCreated',
    type: 'event',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'loanContract', type: 'address', indexed: true },
      { name: 'principalAmount', type: 'uint256', indexed: false },
      { name: 'collateralAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export type DecodedLoanCreated = {
  loanId: bigint;
  loanContract: `0x${string}`;
};

/**
 * BUG-11 fix: the loan ID and contract address for a just-created loan must
 * come from this transaction's own receipt, never inferred from a global
 * counter like `loanCount - 1` (racy if another loan is created concurrently).
 * A tx receipt only ever contains logs emitted by that transaction, so
 * decoding LoanCreated straight out of it is race-free by construction.
 */
export function decodeLoanCreatedFromReceipt(logs: readonly Log[]): DecodedLoanCreated | null {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: LOAN_CREATED_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'LoanCreated') {
        const args = decoded.args as { loanId: bigint; loanContract: `0x${string}` };
        return { loanId: args.loanId, loanContract: args.loanContract };
      }
    } catch {
      // Not a LoanCreated log (the vault emits its own) — keep looking.
    }
  }
  return null;
}
