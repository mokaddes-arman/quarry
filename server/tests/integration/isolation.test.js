'use strict';

/**
 * Per-user data isolation.
 *
 * Two normal users each own one project; the seeded administrator sees both.
 * Foreign resources must look like they do not exist (404), never 403, and
 * cross-project retrieval must only ever search the caller's own projects.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as h from '../helpers.js';

let alice;
let bob;
let aliceProject;
let bobProject;

beforeAll(async () => {
  await h.setupTestApp();
});

afterAll(async () => {
  await h.teardownTestApp();
});

async function createProjectAs(userId, name) {
  const res = await h.requestAs(userId).post('/api/projects').send({ name }).expect(201);
  return res.body.project;
}

beforeEach(async () => {
  await h.resetData();
  await h.query('DELETE FROM users WHERE id <> $1', [h.TEST_ADMIN_ID]);

  alice = await h.createTestUser({ email: 'alice@test.local', name: 'Alice' });
  bob = await h.createTestUser({ email: 'bob@test.local', name: 'Bob' });

  aliceProject = await createProjectAs(alice.id, 'Alice project');
  bobProject = await createProjectAs(bob.id, 'Bob project');
});

describe('project isolation', () => {
  it('lists only the caller projects, while administrators see all', async () => {
    const mine = await h.requestAs(alice.id).get('/api/projects').expect(200);
    expect(mine.body.projects.map((p) => p.id)).toEqual([aliceProject.id]);

    const theirs = await h.requestAs(bob.id).get('/api/projects').expect(200);
    expect(theirs.body.projects.map((p) => p.id)).toEqual([bobProject.id]);

    const all = await h.request(h.getApp()).get('/api/projects').expect(200);
    expect(all.body.projects.map((p) => p.id).sort()).toEqual([aliceProject.id, bobProject.id].sort());
  });

  it('hides a foreign project behind a 404 on every verb', async () => {
    await h.requestAs(alice.id).get(`/api/projects/${bobProject.id}`).expect(404);
    await h.requestAs(alice.id).patch(`/api/projects/${bobProject.id}`).send({ name: 'stolen' }).expect(404);
    await h.requestAs(alice.id).delete(`/api/projects/${bobProject.id}`).expect(404);

    // The project still belongs to Bob and kept its name.
    const check = await h.requestAs(bob.id).get(`/api/projects/${bobProject.id}`).expect(200);
    expect(check.body.project.name).toBe('Bob project');
  });

  it('returns 404 for nested collections of a foreign project', async () => {
    await h.requestAs(alice.id).get(`/api/projects/${bobProject.id}/documents`).expect(404);
    await h.requestAs(alice.id).get(`/api/projects/${bobProject.id}/conversations`).expect(404);
    await h.requestAs(alice.id).get(`/api/projects/${bobProject.id}/collections`).expect(404);
    await h.requestAs(alice.id).get(`/api/projects/${bobProject.id}/stats`).expect(404);
    await h.requestAs(alice.id).post(`/api/projects/${bobProject.id}/links`).send({ urls: ['https://example.com'] }).expect(404);
  });

  it('scopes system status counts to the caller projects', async () => {
    const mine = await h.requestAs(alice.id).get('/api/system/status').expect(200);
    expect(mine.body.counts.projects).toBe(1);

    const admin = await h.request(h.getApp()).get('/api/system/status').expect(200);
    expect(admin.body.counts.projects).toBe(2);
  });
});

describe('resource isolation', () => {
  it('hides a foreign document', async () => {
    const documentId = await h.uploadAndIndex(bobProject.id, 'bob.md', '# Secret\n\nBob only.');

    await h.requestAs(alice.id).get(`/api/documents/${documentId}`).expect(404);
    await h.requestAs(alice.id).delete(`/api/documents/${documentId}`).expect(404);
    await h.requestAs(alice.id).get(`/api/documents/${documentId}/markdown`).expect(404);
    await h.requestAs(alice.id).get(`/api/documents/${documentId}/markdown/download`).expect(404);

    // Bob can still see it.
    await h.requestAs(bob.id).get(`/api/documents/${documentId}`).expect(200);
  });

  it('refuses to re-index a document with a version that belongs to another document', async () => {
    const bobDocumentId = await h.uploadAndIndex(bobProject.id, 'bob-version.md', '# Bob\n\nPrivate.');
    const aliceDocumentId = await h.uploadAndIndex(aliceProject.id, 'alice-version.md', '# Alice');

    const bobDocument = await h.requestAs(bob.id).get(`/api/documents/${bobDocumentId}`).expect(200);
    const bobVersionId = bobDocument.body.document.versions[0].id;

    // Alice owns the document she targets, but the version id is Bob's.
    await h.requestAs(alice.id)
      .post(`/api/documents/${aliceDocumentId}/reindex`)
      .send({ versionId: bobVersionId })
      .expect(404);

    const bobVersion = await h.query('SELECT status FROM document_versions WHERE id = $1', [bobVersionId]);
    expect(bobVersion.rows[0].status).toBe('indexed');

    const aliceDocument = await h.requestAs(alice.id).get(`/api/documents/${aliceDocumentId}`).expect(200);
    expect(aliceDocument.body.document.status).toBe('indexed');
  });

  it('hides a foreign conversation and its messages', async () => {
    const created = await h.requestAs(bob.id)
      .post(`/api/projects/${bobProject.id}/conversations`)
      .send({ title: 'Bob chat' })
      .expect(201);
    const conversationId = created.body.conversation.id;

    await h.requestAs(alice.id).get(`/api/conversations/${conversationId}`).expect(404);
    await h.requestAs(alice.id).get(`/api/conversations/${conversationId}/messages`).expect(404);
    await h.requestAs(alice.id)
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ question: 'hi', stream: false })
      .expect(404);
    await h.requestAs(alice.id).patch(`/api/conversations/${conversationId}`).send({ title: 'x' }).expect(404);
    await h.requestAs(alice.id).delete(`/api/conversations/${conversationId}`).expect(404);
  });

  it('hides foreign collections and link lists', async () => {
    const collection = await h.requestAs(bob.id)
      .post(`/api/projects/${bobProject.id}/collections`)
      .send({ name: 'Bob collection' })
      .expect(201);
    const collectionId = collection.body.collection.id;

    await h.requestAs(alice.id).get(`/api/collections/${collectionId}`).expect(404);
    await h.requestAs(alice.id).patch(`/api/collections/${collectionId}`).send({ name: 'x' }).expect(404);
    await h.requestAs(alice.id).delete(`/api/collections/${collectionId}`).expect(404);
    await h.requestAs(alice.id).get(`/api/collections/${collectionId}`).expect(404);

    const list = await h.requestAs(bob.id)
      .post(`/api/projects/${bobProject.id}/link-lists`)
      .send({ name: 'Bob list' })
      .expect(201);
    const listId = list.body.linkList?.id || list.body.list?.id;
    expect(listId).toBeTruthy();

    await h.requestAs(alice.id).get(`/api/link-lists/${listId}`).expect(404);
    await h.requestAs(alice.id).delete(`/api/link-lists/${listId}`).expect(404);
  });

  it('only retrieves evidence from projects the caller owns', async () => {
    const aliceDocId = await h.uploadAndIndex(
      aliceProject.id,
      'alice.md',
      '# Alice notes\n\nThe internal codename is ZZALICE123 for the launch checklist.',
    );
    const bobDocId = await h.uploadAndIndex(
      bobProject.id,
      'bob.md',
      '# Bob notes\n\nThe internal codename is ZZBOB456 for the launch checklist.',
    );

    const conversation = await h.requestAs(alice.id)
      .post(`/api/projects/${aliceProject.id}/conversations`)
      .send({ title: 'Alice chat' })
      .expect(201);
    const conversationId = conversation.body.conversation.id;

    // Explicitly ask for Bob's project: it must be filtered out silently.
    const forced = await h.requestAs(alice.id)
      .post(`/api/conversations/${conversationId}/evidence`)
      .send({
        question: 'What is the internal codename for the launch checklist?',
        crossProject: true,
        projectIds: [bobProject.id],
        retrieval: { minScore: -1 },
      })
      .expect(200);
    expect(forced.body.sources.some((s) => s.documentId === bobDocId)).toBe(false);

    // With no explicit list, only Alice's own projects are searched.
    const natural = await h.requestAs(alice.id)
      .post(`/api/conversations/${conversationId}/evidence`)
      .send({
        question: 'What is the internal codename for the launch checklist?',
        crossProject: true,
        retrieval: { minScore: -1 },
      })
      .expect(200);
    expect(natural.body.sources.some((s) => s.documentId === bobDocId)).toBe(false);
    expect(natural.body.sources.some((s) => s.documentId === aliceDocId)).toBe(true);
  });
});

describe('administrator-only surfaces', () => {
  it('blocks normal users from user management and global settings', async () => {
    await h.requestAs(alice.id).get('/api/admin/users').expect(403);
    await h.requestAs(alice.id).post('/api/admin/users').send({ email: 'x@test.local' }).expect(403);
    await h.requestAs(alice.id).get('/api/settings').expect(403);
    await h.requestAs(alice.id).get('/api/model-usage').expect(403);
    await h.requestAs(alice.id).get('/api/settings/embedding-index').expect(403);

    // Theme is a personal preference and stays writable.
    await h.requestAs(alice.id).put('/api/settings/ui_theme').send({ value: 'dark' }).expect(200);
    await h.requestAs(alice.id).put('/api/settings/default_retrieval').send({ value: {} }).expect(403);
  });

  it('lets everyone read the model list but only safe fields', async () => {
    await h.addMockProvider({ name: 'Shared mock' });

    const asUser = await h.requestAs(alice.id).get('/api/providers/llm').expect(200);
    const config = asUser.body.configs[0];
    expect(config).toMatchObject({ name: 'Shared mock', provider: 'mock' });
    expect(config.keyMasked).toBeUndefined();
    expect(config.base_url).toBeUndefined();
    expect(config.extra).toBeUndefined();

    // Only administrators may change provider configuration.
    await h.requestAs(alice.id).post('/api/providers/llm').send({ name: 'x', provider: 'mock', model: 'm' }).expect(403);

    const asAdmin = await h.request(h.getApp()).get('/api/providers/llm').expect(200);
    expect(asAdmin.body.configs[0]).toHaveProperty('keyMasked');
  });
});
