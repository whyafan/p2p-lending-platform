# Phase 6 (off-chain half) — ML backend deploy, model versioning, IPFS term sheets

> Approved design, 2026-08-21. Scope = planv2 Phase 6 Option A: the three items that need no
> contract change. ERC-20 principal, on-chain KYC, and real KYT are explicitly out of scope
> (contract items batch with Phase 4 Option B; KYT APIs are paid).

## Context

The FastAPI backend (`backend/`) already implements the full "real ML" pipeline: LightGBM +
SHAP inference (`app/ml/model.py`), live Alchemy chain fetching for mainnet + Sepolia
(`app/services/chain_fetcher.py`), believability cross-checks, and a trained
`credit_model.pkl`. The frontend proxy (`/api/credit/score`) and the wallet-mode wizard
already consume the full SHAP response shape. The actual gaps: the backend is deployed
nowhere (`CREDIT_BACKEND_URL` unset everywhere — root cause of closed bug B1), nothing
tracks a model version, and term sheets are neither signed nor anchored.

**Correction to `report.md`:** it claims "the borrower signs an EIP-712 term sheet" — no
EIP-712 signing exists anywhere in the code or git history. The "term sheet" is the computed
`LoanTermSheet` object from `calculateProtocolLoanTerms`. Part 3 adds the real signing step.

## Part 1 — Deploy the backend (Render free tier)

- `render.yaml` blueprint at repo root: one web service, root dir `backend/`, build
  `pip install -r requirements.txt`, start `uvicorn app.main:app --host 0.0.0.0 --port $PORT`,
  Python version pinned, `ALCHEMY_API_KEY` declared `sync: false` (pasted in the Render
  dashboard, never committed).
- `GET /health` endpoint on the FastAPI app (if `main.py` lacks one) for Render health checks
  and frontend warm-up pings.
- **Cold-start softening:** Render free sleeps after 15 min idle (~50s wake). When the wizard
  enters wallet mode, fire one non-blocking `GET` to the backend health route via the Next
  proxy so the wake starts while the user fills the form. Fallback copy updated to say the
  service may be waking — retry in a minute (alongside the existing switch-to-demo offer).
- Not doing: keep-alive cron to defeat sleep, Dockerfile, proxy timeout changes.

Manual steps (documented, not automated): create the Render service from the blueprint,
paste the Alchemy key, set `CREDIT_BACKEND_URL=https://<service>.onrender.com` on all four
Vercel deployments.

## Part 2 — Model versioning

- `train.py` writes `artifacts/model_meta.json` at train time:
  `{version, trained_at, n_samples, feature_names, lightgbm_params}`. `version` is a short
  content hash of `credit_model.pkl` (e.g. `v-3fa9c21`) — retraining automatically yields a
  new version, no counter to bump. A tiny backfill stamps meta for the existing pkl.
- `CreditScorer` loads the meta; `ScoreResponse` gains `model_version` (`null` when the
  rule-based fallback scored).
- Migration `006` adds nullable `model_version TEXT` to `loan_risk_assessments` (existing
  table, existing RLS and immutability untouched).
- The wizard threads `model_version` from the score response into the existing post-receipt
  risk-persist call. The lender's risk panel shows "Scored by model `v-xxxxxxx`" when
  present, "rule-based scorer" otherwise.
- Not doing: MLflow/registry, A/B serving, retraining pipelines, metrics dashboards.

## Part 3 — EIP-712 signing + IPFS anchoring (Pinata)

- **Signing (new):** in the wallet-mode wizard, before `createLoan()`, the borrower signs the
  term sheet via wagmi `useSignTypedData` with a `LoanTermSheet` typed-data definition
  (domain: NexusFi + chainId; message: principal, collateral, tenor, interestBps, maxLtvBps,
  liquidationBufferBps, borrower address, timestamp).
- **Pinning:** the wizard POSTs `{termSheet, signature, signerAddress}` to a new
  authenticated server route `/api/termsheet/pin` (Supabase session required), which:
  1. canonicalizes the JSON (sorted keys) via a pure helper `lib/termsheet-canonical.ts`,
  2. computes `keccak256` of the canonical bytes,
  3. pins to Pinata (`PINATA_JWT`, server-side only),
  4. returns `{cid, hash}`.
- **Persistence:** the same migration `006` adds nullable `term_sheet_cid TEXT` and
  `term_sheet_hash TEXT` to `loan_risk_assessments`. The wizard holds `{cid, hash}` in state
  and includes them in the existing post-receipt persist call.
- **Lender verification:** the lender's risk panel shows "Term sheet anchored on IPFS" with
  the CID linked to the Pinata gateway and a Verify button: fetch the JSON from the gateway,
  re-canonicalize + re-hash client-side, recover the EIP-712 signer, show match/mismatch
  against the stored hash and the loan's borrower address.
- Persona/demo loans skip signing and pinning entirely; the panel omits the section.
- Not doing: on-chain hash anchoring (needs a redeploy — batch with Phase 4 Option B).

## Error handling

- Pinata failure or signature decline: log a warning, proceed with loan creation, persist
  the assessment without CID/hash. Anchoring is best-effort, exactly like the existing
  risk-assessment persist.
- Backend unreachable: existing fallback path (rule-based scorer + switch-to-demo offer),
  now with wake-up copy.
- Gateway fetch failure on Verify: show "could not fetch from gateway", never a false
  mismatch.

## Testing

- `lib/termsheet-canonical.test.ts` — canonicalization is deterministic (key order,
  whitespace), hash is stable, a changed field changes the hash.
- Backend: one pytest smoke test — `CreditScorer` loads meta and returns `model_version`;
  train backfill produces valid meta.
- Existing suites must stay green: contract 54/54, frontend 157+/157+, `tsc --noEmit`.

## Manual steps checklist (user)

1. Render: new Blueprint service from `render.yaml`, paste `ALCHEMY_API_KEY`.
2. Vercel ×4: set `CREDIT_BACKEND_URL`, `PINATA_JWT`.
3. Pinata: sign up, create JWT.
4. Supabase: run migration `006` in the SQL editor.

## Exit criteria

- A real wallet on a deployed frontend gets an ML score with SHAP contributions and a
  model version, persisted and visible to lenders.
- A wallet-mode loan's signed term sheet is on IPFS; a lender can verify hash and signer
  from the UI.
- Backend down still degrades exactly as today.
