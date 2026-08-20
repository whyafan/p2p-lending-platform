'use client';

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useCompliance } from '../../../hooks/useCompliance';
import { useTokenPrices } from '../../../hooks/useTokenPrices';
import { KycBadge } from '../../../components/KycBadge';
import { PublicLoanSummary } from '../../../components/PublicLoanSummary';
import { ArrowLeft, ExternalLink, Copy } from 'lucide-react';

type DirectoryProfile = {
  id: string;
  displayName: string | null;
  kycStatus: string;
  userRole: string | null;
  walletAddress: string;
};

const ROLE_LABEL: Record<string, string> = {
  borrower: 'Borrower',
  lender: 'Lender',
  both: 'Borrower & Lender',
};

export default function DirectoryProfilePage() {
  const router = useRouter();
  const params = useParams<{ walletAddress: string }>();
  const compliance = useCompliance();
  const { data: priceData } = useTokenPrices();
  const ethPrice = priceData?.prices?.['ETH'] ?? priceData?.prices?.['ethereum'] ?? 0;

  useEffect(() => {
    if (compliance.isLoading) return;
    if (!compliance.data?.authenticated) router.replace('/');
  }, [compliance.isLoading, compliance.data, router]);

  const { data: profile, isLoading: profileLoading, error } = useQuery<DirectoryProfile>({
    queryKey: ['directory-profile', params.walletAddress],
    queryFn: async () => {
      const res = await fetch(`/api/directory/${params.walletAddress}`);
      // A 401 here means the session lapsed between mount and this fetch
      // (compliance.data?.authenticated was still true client-side when the
      // query was enabled). It is not "not found" - collapsing it into that
      // bucket would tell a user with an expired session that the person
      // they looked up does not exist.
      if (res.status === 401) throw new Error('UNAUTHORIZED');
      if (res.status === 404) throw new Error('NOT_FOUND');
      if (!res.ok) throw new Error('LOAD_FAILED');
      const data = await res.json();
      return data.profile as DirectoryProfile;
    },
    enabled: Boolean(params.walletAddress) && Boolean(compliance.data?.authenticated),
    retry: false,
  });

  const isUnauthorized = error instanceof Error && error.message === 'UNAUTHORIZED';

  useEffect(() => {
    // Same handling the rest of the app gives an invalid session (see the
    // compliance-based redirect above, and app/app/page.tsx): send them back
    // to '/' rather than rendering anything about the looked-up profile.
    if (isUnauthorized) router.replace('/');
  }, [isUnauthorized, router]);

  const networkMode: 'local' | 'testnet' =
    (process.env.NEXT_PUBLIC_NETWORK_MODE as 'local' | 'testnet') ?? 'testnet';
  const factoryAddress =
    networkMode === 'testnet'
      ? process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA
      : process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL;
  const chainId = networkMode === 'testnet' ? 11155111 : 31337;

  if (compliance.isLoading || !compliance.data?.authenticated || isUnauthorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/directory" className="text-slate-500 hover:text-white transition-colors">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-black text-white">User profile</h1>
        </div>

        {profileLoading && <p className="text-xs text-slate-600">Loading...</p>}

        {error && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-8 text-center">
            <p className="text-sm font-bold text-slate-400">
              {error instanceof Error && error.message === 'LOAD_FAILED'
                ? 'Failed to load this profile. Please try again.'
                : 'User not found or not verified.'}
            </p>
          </div>
        )}

        {profile && (
          <>
            <div className="rounded-2xl border border-slate-800 bg-[#111827] p-5 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-base font-black text-white">{profile.displayName ?? 'Unnamed user'}</p>
                <KycBadge status={profile.kycStatus} />
                {profile.userRole && (
                  <span className="text-[10px] font-bold text-slate-500 border border-slate-700 px-2 py-1 rounded-full">
                    {ROLE_LABEL[profile.userRole] ?? profile.userRole}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                <span>{profile.walletAddress}</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(profile.walletAddress)}
                  className="text-slate-600 hover:text-white transition-colors"
                  title="Copy address"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <a
                  href={`https://sepolia.etherscan.io/address/${profile.walletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-600 hover:text-white transition-colors"
                  title="View on Etherscan"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>

            {(profile.userRole === 'borrower' || profile.userRole === 'both') && (
              <div>
                <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                  Open loan requests
                </p>
                <PublicLoanSummary
                  mode="borrower"
                  targetAddress={profile.walletAddress as `0x${string}`}
                  factoryAddress={factoryAddress}
                  chainId={chainId}
                  ethPrice={ethPrice}
                />
              </div>
            )}

            {(profile.userRole === 'lender' || profile.userRole === 'both') && (
              <div>
                <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-2">
                  Active positions
                </p>
                <PublicLoanSummary
                  mode="lender"
                  targetAddress={profile.walletAddress as `0x${string}`}
                  factoryAddress={factoryAddress}
                  chainId={chainId}
                  ethPrice={ethPrice}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
