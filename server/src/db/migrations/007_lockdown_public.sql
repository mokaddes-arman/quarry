-- =============================================================================
-- 007_lockdown_public.sql - close the Supabase PostgREST exposure
--
-- Supabase publishes every table in an exposed schema over its REST API, and
-- grants the `anon` / `authenticated` roles access to tables created in
-- `public`. This application talks to PostgreSQL directly (as the table owner),
-- so it needs neither of those roles. Without this migration, a project pointed
-- at Supabase would let anyone holding the public anon key read every document,
-- chat message and provider credential ciphertext.
--
-- What this migration does (all of it is a no-op on plain PostgreSQL/PGlite,
-- where the Supabase roles do not exist):
--   1. revokes table/sequence/function privileges from anon and authenticated;
--   2. revokes future default privileges, so later migrations cannot re-open it;
--   3. enables row level security on every table in `public` with no policies,
--      which denies every non-owner role even if a grant is re-introduced;
--   4. revokes schema usage from both roles.
--
-- The table owner (the role this app connects as) bypasses RLS and keeps full
-- access, so the application is unaffected.
--
-- IMPORTANT: for a Supabase project you should ALSO remove `public` from
-- Settings -> API -> Exposed schemas. This migration is defence in depth, not a
-- substitute for turning the exposure off at the edge. Run
-- `npm run check` to verify the lock is in place.
-- =============================================================================

DO $$
DECLARE
  role_name text;
  tbl record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', role_name);
    END IF;
  END LOOP;

  -- RLS on every base table in public. No policies are created, so any role
  -- that is not the owner (or BYPASSRLS) is denied.
  FOR tbl IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl.tablename);
  END LOOP;
END $$;
