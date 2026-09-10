import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | null = null;

/**
 * Service-role client, which bypasses row level security entirely.
 *
 * Server-only: SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_ prefix, so importing this
 * from a client component leaves the key undefined and returns null rather than
 * shipping it to the browser. Callers treat null as "fall back to the user-scoped
 * client", which is why every caller still works with only the anon key set.
 */
export function createAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!adminClient) {
    // Cached across requests, and sessionless: this client authenticates as the
    // service role itself, so persisting a session would only risk carrying one
    // request's auth state into the next.
    adminClient = createClient(url, key, { auth: { persistSession: false } });
  }
  return adminClient;
}
