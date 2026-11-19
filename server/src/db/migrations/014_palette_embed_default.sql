-- 014_palette_embed_default.sql - Quarry palette update: Deep Navy widget default.
-- Embeds still on the short-lived slate-teal default from 013 move to the new
-- default; any other colour an owner picked is left untouched.
ALTER TABLE project_embeds ALTER COLUMN theme_color SET DEFAULT '#172A3A';
UPDATE project_embeds SET theme_color = '#172A3A' WHERE lower(theme_color) = '#2f5d62';
