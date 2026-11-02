-- =============================================================================
-- 012_project_embeds.sql - public widget embeds and external visitors
--
-- A project can be exposed as an embeddable chat widget on another website.
-- Each project has exactly one embed configuration (branding, consent screen,
-- allowed origins and a rotatable public key). Visitors identify themselves
-- with name + email and accept the configured consent text; only a hash of the
-- visitor token is stored, so a database dump cannot be replayed.
--
-- External conversations are kept in the same tables as internal ones but are
-- tagged with channel = 'external' so they never appear in the normal chat
-- history. Administrators can review them from the admin conversation viewer.
-- =============================================================================

CREATE TABLE IF NOT EXISTS project_embeds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  public_key        text NOT NULL UNIQUE,
  enabled           boolean NOT NULL DEFAULT true,
  allowed_origins   jsonb NOT NULL DEFAULT '[]'::jsonb,
  brand_name        text,
  slogan            text,
  logo_url          text,
  logo_path         text,
  logo_mime         text,
  theme_color       text NOT NULL DEFAULT '#2563eb',
  welcome_message   text,
  consent_required  boolean NOT NULL DEFAULT true,
  consent_title     text NOT NULL DEFAULT 'Before we start',
  consent_body      text NOT NULL DEFAULT 'This assistant answers questions from the project documentation. Your conversation and the name and email you provide are stored so an administrator can review and improve the service.',
  consent_url       text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_embeds_project ON project_embeds (project_id);
DROP TRIGGER IF EXISTS trg_project_embeds_updated_at ON project_embeds;
CREATE TRIGGER trg_project_embeds_updated_at BEFORE UPDATE ON project_embeds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS embed_visitors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  embed_id             uuid NOT NULL REFERENCES project_embeds(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  email                text NOT NULL,
  email_normalised     text NOT NULL,
  token_hash           text NOT NULL UNIQUE,
  consent_accepted_at  timestamptz,
  user_agent           text,
  ip                   text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_embed_visitors_embed ON embed_visitors (embed_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_embed_visitors_email ON embed_visitors (embed_id, email_normalised);

-- ---------------------------------------------------------------------------
-- conversations: origin of the conversation and the visitor snapshot
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'internal';
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('internal', 'external'));

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS embed_id uuid REFERENCES project_embeds(id) ON DELETE SET NULL;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS visitor_id uuid REFERENCES embed_visitors(id) ON DELETE SET NULL;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS visitor_name text;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS visitor_email text;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS consent_accepted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations (channel, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_visitor
  ON conversations (visitor_id, updated_at DESC);
