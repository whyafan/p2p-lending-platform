import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the Supabase session on every request.
 *
 * Server Components cannot write cookies, so the getUser() call in lib/supabase/server
 * can rotate a token but not persist it. This middleware is the one place in the
 * request cycle allowed to set them, which is why it runs on almost every path and why
 * the cookie handling below writes to both the request and the response: the request
 * copy is what the same-cycle Server Components read, the response copy is what
 * reaches the browser.
 *
 * It refreshes only. Nothing here redirects or authorises, so this is not a route
 * guard: access decisions belong to the pages and route handlers themselves.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // The call itself is the work: it validates the token and, if it was near expiry,
  // triggers the setAll above with the rotated cookies. The user object is discarded.
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // Everything except static assets. Running this on images and bundled JS would add a
  // Supabase round trip to requests that have no session to refresh.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
