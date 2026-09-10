'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount, useSignMessage, useConnect, useDisconnect } from 'wagmi';
import { useHydrated } from '../../hooks/useHydrated';
import { useCompliance } from '../../hooks/useCompliance';
import { createClient } from '../../lib/supabase/client';
import { KycBadge } from '../../components/KycBadge';
import { PriceTicker } from '../../components/PriceTicker';
import { StatementsPanel } from '../../components/StatementsPanel';
import { useTokenUsdPrice } from '../../hooks/useTokenPrices';
import { Hexagon, Check, Wallet } from 'lucide-react';

const ROLE_OPTIONS = [
  { value: 'borrower', label: 'Borrow', desc: 'Request ETH loans against crypto collateral' },
  { value: 'lender', label: 'Lend', desc: 'Contribute to loan requests and earn interest' },
  { value: 'both', label: 'Both', desc: 'Borrow and lend on one account' },
] as const;

type WalletEntry = {
  id: string;
  walletAddress: string;
  chainId: number;
  isPrimary: boolean;
  signatureVerified: boolean;
  verifiedAt: string | null;
  createdAt: string;
};

function WalletConnectPanel({ onConnected }: { onConnected?: () => void }) {
  const { connectors, connect, isPending } = useConnect({
    mutation: { onSuccess: onConnected },
  });
  const metaMask = connectors.find((c) => c.name === 'MetaMask') ?? connectors[0];

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => metaMask && connect({ connector: metaMask })}
        disabled={isPending || !metaMask}
        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-500/30 hover:border-amber-500/60 hover:bg-amber-500/5 text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Wallet className="h-4 w-4 flex-shrink-0 text-amber-400" />
        <span className="text-sm font-bold text-white flex-1">MetaMask</span>
        {isPending && (
          <span className="h-3.5 w-3.5 rounded-full border-2 border-amber-400 border-t-transparent animate-spin flex-shrink-0" />
        )}
      </button>
      {['Coinbase Wallet', 'Binance Wallet'].map((label) => (
        <button
          key={label}
          type="button"
          disabled
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-800 text-left cursor-not-allowed opacity-40"
        >
          <Wallet className="h-4 w-4 flex-shrink-0 text-slate-500" />
          <span className="text-sm font-bold text-slate-500 flex-1">{label}</span>
          <span className="text-[10px] font-bold text-slate-600 border border-slate-700 px-1.5 py-0.5 rounded">Coming soon</span>
        </button>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { address, isConnected, isReconnecting, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const compliance = useCompliance();

  const hydrated = useHydrated();
  const [walletStatus, setWalletStatus] = useState('');
  const [isLinkingWallet, setIsLinkingWallet] = useState(false);
  const { priceUsd: ethPrice } = useTokenUsdPrice('ETH');
  const [roleStatus, setRoleStatus] = useState('');
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);
  const [showConnector, setShowConnector] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDeletingWallet, setIsDeletingWallet] = useState(false);

  useEffect(() => {
    if (compliance.isLoading) return;
    if (!compliance.data?.authenticated) router.replace('/');
  }, [compliance.isLoading, compliance.data, router]);

  // When wallet connects, hide the connector panel and clear status
  useEffect(() => {
    if (isConnected) {
      setShowConnector(false);
      setWalletStatus('');
    }
  }, [isConnected]);

  const complianceData = compliance.data;
  const wallets: WalletEntry[] = (complianceData as { wallets?: WalletEntry[] } | undefined)?.wallets ?? [];
  const user = complianceData?.authenticated ? complianceData.user : null;
  const kycStatus = user?.kycStatus ?? 'NOT_STARTED';
  const currentRole = user?.userRole ?? null;

  // Requires signatureVerified, so a wallet whose linking was started but never signed
  // does not block a second attempt. Compared lowercase because the stored address is
  // normalised on the way in while wagmi hands back a checksummed one.
  const walletAlreadyLinked = Boolean(
    address && wallets.some((w) => w.walletAddress === address.toLowerCase() && w.signatureVerified)
  );

  const linkWallet = useCallback(async () => {
    if (!address || !chainId) { setWalletStatus('Connect a wallet first.'); return; }
    if (walletAlreadyLinked) { setWalletStatus('This wallet is already linked to your account.'); return; }
    setIsLinkingWallet(true);
    setWalletStatus('Requesting signature…');
    try {
      const nonceRes = await fetch('/api/wallets/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, chainId }),
      });
      const nonceBody = await nonceRes.json() as { message?: string; error?: string };
      if (!nonceRes.ok) { setWalletStatus(nonceBody.error ?? 'Failed to get nonce'); return; }
      const signature = await signMessageAsync({ message: nonceBody.message! });
      const verifyRes = await fetch('/api/wallets/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: address,
          chainId,
          message: nonceBody.message,
          signature,
          // First wallet becomes primary automatically; later ones do not, since
          // silently demoting the wallet a user already borrows from would change which
          // address the rest of the app treats as theirs without them asking.
          setPrimary: wallets.length === 0,
        }),
      });
      const body = await verifyRes.json() as { error?: string };
      if (!verifyRes.ok) { setWalletStatus(body.error ?? 'Verification failed'); return; }
      setWalletStatus('Wallet linked successfully.');
      void compliance.refetch();
    } catch (err) {
      setWalletStatus(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setIsLinkingWallet(false);
    }
  }, [address, chainId, signMessageAsync, wallets, walletAlreadyLinked, compliance]);

  async function deleteWallet(walletId: string) {
    setIsDeletingWallet(true);
    setWalletStatus('');
    try {
      const res = await fetch(`/api/wallets?id=${encodeURIComponent(walletId)}`, { method: 'DELETE' });
      if (res.ok) {
        setWalletStatus('Wallet removed.');
        setConfirmDeleteId(null);
        void compliance.refetch();
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setWalletStatus(body.error ?? 'Failed to remove wallet');
      }
    } finally {
      setIsDeletingWallet(false);
    }
  }

  async function updateRole(role: string) {
    setIsUpdatingRole(true);
    setRoleStatus('');
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userRole: role }),
      });
      if (res.ok) {
        setRoleStatus('Role updated.');
        void compliance.refetch();
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setRoleStatus(body.error ?? 'Failed to update role');
      }
    } finally {
      setIsUpdatingRole(false);
    }
  }

  async function signOut() {
    const supabase = createClient();
    if (supabase) await supabase.auth.signOut();
    window.location.replace('/');
  }

  if (compliance.isLoading || !complianceData?.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0e1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-800 border-t-emerald-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex flex-col">
      <PriceTicker />

      {/* Header */}
      <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-[#0a0e1a]/95 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Link href="/app" className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span className="text-sm font-bold">Dashboard</span>
          </Link>
          <span className="text-slate-700">/</span>
          <span className="text-sm font-black text-white">Account Settings</span>
        </div>
        <div className="flex items-center gap-4">
          {hydrated && !isReconnecting && isConnected && address && (
            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-mono text-slate-400">{address.slice(0, 6)}…{address.slice(-4)}</span>
              <button
                type="button"
                onClick={() => disconnect()}
                className="ml-1 text-[10px] font-bold text-slate-600 hover:text-red-400 transition-colors"
                title="Disconnect wallet"
              >
                ×
              </button>
            </div>
          )}
          <button
            onClick={() => void signOut()}
            className="text-xs font-bold text-slate-500 hover:text-red-400 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 max-w-3xl mx-auto w-full">
        <div className="space-y-5">

          {/* ── Profile Overview ── */}
          <div className="rounded-2xl border border-slate-800 bg-[#111827] p-6">
            <div className="flex items-center gap-4 mb-6">
              <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-emerald-500/20 border border-emerald-500/30 text-lg font-black text-emerald-400 select-none">
                {user?.email ? user.email.slice(0, 2).toUpperCase() : 'NF'}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5">Account</p>
                <p className="text-base font-black text-white truncate">{user?.email ?? 'N/A'}</p>
                {currentRole && (
                  <span className="inline-flex mt-1 items-center px-2 py-0.5 rounded-full text-[10px] font-bold border border-slate-700 text-slate-400">
                    {currentRole.charAt(0).toUpperCase() + currentRole.slice(1)}
                  </span>
                )}
              </div>
            </div>

            {/* KYC row */}
            <div className="flex items-center justify-between py-4 border-t border-slate-800">
              <div>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Identity Verification (KYC)</p>
                <KycBadge status={kycStatus} />
              </div>
              {kycStatus !== 'APPROVED' && (
                <Link
                  href="/onboarding"
                  className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-bold text-white transition-colors flex items-center"
                >
                  Complete KYC →
                </Link>
              )}
            </div>
          </div>

          {/* ── Connected Wallets ── */}
          <div className="rounded-2xl border border-slate-800 bg-[#111827] p-6">
            <div className="mb-5">
              <h2 className="text-sm font-black text-white uppercase tracking-widest">Connected Wallets</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {wallets.length} wallet{wallets.length !== 1 ? 's' : ''} linked to your account
              </p>
            </div>

            {/* Wallet list */}
            {wallets.length === 0 ? (
              <div className="py-8 text-center border border-dashed border-slate-700 rounded-xl mb-5">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-slate-600 mb-3">
                  <Hexagon className="h-6 w-6 text-slate-700" />
                </div>
                <p className="text-sm font-bold text-slate-500">No wallets linked</p>
                <p className="text-xs text-slate-700 mt-1">Link a wallet below to enable borrowing and lending</p>
              </div>
            ) : (
              <div className="space-y-3 mb-5">
                {wallets.map((w) => (
                  <div
                    key={w.id}
                    className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                      w.isPrimary
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-slate-700 bg-slate-900/30'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`flex-shrink-0 h-9 w-9 rounded-xl flex items-center justify-center text-sm font-black ${
                        w.isPrimary ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'
                      }`}>
                        {w.isPrimary ? '★' : '#'}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                          <p className="text-sm font-mono text-white">
                            {w.walletAddress.slice(0, 8)}…{w.walletAddress.slice(-6)}
                          </p>
                          {w.isPrimary && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-400">
                              Primary
                            </span>
                          )}
                          {w.signatureVerified ? (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-400">
                              Verified
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-700 border border-slate-600 text-slate-500">
                              Unverified
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-600">
                          Chain ID: {w.chainId}
                          {w.verifiedAt && ` · Verified ${new Date(w.verifiedAt).toLocaleDateString()}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-2 ml-3">
                      <a
                        href={`https://sepolia.etherscan.io/address/${w.walletAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-mono text-blue-500/60 hover:text-blue-400 transition-colors"
                      >
                        Etherscan ↗
                      </a>
                      {confirmDeleteId === w.id ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void deleteWallet(w.id)}
                            disabled={isDeletingWallet}
                            className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
                          >
                            {isDeletingWallet ? '…' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-[10px] font-bold text-slate-500 hover:text-slate-300 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(w.id)}
                          className="text-[10px] font-bold text-slate-600 hover:text-red-400 transition-colors"
                          title="Remove wallet"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Add wallet section ── */}
            <div className="border-t border-slate-800 pt-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Link Another Wallet</p>
                {hydrated && !isReconnecting && isConnected && (
                  <button
                    type="button"
                    onClick={() => { disconnect(); setWalletStatus(''); }}
                    className="text-[10px] font-bold text-slate-600 hover:text-slate-400 transition-colors"
                  >
                    Switch wallet
                  </button>
                )}
              </div>

              {/* Loading — not yet hydrated or wagmi is mid-reconnect */}
              {(!hydrated || isReconnecting) && (
                <div className="h-10 rounded-xl border border-slate-800 bg-slate-900/30 animate-pulse" />
              )}

              {/* Not connected — show wallet connectors inline */}
              {hydrated && !isReconnecting && !isConnected && (
                showConnector ? (
                  <div className="space-y-3">
                    <WalletConnectPanel />
                    <button
                      type="button"
                      onClick={() => setShowConnector(false)}
                      className="w-full text-xs font-bold text-slate-600 hover:text-slate-400 transition-colors py-1"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowConnector(true)}
                    className="w-full h-10 rounded-xl border border-amber-500/30 hover:border-amber-500/60 hover:bg-amber-500/5 text-sm font-bold text-slate-400 hover:text-white transition-all flex items-center justify-center gap-2"
                  >
                    <Wallet className="h-4 w-4" />
                    Connect MetaMask
                  </button>
                )
              )}

              {/* Connected — already linked */}
              {hydrated && !isReconnecting && isConnected && walletAlreadyLinked && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-400" />
                  <p className="text-xs text-emerald-400 font-bold">
                    {address?.slice(0, 8)}…{address?.slice(-6)} is already linked to your account
                  </p>
                </div>
              )}

              {/* Connected — not yet linked — show sign & link */}
              {hydrated && !isReconnecting && isConnected && !walletAlreadyLinked && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-slate-700 bg-slate-900/30 px-4 py-3 flex items-center gap-3">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                    <p className="text-xs font-mono text-slate-300 flex-1">
                      {address?.slice(0, 10)}…{address?.slice(-8)}
                    </p>
                    <span className="text-[10px] text-slate-600 flex-shrink-0">Ready to link</span>
                  </div>
                  <button
                    onClick={() => void linkWallet()}
                    disabled={isLinkingWallet}
                    className="w-full h-10 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-black text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isLinkingWallet ? (
                      <>
                        <span className="h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                        Signing…
                      </>
                    ) : (
                      'Sign & Link Wallet'
                    )}
                  </button>
                </div>
              )}

              {walletStatus && (
                <p className={`mt-2 text-xs font-bold ${
                  walletStatus.toLowerCase().includes('fail') || walletStatus.toLowerCase().includes('error')
                    ? 'text-red-400'
                    : walletStatus.toLowerCase().includes('success') || walletStatus.toLowerCase().includes('linked')
                    ? 'text-emerald-400'
                    : 'text-slate-400'
                }`}>
                  {walletStatus}
                </p>
              )}
            </div>
          </div>

          {/* ── Statements (T3) ── */}
          <StatementsPanel email={user?.email} ethPrice={ethPrice} />

          {/* ── Role Management ── */}
          <div id="role" className="rounded-2xl border border-slate-800 bg-[#111827] p-6 scroll-mt-6">
            <div className="mb-5">
              <h2 className="text-sm font-black text-white uppercase tracking-widest">Account Role</h2>
              <p className="text-xs text-slate-500 mt-0.5">Choose how you use NexusFi. You can change this any time.</p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {ROLE_OPTIONS.map(({ value, label, desc }) => {
                const isActive = currentRole === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => void updateRole(value)}
                    disabled={isUpdatingRole || isActive}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      isActive
                        ? 'border-emerald-500/40 bg-emerald-500/10 cursor-default'
                        : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/50 disabled:opacity-60 disabled:cursor-not-allowed'
                    }`}
                  >
                    <p className={`text-sm font-black mb-1 ${isActive ? 'text-emerald-400' : 'text-white'}`}>
                      {isActive && <Check className="h-3 w-3 mr-1 inline" />}{label}
                    </p>
                    <p className="text-[11px] text-slate-500 leading-relaxed">{desc}</p>
                  </button>
                );
              })}
            </div>

            {roleStatus && (
              <p className={`mt-3 text-xs font-bold ${
                roleStatus.toLowerCase().includes('fail') || roleStatus.toLowerCase().includes('error')
                  ? 'text-red-400'
                  : 'text-emerald-400'
              }`}>
                {roleStatus}
              </p>
            )}
          </div>

          {/* ── Sign Out ── */}
          <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-6">
            <h2 className="text-sm font-black text-red-400 uppercase tracking-widest mb-1">Sign Out</h2>
            <p className="text-xs text-slate-500 mb-4">End your current session on this device</p>
            <button
              onClick={() => void signOut()}
              className="h-10 px-5 rounded-xl border border-red-500/30 bg-red-500/10 text-sm font-bold text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Sign out →
            </button>
          </div>

        </div>
      </main>
    </div>
  );
}
