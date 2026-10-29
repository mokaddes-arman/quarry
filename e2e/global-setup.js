'use strict';

/**
 * Playwright global setup: hand the browser a real administrator session.
 *
 * The e2e backend creates the first administrator at boot and writes a valid
 * session token to `storage/.e2e/session.json` (see `start-server.js`). This
 * runs after the web server is up, waits for that file, and writes a Playwright
 * storage-state file that `playwright.config.js` points `use.storageState` at.
 */

const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const E2E_DIR = path.resolve(__dirname, '..', 'storage', '.e2e');
const SESSION_FILE = process.env.E2E_SESSION_FILE || path.join(E2E_DIR, 'session.json');
const STATE_FILE = process.env.E2E_STATE_FILE || path.join(E2E_DIR, 'state.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function globalSetup() {
  const deadline = Date.now() + 120_000;
  let session = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (session?.token) break;
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }

  if (!session?.token) {
    throw new Error(
      `e2e session file ${SESSION_FILE} was not written: ${lastError ? lastError.message : 'empty file'}`,
    );
  }

  const expires = session.expiresAt ? Math.floor(new Date(session.expiresAt).getTime() / 1000) : undefined;

  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        cookies: [
          {
            name: 'gs_session',
            value: session.token,
            domain: '127.0.0.1',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
            expires,
          },
        ],
        origins: [],
      },
      null,
      2,
    ),
  );
};
