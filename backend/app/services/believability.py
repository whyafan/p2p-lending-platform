"""
Believability / credibility model for off-chain claims.

For each off-chain input we compute P(claim_true | on-chain_signals).

Income band:
  On-chain proxy = balance_usd.  Expected crypto savings ≈ 15-25% of annual
  income.  We use a sigmoid centred at the expected savings ratio so that
  a wallet that actually holds the money to back its income claim scores near 1,
  while a wallet claiming $150k/yr with $500 in ETH scores near 0.15.

Employment type:
  Harder to verify directly. We use wallet activity level (tx_count, age) as a
  behavioural proxy.  Full-time employees tend to have steady, moderate usage.
  Base confidence is set conservatively because employment is the weakest signal;
  it is down-weighted slightly in the feature vector accordingly.

Mixer & DeFi loan claims:
  These are directly verifiable on-chain (chain_fetcher already fetched the
  truth).  We compare claim vs chain reality and return a boolean match plus
  a dishonesty_detected flag — lying here carries a heavy model penalty.
"""

from __future__ import annotations
import math


# ─── Income band credibility ──────────────────────────────────────────────────

_INCOME_MIDPOINTS: dict[str, float] = {
    "<30k":      20_000,
    "30k-50k":   40_000,
    "50k-100k":  75_000,
    ">100k":    150_000,
}

def income_credibility(
    claimed_band: str,
    balance_usd: float,
    tx_count: int,
    wallet_age_days: int,
) -> float:
    """
    P(income claim is true | on-chain wealth signals).

    Logic:
      - Expected crypto holding ≈ 20% of annual income (rough rule-of-thumb).
      - Compute ratio: actual_balance / expected_savings.
      - Map through a sigmoid so ratio=1 → ~0.73, ratio=0.1 → ~0.15, ratio=3 → ~0.90.
      - Activity bonus: high tx_count or long wallet age add up to +0.08.
      - People rarely lie *downward* (claiming <$30k when rich), so that gets
        a credibility floor of 0.70.
    """
    midpoint = _INCOME_MIDPOINTS.get(claimed_band, 75_000)
    expected_savings = midpoint * 0.20

    ratio = balance_usd / (expected_savings + 1e-6)

    # Sigmoid: centred at ratio=0.5 so that holding half the expected savings
    # gives ~0.5 probability.
    base_prob = 1.0 / (1.0 + math.exp(-3.0 * (ratio - 0.5)))

    # Activity proxy — busy wallet suggests financial engagement
    activity = min(tx_count / 300.0, 1.0) * 0.05
    age_bonus = min(wallet_age_days / 730.0, 1.0) * 0.03

    prob = base_prob + activity + age_bonus

    # People almost never lie downward (claim less income than they have)
    if claimed_band == "<30k":
        prob = max(prob, 0.70)

    return round(min(0.95, max(0.10, prob)), 3)


# ─── Employment type credibility ──────────────────────────────────────────────

def employment_credibility(
    employment_type: str,
    balance_usd: float,
    tx_count: int,
    wallet_age_days: int,
) -> float:
    """
    P(employment claim is true | behavioral proxy signals).

    No direct on-chain proof exists, so we use conservative baseline credibilities
    adjusted by how well the on-chain behavior matches the claimed employment:
      - Full-time workers tend to have steady wallets with moderate activity.
      - Students tend to have lower balances; if balance is high, claim is suspicious.
      - Self-employed / freelance are hard to distinguish; moderate confidence.
    """
    base: dict[str, float] = {
        "full-time":     0.65,
        "self-employed": 0.60,
        "freelance":     0.60,
        "student":       0.70,   # students rarely lie about being students
    }
    prob = base.get(employment_type, 0.60)

    # Adjust for balance consistency
    if employment_type == "student" and balance_usd > 30_000:
        # Rich students exist but are less common — slight credibility drop
        prob -= 0.10
    elif employment_type == "full-time" and balance_usd > 10_000:
        # Matches expected savings pattern
        prob += 0.07
    elif employment_type in ("self-employed", "freelance") and tx_count > 100:
        # High activity consistent with running a business
        prob += 0.05

    # Wallet age signals: employed people tend to have older wallets
    if wallet_age_days > 365:
        prob += 0.03

    return round(min(0.90, max(0.40, prob)), 3)


# ─── Mixer & DeFi loan cross-validation ──────────────────────────────────────

def mixer_claim_status(
    claimed_no_mixer: bool,
    mixer_detected: bool,
) -> tuple[bool, bool]:
    """
    Returns (claim_matches_chain, dishonesty_detected).

    Dishonesty = claimed "no mixer" but chain shows mixer usage.
    (Admitting mixer use when there's none is unusual but not penalised.)
    """
    # Asymmetric on purpose: only the claim that hides real mixer activity counts as
    # dishonesty. The opposite direction still fails `matches`, so it shows in the
    # breakdown, but it carries no penalty because it costs the borrower to admit.
    matches = claimed_no_mixer == (not mixer_detected)
    dishonest = (claimed_no_mixer is True) and (mixer_detected is True)
    return matches, dishonest


def defi_claim_status(
    claimed_taken: int,
    claimed_repaid: int,
    claimed_liq: int,
    chain_repaid: int,
    chain_liq: int,
) -> tuple[bool, bool]:
    """
    Returns (claim_matches_chain, dishonesty_detected).

    We compare claimed_repaid vs chain_repaid and claimed_liq vs chain_liq.
    Overclaiming repayments or underclaiming liquidations = dishonesty.
    """
    # Allow small tolerance (+/-1) for honest approximation
    # The tolerance is not just leniency: chain_repaid only covers Aave V3 over the
    # last ~6 months, so a borrower recalling one extra loan is as likely to be right
    # as lying, and the penalty for a false positive here is a whole tier.
    repaid_ok = abs(claimed_repaid - chain_repaid) <= 1
    liq_ok    = abs(claimed_liq - chain_liq) <= 1
    matches   = repaid_ok and liq_ok

    # Dishonesty = overclaiming repayments OR underclaiming liquidations
    # Both directions are self-serving. Understating repayments or admitting extra
    # liquidations only hurts the claimant, so neither is treated as a lie.
    dishonest = (claimed_repaid > chain_repaid + 1) or (claimed_liq < chain_liq - 1)
    return matches, dishonest


# ─── Dishonesty penalty ───────────────────────────────────────────────────────

def dishonesty_penalty(mixer_lie: bool, defi_lie: bool) -> float:
    """
    Returns a [0, 1] penalty value fed into the model as an explicit feature.
    0.0 = fully honest, 1.0 = maximum detected deception.
    Mixer lies are weighted more heavily (compliance issue) than DeFi lies.
    """
    penalty = 0.0
    if mixer_lie:
        penalty += 0.70
    if defi_lie:
        penalty += 0.45
    # Additive then clamped, so lying about both saturates at 1.0. Either lie alone
    # leaves headroom; both together is treated as the worst case with no distinction
    # beyond that, since there is nothing further the model needs to know.
    return min(1.0, penalty)
