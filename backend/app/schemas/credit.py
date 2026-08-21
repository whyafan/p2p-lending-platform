from __future__ import annotations
from pydantic import BaseModel, field_validator
from typing import Literal


class DeFiLoans(BaseModel):
    taken: int = 0
    repaid: int = 0
    liquidations: int = 0


class OffChainClaims(BaseModel):
    employment_type: Literal["full-time", "self-employed", "freelance", "student"]
    income_band: Literal["<30k", "30k-50k", "50k-100k", ">100k"]
    claimed_no_mixer: bool = True   # True = "I have never used a mixer"
    defi_loans: DeFiLoans = DeFiLoans()


class ScoreRequest(BaseModel):
    wallet_address: str
    eth_price_usd: float = 2500.0
    off_chain: OffChainClaims

    @field_validator("wallet_address")
    @classmethod
    def normalise_address(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith("0x") or len(v) != 42:
            raise ValueError("wallet_address must be a 42-character hex string starting with 0x")
        return v.lower()


class OnChainData(BaseModel):
    wallet_age_days: int
    tx_count: int
    protocols_count: int
    balance_eth: float
    balance_usd: float
    mixer_detected: bool
    # Mainnet Aave / Compound verified
    defi_repaid: int
    defi_liquidations: int
    # NexusFi Sepolia platform history
    platform_loans_repaid: int
    platform_loans_defaulted: int
    data_source: str = "mainnet+sepolia"


class ClaimCredibility(BaseModel):
    income_probability: float       # P(income claim is true | on-chain signals)
    employment_probability: float   # P(employment claim is true | behavior)
    mixer_claim_matches_chain: bool # claim == on-chain reality
    defi_claim_matches_chain: bool  # claimed history ≈ verified history
    dishonesty_detected: bool       # True if claim explicitly contradicts chain


class FeatureContribution(BaseModel):
    feature: str
    category: Literal["on-chain", "off-chain", "integrity"]
    source: Literal["verified", "claimed+verified", "modeled"]
    value: str
    score: float        # raw score before SHAP [-1, 1]
    weight: float       # nominal feature weight
    shap_value: float   # SHAP additive contribution to log-odds


class ScoreResponse(BaseModel):
    tier: Literal["A", "B", "C"]
    overall_score: float    # normalised to [-1, 1] from model probability
    confidence: float       # max class probability [0, 1]
    on_chain: OnChainData
    credibility: ClaimCredibility
    contributions: list[FeatureContribution]
    warnings: list[str]
    fallback_used: bool = False
    model_version: str | None = None   # content-hash version of the scoring model; None = rule-based fallback
