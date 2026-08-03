"""
LightGBM inference + SHAP explanations for the NexusFi credit scorer.

Usage:
    scorer = CreditScorer()                    # loads from artifacts/
    tier, conf, shap_vals = scorer.score(fv)   # fv = 10-element list
"""

from __future__ import annotations
import os
from typing import Optional

import numpy as np
import joblib

from .features import FEATURE_NAMES, FEATURE_LABELS, feature_value_label

ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")


class CreditScorer:
    _instance: Optional["CreditScorer"] = None

    def __init__(self) -> None:
        model_path = os.path.join(ARTIFACTS_DIR, "credit_model.pkl")
        label_path = os.path.join(ARTIFACTS_DIR, "label_map.pkl")
        # Artifacts are produced by train.py and are not in the repo, so a fresh
        # checkout has no model. Readiness is decided here, once, and drives the
        # fallback path in score() instead of raising on the first request.
        self._ready = os.path.exists(model_path) and os.path.exists(label_path)

        if self._ready:
            self._model    = joblib.load(model_path)
            self._labels   = joblib.load(label_path)   # {0:'A', 1:'B', 2:'C'}
            # shap is optional: without it the model still scores, it just cannot
            # attribute. Losing explanations is worth less than losing the endpoint.
            try:
                import shap
                self._explainer = shap.TreeExplainer(self._model)
            except Exception:
                self._explainer = None
        else:
            self._model    = None
            self._labels   = {0: "A", 1: "B", 2: "C"}
            self._explainer = None

    # Process-wide singleton. Unpickling the booster and building the TreeExplainer
    # are the expensive part of a score; doing it per request would dominate the
    # response time and defeat the point of keeping the service warm.
    @classmethod
    def get(cls) -> "CreditScorer":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def ready(self) -> bool:
        return self._ready

    def score(
        self,
        feature_vector: list[float],
        feature_values_raw: dict[str, str] | None = None,
    ) -> dict:
        """
        Score a borrower.

        Returns a dict with:
          tier, overall_score, confidence, shap_values (per feature), fallback_used
        """
        fv = np.array([feature_vector], dtype=np.float32)

        if self._ready and self._model is not None:
            proba = self._model.predict(fv)[0]        # shape (3,)
            pred_class = int(np.argmax(proba))
            confidence = float(proba[pred_class])
            tier       = self._labels[pred_class]

            # Normalise probability to a [-1, 1] score:
            # P(A) pulls toward +1, P(C) pulls toward -1
            overall_score = float(proba[0] - proba[2])

            # SHAP — per-class values for the predicted class
            # Attribution is taken for the class actually predicted, not a fixed one:
            # the features that argue for tier C are not the negation of those that
            # argue for tier A, so explaining the wrong class would be misleading.
            shap_vals = [0.0] * len(FEATURE_NAMES)
            if self._explainer is not None:
                try:
                    sv = self._explainer.shap_values(fv)  # list of (1, 10) arrays
                    class_sv = sv[pred_class][0]           # (10,)
                    shap_vals = [float(v) for v in class_sv]
                except Exception:
                    # Zeroed contributions rather than a failed score. The tier is
                    # the answer the caller needs; the breakdown is supporting detail.
                    pass

            fallback_used = False

        else:
            # Rule-based fallback (no trained model)
            tier, overall_score, confidence, shap_vals = _rule_based_fallback(feature_vector)
            fallback_used = True

        contributions = []
        for i, name in enumerate(FEATURE_NAMES):
            raw_val = feature_values_raw.get(name, "") if feature_values_raw else ""
            if not raw_val:
                raw_val = feature_value_label(name, feature_vector[i])

            # Nominal weight for display (equal weight for verified on-chain features,
            # lower for credibility-adjusted off-chain)
            nominal_weight = _NOMINAL_WEIGHTS.get(name, 0.10)

            contributions.append({
                "feature":   FEATURE_LABELS.get(name, name),
                "raw_name":  name,
                "category":  _FEATURE_CATEGORIES[name],
                "source":    _FEATURE_SOURCES[name],
                "value":     raw_val,
                "score":     round(float(feature_vector[i]), 4),
                "weight":    nominal_weight,
                "shap_value": round(shap_vals[i], 5),
            })

        return {
            "tier":          tier,
            "overall_score": round(overall_score, 4),
            "confidence":    round(confidence, 4),
            "contributions": contributions,
            "fallback_used": fallback_used,
        }


# ─── Feature metadata ─────────────────────────────────────────────────────────

