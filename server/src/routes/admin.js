'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateQuery, validateUuidParam, booleanQuery } = require('../middleware/validate');
const { requireAdmin } = require('../middleware/auth');
const users = require('../services/users');

/**
 * Administrator-only user management.
 *
 * Mounted behind requireAuth (see app.js); the path-scoped requireAdmin below
 * gate every route in this file. An admin can invite users, resend sign-in
 * links, disable accounts, revoke sessions and delete accounts. Deleting an
 * account that owns projects requires an explicit reassignment so data is never
 * orphaned silently.
 */
const router = express.Router();

// Scope the gate to this router's own paths. A bare `router.use(requireAdmin)`
// would run for every request that passes through the router and lock the rest
// of the API for normal users.
router.use('/admin', requireAdmin);

const roleEnum = z.enum(['admin', 'user']);
const statusEnum = z.enum(['invited', 'active', 'disabled']);

/**
 * Absolute origin for the one-time link. `APP_PUBLIC_URL` wins inside the
 * users service; this is only the fallback when it is not configured. The
 * Origin header is validated by the CSRF guard for unsafe methods, and a
 * non-browser client without one still gets a usable absolute link.
 */
function requestOrigin(req) {
  return req.get('origin') || `${req.protocol}://${req.get('host')}`;
}

router.get(
  '/admin/overview',
  asyncHandler(async (_req, res) => {
    res.json({ overview: await users.stats() });
  }),
);

router.get(
  '/admin/users',
  validateQuery(
    z.object({
      search: z.string().trim().max(120).optional(),
      status: statusEnum.optional(),
      role: roleEnum.optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json({ users: await users.listUsers(req.validatedQuery || {}) });
  }),
);

router.post(
  '/admin/users',
  validateBody(
    z.object({
      email: z.string().trim().min(3).max(320),
      name: z.string().trim().max(120).optional().nullable(),
      role: roleEnum.optional().default('user'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await users.createUser({
      email: req.validated.email,
      name: req.validated.name || null,
      role: req.validated.role,
      createdBy: req.user.id,
      origin: requestOrigin(req),
    });
    res.status(201).json({
      user: result.user,
      invite: {
        emailSent: result.email?.sent === true,
        email: result.email,
        // Administrators always receive the link: it can be copied and handed
        // over even when email delivery is configured (or lands in spam).
        loginUrl: result.url,
        expiresAt: result.expiresAt,
      },
    });
  }),
);

router.patch(
  '/admin/users/:id',
  validateUuidParam('id'),
  validateBody(
    z.object({
      name: z.string().trim().max(120).optional().nullable(),
      role: roleEnum.optional(),
      status: statusEnum.optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const user = await users.updateUser(req.params.id, req.validated, { actorId: req.user.id });
    res.json({ user });
  }),
);

/** Issue a fresh sign-in link (and email it when SMTP is configured). */
router.post(
  '/admin/users/:id/resend',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const result = await users.resendLoginLink(req.params.id, {
      origin: requestOrigin(req),
      createdBy: req.user.id,
    });
    res.status(202).json({
      user: result.user,
      emailSent: result.email?.sent === true,
      email: result.email,
      // Always returned to the administrator so the link can be copied.
      loginUrl: result.url,
      expiresAt: result.expiresAt,
    });
  }),
);

/**
 * Issue a password-reset link (and email it when SMTP is configured). The link
 * is always returned so an administrator can hand it over manually.
 */
router.post(
  '/admin/users/:id/password-reset',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const result = await users.sendPasswordResetLink(req.params.id, {
      origin: requestOrigin(req),
      createdBy: req.user.id,
    });
    res.status(202).json({
      user: result.user,
      emailSent: result.email?.sent === true,
      email: result.email,
      loginUrl: result.url,
      expiresAt: result.expiresAt,
    });
  }),
);

/** Projects this user can open, with owner/assignment flags for the picker. */
router.get(
  '/admin/users/:id/projects',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ projects: await users.listUserProjects(req.params.id) });
  }),
);

/** Grant access to one or many projects at once (idempotent). */
router.put(
  '/admin/users/:id/projects',
  validateUuidParam('id'),
  validateBody(z.object({ projectIds: z.array(z.string().uuid()).max(500).default([]) })),
  asyncHandler(async (req, res) => {
    await users.assignUserProjects(req.params.id, {
      projectIds: req.validated.projectIds,
      actorId: req.user.id,
    });
    res.json({ projects: await users.listUserProjects(req.params.id) });
  }),
);

/** Revoke one assignment. The project owner always keeps access. */
router.delete(
  '/admin/users/:id/projects/:projectId',
  validateUuidParam('id'),
  validateUuidParam('projectId'),
  asyncHandler(async (req, res) => {
    await users.unassignUserProject(req.params.id, req.params.projectId);
    res.json({ projects: await users.listUserProjects(req.params.id) });
  }),
);

/** Sign the user out everywhere. */
router.delete(
  '/admin/users/:id/sessions',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const target = await users.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: { code: 'not_found', message: 'User not found.' } });
    res.json(await users.revokeAllSessions(req.params.id));
  }),
);

router.delete(
  '/admin/users/:id',
  validateUuidParam('id'),
  validateQuery(z.object({ reassign: z.string().uuid().optional(), confirm: booleanQuery() })),
  asyncHandler(async (req, res) => {
    res.json(
      await users.deleteUser(req.params.id, {
        actorId: req.user.id,
        reassignTo: req.validatedQuery?.reassign || null,
      }),
    );
  }),
);

module.exports = router;
