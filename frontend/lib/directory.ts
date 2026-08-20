import type { PublicProfile } from './supabase/types.ts';

export type { PublicProfile as PublicProfileRow } from './supabase/types.ts';

export type DirectoryProfile = {
  id: string;
  displayName: string | null;
  kycStatus: string;
  userRole: string | null;
  walletAddress: string;
};

const WALLET_ADDRESS_RE = /^0x[a-f0-9]{40}$/;

/** Returns the trimmed query, or null if it is under 2 characters (too short to search). */
export function normalizeSearchQuery(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length >= 2 ? trimmed : null;
}

/** Escapes ILIKE wildcard/escape characters and wraps the query for a substring match. */
export function buildLikePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/** Lowercases and validates a route-param wallet address. Returns null if malformed. */
export function normalizeWalletAddressParam(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  return WALLET_ADDRESS_RE.test(trimmed) ? trimmed : null;
}

export function shapeDirectoryProfile(row: PublicProfile): DirectoryProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    kycStatus: row.kyc_status,
    userRole: row.user_role,
    walletAddress: row.wallet_address,
  };
}

/**
 * Merges two row sets (a display-name match and a wallet-address match),
 * dedupes by id, sorts by display name, and caps the result at `limit`.
 */
export function mergeSearchResults(
  byName: PublicProfile[],
  byWallet: PublicProfile[],
  limit: number,
): DirectoryProfile[] {
  const byId = new Map<string, PublicProfile>();
  for (const row of [...byName, ...byWallet]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return Array.from(byId.values())
    .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''))
    .slice(0, limit)
    .map(shapeDirectoryProfile);
}
