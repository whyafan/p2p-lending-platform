import { NextResponse } from 'next/server';
import { mapDiditStatus, verifyDiditWebhookSignature } from '../../../../lib/didit';
import { createAdminClient } from '../../../../lib/supabase/admin';

/**
 * Didit's callback: the authoritative source of a user's KYC verdict.
 *
 * Read as text and only parsed after the signature check, because the HMAC covers the
 * exact bytes sent. Parsing first and re-serialising would produce a different string
 * and fail every legitimate signature.
 *
 * The route is public by necessity, which is why the signature is the only thing
 * standing between an anonymous POST and a user being marked APPROVED.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();

  // Log every incoming webhook so we can see it in the Next.js terminal
  // Three header names because the provider has used different ones across workflow
  // versions and the docs do not say which applies to a given account.
  const signature =
    req.headers.get('x-signature-v2') ??
    req.headers.get('x-signature') ??
    req.headers.get('x-hub-signature-256') ??
    null;

  console.log('[webhook] received — body length:', rawBody.length);
  console.log('[webhook] signature header:', signature?.slice(0, 32) ?? 'NONE');
  console.log('[webhook] body preview:', rawBody.slice(0, 300));

  // Verification is skipped entirely when no secret is configured, so a local setup can
  // replay a captured webhook without one. That makes the secret the whole control:
  // any deployment reachable from the internet must have DIDIT_WEBHOOK_SECRET set.
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

  // vendor_data is the profile id this app passed in when the session was created, and
  // it is how a verdict finds its user. Didit echoes it back untouched; nothing in the
  // payload otherwise identifies the account.
  const userId = payload.vendor_data;
  const sessionId = payload.session_id;
  // decision.status is the nested shape and status the flat one; both have been seen.
  // Defaulting to 'pending' means an unreadable payload leaves the user where they are
  // rather than resolving them one way or the other.
  const statusRaw = payload.decision?.status ?? payload.status ?? 'pending';
  const kycStatus = mapDiditStatus(statusRaw);

  console.log('[webhook] mapped kycStatus:', kycStatus);

  if (!userId) {
    console.error('[webhook] vendor_data missing from payload');
    return NextResponse.json({ error: 'vendor_data missing' }, { status: 400 });
  }

  // Service role with no fallback, unlike every other route here. There is no user
  // session on a webhook, so there is no user-scoped client to fall back to, and
  // without the service key this route cannot write at all.
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

  // Logged, not returned as an error. A non-2xx here would make Didit retry a webhook
  // that has already been accepted and verified, and the audit row below still records
  // that the verdict arrived even if the profile write did not land.
  if (error) console.error('[webhook] Supabase update error:', error.message);

  await admin.from('audit_logs').insert({
    user_id: userId,
    action: 'KYC_WEBHOOK',
    metadata: JSON.stringify({ kycStatus, sessionId, statusRaw }),
  });

  console.log('[webhook] done — user', userId, '->', kycStatus);
  return NextResponse.json({ ok: true });
}
