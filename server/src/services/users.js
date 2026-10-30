'use strict';

/**
 * Accounts, passwordless login links, password resets and sessions.
 *
 * Security properties this module guarantees:
 *   - a token or session id is only ever stored as a SHA-256 hash;
 *   - login links are single use and expire (AUTH_TOKEN_TTL_MINUTES);
 *   - issuing a new link invalidates the previous unused ones for that user;
 *   - disabled users cannot complete a sign-in and their sessions stop working;
 *   - the last remaining administrator cannot be demoted, disabled or deleted;
 *   - passwords are stored only as scrypt:<salt>:<hash> and never in plain text.
 */
const crypto = require('node:crypto');
const { query, withTransaction } = require('../db');
const { AppError, Codes } = require('../lib/errors');
const { newId, randomToken, sha256 } = require('../lib/ids');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const mailer = require('./mailer');

const USER_COLUMNS = `id, email, name, role, status, created_by, last_login_at, created_at, updated_at`;
const USER_COLUMNS_WITH_HASH = `${USER_COLUMNS}, password_hash`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Passwords are verified with scrypt (memory-hard, slow by design) and stored
// as `scrypt:<salt>:<derived key>`. The salt is a random hex string, the key a
// hex digest - the whole string is opaque and never the password itself.
const PASSWORD_ALGO = 'scrypt';
const PASSWORD_KEY_LENGTH = 64;

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function assertEmail(value) {
  const email = normaliseEmail(value);
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    throw new AppError('Please enter a valid email address.', { code: Codes.VALIDATION, status: 422 });
  }
  return email;
}

function displayName(name, email) {
  const clean = String(name || '').trim();
  return clean ? clean.slice(0, 120) : String(email || '').split('@')[0];
}

/* -------------------------------------------------------------------------- */
/* Password hashing                                                           */
/* -------------------------------------------------------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, PASSWORD_KEY_LENGTH).toString('hex');
  return `${PASSWORD_ALGO}:${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, salt, expected] = String(stored).split(':');
  if (algo !== PASSWORD_ALGO || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, PASSWORD_KEY_LENGTH);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < 8) {
    throw new AppError('Password must be at least 8 characters long.', { code: Codes.VALIDATION, status: 422 });
  }
  if (value.length > 128) {
    throw new AppError('Password must be at most 128 characters long.', { code: Codes.VALIDATION, status: 422 });
  }
  return value;
}

// Always run one scrypt verification, even for unknown addresses, so response
// timing cannot be used to find out which email addresses have accounts.
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

/** Fetch a user together with the password hash (never leave the hash out). */
async function getUserWithPasswordHash(email) {
  const { rows } = await query(`SELECT ${USER_COLUMNS_WITH_HASH} FROM users WHERE email_normalised = $1`, [
    normaliseEmail(email),
  ]);
  return rows[0] || null;
}

async function getUserWithPasswordHashById(id) {
  const { rows } = await query(`SELECT ${USER_COLUMNS_WITH_HASH} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}


function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    last_login_at: row.last_login_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function countUsers() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0]?.n ?? 0;
}

async function setupRequired() {
  return (await countUsers()) === 0;
}

async function getUser(id) {
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE email_normalised = $1`, [normaliseEmail(email)]);
  return rows[0] || null;
}

