-- Run this in the Supabase dashboard SQL editor (or via: supabase db push).
-- Migration 005: peer discovery directory.
--
-- This migration is safe to re-run: CREATE OR REPLACE VIEW is idempotent.
-- If you already applied an earlier version of this file, re-running it is
-- REQUIRED to pick up the REVOKE statement added below - without it, the
-- view stays readable by anon/PUBLIC on a database where this already ran.
--
-- Exposes a narrow, non-PII slice of profiles + linked_wallets to every
-- authenticated user, without changing the existing RLS policies on the
-- base tables (migration 002). Postgres RLS is row-level, not column-level:
-- a policy that let other users read a profiles row at all would let them
-- read every column through it, including email. A view that only ever
-- selects the safe columns avoids that regardless of what a client asks for.
--
-- This view is created (and therefore owned) by the role running this SQL
-- editor script, which is not subject to the profiles/linked_wallets RLS
-- policies. That is intentional and required: the view has to see every
-- user's rows to build the directory, then its own JOIN condition below is
-- what actually restricts the result to verified-wallet users. Do not add
-- `WITH (security_invoker = true)` to this view - that would make it
-- re-apply the caller's RLS instead, and the directory would silently
-- return nothing for every user except themselves.

CREATE OR REPLACE VIEW public_profiles AS
SELECT
  p.id,
  p.display_name,
  p.kyc_status,
  p.user_role,
  lw.wallet_address
FROM profiles p
JOIN linked_wallets lw
  ON lw.user_id = p.id
 AND lw.is_primary = true
 AND lw.signature_verified = true;

GRANT SELECT ON public_profiles TO authenticated;

-- Supabase's default privileges grant ALL on every table/view in the public
-- schema to anon, authenticated, and service_role. A view created by the
-- postgres role (as this one is, from the SQL editor) inherits those grants,
-- so without this REVOKE the view would be readable by anon - i.e. by anyone
-- with the public anon key and no session at all. The view has no RLS of its
-- own (see note above on security_invoker), so this REVOKE is the only thing
-- standing between an anonymous caller and every verified user's profile.
-- Do not delete this as "redundant" - it is not, it is load-bearing.
REVOKE ALL ON public_profiles FROM anon, PUBLIC;
