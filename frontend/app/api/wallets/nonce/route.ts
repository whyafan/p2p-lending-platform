import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getSessionUser } from '../../../../lib/auth';
import { createAdminClient } from '../../../../lib/supabase/admin';

// Long enough for a user to find and approve the MetaMask prompt, short enough that a
// challenge captured from the network is not usable later. The nonce is also cleared
// on successful verification, so this bounds the abandoned case, not the normal one.
const NONCE_TTL_MS = 10 * 60 * 1000;

/**
 * Issue a one-time challenge for linking a wallet.
 *
 * The nonce is generated and stored server-side, then embedded in the message the user
 * signs. Verification later checks that the message contains the nonce this server
 * issued, which is what makes a signature captured from another site or another session
 * useless here.
 *
 * Requires a signed-in session: this binds a wallet to an account, so there has to be
 * an account to bind it to before any signing happens.
 */
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

    // crypto.randomBytes, not Math.random: this value is the entire replay protection,
    // so it has to be unpredictable, not merely unlikely to repeat.
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

    // Origin is read from the request rather than configured, so the message names the
    // deployment the user is actually on, preview URL included, and a signature for one
    // origin visibly does not belong to another.
    const origin = new URL(req.url).origin;
    // Shaped after EIP-4361, deliberately: the wallet renders this text verbatim, and a
    // user asked to approve an opaque hex blob has no way to know what they consented
    // to. The address, chain and origin are all stated in the thing being signed.
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