async function listUsers({ search, status, role } = {}) {
  const conditions = ['TRUE'];
  const params = [];
  if (status && ['invited', 'active', 'disabled'].includes(status)) {
    conditions.push(`u.status = $${params.push(status)}`);
  }
  if (role && ['admin', 'user'].includes(role)) {
    conditions.push(`u.role = $${params.push(role)}`);
  }
  if (search) {
    const p = params.push(`%${String(search).slice(0, 120)}%`);
    conditions.push(`(u.email ILIKE $${p} OR u.name ILIKE $${p})`);
  }
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_by, u.last_login_at, u.created_at, u.updated_at,
            (SELECT COUNT(*)::int FROM projects p WHERE p.owner_user_id = u.id) AS project_count,
            (SELECT COUNT(*)::int FROM user_projects up WHERE up.user_id = u.id) AS assigned_project_count,
            (SELECT MAX(s.last_seen_at) FROM auth_sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS last_seen_at
     FROM users u
     WHERE ${conditions.join(' AND ')}
     ORDER BY u.created_at ASC`,
    params,
  );
  return rows;
}

/** Create a user and (optionally) deliver the invitation link. */
async function createUser({ email, name, role = 'user', createdBy = null, origin = null }) {
  const cleanEmail = assertEmail(email);
  const cleanRole = role === 'admin' ? 'admin' : 'user';
  const normalised = normaliseEmail(cleanEmail);

  let row;
  try {
    const { rows } = await query(
      `INSERT INTO users (id, email, email_normalised, name, role, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'invited',$6)
       RETURNING ${USER_COLUMNS}`,
      [newId(), cleanEmail, normalised, displayName(name, cleanEmail), cleanRole, createdBy],
    );
    row = rows[0];
  } catch (err) {
    if (err.code === '23505' || /unique/i.test(err.message)) {
      throw new AppError('A user with that email address already exists.', { code: Codes.CONFLICT, status: 409 });
    }
    throw err;
  }

  const delivery = await deliverLoginLink(row, { origin, purpose: 'invite', createdBy });
  return { user: publicUser(row), ...delivery };
}

/**
 * Create the very first administrator. Only possible while the users table is
 * empty; subsequent accounts must be created by an administrator.
 */
async function createFirstAdmin({ email, name, origin = null }) {
  const cleanEmail = assertEmail(email);
  const normalised = normaliseEmail(cleanEmail);
  let row;
  await withTransaction(async (tx) => {
    // Serialise concurrent first-run requests: without the lock two setup calls
    // could both observe an empty table and create competing administrators.
    await tx.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const { rows: existing } = await tx.query('SELECT COUNT(*)::int AS n FROM users');
    if ((existing[0]?.n ?? 0) > 0) {
      throw new AppError('Setup has already been completed. Ask an administrator for a login link.', {
        code: Codes.CONFLICT,
        status: 409,
      });
    }
    const { rows } = await tx.query(
      `INSERT INTO users (id, email, email_normalised, name, role, status)
       VALUES ($1,$2,$3,$4,'admin','active')
       RETURNING ${USER_COLUMNS}`,
      [newId(), cleanEmail, normalised, displayName(name, cleanEmail)],
    );
    row = rows[0];
  });

  await claimOrphanProjects(row.id);
  const delivery = await deliverLoginLink(row, { origin, purpose: 'login' });
  return { user: publicUser(row), ...delivery };
}

/** Projects that predate multi-user support belong to the first admin. */
async function claimOrphanProjects(adminId) {
  const { rowCount } = await query('UPDATE projects SET owner_user_id = $1 WHERE owner_user_id IS NULL', [adminId]);
  return rowCount;
}

async function updateUser(id, patch = {}, { actorId = null } = {}) {
  const current = await getUser(id);
  if (!current) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });

  const sets = [];
  const params = [];

  if (patch.name !== undefined) {
    sets.push(`name = $${params.push(displayName(patch.name, current.email))}`);
  }
  if (patch.role !== undefined && patch.role !== current.role) {
    if (current.role === 'admin' && patch.role !== 'admin') {
      await assertNotLastAdmin(current.id, 'demote');
    }
    sets.push(`role = $${params.push(patch.role === 'admin' ? 'admin' : 'user')}`);
  }
  if (patch.status !== undefined && patch.status !== current.status) {
    if (actorId && actorId === current.id && patch.status !== 'active') {
      throw new AppError('You cannot disable your own account.', { code: Codes.CONFLICT, status: 409 });
    }
    if (current.role === 'admin' && patch.status !== 'active') {
      await assertNotLastAdmin(current.id, 'disable');
    }
    sets.push(`status = $${params.push(['invited', 'active', 'disabled'].includes(patch.status) ? patch.status : 'active')}`);
  }

  if (!sets.length) return publicUser(current);
  params.push(id);
  const { rows } = await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${USER_COLUMNS}`, params);
  if (!rows[0]) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });

  // Disabling an account must also end its live sessions.
  if (patch.status === 'disabled') await revokeAllSessions(id);
  return publicUser(rows[0]);
}

