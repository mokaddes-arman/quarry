'use strict';

const path = require('node:path');
const { AppError, Codes } = require('../../lib/errors');

/**
 * Storage keys are relative, slash-separated object names. They are persisted
 * in the database and are identical for the local and Supabase backends.
 */

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Produce a safe, human-readable filename (never a path). */
function sanitiseFilename(name, fallback = 'document') {
  let base = path.basename(String(name || ''));
  base = base.replace(/[\u0000-\u001f\u007f]/g, '');
  base = base.replace(/[<>:"/\\|?*]/g, '_');
  base = base.replace(/\.+$/, '');
  base = base.trim().replace(/\s+/g, ' ');
  if (!base) base = fallback;
  const ext = path.extname(base);
  const stemRaw = path.basename(base, ext);
  let stem = stemRaw.slice(0, 120) || fallback;
  if (RESERVED.has(stem.toLowerCase())) stem = `_${stem}`;
  const safeExt = ext.slice(0, 12).replace(/[^.\w]/g, '');
  return `${stem}${safeExt}`;
}

function safeSegment(value, fallback) {
  const segment = String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
  return segment && segment !== '.' && segment !== '..' ? segment : fallback;
}

/**
 * Object key layout:
 *   <owner user id>/<project id>/<document id>/v<version>__<filename>
 *
 * The owner and document ids make tenant isolation visible in the storage
 * namespace and allow a document's objects to be removed by prefix.
 */
function buildRelativePath({ ownerUserId, projectId, documentId, versionNumber, originalFilename }) {
  const safe = sanitiseFilename(originalFilename);
  return path.posix.join(
    safeSegment(ownerUserId, 'orphan'),
    safeSegment(projectId, 'project'),
    safeSegment(documentId, 'document'),
    `v${versionNumber}__${safe}`,
  );
}

/**
 * Widget logos live in a dedicated folder so they can be backed up, reviewed,
 * or retained separately from uploaded knowledge-base documents. The folder is
 * a prefix inside the configured bucket, so it reuses the same Supabase URL and
 * service-role key as document storage.
 */
const EMBED_LOGO_PREFIX = 'external_logo';

function buildEmbedLogoPath({ projectId, embedId, originalFilename, folder = EMBED_LOGO_PREFIX }) {
  const safe = sanitiseFilename(originalFilename, 'logo.png');
  return path.posix.join(
    safeSegment(folder, EMBED_LOGO_PREFIX),
    safeSegment(projectId, 'project'),
    safeSegment(embedId, 'embed'),
    `v1__${safe}`,
  );
}

/** Reject keys that could escape an object prefix in either backend. */
function assertStorageKey(relativePath) {
  const key = String(relativePath || '');
  const segments = key.split('/');
  if (!key || segments.some((part) => !part || part === '.' || part === '..')) {
    throw new AppError('Refusing to access an invalid storage key.', {
      code: Codes.BAD_REQUEST,
      status: 400,
    });
  }
  return key;
}

module.exports = {
  EMBED_LOGO_PREFIX,
  sanitiseFilename,
  buildRelativePath,
  buildEmbedLogoPath,
  assertStorageKey,
};
