'use strict';

/**
 * Transactional email for account invitations and sign-in links.
 *
 * SMTP is optional. When it is not configured, nothing fails: the caller gets
 * `{ sent: false, reason: 'not_configured' }`, the link is logged (server
 * console) and the admin UI still shows a copyable link. That keeps the app
 * usable on a laptop with no mail server while allowing a real deployment to
 * send links to users.
 */
const nodemailer = require('nodemailer');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');

let transport = null;
let transportKey = '';

function isConfigured() {
  return Boolean(config.mail.host);
}

function getTransport() {
  if (!isConfigured()) return null;
  // Re-create only when the configuration actually changed (tests mutate env).
  const key = [config.mail.host, config.mail.port, config.mail.secure, config.mail.user, config.mail.pass].join('|');
  if (transport && transportKey === key) return transport;
  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    // A stuck SMTP server must never hold a request open indefinitely.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  transportKey = key;
  return transport;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function describe() {
  return { configured: isConfigured(), from: isConfigured() ? config.mail.from : null };
}

/**
 * Send a sign-in / invitation link.
 * Never throws for a delivery problem: the caller decides how to surface it.
 */
async function sendLoginLink({ to, name, url, expiresAt, purpose = 'login' }) {
  const expires = new Date(expiresAt);
  const minutes = Math.max(1, Math.round((expires.getTime() - Date.now()) / 60000));
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const intro =
    purpose === 'invite'
      ? 'An account has been created for you on Quarry.'
      : 'Here is your sign-in link for Quarry.';

  const subject =
    purpose === 'invite'
      ? 'Your Quarry account is ready'
      : 'Your Quarry sign-in link';

  const text = [
    greeting,
    '',
    intro,
    '',
    `Sign in: ${url}`,
    '',
    `This link can be used once and expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    'If you did not expect this email you can ignore it.',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F5F3ED;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#172A3A">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E0DCD2;border-radius:12px;padding:28px">
    <p style="margin:0 0 16px;font-size:16px">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.5">${escapeHtml(intro)}</p>
    <p style="margin:0 0 24px">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#172A3A;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Sign in</a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#56657A;line-height:1.5">
      This link can be used once and expires in ${minutes} minute${minutes === 1 ? '' : 's'}.
    </p>
    <p style="margin:0;font-size:12px;color:#718096;line-height:1.5">
      If the button does not work, paste this address into your browser:<br>
      <span style="word-break:break-all">${escapeHtml(url)}</span>
    </p>
  </div>
</body></html>`;

  if (!isConfigured()) {
    logger.warn({ to, purpose }, 'SMTP is not configured; login link was not emailed');
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const info = await getTransport().sendMail({
      from: config.mail.from,
      to,
      replyTo: config.mail.replyTo || undefined,
      subject,
      text,
      html,
    });
    logger.info({ to, purpose, messageId: info.messageId }, 'login link emailed');
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err: err.message, to, purpose }, 'could not send login link email');
    return { sent: false, reason: 'send_failed', message: err.message };
  }
}

module.exports = { describe, isConfigured, sendLoginLink };