async function assertNotLastAdmin(userId, action) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1`,
    [userId],
  );
  if ((rows[0]?.n ?? 0) === 0) {
    throw new AppError(`You cannot ${action} the last remaining administrator.`, { code: Codes.CONFLICT, status: 409 });
  }
}

/**
 * Delete a user. An account that owns projects is only deleted when the caller
 * says where those projects should go, so data is never orphaned silently.
 */
async function deleteUser(id, { actorId = null, reassignTo = null } = {}) {
  const user = await getUser(id);
  if (!user) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (actorId && actorId === id) {
    throw new AppError('You cannot delete your own account.', { code: Codes.CONFLICT, status: 409 });
  }
  if (user.role === 'admin') await assertNotLastAdmin(id, 'delete');

  const { rows: owned } = await query('SELECT COUNT(*)::int AS n FROM projects WHERE owner_user_id = $1', [id]);
  const projectCount = owned[0]?.n ?? 0;

  if (projectCount > 0) {
    if (!reassignTo) {
      throw new AppError(
        `This user owns ${projectCount} project${projectCount === 1 ? '' : 's'}. Choose an administrator to take them over before deleting the account.`,
        { code: Codes.CONFLICT, status: 409, details: { projectCount } },
      );
    }
    if (reassignTo === id) {
      throw new AppError('Choose a different administrator to take over these projects.', {
        code: Codes.VALIDATION,
        status: 422,
      });
    }
    const target = await getUser(reassignTo);
    if (!target || target.role !== 'admin' || target.status !== 'active') {
      throw new AppError('Projects can only be reassigned to an active administrator.', {
        code: Codes.VALIDATION,
        status: 422,
      });
    }
    await query('UPDATE projects SET owner_user_id = $2 WHERE owner_user_id = $1', [id, reassignTo]);
  }

  await query('DELETE FROM users WHERE id = $1', [id]);
  return { deleted: true, id, reassignedProjects: projectCount };
}

/* -------------------------------------------------------------------------- */
/* Project assignment                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every project together with whether this user owns it or has been assigned
 * to it. The admin UI uses the flags to show the current access in one list.
 */
async function listUserProjects(userId) {
  const user = await getUser(userId);
  if (!user) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });
  const { rows } = await query(
    `SELECT p.id, p.name, p.slug, p.status,
            (p.owner_user_id = $1) AS owned,
            (up.user_id IS NOT NULL) AS assigned,
            up.created_at AS assigned_at
       FROM projects p
       LEFT JOIN user_projects up ON up.project_id = p.id AND up.user_id = $1
      ORDER BY p.name ASC`,
    [userId],
  );
  return rows;
}

/** Grant a user access to one or more projects (idempotent). */
async function assignUserProjects(userId, { projectIds = [], actorId = null } = {}) {
  const user = await getUser(userId);
  if (!user) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });

  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return { assigned: 0, projectIds: [] };
  if (ids.length > 500) {
    throw new AppError('Too many projects selected at once.', { code: Codes.VALIDATION, status: 422 });
  }
  if (ids.some((id) => !UUID_RE.test(id))) {
    throw new AppError('One or more project ids are invalid.', { code: Codes.VALIDATION, status: 422 });
  }

  const { rows: found } = await query('SELECT id FROM projects WHERE id = ANY($1::uuid[])', [ids]);
  if (found.length !== ids.length) {
    throw new AppError('One or more projects could not be found.', { code: Codes.NOT_FOUND, status: 404 });
  }

  await query(
    `INSERT INTO user_projects (user_id, project_id, assigned_by)
     SELECT $1, p.id, $3 FROM projects p WHERE p.id = ANY($2::uuid[])
     ON CONFLICT (user_id, project_id) DO UPDATE SET assigned_by = EXCLUDED.assigned_by`,
    [userId, ids, actorId],
  );
  return { assigned: ids.length, projectIds: ids };
}

/** Revoke an assignment. Ownership is untouched and always keeps access. */
async function unassignUserProject(userId, projectId) {
  const user = await getUser(userId);
  if (!user) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (!UUID_RE.test(String(projectId || ''))) {
    throw new AppError('Invalid project id.', { code: Codes.VALIDATION, status: 422 });
  }
  const { rows } = await query('SELECT id, owner_user_id FROM projects WHERE id = $1', [projectId]);
  if (!rows[0]) throw new AppError('Project not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (rows[0].owner_user_id === userId) {
    throw new AppError('This user owns the project, so access cannot be removed.', { code: Codes.CONFLICT, status: 409 });
  }
  const { rowCount } = await query('DELETE FROM user_projects WHERE user_id = $1 AND project_id = $2', [userId, projectId]);
  return { removed: rowCount > 0, projectId };
}

/* -------------------------------------------------------------------------- */
/* Login links                                                                */
/* -------------------------------------------------------------------------- */

function loginUrl(token) {
  // The token travels in the URL fragment so it never reaches a server access
  // log, proxy log or Referer header.
  return `${config.appPublicUrl || ''}/login#token=${token}`;
}

