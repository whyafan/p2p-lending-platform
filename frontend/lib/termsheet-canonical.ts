/**
 * Deterministic term-sheet serialization. The IPFS-anchored hash is only
 * meaningful if borrower (pin time) and lender (verify time) serialize the
 * same object to the same bytes, so: keys sorted recursively, no whitespace,
 * bigints as decimal strings. Both sides MUST hash through this module.
 */
import { keccak256, stringToBytes } from 'viem';

export function canonicalize(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function termSheetHash(payload: unknown): `0x${string}` {
  return keccak256(stringToBytes(canonicalize(payload)));
}
