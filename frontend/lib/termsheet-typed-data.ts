/**
 * EIP-712 LoanTermSheet definition, shared by the borrower wizard (signing),
 * the pin route (server-side signature check), and the lender verifier.
 */

export const TERM_SHEET_TYPES = {
  LoanTermSheet: [
    { name: 'borrower', type: 'address' },
    { name: 'principalWei', type: 'uint256' },
    { name: 'collateralWei', type: 'uint256' },
    { name: 'tenorDays', type: 'uint256' },
    { name: 'interestBps', type: 'uint256' },
    { name: 'maxLtvBps', type: 'uint256' },
    { name: 'liquidationBufferBps', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const;

export function termSheetDomain(chainId: number) {
  return { name: 'NexusFi', version: '1', chainId } as const;
}

export type TermSheetMessage = {
  borrower: `0x${string}`;
  principalWei: bigint;
  collateralWei: bigint;
  tenorDays: bigint;
  interestBps: bigint;
  maxLtvBps: bigint;
  liquidationBufferBps: bigint;
  issuedAt: bigint;
};

const UINT_FIELDS = [
  'principalWei', 'collateralWei', 'tenorDays', 'interestBps',
  'maxLtvBps', 'liquidationBufferBps', 'issuedAt',
] as const;

/** JSON-safe form for pinning: bigints become decimal strings. */
export function serializeMessage(m: TermSheetMessage): Record<string, string> {
  return {
    borrower: m.borrower,
    ...Object.fromEntries(UINT_FIELDS.map((f) => [f, m[f].toString()])),
  };
}

/** Inverse of serializeMessage; throws on malformed input (callers surface that as a verification error). */
export function parseMessage(raw: Record<string, unknown>): TermSheetMessage {
  const borrower = raw.borrower;
  if (typeof borrower !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(borrower)) {
    throw new Error('bad borrower address');
  }
  const out: Record<string, unknown> = { borrower };
  for (const f of UINT_FIELDS) {
    if (typeof raw[f] !== 'string' || !/^\d+$/.test(raw[f] as string)) throw new Error(`bad field ${f}`);
    out[f] = BigInt(raw[f] as string);
  }
  return out as TermSheetMessage;
}

export const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
