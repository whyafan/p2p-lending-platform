-- Run this in the Supabase dashboard SQL editor (or via: supabase db push).

-- profiles: app-specific data extending auth.users
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT        NOT NULL,
  display_name    TEXT,
  kyc_status      TEXT        NOT NULL DEFAULT 'NOT_STARTED',
  didit_session_id TEXT,
  kyc_provider    TEXT        NOT NULL DEFAULT 'didit',
  verified_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  user_role       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- linked_wallets: EIP-191 verified wallet addresses per user
CREATE TABLE IF NOT EXISTS linked_wallets (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wallet_address     TEXT        NOT NULL,
  chain_id           INT         NOT NULL,
  is_primary         BOOLEAN     NOT NULL DEFAULT FALSE,
  signature_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  verified_at        TIMESTAMPTZ,
  nonce              TEXT,
  nonce_expires_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wallet_address, chain_id)
);
CREATE INDEX IF NOT EXISTS linked_wallets_user_id_idx ON linked_wallets(user_id);

-- wallet_screenings: KYT risk scores
CREATE TABLE IF NOT EXISTS wallet_screenings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wallet_address TEXT        NOT NULL,
  risk_score     INT         NOT NULL,
  risk_level     TEXT        NOT NULL,
  flags          TEXT        NOT NULL DEFAULT '',
  screened_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, wallet_address)
);
CREATE INDEX IF NOT EXISTS wallet_screenings_wallet_address_idx ON wallet_screenings(wallet_address);
CREATE INDEX IF NOT EXISTS wallet_screenings_user_id_idx        ON wallet_screenings(user_id);

-- audit_logs: append-only event trail
CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  action     TEXT        NOT NULL,
  metadata   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs(user_id);
