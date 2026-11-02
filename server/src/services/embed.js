'use strict';

const { query } = require('../db');
const { AppError, Codes } = require('../lib/errors');
const { randomToken, sha256 } = require('../lib/ids');
const { requireProjectOwner } = require('./projects');
const storage = require('../lib/storage');
const { sanitiseFilename, buildEmbedLogoPath } = require('./storage/paths');
const { config } = require('../config/env');

/**
 * Public widget embeds.
 *
 * A project has one embed configuration. Visitors identify themselves with a
 * name, an email address and (when enabled) consent. Only the SHA-256 hash of
 * the visitor token is stored. External conversations use the normal
 * conversations/messages tables with channel = 'external' and are only visible
 * in the administrator conversation viewer.
 */

function normalizeOrigin(origin) {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function originAllowed(embed, origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return true; // same-origin / non-browser client
  const list = Array.isArray(embed.allowed_origins) ? embed.allowed_origins : [];
  if (!list.length || list.includes('*')) return true;
  return list.map((item) => normalizeOrigin(item)).filter(Boolean).includes(normalized);
}

async function getEmbedByProject(projectId) {
  const { rows } = await query('SELECT * FROM project_embeds WHERE project_id = $1', [projectId]);
  return rows[0] || null;
}

async function getEmbedByKey(publicKey) {
  const { rows } = await query(
    `SELECT pe.*, p.name AS project_name
       FROM project_embeds pe
       JOIN projects p ON p.id = pe.project_id
      WHERE pe.public_key = $1`,
    [publicKey],
  );
  return rows[0] || null;
}

async function ensureEmbed(projectId, { user }) {
  await requireProjectOwner(projectId, { user });
  const existing = await getEmbedByProject(projectId);
  if (existing) return existing;
  const { rows } = await query(
    `INSERT INTO project_embeds (project_id, public_key, created_by)
     VALUES ($1,$2,$3)
     RETURNING *`,
    [projectId, randomToken(32), user?.id || null],
  );
  return rows[0];
}

async function updateEmbed(projectId, { user }, patch) {
  await requireProjectOwner(projectId, { user });
  let embed = await getEmbedByProject(projectId);
  if (!embed) embed = await ensureEmbed(projectId, { user });

  const sets = [];
  const params = [];
  const push = (col, value) => sets.push(`${col} = $${params.push(value)}`);
  if (patch.enabled !== undefined) push('enabled', patch.enabled);
  if (patch.allowedOrigins !== undefined) push('allowed_origins', JSON.stringify(patch.allowedOrigins));
  if (patch.brandName !== undefined) push('brand_name', patch.brandName);
  if (patch.slogan !== undefined) push('slogan', patch.slogan);
  if (patch.logoUrl !== undefined) push('logo_url', patch.logoUrl);
  if (patch.themeColor !== undefined) push('theme_color', patch.themeColor);
  if (patch.welcomeMessage !== undefined) push('welcome_message', patch.welcomeMessage);
  if (patch.consentRequired !== undefined) push('consent_required', patch.consentRequired);
  if (patch.consentTitle !== undefined) push('consent_title', patch.consentTitle);
  if (patch.consentBody !== undefined) push('consent_body', patch.consentBody);
  if (patch.consentUrl !== undefined) push('consent_url', patch.consentUrl);
  if (!sets.length) return embed;

  params.push(embed.id);
  const { rows } = await query(
    `UPDATE project_embeds SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length} RETURNING *`,
    params,
  );
  return rows[0];
}

async function rotateEmbedKey(projectId, { user }) {
  await requireProjectOwner(projectId, { user });
  let embed = await getEmbedByProject(projectId);
  if (!embed) embed = await ensureEmbed(projectId, { user });
  const { rows } = await query(
    'UPDATE project_embeds SET public_key = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [randomToken(32), embed.id],
  );
  return rows[0];
}

async function saveEmbedLogo(projectId, { user }, file) {
  await requireProjectOwner(projectId, { user });
  const embed = await ensureEmbed(projectId, { user });
  const relativePath = buildEmbedLogoPath({
    projectId,
    embedId: embed.id,
    folder: config.supabaseStorage.logoFolder,
    originalFilename: sanitiseFilename(file.originalname || 'logo.png'),
  });
  await storage.moveFileIntoStorage(file.path, relativePath);
  if (embed.logo_path && embed.logo_path !== relativePath) {
    await storage.deleteStoredFile(embed.logo_path).catch(() => {});
  }
  const { rows } = await query(
    `UPDATE project_embeds
        SET logo_path = $1, logo_mime = $2, logo_url = NULL, updated_at = now()
      WHERE id = $3 RETURNING *`,
    [relativePath, file.mimetype || null, embed.id],
  );
  return rows[0];
}

async function deleteEmbedLogo(projectId, { user }) {
  await requireProjectOwner(projectId, { user });
  const embed = await getEmbedByProject(projectId);
  if (!embed) return null;
  if (embed.logo_path) await storage.deleteStoredFile(embed.logo_path).catch(() => {});
  const { rows } = await query(
    `UPDATE project_embeds
        SET logo_path = NULL, logo_mime = NULL, logo_url = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [embed.id],
  );
  return rows[0];
}

async function readEmbedLogo(embed) {
  if (!embed?.logo_path) return null;
  try {
    return { buffer: await storage.readStoredFile(embed.logo_path), mime: embed.logo_mime || 'application/octet-stream' };
  } catch {
    return null;
  }
}

async function registerVisitor(embed, { name, email, userAgent, ip }) {
  const token = randomToken(32);
  const { rows } = await query(
    `INSERT INTO embed_visitors
       (embed_id, name, email, email_normalised, token_hash, user_agent, ip, consent_accepted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     RETURNING *`,
    [embed.id, String(name).trim(), String(email).trim(), String(email).trim().toLowerCase(), sha256(token), userAgent || null, ip || null],
  );
  return { visitor: rows[0], token };
}

async function verifyVisitor(embedId, token) {
  if (!token) return null;
  const { rows } = await query('SELECT * FROM embed_visitors WHERE embed_id = $1 AND token_hash = $2', [
    embedId,
    sha256(token),
  ]);
  if (!rows[0]) return null;
  await query('UPDATE embed_visitors SET last_seen_at = now() WHERE id = $1', [rows[0].id]);
  return rows[0];
}

async function latestConversation(embedId, visitorId) {
  const { rows } = await query(
    `SELECT * FROM conversations
      WHERE embed_id = $1 AND visitor_id = $2 AND channel = 'external' AND archived = false
      ORDER BY updated_at DESC LIMIT 1`,
    [embedId, visitorId],
  );
  return rows[0] || null;
}

async function createExternalConversation({ embed, visitor }) {
  const { rows } = await query(
    `INSERT INTO conversations
       (project_id, owner_user_id, title, channel, embed_id, visitor_id,
        visitor_name, visitor_email, consent_accepted_at)
     VALUES ($1, NULL, 'New conversation', 'external', $2, $3, $4, $5, now())
     RETURNING *`,
    [embed.project_id, embed.id, visitor.id, visitor.name, visitor.email],
  );
  return rows[0];
}

async function assertVisitorConversation(embed, visitor, conversationId) {
  const { rows } = await query(
    `SELECT * FROM conversations
      WHERE id = $1 AND channel = 'external' AND embed_id = $2 AND visitor_id = $3`,
    [conversationId, embed.id, visitor.id],
  );
  if (!rows[0]) {
    throw new AppError('Conversation not found.', { code: Codes.NOT_FOUND, status: 404 });
  }
  return rows[0];
}

function serializeEmbedConfig(embed, { includeKeys = false } = {}) {
  return {
    id: embed.id,
    projectId: embed.project_id,
    projectName: embed.project_name || null,
    enabled: embed.enabled,
    allowedOrigins: embed.allowed_origins || [],
    brandName: embed.brand_name,
    slogan: embed.slogan,
    logoUrl: embed.logo_url,
    hasLogo: Boolean(embed.logo_path),
    themeColor: embed.theme_color,
    welcomeMessage: embed.welcome_message,
    consentRequired: embed.consent_required,
    consentTitle: embed.consent_title,
    consentBody: embed.consent_body,
    consentUrl: embed.consent_url,
    publicKey: includeKeys ? embed.public_key : undefined,
  };
}

module.exports = {
  getEmbedByProject,
  getEmbedByKey,
  ensureEmbed,
  updateEmbed,
  rotateEmbedKey,
  saveEmbedLogo,
  deleteEmbedLogo,
  readEmbedLogo,
  registerVisitor,
  verifyVisitor,
  latestConversation,
  createExternalConversation,
  assertVisitorConversation,
  serializeEmbedConfig,
  normalizeOrigin,
  originAllowed,
};
