'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { type State, WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { getConfig } from './wagmi-config';
import { createClient } from '../lib/supabase/client';

type ProvidersProps = {
  children: ReactNode;
  initialState?: State;
};

/**
 * Listens to Supabase auth state changes and immediately invalidates the
 * 'compliance' React Query cache.
 *
 * Without this, the dashboard keeps stale compliance data (authenticated: false)
 * for up to staleTime milliseconds after login / logout because:
 *   - router.refresh() only triggers a server-side re-render, not a query refetch
 *   - refetchOnWindowFocus is disabled on useCompliance
 *   - staleTime prevents automatic background refetches
 *
 * By invalidating on every SIGNED_IN / SIGNED_OUT event, the header and
 * borrower gate update within one round-trip of the auth event.
 */
function AuthStateSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void queryClient.invalidateQueries({ queryKey: ['compliance'] });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [queryClient]);

  return null;
}

export function Providers({ children, initialState }: ProvidersProps) {
  const [config] = useState(() => getConfig());
  // Chain state is shared between two people in real time — a borrower repays and
  // the lender must see it without hitting reload. React Query pauses polling for
  // unfocused tabs by default, which is precisely the two-window case, so keep it
  // running in the background and refetch the moment a tab regains focus.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchIntervalInBackground: true,
            refetchOnWindowFocus: true,
            staleTime: 0,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <AuthStateSync />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
