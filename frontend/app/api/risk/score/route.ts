import { NextRequest, NextResponse } from 'next/server';
import { getPersonaById } from '../../../../lib/borrower-personas';
import { extractFeatures } from '../../../../lib/feature-extractor';
import { scoreFeatureVector } from '../../../../lib/risk-explainer';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.personaId) {
    return NextResponse.json({ error: 'personaId required' }, { status: 400 });
  }

  const persona = getPersonaById(body.personaId);
  if (!persona) {
    return NextResponse.json({ error: 'Unknown persona' }, { status: 404 });
  }

  const features = extractFeatures(body.personaId)!;
  const explanation = scoreFeatureVector(features);

  return NextResponse.json({ persona, features, explanation });
}
