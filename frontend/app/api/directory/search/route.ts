import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import {
  normalizeSearchQuery,
  buildLikePattern,
  mergeSearchResults,
  type PublicProfileRow,
} from '../../../../lib/directory';

const MAX_RESULTS = 20;
const SELECT_COLUMNS = 'id, display_name, kyc_status, user_role, wallet_address';

export async function GET(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const q = normalizeSearchQuery(req.nextUrl.searchParams.get('q'));
  if (!q) return NextResponse.json({ results: [] });

  const pattern = buildLikePattern(q);

  // The public_profiles view (migration 005) grants SELECT to the
  // authenticated role directly, so the RLS-scoped session client is
  // enough here. No admin/service-role client needed, matching migration
  // 002's goal that teammates can run the app without one.
  //
  // .order() runs before .limit() takes effect on Postgres' side, so the
  // cap picks a deterministic 20 rows instead of an arbitrary 20 out of
  // however many match - without it, Postgres is free to return a
  // different arbitrary subset on each request, and the client-side sort
  // in mergeSearchResults only reorders whatever arbitrary subset arrived.
  const [byName, byWallet] = await Promise.all([
    session.serverClient
      .from('public_profiles')
      .select(SELECT_COLUMNS)
      .neq('id', session.profile.id)
      .ilike('display_name', pattern)
      .order('display_name')
      .limit(MAX_RESULTS),
    session.serverClient
      .from('public_profiles')
      .select(SELECT_COLUMNS)
      .neq('id', session.profile.id)
      .ilike('wallet_address', pattern)
      .order('display_name')
      .limit(MAX_RESULTS),
  ]);

  if (byName.error || byWallet.error) {
    console.error('[GET /api/directory/search]', byName.error?.message ?? byWallet.error?.message);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }

  const results = mergeSearchResults(
    (byName.data ?? []) as PublicProfileRow[],
    (byWallet.data ?? []) as PublicProfileRow[],
    MAX_RESULTS,
  );

  return NextResponse.json({ results });
}
