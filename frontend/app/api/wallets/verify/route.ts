import { NextResponse } from 'next/server';
import { verifyMessage } from 'viem';
import { getSessionUser } from '../../../../lib/auth';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { screenWallet, isWalletRiskAcceptable } from '../../../../lib/wallet-screening';

/**
 * Verify a signed challenge, screen the wallet, and record it as verified.
 *
 * The checks run in a fixed order and each one is a gate: an active nonce must exist,
 * it must not have expired, the signed message must contain that exact nonce, and only
 * then is the signature itself checked. Verifying the signature first would prove the
 * user controls the key but not that they were answering this server's challenge,
 * which is the property that stops a signature being replayed from elsewhere.
 *
 * Screening runs after the signature rather than before, so a rejection is recorded
 * against an address the caller has proven they control.
 */
export async function POST(req: Request) {
  try {
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }

    const { walletAddress, chainId, message, signature, setPrimary } = await req.json();
    if (!walletAddress || !chainId || !message || !signature) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const admin = createAdminClient() ?? session.serverClient;

    const normalized = walletAddress.toLowerCase() as `0x${string}`;
    const chainIdNum = Number(chainId);

    const { data: walletRecord } = await admin
      .from('linked_wallets')
      .select('*')
      .eq('wallet_address', normalized)
      .eq('chain_id', chainIdNum)
      .single();

    if (!walletRecord?.nonce || !walletRecord.nonce_expires_at) {
      return NextResponse.json(
        { error: 'No active nonce — request a fresh one via /api/wallets/nonce' },
        { status: 400 }
      );
    }

    if (new Date() > new Date(walletRecord.nonce_expires_at)) {
      return NextResponse.json(
        { error: 'Nonce has expired — request a fresh one via /api/wallets/nonce' },
        { status: 400 }
      );
    }

    if (!message.includes(walletRecord.nonce)) {
      return NextResponse.json({ error: 'Nonce mismatch' }, { status: 400 });
    }

    // Recovers the signer and compares it to the claimed address. Checking against
    // `normalized` and not against whatever the signature recovers to is the point: a
    // valid signature from a different key must not link that key's owner's wallet.
    const valid = await verifyMessage({ address: normalized, message, signature });
    if (!valid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    const screening = screenWallet(normalized);
    await admin.from('wallet_screenings').upsert(
      {
        user_id: session.profile.id,
        wallet_address: normalized,
        risk_score: screening.riskScore,
        risk_level: screening.riskLevel,
        flags: screening.flags.join(','),
        screened_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,wallet_address' }
    );

    // Recorded before the acceptance test, so a refused wallet still leaves an audit
    // trail of why it was refused rather than vanishing on the early return below.
    if (!isWalletRiskAcceptable(screening)) {
      return NextResponse.json({ error: 'Wallet risk too high', screening }, { status: 403 });
    }

    // Demote every existing wallet first, then insert this one as primary. Two rows
    // flagged primary is the state that has no sensible interpretation, so the clear
    // has to happen even though it touches rows this request is not otherwise about.
    if (setPrimary) {
      await admin
        .from('linked_wallets')
        .update({ is_primary: false })
        .eq('user_id', session.profile.id);
    }

    const { data: wallet } = await admin
      .from('linked_wallets')
      .upsert(
        {
          user_id: session.profile.id,
          wallet_address: normalized,
          chain_id: chainIdNum,
          signature_verified: true,
          verified_at: new Date().toISOString(),
          is_primary: Boolean(setPrimary),
          // Nonce cleared on success, which is what makes it single-use: the same
          // signature replayed against this route now fails the "no active nonce" check
          // at the top rather than verifying a second time.
          nonce: null,
          nonce_expires_at: null,
        },
        { onConflict: 'wallet_address,chain_id' }
      )
      .select()
      .single();

    await admin.from('audit_logs').insert({
      user_id: session.profile.id,
      action: 'WALLET_VERIFIED',
      metadata: JSON.stringify({ walletAddress: normalized, chainId }),
    });

    return NextResponse.json({ wallet, screening });
  } catch (err) {
    console.error('[POST /api/wallets/verify]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
