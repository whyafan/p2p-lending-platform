/**
 * POST /api/termsheet/pin
 *
 * Pins a borrower's EIP-712-signed term sheet to IPFS via Pinata and returns
 * { cid, hash }. The keccak256 hash is computed over the canonical form of the
 * exact pinned payload, so any later gateway fetch can be re-hashed and compared.
 * Best-effort by design: callers must treat any failure as non-blocking.
 */
import { NextResponse } from 'next/server';
import { verifyTypedData } from 'viem';
import { getSessionUser } from '../../../../lib/auth';
import { termSheetHash } from '../../../../lib/termsheet-canonical';
import { TERM_SHEET_TYPES, termSheetDomain, parseMessage, serializeMessage, type TermSheetMessage } from '../../../../lib/termsheet-typed-data';

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json({ error: 'IPFS pinning not configured' }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { chainId, message, signature, signer } = body as {
    chainId?: unknown; message?: unknown; signature?: unknown; signer?: unknown;
  };
  if (typeof chainId !== 'number' || typeof signature !== 'string' || typeof signer !== 'string'
      || message === null || typeof message !== 'object') {
    return NextResponse.json({ error: 'chainId, message, signature, signer required' }, { status: 400 });
  }

  // The signature must actually be the signer's, over exactly this message.
  let parsedMessage: TermSheetMessage;
  try {
    parsedMessage = parseMessage(message as Record<string, unknown>);
  } catch {
    return NextResponse.json({ error: 'Malformed message' }, { status: 400 });
  }

  let valid = false;
  try {
    valid = await verifyTypedData({
      address: signer as `0x${string}`,
      domain: termSheetDomain(chainId),
      types: TERM_SHEET_TYPES,
      primaryType: 'LoanTermSheet',
      message: parsedMessage,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({ error: 'Signature does not verify' }, { status: 400 });
  }

  // Pin the exact payload we hash. Only the 8 typed fields - reserialized from the
  // verified parse, so no extra unsigned keys the client sent along ever get pinned.
  const payload = {
    standard: 'NexusFi-TermSheet-v1',
    chainId,
    domain: termSheetDomain(chainId),
    primaryType: 'LoanTermSheet',
    types: TERM_SHEET_TYPES,
    message: serializeMessage(parsedMessage),
    signature,
    signer: signer.toLowerCase(),
  };
  const hash = termSheetHash(payload);

  try {
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pinataContent: payload,
        pinataMetadata: { name: `nexusfi-termsheet-${signer.toLowerCase()}` },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[termsheet/pin] pinata error', res.status, text.slice(0, 200));
      return NextResponse.json({ error: `Pinata error ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { IpfsHash?: string };
    if (!data.IpfsHash) {
      return NextResponse.json({ error: 'Pinata returned no CID' }, { status: 502 });
    }
    return NextResponse.json({ cid: data.IpfsHash, hash });
  } catch (err) {
    console.error('[termsheet/pin] failed:', err);
    return NextResponse.json({ error: 'Pinning failed' }, { status: 502 });
  }
}
