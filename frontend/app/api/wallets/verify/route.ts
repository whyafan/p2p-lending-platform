import { NextResponse } from 'next/server';
import { verifyMessage } from 'viem';
import { getSessionUser } from '../../../../lib/auth';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { screenWallet, isWalletRiskAcceptable } from '../../../../lib/wallet-screening';

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

    if (!isWalletRiskAcceptable(screening)) {
      return NextResponse.json({ error: 'Wallet risk too high', screening }, { status: 403 });
    }

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
