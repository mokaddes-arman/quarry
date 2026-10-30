'use strict';

/**
 * Administrator flow: invite a normal user from the admin dashboard, open the
 * one-time sign-in link in a clean browser context, and confirm the new account
 * gets an isolated, project-less workspace.
 *
 * SMTP is not configured for the e2e backend, so the link is shown once in the
 * admin UI (the same fallback a real deployment gets without a mail server).
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || 3101}`;

test('admin invites a user who signs in with a one-time link and sees only their own data', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);

  const email = `invitee-${Date.now()}@example.test`;
  const projectName = `Invitee project ${Date.now()}`;

  await page.goto('/');

  // --- open the admin dashboard --------------------------------------------
  await page.locator('aside').getByRole('button', { name: /^Admin/ }).click();
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
  await expect(page.getByText('Email delivery is not configured')).toBeVisible();

  // --- invite a normal user --------------------------------------------------
  await page.getByRole('button', { name: 'Invite user' }).click();
  const inviteDialog = page.getByRole('dialog');
  await expect(inviteDialog.getByRole('heading', { name: 'Invite a user' })).toBeVisible();
  await inviteDialog.getByPlaceholder('colleague@company.com').fill(email);
  await inviteDialog.getByPlaceholder('Jane Doe').fill('Invited User');
  await inviteDialog.getByRole('combobox').selectOption('user');
  await inviteDialog.getByRole('button', { name: 'Create account & send link' }).click();

  // --- the fallback link is shown exactly once ------------------------------
  const resultDialog = page.getByRole('dialog');
  await expect(resultDialog.getByRole('heading', { name: 'Account created' })).toBeVisible();
  await expect(resultDialog.getByText('Email is not configured or sending failed')).toBeVisible();
  const linkText = await resultDialog.getByText(/\/login#token=/).innerText();
  expect(linkText).toMatch(/\/login#token=[A-Za-z0-9_-]{20,}/);
  await resultDialog.getByRole('button', { name: 'Done' }).click();

  // --- the invitee signs in from a fresh browser ---------------------------
  // Playwright's browser fixture inherits the admin storage state, so this
  // context explicitly starts with no cookies at all and must use the real link.
  const invitee = await browser.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
  const password = 'invitee-password-123';
  try {
    const inviteePage = await invitee.newPage();
    await inviteePage.goto(linkText.trim());

    // An invitation link asks the new user to choose a password before it is
    // exchanged for a session. They may skip, but setting one enables password
    // sign-in later.
    await expect(inviteePage.getByRole('heading', { name: 'Set a password' })).toBeVisible();
    await inviteePage.getByLabel('New password').fill(password);
    await inviteePage.getByLabel('Confirm password').fill(password);
    await inviteePage.getByRole('button', { name: 'Set password & sign in' }).click();

    // First-run for this account: no projects yet, no admin navigation.
    await expect(inviteePage.getByText('Welcome to Global Softel RAG Chat')).toBeVisible();
    await expect(inviteePage.locator('aside').getByRole('button', { name: /^Admin/ })).toHaveCount(0);
    await expect(inviteePage.locator('aside').getByRole('button', { name: 'Settings' })).toHaveCount(0);
    await expect(inviteePage.locator('aside').getByRole('button', { name: 'Model usage' })).toHaveCount(0);
    await expect(inviteePage.locator('aside').getByText(email)).toBeVisible();

    // The new account sees an empty project list even though earlier specs
    // created projects for the administrator.
    const projects = await inviteePage.request.get('/api/projects');
    expect(projects.status()).toBe(200);
    expect((await projects.json()).projects).toEqual([]);

    // It can create and use its own project.
    await inviteePage.getByRole('main').getByRole('button', { name: 'Create your first project' }).click();
    const createDialog = inviteePage.getByRole('dialog');
    await createDialog.getByPlaceholder('e.g. Platform API Specification').fill(projectName);
    await createDialog.getByRole('button', { name: 'Create project' }).click();
    await expect(createDialog).toBeHidden();
    await expect(inviteePage.getByRole('main').locator('header').first()).toContainText(projectName);

    const ownProjects = await inviteePage.request.get('/api/projects');
    const list = (await ownProjects.json()).projects;
    expect(list.map((p) => p.name)).toEqual([projectName]);

    // --- the link is single use, but the chosen password works --------------
    await inviteePage.locator('aside').getByRole('button', { name: 'Sign out' }).click();
    await expect(inviteePage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await inviteePage.getByLabel('Email address').fill(email);
    await inviteePage.getByLabel('Password').fill(password);
    await inviteePage.getByRole('button', { name: 'Sign in' }).click();
    // The account now has a project, so the landing view is the chat rather
    // than the welcome screen; the sidebar identifies the signed-in user.
    await expect(inviteePage.locator('aside').getByText(email)).toBeVisible();
    await expect(inviteePage.getByRole('heading', { name: 'Sign in' })).toHaveCount(0);

    // A fresh browser opening the same URL gets the error instead of a session.
    const late = await browser.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const latePage = await late.newPage();
      await latePage.goto(linkText.trim());
      await expect(latePage.getByText(/already been used|invalid or/i)).toBeVisible();
    } finally {
      await late.close();
    }
  } finally {
    await invitee.close();
  }
});
