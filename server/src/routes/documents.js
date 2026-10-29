'use strict';

const express = require('express');
const path = require('node:path');
const multer = require('multer');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateQuery, validateUuidParam, booleanQuery } = require('../middleware/validate');
const { config, ensureRuntimeDirs } = require('../config/env');
const { AppError, Codes } = require('../lib/errors');
const { newId } = require('../lib/ids');
const { query } = require('../db');
const storage = require('../lib/storage');
const documents = require('../services/documents');
const access = require('../services/access');
const parsers = require('../ingestion/parsers');

const router = express.Router();

ensureRuntimeDirs();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureRuntimeDirs();
      cb(null, config.paths.tmp);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(storage.sanitiseFilename(file.originalname)).slice(0, 12).replace(/[^.\w]/g, '');
      cb(null, `${newId()}${ext}`);
    },
  }),
  limits: {
    fileSize: config.maxUploadSizeMb * 1024 * 1024,
    files: 25,
    fields: 20,
  },
});

const duplicateQuery = z.object({ onDuplicate: z.enum(['skip', 'new_version', 'new_document']).optional() });

/** Upload one or many files into a project. Each file is processed independently. */
router.post(
  '/projects/:projectId/documents/upload',
  validateUuidParam('projectId'),
  access.requireProjectAccess('projectId'),
  upload.array('files', 25),
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (!files.length) {
      throw new AppError('No files were received. Attach files under the "files" field.', { code: Codes.BAD_REQUEST, status: 400 });
    }
    const onDuplicate = duplicateQuery.parse(req.query || {}).onDuplicate || 'skip';
    const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : undefined;

    const results = [];
    for (const file of files) {
      try {
        const registered = await documents.registerUpload({
          projectId: req.params.projectId,
          file,
          onDuplicate,
          title,
        });
        results.push({
          filename: file.originalname,
          ok: true,
          ...registered,
          supportedFormat: parsers.isSupported(path.extname(file.originalname).replace(/^\./, '').toLowerCase()),
        });
      } catch (err) {
        results.push({
          filename: file.originalname,
          ok: false,
          error: { code: err.code || 'upload_failed', message: err.message, details: err.details },
        });
      }
    }

    const summary = {
      received: files.length,
      accepted: results.filter((r) => r.ok).length,
      rejected: results.filter((r) => !r.ok).length,
      duplicates: results.filter((r) => r.error?.code === Codes.DUPLICATE_DOCUMENT).length,
    };
    res.status(summary.accepted ? 202 : 400).json({ results, summary });
  }),
);

/** Add a new version to an existing document. */
router.post(
  '/documents/:id/versions',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  upload.array('files', 1),
  asyncHandler(async (req, res) => {
    const doc = req.resource;
    const files = req.files || [];
    if (!files.length) throw new AppError('No file was received.', { code: Codes.BAD_REQUEST, status: 400 });
    const registered = await documents.registerUpload({
      projectId: doc.project_id,
      file: files[0],
      documentId: doc.id,
    });
    res.status(202).json({ result: { filename: files[0].originalname, ok: true, ...registered } });
  }),
);

router.get(
  '/documents/:id',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  asyncHandler(async (req, res) => {
    res.json({ document: await documents.getDocumentWithVersions(req.params.id) });
  }),
);

router.delete(
  '/documents/:id',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  validateQuery(z.object({ permanent: booleanQuery() })),
  asyncHandler(async (req, res) => {
    const permanent = Boolean(req.validatedQuery?.permanent);
    res.json(await documents.deleteDocument(req.params.id, { permanent }));
  }),
);

router.post(
  '/documents/:id/restore',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  asyncHandler(async (req, res) => {
    res.json(await documents.restoreDocument(req.params.id));
  }),
);

router.post(
  '/documents/:id/reindex',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  validateBody(z.object({ versionId: z.string().uuid().optional().nullable() })),
  asyncHandler(async (req, res) => {
    res.status(202).json(await documents.reindexDocument(req.params.id, { versionId: req.validated.versionId || null }));
  }),
);

