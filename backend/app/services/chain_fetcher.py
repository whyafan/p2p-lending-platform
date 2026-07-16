"""
On-chain data fetcher for credit scoring.

Queries:
  • Ethereum mainnet  — real DeFi history (wallet age, tx count, protocols,
                        balance, Aave V3 loans, Tornado Cash interactions)
  • Sepolia testnet   — NexusFi platform loan history (LoanCreated / LoanRepaid events)

All RPC calls go through the Alchemy JSON-RPC API (httpx async).
"""

from __future__ import annotations
import asyncio
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from eth_utils import keccak, to_checksum_address

# ─── Alchemy endpoints ────────────────────────────────────────────────────────

def _alchemy_url(network: str) -> str:
    if network == "sepolia":
        key = os.getenv("ALCHEMY_SEPOLIA_API_KEY") or os.getenv("ALCHEMY_API_KEY", "")
    else:
        key = os.getenv("ALCHEMY_API_KEY", "")
    base = {
        "mainnet": "https://eth-mainnet.g.alchemy.com/v2",
        "sepolia": "https://eth-sepolia.g.alchemy.com/v2",
    }[network]
    return f"{base}/{key}"

# ─── Known contract addresses (lowercase) ────────────────────────────────────

DEFI_PROTOCOLS: dict[str, str] = {
    "uniswap_v2_router":   "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
    "uniswap_v3_router":   "0xe592427a0aece92de3edee1f18e0157c05861564",
    "uniswap_v3_router2":  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
    "aave_v3_pool":        "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    "aave_v2_pool":        "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
    "compound_v3_usdc":    "0xc3d688b66703497daa19211eedff47f25384cdc3",
    "compound_v2_ctrl":    "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b",
    "curve_3pool":         "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
    "balancer_vault":      "0xba12222222228d8ba445958a75a0704d566bf2c8",
    "lido":                "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    "1inch_router":        "0x1111111254eeb25477b68fb85ed929f73a960582",
    "yearn_registry":      "0x50c1a2ea0a861a967d9d0ffe2ae4012c2e053804",
    "gmx_router":          "0xabbc5f99639c9b6bcb58544ddf04efa6802f4064",
    "synthetix":           "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f",
    "maker_proxy_actions": "0x82ecd135dce65fbc6dbdd0e4237e0af93ffd5038",
}
PROTOCOL_ADDRS: set[str] = set(DEFI_PROTOCOLS.values())

TORNADO_CASH_ADDRS: set[str] = {
    "0x722122df12d4e14e13ac3b6895a86e84145b6967",
    "0x12d66f87a04a9e220c9d1f2e6e0b3e5b6a2e9999",
    "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",
    "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
    "0xa160cdab225685da1d56aa342ad8841c3b53f291",
    "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
    "0x84443cfd09a48af6ef360c6976c5392ac5023a1f",
    "0xfd8610d20aa15b7b2e3be39b396a1bc3516c7144",
    "0x07687e702b410fa43f4cb4af7fa097918ffd2730",
}

AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"

# Aave V3 event topic0 hashes
# Repay(address indexed reserve, address indexed user, address indexed repayer, uint256, bool)
AAVE_REPAY_TOPIC   = "0x" + keccak(text="Repay(address,address,address,uint256,bool)").hex()
# LiquidationCall(address indexed, address indexed, address indexed user, uint256, uint256, address, bool)
AAVE_LIQ_TOPIC     = "0x" + keccak(text="LiquidationCall(address,address,address,uint256,uint256,address,bool)").hex()

# NexusFi LoanFactory on Sepolia
NEXUSFI_FACTORY = os.getenv(
    "NEXUSFI_FACTORY_SEPOLIA",
    "0xd4cfc809b885e7c197d3ca6878746881c78d2ce5",
).lower()

# LoanCreated(uint256 indexed loanId, address indexed borrower, address indexed loanContract, uint256, uint256)
LOAN_CREATED_TOPIC = "0x" + keccak(
    text="LoanCreated(uint256,address,address,uint256,uint256)"
).hex()
# LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 repaymentAmount)
LOAN_REPAID_TOPIC  = "0x" + keccak(text="LoanRepaid(uint256,address,uint256)").hex()


