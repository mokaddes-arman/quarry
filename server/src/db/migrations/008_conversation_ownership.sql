-- =============================================================================
-- 008_conversation_ownership.sql - per-user conversation visibility
--
-- A project has one owner, but administrators can open that project too. A
-- conversation belongs to the person who created it:
--   * normal users only see and open conversations they created;
--   * administrators can still see every conversation in every project.
--
-- Existing conversations are assigned to the project owner so their history
-- remains visible to that user. Conversations created by an administrator in
-- somebody else's project from this point on stay private to administrators.
-- =============================================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE conversations c
SET owner_user_id = p.owner_user_id
FROM projects p
WHERE c.project_id = p.id
  AND c.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_owner
  ON conversations (project_id, owner_user_id, archived, updated_at DESC);
