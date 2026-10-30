'use strict';

/**
 * Per-user data isolation.
 *
 * A project has an owner and may additionally be assigned to other users.
 * Normal users may touch projects they own or that an administrator assigned
 * to them, plus everything that hangs off those projects; administrators may
 * touch everything. Conversations additionally belong to the user who created
 * them, so an administrator's chats in a user's project stay invisible to that
 * user. Foreign resources are reported as 404 (not 403) so the API never
 * confirms that somebody else's document, conversation or link exists.
 *
 * Route-level guards are the primary enforcement point. List queries also take
 * the actor so a missed guard cannot silently widen a result set.
 */
const { query } = require('../db');
const { AppError, Codes } = require('../lib/errors');
const { asyncHandler } = require('../middleware/errorHandler');

function isAdmin(user) {
  return user?.role === 'admin';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

function notFound(message) {
  return new AppError(message, { code: Codes.NOT_FOUND, status: 404 });
}

function malformed(message) {
  return new AppError(message, { code: Codes.BAD_REQUEST, status: 400 });
}

/**
 * SQL predicate for "the actor may read this project": owner or assigned.
 * `params` is mutated with the actor id (once, referenced twice). Returns an
 * empty string for administrators, who can read everything.
 */
function projectAccessClause(user, params, alias = 'p') {
  // Internal service calls (e.g. conversations.createConversation) do not have
  // an actor; they are only reached after a route-level access check.
  if (!user || isAdmin(user)) return '';
  const ref = `$${params.push(user.id)}`;
  return `(${alias}.owner_user_id = ${ref} OR EXISTS (
    SELECT 1 FROM user_projects up WHERE up.project_id = ${alias}.id AND up.user_id = ${ref}
  ))`;
}

async function assertProject(user, projectId) {
  // Check the shape before touching the database so a malformed id is a clean
  // 400 instead of a Postgres "invalid input syntax for uuid" 500.
  if (!isUuid(projectId)) throw malformed('Invalid project id.');
  if (!user) throw notFound('Project not found.');
  const params = [projectId];
  const scope = projectAccessClause(user, params);
  const { rows } = await query(
    `SELECT p.* FROM projects p WHERE p.id = $1${scope ? ` AND ${scope}` : ''}`,
    params,
  );
  if (!rows[0]) throw notFound('Project not found.');
  return rows[0];
}

/** Every project id the actor is allowed to read. Used by cross-project search. */
async function allowedProjectIds(user, { activeOnly = true } = {}) {
  if (!user) return [];
  const conditions = [];
  const params = [];
  const scope = projectAccessClause(user, params);
  if (scope) conditions.push(scope);
  if (activeOnly) conditions.push(`p.status = 'active'`);
  const { rows } = await query(
    `SELECT p.id FROM projects p ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
    params,
  );
  return rows.map((r) => r.id);
}

/**
 * Assert that a row belongs to a project the actor may access.
 * `spec` keeps the table/join pair in one whitelisted place instead of building
 * SQL from user input.
 */
const OWNED = {
  document: {
    sql: 'SELECT d.* FROM documents d JOIN projects p ON p.id = d.project_id WHERE d.id = $1',
    label: 'Document not found.',
  },
  version: {
    sql: 'SELECT v.* FROM document_versions v JOIN projects p ON p.id = v.project_id WHERE v.id = $1',
    label: 'Document version not found.',
  },
  chunk: {
    sql: `SELECT c.* FROM document_chunks c
          JOIN documents d ON d.id = c.document_id
          JOIN projects p ON p.id = d.project_id
          WHERE c.id = $1`,
    label: 'Chunk not found.',
  },
  conversation: {
    sql: 'SELECT c.* FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1',
    ownerColumn: 'c.owner_user_id',
    label: 'Conversation not found.',
  },
  link: {
    sql: 'SELECT l.* FROM web_links l JOIN projects p ON p.id = l.project_id WHERE l.id = $1',
    label: 'Web link not found.',
  },
  linkList: {
    sql: 'SELECT l.* FROM link_lists l JOIN projects p ON p.id = l.project_id WHERE l.id = $1',
    label: 'Link list not found.',
  },
  collection: {
    sql: 'SELECT c.* FROM collections c JOIN projects p ON p.id = c.project_id WHERE c.id = $1',
    label: 'Collection not found.',
  },
  crawlJob: {
    sql: 'SELECT j.* FROM crawl_jobs j JOIN projects p ON p.id = j.project_id WHERE j.id = $1',
    label: 'Crawl job not found.',
  },
  ingestionJob: {
    sql: 'SELECT j.* FROM ingestion_jobs j JOIN projects p ON p.id = j.project_id WHERE j.id = $1',
    label: 'Job not found.',
  },
};

async function assertOwned(kind, user, id) {
  const spec = OWNED[kind];
  if (!spec) throw new Error(`Unknown owned resource: ${kind}`);
  if (!isUuid(id)) throw malformed('Invalid resource id.');
  if (!user) throw notFound(spec.label);
  const params = [id];
  let ownerClause = '';
  if (!isAdmin(user)) {
    if (spec.ownerColumn) {
      // Conversations stay private to their creator, even inside a shared project.
      ownerClause = ` AND ${spec.ownerColumn} = $${params.push(user.id)}`;
    } else {
      ownerClause = ` AND ${projectAccessClause(user, params)}`;
    }
  }
  const { rows } = await query(`${spec.sql}${ownerClause}`, params);
  if (!rows[0]) throw notFound(spec.label);
  return rows[0];
}

/** Express middleware: resolve `param` as a project the actor can access. */
function requireProjectAccess(param = 'projectId') {
  return asyncHandler(async (req, _res, next) => {
    req.project = await assertProject(req.user, req.params[param]);
    return next();
  });
}

/** Express middleware: resolve `param` as any owned resource of `kind`. */
function requireOwnedAccess(kind, param = 'id', as = 'resource') {
  return asyncHandler(async (req, _res, next) => {
    req[as] = await assertOwned(kind, req.user, req.params[param]);
    return next();
  });
}

module.exports = {
  isAdmin,
  projectAccessClause,
  assertProject,
  assertOwned,
  allowedProjectIds,
  requireProjectAccess,
  requireOwnedAccess,
};
