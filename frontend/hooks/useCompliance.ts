'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient, isSupabaseConfigured } from '../lib/supabase/client';

export function useCompliance() {
  return useQuery({
    queryKey: ['compliance'],
    enabled: isSupabaseConfigured(),
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const supabase = createClient();
      if (!supabase) return { authenticated: false as const };

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { authenticated: false as const };

      try {
        const res = await fetch('/api/wallets');

        if (!res.ok) {
          return {
            authenticated: true as const,
            user: { id: user.id, email: user.email ?? '', kycStatus: 'NOT_STARTED', displayName: null, userRole: null },
            wallets: [],
            screenings: [],
            hasVerifiedWallet: false,
            kycApproved: false,
            canBorrow: false,
            userRole: null,
            hasRole: false,
            canLend: false,
          };
        }

        const data = await res.json();
        const wallets = data.wallets as Array<{ signatureVerified: boolean }> | undefined;
        const hasVerifiedWallet = Array.isArray(wallets) && wallets.some((w) => w.signatureVerified);
        const kycApproved = data.user?.kycStatus === 'APPROVED';
        const userRole: string | null = data.user?.userRole ?? null;
        const hasRole = userRole !== null;
        const canLend = userRole === 'lender' || userRole === 'both';

        return {
          authenticated: true as const,
          user: data.user,
          wallets: data.wallets,
          screenings: data.screenings,
          hasVerifiedWallet,
          kycApproved,
          canBorrow: hasVerifiedWallet && kycApproved,
          userRole,
          hasRole,
          canLend,
        };
      } catch {
        return {
          authenticated: true as const,
          user: { id: user.id, email: user.email ?? '', kycStatus: 'NOT_STARTED', displayName: null, userRole: null },
          wallets: [],
          screenings: [],
          hasVerifiedWallet: false,
          kycApproved: false,
          canBorrow: false,
          userRole: null,
          hasRole: false,
          canLend: false,
        };
      }
    },
  });
}
