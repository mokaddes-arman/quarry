'use strict';

/**
 * Small API helpers shared by the e2e specs.
 *
 * The specs use these for fast, deterministic setup (create a project, seed a
 * document and wait for indexing) and to assert the HTTP contract directly;
 * the browser-facing assertions live in `03-ui-workflow.spec.js`.
 *
 * Everything talks to the same origin Playwright serves the SPA from, so no
 * extra configuration is required.
 */

const { readFileSync } = require('node:fs');
const path = require('node:path');

const API_BASE = () => process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || 3101}`;

// The backend writes a ready-made administrator session to a file once it is
// listening (see `e2e/start-server.js`), so API calls never have to go through
// the passwordless email flow.
let cachedSession = null;
function session() {
  if (cachedSession) return cachedSession;
  const file = process.env.E2E_SESSION_FILE || path.resolve(__dirname, '..', 'storage', '.e2e', 'session.json');
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      cachedSession = JSON.parse(readFileSync(file, 'utf8'));
      return cachedSession;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`e2e session file was not written: ${err.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function authHeaders() {
  return { cookie: `quarry_session=${session().token}` };
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE()}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      ...authHeaders(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, ok: res.ok, data };
}

/** Same as `api`, but with an explicit cookie (used for a second workspace user). */
async function apiAs(cookie, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE()}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, ok: res.ok, data };
}

function sessionCookieFrom(response) {
  const combined =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  return combined
    .map((value) => String(value).split(';')[0])
    .find((value) => value.startsWith('quarry_session='));
}

/**
 * Invite a normal user through the real admin API and exchange the one-time
 * sign-in link for a session cookie. Lets specs seed "another user's" data.
 */
async function createUserWithSession({ email, name = 'Other User' }) {
  const invite = await api('/api/admin/users', {
    method: 'POST',
    body: { email, name, role: 'user' },
  });
  if (!invite.ok) throw new Error(`invite failed (${invite.status}): ${JSON.stringify(invite.data)}`);
  const loginUrl = invite.data.invite.loginUrl;
  const token = new URL(loginUrl).hash.replace(/^#token=/, '');
  const res = await fetch(`${API_BASE()}/api/auth/verify`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`verify failed (${res.status}): ${JSON.stringify(data)}`);
  return { user: data.user, cookie: sessionCookieFrom(res), loginUrl };
}

async function getEmbed(projectId) {
  const { status, ok, data } = await api(`/api/projects/${projectId}/embed`);
  if (!ok) throw new Error(`getEmbed failed (${status}): ${JSON.stringify(data)}`);
  return data.embed;
}

async function updateEmbed(projectId, patch) {
  const { status, ok, data } = await api(`/api/projects/${projectId}/embed`, {
    method: 'PATCH',
    body: patch,
  });
  if (!ok) throw new Error(`updateEmbed failed (${status}): ${JSON.stringify(data)}`);
  return data.embed;
}

/** Public visitor call with no admin cookie, exactly like a third-party site. */
async function publicApi(pathname, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE()}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, ok: res.ok, data };
}

async function registerPublicVisitor(publicKey, { name, email, consent = true }) {
  const { status, ok, data } = await publicApi(`/api/public/embeds/${publicKey}/visitors`, {
    method: 'POST',
    body: { name, email, consent },
  });
  if (!ok) throw new Error(`register visitor failed (${status}): ${JSON.stringify(data)}`);
  return data;
}

async function createExternalConversation(publicKey, token) {
  const { status, ok, data } = await publicApi(`/api/public/embeds/${publicKey}/conversations`, {
    method: 'POST',
    token,
  });
  if (!ok) throw new Error(`create external conversation failed (${status}): ${JSON.stringify(data)}`);
  return data.conversation;
}

/** @returns {Promise<{id: string, name: string}>} */
async function createProject(name) {
  const { status, ok, data } = await api('/api/projects', { method: 'POST', body: { name } });
  if (!ok) throw new Error(`createProject failed (${status}): ${JSON.stringify(data)}`);
  return data.project;
}

/** @returns {Promise<{id: string, name: string}>} */
async function createConversation(projectId, title = 'e2e') {
  const { status, ok, data } = await api(`/api/projects/${projectId}/conversations`, {
    method: 'POST',
    body: { title },
  });
  if (!ok) throw new Error(`createConversation failed (${status}): ${JSON.stringify(data)}`);
  return data.conversation;
}

/** Poll until a document has finished ingesting (or fail loudly). */
async function waitForIndexed(documentId, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, ok, data } = await api(`/api/documents/${documentId}`);
    if (!ok) throw new Error(`getDocument failed (${status}): ${JSON.stringify(data)}`);
    const docStatus = data.document?.status;
    if (docStatus === 'indexed') return data.document;
    if (docStatus === 'failed') {
      throw new Error(`document ${documentId} failed to index: ${JSON.stringify(data.document)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`document ${documentId} did not finish indexing in time (status=${docStatus})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Upload one file to a project and wait until it is fully indexed. */
async function uploadAndIndex(projectId, filename, content, { type = 'text/markdown' } = {}) {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from(content, 'utf8')], { type }), filename);
  const res = await fetch(`${API_BASE()}/api/projects/${projectId}/documents/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  const data = await res.json();
  const first = data?.results?.[0];
  if (!first?.ok) {
    throw new Error(`upload rejected (${res.status}): ${JSON.stringify(data)}`);
  }
  const document = await waitForIndexed(first.documentId);
  return { documentId: first.documentId, document };
}

/**
 * Ask a question and return the non-streaming `result` payload the endpoint
 * wraps in `{ result }`.
 */
async function ask(conversationId, question, options = {}) {
  const { status, ok, data } = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { question, stream: false, ...options },
  });
  if (!ok) throw new Error(`ask failed (${status}): ${JSON.stringify(data)}`);
  return data.result;
}

/** Retrieval only (the "inspect evidence" panel). */
async function evidence(conversationId, question, options = {}) {
  const { status, ok, data } = await api(`/api/conversations/${conversationId}/evidence`, {
    method: 'POST',
    body: { question, ...options },
  });
  if (!ok) throw new Error(`evidence failed (${status}): ${JSON.stringify(data)}`);
  return data;
}

/** A distinctive markdown document so keyword retrieval has unambiguous anchors. */
const SAMPLE_DOCUMENT = `# Platform API Specification

## Authentication

Every request to the Platform API must send an \`Authorization\` header containing
a bearer token. Tokens are issued by the identity service and expire after
60 minutes.

## Rate limits

The Platform API enforces a rate limit of 120 requests per minute for every API key.
Bursts are smoothed over a rolling 10 second window.

## Pagination

List endpoints use cursor pagination. Pass \`cursor\` and \`limit\` query parameters.
`;

const SAMPLE_QUESTION = 'What is the rate limit per minute for the Platform API?';

module.exports = {
  API_BASE,
  api,
  apiAs,
  createUserWithSession,
  createProject,
  createConversation,
  waitForIndexed,
  uploadAndIndex,
  ask,
  evidence,
  getEmbed,
  updateEmbed,
  publicApi,
  registerPublicVisitor,
  createExternalConversation,
  SAMPLE_DOCUMENT,
  SAMPLE_QUESTION,
};
