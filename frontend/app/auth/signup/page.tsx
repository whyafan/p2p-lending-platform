'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { createClient, isSupabaseConfigured } from '../../../lib/supabase/client';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const supabase = createClient();
    if (!supabase) {
      setError('Supabase is not configured.');
      return;
    }
    setLoading(true);
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: displayName } },
    });
    setLoading(false);
    if (signUpError) {
      const msg = signUpError.message.toLowerCase();
      if (msg.includes('rate limit') || msg.includes('rate_limit')) {
        setError(
          'Too many sign-up attempts — Supabase rate-limited email sending. ' +
          'Fix: Supabase Dashboard → Authentication → Providers → Email → disable "Confirm email". ' +
          'Or wait ~1 hour and try again.',
        );
      } else {
        setError(signUpError.message);
      }
      return;
    }

    // signUp succeeding does not mean the user is signed in: with email confirmation
    // enabled Supabase creates the account but issues no session. The presence of a
    // session is what distinguishes the two, and sending an unconfirmed user to
    // onboarding would land them on a page that immediately bounces them back.
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setError('Check your email for a confirmation link, then sign in.');
      return;
    }

    sessionStorage.setItem('nexusfi_signup_success', '1');
    window.location.replace('/onboarding');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0e1a] p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-sm font-black text-slate-950">
            NF
          </div>
          <h1 className="text-2xl font-black text-white">Create account</h1>
          <p className="mt-1.5 text-sm text-slate-500">Connect your wallet and start borrowing on-chain.</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#111827] p-8">
          {!isSupabaseConfigured() && (
            <p className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-400">
              Supabase env vars missing. Configure .env.local.
            </p>
          )}
          <form onSubmit={onSubmit} className="grid gap-4">
            <label className="grid gap-2">
              <span className="text-xs font-bold text-slate-400 tracking-wide uppercase">Display name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="h-11 rounded-xl border border-slate-700 bg-slate-900 px-4 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
                placeholder="Optional"
              />
            </label>
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
            <label className="grid gap-2">
              <span className="text-xs font-bold text-slate-400 tracking-wide uppercase">Password</span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 rounded-xl border border-slate-700 bg-slate-900 px-4 text-sm text-white placeholder-slate-600 focus:border-blue-500 focus:outline-none transition-colors"
                placeholder="Min 8 characters"
              />
            </label>
            {error && <p className="text-xs font-bold text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="h-11 rounded-xl bg-emerald-500 hover:bg-emerald-400 font-black text-sm text-slate-950 transition-colors disabled:opacity-50 mt-1"
            >
              {loading ? 'Creating account…' : 'Create account'}
            </button>
          </form>
          <p className="mt-6 text-center text-xs text-slate-600">
            Already have an account?{' '}
            <Link href="/auth/login" className="font-bold text-emerald-400 hover:text-emerald-300 transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
