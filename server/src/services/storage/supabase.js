'use strict';

const fsp = require('node:fs/promises');
const { config } = require('../../config/env');
const { AppError, Codes } = require('../../lib/errors');
const { logger } = require('../../lib/logger');
const { assertStorageKey } = require('./paths');

/**
 * Supabase Storage backend.
 *
 * Uses the private Storage REST API with the service-role key. The key stays on
 * the server: this module never returns it, logs it, or puts it in a URL.
 */

const kind = 'supabase';
const REQUEST_TIMEOUT_MS = 30_000;
const LIST_LIMIT = 1000;
const MAX_ERROR_DETAIL_CHARS = 200;

function createSupabaseStorage({ url, serviceRoleKey, bucket, fetchImpl = fetch }) {
  if (!url || !serviceRoleKey || !bucket) {
    throw new AppError('Supabase Storage is not configured.', { code: 'storage_error', status: 500 });
  }

  const baseUrl = String(url).replace(/\/+$/, '');
  const bucketName = String(bucket);
  const serviceKey = String(serviceRoleKey);
  const usesLegacyJwt = serviceKey.startsWith('eyJ');
  const authStyle = usesLegacyJwt ? 'apikey+authorization_bearer_jwt' : 'apikey';

  function truncateText(value) {
    const text = value == null ? '' : String(value);
    return text.length > MAX_ERROR_DETAIL_CHARS ? text.slice(0, MAX_ERROR_DETAIL_CHARS) : text;
  }

  async function readErrorDetail(res) {
    const payload = await res.json().catch(() => null);
    const raw = payload && (typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message);
    return truncateText(raw);
  }

  async function failRequest({ action, res, objectKey = null, fallbackMessage, fallbackStatus }) {
    const detail = await readErrorDetail(res);
    const errorMessage = fallbackMessage || `Supabase Storage ${action} failed (${res.status})${detail ? `: ${detail}` : ''}.`;
    logger.error(
      { bucket: bucketName, objectKey, authStyle, action, status: res.status, detail },
      `Supabase Storage ${action} failed`,
    );
    throw new AppError(errorMessage, {
      code: fallbackStatus ? (fallbackStatus === 410 ? Codes.NOT_FOUND : fallbackStatus) : 'storage_error',
      status: fallbackStatus || 502,
      details: { action, status: res.status, detail },
    });
  }

  function authHeaders(extra = {}) {
    const headers = { apikey: serviceKey };
    if (usesLegacyJwt) headers.authorization = `Bearer ${serviceKey}`;
    return { ...headers, ...extra };
  }

  function objectUrl(key) {
    const encodedKey = assertStorageKey(key)
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    return `${baseUrl}/storage/v1/object/${encodeURIComponent(bucketName)}/${encodedKey}`;
  }

  function listUrl() {
    return `${baseUrl}/storage/v1/object/list/${encodeURIComponent(bucketName)}`;
  }

  async function send(target, options, action, objectKey = null) {
    const res = await fetchImpl(target, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      await failRequest({ action, res, objectKey });
    }
    return res;
  }

  async function moveFileIntoStorage(tempPath, relativePath) {
    const key = assertStorageKey(relativePath);
    const body = await fsp.readFile(tempPath);
    await send(
      objectUrl(key),
      {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/octet-stream',
          'x-upsert': 'true',
        }),
        body,
      },
      'upload',
      relativePath,
    );
    await fsp.unlink(tempPath).catch(() => {});
    return key;
  }

  async function readStoredFile(relativePath, maxBytes = 50 * 1024 * 1024) {
    const key = assertStorageKey(relativePath);
    const res = await fetchImpl(objectUrl(key), {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 400 || res.status === 404) {
      await failRequest({
        action: 'download',
        res,
        objectKey: key,
        fallbackMessage: 'The stored file is missing from storage.',
        fallbackStatus: 410,
      });
    }
    if (!res.ok) {
      await failRequest({ action: 'download', res, objectKey: key });
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      throw new AppError(`Stored file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB read limit.`, {
        code: Codes.FILE_TOO_LARGE,
        status: 413,
      });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new AppError(`Stored file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB read limit.`, {
        code: Codes.FILE_TOO_LARGE,
        status: 413,
      });
    }
    return buffer;
  }

  async function fileExists(relativePath) {
    const key = assertStorageKey(relativePath);
    const res = await fetchImpl(objectUrl(key), {
      method: 'HEAD',
      headers: authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return true;
    if (res.status === 400 || res.status === 404) return false;
    await failRequest({ action: 'existence check', res, objectKey: key });
  }

  async function deleteStoredFile(relativePath) {
    if (!relativePath) return false;
    const key = assertStorageKey(relativePath);
    const res = await fetchImpl(objectUrl(key), {
      method: 'DELETE',
      headers: authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return true;
    if (res.status === 400 || res.status === 404) return false;
    await failRequest({ action: 'delete', res, objectKey: key });
  }

  async function listObjects(prefix) {
    const keys = [];
    let offset = 0;
    for (;;) {
      const res = await send(
        listUrl(),
        {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            prefix,
            limit: LIST_LIMIT,
            offset,
            sortBy: { column: 'name', order: 'asc' },
          }),
        },
        'list',
        prefix,
      );
      const items = await res.json();
      if (!Array.isArray(items) || !items.length) break;
      for (const item of items) {
        if (item?.name) keys.push(`${prefix}/${item.name}`);
      }
      if (items.length < LIST_LIMIT) break;
      offset += items.length;
    }
    return keys;
  }

  async function removeVersionDirectory(projectId, documentId, ownerUserId = null) {
    // Current owner-scoped layout plus the pre-owner layout, for compatibility.
    const prefixes = [
      `${ownerUserId || 'orphan'}/${projectId}/${documentId}`,
      `${projectId}/${documentId}`,
    ];
    const keys = new Set();
    for (const prefix of prefixes) {
      for (const key of await listObjects(prefix)) keys.add(key);
    }
    for (const key of keys) {
      await deleteStoredFile(key);
    }
  }

  return {
    kind,
    moveFileIntoStorage,
    readStoredFile,
    fileExists,
    deleteStoredFile,
    removeVersionDirectory,
  };
}

module.exports = { createSupabaseStorage };

// Index only loads this module when all three settings are present. The factory
// remains exported so the adapter can be unit-tested without real credentials.
if (config.supabaseStorage.enabled) {
  Object.assign(module.exports, createSupabaseStorage(config.supabaseStorage));
}