# ─── Low-level RPC helper ─────────────────────────────────────────────────────

async def _rpc(
    client: httpx.AsyncClient,
    url: str,
    method: str,
    params: list[Any],
) -> Any:
    resp = await client.post(
        url,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=15.0,
    )
    if not resp.is_success:
        body = resp.text[:400]
        raise RuntimeError(f"HTTP {resp.status_code} from Alchemy on '{method}': {body}")
    data = resp.json()
    if "error" in data:
        err = data["error"]
        raise RuntimeError(f"Alchemy RPC error on '{method}': {err.get('message', err)}")
    return data.get("result")


# ─── Individual fetchers ──────────────────────────────────────────────────────

async def _tx_count(client: httpx.AsyncClient, url: str, wallet: str) -> int:
    hex_val = await _rpc(client, url, "eth_getTransactionCount", [wallet, "latest"])
    return int(hex_val, 16) if hex_val else 0


async def _balance_eth(client: httpx.AsyncClient, url: str, wallet: str) -> float:
    hex_val = await _rpc(client, url, "eth_getBalance", [wallet, "latest"])
    return int(hex_val, 16) / 1e18 if hex_val else 0.0


async def _asset_transfers(
    client: httpx.AsyncClient,
    url: str,
    wallet: str,
    direction: str = "from",
    max_count: int = 200,
    order: str = "desc",
    with_metadata: bool = False,
) -> list[dict]:
    params: dict[str, Any] = {
        "category": ["external", "erc20", "internal"],
        "maxCount": hex(max_count),
        "order": order,
        "withMetadata": with_metadata,
    }
    if direction == "from":
        params["fromAddress"] = wallet
    else:
        params["toAddress"] = wallet

    result = await _rpc(client, url, "alchemy_getAssetTransfers", [params])
    return (result or {}).get("transfers", [])


async def _wallet_age_days(client: httpx.AsyncClient, url: str, wallet: str) -> int:
    """Return days since first outgoing transaction, or 0 if Enhanced API unavailable."""
    try:
        transfers = await _asset_transfers(
            client, url, wallet, direction="from", max_count=1, order="asc", with_metadata=True
        )
        if not transfers:
            return 0
        ts_str: str = (transfers[0].get("metadata") or {}).get("blockTimestamp", "")
        if not ts_str:
            return 0
        first_dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return (datetime.now(tz=timezone.utc) - first_dt).days
    except Exception:
        return 0


async def _protocol_and_mixer(
    client: httpx.AsyncClient, url: str, wallet: str
) -> tuple[int, bool]:
    """Return (unique_protocol_count, mixer_detected). Falls back to (0, False) if Enhanced API unavailable."""
    try:
        transfers = await _asset_transfers(client, url, wallet, direction="from", max_count=200)
        seen_protocols: set[str] = set()
        mixer_hit = False
        for t in transfers:
            to_addr = (t.get("to") or "").lower()
            if to_addr in PROTOCOL_ADDRS:
                seen_protocols.add(to_addr)
            if to_addr in TORNADO_CASH_ADDRS:
                mixer_hit = True
        return len(seen_protocols), mixer_hit
    except Exception:
        return 0, False


def _pad_address(addr: str) -> str:
    """Pad a 0x-prefixed address to a 32-byte (64 hex char) topic."""
    clean = addr[2:] if addr.startswith("0x") else addr
    return "0x" + clean.zfill(64)


