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
