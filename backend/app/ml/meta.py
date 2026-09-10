"""
Model version metadata. The version is a short content hash of credit_model.pkl,
so retraining automatically yields a new version - there is no counter to bump.
Run `python -m app.ml.meta` once to backfill meta for an already-trained model.
"""
from __future__ import annotations
import hashlib
import json
import os
from datetime import datetime, timezone

from .features import FEATURE_NAMES

ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
MODEL_PATH = os.path.join(ARTIFACTS_DIR, "credit_model.pkl")
META_PATH = os.path.join(ARTIFACTS_DIR, "model_meta.json")


def model_version() -> str:
    with open(MODEL_PATH, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    return f"v-{digest[:7]}"


def stamp_meta(n_samples: int | None = None, params: dict | None = None) -> dict:
    meta = {
        "version": model_version(),
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_samples": n_samples,
        "feature_names": FEATURE_NAMES,
        "lightgbm_params": params,
    }
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    return meta


def load_meta() -> dict | None:
    try:
        with open(META_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


if __name__ == "__main__":
    print(json.dumps(stamp_meta(), indent=2))
