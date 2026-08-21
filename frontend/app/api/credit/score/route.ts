/**
 * POST /api/credit/score
 *
 * Server-side proxy to the FastAPI credit scoring backend.
 * Keeps the Alchemy API key and backend URL server-side.
 *
 * Falls back gracefully when the backend is unavailable:
 * returns { fallback: true } so the client can use its own rule-based scorer.
 */

import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL =
  process.env.CREDIT_BACKEND_URL ?? 'http://localhost:8000';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${BACKEND_URL}/credit/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // 20-second timeout — chain fetching can be slow on first call
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      // Surface the backend error but don't expose stack traces
      return NextResponse.json(
        { error: `Backend error ${upstream.status}`, detail: text.slice(0, 300) },
        { status: upstream.status },
      );
    }

    const data = await upstream.json();
    return NextResponse.json(data);
  } catch {
    // Backend unreachable — signal the client to fall back
    return NextResponse.json(
      { fallback: true, reason: 'Credit scoring backend unavailable' },
      { status: 503 },
    );
  }
}

/**
 * GET = warm-up ping. Render's free tier sleeps after 15 min idle and takes
 * ~50s to wake; any request starts the wake, so the wizard fires this when
 * the user enters wallet mode. Short timeout on purpose - we only need to
 * knock, not wait for the door.
 */
export async function GET() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    return NextResponse.json({ ok: res.ok });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
