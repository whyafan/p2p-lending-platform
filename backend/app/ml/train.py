"""
Synthetic training data generation + LightGBM model training.

Run once before starting the API:
    cd backend
    source venv/bin/activate
    python -m app.ml.train

Saves:
    app/ml/artifacts/credit_model.pkl   — LightGBM Booster
    app/ml/artifacts/label_map.pkl      — {0: 'A', 1: 'B', 2: 'C'}

Design:
  3 000 synthetic borrowers (1 000 per tier) generated from per-tier
  distributions with ≈15% overlap at tier boundaries so the model cannot
  trivially memorise rules.  The feature distributions approximate realistic
  DeFi user populations based on Aave / Dune analytics data.
"""

from __future__ import annotations
import os
import joblib
import numpy as np
import lightgbm as lgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import log_loss, roc_auc_score
from .features import FEATURE_NAMES, build_feature_vector

ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")
os.makedirs(ARTIFACTS_DIR, exist_ok=True)

RNG = np.random.default_rng(42)


def _clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def _generate_tier_a(n: int) -> list[list[float]]:
    rows = []
    for _ in range(n):
        age   = int(_clamp(RNG.lognormal(6.9, 0.35), 300, 2800))   # ~990d mean
        txs   = int(_clamp(RNG.lognormal(5.5, 0.45), 80, 900))
        proto = int(_clamp(RNG.poisson(7), 4, 15))
        bal   = _clamp(RNG.lognormal(10.5, 0.6), 12_000, 200_000)
        mixer = int(RNG.random() < 0.01)
        repaid = int(_clamp(RNG.poisson(4), 2, 20))
        liq   = 0
        inc   = _clamp(RNG.normal(0.55, 0.12), 0.25, 0.80)
        emp   = _clamp(RNG.normal(0.35, 0.08), 0.15, 0.50)
        dis   = _clamp(RNG.beta(9, 1) * 0.05, 0, 0.15)  # almost never dishonest
        rows.append([float(age), float(txs), float(proto), float(bal),
                     float(mixer), float(repaid), float(liq), inc, emp, dis])
    return rows


def _generate_tier_b(n: int) -> list[list[float]]:
    rows = []
    for _ in range(n):
        age   = int(_clamp(RNG.lognormal(5.5, 0.55), 70, 600))
        txs   = int(_clamp(RNG.lognormal(3.9, 0.55), 15, 200))
        proto = int(_clamp(RNG.poisson(3), 1, 7))
        bal   = _clamp(RNG.lognormal(8.8, 0.55), 2_000, 25_000)
        mixer = int(RNG.random() < 0.05)
        repaid = int(_clamp(RNG.poisson(1), 0, 5))
        liq   = int(RNG.random() < 0.18)
        inc   = _clamp(RNG.normal(0.12, 0.22), -0.25, 0.50)
        emp   = _clamp(RNG.normal(0.05, 0.20), -0.15, 0.40)
        dis   = _clamp(RNG.beta(4, 3) * 0.35, 0, 0.50)
        rows.append([float(age), float(txs), float(proto), float(bal),
                     float(mixer), float(repaid), float(liq), inc, emp, dis])
    return rows


def _generate_tier_c(n: int) -> list[list[float]]:
    rows = []
    for _ in range(n):
        age   = int(_clamp(RNG.lognormal(3.5, 0.75), 0, 150))
        txs   = int(_clamp(RNG.lognormal(2.2, 0.70), 0, 60))
        proto = int(_clamp(RNG.poisson(1), 0, 4))
        bal   = _clamp(RNG.lognormal(7.0, 0.80), 0, 7_000)
        mixer = int(RNG.random() < 0.22)
        repaid = int(_clamp(RNG.poisson(0.2), 0, 2))
        liq   = int(_clamp(RNG.poisson(0.45), 0, 4))
        inc   = _clamp(RNG.normal(-0.15, 0.30), -0.50, 0.25)
        emp   = _clamp(RNG.normal(-0.10, 0.25), -0.35, 0.25)
        dis   = _clamp(RNG.beta(3, 4) * 0.70, 0, 1.0)
        rows.append([float(age), float(txs), float(proto), float(bal),
                     float(mixer), float(repaid), float(liq), inc, emp, dis])
    return rows


def _rows_to_feature_vectors(rows: list[list[float]]) -> np.ndarray:
    """Convert raw distribution samples to the proper feature vector format."""
    import math
    out = []
    for r in rows:
        age, txs, proto, bal, mixer, repaid, liq, inc_adj, emp_adj, dis = r
        fv = [
            age,
            txs,
            proto,
            math.log10(max(bal, 1.0)),  # F3: log_balance
            mixer,
            repaid,
            liq,
            inc_adj,     # already credibility-adjusted in generation
            emp_adj,
            dis,
        ]
        out.append(fv)
    return np.array(out, dtype=np.float32)


def generate_training_data(n_per_tier: int = 1000):
    a_rows = _generate_tier_a(n_per_tier)
    b_rows = _generate_tier_b(n_per_tier)
    c_rows = _generate_tier_c(n_per_tier)

    X = np.vstack([
        _rows_to_feature_vectors(a_rows),
        _rows_to_feature_vectors(b_rows),
        _rows_to_feature_vectors(c_rows),
    ])
    y = np.array([0] * n_per_tier + [1] * n_per_tier + [2] * n_per_tier)

    # Shuffle
    idx = RNG.permutation(len(y))
    return X[idx], y[idx]


def train_and_save(n_per_tier: int = 1000) -> None:
    print("Generating synthetic training data…")
    X, y = generate_training_data(n_per_tier)

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.20, random_state=42, stratify=y
    )

    dtrain = lgb.Dataset(X_train, label=y_train, feature_name=FEATURE_NAMES)
    dval   = lgb.Dataset(X_val,   label=y_val,   reference=dtrain)

    params = {
        "objective":        "multiclass",
        "num_class":        3,
        "metric":           "multi_logloss",
        "num_leaves":       31,
        "learning_rate":    0.05,
        "n_estimators":     300,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq":     5,
        "min_child_samples": 20,
        "verbose":          -1,
    }

    print("Training LightGBM model…")
    callbacks = [lgb.early_stopping(30, verbose=False), lgb.log_evaluation(50)]
    model = lgb.train(
        params,
        dtrain,
        num_boost_round=300,
        valid_sets=[dval],
        callbacks=callbacks,
    )

    # Evaluation
    proba = model.predict(X_val)
    ll = log_loss(y_val, proba)
    auc = roc_auc_score(y_val, proba, multi_class="ovr", average="macro")
    print(f"  Validation log-loss: {ll:.4f}  |  AUC (OvR macro): {auc:.4f}")

    label_map = {0: "A", 1: "B", 2: "C"}

    model_path = os.path.join(ARTIFACTS_DIR, "credit_model.pkl")
    label_path = os.path.join(ARTIFACTS_DIR, "label_map.pkl")
    joblib.dump(model, model_path)
    joblib.dump(label_map, label_path)
    print(f"  Saved model → {model_path}")
    print(f"  Saved label map → {label_path}")


if __name__ == "__main__":
    train_and_save()
