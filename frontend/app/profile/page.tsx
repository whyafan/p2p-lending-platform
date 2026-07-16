'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { ArrowLeft, LogOut, Save, UserRound } from 'lucide-react';
import { useAccount, useDisconnect } from 'wagmi';

function shortAddress(address?: string) {
  if (!address) return 'Not connected';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function ProfilePage() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [displayName, setDisplayName] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState('');

  async function saveProfile(event: FormEvent) {
    event.preventDefault();

    if (!isConnected || !address) {
      setStatus('Connect a wallet before saving a profile.');
      return;
    }

    setStatus('Saving profile...');

    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: address,
          name: displayName,
          bio: notes,
        }),
      });

      setStatus(response.ok ? 'Profile saved.' : 'Profile save failed.');
    } catch {
      setStatus('Database request failed.');
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7fb] p-5 text-slate-950 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-sm font-black text-slate-600 hover:text-slate-950">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to dashboard
          </Link>
          {isConnected && (
            <button
              onClick={() => disconnect()}
              className="flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-sm font-black text-red-600 hover:bg-red-100"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Log out
            </button>
          )}
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-blue-600 text-xl font-black text-white">
              {address ? address.slice(2, 4).toUpperCase() : <UserRound className="h-8 w-8" aria-hidden="true" />}
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-slate-400">User profile</p>
              <h1 className="mt-1 text-2xl font-black text-slate-950">{shortAddress(address)}</h1>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                This is off-chain profile metadata for the local demo.
              </p>
            </div>
          </div>

          <form onSubmit={saveProfile} className="mt-8 grid gap-5">
            <label className="grid gap-2 text-sm font-black text-slate-700">
              Display name
              <input
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Afan"
                className="h-12 rounded-xl border border-slate-200 px-4 text-sm font-semibold outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
                required
              />
            </label>

            <label className="grid gap-2 text-sm font-black text-slate-700">
              Notes
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Local demo borrower"
                className="min-h-28 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
              />
            </label>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="submit"
                className="flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-black text-white shadow-sm transition hover:bg-blue-700"
              >
                <Save className="h-4 w-4" aria-hidden="true" />
                Save profile
              </button>
              {status && <p className="text-sm font-semibold text-slate-500">{status}</p>}
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
