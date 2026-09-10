"""
Feature engineering: converts raw on-chain data + credibility scores into
a fixed-length numerical vector for the LightGBM credit model.

Feature vector (10 dimensions, in order):
  F0  wallet_age_days          — verified on-chain [0, 3000+]
  F1  tx_count                 — verified on-chain [0, 1000+]
  F2  protocols_count          — verified on-chain [0, 15]
  F3  log_balance_usd          — log10(balance_usd + 1) ≈ [0, 6]
  F4  mixer_detected           — verified on-chain {0, 1}
  F5  defi_repaid              — verified on-chain (mainnet Aave + platform) [0, 20]
  F6  defi_liquidations        — verified on-chain [0, 5]
  F7  income_adjusted          — income_band_score × credibility [-1, 1]
  F8  employment_adjusted      — employment_score × credibility [-1, 1]
  F9  dishonesty_penalty       — 0 = fully honest, 1 = lied about mixer/DeFi

Using log balance instead of raw USD normalises the 4-orders-of-magnitude
spread ($10 → $100k) without requiring explicit normalisation in the tree model.
"""

from __future__ import annotations
import math

FEATURE_NAMES = [
    "wallet_age_days",
    "tx_count",
    "protocols_count",
    "log_balance_usd",
    "mixer_detected",
    "defi_repaid",
    "defi_liquidations",
    "income_adjusted",
    "employment_adjusted",
    "dishonesty_penalty",
]

# Human-readable labels for the UI
FEATURE_LABELS: dict[str, str] = {
    "wallet_age_days":     "Wallet age",
    "tx_count":            "Transaction count",
    "protocols_count":     "DeFi breadth",
    "log_balance_usd":     "Wallet balance",
    "mixer_detected":      "Mixer interaction",
    "defi_repaid":         "DeFi repayment history",
    "defi_liquidations":   "Prior liquidations",
    "income_adjusted":     "Income (credibility-adjusted)",
    "employment_adjusted": "Employment (credibility-adjusted)",
    "dishonesty_penalty":  "Claim integrity",
}

# Score mappings for income band and employment type (range -1 to +1)
_INCOME_SCORES: dict[str, float] = {
    "<30k":     -0.30,
    "30k-50k":   0.10,
    "50k-100k":  0.50,
    ">100k":     0.80,
}

_EMPLOYMENT_SCORES: dict[str, float] = {
    "full-time":     0.50,
    "self-employed": 0.20,
    "freelance":    -0.10,
    "student":      -0.20,
}


def build_feature_vector(
    *,
    # on-chain
    wallet_age_days: int,
    tx_count: int,
    protocols_count: int,
    balance_usd: float,
    mixer_detected: bool,
    defi_repaid: int,
    defi_liquidations: int,
    platform_loans_repaid: int,
    # off-chain claims
    income_band: str,
    employment_type: str,
    # credibility
    income_prob: float,
    employment_prob: float,
    dishonesty: float,
) -> list[float]:
    """Return a 10-element feature vector aligned with FEATURE_NAMES."""

    # Mainnet Aave repayments and NexusFi platform repayments collapse into one
    # feature. The model has no reason to treat them differently, and splitting them
    # would leave the platform column at zero for almost every real borrower.
    total_repaid = defi_repaid + platform_loans_repaid

    # Claims are multiplied by their credibility rather than fed in raw, so an
    # unbacked income claim contributes proportionally less instead of being either
    # trusted outright or discarded. An unrecognised band scores 0, i.e. no signal.
    income_score       = _INCOME_SCORES.get(income_band, 0.0) * income_prob
    employment_score   = _EMPLOYMENT_SCORES.get(employment_type, 0.0) * employment_prob

    return [
        float(wallet_age_days),
        float(tx_count),
        float(protocols_count),
        # Floored at 1.0 so log10 is defined and an empty wallet lands on 0.0 rather
        # than negative infinity. train.py applies the identical transform.
        math.log10(max(balance_usd, 1.0)),
        float(int(mixer_detected)),
        float(total_repaid),
        float(defi_liquidations),
        income_score,
        employment_score,
        dishonesty,
    ]


def feature_value_label(name: str, value: float, balance_usd: float = 0) -> str:
    """Return a human-readable string for a feature value (for UI display)."""
    if name == "wallet_age_days":
        days = int(value)
        if days >= 365:
            return f"{days // 365}y {(days % 365) // 30}m"
        return f"{days} days"
    if name == "tx_count":
        return f"{int(value)} txs"
    if name == "protocols_count":
        return f"{int(value)} protocol{'s' if value != 1 else ''}"
    if name == "log_balance_usd":
        # Inverse of the log transform, so the UI shows the dollar figure the borrower
        # would recognise rather than the model's 4.7.
        usd = 10 ** value - 1
        return f"${usd:,.0f}"
    if name == "mixer_detected":
        return "Detected" if value else "None detected"
    if name == "defi_repaid":
        return f"{int(value)} repaid"
    if name == "defi_liquidations":
        return f"{int(value)} liquidation{'s' if value != 1 else ''}"
    if name in ("income_adjusted", "employment_adjusted"):
        return f"{value:+.3f} (credibility-adjusted)"
    if name == "dishonesty_penalty":
        if value == 0:
            return "Clean — no inconsistencies"
        return f"Penalty {value:.2f} — claim mismatch detected"
    return str(round(value, 4))
