'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAccount, useConnect, useSignMessage } from 'wagmi';
import { PriceTicker } from '../../components/PriceTicker';
import { useCompliance } from '../../hooks/useCompliance';
import { kycStatusLabel } from '../../lib/kyc';
import { createClient } from '../../lib/supabase/client';
import { Wallet, Check } from 'lucide-react';

type Step = 'account' | 'role' | 'wallet' | 'kyc' | 'ready';

const DIDIT_CONFIGURED = process.env.NEXT_PUBLIC_DIDIT_CONFIGURED === 'true';
const ALLOW_DEMO = process.env.NODE_ENV === 'development';

const ROLE_OPTIONS = [
  {
    value: 'borrower',
    label: 'Borrow',
    icon: '↓',
    desc: 'Request ETH loans against crypto collateral',
    color: 'hover:border-emerald-500/50 hover:bg-emerald-500/5',
    activeColor: 'border-emerald-500/50 bg-emerald-500/5',
    textColor: 'text-emerald-400',
  },
  {
    value: 'lender',
    label: 'Lend',
    icon: '↑',
    desc: 'Fund loan requests and earn interest on-chain',
    color: 'hover:border-blue-500/50 hover:bg-blue-500/5',
    activeColor: 'border-blue-500/50 bg-blue-500/5',
    textColor: 'text-blue-400',
  },
  {
    value: 'both',
    label: 'Both',
    icon: '⇅',
    desc: 'Borrow and lend on the same verified account',
    color: 'hover:border-purple-500/50 hover:bg-purple-500/5',
    activeColor: 'border-purple-500/50 bg-purple-500/5',
    textColor: 'text-purple-400',
  },
] as const;

