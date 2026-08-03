'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { createClient, isSupabaseConfigured } from '../../../lib/supabase/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
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
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    sessionStorage.setItem('nexusfi_login_success', '1');
    // Full navigation rather than a router push. The session cookie was just written by
    // the Supabase client, and only a fresh request runs it through middleware, so this
    // is what makes the server render the landing page as signed in on first paint.
    window.location.replace('/');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0e1a] p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-sm font-black text-slate-950">
            NF
          </div>
          <h1 className="text-2xl font-black text-white">Welcome back</h1>
          <p className="mt-1.5 text-sm text-slate-500">Sign in to your NexusFi account.</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#111827] p-8">
          {!isSupabaseConfigured() && (
            <p className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-400">
              Supabase env vars missing. Configure .env.local.
            </p>
          )}
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
            <label className="grid gap-2">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-bold text-slate-400 tracking-wide uppercase">Password</span>
                <Link
                  href="/auth/forgot-password"
                  className="text-[11px] font-bold text-slate-500 hover:text-emerald-400 transition-colors"
                >
                  Forgot?
                </Link>
              </div>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p className="mt-6 text-center text-xs text-slate-600">
            No account?{' '}
            <Link href="/auth/signup" className="font-bold text-emerald-400 hover:text-emerald-300 transition-colors">
              Create one
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
