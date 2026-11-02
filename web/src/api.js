// Thin API client for the Global Softel RAG Chat backend.
// The dev server proxies /api to the backend, so a relative base always works.

const BASE = '/api';

function qs(params = {}) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    usp.append(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function parse(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class ApiError extends Error {
  constructor(message, { status, code, details, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, headers, signal } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await parse(res);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('rag:unauthorized'));
    throw new ApiError(data?.error?.message || `Request failed (${res.status})`, {
      status: res.status,
      code: data?.error?.code,
      details: data?.error?.details,
      body: data,
    });
  }
  return data;
}

/** Upload a single image under a specific multipart field name. */
async function uploadImage(path, field, file) {
  const fd = new FormData();
  fd.append(field, file);
  const res = await fetch(BASE + path, { method: 'POST', body: fd });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('rag:unauthorized'));
  const data = await parse(res);
  if (!res.ok) {
    throw new ApiError(data?.error?.message || `Upload failed (${res.status})`, {
      status: res.status,
      code: data?.error?.code,
      details: data?.error?.details,
      body: data,
    });
  }
  return data;
}

/** Upload one or more files as multipart (not JSON). Returns the raw body. */
async function upload(path, fileOrFiles) {
  const fd = new FormData();
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  for (const f of files) fd.append('files', f);
  const res = await fetch(BASE + path, { method: 'POST', body: fd });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('rag:unauthorized'));
  const data = await parse(res);
  return { status: res.status, ok: res.ok, body: data };
}