export default function OnboardingPage() {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const compliance = useCompliance();
  const [step, setStep] = useState<Step>('account');
  const [status, setStatus] = useState('');
  const [kycLoading, setKycLoading] = useState(false);
  const [checkLoading, setCheckLoading] = useState(false);
  const [roleLoading, setRoleLoading] = useState(false);
  const [signupBanner, setSignupBanner] = useState<string | null>(null);

  const [isKycReturn, setIsKycReturn] = useState(false);
  const [pollExpired, setPollExpired] = useState(false);
  const [diditSessionId, setDiditSessionId] = useState<string | null>(null);
  const [diditReturnedStatus, setDiditReturnedStatus] = useState<string | null>(null);
  const [hasAutoChecked, setHasAutoChecked] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flag = sessionStorage.getItem('nexusfi_signup_success');
    if (flag) {
      setSignupBanner('Account created! Complete the steps below to start borrowing.');
      sessionStorage.removeItem('nexusfi_signup_success');
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('kyc_return') === '1') {
      const sessionId = params.get('verificationSessionId');
      const returnedStatus = params.get('status');
      if (sessionId) setDiditSessionId(sessionId);
      if (returnedStatus) setDiditReturnedStatus(returnedStatus);
      setIsKycReturn(true);
      window.history.replaceState({}, '', '/onboarding');
    }
  }, []);

  const syncAndRefetch = useCallback(async () => {
    const params = new URLSearchParams();
    if (diditSessionId) params.set('sessionId', diditSessionId);
    if (diditReturnedStatus) params.set('returnedStatus', diditReturnedStatus);
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    await fetch(`/api/kyc/status${qs}`);
    await compliance.refetch();
  }, [compliance, diditSessionId, diditReturnedStatus]);

  useEffect(() => {
    if (!isKycReturn || !compliance.data?.authenticated || compliance.data?.kycApproved) return;
    const interval = setInterval(() => { void syncAndRefetch(); }, 3000);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      setIsKycReturn(false);
      setPollExpired(true);
    }, 90_000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [isKycReturn, compliance, syncAndRefetch]);

  useEffect(() => {
    if (compliance.data?.kycApproved) {
      setIsKycReturn(false);
      setPollExpired(false);
    }
  }, [compliance.data?.kycApproved]);

  useEffect(() => {
    if (hasAutoChecked) return;
    if (isKycReturn) return;
    if (!compliance.data?.authenticated) return;
    if (compliance.data?.kycApproved) return;
    const currentKycStatus = (compliance.data as { user?: { kycStatus?: string } } | undefined)?.user?.kycStatus;
    if (currentKycStatus !== 'PENDING') return;
    setHasAutoChecked(true);
    void syncAndRefetch();
  }, [compliance.data, hasAutoChecked, isKycReturn, syncAndRefetch]);

  useEffect(() => {
    if (!compliance.data?.authenticated) { setStep('account'); return; }
    if (!compliance.data.hasRole) { setStep('role'); return; }
    if (!compliance.data.hasVerifiedWallet) { setStep('wallet'); return; }
    if (!compliance.data.kycApproved) { setStep('kyc'); return; }
    setStep('ready');
  }, [compliance.data]);

  const verifyWallet = useCallback(async () => {
    if (!address || !chainId) { setStatus('Connect a wallet first.'); return; }
    setStatus('Requesting signature…');
    try {
      const nonceRes = await fetch('/api/wallets/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, chainId }),
      });
      const nonceBody = await nonceRes.json();
      if (!nonceRes.ok) { setStatus(nonceBody.error ?? 'Failed to request nonce. Try signing in again.'); return; }
      const { message } = nonceBody;
      const signature = await signMessageAsync({ message });
      const verifyRes = await fetch('/api/wallets/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, chainId, message, signature, setPrimary: true }),
      });
      const body = await verifyRes.json();
      if (!verifyRes.ok) { setStatus(body.error ?? 'Verification failed'); return; }
      setStatus('Wallet verified and linked.');
      void compliance.refetch();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Unexpected error. Please try again.');
    }
  }, [address, chainId, signMessageAsync, compliance]);

  async function selectRole(role: string) {
    setRoleLoading(true);
    setStatus('');
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userRole: role }),
      });
      if (res.ok) {
        void compliance.refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        setStatus((body as { error?: string }).error ?? 'Could not save role. Try again.');
      }
    } finally {
      setRoleLoading(false);
    }
  }

  async function startKyc() {
    setKycLoading(true);
    setStatus('');
    const callbackUrl = `${window.location.origin}/onboarding?kyc_return=1`;
    const res = await fetch('/api/kyc/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callbackUrl }),
    });
    const body = await res.json();
    setKycLoading(false);
    if (body.url) { window.location.href = body.url; return; }
    setStatus(body.error ?? 'Could not start KYC session.');
  }

  async function checkKycStatus() {
    setCheckLoading(true);
    setStatus('');
    try {
      await syncAndRefetch();
    } catch {
      setStatus('Could not reach verification service. Try again.');
    } finally {
      setCheckLoading(false);
    }
  }

  async function demoApproveKyc() {
    setStatus('Approving…');
    const res = await fetch('/api/kyc/demo-approve', { method: 'POST' });
    if (res.ok) {
      setStatus('');
      void compliance.refetch();
    } else {
      const body = await res.json().catch(() => ({}));
      setStatus((body as { error?: string }).error ?? 'Demo approve failed.');
    }
  }

  async function signOut() {
    const supabase = createClient();
    if (supabase) await supabase.auth.signOut();
    window.location.href = '/';
  }

  const kycStatus = compliance.data?.authenticated ? compliance.data.user?.kycStatus ?? 'NOT_STARTED' : 'NOT_STARTED';
  const kycIsPending = kycStatus === 'PENDING';

  const steps: { id: Step; label: string; detail: string; done: boolean }[] = [
    {
      id: 'account',
      label: '01  Account',
      detail: compliance.data?.authenticated
        ? `Signed in as ${compliance.data.user.email}`
        : 'Email + password via Supabase',
      done: Boolean(compliance.data?.authenticated),
    },
    {
      id: 'role',
      label: '02  Choose role',
      detail: compliance.data?.hasRole
        ? `Role: ${compliance.data.userRole}`
        : 'Borrower, lender, or both',
      done: Boolean(compliance.data?.hasRole),
    },
    {
      id: 'wallet',
      label: '03  Verify wallet',
      detail: 'Prove you control the wallet (EIP-191 signing)',
      done: Boolean(compliance.data?.hasVerifiedWallet),
    },
    {
      id: 'kyc',
      label: '04  Identity (KYC)',
      detail: compliance.data?.authenticated
        ? `Status: ${kycStatusLabel(compliance.data.user.kycStatus)}`
        : 'Government ID. We never store documents.',
      done: Boolean(compliance.data?.kycApproved),
    },
    {
      id: 'ready',
      label: '05  Ready',
      detail: 'Access the lending desk',
      done: step === 'ready',
    },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-[#0a0e1a]">
      <PriceTicker />

      <header className="flex items-center justify-between px-8 py-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-xs font-black text-slate-950">NF</div>
          <span className="text-sm font-black tracking-widest text-white uppercase">NexusFi</span>
        </div>
        {compliance.data?.authenticated && (
          <button type="button" onClick={() => void signOut()} className="text-xs font-bold text-slate-500 hover:text-red-400 transition-colors">
            Sign out
          </button>
        )}
      </header>

      <main className="flex flex-1 flex-col items-center justify-center p-6 py-12">
        <div className="w-full max-w-lg">

          {signupBanner && (
            <div className="mb-4 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-3">
              <p className="text-sm font-bold text-emerald-400">{signupBanner}</p>
              <button type="button" onClick={() => setSignupBanner(null)} className="ml-4 text-lg leading-none text-emerald-600 hover:text-emerald-400" aria-label="Dismiss">×</button>
            </div>
          )}

          <div className="rounded-2xl border border-slate-800 bg-[#111827] p-8 shadow-xl">
            <h1 className="text-2xl font-black text-white">Onboarding</h1>
            <p className="mt-1.5 text-xs font-medium text-slate-500 tracking-wide">Complete all steps to access the lending desk</p>

            <ol className="mt-8 space-y-2">
              {steps.map(({ id, label, detail, done }) => {
                const active = step === id;
                return (
                  <li key={id} className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${done ? 'border-emerald-500/30 bg-emerald-500/5' : active ? 'border-blue-500/30 bg-blue-500/5' : 'border-slate-800 bg-slate-900/50'}`}>
                    <span className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-black ${done ? 'bg-emerald-500 text-slate-950' : active ? 'border-2 border-blue-500 text-blue-400' : 'border border-slate-700 text-slate-600'}`}>
                      {done ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <div>
                      <p className={`text-sm font-black ${done ? 'text-emerald-400' : active ? 'text-white' : 'text-slate-600'}`}>{label}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{detail}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-8 space-y-3">

              {/* Step 1 — Account */}
              {!compliance.data?.authenticated && (
                <div className="flex flex-wrap gap-3">
                  <Link href="/auth/signup" className="flex-1 flex h-11 items-center justify-center rounded-xl bg-emerald-500 hover:bg-emerald-400 text-sm font-black text-slate-950 transition-colors">Sign up</Link>
                  <Link href="/auth/login" className="flex-1 flex h-11 items-center justify-center rounded-xl border border-slate-700 hover:border-slate-500 text-sm font-bold text-slate-300 hover:text-white transition-colors">Sign in</Link>
                </div>
              )}

              {/* Step 2 — Role Selection */}
              {compliance.data?.authenticated && step === 'role' && (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Choose how you want to use NexusFi. You can change this from settings later.</p>
                  <div className="space-y-2">
                    {ROLE_OPTIONS.map(({ value, label, icon, desc, color, textColor }) => (
                      <button
                        key={value}
                        type="button"
                        disabled={roleLoading}
                        onClick={() => void selectRole(value)}
                        className={`w-full flex items-center gap-4 p-4 rounded-xl border border-slate-700 ${color} text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        <span className={`text-2xl font-black ${textColor} w-8 text-center flex-shrink-0`}>{icon}</span>
                        <div>
                          <p className="text-sm font-black text-white">{label}</p>
                          <p className="text-xs text-slate-500">{desc}</p>
                        </div>
                        <span className="ml-auto text-slate-600 text-lg">→</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 3 — Wallet */}
              {compliance.data?.authenticated && step === 'wallet' && (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Connect MetaMask, then sign once to prove you control the address.</p>
                  {!isConnected ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        disabled={isConnecting}
                        onClick={() => {
                          const mm = connectors.find((c) => c.name === 'MetaMask') ?? connectors[0];
                          if (mm) connect({ connector: mm });
                        }}
                        className="h-11 w-full rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-sm font-black text-amber-300 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isConnecting ? (
                          <span className="h-4 w-4 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
                        ) : (
                          <Wallet className="h-4 w-4" />
                        )}
                        {isConnecting ? 'Connecting…' : 'MetaMask'}
                      </button>
                      {['Coinbase Wallet', 'Binance Wallet'].map((label) => (
                        <button
                          key={label}
                          type="button"
                          disabled
                          className="h-11 w-full rounded-xl border border-slate-800 text-sm font-bold text-slate-600 flex items-center justify-center gap-2 cursor-not-allowed opacity-40"
                        >
                          <Wallet className="h-4 w-4" />
                          {label}
                          <span className="text-[10px] border border-slate-700 px-1.5 py-0.5 rounded ml-1">Coming soon</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button type="button" onClick={() => void verifyWallet()} className="h-11 w-full rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-black text-white transition-colors">
                      Sign & link {address?.slice(0, 6)}…{address?.slice(-4)}
                    </button>
                  )}
                </div>
              )}

              {/* Step 4 — KYC */}
              {compliance.data?.authenticated && step === 'kyc' && (
                <div className="space-y-3">

                  {isKycReturn && (
                    <div className="flex items-center gap-3 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-4">
                      <div className="h-4 w-4 flex-shrink-0 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                      <div>
                        <p className="text-xs font-bold text-blue-400">Checking your verification status…</p>
                        <p className="text-xs text-slate-500 mt-0.5">Syncing with Didit, this takes a few seconds</p>
                      </div>
                    </div>
                  )}

                  {!isKycReturn && (kycIsPending || pollExpired) && (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                      <p className="text-xs font-bold text-amber-400">Verification submitted</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {pollExpired
                          ? 'Still waiting on your result. Click below to check.'
                          : 'Your documents are being reviewed. Check status below.'}
                      </p>
                    </div>
                  )}

                  {DIDIT_CONFIGURED && (
                    <button
                      type="button"
                      disabled={kycLoading || kycIsPending || isKycReturn}
                      onClick={() => void startKyc()}
                      className="h-11 w-full rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-black text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {kycLoading ? 'Starting session…' : kycIsPending || isKycReturn ? 'Verification in progress…' : 'Verify identity with Didit'}
                    </button>
                  )}

                  {DIDIT_CONFIGURED && (kycIsPending || pollExpired) && !isKycReturn && (
                    <button
                      type="button"
                      disabled={checkLoading}
                      onClick={() => void checkKycStatus()}
                      className="h-11 w-full rounded-xl border border-blue-500/40 hover:border-blue-400 text-sm font-bold text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {checkLoading && <span className="h-3 w-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />}
                      {checkLoading ? 'Checking…' : 'Check verification status'}
                    </button>
                  )}

                  {!DIDIT_CONFIGURED && (
                    <>
                      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                        <p className="text-xs font-bold text-amber-400">Dev mode: Didit not configured</p>
                        <p className="text-xs text-slate-500 mt-0.5">Set DIDIT_API_KEY + DIDIT_WORKFLOW_ID and flip NEXT_PUBLIC_DIDIT_CONFIGURED=true to enable real KYC.</p>
                      </div>
                      <button type="button" onClick={() => void demoApproveKyc()} className="h-11 w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm font-black text-white transition-colors">
                        Approve KYC (demo)
                      </button>
                    </>
                  )}

                  {DIDIT_CONFIGURED && ALLOW_DEMO && (
                    <button type="button" onClick={() => void demoApproveKyc()} className="w-full text-xs font-bold text-slate-600 hover:text-slate-400 transition-colors py-1">
                      Skip verification (dev bypass)
                    </button>
                  )}
                </div>
              )}

              {/* Step 5 — Ready */}
              {step === 'ready' && (
                <Link href="/app" className="flex h-11 items-center justify-center rounded-xl bg-emerald-500 hover:bg-emerald-400 text-sm font-black text-slate-950 transition-colors shadow-lg shadow-emerald-500/20">
                  Go to App →
                </Link>
              )}

              {status && (
                <p className={`text-xs font-bold ${status.includes('error') || status.includes('fail') || status.includes('required') || status.includes('reject') ? 'text-red-400' : 'text-slate-400'}`}>
                  {status}
                </p>
              )}
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-slate-700">One identity → one account → many verified wallets</p>
        </div>
      </main>
    </div>
  );
}