router.post(
  '/documents/:id/activate-version',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  validateBody(z.object({ versionId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    res.json(await documents.activateVersion(req.params.id, req.validated.versionId));
  }),
);

/** Serve the original stored file for a document (or a specific version). */
router.get(
  '/documents/:id/file',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  validateQuery(z.object({ versionId: z.string().uuid().optional(), download: z.coerce.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const doc = await documents.getDocumentWithVersions(req.params.id);
    const wanted = req.validatedQuery?.versionId;
    const version = wanted ? doc.versions.find((v) => v.id === wanted) : doc.versions.find((v) => v.id === doc.current_version_id);
    if (!version) throw new AppError('No stored file for that version.', { code: Codes.NOT_FOUND, status: 404 });

    if (!(await storage.fileExists(version.storage_path))) {
      throw new AppError('The stored file is missing from storage.', { code: Codes.NOT_FOUND, status: 410 });
    }
    // Reads go through the adapter so this route works identically for local
    // disk and a private Supabase bucket. Authorization already ran above.
    const body = await storage.readStoredFile(version.storage_path, config.maxUploadSizeMb * 1024 * 1024);
    const safeName = storage.sanitiseFilename(version.original_filename);
    res.setHeader('Content-Disposition', `${req.validatedQuery?.download ? 'attachment' : 'inline'}; filename="${safeName}"`);
    res.setHeader('Content-Length', String(body.length));
    // Match the old sendFile() behaviour by deriving the type from the file
    // extension; uploads sometimes arrive as application/octet-stream.
    res.type(path.extname(version.original_filename) || version.mime_type || 'application/octet-stream');
    res.send(body);
  }),
);

/**
 * The shareable Markdown representation of a document.
 *
 * `GET /documents/:id/markdown` returns JSON so the UI can preview the file,
 * `GET /documents/:id/markdown/download` sends the raw `.md` file (that is
 * what the download icon in "View documents" points at).
 */
router.get(
  '/documents/:id/markdown',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  validateQuery(z.object({ versionId: z.string().uuid().optional() })),
  asyncHandler(async (req, res) => {
    const result = await documents.buildDocumentMarkdown(req.params.id, {
      versionId: req.validatedQuery?.versionId || null,
    });
    res.json({ markdown: result });
  }),
);

router.get(
  '/documents/:id/markdown/download',
  validateUuidParam('id'),
  access.requireOwnedAccess('document', 'id'),
  validateQuery(z.object({ versionId: z.string().uuid().optional() })),
  asyncHandler(async (req, res) => {
    const result = await documents.buildDocumentMarkdown(req.params.id, {
      versionId: req.validatedQuery?.versionId || null,
    });
    const filename = storage.sanitiseFilename(result.filename, 'document.md');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(result.markdown);
  }),
);

/** Full content + metadata of a single retrieved chunk (citation inspection). */
router.get(
  '/chunks/:id',
  validateUuidParam('id'),
  access.requireOwnedAccess('chunk', 'id'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.id, c.content, c.chunk_index, c.token_count, c.char_count, c.metadata, c.created_at,
              d.id AS document_id, d.title AS document_title, d.original_filename, d.file_ext,
              v.id AS document_version_id, v.version_number, v.status AS version_status, v.is_active
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN document_versions v ON v.id = c.document_version_id
       WHERE c.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new AppError('Chunk not found.', { code: Codes.NOT_FOUND, status: 404 });
    res.json({ chunk: rows[0] });
  }),
);

router.post(
  '/jobs/:id/retry',
  validateUuidParam('id'),
  access.requireOwnedAccess('ingestionJob', 'id'),
  asyncHandler(async (req, res) => {
    res.status(202).json(await documents.retryJob(req.params.id));
  }),
);

module.exports = router;
