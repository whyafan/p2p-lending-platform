-- Migration 003: Persist the borrower's risk explanation so lenders can see it.
-- Run this in the Supabase dashboard SQL editor after 002_rls_and_user_role.sql.
--
-- Why this exists: the 8-feature risk score is computed in the borrower's browser
-- at loan-request time and, until now, thrown away the moment the page unmounts.
-- Only the resulting tier survived, baked into the on-chain terms as maxLtvBps /
-- interestBps. That left lenders with a letter grade and no reasoning — the exact
-- "ledger transparency is not decision transparency" gap the literature review
-- calls out. This table keeps the explanation alongside the loan.
--
-- Keyed by the Loan contract address rather than the numeric loan ID: the address
-- is globally unique (no chain/factory ambiguity across redeploys) and it is what
-- the lender dashboard already has in hand.

CREATE TABLE IF NOT EXISTS loan_risk_assessments (
  loan_contract   TEXT PRIMARY KEY,
  chain_id        INTEGER NOT NULL,
  borrower_wallet TEXT,
  -- Snapshot of the assessment at request time
  tier            TEXT NOT NULL CHECK (tier IN ('A', 'B', 'C')),
  overall_score   NUMERIC NOT NULL,
  -- Full FeatureContribution[]: feature, category, value, score, weight, description
  contributions   JSONB NOT NULL,
  -- 'persona' (synthetic demo profile) or 'wallet' (real on-chain extraction)
  source          TEXT,
  persona_id      TEXT,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_risk_assessments_chain_idx
  ON loan_risk_assessments (chain_id);

ALTER TABLE loan_risk_assessments ENABLE ROW LEVEL SECURITY;

-- Readable by ANY signed-in user, not just the borrower. That is the whole point:
-- a lender evaluating someone else's loan must be able to see why it was priced
-- the way it was. The row holds no PII — only derived risk signals that already
-- determine the public on-chain terms.
DROP POLICY IF EXISTS "loan_risk_select_all_authenticated" ON loan_risk_assessments;
CREATE POLICY "loan_risk_select_all_authenticated" ON loan_risk_assessments
  FOR SELECT TO authenticated USING (true);

-- Only the signed-in user who created the loan may write its assessment, and
-- rows are immutable afterwards (no UPDATE/DELETE policy) so a borrower cannot
-- retroactively improve the explanation a lender already acted on.
DROP POLICY IF EXISTS "loan_risk_insert_own" ON loan_risk_assessments;
CREATE POLICY "loan_risk_insert_own" ON loan_risk_assessments
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
