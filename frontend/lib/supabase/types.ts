export type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  kyc_status: string;
  didit_session_id: string | null;
  kyc_provider: string;
  verified_at: string | null;
  rejection_reason: string | null;
  user_role: string | null;
  created_at: string;
  updated_at: string;
};

export type LinkedWallet = {
  id: string;
  user_id: string;
  wallet_address: string;
  chain_id: number;
  is_primary: boolean;
  signature_verified: boolean;
  verified_at: string | null;
  nonce: string | null;
  nonce_expires_at: string | null;
  created_at: string;
};

export type WalletScreening = {
  id: string;
  user_id: string;
  wallet_address: string;
  risk_score: number;
  risk_level: string;
  flags: string;
  screened_at: string;
};

export type AuditLog = {
  id: string;
  user_id: string | null;
  action: string;
  metadata: string | null;
  created_at: string;
};
