-- Migration 002: Add user_role column (missing from 001) and set up Row Level Security.
-- Run this in the Supabase dashboard SQL editor after 001_init.sql.
--
-- With RLS in place, API routes work with just the Supabase anon key + user JWT,
-- so SUPABASE_SERVICE_ROLE_KEY is no longer required for teammates to run the app.

-- ── user_role column ──────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS user_role TEXT;

-- ── Enable RLS on every table ─────────────────────────────────────────────────
ALTER TABLE profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE linked_wallets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_screenings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;

-- ── profiles: each user can read and write their own row ─────────────────────
DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- ── linked_wallets: each user can CRUD their own wallets ─────────────────────
DROP POLICY IF EXISTS "wallets_select_own" ON linked_wallets;
CREATE POLICY "wallets_select_own" ON linked_wallets
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "wallets_insert_own" ON linked_wallets;
CREATE POLICY "wallets_insert_own" ON linked_wallets
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "wallets_update_own" ON linked_wallets;
CREATE POLICY "wallets_update_own" ON linked_wallets
  FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "wallets_delete_own" ON linked_wallets;
CREATE POLICY "wallets_delete_own" ON linked_wallets
  FOR DELETE USING (user_id = auth.uid());

-- ── wallet_screenings: each user can read and insert their own screenings ─────
DROP POLICY IF EXISTS "screenings_select_own" ON wallet_screenings;
CREATE POLICY "screenings_select_own" ON wallet_screenings
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "screenings_insert_own" ON wallet_screenings;
CREATE POLICY "screenings_insert_own" ON wallet_screenings
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "screenings_update_own" ON wallet_screenings;
CREATE POLICY "screenings_update_own" ON wallet_screenings
  FOR UPDATE USING (user_id = auth.uid());

-- ── audit_logs: any signed-in user can insert; read only own rows ─────────────
DROP POLICY IF EXISTS "audit_logs_select_own" ON audit_logs;
CREATE POLICY "audit_logs_select_own" ON audit_logs
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "audit_logs_insert_auth" ON audit_logs;
CREATE POLICY "audit_logs_insert_auth" ON audit_logs
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
