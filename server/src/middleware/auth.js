'use strict';

const { config } = require('../config/env');
const { AppError } = require('../lib/errors');
const { logger } = require('../lib/logger');
const users = require('../services/users');

/**
 * Session authentication and role checks.
 *
 * Auth is cookie based. The cookie is HttpOnly + SameSite=Lax, and unsafe
 * methods additionally require a same-origin request, which together block
 * cross-site request forgery without a token round-trip.
 */

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function sessionTokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[config.auth.cookieName] || null;
}

function setSessionCookie(res, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const parts = [
    `${config.auth.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (config.auth.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [
    `${config.auth.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (config.auth.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/**
 * Resolve the current session (if any) onto req.session / req.user.
 *
 * `app.set('testAuth', true)` is only set by the integration-test helper. It lets
 * tests act as a seeded administrator without going through email, and to
 * impersonate another user with `x-test-user: <id>`. It is never enabled by the
 * application bootstrap.
 */
async function authenticate(req, _res, next) {
  try {
    if (req.user) return next();
    const token = sessionTokenFromRequest(req);
    if (token) {
      const session = await users.getSession(token);
      if (session) {
        req.session = session;
        req.user = session.user;
        return next();
      }
    }

    if (config.isTest && req.app.get('testAuth')) {
      const impersonate = req.get('x-test-user');
      if (impersonate) {
        const user = await users.getUser(impersonate);
        if (user && user.status !== 'disabled') {
          req.user = { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status };
          return next();
        }
      }
      const fallbackId = req.app.get('testAuthUserId');
      if (fallbackId) {
        const user = await users.getUser(fallbackId);
        if (user && user.status !== 'disabled') {
          req.user = { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status };
        }
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireAuth(req, _res, next) {
  if (!req.user) {
    return next(new AppError('You need to sign in to continue.', { code: 'unauthenticated', status: 401 }));
  }
  return next();
}

function requireAdmin(req, _res, next) {
  if (!req.user) {
    return next(new AppError('You need to sign in to continue.', { code: 'unauthenticated', status: 401 }));
  }
  if (req.user.role !== 'admin') {
    return next(new AppError('Administrator access is required.', { code: 'forbidden', status: 403 }));
  }
  return next();
}

function allowedOrigin(origin) {
  if (!origin) return false;
  if (config.corsOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return Boolean(url.host);
  } catch {
    return false;
  }
}

/**
 * CSRF guard for state-changing requests. A browser always sends Origin (or at
 * least Referer) on a cross-site POST; a request whose origin is not this app is
 * rejected. Non-browser clients that send neither header are allowed, which
 * keeps curl/health checks working.
 */
function csrfGuard(req, _res, next) {
  if (!UNSAFE.has(req.method)) return next();

  const site = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site') {
    return next(new AppError('Cross-site request blocked.', { code: 'forbidden', status: 403 }));
  }

  const host = String(req.get('host') || '').toLowerCase();
  const origin = req.get('origin');
  const referer = req.get('referer');

  const matchesHost = (value) => {
    try {
      return new URL(value).host.toLowerCase() === host;
    } catch {
      return false;
    }
  };

  if (origin) {
    if (allowedOrigin(origin) && (matchesHost(origin) || config.corsOrigins.includes(origin))) return next();
    return next(new AppError('Request origin is not allowed.', { code: 'forbidden', status: 403 }));
  }
  if (referer) {
    if (matchesHost(referer) || config.corsOrigins.some((o) => referer.startsWith(`${o}/`))) return next();
    return next(new AppError('Request origin is not allowed.', { code: 'forbidden', status: 403 }));
  }
  return next();
}

/* -------------------------------------------------------------------------- */
/* Lightweight in-memory rate limiting                                        */
/* -------------------------------------------------------------------------- */

const buckets = new Map();
let lastSweep = Date.now();

function rateLimit({ windowMs = 15 * 60_000, max = 10, keyPrefix = 'default' } = {}) {
  return (req, _res, next) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      lastSweep = now;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }
    const key = `${keyPrefix}|${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      logger.warn({ key, count: bucket.count }, 'rate limit hit');
      return next(
        new AppError('Too many attempts. Please wait a few minutes and try again.', {
          code: 'rate_limited',
          status: 429,
        }),
      );
    }
    return next();
  };
}

module.exports = {
  authenticate,
  requireAuth,
  requireAdmin,
  csrfGuard,
  rateLimit,
  parseCookies,
  sessionTokenFromRequest,
  setSessionCookie,
  clearSessionCookie,
};
