"""
POST /credit/score

Full pipeline:
  1. Fetch on-chain data (mainnet + Sepolia) via Alchemy
  2. Compute off-chain credibility scores
  3. Build feature vector
  4. LightGBM inference + SHAP
  5. Return tier, score, contributions, and warnings
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException
import httpx

from ..schemas.credit import ScoreRequest, ScoreResponse, OnChainData, ClaimCredibility, FeatureContribution
from ..services.chain_fetcher import fetch_wallet_data
from ..services.believability import (
    income_credibility,
    employment_credibility,
    mixer_claim_status,
    defi_claim_status,
    dishonesty_penalty,
)
from ..ml.features import build_feature_vector, feature_value_label, FEATURE_LABELS
from ..ml.model import CreditScorer

router = APIRouter(prefix="/credit", tags=["credit"])


@router.post("/score", response_model=ScoreResponse)
async def score_borrower(req: ScoreRequest) -> ScoreResponse:
    wallet = req.wallet_address
    eth_price = req.eth_price_usd
    oc = req.off_chain

    # ── 1. Fetch on-chain data ────────────────────────────────────────────────
    try:
        chain = await fetch_wallet_data(wallet, eth_price)
    except (httpx.HTTPError, Exception) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Chain data fetch failed: {exc!s}",
        )

    on_chain = OnChainData(
        wallet_age_days        = chain["wallet_age_days"],
        tx_count               = chain["tx_count"],
        protocols_count        = chain["protocols_count"],
        balance_eth            = chain["balance_eth"],
        balance_usd            = chain["balance_usd"],
        mixer_detected         = chain["mixer_detected"],
        defi_repaid            = chain["defi_repaid"],
        defi_liquidations      = chain["defi_liquidations"],
        platform_loans_repaid  = chain["platform_loans_repaid"],
        platform_loans_defaulted = chain["platform_loans_defaulted"],
    )

    # ── 2. Credibility scoring ────────────────────────────────────────────────
    inc_prob = income_credibility(
        oc.income_band,
        chain["balance_usd"],
        chain["tx_count"],
        chain["wallet_age_days"],
    )
    emp_prob = employment_credibility(
        oc.employment_type,
        chain["balance_usd"],
        chain["tx_count"],
        chain["wallet_age_days"],
    )
    mixer_match, mixer_lie = mixer_claim_status(
        oc.claimed_no_mixer,
        chain["mixer_detected"],
    )
    defi_match, defi_lie = defi_claim_status(
        oc.defi_loans.taken,
        oc.defi_loans.repaid,
        oc.defi_loans.liquidations,
        chain["defi_repaid"],
        chain["defi_liquidations"],
    )
    dis_penalty = dishonesty_penalty(mixer_lie, defi_lie)

    credibility = ClaimCredibility(
        income_probability        = inc_prob,
        employment_probability    = emp_prob,
        mixer_claim_matches_chain = mixer_match,
        defi_claim_matches_chain  = defi_match,
        dishonesty_detected       = mixer_lie or defi_lie,
    )

    # ── 3. Build feature vector ───────────────────────────────────────────────
    fv = build_feature_vector(
        wallet_age_days       = chain["wallet_age_days"],
        tx_count              = chain["tx_count"],
        protocols_count       = chain["protocols_count"],
        balance_usd           = chain["balance_usd"],
        mixer_detected        = chain["mixer_detected"],
        defi_repaid           = chain["defi_repaid"],
        defi_liquidations     = chain["defi_liquidations"],
        platform_loans_repaid = chain["platform_loans_repaid"],
        income_band           = oc.income_band,
        employment_type       = oc.employment_type,
        income_prob           = inc_prob,
        employment_prob       = emp_prob,
        dishonesty            = dis_penalty,
    )

    # ── 4. Score ──────────────────────────────────────────────────────────────
    scorer = CreditScorer.get()
    result = scorer.score(fv)

    # ── 5. Build response contributions ──────────────────────────────────────
    contributions = [
        FeatureContribution(
            feature   = c["feature"],
            category  = c["category"],
            source    = c["source"],
            value     = c["value"],
            score     = c["score"],
            weight    = c["weight"],
            shap_value = c["shap_value"],
        )
        for c in result["contributions"]
    ]

    # ── 6. Warnings ───────────────────────────────────────────────────────────
    warnings: list[str] = []
    if chain["wallet_age_days"] == 0:
        warnings.append("No mainnet transaction history found — wallet scored as new.")
    if mixer_lie:
        warnings.append("Mixer claim contradicts on-chain data — Tornado Cash interactions detected.")
    if defi_lie:
        warnings.append("DeFi loan claim does not match verified on-chain history.")
    if result["fallback_used"]:
        warnings.append("ML model not yet trained — rule-based scoring used. Run python -m app.ml.train.")
    if chain["defi_liquidations"] > 0:
        warnings.append(f"{chain['defi_liquidations']} prior liquidation(s) detected on Aave V3.")
    if chain["platform_loans_defaulted"] > 0:
        warnings.append(
            f"{chain['platform_loans_defaulted']} NexusFi platform loan(s) appear unfunded or defaulted."
        )

    return ScoreResponse(
        tier          = result["tier"],
        overall_score = result["overall_score"],
        confidence    = result["confidence"],
        on_chain      = on_chain,
        credibility   = credibility,
        contributions = contributions,
        warnings      = warnings,
        fallback_used = result["fallback_used"],
    )
