-- =============================================================================
-- 010_user_project_assignments.sql - many-to-many user <-> project access
--
-- Previously a project belonged to exactly one user (projects.owner_user_id).
-- Administrators can now assign a user to one project or to many projects, so
-- a normal user may be granted access to a project without owning it.
--
-- Ownership is retained: a project keeps its owner (owner_user_id) and an
-- assignment simply grants access in addition. Deleting a user cascades away
-- the assignment rows.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_projects (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_user_projects_user ON user_projects (user_id);
CREATE INDEX IF NOT EXISTS idx_user_projects_project ON user_projects (project_id);
