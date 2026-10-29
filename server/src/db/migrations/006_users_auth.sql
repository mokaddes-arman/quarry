-- =============================================================================
-- 006_users_auth.sql - accounts, email login links and sessions
--
-- Authentication model:
--   * a user is created by an admin (role "user") or during first-run setup
--     (role "admin");
--   * sign-in is passwordless: a single-use token is emailed as a login link;
--   * only the SHA-256 hash of a token or session id is stored, so a database
--     dump cannot be replayed to log in.
--
-- Ownership: a project belongs to exactly one user. Normal users only ever see
-- their own projects; admins can see everything. Projects created before this
-- migration are claimed by the first user (see server/src/services/users.js).
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  -- Lower-cased, trimmed form used for uniqueness and lookup.
  email_normalised text NOT NULL,
  name             text,
  role             text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status           text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalised ON users (email_normalised);
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, status);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- auth_login_tokens : single-use magic-link tokens (invite + sign-in)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_login_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  purpose     text NOT NULL CHECK (purpose IN ('invite', 'login')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_login_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expiry ON auth_login_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- auth_sessions : browser sessions (cookie value is never stored)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- projects.owner_user_id : per-user isolation
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_user_id);
