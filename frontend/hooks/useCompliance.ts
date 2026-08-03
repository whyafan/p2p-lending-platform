'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient, isSupabaseConfigured } from '../lib/supabase/client';

/**
 * The user's compliance standing: signed in, wallet linked and signature-verified,
 * KYC approved, and which role they chose. Everything gated in the UI reads from here.
 *
 * The derived booleans (canBorrow, canLend, hasRole) are computed once, in this hook,
 * rather than at each call site. Borrowing in particular requires both a verified
 * wallet and approved KYC, and re-deriving that condition in every component is how
 * one of them ends up checking only half of it.
 */
export function useCompliance() {
  return useQuery({
    queryKey: ['compliance'],
    enabled: isSupabaseConfigured(),
    // KYC approval and wallet verification both complete outside this tab, in a Didit
    // flow or a MetaMask prompt. Refetching on focus with no stale window is what makes
    // the gates open on return without the user reloading the page.
    refetchOnWindowFocus: true,
    staleTime: 0,
    // No retries: every failure path below already resolves to a fully denied state,
    // so a retry would only delay showing the user an accurate, if pessimistic, answer.
    retry: false,
    queryFn: async () => {
      const supabase = createClient();
      if (!supabase) return { authenticated: false as const };

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { authenticated: false as const };

      try {
        const res = await fetch('/api/wallets');

        // Both this branch and the catch below return the same shape: authenticated,
        // but with every permission denied. A failed compliance read must never leave
        // a gate open, and the user stays signed in either way.
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
        // Requires at least one wallet that passed the signature challenge, not merely
        // one that is linked: linking records an address, signing proves the user
        // controls it, and only the latter is worth gating on.
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
          // Borrowing is the stricter gate of the two: a borrower takes on a debt and
          // posts collateral, so they must be both identified and provably in control
          // of the wallet. Lending only asks for the role, since a lender risks their
          // own funds and the contract holds them to nothing afterwards.
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
