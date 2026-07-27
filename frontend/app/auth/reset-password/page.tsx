'use client';

/**
 * Step 2 of password recovery: the destination of the emailed link.
 *
 * Supabase puts the user into a temporary recovery session when they arrive
 * here, which is what authorises updateUser({ password }). If they land without
 * one (link expired, opened in a different browser, or the URL isn't allowlisted
 * in Supabase's Redirect URLs) we say so rather than failing on submit.
 */

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { createClient } from '../../../lib/supabase/client';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null); // null = still checking

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) {
      setReady(false);
      return;
    }
    // The recovery session is established asynchronously from the URL fragment,
    // so listen for it as well as checking what's already there.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) setReady(true);
    });
    void supabase.auth.getSession().then(({ data }) => {
      setReady((prev) => (prev === true ? prev : Boolean(data.session)));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    const supabase = createClient();
    if (!supabase) {
      setError('Supabase is not configured.');
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDone(true);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0e1a] p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-sm font-black text-slate-950">
            NF
          </div>
          <h1 className="text-2xl font-black text-white">Set a new password</h1>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#111827] p-8">
          {done ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-xl">
                ✓
              </div>
              <p className="text-sm font-bold text-white">Password updated</p>
              <Link
                href="/auth/login"
                className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-emerald-500 hover:bg-emerald-400 text-sm font-black text-slate-950 transition-colors"
              >
                Sign in
              </Link>
            </div>
          ) : ready === false ? (
            <div className="space-y-4 text-center">
              <p className="text-sm font-bold text-amber-400">This link isn&apos;t valid</p>
              <p className="text-xs text-slate-500 leading-relaxed">
                Reset links expire and only work in the browser that opened them. Request a fresh one.
              </p>
              <Link
                href="/auth/forgot-password"
                className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-emerald-500 hover:bg-emerald-400 text-sm font-black text-slate-950 transition-colors"
              >
                Request a new link
              </Link>
            </div>
          ) : ready === null ? (
            <p className="text-center text-xs text-slate-600">Checking your link…</p>
          ) : (
            <form onSubmit={onSubmit} className="grid gap-4">
              <label className="grid gap-2">
                <span className="text-xs font-bold text-slate-400 tracking-wide uppercase">New password</span>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 rounded-xl border border-slate-700 bg-slate-900 px-4 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
                  placeholder="At least 6 characters"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-xs font-bold text-slate-400 tracking-wide uppercase">Confirm password</span>
                <input
                  type="password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-11 rounded-xl border border-slate-700 bg-slate-900 px-4 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
                  placeholder="••••••••"
                />
              </label>
              {error && <p className="text-xs font-bold text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="h-11 rounded-xl bg-emerald-500 hover:bg-emerald-400 font-black text-sm text-slate-950 transition-colors disabled:opacity-50 mt-1"
              >
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
