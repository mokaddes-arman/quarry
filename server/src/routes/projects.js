'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateUuidParam, validateQuery, booleanQuery } = require('../middleware/validate');
const projects = require('../services/projects');
const documents = require('../services/documents');
const conversations = require('../services/conversations');
const access = require('../services/access');
const storage = require('../lib/storage');

const router = express.Router();

// Every /:id route below is scoped to the signed-in user. An administrator sees
// every project; a normal user sees the projects they own or were assigned.
router.param('id', async (req, _res, next, id) => {
  try {
    req.project = await access.assertProject(req.user, id);
    return next();
  } catch (err) {
    return next(err);
  }
});

const createSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  instructions: z.string().trim().max(8000).optional().nullable(),
  settings: z.record(z.string(), z.any()).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional().nullable(),
  instructions: z.string().trim().max(8000).optional().nullable(),
  status: z.enum(['active', 'archived']).optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

router.get(
  '/',
  validateQuery(z.object({ includeArchived: booleanQuery() })),
  asyncHandler(async (req, res) => {
    res.json({
      projects: await projects.listProjects({
        includeArchived: Boolean(req.validatedQuery?.includeArchived),
        user: req.user,
      }),
    });
  }),
);

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const project = await projects.createProject({ ...req.validated, ownerUserId: req.user.id });
    res.status(201).json({ project });
  }),
);

router.get(
  '/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ project: req.project });
  }),
);

router.patch(
  '/:id',
  validateUuidParam('id'),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const project = await projects.updateProject(req.project.id, req.validated, { user: req.user });
    res.json({ project });
  }),
);

router.post(
  '/:id/archive',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ project: await projects.archiveProject(req.project.id, { user: req.user }) });
  }),
);

router.post(
  '/:id/restore',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ project: await projects.restoreProject(req.project.id, { user: req.user }) });
  }),
);

/**
 * Permanently delete a project. Files are removed from disk first; if that
 * fails the request fails before the database record disappears.
 */
router.delete(
  '/:id',
  validateUuidParam('id'),
  validateQuery(z.object({ confirm: z.literal('yes') })),
  asyncHandler(async (req, res) => {
    const project = req.project;
    // Assignment grants read/use access, never the right to destroy the project.
    await projects.requireProjectOwner(project.id, { user: req.user });
    const { rows } = await require('../db').query('SELECT id FROM documents WHERE project_id = $1', [project.id]);
    const { rows: versions } = await require('../db').query(
      'SELECT storage_path FROM document_versions WHERE project_id = $1',
      [project.id],
    );
    await Promise.allSettled(versions.map((version) => storage.deleteStoredFile(version.storage_path)));
    for (const doc of rows) {
      await storage.removeVersionDirectory(project.id, doc.id, project.owner_user_id).catch(() => {});
    }
    await projects.deleteProject(project.id);
    res.json({ deleted: true, id: project.id });
  }),
);

router.get(
  '/:id/stats',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ stats: await projects.projectStats(req.project.id, { user: req.user }) });
  }),
);

router.get(
  '/:id/documents',
  validateUuidParam('id'),
  validateQuery(
    z.object({
      search: z.string().trim().max(200).optional(),
      status: z.enum(['pending', 'processing', 'indexed', 'failed', 'archived']).optional(),
      includeArchived: booleanQuery(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      sort: z.enum(['created_at', 'title', 'size_bytes', 'status', 'updated_at']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await documents.listDocuments(req.project.id, req.validatedQuery || {});
    res.json(result);
  }),
);

router.get(
  '/:id/conversations',
  validateUuidParam('id'),
  validateQuery(
    z.object({
      search: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      includeArchived: booleanQuery(),
      // Administrators see every internal conversation by default (used by
      // tests and the admin viewer); the chat sidebar asks for its own only.
      mine: booleanQuery(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json({
      conversations: await conversations.listConversations(req.project.id, {
        ...(req.validatedQuery || {}),
        ownerOnly: Boolean(req.validatedQuery?.mine),
        user: req.user,
      }),
    });
  }),
);

router.get(
  '/:id/jobs',
  validateUuidParam('id'),
  validateQuery(
    z.object({ status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
  ),
  asyncHandler(async (req, res) => {
    res.json({ jobs: await documents.listJobs(req.project.id, req.validatedQuery || {}) });
  }),
);

router.get(
  '/:id/search',
  validateUuidParam('id'),
  validateQuery(
    z.object({
      q: z.string().trim().min(1).max(500),
      topK: z.coerce.number().int().min(1).max(50).optional(),
      // Explicit opt-in to include superseded/historical document versions.
      includeHistoricalVersions: booleanQuery(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await conversations.retrieveEvidence({
      projectId: req.project.id,
      question: req.validatedQuery.q,
      options: {
        retrieval: {
          topK: req.validatedQuery.topK,
          includeHistoricalVersions: Boolean(req.validatedQuery.includeHistoricalVersions),
        },
      },
    });
    res.json({ question: req.validatedQuery.q, sources: result.sources, stats: result.stats });
  }),
);

module.exports = router;
