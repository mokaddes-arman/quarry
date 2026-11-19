-- 013_rebrand_embed_default.sql - Quarry rebrand: new default widget colour.
-- Only the column default changes; existing embeds keep their stored colour.
ALTER TABLE project_embeds ALTER COLUMN theme_color SET DEFAULT '#2F5D62';
