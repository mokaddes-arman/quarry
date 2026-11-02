/* globals describe, it, expect, beforeAll, afterAll, beforeEach */
'use strict';

/**
 * Public chat widgets and administrator conversation review.
 *
 * These tests cover the whole flow: owner/admin widget configuration, logo and
 * key handling, visitor consent + identity, origin restrictions, external
 * conversations isolated from normal chat surfaces, and the three administrator
 * scopes (own chats, other users, widget visitors).
 */

const h = require('../helpers');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let alice;
let bob;
let aliceProject;
let adminProject;

function app() {
  return h.getApp();
}

async function createProjectAs(userId, name) {
  const res = await h.requestAs(userId).post('/api/projects').send({ name }).expect(201);
  return res.body.project;
}

function getEmbed(projectId, userId = null) {
  const req = userId ? h.requestAs(userId) : h.request(app());
  return req.get(`/api/projects/${projectId}/embed`);
}

function configureEmbed(projectId, patch = {}, userId = null) {
  const req = userId ? h.requestAs(userId) : h.request(app());
  return req.patch(`/api/projects/${projectId}/embed`).send(patch);
}

function visitorRegistration(embedKey, body, { origin, token } = {}) {
  let req = h.request(app()).post(`/api/public/embeds/${embedKey}/visitors`);
  if (origin) req = req.set('Origin', origin);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

function registerVisitor(embedKey, overrides = {}, options = {}) {
  return visitorRegistration(
    embedKey,
    {
      name: 'Website Visitor',
      email: `visitor-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      consent: true,
      ...overrides,
    },
    options,
  );
}

function openExternalConversation(embedKey, token) {
  return h
    .request(app())
    .post(`/api/public/embeds/${embedKey}/conversations`)
    .set('Authorization', `Bearer ${token}`);
}

async function createExternalConversation(embedKey) {
  const registered = await registerVisitor(embedKey).expect(201);
  const token = registered.body.token;
  const conversation = await openExternalConversation(embedKey, token).expect(201);
  return { token, visitor: registered.body.visitor, conversation: conversation.body.conversation };
}

beforeAll(async () => {
  await h.setupTestApp();
});

afterAll(async () => {
  await h.teardownTestApp();
});

beforeEach(async () => {
  await h.resetData();
  await h.query('DELETE FROM users WHERE id <> $1', [h.TEST_ADMIN_ID]);

  alice = await h.createTestUser({ email: 'alice@test.local', name: 'Alice' });
  bob = await h.createTestUser({ email: 'bob@test.local', name: 'Bob' });
  aliceProject = await createProjectAs(alice.id, 'Alice project');
  adminProject = await createProjectAs(h.TEST_ADMIN_ID, 'Admin project');
});

describe('widget configuration', () => {
  it('lets the project owner and administrators configure an embed', async () => {
    const created = await getEmbed(aliceProject.id).expect(200);
    expect(created.body.embed).toMatchObject({
      projectId: aliceProject.id,
      enabled: true,
      consentRequired: true,
    });
    expect(created.body.embed.publicKey).toBeTruthy();
    expect(created.body.embed.widgetUrl).toContain(`/embed/${created.body.embed.publicKey}`);
    expect(created.body.embed.scriptTag).toContain(`/embed.js?key=${created.body.embed.publicKey}`);

    const asOwner = await getEmbed(aliceProject.id, alice.id).expect(200);
    expect(asOwner.body.embed.publicKey).toBe(created.body.embed.publicKey);

    const asAdmin = await getEmbed(aliceProject.id, h.TEST_ADMIN_ID).expect(200);
    expect(asAdmin.body.embed.publicKey).toBe(created.body.embed.publicKey);

    // A stranger sees the project as non-existent.
    await getEmbed(aliceProject.id, bob.id).expect(404);
    await getEmbed(adminProject.id, alice.id).expect(404);
  });

  it('persists branding, consent text and normalised origins', async () => {
    const updated = await configureEmbed(
      aliceProject.id,
      {
        brandName: 'Acme Support',
        slogan: 'Answers from our docs',
        themeColor: '#112233',
        welcomeMessage: 'How can we help?',
        consentRequired: false,
        consentTitle: 'Privacy notice',
        consentBody: 'We store this chat for quality review.',
        consentUrl: 'https://acme.example/privacy',
        allowedOrigins: ['https://acme.example/some/path', 'https://acme.example', 'not a url'],
        logoUrl: 'https://acme.example/logo.png',
      },
      alice.id,
    ).expect(200);

    expect(updated.body.embed).toMatchObject({
      brandName: 'Acme Support',
      slogan: 'Answers from our docs',
      themeColor: '#112233',
      welcomeMessage: 'How can we help?',
      consentRequired: false,
      consentTitle: 'Privacy notice',
      consentBody: 'We store this chat for quality review.',
      consentUrl: 'https://acme.example/privacy',
      // Path variants collapse to one origin and invalid values are dropped.
      allowedOrigins: ['https://acme.example'],
      logoUrl: 'https://acme.example/logo.png',
    });

    const fetched = await getEmbed(aliceProject.id, alice.id).expect(200);
    expect(fetched.body.embed.brandName).toBe('Acme Support');
    expect(fetched.body.embed.allowedOrigins).toEqual(['https://acme.example']);

    const invalid = await configureEmbed(aliceProject.id, { themeColor: 'blue' }, alice.id);
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('validation_error');
  });

  it('rotates the public key and immediately invalidates the old one', async () => {
    const first = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const rotated = await h
      .request(app())
      .post(`/api/projects/${aliceProject.id}/embed/rotate-key`)
      .expect(200);
    const second = rotated.body.embed;

    expect(second.publicKey).not.toBe(first.publicKey);
    expect(second.scriptTag).toContain(`/embed.js?key=${second.publicKey}`);

    await h.request(app()).get(`/api/public/embeds/${first.publicKey}`).expect(404);
    await h.request(app()).get(`/api/public/embeds/${second.publicKey}`).expect(200);
  });

  it('uploads, serves and deletes an uploaded logo', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;

    const uploaded = await h
      .requestAs(alice.id)
      .post(`/api/projects/${aliceProject.id}/embed/logo`)
      .attach('logo', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    expect(uploaded.body.embed.hasLogo).toBe(true);
    expect(uploaded.body.embed.logoUrl).toBeNull();

    const { rows } = await h.query('SELECT logo_path FROM project_embeds WHERE id = $1', [embed.id]);
    expect(rows[0].logo_path).toMatch(new RegExp(`^external_logo/${aliceProject.id}/${embed.id}/v1__`));
    expect(rows[0].logo_path).toMatch(/logo\.png$/);

    const logo = await h.request(app()).get(`/api/public/embeds/${embed.publicKey}/logo`).expect(200);
    expect(logo.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(logo.body, PNG)).toBe(0);

    const removed = await h
      .requestAs(alice.id)
      .delete(`/api/projects/${aliceProject.id}/embed/logo`)
      .expect(200);
    expect(removed.body.embed.hasLogo).toBe(false);
    await h.request(app()).get(`/api/public/embeds/${embed.publicKey}/logo`).expect(404);
  });

  it('rejects non-image logo uploads', async () => {
    await getEmbed(aliceProject.id).expect(200);
    const res = await h
      .requestAs(alice.id)
      .post(`/api/projects/${aliceProject.id}/embed/logo`)
      .attach('logo', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('hides a disabled widget and its launcher data', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    await configureEmbed(aliceProject.id, { enabled: false }, alice.id).expect(200);

    await h.request(app()).get(`/api/public/embeds/${embed.publicKey}`).expect(404);
    const res = await registerVisitor(embed.publicKey);
    expect(res.status).toBe(404);
  });

  it('serves the floating launcher with framing allowed and rejects a missing key', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;

    const script = await h.request(app()).get(`/embed.js?key=${embed.publicKey}`).expect(200);
    expect(script.headers['content-type']).toContain('application/javascript');
    expect(script.headers['x-frame-options']).toBeUndefined();
    expect(script.headers['content-security-policy']).toContain('frame-ancestors *');
    expect(script.text).toContain(embed.publicKey);
    expect(script.text).toContain("base + '/embed/'");

    const missing = await h.request(app()).get('/embed.js').expect(400);
    expect(missing.headers['content-type']).toContain('application/javascript');
    expect(missing.text).toContain('Missing ?key=');
  });
});

describe('visitor identity and consent', () => {
  it('requires an explicit consent when the widget asks for one', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;

    const missingConsent = await registerVisitor(embed.publicKey, { consent: false });
    expect(missingConsent.status).toBe(422);
    expect(missingConsent.body.error.code).toBe('validation_error');

    const missingName = await registerVisitor(embed.publicKey, { name: ' ' });
    expect(missingName.status).toBe(422);

    const invalidEmail = await registerVisitor(embed.publicKey, { email: 'not-an-email' });
    expect(invalidEmail.status).toBe(422);
  });

  it('stores only a hash of the visitor token and accepts it on the session', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const email = 'Visitor@Example.com';
    const registered = await registerVisitor(embed.publicKey, { name: 'Jane Doe', email }).expect(201);

    expect(registered.body.token).toBeTruthy();
    expect(registered.body.visitor).toMatchObject({ name: 'Jane Doe', email });
    expect(registered.body.conversation).toBeNull();

    const { rows } = await h.query(
      'SELECT token_hash, email_normalised, consent_accepted_at FROM embed_visitors WHERE id = $1',
      [registered.body.visitor.id],
    );
    expect(rows[0].token_hash).not.toBe(registered.body.token);
    expect(rows[0].token_hash).toHaveLength(64);
    expect(rows[0].email_normalised).toBe('visitor@example.com');
    expect(rows[0].consent_accepted_at).not.toBeNull();

    await h.request(app()).get(`/api/public/embeds/${embed.publicKey}/session`).expect(401);
    await h
      .request(app())
      .get(`/api/public/embeds/${embed.publicKey}/session`)
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);

    const session = await h
      .request(app())
      .get(`/api/public/embeds/${embed.publicKey}/session`)
      .set('Authorization', `Bearer ${registered.body.token}`)
      .expect(200);
    expect(session.body.visitor).toMatchObject({ name: 'Jane Doe', email });
    expect(session.body.conversation).toBeNull();

    // The x-embed-token header is an accepted alternative.
    await h
      .request(app())
      .get(`/api/public/embeds/${embed.publicKey}/session`)
      .set('x-embed-token', registered.body.token)
      .expect(200);
  });

  it('allows registration without consent when the widget does not require it', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    await configureEmbed(aliceProject.id, { consentRequired: false }, alice.id).expect(200);

    const registered = await visitorRegistration(embed.publicKey, {
      name: 'No Consent',
      email: 'no-consent@example.com',
    }).expect(201);
    expect(registered.body.token).toBeTruthy();
  });
});

describe('external conversations', () => {
  it('creates one reusable visitor conversation and stores the visitor snapshot', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const registered = await registerVisitor(embed.publicKey, {
      name: 'Widget Person',
      email: 'widget@example.com',
    }).expect(201);
    const token = registered.body.token;

    const first = await openExternalConversation(embed.publicKey, token).expect(201);
    const second = await openExternalConversation(embed.publicKey, token).expect(201);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
    expect(first.body.conversation.channel).toBe('external');

    const { rows } = await h.query('SELECT * FROM conversations WHERE id = $1', [first.body.conversation.id]);
    expect(rows[0]).toMatchObject({
      channel: 'external',
      owner_user_id: null,
      visitor_name: 'Widget Person',
      visitor_email: 'widget@example.com',
      project_id: aliceProject.id,
    });
    expect(rows[0].consent_accepted_at).not.toBeNull();

    const empty = await h
      .request(app())
      .get(`/api/public/embeds/${embed.publicKey}/conversations/${first.body.conversation.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(empty.body.messages).toEqual([]);
  });

  it('runs the normal RAG flow and returns the transcript to the visitor', async () => {
    await h.addMockProvider();
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const { token, conversation } = await createExternalConversation(embed.publicKey);

    const answer = await h
      .request(app())
      .post(`/api/public/embeds/${embed.publicKey}/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'What does the documentation say?', stream: false })
      .expect(200);
    expect(answer.body.result).toBeTruthy();
    expect(answer.body.result.ok).toBe(true);

    const transcript = await h
      .request(app())
      .get(`/api/public/embeds/${embed.publicKey}/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(transcript.body.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(transcript.body.messages[0].content).toBe('What does the documentation say?');
  });

  it('scopes conversations to one visitor token and one embed key', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const first = await createExternalConversation(embed.publicKey);

    const secondVisitor = await registerVisitor(embed.publicKey).expect(201);
    await h
      .request(app())
      .get(`/api/public/embeds/${embed.publicKey}/conversations/${first.conversation.id}/messages`)
      .set('Authorization', `Bearer ${secondVisitor.body.token}`)
      .expect(404);
    await h
      .request(app())
      .post(`/api/public/embeds/${embed.publicKey}/conversations/${first.conversation.id}/messages`)
      .set('Authorization', `Bearer ${secondVisitor.body.token}`)
      .send({ question: 'Can I read this?', stream: false })
      .expect(404);

    // A visitor of another widget can never reach this conversation either.
    const otherEmbed = (await getEmbed(adminProject.id).expect(200)).body.embed;
    const otherVisitor = await registerVisitor(otherEmbed.publicKey).expect(201);
    await h
      .request(app())
      .get(`/api/public/embeds/${otherEmbed.publicKey}/conversations/${first.conversation.id}/messages`)
      .set('Authorization', `Bearer ${otherVisitor.body.token}`)
      .expect(404);
  });

  it('enforces the configured allowed origins', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    await configureEmbed(aliceProject.id, { allowedOrigins: ['https://allowed.example'] }, alice.id).expect(200);

    const blocked = await registerVisitor(embed.publicKey, {}, { origin: 'https://attacker.example' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('forbidden');
    expect(blocked.body.error.message).toMatch(/not allowed/i);

    const allowed = await registerVisitor(embed.publicKey, {}, { origin: 'https://allowed.example' });
    expect(allowed.status).toBe(201);

    // An empty allow-list means "any website" (the default for quick starts).
    await configureEmbed(aliceProject.id, { allowedOrigins: [] }, alice.id).expect(200);
    const anyOrigin = await registerVisitor(embed.publicKey, {}, { origin: 'https://anywhere.example' });
    expect(anyOrigin.status).toBe(201);
  });
});

describe('leakage into normal chat surfaces', () => {
  it('never shows widget conversations in project history, stats or workspace counts', async () => {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const external = await createExternalConversation(embed.publicKey);

    const aliceChat = await h
      .requestAs(alice.id)
      .post(`/api/projects/${aliceProject.id}/conversations`)
      .send({ title: 'Alice internal chat' })
      .expect(201);
    const adminChat = await h
      .request(app())
      .post(`/api/projects/${aliceProject.id}/conversations`)
      .send({ title: 'Admin internal chat' })
      .expect(201);

    const adminList = await h.request(app()).get(`/api/projects/${aliceProject.id}/conversations`).expect(200);
    const adminIds = adminList.body.conversations.map((row) => row.id);
    expect(adminIds).toEqual(expect.arrayContaining([aliceChat.body.conversation.id, adminChat.body.conversation.id]));
    expect(adminIds).not.toContain(external.conversation.id);

    const aliceList = await h
      .requestAs(alice.id)
      .get(`/api/projects/${aliceProject.id}/conversations`)
      .expect(200);
    expect(aliceList.body.conversations.map((row) => row.id)).toEqual([aliceChat.body.conversation.id]);

    const adminStats = await h.request(app()).get(`/api/projects/${aliceProject.id}/stats`).expect(200);
    expect(adminStats.body.stats.conversations.total_conversations).toBe(2);
    expect(adminStats.body.stats.recentConversations.map((row) => row.id)).not.toContain(external.conversation.id);

    const aliceStats = await h
      .requestAs(alice.id)
      .get(`/api/projects/${aliceProject.id}/stats`)
      .expect(200);
    expect(aliceStats.body.stats.conversations.total_conversations).toBe(1);

    const adminStatus = await h.request(app()).get('/api/system/status').expect(200);
    expect(adminStatus.body.counts.conversations).toBe(2);

    const aliceStatus = await h.requestAs(alice.id).get('/api/system/status').expect(200);
    expect(aliceStatus.body.counts.conversations).toBe(1);
  });
});

describe('administrator conversation review', () => {
  async function seedConversations() {
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const external = await createExternalConversation(embed.publicKey);

    const aliceChat = await h
      .requestAs(alice.id)
      .post(`/api/projects/${aliceProject.id}/conversations`)
      .send({ title: 'Alice billing question' })
      .expect(201);
    const adminChat = await h
      .request(app())
      .post(`/api/projects/${aliceProject.id}/conversations`)
      .send({ title: 'Admin private note' })
      .expect(201);

    return {
      external: external.conversation,
      aliceChat: aliceChat.body.conversation,
      adminChat: adminChat.body.conversation,
    };
  }

  it('separates own chats, other users and widget visitors', async () => {
    const seeded = await seedConversations();

    const mine = await h.request(app()).get('/api/admin/conversations?scope=mine').expect(200);
    expect(mine.body.conversations.map((row) => row.id)).toEqual([seeded.adminChat.id]);
    expect(mine.body.counts).toMatchObject({ mine: 1, users: 1, external: 1, all: 3 });

    const users = await h.request(app()).get('/api/admin/conversations?scope=users').expect(200);
    expect(users.body.conversations.map((row) => row.id)).toEqual([seeded.aliceChat.id]);
    expect(users.body.conversations[0].owner_email).toBe('alice@test.local');

    const external = await h.request(app()).get('/api/admin/conversations?scope=external').expect(200);
    expect(external.body.conversations.map((row) => row.id)).toEqual([seeded.external.id]);
    expect(external.body.conversations[0]).toMatchObject({
      channel: 'external',
      visitor_email: expect.stringContaining('@example.com'),
    });

    const all = await h.request(app()).get('/api/admin/conversations?scope=all').expect(200);
    expect(all.body.conversations.map((row) => row.id).sort()).toEqual(
      [seeded.adminChat.id, seeded.aliceChat.id, seeded.external.id].sort(),
    );

    const invalid = await h.request(app()).get('/api/admin/conversations?scope=everything');
    expect(invalid.status).toBe(422);
  });

  it('filters by project, user and search text', async () => {
    const seeded = await seedConversations();

    const byProject = await h
      .request(app())
      .get(`/api/admin/conversations?scope=all&projectId=${aliceProject.id}`)
      .expect(200);
    expect(byProject.body.conversations).toHaveLength(3);

    const emptyProject = await h
      .request(app())
      .get(`/api/admin/conversations?scope=all&projectId=${adminProject.id}`)
      .expect(200);
    expect(emptyProject.body.conversations).toEqual([]);

    const byUser = await h
      .request(app())
      .get(`/api/admin/conversations?scope=all&userId=${alice.id}`)
      .expect(200);
    expect(byUser.body.conversations.map((row) => row.id)).toEqual([seeded.aliceChat.id]);

    const byVisitorEmail = await h
      .request(app())
      .get(
        `/api/admin/conversations?scope=external&search=${encodeURIComponent(
          seeded.external.visitor_email || 'visitor-',
        )}`,
      )
      .expect(200);
    expect(byVisitorEmail.body.conversations.map((row) => row.id)).toEqual([seeded.external.id]);

    const byUserEmail = await h
      .request(app())
      .get(`/api/admin/conversations?scope=all&search=${encodeURIComponent('alice@test.local')}`)
      .expect(200);
    expect(byUserEmail.body.conversations.map((row) => row.id)).toEqual([seeded.aliceChat.id]);

    const byTitle = await h
      .request(app())
      .get(`/api/admin/conversations?scope=all&search=${encodeURIComponent('billing')}`)
      .expect(200);
    expect(byTitle.body.conversations.map((row) => row.id)).toEqual([seeded.aliceChat.id]);
  });

  it('returns full transcripts with visitor identity and deletes conversations', async () => {
    await h.addMockProvider();
    const embed = (await getEmbed(aliceProject.id).expect(200)).body.embed;
    const { token, conversation } = await createExternalConversation(embed.publicKey);

    await h
      .request(app())
      .post(`/api/public/embeds/${embed.publicKey}/conversations/${conversation.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'Where is the privacy policy?', stream: false })
      .expect(200);

    const detail = await h.request(app()).get(`/api/admin/conversations/${conversation.id}`).expect(200);
    expect(detail.body.conversation).toMatchObject({
      id: conversation.id,
      channel: 'external',
      project_name: 'Alice project',
      visitor_name: 'Website Visitor',
    });
    expect(detail.body.conversation.consent_accepted_at).toBeTruthy();
    expect(detail.body.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail.body.sources).toEqual(expect.any(Array));

    await h.request(app()).delete(`/api/admin/conversations/${conversation.id}`).expect(200);
    await h.request(app()).get(`/api/admin/conversations/${conversation.id}`).expect(404);
    const remaining = await h.query('SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id = $1', [
      conversation.id,
    ]);
    expect(remaining.rows[0].count).toBe(0);
  });

  it('blocks normal users from the admin conversation surface', async () => {
    await h.requestAs(alice.id).get('/api/admin/conversations').expect(403);
    await h.requestAs(alice.id).get('/api/admin/conversations?scope=mine').expect(403);
  });
});
