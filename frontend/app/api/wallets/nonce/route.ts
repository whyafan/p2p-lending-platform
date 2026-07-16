import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getSessionUser } from '../../../../lib/auth';
import { createAdminClient } from '../../../../lib/supabase/admin';

const NONCE_TTL_MS = 10 * 60 * 1000;

export async function POST(req: Request) {
  try {
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }

    const { walletAddress, chainId } = await req.json();
    if (!walletAddress || !chainId) {
      return NextResponse.json({ error: 'walletAddress and chainId required' }, { status: 400 });
    }

    const admin = createAdminClient() ?? session.serverClient;

    const nonce = randomBytes(16).toString('hex');
    const normalized = walletAddress.toLowerCase();
    const nonceExpiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();

    const { error: dbError } = await admin.from('linked_wallets').upsert(
      {
        user_id: session.profile.id,
        wallet_address: normalized,
        chain_id: Number(chainId),
        nonce,
        nonce_expires_at: nonceExpiresAt,
        is_primary: false,
      },
      { onConflict: 'wallet_address,chain_id' }
    );

    if (dbError) {
      console.error('[POST /api/wallets/nonce] db error:', dbError.message);
      return NextResponse.json(
        { error: 'Database not ready — run the SQL migration in the Supabase dashboard.' },
        { status: 503 }
      );
    }

    const origin = new URL(req.url).origin;
    const message = [
      'NexusFi Protocol wants you to sign in with your Ethereum account.',
      normalized,
      '',
      'Sign in to link this wallet to your NexusFi account.',
      '',
      `URI: ${origin}`,
      'Version: 1',
      'Chain ID: ' + chainId,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join('\n');

    return NextResponse.json({ message, nonce });
  } catch (err) {
    console.error('[POST /api/wallets/nonce]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