async def _aave_history(
    client: httpx.AsyncClient, url: str, wallet: str
) -> dict[str, int]:
    """Return Aave V3 mainnet repay count and liquidation count for wallet.
    Returns zeros gracefully when eth_getLogs block range is restricted (free tier)."""
    _empty = {"repaid": 0, "liquidations": 0}
    try:
        user_topic = _pad_address(wallet)

        current_hex = await _rpc(client, url, "eth_blockNumber", [])
        if not current_hex:
            return _empty
        current_block = int(current_hex, 16)
        from_block = hex(max(0, current_block - 1_500_000))  # ~6 months

        repay_logs, liq_logs = await asyncio.gather(
            _rpc(client, url, "eth_getLogs", [{
                "address": AAVE_V3_POOL,
                "fromBlock": from_block,
                "toBlock": "latest",
                "topics": [AAVE_REPAY_TOPIC, None, user_topic],
            }]),
            _rpc(client, url, "eth_getLogs", [{
                "address": AAVE_V3_POOL,
                "fromBlock": from_block,
                "toBlock": "latest",
                "topics": [AAVE_LIQ_TOPIC, None, None, user_topic],
            }]),
        )

        return {
            "repaid":       len(repay_logs or []),
            "liquidations": len(liq_logs or []),
        }
    except Exception:
        return _empty


async def _nexusfi_history(
    client: httpx.AsyncClient, url: str, wallet: str
) -> dict[str, int]:
    """Return NexusFi platform loan history from Sepolia LoanFactory events.
    Returns zeros gracefully if Sepolia endpoint is unavailable."""
    _empty = {"platform_loans_repaid": 0, "platform_loans_defaulted": 0}
    if not NEXUSFI_FACTORY:
        return _empty

    try:
        user_topic = _pad_address(wallet)

        created_logs, repaid_logs = await asyncio.gather(
            _rpc(client, url, "eth_getLogs", [{
                "address": NEXUSFI_FACTORY,
                "fromBlock": "0x0",
                "toBlock": "latest",
                "topics": [LOAN_CREATED_TOPIC, None, user_topic],
            }]),
            _rpc(client, url, "eth_getLogs", [{
                "address": NEXUSFI_FACTORY,
                "fromBlock": "0x0",
                "toBlock": "latest",
                "topics": [LOAN_REPAID_TOPIC, None, user_topic],
            }]),
        )

        created_count = len(created_logs or [])
        repaid_count  = len(repaid_logs or [])
        return {
            "platform_loans_repaid":    repaid_count,
            "platform_loans_defaulted": max(0, created_count - repaid_count),
        }
    except Exception:
        return _empty


# ─── Public API ───────────────────────────────────────────────────────────────

async def fetch_wallet_data(wallet: str, eth_price_usd: float = 2500.0) -> dict:
    """
    Fetch all on-chain data for `wallet`.

    Queries mainnet for real DeFi history and Sepolia for NexusFi platform
    history in parallel. Returns a dict ready for feature engineering.
    """
    mainnet_url = _alchemy_url("mainnet")
    sepolia_url = _alchemy_url("sepolia")

    async with httpx.AsyncClient() as client:
        # Validate mainnet connection before running the full fetch.
        # eth_blockNumber is the simplest possible RPC call — if this fails
        # the API key is wrong or the network is unreachable.
        try:
            await _rpc(client, mainnet_url, "eth_blockNumber", [])
        except Exception as exc:
            raise RuntimeError(
                f"Alchemy mainnet unreachable — check ALCHEMY_API_KEY. Error: {exc}"
            ) from exc

        tx_cnt, bal_eth, wallet_age, (protocols, mixer), aave, nexusfi = (
            await asyncio.gather(
                _tx_count(client, mainnet_url, wallet),
                _balance_eth(client, mainnet_url, wallet),
                _wallet_age_days(client, mainnet_url, wallet),
                _protocol_and_mixer(client, mainnet_url, wallet),
                _aave_history(client, mainnet_url, wallet),
                _nexusfi_history(client, sepolia_url, wallet),
            )
        )

    balance_usd = bal_eth * eth_price_usd

    return {
        "wallet_age_days":         wallet_age,
        "tx_count":                tx_cnt,
        "protocols_count":         protocols,
        "balance_eth":             round(bal_eth, 6),
        "balance_usd":             round(balance_usd, 2),
        "mixer_detected":          mixer,
        "defi_repaid":             aave["repaid"],
        "defi_liquidations":       aave["liquidations"],
        "platform_loans_repaid":   nexusfi["platform_loans_repaid"],
        "platform_loans_defaulted": nexusfi["platform_loans_defaulted"],
    }
