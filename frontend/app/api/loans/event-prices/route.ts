/**
 * ETH/USD price snapshots per settlement event.
 *
 * GET  ?txHashes=0x..,0x..   fetch known snapshots
 * POST { snapshots: [...] }  record prices for newly-observed events
 *
 * Tax reporting needs the price at the moment of each disposal; nothing on-chain
 * stores it. The client snapshots the market price the first time it sees an
 * event. Inserts are first-write-wins so a historical figure can never be
 * restated after a statement has been generated from it.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { createClient } from '../../../../lib/supabase/server';

const TX_RE = /^0x[a-fA-F0-9]{64}$/;
const MAX_BATCH = 100;

async function db() {
  return createAdminClient() ?? (await createClient());
}

export async function GET(req: Request) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const param = new URL(req.url).searchParams.get('txHashes');
  if (!param) return NextResponse.json({ prices: {} });

  const hashes = param
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => TX_RE.test(h))
    .slice(0, MAX_BATCH);
  if (hashes.length === 0) return NextResponse.json({ prices: {} });

  const client = await db();
  if (!client) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });

  const { data, error } = await client
    .from('event_price_snapshots')
    .select('tx_hash, log_kind, eth_usd, event_at')
    .in('tx_hash', hashes);

  if (error) {
    console.error('[event-prices] select failed:', error.message);
    return NextResponse.json({ prices: {} });
  }

  // Keyed "txHash:kind" — one transaction can carry more than one event.
  const prices: Record<string, { ethUsd: number; eventAt: string | null }> = {};
  for (const row of data ?? []) {
    prices[`${row.tx_hash}:${row.log_kind}`] = {
      ethUsd: Number(row.eth_usd),
      eventAt: row.event_at,
    };
  }
  return NextResponse.json({ prices });
}

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const raw = (body as { snapshots?: unknown }).snapshots;
  if (!Array.isArray(raw) || raw.length === 0) {
    return NextResponse.json({ error: 'snapshots array required' }, { status: 400 });
  }

  const rows = raw
    .slice(0, MAX_BATCH)
    .map((r) => r as Record<string, unknown>)
    .filter(
      (r) =>
        typeof r.txHash === 'string' &&
        TX_RE.test(r.txHash) &&
        typeof r.kind === 'string' &&
        typeof r.ethUsd === 'number' &&
        Number.isFinite(r.ethUsd) &&
        r.ethUsd > 0,
    )
    .map((r) => ({
      tx_hash: (r.txHash as string).toLowerCase(),
      log_kind: r.kind as string,
      loan_contract:
        typeof r.loanContract === 'string' ? (r.loanContract as string).toLowerCase() : null,
      eth_usd: r.ethUsd as number,
      event_at:
        typeof r.eventAt === 'number' ? new Date((r.eventAt as number) * 1000).toISOString() : null,
    }));

  if (rows.length === 0) return NextResponse.json({ ok: true, inserted: 0 });

  const client = await db();
  if (!client) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });

  // ignoreDuplicates keeps the first observation authoritative.
  const { error } = await client
    .from('event_price_snapshots')
    .upsert(rows, { onConflict: 'tx_hash,log_kind', ignoreDuplicates: true });

  if (error) {
    console.error('[event-prices] insert failed:', error.message);
    return NextResponse.json({ error: 'Could not save snapshots' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, inserted: rows.length });
}
