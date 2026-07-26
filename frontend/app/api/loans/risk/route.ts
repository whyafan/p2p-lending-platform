/**
 * Loan risk assessments — persist the borrower's explanation, expose it to lenders.
 *
 * POST  /api/loans/risk        save the assessment for a freshly created loan
 * GET   /api/loans/risk?loanContracts=0x..,0x..   fetch assessments (batch)
 *
 * The score is computed client-side at request time; without this it is lost on
 * unmount, leaving lenders with a bare A/B/C badge and no reasoning.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/auth';
import { createAdminClient } from '../../../../lib/supabase/admin';
import { createClient } from '../../../../lib/supabase/server';

const TIERS = new Set(['A', 'B', 'C']);
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_BATCH = 50;

async function db() {
  return createAdminClient() ?? (await createClient());
}

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    loanContract,
    chainId,
    borrowerWallet,
    tier,
    overallScore,
    contributions,
    source,
    personaId,
  } = (body ?? {}) as Record<string, unknown>;

  if (typeof loanContract !== 'string' || !ADDRESS_RE.test(loanContract)) {
    return NextResponse.json({ error: 'Valid loanContract address required' }, { status: 400 });
  }
  if (typeof tier !== 'string' || !TIERS.has(tier)) {
    return NextResponse.json({ error: 'tier must be A, B or C' }, { status: 400 });
  }
  if (typeof overallScore !== 'number' || !Number.isFinite(overallScore)) {
    return NextResponse.json({ error: 'overallScore must be a number' }, { status: 400 });
  }
  if (!Array.isArray(contributions) || contributions.length === 0) {
    return NextResponse.json({ error: 'contributions must be a non-empty array' }, { status: 400 });
  }

  const client = await db();
  if (!client) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  }

  // Immutable by design: a borrower must not be able to rewrite the explanation
  // a lender already funded against, so an existing row wins.
  const { error } = await client.from('loan_risk_assessments').insert({
    loan_contract: loanContract.toLowerCase(),
    chain_id: typeof chainId === 'number' ? chainId : 11155111,
    borrower_wallet: typeof borrowerWallet === 'string' ? borrowerWallet.toLowerCase() : null,
    tier,
    overall_score: overallScore,
    contributions,
    source: typeof source === 'string' ? source : null,
    persona_id: typeof personaId === 'string' ? personaId : null,
    created_by: session.profile.id,
  });

  if (error) {
    // 23505 = unique violation: already saved (e.g. a retry). Not a failure.
    if (error.code === '23505') {
      return NextResponse.json({ ok: true, alreadyExists: true });
    }
    console.error('[loans/risk] insert failed:', error.message);
    return NextResponse.json({ error: 'Could not save assessment' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const param = new URL(req.url).searchParams.get('loanContracts');
  if (!param) {
    return NextResponse.json({ assessments: {} });
  }

  const addresses = param
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => ADDRESS_RE.test(a))
    .slice(0, MAX_BATCH);

  if (addresses.length === 0) {
    return NextResponse.json({ assessments: {} });
  }

  const client = await db();
  if (!client) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  }

  const { data, error } = await client
    .from('loan_risk_assessments')
    .select('loan_contract, tier, overall_score, contributions, source, persona_id, created_at')
    .in('loan_contract', addresses);

  if (error) {
    console.error('[loans/risk] select failed:', error.message);
    return NextResponse.json({ error: 'Could not load assessments' }, { status: 500 });
  }

  // Keyed by address so callers can look up per loan without scanning.
  const assessments: Record<string, unknown> = {};
  for (const row of data ?? []) {
    assessments[row.loan_contract] = {
      tier: row.tier,
      overallScore: Number(row.overall_score),
      contributions: row.contributions,
      source: row.source,
      personaId: row.persona_id,
      createdAt: row.created_at,
    };
  }

  return NextResponse.json({ assessments });
}