async function issueLoginToken({ userId, purpose = 'login', createdBy = null, origin = null }) {
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + config.auth.tokenTtlMinutes * 60_000);

  await withTransaction(async (tx) => {
    // One live link per user: an old email must stop working once a new one is sent.
    await tx.query(
      `UPDATE auth_login_tokens SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await tx.query(
      `INSERT INTO auth_login_tokens (id, user_id, token_hash, purpose, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), userId, tokenHash, purpose, expiresAt, createdBy],
    );
  });

  const base = config.appPublicUrl || String(origin || '').replace(/\/+$/, '');
  const url = base ? `${base}/login#token=${token}` : loginUrl(token);
  return { token, url, expiresAt };
}

/** Issue a link and try to email it. Never fails because of a mail problem. */
async function deliverLoginLink(user, { origin = null, purpose = 'login', createdBy = null } = {}) {
  const link = await issueLoginToken({ userId: user.id, purpose, createdBy, origin });
  const email = await mailer.sendLoginLink({
    to: user.email,
    name: user.name,
    url: link.url,
    expiresAt: link.expiresAt,
    purpose,
  });

  if (!email.sent) {
    // The operator is the only one who can read the server log. This is the
    // fallback that makes the app usable without an SMTP server.
    logger.warn(
      { to: user.email, url: link.url, reason: email.reason, expiresAt: link.expiresAt },
      'login link generated; email was not sent',
    );
  }

  return {
    expiresAt: link.expiresAt,
    // Returned to the administrator so the link can be copied and handed over
    // when email is not configured (or lands in spam).
    url: link.url,
    email,
  };
}

/** Re-send a sign-in link to an existing account. */
async function resendLoginLink(id, { origin = null, createdBy = null } = {}) {
  const user = await getUser(id);
  if (!user) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (user.status === 'disabled') {
    throw new AppError('This account is disabled. Enable it before sending a new link.', {
      code: Codes.CONFLICT,
      status: 409,
    });
  }
  const purpose = user.status === 'invited' ? 'invite' : 'login';
  const delivery = await deliverLoginLink(user, { origin, purpose, createdBy });
  return { user: publicUser(user), ...delivery };
}

function cleanToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token || token.length > 512) {
    throw new AppError('This sign-in link is invalid.', { code: 'invalid_token', status: 400 });
  }
  return token;
}

/**
 * Describe a link without consuming it, so the sign-in screen can ask the user
 * to choose a password before the one-time token is exchanged for a session.
 */
