import crypto from 'crypto';

const DIDIT_API_BASE = process.env.DIDIT_API_BASE ?? 'https://verification.didit.me/v2';

// Didit v2 doesn't expose a reliable single GET-session endpoint on the free plan.
// Try the known candidates in order and return the first successful JSON response.
const SESSION_STATUS_PATHS = [
  (id: string) => `/session/${id}/decision/`,
  (id: string) => `/session/${id}/decision`,
  (id: string) => `/session/${id}/`,
  (id: string) => `/session/${id}`,
];

export async function getDiditSessionStatus(sessionId: string): Promise<{
  error: string | null;
  data: Record<string, unknown> | null;
}> {
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) return { error: 'Didit not configured', data: null };

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'Authorization': `Bearer ${apiKey}`,
  };

  for (const buildPath of SESSION_STATUS_PATHS) {
    const url = `${DIDIT_API_BASE}${buildPath(sessionId)}`;
    console.log('[didit] trying GET:', url);

    try {
      const response = await fetch(url, { headers });
      const text = await response.text();
      console.log('[didit] response', response.status, text.slice(0, 200));

      if (response.ok) {
        const data = JSON.parse(text) as Record<string, unknown>;
        return { error: null, data };
      }
      // 404 = path doesn't exist, try next; any other error = stop
      if (response.status !== 404) {
        return { error: `${response.status}: ${text}`, data: null };
      }
    } catch (e) {
      console.error('[didit] fetch error:', e);
    }
  }

  return { error: 'No valid Didit session endpoint found (all paths 404)', data: null };
}

export async function createDiditSession(params: {
  vendorData: string;
  callbackUrl: string;
}) {
  const apiKey = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey || !workflowId) {
    return { error: 'Didit is not configured', session: null as null };
  }

  const response = await fetch(`${DIDIT_API_BASE}/session/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      workflow_id: workflowId,
      vendor_data: params.vendorData,
      callback: params.callbackUrl,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[didit] createSession failed', response.status, text);
    return { error: text || 'Didit session failed', session: null as null };
  }

  const raw = (await response.json()) as Record<string, unknown>;
  console.log('[didit] createSession response keys:', Object.keys(raw));

  // Didit may return `session_id` or `id` — handle both
  const sessionId = (raw.session_id ?? raw.id) as string | undefined;
  const url = (raw.url ?? raw.verification_url) as string | undefined;

  if (!sessionId || !url) {
    console.error('[didit] createSession: unexpected response shape', raw);
    return { error: 'Unexpected response from Didit', session: null as null };
  }

  return { error: null, session: { session_id: sessionId, url } };
}

export function verifyDiditWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.DIDIT_WEBHOOK_SECRET;
  if (!secret || !signature) {
    console.warn('[didit webhook] Missing secret or signature header. secret set:', !!secret, 'signature:', signature);
    return false;
  }

  const normalized = signature.replace(/^sha256=/, '');

  // Try hex comparison (most common)
  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  console.log('[didit webhook] signature received:', normalized.slice(0, 16) + '…');
  console.log('[didit webhook] expected (hex)  :', expectedHex.slice(0, 16) + '…');

  try {
    if (
      normalized.length === expectedHex.length &&
      crypto.timingSafeEqual(Buffer.from(expectedHex), Buffer.from(normalized))
    ) {
      return true;
    }
  } catch {}

  // Try base64 comparison (some providers use this)
  const expectedB64 = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    if (
      normalized.length === expectedB64.length &&
      crypto.timingSafeEqual(Buffer.from(expectedB64), Buffer.from(normalized))
    ) {
      return true;
    }
  } catch {}

  console.warn('[didit webhook] Signature mismatch — check DIDIT_WEBHOOK_SECRET');
  return false;
}

export function mapDiditStatus(status: string): string {
  const normalized = status.toLowerCase().replace(/[_\s-]/g, '');
  if (['approved', 'verified', 'success', 'completed', 'clear', 'accept', 'accepted'].includes(normalized)) return 'APPROVED';
  if (['declined', 'rejected', 'failed', 'deny', 'denied', 'refuse', 'refused'].includes(normalized)) return 'REJECTED';
  if (['inreview', 'manualreview', 'review', 'consider', 'caution'].includes(normalized)) return 'MANUAL_REVIEW';
  if (['expired'].includes(normalized)) return 'EXPIRED';
  return 'PENDING';
}
