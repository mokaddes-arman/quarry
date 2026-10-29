'use strict';

const fsp = require('node:fs/promises');
const { config } = require('../../config/env');
const { sha256 } = require('../../lib/ids');
const { sanitiseFilename, buildRelativePath } = require('./paths');

/**
 * Storage adapter.
 *
 * Both backends expose the same object operations. Local disk is the default
 * for development and tests; Supabase Storage is selected only when all three
 * Supabase variables are present. The database stores the same relative object
 * key in either case.
 */

const backend = config.supabaseStorage.enabled ? require('./supabase') : require('./local');

/** Hash a temporary upload before it is moved into remote storage. */
async function computeFileHash(filePath) {
  return sha256(await fsp.readFile(filePath));
}

/** Size of a temporary upload. */
async function statSize(filePath) {
  const stat = await fsp.stat(filePath);
  return stat.size;
}

const storage = {
  backend: backend.kind,
  sanitiseFilename,
  buildRelativePath,
  computeFileHash,
  statSize,
  moveFileIntoStorage: backend.moveFileIntoStorage,
  readStoredFile: backend.readStoredFile,
  fileExists: backend.fileExists,
  deleteStoredFile: backend.deleteStoredFile,
  removeVersionDirectory: backend.removeVersionDirectory,
};

// Local-only path helpers are kept for existing tests and local diagnostics.
if (backend.resolveStoredPath) {
  storage.resolveStoredPath = backend.resolveStoredPath;
  storage.storageRoot = backend.storageRoot;
}

module.exports = storage;
