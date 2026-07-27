'use client';

/**
 * Step 1 of password recovery: ask Supabase to email a recovery link.
 *
 * The link lands on /auth/reset-password, which must be listed under
 * Authentication → URL Configuration → Redirect URLs in the Supabase dashboard,
 * or the click bounces to the site root with no session.
 */

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { createClient, isSupabaseConfigured } from '../../../lib/supabase/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const supabase = createClient();
    if (!supabase) {
      setError('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and ANON_KEY.');
      return;
    }
    setLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    setLoading(false);

    // Deliberately show success even on failure: telling a stranger whether an
    // address exists is an account-enumeration leak. Real errors are logged.
    if (resetError) console.error('[forgot-password]', resetError.message);
    setSent(true);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0e1a] p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-sm font-black text-slate-950">
            NF
          </div>
          <h1 className="text-2xl font-black text-white">Reset your password</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            We&apos;ll email you a link to set a new one.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#111827] p-8">
          {!isSupabaseConfigured() && (
            <p className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-400">
              Supabase env vars missing. Configure .env.local.
            </p>
          )}

          {sent ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-xl">
                ✓
              </div>
              <p className="text-sm font-bold text-white">Check your inbox</p>
              <p className="text-xs text-slate-500 leading-relaxed">
                If an account exists for <span className="font-mono text-slate-400">{email}</span>,
                a reset link is on its way. It expires shortly, so use it soon — and check spam.
              </p>
              <button
                onClick={() => setSent(false)}
                className="text-xs font-bold text-slate-500 hover:text-white transition-colors"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="grid gap-4">
              <label className="grid gap-2">
                <span className="text-xs font-bold text-slate-400 tracking-wide uppercase">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 rounded-xl border border-slate-700 bg-slate-900 px-4 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
                  placeholder="you@example.com"
                />
              </label>
              {error && <p className="text-xs font-bold text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="h-11 rounded-xl bg-emerald-500 hover:bg-emerald-400 font-black text-sm text-slate-950 transition-colors disabled:opacity-50 mt-1"
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-xs text-slate-600">
            Remembered it?{' '}
            <Link href="/auth/login" className="font-bold text-emerald-400 hover:text-emerald-300 transition-colors">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
