# Phase 6 Off-Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the existing ML credit backend to Render with model versioning, and add EIP-712-signed, IPFS-anchored term sheets — no contract changes.

**Architecture:** The FastAPI backend (`backend/`) already does LightGBM + SHAP + live Alchemy chain fetching; we add a content-hash model version stamped at train time and deploy via a `render.yaml` blueprint. Term sheets get a real EIP-712 signature in the wizard, are pinned to Pinata by a server route, and CID + keccak256 hash persist on the existing `loan_risk_assessments` row; lenders verify hash + signer client-side.

**Tech Stack:** FastAPI/LightGBM/SHAP (backend), Next.js App Router, wagmi + viem (`useSignTypedData`, `keccak256`, `verifyTypedData`), Supabase, Pinata REST API, Render free tier.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-21-phase6-offchain-design.md`. Read it first.
- Branch: `atharva`. Never force-push. No AI-attribution trailers in commit messages, and no em dashes in added user-visible copy (project conventions from `.superpowers/sdd/progress.md`).
- Frontend tests run with `node --test "lib/*.test.ts"` from `frontend/` (Node 24 runs TS natively; 157 currently pass). Type check: `npx tsc --noEmit`. Lint: `npm run lint`.
- Pinning/signing is **best-effort**: a Pinata failure or signature decline must never block loan creation.
- Persona/demo loans never sign or pin. Wallet mode only.
- All secrets (`ALCHEMY_API_KEY`, `PINATA_JWT`) stay server-side; never in `NEXT_PUBLIC_*`, never committed.
- Existing RLS/immutability on `loan_risk_assessments` untouched — migration 006 adds nullable columns only.
- Working directory below is the repo root `p2p-lending-platform/` unless a task says otherwise.

---

### Task 1: Backend model versioning (meta stamp + `model_version` in responses)

**Files:**
- Create: `backend/app/ml/meta.py`
- Create: `backend/tests/__init__.py` (empty), `backend/tests/test_model_meta.py`
- Modify: `backend/app/ml/model.py` (add meta load + `version` property + `model_version` in `score()` result)
- Modify: `backend/app/ml/train.py` (stamp meta after saving the model)
- Modify: `backend/app/schemas/credit.py` (add `model_version` to `ScoreResponse`)
- Modify: `backend/app/routers/credit.py` (pass `model_version` through)
- Create (generated, committed): `backend/app/ml/artifacts/model_meta.json`

**Interfaces:**
- Produces: `ScoreResponse.model_version: str | None` — e.g. `"v-3fa9c21"`, `null` when the rule-based fallback scored. Task 4's frontend type relies on this exact field name.
- Produces: `python -m app.ml.meta` = one-time backfill that writes `model_meta.json` for the existing pkl.

- [ ] **Step 1: One-time environment setup** (backend has no venv — it was deleted during cleanup)

```bash
cd backend
python -m venv venv
venv/Scripts/python -m pip install -r requirements.txt
```

Takes a few minutes (lightgbm, shap). Confirm `backend/venv` is git-ignored (`git status --short` must not list it; if it does, add `backend/venv/` to `.gitignore`).

- [ ] **Step 2: Write the failing test**

Create `backend/tests/__init__.py` (empty) and `backend/tests/test_model_meta.py`:

```python
"""Smoke tests for model versioning. Run: venv/Scripts/python tests/test_model_meta.py (from backend/)."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.ml.meta import stamp_meta, load_meta, META_PATH
from app.ml.features import FEATURE_NAMES


def test_stamp_meta_writes_valid_meta():
    meta = stamp_meta(n_samples=1234, params={"num_leaves": 31})
    assert re.fullmatch(r"v-[0-9a-f]{7}", meta["version"]), meta["version"]
    assert meta["feature_names"] == FEATURE_NAMES
    assert meta["n_samples"] == 1234
    assert meta["lightgbm_params"] == {"num_leaves": 31}
    on_disk = json.load(open(META_PATH, encoding="utf-8"))
    assert on_disk == meta


def test_stamp_is_deterministic_for_same_model():
    a = stamp_meta()
    b = stamp_meta()
    assert a["version"] == b["version"]


def test_scorer_returns_model_version():
    from app.ml.model import CreditScorer
    stamp_meta()
    CreditScorer._instance = None  # force reload so meta is picked up
    scorer = CreditScorer.get()
    assert scorer.ready, "artifacts/credit_model.pkl must exist"
    result = scorer.score([0.5] * len(FEATURE_NAMES))
    assert result["model_version"] == load_meta()["version"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
    print("all tests passed")
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend && venv/Scripts/python tests/test_model_meta.py
```

Expected: `ModuleNotFoundError: No module named 'app.ml.meta'`

- [ ] **Step 4: Create `backend/app/ml/meta.py`**

```python
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
    if not os.path.exists(META_PATH):
        return None
    with open(META_PATH, encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    print(json.dumps(stamp_meta(), indent=2))
```

Note: `test_stamp_is_deterministic_for_same_model` passes because the version hashes the model file, not `trained_at`.

- [ ] **Step 5: Wire meta into `CreditScorer` (`backend/app/ml/model.py`)**

In `__init__`, after the `if self._ready:` block finishes loading the model, add:

```python
        from .meta import load_meta
        self._meta = load_meta() if self._ready else None
```

Add a property next to `ready`:

```python
    @property
    def version(self) -> str | None:
        return self._meta["version"] if (self._ready and self._meta) else None
```

In `score()`, every `return {...}` dict (the real-model path and the fallback path — read the full method first) gains one key:

```python
            "model_version": self.version,
```

The fallback path has `self._ready == False`, so `self.version` is already `None` there — same line works in both.

- [ ] **Step 6: Stamp at train time (`backend/app/ml/train.py`)**

After the two `joblib.dump(...)` / `print("  Saved label map ...")` lines in `train_and_save()`, add:

```python
    from .meta import stamp_meta
    meta = stamp_meta(n_samples=len(X_train) + len(X_val), params=params)
    print(f"  Stamped model meta → version {meta['version']}")
```

- [ ] **Step 7: Expose in the API**

`backend/app/schemas/credit.py` — add to `ScoreResponse`:

```python
    model_version: str | None = None   # content-hash version of the scoring model; None = rule-based fallback
```

`backend/app/routers/credit.py` — in the final `return ScoreResponse(...)`, add:

```python
        model_version = result.get("model_version"),
```

- [ ] **Step 8: Run tests, backfill, verify health**

```bash
cd backend && venv/Scripts/python tests/test_model_meta.py
```
Expected: `PASS` ×3, `all tests passed`. (`model_meta.json` is now written — that IS the backfill; confirm `git status` shows `backend/app/ml/artifacts/model_meta.json` as new.)

```bash
venv/Scripts/python -c "from app.ml.model import CreditScorer; s=CreditScorer.get(); print(s.ready, s.version)"
```
Expected: `True v-xxxxxxx`

- [ ] **Step 9: Commit**

```bash
git add backend/app/ml/meta.py backend/app/ml/model.py backend/app/ml/train.py backend/app/schemas/credit.py backend/app/routers/credit.py backend/tests/ backend/app/ml/artifacts/model_meta.json
git commit -m "feat(backend): content-hash model versioning stamped at train time"
```

---

### Task 2: Render deployment blueprint

**Files:**
- Create: `render.yaml` (repo root)

**Interfaces:**
- Produces: the deployed service URL (user creates it manually) that becomes `CREDIT_BACKEND_URL` on Vercel. Nothing in code consumes this file.

- [ ] **Step 1: Create `render.yaml`**

```yaml
# Render blueprint for the NexusFi credit-scoring backend (free tier).
# Manual steps after pushing this file:
#   1. Render dashboard -> New -> Blueprint -> pick this repo/branch.
#   2. Paste ALCHEMY_API_KEY when prompted (sync: false keeps it out of git).
#   3. Set CREDIT_BACKEND_URL=https://<service>.onrender.com on all four Vercel deployments.
# Free-tier caveat: the service sleeps after 15 min idle and takes ~50s to wake;
# the frontend fires a warm-up ping and degrades to the rule-based scorer meanwhile.
services:
  - type: web
    name: nexusfi-credit-api
    runtime: python
    plan: free
    rootDir: backend
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    healthCheckPath: /health
    envVars:
      - key: PYTHON_VERSION
        value: 3.12.7
      - key: ALCHEMY_API_KEY
        sync: false
      # chain_fetcher.py's baked-in default factory address predates the
      # 2026-08-21 pooling redeploy; pin the current one explicitly.
      - key: NEXUSFI_FACTORY_SEPOLIA
        value: "0x0e3ea8f226434feadb267d05c9c4ef8f951c7d00"
```

Note: `GET /health` already exists in `backend/app/main.py` (returns `{status, model_ready}`) — do not add another.

- [ ] **Step 2: Sanity-check YAML parses**

```bash
cd frontend && node -e "const fs=require('fs');const y=fs.readFileSync('../render.yaml','utf8');if(!/rootDir: backend/.test(y)||!/healthCheckPath: \/health/.test(y))throw new Error('bad yaml');console.log('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add render.yaml
git commit -m "feat: Render free-tier blueprint for the credit backend"
```

---

### Task 3: Cold-start warm-up ping + honest fallback copy

**Files:**
- Modify: `frontend/app/api/credit/score/route.ts` (add GET handler)
- Modify: `frontend/components/LoanRequestPanel.tsx` (ping on wallet-mode entry; copy tweak)

**Interfaces:**
- Produces: `GET /api/credit/score` → `{ ok: boolean }` (always HTTP 200; it is a warm-up ping, not an error surface).

- [ ] **Step 1: Add the GET handler**

In `frontend/app/api/credit/score/route.ts`, below the existing `POST` export:

```ts
/**
 * GET = warm-up ping. Render's free tier sleeps after 15 min idle and takes
 * ~50s to wake; any request starts the wake, so the wizard fires this when
 * the user enters wallet mode. Short timeout on purpose - we only need to
 * knock, not wait for the door.
 */
export async function GET() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    return NextResponse.json({ ok: res.ok });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
```

- [ ] **Step 2: Fire the ping on wallet-mode entry**

In `frontend/components/LoanRequestPanel.tsx`, add a module-level helper near the other top-level helpers (outside the component):

```ts
// Knock on the scoring backend so Render starts waking while the user fills the form.
function warmUpCreditBackend() {
  void fetch('/api/credit/score', { method: 'GET' }).catch(() => {});
}
```

Call it in both wallet-mode entry points:

In `startWalletMode()`:
```ts
  function startWalletMode() {
    warmUpCreditBackend();
    setEvalMode('wallet');
    setWizardStep(1);
  }
```

In `switchMode()`, right after `const nextMode: EvalMode = ...`:
```ts
    if (nextMode === 'wallet') warmUpCreditBackend();
```

- [ ] **Step 3: Update the fallback copy**

In `confirmWalletScore()`, replace the string

```ts
setScoringWarnings(['Real-wallet scoring is temporarily unavailable — the credit-scoring service isn\'t reachable right now.']);
```

with

```ts
setScoringWarnings(['Real-wallet scoring is temporarily unavailable. The service may be waking up (it sleeps when idle) - try again in about a minute, or switch to demo mode below.']);
```

(Plain dash, not an em dash — project convention.)

- [ ] **Step 4: Verify**

```bash
cd frontend && npx tsc --noEmit && npm run lint && node --test "lib/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: tsc silent, lint clean, `tests 157 / pass 157 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/api/credit/score/route.ts frontend/components/LoanRequestPanel.tsx
git commit -m "feat: warm-up ping and wake-aware fallback copy for the credit backend"
```

---

### Task 4: Migration 006 + persist/display `model_version` (and plumb term-sheet columns)

**Files:**
- Create: `frontend/supabase/migrations/006_model_version_and_termsheets.sql`
- Modify: `frontend/app/api/loans/risk/route.ts` (accept + return the 3 new fields)
- Modify: `frontend/components/LoanRequestPanel.tsx` (type + persist `modelVersion`)
- Modify: `frontend/components/LoanSafetyPanel.tsx` (show scorer provenance)

**Interfaces:**
- Consumes: `model_version` from Task 1's `ScoreResponse`.
- Produces: DB columns `model_version`, `term_sheet_cid`, `term_sheet_hash` (all nullable TEXT); POST `/api/loans/risk` accepts `modelVersion`, `termSheetCid`, `termSheetHash` (all optional strings); GET returns them camelCased on each assessment object. Task 6 fills the term-sheet fields; Task 7 renders them.

- [ ] **Step 1: Write the migration**

`frontend/supabase/migrations/006_model_version_and_termsheets.sql`:

```sql
-- Migration 006: Phase 6 off-chain provenance columns.
-- Run in the Supabase SQL editor after 005_public_profiles_view.sql.
--
-- model_version: which scoring model priced this loan ("v-3fa9c21" content hash
--   from the ML backend), NULL when the client-side rule-based scorer ran.
-- term_sheet_cid / term_sheet_hash: IPFS CID and keccak256 hash of the borrower's
--   EIP-712-signed term sheet, NULL for persona/demo loans or when pinning failed.
-- Nullable additions only: existing RLS, immutability, and rows are untouched.

ALTER TABLE loan_risk_assessments
  ADD COLUMN IF NOT EXISTS model_version   TEXT,
  ADD COLUMN IF NOT EXISTS term_sheet_cid  TEXT,
  ADD COLUMN IF NOT EXISTS term_sheet_hash TEXT;
```

- [ ] **Step 2: Accept the fields in POST `/api/loans/risk`**

In `frontend/app/api/loans/risk/route.ts`, extend the destructuring in `POST`:

```ts
  const {
    loanContract,
    chainId,
    borrowerWallet,
    tier,
    overallScore,
    contributions,
    source,
    personaId,
    modelVersion,
    termSheetCid,
    termSheetHash,
  } = (body ?? {}) as Record<string, unknown>;
```

and extend the `.insert({...})` object:

```ts
    model_version: typeof modelVersion === 'string' ? modelVersion : null,
    term_sheet_cid: typeof termSheetCid === 'string' ? termSheetCid : null,
    term_sheet_hash: typeof termSheetHash === 'string' ? termSheetHash : null,
```

- [ ] **Step 3: Return the fields from GET**

Both `select(...)` calls in the GET handler add the columns:

```ts
      .select('loan_contract, tier, overall_score, contributions, source, persona_id, created_at, model_version, term_sheet_cid, term_sheet_hash')
```

Both response-shaping objects (the `latest` one and the batch `assessments[row.loan_contract]` one) add:

```ts
      modelVersion: row.model_version ?? null,
      termSheetCid: row.term_sheet_cid ?? null,
      termSheetHash: row.term_sheet_hash ?? null,
```

- [ ] **Step 4: Persist from the wizard**

In `frontend/components/LoanRequestPanel.tsx`:

1. The `BackendScoreResult` type (near line 120-140) gains:
```ts
  model_version?: string | null;
```

2. The risk-persist `fetch('/api/loans/risk', ...)` body (near line 483) gains one field:
```ts
        modelVersion: evalMode === 'wallet' ? (backendResult?.model_version ?? null) : null,
```
and `backendResult` joins the effect's dependency array.

(`termSheetCid`/`termSheetHash` are added to this same body in Task 6 — not here.)

- [ ] **Step 5: Show provenance in the lender panel**

In `frontend/components/LoanSafetyPanel.tsx`, extend the `assessment` prop type:

```ts
  assessment?: {
    tier: RiskTier;
    overallScore: number;
    contributions: FeatureContribution[];
    source?: string | null;
    personaId?: string | null;
    modelVersion?: string | null;
    termSheetCid?: string | null;
    termSheetHash?: string | null;
  } | null;
```

Inside the existing `{assessment && assessment.contributions?.length > 0 ? (...)}` block, next to where `assessment.overallScore` is rendered (around line 248), add a provenance line:

```tsx
              <p className="text-[10px] text-slate-500">
                {assessment.modelVersion
                  ? <>Scored by ML model <span className="font-mono text-slate-400">{assessment.modelVersion}</span> (LightGBM + SHAP)</>
                  : <>Scored by the rule-based explainable scorer</>}
              </p>
```

- [ ] **Step 6: Verify**

```bash
cd frontend && npx tsc --noEmit && npm run lint && node --test "lib/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: clean, 157 pass. (DB effect is verified live after the user runs migration 006.)

- [ ] **Step 7: Commit**

```bash
git add frontend/supabase/migrations/006_model_version_and_termsheets.sql frontend/app/api/loans/risk/route.ts frontend/components/LoanRequestPanel.tsx frontend/components/LoanSafetyPanel.tsx
git commit -m "feat: persist and display scoring model version (migration 006)"
```

---

### Task 5: Canonical term-sheet serialization + hash (TDD)

**Files:**
- Create: `frontend/lib/termsheet-canonical.ts`
- Test: `frontend/lib/termsheet-canonical.test.ts`

**Interfaces:**
- Produces: `canonicalize(value: unknown): string` — deterministic JSON: object keys sorted recursively, no whitespace, bigints as decimal strings. `termSheetHash(payload: unknown): \`0x${string}\`` — keccak256 of the canonical UTF-8 bytes. Tasks 6 and 7 both import these; client and server MUST hash through this one helper or verification breaks.

- [ ] **Step 1: Write the failing test**

`frontend/lib/termsheet-canonical.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, termSheetHash } from './termsheet-canonical';

describe('canonicalize', () => {
  it('is independent of key insertion order', () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  });

  it('sorts keys recursively and emits no whitespace', () => {
    assert.equal(
      canonicalize({ z: { b: 1, a: [1, 'x'] }, a: true }),
      '{"a":true,"z":{"a":[1,"x"],"b":1}}',
    );
  });

  it('serializes bigints as decimal strings', () => {
    assert.equal(canonicalize({ wei: 1000000000000000000n }), '{"wei":"1000000000000000000"}');
  });

  it('preserves array order (arrays are positional, not sorted)', () => {
    assert.equal(canonicalize([2, 1]), '[2,1]');
  });

  it('drops undefined object values like JSON.stringify does', () => {
    assert.equal(canonicalize({ a: 1, gone: undefined }), '{"a":1}');
  });
});

describe('termSheetHash', () => {
  it('returns a 32-byte hex hash', () => {
    assert.match(termSheetHash({ a: 1 }), /^0x[0-9a-f]{64}$/);
  });

  it('is stable for equivalent objects and changes when a field changes', () => {
    assert.equal(termSheetHash({ a: 1, b: 2 }), termSheetHash({ b: 2, a: 1 }));
    assert.notEqual(termSheetHash({ a: 1 }), termSheetHash({ a: 2 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && node --test "lib/termsheet-canonical.test.ts"
```
Expected: FAIL — cannot find module `./termsheet-canonical`.

- [ ] **Step 3: Implement `frontend/lib/termsheet-canonical.ts`**

```ts
/**
 * Deterministic term-sheet serialization. The IPFS-anchored hash is only
 * meaningful if borrower (pin time) and lender (verify time) serialize the
 * same object to the same bytes, so: keys sorted recursively, no whitespace,
 * bigints as decimal strings. Both sides MUST hash through this module.
 */
import { keccak256, stringToBytes } from 'viem';

export function canonicalize(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function termSheetHash(payload: unknown): `0x${string}` {
  return keccak256(stringToBytes(canonicalize(payload)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && node --test "lib/termsheet-canonical.test.ts"
```
Expected: 7 pass, 0 fail. Then the full suite:

```bash
node --test "lib/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: `tests 164 / pass 164 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/termsheet-canonical.ts frontend/lib/termsheet-canonical.test.ts
git commit -m "feat: canonical term-sheet serialization and keccak256 hashing"
```

---

### Task 6: EIP-712 typed data + Pinata pin route + wizard signing

**Files:**
- Create: `frontend/lib/termsheet-typed-data.ts`
- Create: `frontend/app/api/termsheet/pin/route.ts`
- Modify: `frontend/components/LoanRequestPanel.tsx` (sign + pin in `submitLoan`, thread `{cid, hash}` into the risk persist)

**Interfaces:**
- Consumes: `canonicalize`/`termSheetHash` from Task 5; POST `/api/loans/risk` fields `termSheetCid`/`termSheetHash` from Task 4.
- Produces: `TERM_SHEET_TYPES`, `termSheetDomain(chainId)`, `TermSheetMessage`, `serializeMessage`, `parseMessage`, `PINATA_GATEWAY` — Task 7's verifier imports all of these. POST `/api/termsheet/pin` → `{ cid: string, hash: string }`.

- [ ] **Step 1: Create `frontend/lib/termsheet-typed-data.ts`**

```ts
/**
 * EIP-712 LoanTermSheet definition, shared by the borrower wizard (signing),
 * the pin route (server-side signature check), and the lender verifier.
 */

export const TERM_SHEET_TYPES = {
  LoanTermSheet: [
    { name: 'borrower', type: 'address' },
    { name: 'principalWei', type: 'uint256' },
    { name: 'collateralWei', type: 'uint256' },
    { name: 'tenorDays', type: 'uint256' },
    { name: 'interestBps', type: 'uint256' },
    { name: 'maxLtvBps', type: 'uint256' },
    { name: 'liquidationBufferBps', type: 'uint256' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const;

export function termSheetDomain(chainId: number) {
  return { name: 'NexusFi', version: '1', chainId } as const;
}

export type TermSheetMessage = {
  borrower: `0x${string}`;
  principalWei: bigint;
  collateralWei: bigint;
  tenorDays: bigint;
  interestBps: bigint;
  maxLtvBps: bigint;
  liquidationBufferBps: bigint;
  issuedAt: bigint;
};

const UINT_FIELDS = [
  'principalWei', 'collateralWei', 'tenorDays', 'interestBps',
  'maxLtvBps', 'liquidationBufferBps', 'issuedAt',
] as const;

/** JSON-safe form for pinning: bigints become decimal strings. */
export function serializeMessage(m: TermSheetMessage): Record<string, string> {
  return {
    borrower: m.borrower,
    ...Object.fromEntries(UINT_FIELDS.map((f) => [f, m[f].toString()])),
  };
}

/** Inverse of serializeMessage; throws on malformed input (verification treats that as a mismatch). */
export function parseMessage(raw: Record<string, unknown>): TermSheetMessage {
  const borrower = raw.borrower;
  if (typeof borrower !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(borrower)) {
    throw new Error('bad borrower address');
  }
  const out: Record<string, unknown> = { borrower };
  for (const f of UINT_FIELDS) {
    if (typeof raw[f] !== 'string' || !/^\d+$/.test(raw[f] as string)) throw new Error(`bad field ${f}`);
    out[f] = BigInt(raw[f] as string);
  }
  return out as TermSheetMessage;
}

export const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
```

- [ ] **Step 2: Create `frontend/app/api/termsheet/pin/route.ts`**

```ts
/**
 * POST /api/termsheet/pin
 *
 * Pins a borrower's EIP-712-signed term sheet to IPFS via Pinata and returns
 * { cid, hash }. The keccak256 hash is computed over the canonical form of the
 * exact pinned payload, so any later gateway fetch can be re-hashed and compared.
 * Best-effort by design: callers must treat any failure as non-blocking.
 */
import { NextResponse } from 'next/server';
import { verifyTypedData } from 'viem';
import { getSessionUser } from '../../../../lib/auth';
import { termSheetHash } from '../../../../lib/termsheet-canonical';
import { TERM_SHEET_TYPES, termSheetDomain, parseMessage } from '../../../../lib/termsheet-typed-data';

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json({ error: 'IPFS pinning not configured' }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { chainId, message, signature, signer } = body as {
    chainId?: unknown; message?: unknown; signature?: unknown; signer?: unknown;
  };
  if (typeof chainId !== 'number' || typeof signature !== 'string' || typeof signer !== 'string'
      || message === null || typeof message !== 'object') {
    return NextResponse.json({ error: 'chainId, message, signature, signer required' }, { status: 400 });
  }

  // The signature must actually be the signer's, over exactly this message.
  let valid = false;
  try {
    valid = await verifyTypedData({
      address: signer as `0x${string}`,
      domain: termSheetDomain(chainId),
      types: TERM_SHEET_TYPES,
      primaryType: 'LoanTermSheet',
      message: parseMessage(message as Record<string, unknown>),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return NextResponse.json({ error: 'Signature does not verify' }, { status: 400 });
  }

  // Pin the exact payload we hash. serialized message only - no bigints in JSON.
  const payload = {
    standard: 'NexusFi-TermSheet-v1',
    chainId,
    domain: termSheetDomain(chainId),
    primaryType: 'LoanTermSheet',
    types: TERM_SHEET_TYPES,
    message,
    signature,
    signer: signer.toLowerCase(),
  };
  const hash = termSheetHash(payload);

  try {
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pinataContent: payload,
        pinataMetadata: { name: `nexusfi-termsheet-${signer.toLowerCase()}` },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[termsheet/pin] pinata error', res.status, text.slice(0, 200));
      return NextResponse.json({ error: `Pinata error ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { IpfsHash?: string };
    if (!data.IpfsHash) {
      return NextResponse.json({ error: 'Pinata returned no CID' }, { status: 502 });
    }
    return NextResponse.json({ cid: data.IpfsHash, hash });
  } catch (err) {
    console.error('[termsheet/pin] failed:', err);
    return NextResponse.json({ error: 'Pinning failed' }, { status: 502 });
  }
}
```

- [ ] **Step 3: Sign + pin in the wizard**

In `frontend/components/LoanRequestPanel.tsx`:

1. Extend the wagmi import to include `useSignTypedData`, and import the typed-data helpers:
```ts
import { TERM_SHEET_TYPES, termSheetDomain, serializeMessage, type TermSheetMessage } from '../lib/termsheet-typed-data';
```

2. Next to the other hooks (`useWriteContract` at ~line 448):
```ts
  const { signTypedDataAsync } = useSignTypedData();
  const [termSheetPin, setTermSheetPin] = useState<{ cid: string; hash: string } | null>(null);
```

3. Add a helper above `submitLoan` (inside the component):
```ts
  // Best-effort: sign the term sheet and anchor it on IPFS. Wallet mode only.
  // A declined signature or failed pin never blocks the loan - we just proceed unanchored.
  async function signAndPinTermSheet(principalWei: bigint, collateralWei: bigint) {
    if (evalMode !== 'wallet' || !termSheet || !address) return;
    try {
      const message: TermSheetMessage = {
        borrower: address,
        principalWei,
        collateralWei,
        tenorDays: BigInt(tenorDays),
        interestBps: BigInt(termSheet.interestBps),
        maxLtvBps: BigInt(termSheet.maxLtvBps),
        liquidationBufferBps: BigInt(termSheet.liquidationBufferBps),
        issuedAt: BigInt(Math.floor(Date.now() / 1000)),
      };
      const signature = await signTypedDataAsync({
        domain: termSheetDomain(chainId),
        types: TERM_SHEET_TYPES,
        primaryType: 'LoanTermSheet',
        message,
      });
      const res = await fetch('/api/termsheet/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId, message: serializeMessage(message), signature, signer: address }),
      });
      if (res.ok) {
        const { cid, hash } = (await res.json()) as { cid: string; hash: string };
        setTermSheetPin({ cid, hash });
      } else {
        console.warn('[termsheet] pin failed:', res.status);
      }
    } catch (err) {
      console.warn('[termsheet] signing declined or failed:', err);
    }
  }
```

4. In `submitLoan()`, after `await switchChainAsync({ chainId });` and before `writeContractAsync`, insert:
```ts
      await signAndPinTermSheet(principalWei, collateralWei);
```
(`principalWei`/`collateralWei` are already computed above the `try` block — signing happens after the chain switch so both wallet prompts arrive on Sepolia.)

5. The risk-persist body (Task 4's `modelVersion` line) gains:
```ts
        termSheetCid: termSheetPin?.cid ?? null,
        termSheetHash: termSheetPin?.hash ?? null,
```
and `termSheetPin` joins the effect dependency array.

6. In `reset()`, add `setTermSheetPin(null);`.

- [ ] **Step 4: Verify**

```bash
cd frontend && npx tsc --noEmit && npm run lint && node --test "lib/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: clean, 164 pass. (Live pin verified end-to-end after the user sets `PINATA_JWT`.)

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/termsheet-typed-data.ts frontend/app/api/termsheet/pin/route.ts frontend/components/LoanRequestPanel.tsx
git commit -m "feat: EIP-712 term-sheet signing with best-effort IPFS anchoring"
```

---

### Task 7: Lender-side term-sheet verification

**Files:**
- Modify: `frontend/components/LoanSafetyPanel.tsx` (IPFS section + Verify button)
- Modify: `frontend/components/LenderDashboard.tsx` (pass `borrower` at both `LoanSafetyPanel` call sites, lines ~1285 and ~1788)

**Interfaces:**
- Consumes: `assessment.termSheetCid`/`termSheetHash` (Task 4), `termSheetHash()` (Task 5), `TERM_SHEET_TYPES`/`parseMessage`/`PINATA_GATEWAY` (Task 6), viem `verifyTypedData`.
- Produces: nothing downstream.

- [ ] **Step 1: Pass the borrower address**

In `frontend/components/LenderDashboard.tsx`, at BOTH `<LoanSafetyPanel ... assessment={...} />` call sites, add:

```tsx
                        borrower={terms.borrower}
```

(`terms.borrower` is already on the terms object each card renders from; confirm the exact property name at the call site before editing — if it is `terms.borrower` elsewhere in the card, use that.)

- [ ] **Step 2: Add verification to `LoanSafetyPanel.tsx`**

1. Props: add `borrower?: string | null;` to `Props` and to the destructuring.

2. Imports:
```ts
import { verifyTypedData } from 'viem';
import { termSheetHash } from '../lib/termsheet-canonical';
import { TERM_SHEET_TYPES, parseMessage, PINATA_GATEWAY } from '../lib/termsheet-typed-data';
```

3. State + handler inside the component:
```ts
  type VerifyState = 'idle' | 'checking' | 'verified' | 'mismatch' | 'error';
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifyDetail, setVerifyDetail] = useState<string | null>(null);

  async function verifyTermSheet() {
    if (!assessment?.termSheetCid || !assessment.termSheetHash) return;
    setVerifyState('checking');
    setVerifyDetail(null);
    try {
      const res = await fetch(`${PINATA_GATEWAY}${assessment.termSheetCid}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`gateway ${res.status}`);
      const payload = (await res.json()) as Record<string, unknown>;

      // 1. Content integrity: the fetched document hashes to the stored hash.
      if (termSheetHash(payload) !== assessment.termSheetHash.toLowerCase()) {
        setVerifyState('mismatch');
        setVerifyDetail('The document on IPFS does not match the hash saved at loan creation.');
        return;
      }

      // 2. Signature: the signer really signed these terms, and is this loan's borrower.
      const message = parseMessage(payload.message as Record<string, unknown>);
      const signer = String(payload.signer ?? '');
      const sigOk = await verifyTypedData({
        address: signer as `0x${string}`,
        domain: payload.domain as { name: string; version: string; chainId: number },
        types: TERM_SHEET_TYPES,
        primaryType: 'LoanTermSheet',
        message,
        signature: String(payload.signature ?? '') as `0x${string}`,
      });
      const isBorrower = !borrower || signer.toLowerCase() === borrower.toLowerCase();
      if (sigOk && isBorrower) {
        setVerifyState('verified');
      } else {
        setVerifyState('mismatch');
        setVerifyDetail(sigOk
          ? 'Signature is valid but the signer is not this loan\'s borrower.'
          : 'The EIP-712 signature does not verify against the pinned terms.');
      }
    } catch {
      setVerifyState('error');
      setVerifyDetail('Could not fetch the term sheet from the IPFS gateway. Try again in a moment.');
    }
  }
```

Note: `verifyState`/`mismatch` never fires on a network failure — a gateway error is reported as `error` ("could not fetch"), never as a false mismatch (spec requirement).

4. Render, directly under the provenance line added in Task 4 (inside the `assessment && contributions` block):

```tsx
              {assessment.termSheetCid && assessment.termSheetHash && (
                <div className="mt-2 rounded-lg border border-slate-700/60 bg-slate-900/40 p-2.5 space-y-1.5">
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Term sheet anchored on IPFS</p>
                  <p className="text-[10px] text-slate-500 break-all">
                    <a
                      href={`${PINATA_GATEWAY}${assessment.termSheetCid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline font-mono"
                    >
                      {assessment.termSheetCid}
                    </a>
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={verifyTermSheet}
                      disabled={verifyState === 'checking'}
                      className="rounded-md border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {verifyState === 'checking' ? 'Verifying…' : 'Verify hash & signer'}
                    </button>
                    {verifyState === 'verified' && (
                      <span className="text-[10px] font-semibold text-emerald-400">Verified: hash and borrower signature match</span>
                    )}
                    {verifyState === 'mismatch' && (
                      <span className="text-[10px] font-semibold text-red-400">Mismatch</span>
                    )}
                    {verifyState === 'error' && (
                      <span className="text-[10px] font-semibold text-amber-400">Gateway unreachable</span>
                    )}
                  </div>
                  {verifyDetail && <p className="text-[10px] text-slate-500">{verifyDetail}</p>}
                </div>
              )}
```

- [ ] **Step 3: Verify**

```bash
cd frontend && npx tsc --noEmit && npm run lint && node --test "lib/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: clean, 164 pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/LoanSafetyPanel.tsx frontend/components/LenderDashboard.tsx
git commit -m "feat: lender-side IPFS term-sheet verification (hash + EIP-712 signer)"
```

---

### Task 8: Docs, env examples, and final verification

**Files:**
- Modify: `frontend/.env.example` (document `CREDIT_BACKEND_URL`, `PINATA_JWT`)
- Modify: `report.md` (correct the EIP-712 claim; add Phase 6 section + manual-steps checklist)
- Modify: `planv2.md` (mark Phase 6 item statuses)

**Interfaces:** none — documentation and verification only.

- [ ] **Step 1: `.env.example` additions**

Append to `frontend/.env.example`:

```bash
# FastAPI credit-scoring backend (Render). Unset = wallet-mode scoring falls back to rule-based.
CREDIT_BACKEND_URL=https://nexusfi-credit-api.onrender.com

# Pinata JWT for IPFS term-sheet anchoring. Unset = term sheets are signed but not pinned.
PINATA_JWT=
```

- [ ] **Step 2: `report.md` updates**

1. In the one-paragraph summary, replace "The borrower signs an EIP-712 term sheet" context: the claim is now true — keep the sentence but it must reflect that signing was ADDED in Phase 6 (it did not exist before). In the "What is implemented" frontend-borrower section, add a Phase 6 subsection:

```markdown
### Phase 6 - ML deployment, model versioning, IPFS term sheets (shipped 2026-08-21)

- **Credit backend deployable via `render.yaml`** (Render free tier). Wallet-mode scoring now
  runs the real LightGBM + SHAP pipeline with live Alchemy chain fetching when
  `CREDIT_BACKEND_URL` is set; the rule-based scorer remains the automatic fallback.
  Free-tier note: the service sleeps after 15 min idle (~50s wake); the wizard fires a
  warm-up ping on wallet-mode entry and the fallback copy explains the wake.
- **Model versioning**: `train.py` stamps `model_meta.json` (version = content hash of the
  model file); every score response carries `model_version`; migration 006 persists it per
  loan and the lender safety panel shows which scorer priced the loan.
- **EIP-712 term-sheet signing + IPFS anchoring**: correction - before Phase 6 no EIP-712
  signing existed despite earlier claims in this report; the "term sheet" was an unsigned
  computed object. Wallet-mode borrowers now sign a LoanTermSheet typed message; the signed
  document is pinned to Pinata, the CID + keccak256 canonical hash persist with the risk
  assessment, and lenders can fetch, re-hash, and verify the signer from the safety panel.
  Best-effort: declined signature or failed pin never blocks loan creation. Persona/demo
  loans do not sign or pin.
- **Manual setup**: (1) Render Blueprint from `render.yaml` + paste `ALCHEMY_API_KEY`;
  (2) set `CREDIT_BACKEND_URL` and `PINATA_JWT` on all four Vercel deployments;
  (3) run migration `006_model_version_and_termsheets.sql` in the Supabase SQL editor.
- Deferred from Phase 6 (documented in planv2.md): ERC-20 principal and on-chain KYC
  (batch with a Phase 4 Option B redeploy), real KYT (paid APIs).
```

2. Also fix the intro summary sentence "The borrower signs an EIP-712 term sheet, lenders browse..." — it is accurate post-Phase-6; leave it, but ensure no other stale claim contradicts the correction note.

- [ ] **Step 3: `planv2.md` Phase 6 status**

In the Phase 6 section, annotate each bullet:

```markdown
- **IPFS-anchored term sheets** - DONE 2026-08-21 (hash + CID off-chain in Supabase; on-chain anchoring deferred to a Phase 4 Option B redeploy).
- **Real ML with SHAP + versioning/MLOps** - DONE 2026-08-21 (Render deploy via render.yaml, content-hash model versioning; rule-based path kept as fallback).
- **MockERC20 as an alternative loan asset** - DEFERRED: every value path in the pooled Loan.sol is ETH-native; batch with the Phase 4 Option B redeploy.
- **Real `extract_features(wallet_address)` pipeline** - DONE (already implemented in backend/app/services/chain_fetcher.py via Alchemy mainnet+Sepolia; now actually reachable in production).
- **Decentralized identity / on-chain KYC** - DEFERRED: enforcing KYCRegistry in createLoan() needs a redeploy; batch with Phase 4 Option B.
- **Real KYT** - DEFERRED: Chainalysis/TRM APIs are paid; mock stays, still flagged as mock.
```

- [ ] **Step 4: Full verification sweep**

```bash
cd frontend && npx tsc --noEmit && npm run lint && node --test "lib/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"
cd ../backend && venv/Scripts/python tests/test_model_meta.py
```
Expected: tsc silent, lint clean, `tests 164 / pass 164 / fail 0`, backend `all tests passed`. Contract tests untouched by this work (no `contracts/` changes) — do not re-run unless something under `contracts/` changed.

- [ ] **Step 5: Commit**

```bash
git add frontend/.env.example report.md planv2.md
git commit -m "docs: Phase 6 off-chain shipped - report, plan status, env examples"
```

---

## Post-plan manual steps (user, not the implementer)

1. Render: New → Blueprint → this repo, branch `atharva`; paste `ALCHEMY_API_KEY`.
2. Vercel ×4: set `CREDIT_BACKEND_URL=https://<service>.onrender.com` and `PINATA_JWT`.
3. Pinata: create account + JWT.
4. Supabase SQL editor: run `006_model_version_and_termsheets.sql`.
5. Live smoke test: wallet-mode loan on a deployed frontend → SHAP contributions + model version visible to a lender; Verify button confirms the pinned term sheet.
