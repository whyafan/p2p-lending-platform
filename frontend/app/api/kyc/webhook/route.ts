import { NextResponse } from 'next/server';
import { mapDiditStatus, verifyDiditWebhookSignature } from '../../../../lib/didit';
import { createAdminClient } from '../../../../lib/supabase/admin';

export async function POST(req: Request) {
  const rawBody = await req.text();

  // Log every incoming webhook so we can see it in the Next.js terminal
  const signature =
    req.headers.get('x-signature-v2') ??
    req.headers.get('x-signature') ??
    req.headers.get('x-hub-signature-256') ??
    null;

  console.log('[webhook] received — body length:', rawBody.length);
  console.log('[webhook] signature header:', signature?.slice(0, 32) ?? 'NONE');
  console.log('[webhook] body preview:', rawBody.slice(0, 300));

  if (process.env.DIDIT_WEBHOOK_SECRET) {
    const valid = verifyDiditWebhookSignature(rawBody, signature);
    console.log('[webhook] signature valid:', valid);
    if (!valid) {
      console.error('[webhook] REJECTED — signature mismatch. Body:', rawBody.slice(0, 200));
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let payload: {
    session_id?: string;
    vendor_data?: string;
    status?: string;
    decision?: { status?: string };
    rejection_reason?: string;
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error('[webhook] Failed to parse body as JSON');
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  console.log('[webhook] parsed — session_id:', payload.session_id, 'vendor_data:', payload.vendor_data, 'status:', payload.decision?.status ?? payload.status);

  const userId = payload.vendor_data;
  const sessionId = payload.session_id;
  const statusRaw = payload.decision?.status ?? payload.status ?? 'pending';
  const kycStatus = mapDiditStatus(statusRaw);

  console.log('[webhook] mapped kycStatus:', kycStatus);

  if (!userId) {
    console.error('[webhook] vendor_data missing from payload');
    return NextResponse.json({ error: 'vendor_data missing' }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });

  const { error } = await admin
    .from('profiles')
    .update({
      kyc_status: kycStatus,
      didit_session_id: sessionId ?? undefined,
      verified_at: kycStatus === 'APPROVED' ? new Date().toISOString() : null,
      rejection_reason: payload.rejection_reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) console.error('[webhook] Supabase update error:', error.message);

  await admin.from('audit_logs').insert({
    user_id: userId,
    action: 'KYC_WEBHOOK',
    metadata: JSON.stringify({ kycStatus, sessionId, statusRaw }),
  });

  console.log('[webhook] done — user', userId, '->', kycStatus);
  return NextResponse.json({ ok: true });
}
