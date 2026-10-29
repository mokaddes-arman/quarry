'use strict';

/**
 * Playwright web server for the end-to-end suite (`npm run test:e2e`).
 *
 * It prepares a deterministic, fully offline backend so the tests never depend
 * on a network call, a real API key or a downloaded embedding model:
 *   1. builds the React client so the API can serve the SPA from one origin,
 *   2. wipes and re-creates a throwaway database + storage directory,
 *   3. forces `hash` embeddings and the `mock` language model,
 *   4. boots the real server (`server/src/index.js`).
 *
 * Environment overrides:
 *   E2E_PORT        port to listen on (default 3101)
 *   E2E_SKIP_BUILD  set to "1" to reuse an existing web/dist build
 *   E2E_LOG_LEVEL   server log level (default silent, because NODE_ENV=test)
 */

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const e2eDir = path.join(root, 'storage', '.e2e');
const port = String(process.env.E2E_PORT || 3101);

const log = (msg) => process.stdout.write(`[e2e] ${msg}\n`);

// --- 1. Build the SPA so it can be served from a single origin --------------
if (process.env.E2E_SKIP_BUILD !== '1') {
  log('building the web client (set E2E_SKIP_BUILD=1 to reuse the last build)...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build', '--workspace', 'web'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    // npm is a .cmd shim on Windows, which must go through a shell.
    shell: process.platform === 'win32',
  });
  if (build.error) {
    log(`could not run npm: ${build.error.message}`);
    process.exit(1);
  }
  if (build.status !== 0) {
    log(`web build failed (exit ${build.status}); cannot start the e2e server`);
    process.exit(1);
  }
}

if (!existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  log('web/dist/index.html is missing - run `npm run build` first');
  process.exit(1);
}

// --- 2. Fresh database + storage for every run ------------------------------
// Each run starts from zero so tests are order-independent and repeatable.
rmSync(e2eDir, { recursive: true, force: true });
mkdirSync(e2eDir, { recursive: true });

// --- 3. Deterministic, offline configuration --------------------------------
// Set BEFORE `server/src/config/env` is loaded. dotenv does not override values
// that are already present, so these win over the developer's .env.
const forced = {
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'silent',
  HOST: '127.0.0.1',
  PORT: port,
  PGLITE_DIR: path.join(e2eDir, 'pgdata'),
  STORAGE_DIR: path.join(e2eDir, 'store'),
  HF_HOME: path.join(e2eDir, 'models'),
  // Deterministic vectors: no model download, no network.
  DEFAULT_EMBEDDING_PROVIDER: 'hash',
  DEFAULT_EMBEDDING_MODEL: 'hash-384',
  EMBEDDING_DIM: '384',
  // Offline language model: the mock provider returns a grounded, citable answer.
  DEFAULT_LLM_PROVIDER: 'mock',
  DEFAULT_LLM_MODEL: 'mock',
  DISABLE_HOSTED_AI: 'false',
  // Fixed test-only master key; NODE_ENV=test means config.isTest is true.
  APP_MASTER_KEY: 'e2e-master-key-0123456789abcdefghijklmnopqrstuv',
  RETRIEVAL_TOP_K: '6',
  RETRIEVAL_VECTOR_CANDIDATES: '30',
  RETRIEVAL_KEYWORD_CANDIDATES: '30',
  CHUNK_SIZE_CHARS: '800',
  CHUNK_OVERLAP_CHARS: '100',
  MAX_UPLOAD_SIZE_MB: '20',
  // First-run administrator. The bootstrap also writes a ready-made session for
  // Playwright below, so every test starts signed in without going through the
  // email flow.
  ADMIN_EMAIL: 'e2e-admin@example.test',
  ADMIN_NAME: 'E2E Admin',
  APP_PUBLIC_URL: `http://127.0.0.1:${port}`,
};
for (const [key, value] of Object.entries(forced)) process.env[key] = value;

// --- 4. Boot the real API (it serves web/dist on the same origin) ------------
log(`starting API on http://127.0.0.1:${port} (database: embedded PGlite, embeddings: hash, LLM: mock)`);
const { bootstrap } = require('../server/src/index.js');
bootstrap()
  .then(async () => {
    // Everything below runs after migrations, so the first administrator exists.
    // Create a real session through the normal token flow and hand it to
    // Playwright (globalSetup waits for this file) and to the API helpers.
    const { writeFileSync } = require('node:fs');
    const { query } = require('../server/src/db');
    const users = require('../server/src/services/users');

    const { rows } = await query(
      "SELECT id FROM users WHERE email_normalised = 'e2e-admin@example.test' LIMIT 1",
    );
    if (!rows[0]) throw new Error('e2e administrator was not created');

    const link = await users.issueLoginToken({ userId: rows[0].id, purpose: 'login' });
    const verified = await users.verifyLoginToken(link.token);
    const sessionFile = path.join(e2eDir, 'session.json');
    writeFileSync(
      sessionFile,
      JSON.stringify(
        {
          userId: rows[0].id,
          token: verified.sessionToken,
          expiresAt: verified.sessionExpiresAt,
        },
        null,
        2,
      ),
    );
    log('e2e administrator session written');
  })
  .catch((err) => {
    log(`server failed to start: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
