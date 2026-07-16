import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../lib/auth';
import { createAdminClient } from '../../../lib/supabase/admin';

/** Legacy profile endpoint — redirects clients to /api/wallets for account data. */
export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get('wallet');
  const session = await getSessionUser();

  if (session) {
    return NextResponse.json({
      profileName: session.profile.display_name,
      linkedWallets: [],
      user: session.profile,
      message: 'Use GET /api/wallets for linked wallets and KYC status.',
    });
  }

  if (wallet) {
    return NextResponse.json({
      profileName: null,
      linkedWallets: [wallet.toLowerCase()],
    });
  }

  return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
}

export async function POST() {
  return NextResponse.json(
    { error: 'Profile updates moved to /onboarding and Supabase auth.' },
    { status: 410 }
  );
}

const VALID_ROLES = ['borrower', 'lender', 'both'] as const;

export async function PATCH(req: Request) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { userRole } = body as { userRole?: string };

  if (!userRole || !VALID_ROLES.includes(userRole as typeof VALID_ROLES[number])) {
    return NextResponse.json({ error: 'Invalid role — must be borrower, lender, or both' }, { status: 400 });
  }

  const admin = createAdminClient() ?? session.serverClient;

  const { error } = await admin
    .from('profiles')
    .update({ user_role: userRole, updated_at: new Date().toISOString() })
    .eq('id', session.profile.id);

  if (error) {
    console.error('[PATCH /api/profile]', error.message);
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
  }

  return NextResponse.json({ success: true, userRole });
}
