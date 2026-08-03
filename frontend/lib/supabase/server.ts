import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Request-scoped Supabase client that reads and writes the session cookies.
 *
 * Returns null instead of throwing when the environment is unset, so a checkout with
 * no Supabase project renders the app rather than crashing on every route.
 */
export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // set from Server Component — ignored if middleware handles refresh
          // Next forbids writing cookies during a Server Component render, and this
          // throws there. Safe to swallow only because middleware.ts performs the same
          // refresh on every request and can write the cookies legally.
        }
      },
    },
  });
}
