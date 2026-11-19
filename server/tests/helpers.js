'use strict';

/**
 * Shared test helpers: boot the real application against a throwaway embedded
 * PostgreSQL database, upload documents, and wait for ingestion to finish.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { initDb, closeDb, query } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { startWorker, stopWorker, drainQueue } = require('../src/ingestion/worker');
const crawlWorker = require('../src/crawl/worker');
const { config, ensureRuntimeDirs } = require('../src/config/env');

let app = null;

// Deterministic administrator used by the API tests. The app is created with
// testAuth enabled, so requests are authenticated as this user unless the test
// explicitly impersonates somebody else with the x-test-user header.
const TEST_ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const TEST_ADMIN_EMAIL = 'admin@test.local';

async function ensureTestAdmin() {
  const { rows } = await query(
    `INSERT INTO users (id, email, email_normalised, name, role, status)
     VALUES ($1, $2, $2, 'Test Admin', 'admin', 'active')
     ON CONFLICT (email_normalised) DO UPDATE SET role = 'admin', status = 'active', name = 'Test Admin'
     RETURNING id`,
    [TEST_ADMIN_ID, TEST_ADMIN_EMAIL],
  );
  return rows[0].id;
}

async function setupTestApp() {
  ensureRuntimeDirs();
  await initDb();
  await migrate({ log: false });
  const adminId = await ensureTestAdmin();
  await startWorker();
  await crawlWorker.startWorker();
  app = createApp({ testAuth: true, testAuthUserId: adminId });
  return app;
}

async function teardownTestApp() {
  await crawlWorker.stopWorker().catch(() => {});
  await stopWorker().catch(() => {});
  await closeDb().catch(() => {});
  app = null;
}

function getApp() {
  if (!app) throw new Error('setupTestApp() must run first');
  return app;
}

/** Wipe all application data between tests (keeps migrations in place). */
async function resetData() {
  // Users (and therefore the seeded administrator) survive between tests; all
  // project data and any sessions/tokens do not.
  await query(`TRUNCATE message_sources, messages, conversations, document_chunks, ingestion_jobs,
                        document_versions, documents, embedding_models, embedding_configs,
                        llm_provider_configs, projects, application_settings,
                        crawl_jobs, collection_items, web_links, link_list_items, link_lists,
                        collections, auth_sessions, auth_login_tokens, embed_visitors, project_embeds CASCADE`);
}

async function createProject(name = 'Test Project', description = null) {
  const res = await request(getApp()).post('/api/projects').send({ name, description }).expect(201);
  return res.body.project;
}

/** Upload raw content as a file into a project. */
async function uploadFile(projectId, filename, content, { onDuplicate, authHeaders } = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const req = request(getApp())
    .post(`/api/projects/${projectId}/documents/upload${onDuplicate ? `?onDuplicate=${onDuplicate}` : ''}`)
    .attach('files', buffer, filename);
  if (authHeaders) Object.assign(req, authHeaders);
  return req;
}

/** Upload and wait until ingestion settles, returning the document id. */
async function uploadAndIndex(projectId, filename, content, options = {}) {
  const res = await uploadFile(projectId, filename, content, options);
  if (res.status >= 400) {
    const err = new Error(`upload failed (${res.status}): ${JSON.stringify(res.body)}`);
    err.response = res;
    throw err;
  }
  const first = res.body.results[0];
  if (!first?.ok) {
    const err = new Error(`upload rejected: ${JSON.stringify(first?.error)}`);
    err.result = first;
    throw err;
  }
  await waitForIndexing(first.documentId);
  return first.documentId;
}

async function waitForIndexing(documentId, { timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(getApp()).get(`/api/documents/${documentId}`);
    const status = res.body.document?.status;
    if (status === 'indexed' || status === 'failed') return res.body.document;
    if (Date.now() > deadline) throw new Error(`indexing did not finish in time (status=${status})`);
    await drainQueue({ timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Wait until a crawled link has been fetched *and* indexed.
 *
 * A crawl has two stages: the crawl worker stores the page as a document and
 * queues the normal ingestion, which then marks the link as indexed. Both
 * stages have to finish before the link is usable.
 */
async function waitForCrawl(linkId, { timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await query(
      `SELECT l.status, l.last_error, l.document_id, l.crawl_count,
              (SELECT j.status FROM crawl_jobs j WHERE j.web_link_id = l.id ORDER BY j.created_at DESC LIMIT 1) AS job_status
       FROM web_links l WHERE l.id = $1`,
      [linkId],
    );
    const link = rows[0];
    if (link?.job_status === 'failed' || link?.status === 'failed') return link;
    if (link?.job_status === 'completed' && link?.status === 'indexed') return link;
    if (Date.now() > deadline) {
      throw new Error(`crawl did not finish in time (link=${link?.status}, job=${link?.job_status})`);
    }
    await crawlWorker.drainQueue({ timeoutMs: 5000 });
    await drainQueue({ timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function createConversation(projectId, body = {}) {
  const res = await request(getApp()).post(`/api/projects/${projectId}/conversations`).send(body).expect(201);
  return res.body.conversation;
}

/** Ask a question without streaming (simplest assertion shape). */
async function ask(conversationId, question, options = {}) {
  const res = await request(getApp())
    .post(`/api/conversations/${conversationId}/messages`)
    .send({ question, stream: false, ...options });
  return res;
}

/** Register a provider configuration (mock by default). */
async function addMockProvider({ name = 'Mock Provider', isDefaultChat = true } = {}) {
  const res = await request(getApp())
    .post('/api/providers/llm')
    .send({ name, provider: 'mock', model: 'mock-1', isDefaultChat })
    .expect(201);
  return res.body.config;
}

/** Create an additional account, for per-user isolation tests. */
async function createTestUser({ email, name = null, role = 'user', status = 'active' } = {}) {
  const { rows } = await query(
    `INSERT INTO users (email, email_normalised, name, role, status)
     VALUES ($1, lower($1), $2, $3, $4)
     RETURNING id, email, name, role, status`,
    [email, name, role, status],
  );
  return rows[0];
}

/**
 * A supertest chain that impersonates a specific user. testAuth must be on (it
 * is for the shared app), and this header is ignored in production.
 */
function requestAs(userId) {
  const withUser = (test) => test.set('x-test-user', userId);
  return {
    get: (url) => withUser(request(getApp()).get(url)),
    post: (url) => withUser(request(getApp()).post(url)),
    put: (url) => withUser(request(getApp()).put(url)),
    patch: (url) => withUser(request(getApp()).patch(url)),
    delete: (url) => withUser(request(getApp()).delete(url)),
  };
}

function tempFile(name, content) {
  const p = path.join(os.tmpdir(), `quarry-test-${Date.now()}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}

module.exports = {
  setupTestApp,
  teardownTestApp,
  getApp,
  resetData,
  createProject,
  uploadFile,
  uploadAndIndex,
  waitForIndexing,
  waitForCrawl,
  createConversation,
  ask,
  addMockProvider,
  tempFile,
  request,
  requestAs,
  createTestUser,
  TEST_ADMIN_ID,
  TEST_ADMIN_EMAIL,
  query,
  config,
};