export const api = {
  // --- authentication ---------------------------------------------------------
  authStatus: () => request('/auth/status'),
  me: () => request('/auth/me'),
  requestLoginLink: (email) => request('/auth/request-link', { method: 'POST', body: { email } }),
  requestPasswordReset: (email) =>
    request('/auth/password/forgot', { method: 'POST', body: { email } }),
  loginWithPassword: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),
  loginLinkInfo: (token) => request('/auth/link-info', { method: 'POST', body: { token } }),
  verifyLogin: (token, password) =>
    request('/auth/verify', {
      method: 'POST',
      body: password ? { token, password } : { token },
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  setupAdmin: (body) => request('/auth/setup', { method: 'POST', body }),

  // --- administration ---------------------------------------------------------
  adminOverview: () => request('/admin/overview'),
  adminListUsers: (params) => request(`/admin/users${qs(params)}`),
  adminCreateUser: (body) => request('/admin/users', { method: 'POST', body }),
  adminUpdateUser: (id, body) => request(`/admin/users/${id}`, { method: 'PATCH', body }),
  adminResendInvite: (id) => request(`/admin/users/${id}/resend`, { method: 'POST' }),
  adminSendPasswordReset: (id) => request(`/admin/users/${id}/password-reset`, { method: 'POST' }),
  adminUserProjects: (id) => request(`/admin/users/${id}/projects`),
  adminAssignProjects: (id, projectIds) =>
    request(`/admin/users/${id}/projects`, { method: 'PUT', body: { projectIds } }),
  adminUnassignProject: (id, projectId) =>
    request(`/admin/users/${id}/projects/${projectId}`, { method: 'DELETE' }),
  adminRevokeSessions: (id) => request(`/admin/users/${id}/sessions`, { method: 'DELETE' }),
  adminDeleteUser: (id, reassignTo) =>
    request(`/admin/users/${id}${qs({ reassign: reassignTo, confirm: 'yes' })}`, { method: 'DELETE' }),

  // --- system -----------------------------------------------------------------
  health: () => request('/health'),
  systemStatus: () => request('/system/status'),
  getSettings: () => request('/settings'),
  updateSetting: (key, value) => request(`/settings/${key}`, { method: 'PUT', body: { value } }),
  embeddingIndex: () => request('/settings/embedding-index'),
  providerMetadata: () => request('/providers/metadata'),

  // --- projects ---------------------------------------------------------------
  listProjects: (includeArchived = false) =>
    request(`/projects${includeArchived ? '?includeArchived=true' : ''}`),
  createProject: (body) => request('/projects', { method: 'POST', body }),
  getProject: (id) => request(`/projects/${id}`),
  updateProject: (id, body) => request(`/projects/${id}`, { method: 'PATCH', body }),
  archiveProject: (id) => request(`/projects/${id}/archive`, { method: 'POST' }),
  restoreProject: (id) => request(`/projects/${id}/restore`, { method: 'POST' }),
  deleteProject: (id) => request(`/projects/${id}?confirm=yes`, { method: 'DELETE' }),
  projectStats: (id) => request(`/projects/${id}/stats`),
  projectDocuments: (id, params) => request(`/projects/${id}/documents${qs(params)}`),
  projectConversations: (id, params) => request(`/projects/${id}/conversations${qs(params)}`),
  projectJobs: (id, params) => request(`/projects/${id}/jobs${qs(params)}`),
  projectSearch: (id, params) => request(`/projects/${id}/search${qs(params)}`),

  // --- documents --------------------------------------------------------------
  uploadFiles: (projectId, files, onDuplicate) =>
    upload(`/projects/${projectId}/documents/upload${qs({ onDuplicate })}`, files),
  addVersion: (documentId, file) => upload(`/documents/${documentId}/versions`, file),
  getDocument: (id) => request(`/documents/${id}`),
  deleteDocument: (id, permanent = false) =>
    request(`/documents/${id}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
  restoreDocument: (id) => request(`/documents/${id}/restore`, { method: 'POST' }),
  reindexDocument: (id, versionId) =>
    request(`/documents/${id}/reindex`, { method: 'POST', body: versionId ? { versionId } : {} }),
  activateVersion: (id, versionId) =>
    request(`/documents/${id}/activate-version`, { method: 'POST', body: { versionId } }),
  retryJob: (jobId) => request(`/jobs/${jobId}/retry`, { method: 'POST' }),
  getChunk: (id) => request(`/chunks/${id}`),
  fileUrl: (id, { versionId, download } = {}) =>
    `${BASE}/documents/${id}/file${qs({ versionId, download: download ? 'true' : undefined })}`,
  /** The shared `.md` representation of a document (JSON preview). */
  documentMarkdown: (id, { versionId } = {}) => request(`/documents/${id}/markdown${qs({ versionId })}`),
  /** Direct link to the shared `.md` file (used by the download icon). */
  documentMarkdownUrl: (id, { versionId } = {}) =>
    `${BASE}/documents/${id}/markdown/download${qs({ versionId })}`,

  // --- knowledge base ---------------------------------------------------------
  // Web links: a URL that is crawled into the knowledge base as a document.
  listWebLinks: (projectId, params) => request(`/projects/${projectId}/links${qs(params)}`),
  createWebLinks: (projectId, body) => request(`/projects/${projectId}/links`, { method: 'POST', body }),
  getWebLink: (id) => request(`/links/${id}`),
  updateWebLink: (id, body) => request(`/links/${id}`, { method: 'PATCH', body }),
  deleteWebLink: (id) => request(`/links/${id}`, { method: 'DELETE' }),
  /** Queue a fresh crawl of a link (re-crawl). */
  crawlWebLink: (id) => request(`/links/${id}/crawl`, { method: 'POST' }),

  // Link lists: a named list of URLs that can be imported into the knowledge base.
  listLinkLists: (projectId) => request(`/projects/${projectId}/link-lists`),
  createLinkList: (projectId, body) => request(`/projects/${projectId}/link-lists`, { method: 'POST', body }),
  getLinkList: (id) => request(`/link-lists/${id}`),
  addLinkListItems: (id, urls) => request(`/link-lists/${id}/items`, { method: 'POST', body: { urls } }),
  deleteLinkList: (id) => request(`/link-lists/${id}`, { method: 'DELETE' }),
  /** Turn every URL of a list into a knowledge-base link and crawl it. */
  importLinkList: (id, collectionId) =>
    request(`/link-lists/${id}/import`, { method: 'POST', body: { collectionId: collectionId || null } }),

  // Collections: named groups of documents and web links.
  listCollections: (projectId) => request(`/projects/${projectId}/collections`),
  createCollection: (projectId, body) => request(`/projects/${projectId}/collections`, { method: 'POST', body }),
  getCollection: (id) => request(`/collections/${id}`),
  updateCollection: (id, body) => request(`/collections/${id}`, { method: 'PATCH', body }),
  deleteCollection: (id) => request(`/collections/${id}`, { method: 'DELETE' }),
  addCollectionItems: (id, body) => request(`/collections/${id}/items`, { method: 'POST', body }),
  removeCollectionItem: (id, itemId) => request(`/collections/${id}/items/${itemId}`, { method: 'DELETE' }),

  // Crawl jobs: the queue that fetches and indexes the linked pages.
  listCrawlJobs: (projectId, params) => request(`/projects/${projectId}/crawl-jobs${qs(params)}`),
  retryCrawlJob: (id) => request(`/crawl-jobs/${id}/retry`, { method: 'POST' }),

  // --- conversations ----------------------------------------------------------
  createConversation: (projectId, body = {}) =>
    request(`/projects/${projectId}/conversations`, { method: 'POST', body }),
  getConversation: (id) => request(`/conversations/${id}`),
  updateConversation: (id, body) => request(`/conversations/${id}`, { method: 'PATCH', body }),
  deleteConversation: (id) => request(`/conversations/${id}`, { method: 'DELETE' }),
  conversationMessages: (id) => request(`/conversations/${id}/messages`),
  evidence: (id, body) => request(`/conversations/${id}/evidence`, { method: 'POST', body }),

  // --- admin conversations ----------------------------------------------------
  adminConversationsList: (params) => request(`/admin/conversations${qs(params)}`),
  adminConversationGet: (id) => request(`/admin/conversations/${id}`),
  adminConversationDelete: (id) => request(`/admin/conversations/${id}`, { method: 'DELETE' }),

  // --- embeds (owner/admin) ---------------------------------------------------
  getProjectEmbed: (projectId) => request(`/projects/${projectId}/embed`),
  updateProjectEmbed: (projectId, body) => request(`/projects/${projectId}/embed`, { method: 'PATCH', body }),
  rotateProjectEmbedKey: (projectId) => request(`/projects/${projectId}/embed/rotate-key`, { method: 'POST' }),
  uploadProjectEmbedLogo: (projectId, file) =>
    uploadImage(`/projects/${projectId}/embed/logo`, 'logo', file),
  deleteProjectEmbedLogo: (projectId) => request(`/projects/${projectId}/embed/logo`, { method: 'DELETE' }),

  // --- public embed -----------------------------------------------------------
  publicEmbedConfig: (key) => request(`/public/embeds/${encodeURIComponent(key)}`),
  publicEmbedLogoUrl: (key) => `${BASE}/public/embeds/${encodeURIComponent(key)}/logo`,
  publicRegisterVisitor: (key, body) =>
    request(`/public/embeds/${encodeURIComponent(key)}/visitors`, { method: 'POST', body }),
  publicEmbedSession: (key, token) =>
    request(`/public/embeds/${encodeURIComponent(key)}/session`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  publicCreateExternalConversation: (key, token) =>
    request(`/public/embeds/${encodeURIComponent(key)}/conversations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }),
  publicConversationMessages: (key, conversationId, token) =>
    request(`/public/embeds/${encodeURIComponent(key)}/conversations/${conversationId}/messages`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  // --- providers --------------------------------------------------------------
  listLlmConfigs: () => request('/providers/llm'),
  createLlmConfig: (body) => request('/providers/llm', { method: 'POST', body }),
  updateLlmConfig: (id, body) => request(`/providers/llm/${id}`, { method: 'PATCH', body }),
  deleteLlmConfig: (id) => request(`/providers/llm/${id}`, { method: 'DELETE' }),
  testLlmConfig: (id) => request(`/providers/llm/${id}/test`, { method: 'POST' }),
  testLlmAdHoc: (body) => request('/providers/llm/test', { method: 'POST', body }),
  setDefaultChat: (id) => request(`/providers/llm/${id}/default`, { method: 'POST' }),

  listEmbeddingConfigs: () => request('/providers/embedding'),
  createEmbeddingConfig: (body) => request('/providers/embedding', { method: 'POST', body }),
  updateEmbeddingConfig: (id, body) =>
    request(`/providers/embedding/${id}`, { method: 'PATCH', body }),
  deleteEmbeddingConfig: (id) => request(`/providers/embedding/${id}`, { method: 'DELETE' }),
  setDefaultEmbedding: (id) => request(`/providers/embedding/${id}/default`, { method: 'POST' }),

  // --- model usage ------------------------------------------------------------
  modelUsage: (params) => request(`/model-usage${qs(params)}`),
  modelUsageCatalog: () => request('/model-usage/catalog'),
};

/**
 * Ask a question and consume the Server-Sent Events stream.
 *
 * Two watchdogs protect the browser: if the server stops sending events for
 * `idleTimeoutMs`, or the whole exchange takes longer than `overallTimeoutMs`,
 * the request is aborted and an error is raised instead of leaving the UI on
 * a spinner forever. A stream that ends without a terminal event is also
 * reported as an error.
 */
async function consumeAskStream(
  url,
  body,
  {
    headers = {},
    onEvent,
    signal,
    idleTimeoutMs = 120000,
    overallTimeoutMs = 300000,
    onUnauthorised,
  } = {},
) {
  const controller = new AbortController();
  const abortWith = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onOuterAbort = () => abortWith(new Error('cancelled'));
  if (signal) {
    if (signal.aborted) abortWith(new Error('cancelled'));
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let timeoutReason = null;
  let idleTimer = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutReason = `The server stopped responding for ${Math.round(idleTimeoutMs / 1000)}s.`;
      abortWith(new Error('idle timeout'));
    }, idleTimeoutMs);
  };
  const overallTimer = setTimeout(() => {
    timeoutReason = `The answer took longer than ${Math.round(overallTimeoutMs / 1000)}s.`;
    abortWith(new Error('overall timeout'));
  }, overallTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      if (res.status === 401) {
        if (onUnauthorised) onUnauthorised();
        else window.dispatchEvent(new CustomEvent('rag:unauthorized'));
      }
      const data = await parse(res);
      throw new ApiError(data?.error?.message || `Request failed (${res.status})`, {
        status: res.status,
        code: data?.error?.code,
        details: data?.error?.details,
        body: data,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let last = null;
    let finished = false;

    armIdleTimer();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            const event = JSON.parse(json);
            last = event;
            if (event.type === 'done' || event.type === 'error' || event.type === 'complete') finished = true;
            onEvent?.(event);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch (err) {
      if (timeoutReason) {
        throw new ApiError(timeoutReason, { code: 'client_timeout', status: 504 });
      }
      if (signal?.aborted) throw err;
      throw new ApiError(err.message || 'The connection to the server was lost.', {
        code: 'stream_error',
        status: 502,
      });
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* already released */
      }
    }

    if (!finished && !timeoutReason) {
      throw new ApiError('The server closed the connection before the answer was finished.', {
        code: 'incomplete_stream',
        status: 502,
      });
    }
    return last;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    if (signal) signal.removeEventListener?.('abort', onOuterAbort);
  }
}

export async function askStream(conversationId, body, options = {}) {
  return consumeAskStream(`${BASE}/conversations/${conversationId}/messages`, body, options);
}

/**
 * The public widget uses the same event protocol, but authenticates with its
 * visitor token rather than a session cookie.
 */
export async function publicAskStream(key, conversationId, token, body, options = {}) {
  return consumeAskStream(
    `${BASE}/public/embeds/${encodeURIComponent(key)}/conversations/${conversationId}/messages`,
    body,
    {
      ...options,
      headers: { ...(options.headers || {}), authorization: `Bearer ${token}` },
      onUnauthorised: options.onUnauthorised,
    },
  );
}

export { qs };
