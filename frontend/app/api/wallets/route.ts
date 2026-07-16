import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../lib/auth';
import { createAdminClient } from '../../../lib/supabase/admin';

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSessionUser();
    if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

    const walletId = req.nextUrl.searchParams.get('id');
    if (!walletId) return NextResponse.json({ error: 'Missing wallet id' }, { status: 400 });

    const admin = createAdminClient() ?? session.serverClient;

    // Confirm the wallet belongs to this user before deleting
    const { data: wallet } = await admin
      .from('linked_wallets')
      .select('id, is_primary, user_id')
      .eq('id', walletId)
      .eq('user_id', session.profile.id)
      .single();

    if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });

    await admin.from('linked_wallets').delete().eq('id', walletId);

    // If the deleted wallet was primary, promote the earliest remaining wallet
    if (wallet.is_primary) {
      const { data: remaining } = await admin
        .from('linked_wallets')
        .select('id')
        .eq('user_id', session.profile.id)
        .order('created_at', { ascending: true })
        .limit(1);
      if (remaining && remaining.length > 0) {
        await admin.from('linked_wallets').update({ is_primary: true }).eq('id', remaining[0].id);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/wallets]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }

    const admin = createAdminClient() ?? session.serverClient;

    const [walletsRes, screeningsRes] = await Promise.all([
      admin
        .from('linked_wallets')
        .select('*')
        .eq('user_id', session.profile.id)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true }),
      admin
        .from('wallet_screenings')
        .select('*')
        .eq('user_id', session.profile.id)
        .order('screened_at', { ascending: false })
        .limit(20),
    ]);

    const wallets = (walletsRes.data ?? []).map((w) => ({
      id: w.id,
      userId: w.user_id,
      walletAddress: w.wallet_address,
      chainId: w.chain_id,
      isPrimary: w.is_primary,
      signatureVerified: w.signature_verified,
      verifiedAt: w.verified_at,
      createdAt: w.created_at,
    }));

    const screenings = (screeningsRes.data ?? []).map((s) => ({
      id: s.id,
      userId: s.user_id,
      walletAddress: s.wallet_address,
      riskScore: s.risk_score,
      riskLevel: s.risk_level,
      flags: s.flags,
      screenedAt: s.screened_at,
    }));

    return NextResponse.json({
      wallets,
      screenings,
      user: {
        id: session.profile.id,
        email: session.profile.email,
        kycStatus: session.profile.kyc_status,
        displayName: session.profile.display_name,
        userRole: session.profile.user_role ?? null,
      },
    });
  } catch (err) {
    console.error('[GET /api/wallets]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
