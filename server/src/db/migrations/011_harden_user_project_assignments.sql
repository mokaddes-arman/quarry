-- =============================================================================
-- 011_harden_user_project_assignments.sql - close Supabase exposure for 010
--
-- user_projects is created after 007_lockdown_public.sql, so it does not
-- inherit that migration's per-table RLS/privilege hardening. Tables created
-- later still get the revoked default privileges on Supabase, but enabling RLS
-- explicitly keeps this table denied even if a grant is reintroduced.
--
-- The application connects as the table owner and bypasses RLS, so this does
-- not affect normal use.
-- =============================================================================

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.user_projects FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE user_projects ENABLE ROW LEVEL SECURITY;
