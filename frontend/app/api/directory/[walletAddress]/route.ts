import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import {
  normalizeWalletAddressParam,
  shapeDirectoryProfile,
  type PublicProfileRow,
} from '../../../../lib/directory';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ walletAddress: string }> },
) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const { walletAddress } = await params;
  const normalized = normalizeWalletAddressParam(walletAddress);
  if (!normalized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Exact match against the lowercased column (linked_wallets.wallet_address
  // is stored lowercased on insert, see /api/wallets/verify), not ILIKE.
  //
  // Not .maybeSingle(): linked_wallets is UNIQUE(wallet_address, chain_id),
  // so the same address can legitimately have one verified primary row per
  // chain. That means public_profiles can return more than one row for a
  // single wallet address, and .maybeSingle() throws (500) instead of
  // picking one. Order deterministically and take the first row instead -
  // do not "simplify" this back to .maybeSingle().
  const { data, error } = await session.serverClient
    .from('public_profiles')
    .select('id, display_name, kyc_status, user_role, wallet_address')
    .eq('wallet_address', normalized)
    .order('id', { ascending: true })
    .limit(1);

  if (error) {
    console.error('[GET /api/directory/[walletAddress]]', error.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }

  const row = data?.[0];
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ profile: shapeDirectoryProfile(row as PublicProfileRow) });
}
