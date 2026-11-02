'use strict';

const { query } = require('../db');
const { AppError, Codes } = require('../lib/errors');
const { getConversation } = require('./conversations');

/**
 * Administrator-only conversation review.
 *
 * Administrators see three distinct scopes:
 *   - mine     : their own internal chats
 *   - users    : internal chats created by everybody else
 *   - external : conversations started from a public widget
 *   - all      : everything (used by the "All" tab)
 *
 * External conversations deliberately use the same tables as internal ones so
 * the RAG pipeline is shared, but they are excluded from every normal chat
 * surface and only appear here.
 */

const SCOPES = new Set(['mine', 'users', 'external', 'all']);

function scopeClause(scope, actorId, params) {
  switch (scope) {
    case 'mine':
      params.push(actorId);
      return `c.channel = 'internal' AND c.owner_user_id = $${params.length}`;
    case 'users':
      params.push(actorId);
      return `c.channel = 'internal' AND (c.owner_user_id IS NULL OR c.owner_user_id <> $${params.length})`;
    case 'external':
      return "c.channel = 'external'";
    case 'all':
    default:
      return 'TRUE';
  }
}

function filters({ projectId, userId, search }, params) {
  const conditions = [];
  if (projectId) {
    params.push(projectId);
    conditions.push(`c.project_id = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    conditions.push(`c.owner_user_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).replace(/[%_]/g, '\\$&')}%`);
    const ref = `$${params.length}`;
    conditions.push(
      `(c.title ILIKE ${ref} OR c.visitor_name ILIKE ${ref} OR c.visitor_email ILIKE ${ref} OR u.email ILIKE ${ref} OR u.name ILIKE ${ref})`,
    );
  }
  return conditions;
}

async function list({ scope = 'all', projectId = null, userId = null, search = null, limit = 50, offset = 0, actorId }) {
  const normalizedScope = SCOPES.has(scope) ? scope : 'all';
  const params = [];
  const where = [scopeClause(normalizedScope, actorId, params), ...filters({ projectId, userId, search }, params)];

  const countParams = [];
  const countWhere = filters({ projectId, userId, search }, countParams);
  countParams.push(actorId);
  const actorRef = `$${countParams.length}`;
  const { rows: countRows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE c.channel = 'internal' AND c.owner_user_id = ${actorRef})::int AS mine,
       COUNT(*) FILTER (WHERE c.channel = 'internal' AND (c.owner_user_id IS NULL OR c.owner_user_id <> ${actorRef}))::int AS users,
       COUNT(*) FILTER (WHERE c.channel = 'external')::int AS external,
       COUNT(*)::int AS all
     FROM conversations c
     LEFT JOIN users u ON u.id = c.owner_user_id
     ${countWhere.length ? `WHERE ${countWhere.join(' AND ')}` : ''}`,
    countParams,
  );

  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
  const { rows } = await query(
    `SELECT c.id, c.project_id, c.owner_user_id, c.channel, c.title, c.archived,
            c.visitor_id, c.visitor_name, c.visitor_email, c.consent_accepted_at,
            c.created_at, c.updated_at,
            p.name AS project_name,
            u.email AS owner_email, u.name AS owner_name,
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
     FROM conversations c
     JOIN projects p ON p.id = c.project_id
     LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    scope: normalizedScope,
    counts: countRows[0] || { mine: 0, users: 0, external: 0, all: 0 },
    conversations: rows,
  };
}

async function get(id) {
  const { rows } = await query(
    `SELECT c.*, p.name AS project_name, u.email AS owner_email, u.name AS owner_name
     FROM conversations c
     JOIN projects p ON p.id = c.project_id
     LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) {
    throw new AppError('Conversation not found.', { code: Codes.NOT_FOUND, status: 404 });
  }
  const full = await getConversation(id);
  return {
    conversation: {
      ...rows[0],
      messages: full.messages,
    },
    messages: full.messages,
    sources: full.sources,
  };
}

async function remove(id) {
  const { rows } = await query('DELETE FROM conversations WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) {
    throw new AppError('Conversation not found.', { code: Codes.NOT_FOUND, status: 404 });
  }
  return rows[0];
}

module.exports = { list, get, remove, SCOPES };
