'use client';

/**
 * Lender-facing "loan safety panel".
 *
 * The dashboards already showed a Tier A/B/C badge, but a letter on its own
 * tells a lender nothing — the lender-journey spec asks for the reasoning and
 * the protections behind it. This expands the badge into: what the tier means,
 * how it produced these exact terms, what protects the lender, and what happens
 * when it goes wrong.
 *
 * Everything here is derived from on-chain loan terms plus the tier→terms rules
 * in lib/loan-terms.ts. The borrower's underlying feature-level risk breakdown
 * is computed in their browser at request time and never persisted, so it can't
 * be shown here yet — see PLAN.md for that follow-up.
 */

import { useState } from 'react';
import { verifyTypedData } from 'viem';
import type { RiskTier } from '../lib/loan-terms';
import type { FeatureContribution } from '../lib/risk-explainer';
import { RISK_TIER_CONFIG, BASE_APR } from '../lib/loan-terms';
import { formatPercent, formatUsd } from '../lib/format';
import { termSheetHash } from '../lib/termsheet-canonical';
import { TERM_SHEET_TYPES, parseMessage, PINATA_GATEWAY } from '../lib/termsheet-typed-data';
import { ShieldCheck, ChevronDown, AlertTriangle } from 'lucide-react';

type Props = {
  tier: RiskTier | null;
  maxLtvBps: number;
  liquidationBufferBps: number;
  interestBps: number;
  durationDays: number;
  /** Live LTV from the contract (0–1). null when the oracle is unavailable. */
  currentLtv: number | null;
  /** Whole-loan figures - this pool's total collateral and principal, not any one lender's. */
  collateralUsd: number | null;
  principalUsd: number | null;
  /**
   * This viewer's fraction of the loan's principal (0-1), when they have a
   * position. 0 or omitted means "no personal position yet" - the panel then
   * shows the loan's whole-pool figures labelled as the loan's, not "yours".
   * Multi-lender pooling means principalUsd/collateralUsd above are never a
   * single lender's own numbers.
   */
  myShareFrac?: number;
  /** Contract's own view — the authoritative gate. */
  isLiquidatable?: boolean;
  /** Persisted borrower assessment, when one was saved at request time. */
  assessment?: {
    tier: RiskTier;
    overallScore: number;
    contributions: FeatureContribution[];
    source?: string | null;
    personaId?: string | null;
    modelVersion?: string | null;
    termSheetCid?: string | null;
    termSheetHash?: string | null;
  } | null;
  /** This loan's borrower - used to confirm the term-sheet signer matches. */
  borrower?: string | null;
};

