import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import { createDiditSession } from '../../../../lib/didit';
import { createAdminClient } from '../../../../lib/supabase/admin';

export async function POST(req: Request) {
  try {
    const session = await getSessionUser();
    if (!session) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const origin = new URL(req.url).origin;
    const callbackUrl =
      (body.callbackUrl as string | undefined) ?? `${origin}/onboarding?step=kyc&return=1`;

    const { error, session: diditSession } = await createDiditSession({
      vendorData: session.profile.id,
      callbackUrl,
    });

    if (error || !diditSession) {
      return NextResponse.json({ error: error ?? 'Could not start KYC', demo: true }, { status: 503 });
    }

    const admin = createAdminClient() ?? session.serverClient;

    await admin
      .from('profiles')
      .update({
        didit_session_id: diditSession.session_id,
        kyc_status: 'PENDING',
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.profile.id);

    await admin.from('audit_logs').insert({
      user_id: session.profile.id,
      action: 'KYC_SESSION_CREATED',
      metadata: JSON.stringify({ sessionId: diditSession.session_id }),
    });

    return NextResponse.json({ sessionId: diditSession.session_id, url: diditSession.url });
  } catch (err) {
    console.error('[POST /api/kyc/session]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
