'use client';

import { RISK_TIER_CONFIG, BASE_APR, type LoanTermSheet } from '../lib/loan-terms';
import { formatUsd, formatPercent } from '../lib/format';

type Props = {
  termSheet: LoanTermSheet;
  loanAmountUsd: number;
  tenorDays: number;
  ethUsdPrice: number;
};

const TIERS = ['A', 'B', 'C'] as const;

const TIER_HEADER: Record<string, string> = {
  A: 'text-emerald-700',
  B: 'text-amber-700',
  C: 'text-red-700',
};

function pct(n: number) {
  return `${(n * 100).toFixed(0)}%`;
}

function TierCell({ tier, activeTier, value }: { tier: string; activeTier: string; value: string }) {
  const isActive = tier === activeTier;
  return (
    <td className={`py-1.5 px-2 text-center text-xs font-mono ${isActive ? 'bg-blue-50 font-bold text-blue-800' : 'text-slate-700'}`}>
      {value}
    </td>
  );
}

function Row({ label, values, activeTier }: { label: string; values: string[]; activeTier: string }) {
  return (
    <tr className="border-b border-slate-50">
      <td className="py-1.5 pr-3 text-xs text-slate-600 font-medium whitespace-nowrap">{label}</td>
      {TIERS.map((t, i) => (
        <TierCell key={t} tier={t} activeTier={activeTier} value={values[i]} />
      ))}
    </tr>
  );
}

function Step({
  n,
  label,
  formula,
  detail,
  result,
}: {
  n: number;
  label: string;
  formula: string;
  detail?: string;
  result: string;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5 space-y-1">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-slate-700">{label}</p>
          <p className="text-[11px] font-mono text-slate-500 mt-0.5 break-words">{formula}</p>
          {detail && (
            <p className="text-[11px] font-mono text-slate-500 mt-0.5 break-words">{detail}</p>
          )}
          <p className="text-xs font-mono font-bold text-slate-800 mt-1">= {result}</p>
        </div>
      </div>
    </div>
  );
}

export function TermTransparencyPanel({ termSheet, loanAmountUsd, tenorDays, ethUsdPrice }: Props) {
  const t = termSheet.tierConfig;
  const tier = termSheet.riskTier;
  const collateralFactor = t.maxLtv * (1 - t.haircut);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        How terms are calculated
      </p>

      {/* ── all-tier comparison table ── */}
      <div>
        <p className="text-[11px] font-bold text-slate-600 mb-2 uppercase tracking-wide">
          All tier parameters
        </p>
        <div className="overflow-x-auto rounded-lg border border-slate-100">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="py-1.5 pr-3 pl-2 text-left text-[11px] font-semibold text-slate-400">
                  Parameter
                </th>
                {TIERS.map((tk) => (
                  <th
                    key={tk}
                    className={`py-1.5 px-2 text-center text-xs font-bold ${tk === tier ? 'bg-blue-50' : ''} ${TIER_HEADER[tk]}`}
                  >
                    Tier {tk}{tk === tier ? ' (active)' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white">
              <Row
                label="Max LTV"
                values={TIERS.map((tk) => pct(RISK_TIER_CONFIG[tk].maxLtv))}
                activeTier={tier}
              />
              <Row
                label="APR spread"
                values={TIERS.map((tk) => `+${pct(RISK_TIER_CONFIG[tk].aprSpread)}`)}
                activeTier={tier}
              />
              <Row
                label="Haircut"
                values={TIERS.map((tk) => pct(RISK_TIER_CONFIG[tk].haircut))}
                activeTier={tier}
              />
              <Row
                label="Liq. buffer"
                values={TIERS.map((tk) => pct(RISK_TIER_CONFIG[tk].liquidationBuffer))}
                activeTier={tier}
              />
              <Row
                label="Liq. threshold"
                values={TIERS.map((tk) =>
                  pct(RISK_TIER_CONFIG[tk].maxLtv + RISK_TIER_CONFIG[tk].liquidationBuffer)
                )}
                activeTier={tier}
              />
              <Row
                label="Final APR"
                values={TIERS.map((tk) =>
                  formatPercent(BASE_APR + RISK_TIER_CONFIG[tk].aprSpread)
                )}
                activeTier={tier}
              />
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[10px] text-slate-400">
          Base APR: {formatPercent(BASE_APR)} applied to all tiers before spread. (active) = your assigned tier.
        </p>
      </div>

      {/* ── step-by-step derivation ── */}
      <div>
        <p className="text-[11px] font-bold text-slate-600 mb-2 uppercase tracking-wide">
          Step-by-step for your request
        </p>
        <div className="space-y-2">
          <Step
            n={1}
            label="Final APR"
            formula={`base ${formatPercent(BASE_APR)} + ${tier} spread ${formatPercent(t.aprSpread)}`}
            result={formatPercent(termSheet.finalApr)}
          />
          <Step
            n={2}
            label="Required collateral"
            formula={`principal ÷ (maxLTV × (1 − haircut)) ÷ ETH price`}
            detail={`${formatUsd(loanAmountUsd)} ÷ (${pct(t.maxLtv)} × (1 − ${pct(t.haircut)})) ÷ ${formatUsd(ethUsdPrice, 0)}/ETH`}
            result={`${termSheet.requiredCollateralEth.toFixed(6)} ETH (= ${formatUsd(termSheet.requiredCollateralValueUsd)})`}
          />
          <Step
            n={3}
            label="Collateral factor"
            formula={`maxLTV × (1 − haircut) = ${pct(t.maxLtv)} × (1 − ${pct(t.haircut)})`}
            result={`${(collateralFactor * 100).toFixed(1)}%. Every $1 of adjusted collateral supports $${collateralFactor.toFixed(2)} borrowed.`}
          />
          <Step
            n={4}
            label="Interest due"
            formula={`principal × APR × (tenor ÷ 365)`}
            detail={`${formatUsd(loanAmountUsd)} × ${formatPercent(termSheet.finalApr)} × (${tenorDays} ÷ 365)`}
            result={formatUsd(termSheet.interestDueUsd)}
          />
          <Step
            n={5}
            label="Total repayment"
            formula={`principal + interest`}
            detail={`${formatUsd(loanAmountUsd)} + ${formatUsd(termSheet.interestDueUsd)}`}
            result={formatUsd(termSheet.totalRepaymentUsd)}
          />
          <Step
            n={6}
            label="Liquidation threshold"
            formula={`maxLTV + liq. buffer = ${pct(t.maxLtv)} + ${pct(t.liquidationBuffer)}`}
            result={`${pct(termSheet.liquidationThreshold)}. Lender may liquidate if collateral value falls below ${formatUsd(termSheet.liquidationCollateralValueUsd)}.`}
          />
        </div>
      </div>

      <p className="text-[10px] text-slate-400 border-t border-slate-100 pt-2">
        All values are computed off-chain for display. The loan contract enforces the same parameters
        on-chain using integer basis-point arithmetic (1 bps = 0.01%).
        Interest on-chain: <span className="font-mono">principal × interestBps × durationDays ÷ (10,000 × 365)</span>.
      </p>
    </div>
  );
}
