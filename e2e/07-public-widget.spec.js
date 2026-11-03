'use strict';

/**
 * Public widget flow.
 *
 * A visitor with no account opens the widget URL in a clean browser context,
 * accepts the consent notice, provides name + email, chats through the normal
 * RAG pipeline, and keeps the transcript across a reload. The administrator
 * then finds that conversation in the review window.
 */

const { test, expect } = require('@playwright/test');
const {
  api,
  createProject,
  uploadAndIndex,
  getEmbed,
  updateEmbed,
  SAMPLE_DOCUMENT,
  SAMPLE_QUESTION,
  API_BASE,
} = require('./helpers');

const GROUNDED_ANSWER = /\[mock\] I found \d+ evidence block/;

test('a visitor can consent, identify themselves and chat without an account', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);

  const marker = Date.now();
  const project = await createProject(`Widget project ${marker}`);
  await uploadAndIndex(project.id, 'widget-docs.md', SAMPLE_DOCUMENT);

  const brandName = `Acme Help ${marker}`;
  const slogan = `Answers from the docs ${marker}`;
  const consentTitle = `Privacy notice ${marker}`;
  const consentBody = `Conversations are stored for quality review ${marker}.`;
  const welcomeMessage = `Ask us anything ${marker}.`;
  const visitorName = `Visitor ${marker}`;
  const visitorEmail = `visitor-${marker}@example.test`;

  const embed = await getEmbed(project.id);
  await updateEmbed(project.id, {
    brandName,
    slogan,
    consentTitle,
    consentBody,
    welcomeMessage,
    consentRequired: true,
    allowedOrigins: [],
  });

  // The launcher script is served from the root and contains this key.
  const launcher = await page.request.get(`/embed.js?key=${embed.publicKey}`);
  expect(launcher.status()).toBe(200);
  expect(await launcher.text()).toContain(embed.publicKey);

  // --- a clean browser with no workspace session ---------------------------
  const visitor = await browser.newContext({
    baseURL: API_BASE(),
    storageState: { cookies: [], origins: [] },
  });

  try {
    const widget = await visitor.newPage();
    await widget.goto(`/embed/${embed.publicKey}`);

    await expect(widget.getByText(brandName)).toBeVisible();
    await expect(widget.getByText(slogan)).toBeVisible();
    await expect(widget.getByRole('heading', { name: consentTitle })).toBeVisible();
    await expect(widget.getByText(consentBody)).toBeVisible();

    await widget.getByLabel('Your name').fill(visitorName);
    await widget.getByLabel('Email address').fill(visitorEmail);
    await widget.getByRole('checkbox').check();
    await widget.getByRole('button', { name: 'Start chat' }).click();

    // --- the consent form is replaced by the chat -------------------------
    await expect(widget.getByText('Online')).toBeVisible();
    await expect(widget.getByText(visitorName)).toBeVisible();
    await expect(widget.getByText(welcomeMessage)).toBeVisible();

    const composer = widget.getByPlaceholder('Ask a question…');
    await composer.fill(SAMPLE_QUESTION);
    await widget.getByRole('button', { name: 'Send question' }).click();

    await expect(widget.getByText(GROUNDED_ANSWER).first()).toBeVisible({ timeout: 120_000 });
    await expect(widget.getByText(/\d+ source/).first()).toBeVisible();

    // --- the visitor token survives a reload ------------------------------
    await widget.reload();
    await expect(widget.getByText('Online')).toBeVisible();
    await expect(widget.getByText(visitorName)).toBeVisible();
    await expect(widget.getByText(SAMPLE_QUESTION).first()).toBeVisible();
    await expect(widget.getByText(GROUNDED_ANSWER).first()).toBeVisible();
    await expect(widget.getByRole('button', { name: 'Start chat' })).toHaveCount(0);

    // --- the administrator can review the visitor conversation ------------
    await page.goto('/admin/conversations');
    await page.getByRole('button', { name: /Widget visitors/ }).click();
    await expect(page.getByText(visitorName)).toBeVisible();
    await page.getByRole('button', { name: new RegExp(visitorName) }).first().click();
    await expect(page.getByText(visitorEmail)).toBeVisible();
    await expect(page.getByText(SAMPLE_QUESTION).first()).toBeVisible();
    await expect(page.getByText(GROUNDED_ANSWER).first()).toBeVisible();
    await expect(page.getByText('Consent accepted')).toBeVisible();

    const search = await api(
      `/api/admin/conversations?scope=external&search=${encodeURIComponent(visitorEmail)}`,
    );
    expect(search.ok).toBe(true);
    expect(search.data.conversations).toHaveLength(1);
    expect(search.data.conversations[0]).toMatchObject({
      channel: 'external',
      visitor_name: visitorName,
      visitor_email: visitorEmail,
    });
  } finally {
    await visitor.close();
  }
});
