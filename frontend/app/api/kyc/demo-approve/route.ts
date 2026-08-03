import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import { createAdminClient } from '../../../../lib/supabase/admin';

/**
 * Dev-only endpoint — only active when ALLOW_DEMO_KYC env var is set.
 *
 * Exists because the real flow depends on a third party: without a Didit account, or
 * when its sandbox is down, there is no other way to reach the borrower experience that
 * sits behind KYC. Approves only the caller's own profile, never an arbitrary user, so
 * the worst case if the flag is left on is that users can self-approve rather than that
 * anyone can approve anyone.
 */
export async function POST() {
  try {
    // Presence check, not a value check: unsetting the variable is the off switch, so
    // there is no "false" string that accidentally leaves it enabled.
    if (!process.env.ALLOW_DEMO_KYC) {
      return NextResponse.json({ error: 'Not available' }, { status: 403 });
    }

    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }

    const admin = createAdminClient() ?? session.serverClient;

    await admin
      .from('profiles')
      .update({
        kyc_status: 'APPROVED',
        verified_at: new Date().toISOString(),
        rejection_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.profile.id);

    await admin.from('audit_logs').insert({
      user_id: session.profile.id,
      action: 'KYC_DEMO_APPROVED',
    });

    return NextResponse.json({ kycStatus: 'APPROVED' });
  } catch (err) {
    console.error('[POST /api/kyc/demo-approve]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
