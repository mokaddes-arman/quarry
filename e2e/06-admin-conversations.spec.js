'use strict';

/**
 * Administrator conversation review.
 *
 * The spec seeds three kinds of conversation through the real API:
 *   - one owned by the administrator,
 *   - one owned by an invited workspace user,
 *   - one started by an anonymous widget visitor.
 * It then checks that the review window keeps the scopes separate, filters by
 * project/user/search, shows visitor identity, deletes a conversation, and that
 * widget chats never leak into the normal chat sidebar.
 */

const { test, expect } = require('@playwright/test');
const {
  api,
  apiAs,
  createProject,
  createConversation,
  createUserWithSession,
  getEmbed,
  registerPublicVisitor,
  createExternalConversation,
  publicApi,
} = require('./helpers');

test('conversation review separates own, other-user and widget chats', async ({ page }) => {
  test.setTimeout(180_000);

  const marker = Date.now();
  const project = await createProject(`Review project ${marker}`);

  const adminTitle = `Admin chat ${marker}`;
  await createConversation(project.id, adminTitle);

  const other = await createUserWithSession({
    email: `other-${marker}@example.test`,
    name: `Other Reviewer ${marker}`,
  });
  const assignment = await api(`/api/admin/users/${other.user.id}/projects`, {
    method: 'PUT',
    body: { projectIds: [project.id] },
  });
  expect(assignment.ok).toBe(true);

  const otherTitle = `Other user chat ${marker}`;
  const otherChat = await apiAs(other.cookie, `/api/projects/${project.id}/conversations`, {
    method: 'POST',
    body: { title: otherTitle },
  });
  expect(otherChat.ok).toBe(true);

  const embed = await getEmbed(project.id);
  const visitorName = `Widget Visitor ${marker}`;
  const visitorEmail = `visitor-${marker}@example.test`;
  const registered = await registerPublicVisitor(embed.publicKey, {
    name: visitorName,
    email: visitorEmail,
  });
  const external = await createExternalConversation(embed.publicKey, registered.token);
  const visitorQuestion = `Visitor question ${marker}`;
  const visitorAnswer = await publicApi(
    `/api/public/embeds/${embed.publicKey}/conversations/${external.id}/messages`,
    { method: 'POST', token: registered.token, body: { question: visitorQuestion, stream: false } },
  );
  expect(visitorAnswer.ok).toBe(true);

  // --- the review window is a real, bookmarkable URL ------------------------
  await page.goto('/admin/conversations');
  await expect(page).toHaveURL(/\/admin\/conversations/);
  await expect(page.getByRole('heading', { name: 'Conversation review' })).toBeVisible();

  // --- My chats -------------------------------------------------------------
  await page.getByRole('button', { name: /My chats/ }).click();
  await expect(page.getByText(adminTitle)).toBeVisible();
  await expect(page.getByText(otherTitle)).toHaveCount(0);
  await expect(page.getByText(visitorQuestion)).toHaveCount(0);

  // --- Other users ----------------------------------------------------------
  await page.getByRole('button', { name: /Other users/ }).click();
  await expect(page.getByText(otherTitle)).toBeVisible();
  await expect(page.getByRole('list').getByText(`Other Reviewer ${marker}`)).toBeVisible();
  await expect(page.getByText(adminTitle)).toHaveCount(0);

  // --- Widget visitors ------------------------------------------------------
  await page.getByRole('button', { name: /Widget visitors/ }).click();
  await expect(page.getByText(visitorQuestion)).toBeVisible();
  await expect(page.getByText(visitorName)).toBeVisible();
  await expect(page.getByText(adminTitle)).toHaveCount(0);

  // --- filters --------------------------------------------------------------
  await page.getByRole('button', { name: /^All/ }).click();
  await expect(page.getByText(adminTitle)).toBeVisible();
  await expect(page.getByText(otherTitle)).toBeVisible();
  await expect(page.getByText(visitorQuestion)).toBeVisible();

  await page.getByLabel('Filter by project').selectOption({ label: project.name });
  await expect(page.getByText(visitorQuestion)).toBeVisible();

  await page.getByLabel('Filter by user').selectOption({ label: `Other Reviewer ${marker}` });
  await expect(page.getByText(otherTitle)).toBeVisible();
  await expect(page.getByText(adminTitle)).toHaveCount(0);
  await expect(page.getByText(visitorQuestion)).toHaveCount(0);

  await page.getByLabel('Filter by user').selectOption({ label: 'All users' });
  await page.getByPlaceholder('Search title, name or email').fill(visitorEmail);
  await expect(page.getByText(visitorQuestion)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(otherTitle)).toHaveCount(0);

  // --- detail shows the transcript and the visitor identity -----------------
  await page.getByRole('button', { name: new RegExp(visitorQuestion) }).first().click();
  await expect(page.getByText(visitorEmail)).toBeVisible();
  await expect(page.getByText(visitorName).first()).toBeVisible();
  await expect(page.getByText('Consent accepted')).toBeVisible();
  await expect(page.getByText(visitorQuestion).first()).toBeVisible();
  await expect(page.getByText(/Review only/)).toBeVisible();

  // --- widget chats are absent from the normal sidebar ----------------------
  await page.goto(`/chats?project=${project.id}`);
  const sidebar = page.locator('aside');
  await expect(sidebar).toContainText(adminTitle);
  await expect(sidebar).not.toContainText(visitorQuestion);
  await expect(sidebar).not.toContainText(otherTitle);

  // --- delete the widget conversation --------------------------------------
  await page.goto('/admin/conversations');
  await page.getByRole('button', { name: /Widget visitors/ }).click();
  await page.getByRole('button', { name: new RegExp(visitorQuestion) }).first().click();
  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete conversation' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(visitorQuestion)).toHaveCount(0);

  const remaining = await api('/api/admin/conversations?scope=external');
  expect(remaining.ok).toBe(true);
  expect(remaining.data.conversations).toEqual([]);
});

test('every page has its own stable URL', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();

  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page).toHaveURL(/\/chats/);

  await page.getByRole('button', { name: 'Documents' }).click();
  await expect(page).toHaveURL(/\/documents/);
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();

  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/search/);
  await expect(page.getByRole('heading', { name: /^Search/ })).toBeVisible();

  await page.getByRole('button', { name: /^Admin/ }).click();
  await expect(page).toHaveURL(/\/admin(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();

  // A reload keeps the same page instead of falling back to the chat.
  await page.reload();
  await expect(page).toHaveURL(/\/admin(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();

  await page.goto('/admin/conversations');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Conversation review' })).toBeVisible();
});
