-- =============================================================================
-- 009_user_passwords.sql - password login + password reset links
--
-- The account model becomes dual-mode:
--   * passwordless magic links (invite / sign-in / password reset) - unchanged;
--   * a password the user sets for themselves (from a magic link or the login
--     form) once they have an account.
--
-- `password_hash` is NULL until the user sets a password, so existing
-- installations keep working with links alone. The hash is `scrypt:<salt>:<hash>`.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at timestamptz;

-- Allow the password-reset purpose alongside 'invite' and 'login'.
ALTER TABLE auth_login_tokens DROP CONSTRAINT IF EXISTS auth_login_tokens_purpose_check;
ALTER TABLE auth_login_tokens ADD CONSTRAINT auth_login_tokens_purpose_check
  CHECK (purpose IN ('invite', 'login', 'password_reset'));
