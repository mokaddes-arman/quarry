'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody } = require('../middleware/validate');
const { rateLimit, setSessionCookie, clearSessionCookie, sessionTokenFromRequest } = require('../middleware/auth');
const { AppError } = require('../lib/errors');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const users = require('../services/users');
const mailer = require('../services/mailer');

const router = express.Router();

const linkLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: 'auth-link' });
const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, keyPrefix: 'auth-verify' });
const passwordLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, keyPrefix: 'auth-password' });
const resetLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: 'auth-reset' });

/** Per-address throttle so one request cannot be used to spam an inbox. */
const addressAttempts = new Map();
function throttleAddress(email) {
  const key = users.normaliseEmail(email);
  const now = Date.now();
  const entry = addressAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    addressAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 5;
}

/**
 * Absolute origin used in a login link. Prefers APP_PUBLIC_URL, then the
 * browser's Origin (validated), then the request host.
 */
function requestOrigin(req) {
  if (config.appPublicUrl) return config.appPublicUrl;
  const origin = req.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      const host = req.get('host');
      if (url.host === host || config.corsOrigins.includes(url.origin)) return url.origin;
    } catch {
      /* fall through */
    }
  }
  return `${req.protocol}://${req.get('host')}`;
}

/** What the SPA needs to decide between "sign in" and "set up the first admin". */
router.get(
  '/auth/status',
  asyncHandler(async (req, res) => {
    res.json({
      authenticated: Boolean(req.user),
      user: req.user ? { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role } : null,
      setupRequired: await users.setupRequired(),
      emailConfigured: mailer.isConfigured(),
    });
  }),
);

router.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    if (!req.user) {
      throw new AppError('You need to sign in to continue.', { code: 'unauthenticated', status: 401 });
    }
    res.json({ user: req.user });
  }),
);

/** First-run setup: creates the first administrator. Only valid with zero users. */
router.post(
  '/auth/setup',
  rateLimit({ windowMs: 15 * 60_000, max: 5, keyPrefix: 'auth-setup' }),
  validateBody(
    z.object({
      email: z.string().trim().min(3).max(320),
      name: z.string().trim().max(120).optional().nullable(),
    }),
  ),
  asyncHandler(async (req, res) => {
    if (!(await users.setupRequired())) {
      throw new AppError('Setup has already been completed. Ask an administrator for a login link.', {
        code: 'conflict',
        status: 409,
      });
    }
    const result = await users.createFirstAdmin({
      email: req.validated.email,
      name: req.validated.name || null,
      origin: requestOrigin(req),
    });
    logger.warn({ email: result.user.email }, 'first administrator created via setup');
    res.status(201).json({
      user: result.user,
      emailSent: result.email?.sent === true,
      // Never log this in production; it is returned so the operator can sign in
      // immediately when SMTP is not configured.
      loginUrl: result.email?.sent ? undefined : result.url,
      expiresAt: result.expiresAt,
      email: result.email,
    });
  }),
);

/**
 * Request a sign-in link. The response is always the same so the endpoint
 * cannot be used to enumerate accounts.
 */
router.post(
  '/auth/request-link',
  linkLimiter,
  validateBody(z.object({ email: z.string().trim().min(3).max(320) })),
  asyncHandler(async (req, res) => {
    const email = users.normaliseEmail(req.validated.email);
    if (!throttleAddress(email)) {
      throw new AppError('Too many sign-in attempts for this address. Please wait a few minutes.', {
        code: 'rate_limited',
        status: 429,
      });
    }

    const user = await users.getUserByEmail(email).catch(() => null);
    if (user && user.status !== 'disabled') {
      await users.deliverLoginLink(user, {
        origin: requestOrigin(req),
        purpose: user.status === 'invited' ? 'invite' : 'login',
      });
    } else {
      logger.info({ email }, 'sign-in requested for an unknown or disabled address');
    }

    res.json({
      ok: true,
      message: 'If that address belongs to an account, a sign-in link is on its way.',
      emailConfigured: mailer.isConfigured(),
    });
  }),
);

/** Email + password sign-in. */
router.post(
  '/auth/login',
  passwordLimiter,
  validateBody(
    z.object({
      email: z.string().trim().min(3).max(320),
      password: z.string().min(1).max(128),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await users.loginWithPassword({
      email: req.validated.email,
      password: req.validated.password,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, result.sessionToken, result.sessionExpiresAt);
    res.json({ user: result.user, expiresAt: result.sessionExpiresAt });
  }),
);

/**
 * Start the "forgot password" flow. Always returns the same answer so it cannot
 * be used to discover which accounts exist.
 */
router.post(
  '/auth/password/forgot',
  resetLimiter,
  validateBody(z.object({ email: z.string().trim().min(3).max(320) })),
  asyncHandler(async (req, res) => {
    const email = users.normaliseEmail(req.validated.email);
    if (!throttleAddress(email)) {
      throw new AppError('Too many reset attempts for this address. Please wait a few minutes.', {
        code: 'rate_limited',
        status: 429,
      });
    }
    await users.requestPasswordReset({ email, origin: requestOrigin(req) });
    res.json({
      ok: true,
      message: 'If that address belongs to an account, a password reset link is on its way.',
      emailConfigured: mailer.isConfigured(),
    });
  }),
);

/**
 * Inspect a link before consuming it. Invitations and password resets need one
 * extra step (choosing a password), which must happen before the token is used.
 */
router.post(
  '/auth/link-info',
  verifyLimiter,
  validateBody(z.object({ token: z.string().trim().min(10).max(512) })),
  asyncHandler(async (req, res) => {
    res.json(await users.describeLoginToken(req.validated.token));
  }),
);

/** Consume a login link, optionally set a password, and open a session. */
router.post(
  '/auth/verify',
  verifyLimiter,
  validateBody(
    z.object({
      token: z.string().trim().min(10).max(512),
      // Present when the user chose a password on the invitation/reset screen.
      password: z.string().min(8).max(128).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await users.verifyLoginToken(req.validated.token, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      password: req.validated.password,
    });
    setSessionCookie(res, result.sessionToken, result.sessionExpiresAt);
    res.json({ user: result.user, expiresAt: result.sessionExpiresAt });
  }),
);

router.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const token = sessionTokenFromRequest(req);
    if (token) await users.revokeSession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

module.exports = router;
