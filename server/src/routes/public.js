'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateUuidParam } = require('../middleware/validate');
const { rateLimit } = require('../middleware/auth');
const { AppError, Codes } = require('../lib/errors');
const { config } = require('../config/env');
const embeds = require('../services/embed');
const conversations = require('../services/conversations');

/**
 * Public widget surface.
 *
 * Mounted before authenticate/csrfGuard in app.js because a visitor on another
 * website has no session and legitimately sends cross-origin requests. Access
 * is limited to the single project behind the embed key and to the visitor token
 * issued at registration.
 */
const router = express.Router();

function baseUrl(req) {
  return (config.appPublicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function sameOrigin(req, origin) {
  if (!origin) return true;
  try {
    const now = new URL(`${req.protocol}://${req.get('host')}`);
    const there = new URL(origin);
    return now.host === there.host && now.protocol === there.protocol;
  } catch {
    return false;
  }
}

function assertOrigin(req, embed) {
  const origin = req.get('origin');
  if (!origin) return;
  if (sameOrigin(req, origin) || embeds.originAllowed(embed, origin)) return;
  throw new AppError('This website is not allowed to use the widget.', {
    code: 'forbidden',
    status: 403,
  });
}

function tokenFrom(req) {
  const auth = String(req.get('authorization') || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.get('x-embed-token') || null;
}

async function requireVisitor(req) {
  const embed = req.embed;
  const visitor = await embeds.verifyVisitor(embed.id, tokenFrom(req));
  if (!visitor) {
    throw new AppError('Please complete the visitor form again.', {
      code: 'unauthenticated',
      status: 401,
    });
  }
  return visitor;
}

function publicConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    channel: row.channel,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicEmbed(req, embed) {
  const configJson = embeds.serializeEmbedConfig(embed);
  return {
    ...configJson,
    widgetUrl: `${baseUrl(req)}/embed/${encodeURIComponent(embed.public_key)}`,
    logoSrc: embed.logo_url || (embed.logo_path ? `${baseUrl(req)}/api/public/embeds/${encodeURIComponent(embed.public_key)}/logo` : null),
  };
}

// CORS for the public API. The embed's allowed origins are enforced in each
// handler; this middleware only adds the response headers and answers
// preflight requests.
router.use('/api/public/embeds', (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, authorization, x-embed-token');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

// Load the embed for every /api/public/embeds/:key route.
router.param('key', async (req, _res, next, key) => {
  try {
    const embed = await embeds.getEmbedByKey(String(key || ''));
    if (!embed || !embed.enabled) {
      throw new AppError('This chat widget is not available.', { code: Codes.NOT_FOUND, status: 404 });
    }
    req.embed = embed;
    return next();
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/api/public/embeds/:key',
  asyncHandler(async (req, res) => {
    res.json({ embed: publicEmbed(req, req.embed) });
  }),
);

router.get(
  '/api/public/embeds/:key/logo',
  asyncHandler(async (req, res) => {
    const logo = await embeds.readEmbedLogo(req.embed);
    if (!logo) {
      throw new AppError('No logo is configured.', { code: Codes.NOT_FOUND, status: 404 });
    }
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(logo.buffer);
  }),
);

router.post(
  '/api/public/embeds/:key/visitors',
  rateLimit({ windowMs: 15 * 60_000, max: 60, keyPrefix: 'embed-visitor' }),
  validateBody(
    z.object({
      name: z.string().trim().min(1, 'Please enter your name.').max(120),
      email: z.string().trim().email('Please enter a valid email address.').max(320),
      consent: z.boolean().optional().default(false),
    }),
  ),
  asyncHandler(async (req, res) => {
    assertOrigin(req, req.embed);
    if (req.embed.consent_required && req.validated.consent !== true) {
      throw new AppError('Please accept the consent notice before continuing.', {
        code: Codes.VALIDATION,
        status: 422,
      });
    }
    const { visitor, token } = await embeds.registerVisitor(req.embed, {
      ...req.validated,
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    const conversation = await embeds.latestConversation(req.embed.id, visitor.id);
    res.status(201).json({
      visitor: { id: visitor.id, name: visitor.name, email: visitor.email },
      token,
      conversation: publicConversation(conversation),
    });
  }),
);

router.get(
  '/api/public/embeds/:key/session',
  asyncHandler(async (req, res) => {
    const visitor = await requireVisitor(req);
    const conversation = await embeds.latestConversation(req.embed.id, visitor.id);
    let messages = [];
    let sources = [];
    if (conversation) {
      const full = await conversations.getConversation(conversation.id);
      messages = full.messages;
      sources = full.sources;
    }
    res.json({
      embed: publicEmbed(req, req.embed),
      visitor: { id: visitor.id, name: visitor.name, email: visitor.email },
      conversation: publicConversation(conversation),
      messages,
      sources,
    });
  }),
);

router.post(
  '/api/public/embeds/:key/conversations',
  asyncHandler(async (req, res) => {
    assertOrigin(req, req.embed);
    const visitor = await requireVisitor(req);
    let conversation = await embeds.latestConversation(req.embed.id, visitor.id);
    if (!conversation) {
      conversation = await embeds.createExternalConversation({ embed: req.embed, visitor });
    }
    res.status(201).json({ conversation: publicConversation(conversation) });
  }),
);

router.get(
  '/api/public/embeds/:key/conversations/:id/messages',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const visitor = await requireVisitor(req);
    const conversation = await embeds.assertVisitorConversation(req.embed, visitor, req.params.id);
    const full = await conversations.getConversation(conversation.id);
    res.json({ messages: full.messages, sources: full.sources });
  }),
);

router.post(
  '/api/public/embeds/:key/conversations/:id/messages',
  validateUuidParam('id'),
  rateLimit({ windowMs: 15 * 60_000, max: 120, keyPrefix: 'embed-ask' }),
  validateBody(
    z.object({
      question: z.string().trim().min(1, 'A question is required').max(8000),
      stream: z.boolean().optional().default(true),
    }),
  ),
  asyncHandler(async (req, res) => {
    assertOrigin(req, req.embed);
    const visitor = await requireVisitor(req);
    await embeds.assertVisitorConversation(req.embed, visitor, req.params.id);
    const body = req.validated;
    const wantsStream = body.stream !== false && req.get('accept') !== 'application/json';

    if (!wantsStream) {
      const result = await conversations.ask({
        conversationId: req.params.id,
        question: body.question,
        options: { stream: false, allowedProjectIds: [req.embed.project_id] },
      });
      return res.json({ result });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const controller = new AbortController();
    let closed = false;
    res.on('close', () => {
      if (!closed) {
        closed = true;
        controller.abort();
      }
    });

    const emit = (event) => {
      if (res.writableEnded || closed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client went away */
      }
    };

    try {
      const result = await conversations.ask({
        conversationId: req.params.id,
        question: body.question,
        options: { stream: true, allowedProjectIds: [req.embed.project_id] },
        emit,
        signal: controller.signal,
      });
      emit({ type: 'complete', ok: result.ok, messageId: result.messageId, code: result.code });
    } catch (err) {
      emit({ type: 'error', code: err.code || 'generation_failed', message: err.message });
    } finally {
      closed = true;
      if (!res.writableEnded) res.end();
    }
  }),
);

/* -------------------------------------------------------------------------- */
/* Floating launcher snippet                                                  */
/* -------------------------------------------------------------------------- */

router.get('/embed.js', (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key.slice(0, 200) : '';
  if (!key) {
    return res
      .status(400)
      .type('application/javascript')
      .send("/* Missing ?key= parameter. Copy the snippet from the project's Chat widget settings. */");
  }

  const script = `(function () {
  if (document.getElementById('quarry-widget')) return;
  var current = document.currentScript;
  if (!current) {
    var all = document.getElementsByTagName('script');
    current = all[all.length - 1];
  }
  var key = ${JSON.stringify(key)};
  var src;
  try { src = new URL(current.src, window.location.href); } catch (e) { return; }
  var base = src.origin;
  var api = base + '/api/public/embeds/' + encodeURIComponent(key);

  var host = document.createElement('div');
  host.id = 'quarry-widget';
  host.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483000;';

  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var styles = [
    ':host { all: initial; }',
    '*, *::before, *::after { box-sizing: border-box; }',
    '.quarry-panel { position: fixed; right: 24px; bottom: 90px; width: 360px; height: 520px; max-height: calc(100vh - 110px); border-radius: 12px; overflow: hidden; background: #0f172a; box-shadow: 0 18px 50px rgba(15,23,42,.35), 0 4px 12px rgba(15,23,42,.25); opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(14px) scale(.98); transform-origin: bottom right; transition: opacity 180ms ease, transform 180ms ease, visibility 180ms ease; z-index: 2147483001; }',
    '.quarry-panel.is-open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); }',
    '.quarry-panel iframe { display: block; width: 100%; height: 100%; border: 0; background: #0f172a; }',
    '.quarry-launcher { position: fixed; right: 24px; bottom: 24px; display: flex; align-items: center; justify-content: center; width: 56px; height: 56px; padding: 0; border: 0; border-radius: 9999px; background: #2F5D62; color: #fff; cursor: pointer; box-shadow: 0 12px 28px rgba(47,93,98,.38); transition: transform 160ms ease, box-shadow 160ms ease, background-color 160ms ease; z-index: 2147483000; }',
    '.quarry-launcher:hover { transform: translateY(-2px); box-shadow: 0 16px 32px rgba(47,93,98,.45); }',
    '.quarry-launcher:focus-visible { outline: 3px solid #8FB5B8; outline-offset: 3px; }',
    '.quarry-launcher svg { display: block; width: 26px; height: 26px; }',
    '@media (max-width: 480px) {',
    '  .quarry-panel { right: 0; bottom: 0; width: 100vw; height: 100vh; height: 100dvh; max-height: none; border-radius: 0; }',
    '  .quarry-launcher { right: 16px; bottom: 16px; }',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  .quarry-panel, .quarry-launcher { transition: none; }',
    '}'
  ].join('\\n');

  var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  root.innerHTML = '<style>' + styles + '</style>' +
    '<div class="quarry-panel" id="quarry-panel" aria-hidden="true">' +
      '<iframe id="quarry-frame" title="Chat with us" allow="clipboard-write"></iframe>' +
    '</div>' +
    '<button type="button" class="quarry-launcher" id="quarry-launcher" aria-label="Open chat" aria-expanded="false" aria-controls="quarry-panel">' + icon + '</button>';

  var panel = root.querySelector('#quarry-panel');
  var frame = root.querySelector('#quarry-frame');
  var button = root.querySelector('#quarry-launcher');
  panel.inert = true;
  frame.src = base + '/embed/' + encodeURIComponent(key);

  var isOpen = false;

  function focusInput() {
    if (!isOpen) return;
    try { frame.contentWindow.postMessage({ type: 'quarry-widget:focus' }, base); } catch (e) {}
  }

  function setOpen(next, restoreFocus) {
    isOpen = next;
    panel.classList.toggle('is-open', isOpen);
    panel.inert = !isOpen;
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    button.setAttribute('aria-label', isOpen ? 'Close chat' : 'Open chat');
    if (isOpen) {
      focusInput();
      window.setTimeout(focusInput, 160);
    } else if (restoreFocus) {
      try { button.focus(); } catch (e) {}
    }
  }

  button.addEventListener('click', function () { setOpen(!isOpen, false); });
  frame.addEventListener('load', focusInput);

  window.addEventListener('message', function (event) {
    if (event.origin !== base) return;
    var data = event.data || {};
    if (data.type === 'quarry-widget:close') setOpen(false, true);
    if (data.type === 'quarry-widget:focus') focusInput();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen) setOpen(false, true);
  });

  (document.body || document.documentElement).appendChild(host);

  fetch(api, { headers: { accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      var embed = data && data.embed;
      if (!embed) return;
      if (embed.themeColor) button.style.background = embed.themeColor;
      if (embed.brandName) {
        button.title = 'Chat with ' + embed.brandName;
        frame.title = embed.brandName + ' chat';
      }
      if (embed.slogan) button.setAttribute('aria-description', embed.slogan);
    })
    .catch(function () {});
})();`;

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(script);
});

module.exports = router;
