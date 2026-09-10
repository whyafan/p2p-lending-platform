import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import { getDiditSessionStatus, mapDiditStatus } from '../../../../lib/didit';
import { createAdminClient } from '../../../../lib/supabase/admin';

/**
 * Reconciles this app's stored KYC status with Didit's.
 *
 * Three sources can tell us a verdict, in descending order of immediacy: the redirect
 * the user just came back on, a direct poll of Didit's API, and the webhook (which
 * writes independently, in kyc/webhook). This route exists because the webhook is not
 * guaranteed to have arrived by the time the user lands back on the page, and a user
 * staring at "pending" after being told they were approved is the failure it prevents.
 *
 * Both write paths are skipped once the stored status is APPROVED or REJECTED. Those
 * are terminal, and re-deriving them from a stale redirect parameter could walk a
 * decided user backwards.
 */
export async function GET(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const profile = session.profile;
  const url = new URL(req.url);
  const sessionIdParam = url.searchParams.get('sessionId');
  const returnedStatus = url.searchParams.get('returnedStatus'); // from Didit's redirect URL

  console.log('[kyc/status] kyc_status:', profile.kyc_status, '| db session_id:', profile.didit_session_id ?? 'NULL', '| param session_id:', sessionIdParam ?? 'none', '| returnedStatus:', returnedStatus ?? 'none');

  // Stored id wins over the query parameter: the parameter is attacker-controlled, and
  // polling an arbitrary session id would report someone else's verdict as this user's.
  const sessionId = profile.didit_session_id ?? sessionIdParam;
  const admin = createAdminClient() ?? session.serverClient;

  // ── Path 1: Didit told us the status in the redirect URL ──────────────────
  // This is the most reliable signal — Didit appends ?status=Approved&verificationSessionId=xxx
  // to our callback URL. Map and persist immediately.
  if (returnedStatus && profile.kyc_status !== 'APPROVED' && profile.kyc_status !== 'REJECTED') {
    const mapped = mapDiditStatus(returnedStatus);
    console.log('[kyc/status] using returnedStatus:', returnedStatus, '→', mapped);

    const updateData: Record<string, unknown> = {
      kyc_status: mapped,
      updated_at: new Date().toISOString(),
    };
    if (sessionIdParam && !profile.didit_session_id) {
      updateData.didit_session_id = sessionIdParam;
    }
    if (mapped === 'APPROVED') {
      updateData.verified_at = new Date().toISOString();
      updateData.rejection_reason = null;
    }

    const { error: updateErr } = await admin
      .from('profiles')
      .update(updateData)
      .eq('id', profile.id);

    if (updateErr) {
      console.error('[kyc/status] Supabase update error:', updateErr.message);
    } else {
      console.log('[kyc/status] profile updated to', mapped);
      await admin.from('audit_logs').insert({
        user_id: profile.id,
        action: 'KYC_STATUS_FROM_REDIRECT',
        metadata: JSON.stringify({ mapped, returnedStatus, sessionId: sessionIdParam }),
      });
    }

    return NextResponse.json({
      kycStatus: mapped,
      verifiedAt: mapped === 'APPROVED' ? new Date().toISOString() : null,
      synced: true,
    });
  }

  // ── Path 2: Actively poll Didit's API ────────────────────────────────────
  // Falls back to this when there's no returnedStatus in the URL.
  // Store the session ID if we got one from the redirect params.
  if (sessionIdParam && !profile.didit_session_id) {
    await admin
      .from('profiles')
      .update({ didit_session_id: sessionIdParam, updated_at: new Date().toISOString() })
      .eq('id', profile.id);
    profile.didit_session_id = sessionIdParam;
  }

  if (
    sessionId &&
    profile.kyc_status !== 'APPROVED' &&
    profile.kyc_status !== 'REJECTED'
  ) {
    const { data, error } = await getDiditSessionStatus(sessionId);
    console.log('[kyc/status] Didit API error:', error ?? 'none');
    console.log('[kyc/status] Didit data:', JSON.stringify(data)?.slice(0, 500));

    if (data && !error) {
      const decision = data.decision as Record<string, unknown> | undefined;
      const statusRaw =
        (decision?.status as string | undefined) ??
        (data.status as string | undefined) ??
        (data.kyc_result as string | undefined) ??
        'pending';
      const mapped = mapDiditStatus(statusRaw);
      console.log('[kyc/status] statusRaw:', statusRaw, '→', mapped);

      // Only a decided verdict is written back. Persisting PENDING would overwrite
      // nothing useful and would clear rejection_reason on a profile that has one.
      if (mapped !== 'PENDING') {
        const { error: updateErr } = await admin
          .from('profiles')
          .update({
            kyc_status: mapped,
            didit_session_id: sessionId,
            verified_at: mapped === 'APPROVED' ? new Date().toISOString() : null,
            rejection_reason: (data.rejection_reason as string | null) ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', profile.id);

        if (updateErr) console.error('[kyc/status] Supabase update error:', updateErr.message);

        await admin.from('audit_logs').insert({
          user_id: profile.id,
          action: 'KYC_STATUS_SYNCED',
          metadata: JSON.stringify({ mapped, statusRaw, sessionId }),
        });

        return NextResponse.json({
          kycStatus: mapped,
          verifiedAt: mapped === 'APPROVED' ? new Date().toISOString() : null,
          rejectionReason: (data.rejection_reason as string | null) ?? null,
          synced: true,
        });
      }
    }
  }

  return NextResponse.json({
    kycStatus: profile.kyc_status,
    verifiedAt: profile.verified_at,
    rejectionReason: profile.rejection_reason,
    diditSessionId: profile.didit_session_id,
  });
}
