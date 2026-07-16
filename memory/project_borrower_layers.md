---
name: project-borrower-layers
description: Three-layer borrower architecture implemented for NexusFi P2P lending platform — synthetic personas, XAI risk engine, full transparency UI, repay/cancel Layer 3 execution
metadata:
  type: project
---

Three-layer borrower architecture fully implemented with full transparency.

**Layer 1** — `frontend/lib/borrower-personas.ts`: Alice (Tier A), Charlie (Tier B), Bob (Tier C) synthetic profiles with simulated on-chain features + off-chain metadata.

**Layer 2** — `frontend/lib/risk-explainer.ts`: SHAP-like XAI scoring engine. 8 features with explicit weights (sum to 1.0). Exports: `FEATURE_WEIGHTS`, `FEATURE_SCORING_GUIDE` (all breakpoints per feature), `TIER_THRESHOLDS` ({A: 0.40, B: 0.00}). Each `FeatureContribution` carries its `weight` field. API at `/api/risk/score`.

**Transparency UI** — `frontend/components/RiskExplanationPanel.tsx`: shows weight%, numeric score, bar, tier boundary formula (score = Σ(feature × weight)), and collapsible per-feature threshold table. `frontend/components/TermTransparencyPanel.tsx`: all-tier parameter comparison table (A/B/C × maxLTV/spread/haircut/buffer) + 6-step formula derivation for the current request, including on-chain formula note. Wired into right column of page.tsx borrower workspace.

**Layer 3 execution** — `frontend/app/page.tsx` extended LOAN_ABI with `repay()`, `cancel()`, `totalRepaymentDue()`, `interestDue()`. Borrower "Your loan" panel shows full loan details, on-chain interest formula, and action buttons: Cancel (Requested) returns collateral; Repay (Funded) sends exact wei from contract to release collateral. Refetch effects update status after each tx.

**effectiveTier pattern** — `effectiveTier = personaExplanation?.tier ?? riskAssignment?.tier` drives both `termSheet` and `termsMetricHelper`. DEMO badge when persona active.

**Why:** Testnet wallets have no real on-chain history; personas provide realistic risk input. Transparency is a core platform principle — every parameter, formula, and score is exposed in the UI.

**How to apply:** When adding new features, maintain transparency: every computed value should trace to a visible formula. The right column always shows TermTransparencyPanel when a term sheet exists.

**Env setup:** `frontend/.env.example` and `contracts/.env.example` document all required vars. Copy to `.env.local` and fill in deployed contract addresses.