async function describeLoginToken(rawToken) {
  const tokenHash = sha256(cleanToken(rawToken));
  const { rows } = await query(
    `SELECT t.expires_at, t.used_at, t.purpose, u.email, u.name, u.status
     FROM auth_login_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) {
    throw new AppError('This sign-in link is invalid or has already been used.', { code: 'invalid_token', status: 400 });
  }
  if (row.used_at) {
    throw new AppError('This sign-in link has already been used. Request a new one.', {
      code: 'invalid_token',
      status: 400,
    });
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new AppError('This sign-in link has expired. Request a new one.', { code: 'expired_token', status: 400 });
  }
  if (row.status === 'disabled') {
    throw new AppError('This account has been disabled. Contact an administrator.', {
      code: 'account_disabled',
      status: 403,
    });
  }

  return {
    purpose: row.purpose,
    email: row.email,
    name: row.name,
    expiresAt: row.expires_at,
    // Invitations and password resets are the only links that may set a password.
    canSetPassword: row.purpose === 'invite' || row.purpose === 'password_reset',
  };
}

/** Administrator-initiated password reset link for an existing account. */
async function sendPasswordResetLink(id, { origin = null, createdBy = null } = {}) {
  const user = await getUser(id);
  if (!user) throw new AppError('User not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (user.status === 'disabled') {
    throw new AppError('This account is disabled. Enable it before sending a reset link.', {
      code: Codes.CONFLICT,
      status: 409,
    });
  }
  const delivery = await deliverLoginLink(user, { origin, purpose: 'password_reset', createdBy });
  return { user: publicUser(user), ...delivery };
}

/** Consume a login link and open a session. */
async function verifyLoginToken(rawToken, { ip = null, userAgent = null, purpose = null, password = null } = {}) {
  const token = cleanToken(rawToken);
  const tokenHash = sha256(token);
  const sessionToken = randomToken(32);
  const sessionHash = sha256(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + config.auth.sessionDays * 86_400_000);
  // An empty string means "sign in without setting a password", so only a real
  // value counts as a password being supplied.
  const suppliedPassword = password === undefined || password === null || password === '' ? null : String(password);

  const result = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT t.id, t.user_id, t.expires_at, t.used_at, t.purpose, u.email, u.name, u.role, u.status, u.password_hash
       FROM auth_login_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );
    const tokenRow = rows[0];
    if (!tokenRow) {
      throw new AppError('This sign-in link is invalid or has already been used.', { code: 'invalid_token', status: 400 });
    }
    if (purpose && tokenRow.purpose !== purpose) {
      throw new AppError('This sign-in link is invalid or has already been used.', { code: 'invalid_token', status: 400 });
    }
    if (tokenRow.used_at) {
      throw new AppError('This sign-in link has already been used. Request a new one.', {
        code: 'invalid_token',
        status: 400,
      });
    }
    if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      throw new AppError('This sign-in link has expired. Request a new one.', { code: 'expired_token', status: 400 });
    }
    if (tokenRow.status === 'disabled') {
      throw new AppError('This account has been disabled. Contact an administrator.', {
        code: 'account_disabled',
        status: 403,
      });
    }

    const canSetPassword = tokenRow.purpose === 'invite' || tokenRow.purpose === 'password_reset';
    if (suppliedPassword && !canSetPassword) {
      throw new AppError('This link cannot be used to set a password. Request a password reset link instead.', {
        code: 'password_not_allowed',
        status: 400,
      });
    }

    // A user coming from an invitation (or a password reset) may set a password
    // as part of consuming the link. The hash is written in the same transaction
    // that consumes the token, so a half-done exchange cannot happen.
    const wantsPassword = Boolean(suppliedPassword);
    if (wantsPassword) {
      const value = validatePassword(suppliedPassword);
      await tx.query(`UPDATE users SET password_hash = $2, password_updated_at = now() WHERE id = $1`, [
        tokenRow.user_id,
        hashPassword(value),
      ]);
      // Changing a password signs the account out everywhere else; the session
      // created below is the only one kept.
      await tx.query('DELETE FROM auth_sessions WHERE user_id = $1', [tokenRow.user_id]);
    }

    await tx.query('UPDATE auth_login_tokens SET used_at = now() WHERE id = $1', [tokenRow.id]);
    await tx.query(
      `UPDATE users SET status = 'active', last_login_at = now() WHERE id = $1 AND status <> 'disabled'`,
      [tokenRow.user_id],
    );
    await tx.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), tokenRow.user_id, sessionHash, String(userAgent || '').slice(0, 400) || null, String(ip || '').slice(0, 64) || null, sessionExpiresAt],
    );

    return {
      user: {
        id: tokenRow.user_id,
        email: tokenRow.email,
        name: tokenRow.name,
        role: tokenRow.role,
        status: 'active',
        hasPassword: wantsPassword || Boolean(tokenRow.password_hash),
      },
      sessionExpiresAt,
    };
  });

  return { ...result, sessionToken };
}

/**
 * Email/password sign-in. The error message is deliberately identical for an
 * unknown address, a wrong password and a disabled account.
 */
async function loginWithPassword({ email, password, ip = null, userAgent = null } = {}) {
  const user = await getUserWithPasswordHash(assertEmail(email));
  const valid = verifyPassword(String(password ?? ''), user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || !user.password_hash || !valid || user.status === 'disabled') {
    throw new AppError('The email address or password is incorrect.', {
      code: 'invalid_credentials',
      status: 401,
    });
  }

  const sessionToken = randomToken(32);
  const sessionExpiresAt = new Date(Date.now() + config.auth.sessionDays * 86_400_000);
  await query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [newId(), user.id, sha256(sessionToken), String(userAgent || '').slice(0, 400) || null, String(ip || '').slice(0, 64) || null, sessionExpiresAt],
  );
  await query(`UPDATE users SET status = 'active', last_login_at = now() WHERE id = $1 AND status <> 'disabled'`, [user.id]);

  return {
    user: { ...publicUser(user), status: 'active', hasPassword: true },
    sessionToken,
    sessionExpiresAt,
  };
}

/**
 * Start the forgot-password flow. The response is intentionally identical for
 * known and unknown addresses so this endpoint cannot enumerate accounts.
 */
async function requestPasswordReset({ email, origin = null, createdBy = null } = {}) {
  const user = await getUserByEmail(assertEmail(email)).catch(() => null);
  if (user && user.status !== 'disabled') {
    await deliverLoginLink(user, { origin, purpose: 'password_reset', createdBy });
  } else {
    logger.info({ email: normaliseEmail(email) }, 'password reset requested for an unknown or disabled address');
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

async function getSession(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.expires_at AS session_expires_at, s.last_seen_at,
            u.id, u.email, u.name, u.role, u.status
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'disabled') return null;

  // Cheap activity tracking: at most one write per session per minute.
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => {});
  }

  return {
    sessionId: row.session_id,
    sessionExpiresAt: row.session_expires_at,
    user: { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status },
  };
}

async function revokeSession(rawToken) {
  if (!rawToken) return { revoked: false };
  const { rowCount } = await query('DELETE FROM auth_sessions WHERE token_hash = $1', [sha256(rawToken)]);
  return { revoked: rowCount > 0 };
}

async function revokeAllSessions(userId) {
  const { rowCount } = await query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
  return { revoked: rowCount };
}

/** Remove expired tokens and sessions. Cheap enough to run at boot. */
async function pruneAuthArtifacts() {
  const tokens = await query('DELETE FROM auth_login_tokens WHERE expires_at < now() - interval \'7 days\'');
  const sessions = await query('DELETE FROM auth_sessions WHERE expires_at < now()');
  return { tokens: tokens.rowCount, sessions: sessions.rowCount };
}

/**
 * First-run bootstrap from ADMIN_EMAIL. Runs only while there are no users, so
 * it can never create a second administrator or reset an existing install.
 */
async function bootstrapAdmin({ origin = null } = {}) {
  if (!config.auth.adminEmail) return null;
  if ((await countUsers()) > 0) return null;
  const result = await createFirstAdmin({
    email: config.auth.adminEmail,
    name: config.auth.adminName,
    origin,
  });
  logger.warn(
    { email: result.user.email, url: result.url, emailed: result.email?.sent === true },
    'created the first administrator from ADMIN_EMAIL (use the URL above to sign in)',
  );
  return result;
}

async function stats() {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM users) AS users_total,
       (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS users_active,
       (SELECT COUNT(*)::int FROM users WHERE status = 'invited') AS users_invited,
       (SELECT COUNT(*)::int FROM users WHERE status = 'disabled') AS users_disabled,
       (SELECT COUNT(*)::int FROM users WHERE role = 'admin') AS admins,
       (SELECT COUNT(*)::int FROM projects) AS projects,
       (SELECT COUNT(*)::int FROM documents WHERE NOT archived) AS documents,
       (SELECT COUNT(*)::int FROM document_chunks) AS chunks,
       (SELECT COUNT(*)::int FROM conversations WHERE NOT archived) AS conversations,
       (SELECT COUNT(*)::int FROM ingestion_jobs WHERE status IN ('queued','processing')) AS active_jobs`,
  );
  const { rows: recent } = await query(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC LIMIT 6`,
  );
  return { counts: rows[0], recentUsers: recent.map(publicUser), mail: mailer.describe() };
}

module.exports = {
  normaliseEmail,
  publicUser,
  countUsers,
  setupRequired,
  getUser,
  getUserByEmail,
  listUsers,
  createUser,
  createFirstAdmin,
  claimOrphanProjects,
  updateUser,
  deleteUser,
  issueLoginToken,
  deliverLoginLink,
  resendLoginLink,
  sendPasswordResetLink,
  describeLoginToken,
  verifyLoginToken,
  loginWithPassword,
  requestPasswordReset,
  listUserProjects,
  assignUserProjects,
  unassignUserProject,
  getSession,
  revokeSession,
  revokeAllSessions,
  pruneAuthArtifacts,
  bootstrapAdmin,
  stats,
};
