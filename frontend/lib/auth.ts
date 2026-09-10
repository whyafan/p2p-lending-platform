import { createClient } from './supabase/server';
import { createAdminClient } from './supabase/admin';
import type { Profile } from './supabase/types';

// Returns the authenticated user + profile, or null if not signed in.
// Uses the admin client when available (bypasses RLS). Falls back to the
// server client when SUPABASE_SERVICE_ROLE_KEY is not set — requires
// RLS policies from supabase/migrations/002_rls_and_user_role.sql.
export async function getSessionUser() {
  const supabase = await createClient();
  if (!supabase) {
    console.error('[auth] Supabase client not created — check NEXT_PUBLIC_SUPABASE_URL / ANON_KEY');
    return null;
  }

  // getUser, never getSession: getSession trusts the cookie as it stands, while
  // getUser revalidates the token against Supabase. On the server that difference is
  // the difference between an identity and a claim.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (!user?.email) {
    if (authError) console.error('[auth] getUser failed:', authError.message);
    return null;
  }

  const db = createAdminClient() ?? supabase;

  // Upsert rather than select: the profile row is created lazily on first authenticated
  // request instead of by a signup trigger, so a user who exists in Supabase Auth but
  // has no profile row is a normal state that heals itself here.
  const { data, error } = await db
    .from('profiles')
    .upsert(
      {
        id: user.id,
        email: user.email,
        display_name: user.user_metadata?.full_name ?? user.email.split('@')[0],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
    .select()
    .single();

  if (error) {
    console.warn('[auth] profiles upsert failed:', error.message, '— run migration 002 or set SUPABASE_SERVICE_ROLE_KEY');
  }

  // A failed upsert degrades to an in-memory profile rather than signing the user out.
  // They are authenticated either way, and the defaults below are all the restrictive
  // ones: no KYC, no role, so nothing gated opens up because the write failed.
  const profile: Profile = (data as Profile | null) ?? {
    id: user.id,
    email: user.email,
    display_name: user.user_metadata?.full_name ?? user.email.split('@')[0] ?? null,
    kyc_status: 'NOT_STARTED',
    didit_session_id: null,
    kyc_provider: 'didit',
    verified_at: null,
    rejection_reason: null,
    user_role: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Return serverClient so callers can use it as a db fallback without a second createClient() call
  return { supabaseUser: user, profile, serverClient: supabase };
}