export function LoanSafetyPanel({
  tier,
  maxLtvBps,
  liquidationBufferBps,
  interestBps,
  durationDays,
  currentLtv,
  collateralUsd,
  principalUsd,
  myShareFrac,
  isLiquidatable,
  assessment,
  borrower,
}: Props) {
  const [open, setOpen] = useState(false);
  type VerifyState = 'idle' | 'checking' | 'verified' | 'mismatch' | 'error';
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifyDetail, setVerifyDetail] = useState<string | null>(null);

  async function verifyTermSheet() {
    if (!assessment?.termSheetCid || !assessment.termSheetHash) return;
    setVerifyState('checking');
    setVerifyDetail(null);
    try {
      const res = await fetch(`${PINATA_GATEWAY}${assessment.termSheetCid}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`gateway ${res.status}`);
      const payload = (await res.json()) as Record<string, unknown>;

      // 1. Content integrity: the fetched document hashes to the stored hash.
      if (termSheetHash(payload) !== assessment.termSheetHash.toLowerCase()) {
        setVerifyState('mismatch');
        setVerifyDetail('The document on IPFS does not match the hash saved at loan creation.');
        return;
      }

      // 2. Signature: the signer really signed these terms, and is this loan's borrower.
      const message = parseMessage(payload.message as Record<string, unknown>);
      const signer = String(payload.signer ?? '');
      const sigOk = await verifyTypedData({
        address: signer as `0x${string}`,
        domain: payload.domain as { name: string; version: string; chainId: number },
        types: TERM_SHEET_TYPES,
        primaryType: 'LoanTermSheet',
        message,
        signature: String(payload.signature ?? '') as `0x${string}`,
      });
      const isBorrower = !borrower || signer.toLowerCase() === borrower.toLowerCase();
      if (sigOk && isBorrower) {
        setVerifyState('verified');
      } else {
        setVerifyState('mismatch');
        setVerifyDetail(sigOk
          ? 'Signature is valid but the signer is not this loan\'s borrower.'
          : 'The EIP-712 signature does not verify against the pinned terms.');
      }
    } catch {
      setVerifyState('error');
      setVerifyDetail('Could not fetch or verify the term sheet from the IPFS gateway. Try again in a moment.');
    }
  }

  const cfg = tier ? RISK_TIER_CONFIG[tier] : null;
  const maxLtv = maxLtvBps / 10_000;
  const buffer = liquidationBufferBps / 10_000;
  const threshold = maxLtv + buffer;
  const apr = interestBps / 10_000;

  // A personal position exists only once this viewer actually holds a share
  // of the pool - otherwise the "Your protection" heading and figures below
  // would be asserting a position that doesn't exist yet.
  const hasPosition = (myShareFrac ?? 0) > 0;
  const myCollateralUsd =
    collateralUsd !== null && hasPosition ? collateralUsd * (myShareFrac as number) : null;
  const myPrincipalUsd =
    principalUsd !== null && hasPosition ? principalUsd * (myShareFrac as number) : null;

  // How far ETH can fall before this loan becomes liquidatable. Debt is
  // frozen in USD at funding, so LTV scales inversely with price:
  // liquidation at  currentLtv / threshold  of today's price. Price-invariant
  // to any one lender's share, so this stays loan-wide regardless of hasPosition.
  const dropToLiquidation =
    currentLtv !== null && currentLtv > 0 && threshold > 0
      ? Math.max(0, 1 - currentLtv / threshold)
      : null;

  // What the pool recovers at the moment of liquidation, before gas - loan-wide,
  // scaled down to this viewer's share only where it's presented as personal.
  const collateralAtThreshold =
    principalUsd !== null && threshold > 0 ? principalUsd / threshold : null;
  const myCollateralAtThreshold =
    collateralAtThreshold !== null && hasPosition ? collateralAtThreshold * (myShareFrac as number) : null;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-900/40 transition-colors"
      >
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
        <span className="text-[11px] font-bold text-slate-300">
          Why {cfg ? cfg.label : 'this tier'}, and what protects you
        </span>
        {isLiquidatable && (
          <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/20 text-red-400">
            <AlertTriangle className="h-2.5 w-2.5" /> at risk
          </span>
        )}
        <ChevronDown
          className={`h-3.5 w-3.5 text-slate-600 ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-800/60 pt-3">

          {cfg && (
            <p className="text-[11px] text-slate-500 leading-relaxed">
              <span className="font-bold text-slate-300">{cfg.borrowerRisk}.</span>{' '}
              The borrower&apos;s risk assessment produced {cfg.label}, and that tier{' '}
              <span className="text-slate-400">deterministically</span> set every number below —
              the terms aren&apos;t negotiated or hand-set, they follow fixed rules from the tier.
            </p>
          )}

          {/* tier → terms mapping */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Max LTV', value: formatPercent(maxLtv), hint: 'borrow limit at origination' },
              { label: 'APR', value: formatPercent(apr), hint: cfg ? `${formatPercent(BASE_APR)} base + ${formatPercent(cfg.aprSpread)} risk` : 'base + risk spread' },
              { label: 'Liq. buffer', value: formatPercent(buffer), hint: 'headroom before seizure' },
              { label: 'Term', value: `${durationDays}d`, hint: 'then 2-day grace period' },
            ].map(({ label, value, hint }) => (
              <div key={label}>
                <p className="text-[10px] text-slate-600">{label}</p>
                <p className="text-sm font-mono font-bold text-white">{value}</p>
                <p className="text-[10px] text-slate-700 leading-tight">{hint}</p>
              </div>
            ))}
          </div>

          {/* what protects the lender */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              {hasPosition ? 'Your protection' : "This loan's collateralisation"}
            </p>

            <ul className="space-y-1.5 text-[11px] text-slate-500">
              <li className="flex gap-2">
                <span className="text-emerald-400">•</span>
                <span>
                  <span className="text-slate-300 font-bold">Over-collateralised.</span>{' '}
                  {hasPosition && myCollateralUsd !== null && myPrincipalUsd !== null ? (
                    <>
                      Your share: {formatUsd(myCollateralUsd)} of collateral secures your {formatUsd(myPrincipalUsd)} contribution
                      {myCollateralUsd > 0 && (
                        <> - {formatPercent(myCollateralUsd / myPrincipalUsd - 1)} more than you put in</>
                      )}
                      . (Loan total: {formatUsd(collateralUsd ?? 0)} collateral against {formatUsd(principalUsd ?? 0)} principal.)
                    </>
                  ) : collateralUsd !== null && principalUsd !== null ? (
                    <>
                      This loan has {formatUsd(collateralUsd)} locked against {formatUsd(principalUsd)} principal
                      {collateralUsd > 0 && (
                        <> - {formatPercent(collateralUsd / principalUsd - 1)} more than the loan</>
                      )}.
                    </>
                  ) : (
                    <>Collateral is locked in the vault before the loan is listed.</>
                  )}{' '}
                  It&apos;s held by CollateralVault, not the borrower.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">•</span>
                <span>
                  <span className="text-slate-300 font-bold">Liquidation at {formatPercent(threshold)} LTV.</span>{' '}
                  {dropToLiquidation !== null ? (
                    <>ETH would have to fall <span className="font-mono text-amber-400">{formatPercent(dropToLiquidation)}</span> from
                    today&apos;s price before any contributor can trigger liquidation{hasPosition ? ' and recover your pro-rata share' : ''}.</>
                  ) : (
                    <>Triggered when collateral value falls far enough against the debt.</>
                  )}
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">•</span>
                <span>
                  <span className="text-slate-300 font-bold">Missed deadline.</span>{' '}
                  If they haven&apos;t repaid {durationDays} days after funding, plus a 2-day grace
                  period, any contributor to the pool{hasPosition ? ' - including you' : ''} can trigger
                  liquidation regardless of price; proceeds split pro-rata across every contributor.
                </span>
              </li>
            </ul>
          </div>

          {/* what can go wrong */}
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-1.5">
            <p className="text-[10px] font-bold text-amber-400/90 uppercase tracking-widest">What can go wrong</p>
            <ul className="space-y-1 text-[11px] text-amber-400/70">
              <li>
                Liquidation is <span className="font-bold">not automatic</span> - any contributor has to
                call it themselves. Nothing seizes the collateral automatically on anyone&apos;s behalf.
              </li>
              <li>
                Liquidation recovers <span className="font-bold">only what is owed</span> - the
                surplus collateral returns to the borrower, so it makes the pool whole rather than
                paying out the full deposit
                {hasPosition ? ', and your own recovery is capped at your pro-rata share' : ''}.
                {hasPosition && myCollateralAtThreshold !== null ? (
                  <> At the threshold your share of the collateral is worth about {formatUsd(myCollateralAtThreshold)}.</>
                ) : collateralAtThreshold !== null ? (
                  <> At the threshold the loan&apos;s collateral is worth about {formatUsd(collateralAtThreshold)}.</>
                ) : null}
              </li>
              <li>
                A crash faster than you react can still leave the collateral worth less than the
                debt, in which case you recover only what is there.
              </li>
              <li>
                The borrower may repay <span className="font-bold">partially</span>, so your capital can
                come back in instalments rather than one payment.
              </li>
              <li>
                Price comes from a <span className="font-bold">mock oracle</span> on testnet. If it fails,
                price-based liquidation is disabled by design — the deadline path still works.
              </li>
            </ul>
          </div>

          {/* Feature-level reasoning, when the borrower's assessment was captured */}
          {assessment && assessment.contributions?.length > 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                  How the score was reached
                </p>
                <p className="text-[10px] font-mono text-slate-500">
                  score <span className="text-slate-300 font-bold">{assessment.overallScore.toFixed(3)}</span>
                  <span className="text-slate-700"> / 1.000</span>
                </p>
              </div>

              <p className="text-[10px] text-slate-500">
                {assessment.modelVersion
                  ? <>Scored by ML model <span className="font-mono text-slate-400">{assessment.modelVersion}</span> (LightGBM + SHAP)</>
                  : <>Scored by the rule-based explainable scorer</>}
              </p>

              {assessment.termSheetCid && assessment.termSheetHash && (
                <div className="mt-2 rounded-lg border border-slate-700/60 bg-slate-900/40 p-2.5 space-y-1.5">
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Term sheet anchored on IPFS</p>
                  <p className="text-[10px] text-slate-500 break-all">
                    <a
                      href={`${PINATA_GATEWAY}${assessment.termSheetCid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline font-mono"
                    >
                      {assessment.termSheetCid}
                    </a>
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={verifyTermSheet}
                      disabled={verifyState === 'checking'}
                      className="rounded-md border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {verifyState === 'checking' ? 'Verifying…' : 'Verify hash & signer'}
                    </button>
                    {verifyState === 'verified' && (
                      <span className="text-[10px] font-semibold text-emerald-400">Verified: hash and borrower signature match</span>
                    )}
                    {verifyState === 'mismatch' && (
                      <span className="text-[10px] font-semibold text-red-400">Mismatch</span>
                    )}
                    {verifyState === 'error' && (
                      <span className="text-[10px] font-semibold text-amber-400">Gateway unreachable</span>
                    )}
                  </div>
                  {verifyDetail && <p className="text-[10px] text-slate-500">{verifyDetail}</p>}
                </div>
              )}

              <div className="space-y-1">
                {[...assessment.contributions]
                  .sort((a, b) => b.weight - a.weight)
                  .map((c) => {
                    // score is -1 (worst) .. +1 (best); render as a centred bar
                    const pct = Math.min(100, Math.abs(c.score) * 50);
                    const good = c.score >= 0;
                    return (
                      <div key={c.feature} className="grid grid-cols-[1fr_auto_64px] items-center gap-2">
                        <div className="min-w-0">
                          <p className="text-[11px] text-slate-300 truncate" title={c.description}>
                            {c.feature}
                          </p>
                          <p className="text-[10px] text-slate-600 truncate">{c.value}</p>
                        </div>
                        <span className="text-[10px] font-mono text-slate-600">
                          {formatPercent(c.weight)}
                        </span>
                        <div className="relative h-1.5 w-16 rounded-full bg-slate-800 overflow-hidden">
                          <div className="absolute left-1/2 top-0 h-full w-px bg-slate-700" />
                          <div
                            className={`absolute top-0 h-full ${good ? 'bg-emerald-500' : 'bg-red-500'}`}
                            style={
                              good
                                ? { left: '50%', width: `${pct}%` }
                                : { right: '50%', width: `${pct}%` }
                            }
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>

              <p className="text-[10px] text-slate-700 leading-relaxed">
                Weight = how much each signal counts toward the score (all sum to 100%). Green pushes
                toward Tier A, red toward Tier C.
                {assessment.source === 'persona' && (
                  <> Assessed from a <span className="text-amber-500/80">demo persona</span>, not a real wallet.</>
                )}
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-slate-700 leading-relaxed">
              Tier is derived from this loan&apos;s on-chain terms. No feature-level assessment was
              captured for it — loans created before this was added won&apos;t have one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
