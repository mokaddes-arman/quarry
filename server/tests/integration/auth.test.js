'use strict';

/**
 * Authentication contract tests.
 *
 * These use a plain `createApp()` (no test-only impersonation) so every request
 * has to authenticate the way a browser does: with the HttpOnly session cookie
 * obtained from a single-use sign-in link.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import * as h from '../helpers.js';
import { createApp } from '../../src/app.js';
import users from '../../src/services/users.js';

let app;

const EMAIL = 'person@test.local';

async function createUser({ email = EMAIL, role = 'user', status = 'invited' } = {}) {
  return h.createTestUser({ email, name: 'Person', role, status });
}

function readCookie(res, name = 'gs_session') {
  const cookies = res.headers['set-cookie'] || [];
  for (const cookie of cookies) {
    const [pair] = String(cookie).split(';');
    const idx = pair.indexOf('=');
    if (idx !== -1 && pair.slice(0, idx) === name) {
      return decodeURIComponent(pair.slice(idx + 1));
    }
  }
  return null;
}

beforeAll(async () => {
  await h.setupTestApp();
  // Intentionally no testAuth: this app only accepts real sessions.
  app = createApp();
});

afterAll(async () => {
  await h.teardownTestApp();
});

beforeEach(async () => {
  await h.resetData();
  // Keep the seeded administrator, drop every account a previous test created.
  await h.query('DELETE FROM users WHERE id <> $1', [h.TEST_ADMIN_ID]);
});

describe('session authentication', () => {
  it('reports the account state without leaking anything', async () => {
    const res = await request(app).get('/api/auth/status').expect(200);
    expect(res.body.setupRequired).toBe(false);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.user).toBeNull();
    expect(typeof res.body.emailConfigured).toBe('boolean');
  });

  it('rejects anonymous access to the API', async () => {
    const res = await request(app).get('/api/projects').expect(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('accepts a sign-in link exactly once and opens a working session', async () => {
    const user = await createUser();
    const link = await users.issueLoginToken({ userId: user.id });

    // The link itself is not an API response, so peek at the token directly.
    const verify = await request(app).post('/api/auth/verify').send({ token: link.token }).expect(200);
    expect(verify.body.user.email).toBe(EMAIL);
    const cookie = readCookie(verify);
    expect(cookie).toBeTruthy();

    const me = await request(app).get('/api/auth/me').set('Cookie', `gs_session=${cookie}`).expect(200);
    expect(me.body.user.id).toBe(user.id);

    // Replaying the same link must fail.
    await request(app).post('/api/auth/verify').send({ token: link.token }).expect(400);
  });

  it('marks a user active after their first sign-in', async () => {
    const user = await createUser({ email: 'new@test.local', status: 'invited' });
    const link = await users.issueLoginToken({ userId: user.id });
    await request(app).post('/api/auth/verify').send({ token: link.token }).expect(200);

    const refreshed = await users.getUser(user.id);
    expect(refreshed.status).toBe('active');
    expect(refreshed.last_login_at).toBeTruthy();
  });

  it('treats unknown email addresses identically to known ones', async () => {
    await createUser({ email: 'known@test.local' });

    const known = await request(app).post('/api/auth/request-link').send({ email: 'known@test.local' }).expect(200);
    const unknown = await request(app).post('/api/auth/request-link').send({ email: 'nobody@test.local' }).expect(200);
    expect(unknown.body).toEqual(known.body);
    expect(JSON.stringify(unknown.body)).not.toContain('token');
  });

  it('invalidates the previous link when a new one is requested', async () => {
    const user = await createUser();
    const first = await users.issueLoginToken({ userId: user.id });
    const second = await users.issueLoginToken({ userId: user.id });

    await request(app).post('/api/auth/verify').send({ token: first.token }).expect(400);
    await request(app).post('/api/auth/verify').send({ token: second.token }).expect(200);
  });

  it('rejects expired links', async () => {
    const user = await createUser();
    const link = await users.issueLoginToken({ userId: user.id });
    await h.query(
      `UPDATE auth_login_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [user.id],
    );
    const res = await request(app).post('/api/auth/verify').send({ token: link.token }).expect(400);
    expect(res.body.error.message).toMatch(/expired|invalid/i);
  });

  it('refuses disabled accounts', async () => {
    const user = await createUser({ email: 'blocked@test.local', status: 'disabled' });
    const link = await users.issueLoginToken({ userId: user.id });
    const res = await request(app).post('/api/auth/verify').send({ token: link.token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(readCookie(res)).toBeNull();
  });

  it('revokes the session on logout', async () => {
    const user = await createUser();
    const link = await users.issueLoginToken({ userId: user.id });
    const verify = await request(app).post('/api/auth/verify').send({ token: link.token }).expect(200);
    const cookie = readCookie(verify);

    await request(app).post('/api/auth/logout').set('Cookie', `gs_session=${cookie}`).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', `gs_session=${cookie}`).expect(401);
  });

  it('blocks first-run setup once an account exists', async () => {
    await createUser({ email: 'existing@test.local' });
    const res = await request(app)
      .post('/api/auth/setup')
      .send({ email: 'second@test.local' })
      .expect(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('rejects cross-site state-changing requests', async () => {
    const res = await request(app)
      .post('/api/auth/request-link')
      .set('Origin', 'https://evil.example')
      .send({ email: 'victim@test.local' })
      .expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('administrator user management', () => {
  async function adminCookie() {
    const link = await users.issueLoginToken({ userId: h.TEST_ADMIN_ID });
    const res = await request(app).post('/api/auth/verify').send({ token: link.token }).expect(200);
    return `gs_session=${readCookie(res)}`;
  }

  async function userCookie(user) {
    const link = await users.issueLoginToken({ userId: user.id });
    const res = await request(app).post('/api/auth/verify').send({ token: link.token }).expect(200);
    return `gs_session=${readCookie(res)}`;
  }

  it('creates an account whose one-time link signs the new user in', async () => {
    const cookie = await adminCookie();
    const res = await request(app)
      .post('/api/admin/users')
      .set('Cookie', cookie)
      .send({ email: 'invited@test.local', name: 'Invited Person' })
      .expect(201);

    expect(res.body.user).toMatchObject({ email: 'invited@test.local', role: 'user', status: 'invited' });
    expect(res.body.invite.emailSent).toBe(false);
    expect(res.body.invite.loginUrl).toMatch(/^https?:\/\/.+\/login#token=/);
    expect(res.body.invite.loginUrl).not.toContain('invited@test.local');

    const token = res.body.invite.loginUrl.split('#token=')[1];
    const verify = await request(app).post('/api/auth/verify').send({ token }).expect(200);
    expect(verify.body.user).toMatchObject({ email: 'invited@test.local', role: 'user', status: 'active' });

    // Single use: replaying the same URL is rejected.
    await request(app).post('/api/auth/verify').send({ token }).expect(400);
  });

  it('rejects a duplicate email address', async () => {
    const cookie = await adminCookie();
    await createUser({ email: 'taken@test.local' });
    const res = await request(app)
      .post('/api/admin/users')
      .set('Cookie', cookie)
      .send({ email: 'TAKEN@test.local' })
      .expect(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('disabling an account ends its sessions and blocks further links', async () => {
    const admin = await adminCookie();
    const user = await createUser({ email: 'soon-disabled@test.local', status: 'active' });
    const cookie = await userCookie(user);
    await request(app).get('/api/projects').set('Cookie', cookie).expect(200);

    await request(app)
      .patch(`/api/admin/users/${user.id}`)
      .set('Cookie', admin)
      .send({ status: 'disabled' })
      .expect(200);

    await request(app).get('/api/projects').set('Cookie', cookie).expect(401);
    await request(app)
      .post(`/api/admin/users/${user.id}/resend`)
      .set('Cookie', admin)
      .expect(409);
  });

  it('protects the last remaining administrator', async () => {
    const cookie = await adminCookie();

    const demote = await request(app)
      .patch(`/api/admin/users/${h.TEST_ADMIN_ID}`)
      .set('Cookie', cookie)
      .send({ role: 'user' })
      .expect(409);
    expect(demote.body.error.message).toMatch(/last remaining administrator/i);

    await request(app)
      .patch(`/api/admin/users/${h.TEST_ADMIN_ID}`)
      .set('Cookie', cookie)
      .send({ status: 'disabled' })
      .expect(409);

    await request(app)
      .delete(`/api/admin/users/${h.TEST_ADMIN_ID}`)
      .set('Cookie', cookie)
      .expect(409);
  });

  it('requires an active administrator for project reassignment before deletion', async () => {
    const cookie = await adminCookie();
    const user = await createUser({ email: 'owner@test.local', status: 'active' });
    await h.query(
      `INSERT INTO projects (name, slug, description, owner_user_id) VALUES ('Owned project', 'owned-project', 'x', $1)`,
      [user.id],
    );

    const blocked = await request(app)
      .delete(`/api/admin/users/${user.id}`)
      .set('Cookie', cookie)
      .expect(409);
    expect(blocked.body.error.details.projectCount).toBe(1);

    // The account itself cannot take over its own projects.
    await request(app)
      .delete(`/api/admin/users/${user.id}?reassign=${user.id}`)
      .set('Cookie', cookie)
      .expect(422);

    // Nor can a disabled administrator.
    const disabledAdmin = await createUser({
      email: 'disabled-admin@test.local',
      role: 'admin',
      status: 'disabled',
    });
    await request(app)
      .delete(`/api/admin/users/${user.id}?reassign=${disabledAdmin.id}`)
      .set('Cookie', cookie)
      .expect(422);

    const deleted = await request(app)
      .delete(`/api/admin/users/${user.id}?reassign=${h.TEST_ADMIN_ID}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(deleted.body.reassignedProjects).toBe(1);

    const { rows } = await h.query('SELECT owner_user_id, name FROM projects WHERE name = $1', ['Owned project']);
    expect(rows[0]).toMatchObject({ owner_user_id: h.TEST_ADMIN_ID, name: 'Owned project' });
  });

  it('resends a fresh link and revokes sessions on demand', async () => {
    const cookie = await adminCookie();
    const user = await createUser({ email: 'resend@test.local', status: 'active' });
    const userSession = await userCookie(user);
    const originalLink = await users.issueLoginToken({ userId: user.id });

    const resend = await request(app)
      .post(`/api/admin/users/${user.id}/resend`)
      .set('Cookie', cookie)
      .expect(202);
    expect(resend.body.loginUrl).toMatch(/\/login#token=/);

    // Issuing the new link invalidates the previous unused one.
    await request(app).post('/api/auth/verify').send({ token: originalLink.token }).expect(400);

    await request(app)
      .delete(`/api/admin/users/${user.id}/sessions`)
      .set('Cookie', cookie)
      .expect(200);
    await request(app).get('/api/projects').set('Cookie', userSession).expect(401);
  });
});
