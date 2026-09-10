import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createBrowserClient(url, key);
}

/**
 * Whether Supabase is set up at all.
 *
 * Exists so callers can distinguish "not configured" from "configured but signed out".
 * useCompliance gates its whole query on this, which is what stops a checkout with no
 * Supabase project from retrying an auth call it can never satisfy.
 */
export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
