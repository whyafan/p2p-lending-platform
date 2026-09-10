-- Migration 006: Phase 6 off-chain provenance columns.
-- Run in the Supabase SQL editor after 005_public_profiles_view.sql.
--
-- HARD PREREQUISITE for the Phase 6 frontend: the risk route selects these
-- columns unconditionally. Deploying the new frontend before this migration
-- runs breaks ALL risk-assessment reads and writes (every select/insert
-- 500s), not just the new fields. Run this migration first.
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
