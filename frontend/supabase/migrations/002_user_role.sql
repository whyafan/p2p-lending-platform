-- User role preference. NULL = not yet chosen (prompted in onboarding).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS user_role TEXT;
