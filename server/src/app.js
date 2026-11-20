'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cors = require('cors');

const { config } = require('./config/env');
const { logger } = require('./lib/logger');
const { requestContext } = require('./middleware/requestContext');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { publicOrigin, absolutizeMeta } = require('./lib/indexHtml');
const { authenticate, requireAuth, csrfGuard } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const healthRoutes = require('./routes/health');
const projectRoutes = require('./routes/projects');
const documentRoutes = require('./routes/documents');
const knowledgeRoutes = require('./routes/knowledge');
const conversationRoutes = require('./routes/conversations');
const providerRoutes = require('./routes/providers');
const settingsRoutes = require('./routes/settings');
const usageRoutes = require('./routes/usage');
const embedRoutes = require('./routes/embed');
const publicRoutes = require('./routes/public');

function createApp({ testAuth = false, testAuthUserId = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  // Only ever set by the integration-test helper (config.isTest is also checked
  // before this is honoured). Never enabled by the application itself.
  app.set('testAuth', Boolean(testAuth) && config.isTest);
  app.set('testAuthUserId', testAuthUserId);

  // Narrow CORS: only the configured dev/preview origins may call the API.
  const allowed = new Set(config.corsOrigins);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // same-origin / curl / server-side
        if (allowed.has(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['content-type', 'authorization', 'x-request-id', 'accept', 'x-test-user'],
    }),
  );

  // Baseline hardening for every response. The public widget must be frameable
  // by the customer's website, so those paths get an explicit allowance instead
  // of X-Frame-Options: DENY.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    const embedSurface =
      req.path === '/embed.js' ||
      req.path.startsWith('/embed/') ||
      req.path === '/embed' ||
      req.path.startsWith('/api/public/');
    if (embedSurface) {
      res.setHeader('Content-Security-Policy', "frame-ancestors *");
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    }
    next();
  });

  app.use(requestContext);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  // Simple, cheap request shaping for uploads and generation endpoints.
  app.use((req, res, next) => {
    if (req.path.includes('/upload') || req.path.includes('/messages')) {
      res.setTimeout(10 * 60 * 1000); // uploads + long generations
    }
    next();
  });

  // Routers define their own full sub-paths, except the projects router whose
  // routes are relative to the project collection (`/`, `/:id`, `/:id/...`).
  //
  // Public surface: health probes and the auth endpoints (setup / request a
  // link / verify / logout). Everything below `requireAuth` needs a session.
  //
  // The widget API is mounted *before* authenticate/csrfGuard: visitors are on
  // another website, have no session and send legitimate cross-origin requests.
  // It authenticates with a visitor token scoped to one embed key instead.
  app.use(publicRoutes);

  app.use('/api', authenticate);
  app.use('/api', csrfGuard);
  app.use('/api', healthRoutes);
  app.use('/api', authRoutes);
  app.use('/api', requireAuth);
  app.use('/api', adminRoutes);
  app.use('/api', providerRoutes);
  app.use('/api', settingsRoutes);
  app.use('/api', usageRoutes);
  app.use('/api', embedRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api', documentRoutes);
  app.use('/api', knowledgeRoutes);
  app.use('/api', conversationRoutes);

  // Serve the built SPA when it exists (production / `npm run build`).
  const distDir = path.resolve(config.projectRoot, 'web', 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    // Read per request (it is small) so a rebuild while the server runs is
    // picked up, as sendFile did before.
    app.use(async (req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      try {
        const html = await fs.promises.readFile(path.join(distDir, 'index.html'), 'utf8');
        res.set('Cache-Control', 'no-cache');
        return res.type('html').send(absolutizeMeta(html, publicOrigin(req, config.appPublicUrl)));
      } catch (err) {
        return next(err);
      }
    });
    logger.info({ distDir }, 'serving built frontend');
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
