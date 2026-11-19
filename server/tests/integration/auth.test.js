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

function readCookie(res, name = 'quarry_session') {
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

    const me = await request(app).get('/api/auth/me').set('Cookie', `quarry_session=${cookie}`).expect(200);
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

    await request(app).post('/api/auth/logout').set('Cookie', `quarry_session=${cookie}`).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', `quarry_session=${cookie}`).expect(401);
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

describe('password authentication', () => {
  it('lets an invited user set a password from the link and then sign in with it', async () => {
    const user = await createUser({ email: 'new-password@test.local', status: 'invited' });
    const link = await users.issueLoginToken({ userId: user.id, purpose: 'invite' });

    // Inspecting the link must not consume it.
    const info = await request(app).post('/api/auth/link-info').send({ token: link.token }).expect(200);
    expect(info.body).toMatchObject({
      purpose: 'invite',
      email: 'new-password@test.local',
      canSetPassword: true,
    });
    await request(app).post('/api/auth/link-info').send({ token: link.token }).expect(200);

    const verify = await request(app)
      .post('/api/auth/verify')
      .send({ token: link.token, password: 'correct-horse-battery' })
      .expect(200);
    expect(verify.body.user).toMatchObject({ email: 'new-password@test.local', hasPassword: true });
    expect(readCookie(verify)).toBeTruthy();

    // The one-time link is now spent, but the password works.
    await request(app).post('/api/auth/link-info').send({ token: link.token }).expect(400);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'new-password@test.local', password: 'correct-horse-battery' })
      .expect(200);
    const cookie = readCookie(login);
    expect(cookie).toBeTruthy();
    await request(app).get('/api/auth/me').set('Cookie', `quarry_session=${cookie}`).expect(200);
  });

  it('rejects a wrong password with the same message as an unknown address', async () => {
    const user = await createUser({ email: 'with-password@test.local', status: 'invited' });
    const link = await users.issueLoginToken({ userId: user.id, purpose: 'invite' });
    await request(app).post('/api/auth/verify').send({ token: link.token, password: 'a-good-password' }).expect(200);

    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'with-password@test.local', password: 'not-the-password' })
      .expect(401);
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: 'not-the-password' })
      .expect(401);

    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect(unknown.body.error.code).toBe('invalid_credentials');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);

    // An account that never set a password cannot be entered with one.
    const noPassword = await createUser({ email: 'no-password@test.local', status: 'active' });
    expect(noPassword.id).toBeTruthy();
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'no-password@test.local', password: 'whatever-password' })
      .expect(401);
  });

  it('returns a generic response for forgot-password requests', async () => {
    await createUser({ email: 'forgot@test.local', status: 'active' });
    const known = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: 'forgot@test.local' })
      .expect(200);
    const unknown = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: 'nobody@test.local' })
      .expect(200);
    expect(unknown.body).toEqual(known.body);
    expect(JSON.stringify(unknown.body)).not.toContain('token');
  });

  it('sends a password-reset link that replaces the old password', async () => {
    const admin = await createUser({ email: 'reset-admin@test.local', role: 'admin', status: 'active' });
    const adminLink = await users.issueLoginToken({ userId: admin.id });
    const adminVerify = await request(app).post('/api/auth/verify').send({ token: adminLink.token }).expect(200);
    const adminCookie = `quarry_session=${readCookie(adminVerify)}`;

    const target = await createUser({ email: 'reset-target@test.local', status: 'invited' });
    const invite = await users.issueLoginToken({ userId: target.id, purpose: 'invite' });
    await request(app).post('/api/auth/verify').send({ token: invite.token, password: 'old-password-123' }).expect(200);

    const reset = await request(app)
      .post(`/api/admin/users/${target.id}/password-reset`)
      .set('Cookie', adminCookie)
      .expect(202);
    expect(reset.body.loginUrl).toMatch(/\/login#token=/);
    const resetToken = reset.body.loginUrl.split('#token=')[1];

    const info = await request(app).post('/api/auth/link-info').send({ token: resetToken }).expect(200);
    expect(info.body).toMatchObject({ purpose: 'password_reset', canSetPassword: true });

    await request(app)
      .post('/api/auth/verify')
      .send({ token: resetToken, password: 'brand-new-password' })
      .expect(200);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset-target@test.local', password: 'brand-new-password' })
      .expect(200);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset-target@test.local', password: 'old-password-123' })
      .expect(401);
  });
});

describe('administrator user management', () => {
  async function adminCookie() {
    const link = await users.issueLoginToken({ userId: h.TEST_ADMIN_ID });
    const res = await request(app).post('/api/auth/verify').send({ token: link.token }).expect(200);
    return `quarry_session=${readCookie(res)}`;
  }

  async function userCookie(user) {
    const link = await users.issueLoginToken({ userId: user.id });
    const res = await request(app).post('/api/auth/verify').send({ token: link.token }).expect(200);
    return `quarry_session=${readCookie(res)}`;
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

  it('assigns a user to one or more projects and honours the access rules', async () => {
    const cookie = await adminCookie();
    const user = await createUser({ email: 'assigned@test.local', status: 'active' });
    const { rows: created } = await h.query(
      `INSERT INTO projects (name, slug, description, owner_user_id) VALUES
         ('Shared Alpha', 'shared-alpha', 'x', $1),
         ('Shared Beta', 'shared-beta', 'x', $1),
         ('Not Shared', 'not-shared', 'x', $1)
       RETURNING id, name`,
      [h.TEST_ADMIN_ID],
    );
    const alpha = created.find((p) => p.name === 'Shared Alpha');
    const beta = created.find((p) => p.name === 'Shared Beta');

    const assigned = await request(app)
      .put(`/api/admin/users/${user.id}/projects`)
      .set('Cookie', cookie)
      .send({ projectIds: [alpha.id, beta.id] })
      .expect(200);
    const rows = assigned.body.projects;
    expect(rows.find((p) => p.id === alpha.id)).toMatchObject({ assigned: true, owned: false });
    expect(rows.find((p) => p.id === beta.id)).toMatchObject({ assigned: true, owned: false });
    expect(rows.find((p) => p.name === 'Not Shared')).toMatchObject({ assigned: false, owned: false });

    const userSession = await userCookie(user);
    const list = await request(app).get('/api/projects').set('Cookie', userSession).expect(200);
    expect(list.body.projects.map((p) => p.name).sort()).toEqual(['Shared Alpha', 'Shared Beta']);
    await request(app).get(`/api/projects/${alpha.id}`).set('Cookie', userSession).expect(200);

    // Assignment grants use, not ownership: renaming or deleting is owner-only.
    await request(app)
      .patch(`/api/projects/${alpha.id}`)
      .set('Cookie', userSession)
      .send({ name: 'Renamed by assignee' })
      .expect(404);
    await request(app)
      .delete(`/api/projects/${alpha.id}?confirm=yes`)
      .set('Cookie', userSession)
      .expect(404);

    const revoked = await request(app)
      .delete(`/api/admin/users/${user.id}/projects/${alpha.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(revoked.body.projects.find((p) => p.id === alpha.id)).toMatchObject({ assigned: false });
    const after = await request(app).get('/api/projects').set('Cookie', userSession).expect(200);
    expect(after.body.projects.map((p) => p.name)).toEqual(['Shared Beta']);

    // The owner's access cannot be removed through an assignment row.
    await request(app)
      .delete(`/api/admin/users/${h.TEST_ADMIN_ID}/projects/${beta.id}`)
      .set('Cookie', cookie)
      .expect(409);
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
