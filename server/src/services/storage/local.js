'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { config, ensureRuntimeDirs } = require('../../config/env');
const { AppError, Codes } = require('../../lib/errors');

/**
 * Local filesystem storage backend.
 *
 * Only relative keys are persisted in the database. Every path read or deleted
 * is re-resolved and verified to live inside the uploads root, which blocks
 * path-traversal attempts from a tampered database row.
 */

const kind = 'local';

function storageRoot() {
  return path.resolve(config.paths.uploads);
}

/** Resolve a relative storage key, refusing anything outside the root. */
function resolveStoredPath(relativePath) {
  const root = storageRoot();
  const full = path.resolve(root, String(relativePath || ''));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    throw new AppError('Refusing to access a file outside the storage directory.', {
      code: Codes.BAD_REQUEST,
      status: 400,
    });
  }
  return full;
}

async function moveFileIntoStorage(tempPath, relativePath) {
  ensureRuntimeDirs();
  const dest = resolveStoredPath(relativePath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(tempPath, dest);
  } catch (err) {
    // Cross-device rename fails on some Windows setups - fall back to copy+unlink.
    if (err.code === 'EXDEV' || err.code === 'EPERM') {
      await fsp.copyFile(tempPath, dest);
      await fsp.unlink(tempPath).catch(() => {});
    } else {
      throw err;
    }
  }
  return dest;
}

async function deleteStoredFile(relativePath) {
  if (!relativePath) return false;
  let full;
  try {
    full = resolveStoredPath(relativePath);
  } catch {
    return false;
  }
  try {
    await fsp.unlink(full);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function removeVersionDirectory(projectId, documentId, ownerUserId = null) {
  // Remove both the current owner-scoped layout and the pre-owner layout so
  // documents uploaded before this change can still be deleted cleanly.
  const keys = [
    path.posix.join(String(ownerUserId || 'orphan'), String(projectId), String(documentId)),
    path.posix.join(String(projectId), String(documentId)),
  ];
  for (const key of keys) {
    const dir = resolveStoredPath(key);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function readStoredFile(relativePath, maxBytes = 50 * 1024 * 1024) {
  const full = resolveStoredPath(relativePath);
  const s = await fsp.stat(full);
  if (s.size > maxBytes) {
    throw new AppError(`Stored file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB read limit.`, {
      code: Codes.FILE_TOO_LARGE,
      status: 413,
    });
  }
  return fsp.readFile(full);
}

async function fileExists(relativePath) {
  try {
    return fs.existsSync(resolveStoredPath(relativePath));
  } catch (err) {
    if (err instanceof AppError) throw err;
    return false;
  }
}

module.exports = {
  kind,
  storageRoot,
  resolveStoredPath,
  moveFileIntoStorage,
  deleteStoredFile,
  removeVersionDirectory,
  readStoredFile,
  fileExists,
};
