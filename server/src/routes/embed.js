'use strict';

const express = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const multer = require('multer');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateUuidParam } = require('../middleware/validate');
const { config, ensureRuntimeDirs } = require('../config/env');
const { newId } = require('../lib/ids');
const { AppError, Codes } = require('../lib/errors');
const embeds = require('../services/embed');

/**
 * Per-project embed configuration. Owner-only (administrators may manage any
 * project). The public widget itself lives in routes/public.js and never needs
 * a session.
 */
const router = express.Router();

ensureRuntimeDirs();

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureRuntimeDirs();
      cb(null, config.paths.tmp);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10).replace(/[^.\w]/g, '');
      cb(null, `embed-logo-${newId()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!IMAGE_TYPES.has(file.mimetype)) {
      return cb(
        new AppError('The logo must be a PNG, JPEG, WEBP or GIF image.', {
          code: Codes.VALIDATION,
          status: 422,
        }),
      );
    }
    return cb(null, true);
  },
});

const originList = z
  .array(z.string().trim().min(1).max(500))
  .max(50)
  .transform((values) => [
    ...new Set(
      values
        .map((value) => embeds.normalizeOrigin(value))
        .filter(Boolean),
    ),
  ]);

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedOrigins: originList.optional(),
    brandName: z.string().trim().max(120).optional().nullable(),
    slogan: z.string().trim().max(300).optional().nullable(),
    logoUrl: z.string().trim().max(2000).optional().nullable(),
    themeColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour such as #2563eb.')
      .optional(),
    welcomeMessage: z.string().trim().max(1000).optional().nullable(),
    consentRequired: z.boolean().optional(),
    consentTitle: z.string().trim().min(1).max(160).optional(),
    consentBody: z.string().trim().min(1).max(4000).optional(),
    consentUrl: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

function publicBase(req) {
  return (
    config.appPublicUrl ||
    req.get('origin') ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/+$/, '');
}

function withUrls(req, embed) {
  const base = publicBase(req);
  const configJson = embeds.serializeEmbedConfig(embed, { includeKeys: true });
  const scriptUrl = `${base}/embed.js?key=${encodeURIComponent(embed.public_key)}`;
  return {
    ...configJson,
    widgetUrl: `${base}/embed/${encodeURIComponent(embed.public_key)}`,
    scriptUrl,
    scriptTag: `<script src="${scriptUrl}" async></script>`,
  };
}

router.get(
  '/projects/:projectId/embed',
  validateUuidParam('projectId'),
  asyncHandler(async (req, res) => {
    const embed = await embeds.ensureEmbed(req.params.projectId, { user: req.user });
    res.json({ embed: withUrls(req, embed) });
  }),
);

router.patch(
  '/projects/:projectId/embed',
  validateUuidParam('projectId'),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const embed = await embeds.updateEmbed(req.params.projectId, { user: req.user }, req.validated);
    res.json({ embed: withUrls(req, embed) });
  }),
);

router.post(
  '/projects/:projectId/embed/rotate-key',
  validateUuidParam('projectId'),
  asyncHandler(async (req, res) => {
    const embed = await embeds.rotateEmbedKey(req.params.projectId, { user: req.user });
    res.json({ embed: withUrls(req, embed) });
  }),
);

router.post(
  '/projects/:projectId/embed/logo',
  validateUuidParam('projectId'),
  upload.single('logo'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError('No logo was received. Attach an image under the "logo" field.', {
        code: Codes.BAD_REQUEST,
        status: 400,
      });
    }
    try {
      const embed = await embeds.saveEmbedLogo(req.params.projectId, { user: req.user }, req.file);
      res.status(201).json({ embed: withUrls(req, embed) });
    } catch (err) {
      await fsp.unlink(req.file.path).catch(() => {});
      throw err;
    }
  }),
);

router.delete(
  '/projects/:projectId/embed/logo',
  validateUuidParam('projectId'),
  asyncHandler(async (req, res) => {
    const embed = await embeds.deleteEmbedLogo(req.params.projectId, { user: req.user });
    res.json({ embed: embed ? withUrls(req, embed) : null });
  }),
);

module.exports = router;
