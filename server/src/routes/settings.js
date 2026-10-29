'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody } = require('../middleware/validate');
const { requireAdmin } = require('../middleware/auth');
const { getSetting, setSetting, embeddingIndexStatus } = require('../services/embeddings');
const { config } = require('../config/env');

const router = express.Router();

const ALLOWED_KEYS = new Set([
  'ui_theme',
  'default_retrieval',
  'active_embedding_config_id',
  'cross_project_default',
]);

/**
 * Theme is the one setting every signed-in user may write: it is a display
 * preference, not configuration. It is declared before the admin gate below.
 */
router.put(
  '/settings/ui_theme',
  validateBody(z.object({ value: z.any() })),
  asyncHandler(async (req, res) => {
    await setSetting('ui_theme', req.validated.value);
    res.json({ key: 'ui_theme', value: await getSetting('ui_theme') });
  }),
);

// Everything below exposes or changes system configuration. The path prefix
// keeps the gate from applying to unrelated routers mounted at /api.
router.use('/settings', requireAdmin);

router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const { query } = require('../db');
    const { rows } = await query('SELECT key, value, updated_at FROM application_settings ORDER BY key');
    res.json({
      settings: Object.fromEntries(rows.map((r) => [r.key, r.value])),
      raw: rows,
      defaults: {
        retrieval: config.retrieval,
        chunkSizeChars: config.chunkSizeChars,
        chunkOverlapChars: config.chunkOverlapChars,
        maxUploadSizeMb: config.maxUploadSizeMb,
        embeddingDim: config.embeddingDim,
        hostedAiDisabled: config.disableHostedAi,
      },
    });
  }),
);

router.put(
  '/settings/:key',
  validateBody(z.object({ value: z.any() })),
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: { code: 'bad_request', message: `Setting "${key}" is not editable.` } });
    }
    await setSetting(key, req.validated.value);
    res.json({ key, value: await getSetting(key) });
  }),
);

/** Embedding index health: how many chunks are stale relative to the active model. */
router.get(
  '/settings/embedding-index',
  asyncHandler(async (_req, res) => {
    res.json(await embeddingIndexStatus());
  }),
);

module.exports = router;
