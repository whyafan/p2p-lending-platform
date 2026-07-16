import { NextRequest, NextResponse } from 'next/server';

// Server-side RPC proxy — the browser calls this route instead of the RPC directly,
// so there are no CORS issues and the API key never reaches the browser.
const RPC_URL: Record<string, string | undefined> = {
  sepolia: process.env.NEXT_PUBLIC_RPC_URL_SEPOLIA,
  local: 'http://127.0.0.1:8545',
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ chain: string }> },
) {
  const { chain } = await params;
  const rpcUrl = RPC_URL[chain];

  if (!rpcUrl) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32000, message: `RPC for '${chain}' not configured` } },
      { status: 503 },
    );
  }

  try {
    const body = await req.text();
    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'RPC proxy error' } },
      { status: 502 },
    );
  }
}
