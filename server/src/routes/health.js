'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { query, dbKind } = require('../db');
const { status: migrationStatus } = require('../db/migrate');
const { config } = require('../config/env');
const { embeddingIndexStatus } = require('../services/embeddings');
const { listLlmProviders } = require('../llm');
const { listEmbeddingProviders } = require('../embeddings');
const { supportedExtensions } = require('../ingestion/parsers');
const { workerStatus } = require('../ingestion/worker');
const access = require('../services/access');

const router = express.Router();

/** Liveness probe - cheap, no dependencies touched. */
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() });
});

/** Readiness probe - verifies the database is reachable. */
router.get(
  '/health/ready',
  asyncHandler(async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ready', database: dbKind() });
    } catch (err) {
      res.status(503).json({ status: 'unavailable', error: { code: 'database_unavailable', message: err.message } });
    }
  }),
);

/**
 * System status used by the dashboard and the Settings page.
 *
 * Administrators see deployment details (database, migrations, providers).
 * Normal users get only what their UI needs, and the counts are restricted to
 * the projects they own.
 */
router.get(
  '/system/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const admin = access.isAdmin(req.user);
    const projectIds = await access.allowedProjectIds(req.user, { activeOnly: false });

    let migrations = null;
    let embeddings = null;
    if (admin) {
      migrations = await migrationStatus();
      embeddings = await embeddingIndexStatus();
    }

    const modelCounts = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM projects WHERE id = ANY($1::uuid[]) AND status = 'active') AS projects,
         (SELECT COUNT(*)::int FROM documents WHERE NOT archived AND project_id = ANY($1::uuid[])) AS documents,
         (SELECT COUNT(*)::int FROM document_chunks WHERE project_id = ANY($1::uuid[])) AS chunks,
         (SELECT COUNT(*)::int FROM conversations WHERE NOT archived AND project_id = ANY($1::uuid[])) AS conversations,
         (SELECT COUNT(*)::int FROM ingestion_jobs WHERE status IN ('queued','processing') AND project_id = ANY($1::uuid[])) AS active_jobs`,
      [projectIds],
    );

    res.json({
      app: { name: 'Global Softel RAG Chat', version: '1.0.0', nodeEnv: config.nodeEnv },
      viewer: { role: req.user.role },
      ...(admin
        ? {
            database: { backend: migrations.backend, applied: migrations.applied, pending: migrations.pending },
            embeddings,
          }
        : {}),
      worker: workerStatus(),
      hostedAi: {
        disabled: config.disableHostedAi,
        note: config.disableHostedAi
          ? 'Hosted AI calls are disabled. Retrieval, document management and citations still work; answers are not generated.'
          : 'Retrieved excerpts (not whole documents) are sent to the selected hosted LLM provider.',
      },
      limits: {
        maxUploadSizeMb: config.maxUploadSizeMb,
        chunkSizeChars: config.chunkSizeChars,
        chunkOverlapChars: config.chunkOverlapChars,
        embeddingDim: config.embeddingDim,
      },
      counts: modelCounts.rows[0],
      supportedExtensions: supportedExtensions(),
      ...(admin ? { llmProviders: listLlmProviders(), embeddingProviders: listEmbeddingProviders() } : {}),
    });
  }),
);

module.exports = router;
