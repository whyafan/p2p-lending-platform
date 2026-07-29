-- Migration 004: ETH/USD price captured per settlement event.
-- Run in the Supabase SQL editor after 003_loan_risk_assessments.sql.
--
-- Why: a Tax P&L needs the price at the moment of each disposal, not today's
-- price. Nothing on-chain records it (Loan stores only priceAtFunding), so the
-- app snapshots the market price the first time it observes an event and keeps
-- it. Events that happened before this existed have no row; statements label
-- those as estimated at the current price rather than inventing a number.

CREATE TABLE IF NOT EXISTS event_price_snapshots (
  tx_hash      TEXT NOT NULL,
  log_kind     TEXT NOT NULL,
  loan_contract TEXT,
  eth_usd      NUMERIC NOT NULL,
  -- Block time of the event where known, so a snapshot taken late is still
  -- attributable to when the event actually happened.
  event_at     TIMESTAMPTZ,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_kind)
);

CREATE INDEX IF NOT EXISTS event_price_snapshots_loan_idx
  ON event_price_snapshots (loan_contract);

ALTER TABLE event_price_snapshots ENABLE ROW LEVEL SECURITY;

-- Readable by any signed-in user: both sides of a loan need the same figures,
-- and a public market price is not private data.
DROP POLICY IF EXISTS "event_prices_select_all_authenticated" ON event_price_snapshots;
CREATE POLICY "event_prices_select_all_authenticated" ON event_price_snapshots
  FOR SELECT TO authenticated USING (true);

-- Insert-only, never updated: a price snapshot is a historical record. First
-- observation wins, so nobody can restate the value a statement was built on.
DROP POLICY IF EXISTS "event_prices_insert_authenticated" ON event_price_snapshots;
CREATE POLICY "event_prices_insert_authenticated" ON event_price_snapshots
  FOR INSERT TO authenticated WITH CHECK (true);
