"""Smoke tests for model versioning. Run: venv/Scripts/python tests/test_model_meta.py (from backend/)."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.ml.meta import stamp_meta, load_meta, META_PATH
from app.ml.features import FEATURE_NAMES


def test_stamp_meta_writes_valid_meta():
    good = open(META_PATH, encoding="utf-8").read()
    try:
        meta = stamp_meta(n_samples=1234, params={"num_leaves": 31})
        assert re.fullmatch(r"v-[0-9a-f]{7}", meta["version"]), meta["version"]
        assert meta["feature_names"] == FEATURE_NAMES
        assert meta["n_samples"] == 1234
        assert meta["lightgbm_params"] == {"num_leaves": 31}
        on_disk = json.load(open(META_PATH, encoding="utf-8"))
        assert on_disk == meta
    finally:
        with open(META_PATH, "w", encoding="utf-8") as f:
            f.write(good)


def test_stamp_is_deterministic_for_same_model():
    good = open(META_PATH, encoding="utf-8").read()
    try:
        a = stamp_meta()
        b = stamp_meta()
        assert a["version"] == b["version"]
    finally:
        with open(META_PATH, "w", encoding="utf-8") as f:
            f.write(good)


def test_scorer_returns_model_version():
    from app.ml.model import CreditScorer
    good = open(META_PATH, encoding="utf-8").read()
    try:
        stamp_meta()
        CreditScorer._instance = None  # force reload so meta is picked up
        scorer = CreditScorer.get()
        assert scorer.ready, "artifacts/credit_model.pkl must exist"
        result = scorer.score([0.5] * len(FEATURE_NAMES))
        assert result["model_version"] == load_meta()["version"]
    finally:
        with open(META_PATH, "w", encoding="utf-8") as f:
            f.write(good)


def test_scorer_version_is_none_when_meta_is_stale():
    """A meta version that no longer matches the live model file (e.g. after a
    model swap without re-stamping) must not be trusted."""
    from app.ml.model import CreditScorer
    good = open(META_PATH, encoding="utf-8").read()
    try:
        meta = stamp_meta()
        meta["version"] = "v-0000000"
        with open(META_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        CreditScorer._instance = None
        scorer = CreditScorer.get()
        assert scorer.version is None
    finally:
        with open(META_PATH, "w", encoding="utf-8") as f:
            f.write(good)
        CreditScorer._instance = None


def test_corrupted_meta_is_treated_as_missing():
    good = open(META_PATH, encoding="utf-8").read()
    try:
        with open(META_PATH, "w", encoding="utf-8") as f:
            f.write("{not json")
        assert load_meta() is None
    finally:
        with open(META_PATH, "w", encoding="utf-8") as f:
            f.write(good)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
    print("all tests passed")
