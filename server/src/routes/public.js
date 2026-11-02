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
  if (document.getElementById('gs-rag-widget')) return;
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
  host.id = 'gs-rag-widget';
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';

  var panel = document.createElement('div');
  panel.style.cssText = 'display:none;width:380px;height:560px;max-width:calc(100vw - 32px);max-height:calc(100vh - 110px);margin-bottom:12px;border-radius:16px;overflow:hidden;box-shadow:0 20px 50px rgba(15,23,42,.28);background:#fff;';

  var frame = document.createElement('iframe');
  frame.src = base + '/embed/' + encodeURIComponent(key);
  frame.title = 'Chat with us';
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff;';
  frame.setAttribute('allow', 'clipboard-write');
  panel.appendChild(frame);

  var button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Open chat');
  button.textContent = 'Chat';
  button.style.cssText = 'float:right;border:0;border-radius:999px;padding:12px 18px;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 10px 25px rgba(37,99,235,.35);';
  button.onclick = function () {
    var open = panel.style.display === 'block';
    panel.style.display = open ? 'none' : 'block';
    button.textContent = open ? 'Chat' : 'Close';
  };

  host.appendChild(panel);
  host.appendChild(button);
  document.body.appendChild(host);

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