_FEATURE_CATEGORIES: dict[str, str] = {
    "wallet_age_days":     "on-chain",
    "tx_count":            "on-chain",
    "protocols_count":     "on-chain",
    "log_balance_usd":     "on-chain",
    "mixer_detected":      "on-chain",
    "defi_repaid":         "on-chain",
    "defi_liquidations":   "on-chain",
    "income_adjusted":     "off-chain",
    "employment_adjusted": "off-chain",
    "dishonesty_penalty":  "integrity",
}

_FEATURE_SOURCES: dict[str, str] = {
    "wallet_age_days":     "verified",
    "tx_count":            "verified",
    "protocols_count":     "verified",
    "log_balance_usd":     "verified",
    "mixer_detected":      "verified",
    "defi_repaid":         "verified",
    "defi_liquidations":   "verified",
    "income_adjusted":     "claimed+verified",
    "employment_adjusted": "claimed+verified",
    "dishonesty_penalty":  "claimed+verified",
}

# Display weights only. The trained model never sees these: a gradient-boosted tree
# has no per-feature coefficient, so SHAP is what actually explains a prediction.
# These exist so the UI can show a stable "how much does this feature normally
# matter" figure next to the per-borrower attribution, and the rule-based fallback
# below reuses them as real weights because it does need coefficients.
_NOMINAL_WEIGHTS: dict[str, float] = {
    "wallet_age_days":     0.15,
    "tx_count":            0.10,
    "protocols_count":     0.10,
    "log_balance_usd":     0.10,
    "mixer_detected":      0.15,
    "defi_repaid":         0.15,
    "defi_liquidations":   0.10,
    "income_adjusted":     0.08,
    "employment_adjusted": 0.04,
    "dishonesty_penalty":  0.03,
}


# ─── Rule-based fallback (when model not yet trained) ─────────────────────────

def _rule_based_fallback(fv: list[float]) -> tuple[str, float, float, list[float]]:
    """
    Simple weighted scoring that mirrors the TypeScript scoring logic.
    Returns (tier, overall_score, confidence, shap_approx).
    """
    age, txs, proto, log_bal, mixer, repaid, liq, inc, emp, dis = fv

    def s_age(d: float) -> float:
        return 0.80 if d >= 365 else 0.30 if d >= 90 else -0.60

    def s_txs(t: float) -> float:
        return 0.70 if t >= 200 else 0.40 if t >= 50 else 0.00 if t >= 10 else -0.50

    def s_proto(p: float) -> float:
        return 0.60 if p >= 5 else 0.20 if p >= 2 else -0.30

    def s_bal(lb: float) -> float:
        usd = 10 ** lb - 1
        return 0.70 if usd >= 20_000 else 0.40 if usd >= 5_000 else 0.10 if usd >= 1_000 else -0.40

    def s_mixer(m: float) -> float:
        return -1.0 if m else 0.30

    def s_repaid(r: float) -> float:
        return 0.90 if r >= 2 else 0.50 if r >= 1 else -0.20

    def s_liq(l: float) -> float:
        return -0.80 if l > 0 else 0.20

    # Positional zip against the weights dict, which only lines up because
    # _NOMINAL_WEIGHTS is declared in FEATURE_NAMES order. Reordering either one
    # silently mis-weights every feature rather than raising.
    weights = list(_NOMINAL_WEIGHTS.values())
    raw_scores = [
        s_age(age), s_txs(txs), s_proto(proto), s_bal(log_bal),
        s_mixer(mixer), s_repaid(repaid), s_liq(liq),
        # Income and employment arrive already credibility-adjusted and already on
        # [-1, 1], so they pass through. Dishonesty is negated: the feature counts
        # up toward deception while the score counts up toward creditworthiness.
        inc, emp, -dis,
    ]
    overall = sum(w * s for w, s in zip(weights, raw_scores))
    overall = max(-1.0, min(1.0, overall))

    # Same cutoffs as the browser-side scorer in lib/risk-explainer.ts, so a borrower
    # who sees tier B in persona mode is not handed a different tier by this path.
    if overall >= 0.40:
        tier, conf = "A", 0.75
    elif overall >= 0.00:
        tier, conf = "B", 0.65
    else:
        tier, conf = "C", 0.70

    # Not real SHAP values, just each feature's share of the weighted sum. They have
    # the same additive shape, so the UI renders both paths with one component.
    shap_approx = [w * s for w, s in zip(weights, raw_scores)]
    return tier, overall, conf, shap_approx
