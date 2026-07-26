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
import type { RiskTier } from '../lib/loan-terms';
import { RISK_TIER_CONFIG, BASE_APR } from '../lib/loan-terms';
import { formatPercent, formatUsd } from '../lib/format';
import { ShieldCheck, ChevronDown, AlertTriangle } from 'lucide-react';

type Props = {
  tier: RiskTier | null;
  maxLtvBps: number;
  liquidationBufferBps: number;
  interestBps: number;
  durationDays: number;
  /** Live LTV from the contract (0–1). null when the oracle is unavailable. */
  currentLtv: number | null;
  collateralUsd: number | null;
  principalUsd: number | null;
  /** Contract's own view — the authoritative gate. */
  isLiquidatable?: boolean;
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
  isLiquidatable,
}: Props) {
  const [open, setOpen] = useState(false);

  const cfg = tier ? RISK_TIER_CONFIG[tier] : null;
  const maxLtv = maxLtvBps / 10_000;
  const buffer = liquidationBufferBps / 10_000;
  const threshold = maxLtv + buffer;
  const apr = interestBps / 10_000;

  // How far ETH can fall before this position becomes liquidatable. Debt is
  // frozen in USD at funding, so LTV scales inversely with price:
  // liquidation at  currentLtv / threshold  of today's price.
  const dropToLiquidation =
    currentLtv !== null && currentLtv > 0 && threshold > 0
      ? Math.max(0, 1 - currentLtv / threshold)
      : null;

  // What the lender recovers at the moment of liquidation, before gas.
  const collateralAtThreshold =
    principalUsd !== null && threshold > 0 ? principalUsd / threshold : null;

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
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Your protection</p>

            <ul className="space-y-1.5 text-[11px] text-slate-500">
              <li className="flex gap-2">
                <span className="text-emerald-400">•</span>
                <span>
                  <span className="text-slate-300 font-bold">Over-collateralised.</span>{' '}
                  {collateralUsd !== null && principalUsd !== null ? (
                    <>
                      {formatUsd(collateralUsd)} locked against {formatUsd(principalUsd)} lent
                      {collateralUsd > 0 && (
                        <> — {formatPercent(collateralUsd / principalUsd - 1)} more than the loan</>
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
                    today&apos;s price before you can seize the collateral.</>
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
                  period, you can liquidate regardless of price.
                </span>
              </li>
            </ul>
          </div>

          {/* what can go wrong */}
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-1.5">
            <p className="text-[10px] font-bold text-amber-400/90 uppercase tracking-widest">What can go wrong</p>
            <ul className="space-y-1 text-[11px] text-amber-400/70">
              <li>
                Liquidation is <span className="font-bold">not automatic</span> — you have to call it.
                Nothing seizes the collateral on your behalf.
              </li>
              <li>
                A crash faster than you react can leave collateral worth less than the debt.
                {collateralAtThreshold !== null && (
                  <> At the threshold it&apos;s worth about {formatUsd(collateralAtThreshold)}.</>
                )}
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

          <p className="text-[10px] text-slate-700 leading-relaxed">
            Tier is derived from the loan&apos;s on-chain terms. The borrower&apos;s feature-level risk
            breakdown is generated at request time and isn&apos;t stored on-chain yet, so it can&apos;t be
            shown here.
          </p>
        </div>
      )}
    </div>
  );
}
