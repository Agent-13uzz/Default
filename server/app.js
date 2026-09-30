'use strict';
const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const { createAuth } = require('./auth');
const { createEventBus } = require('./events');
const { createRecordService } = require('./records');
const { createIntegrationEngine } = require('./integrations/engine');
const { createWebhookDispatcher } = require('./integrations/webhooks');
const { coreRoutes } = require('./routes/core');
const { adminRoutes, integrationRoutes } = require('./routes/admin');

/**
 * Builds the application. Returned services are exposed so tests and the
 * seed script can drive the platform without going through HTTP.
 */
function createApp({ dbFile, uploadsDir, background = true, logger = console } = {}) {
  const db = openDatabase(dbFile);
  const events = createEventBus();
  const auth = createAuth(db);
  const records = createRecordService({ db, events });
  const log = (msg) => logger.warn?.(`[keystone] ${msg}`);
  const engine = createIntegrationEngine({ db, records, events, log });
  const webhooks = createWebhookDispatcher({ db, events, log });
  engine.start({ schedulerMs: background ? 60000 : 0 });
  webhooks.start({ intervalMs: background ? 15000 : 0 });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  const uploads = uploadsDir || process.env.KEYSTONE_UPLOADS || path.join(__dirname, '..', 'data', 'uploads');
  // Integration inbound endpoint needs the raw body for signature checks, so mount before JSON parsing.
  app.use('/api/integrations', (req, res, next) => (req.path.startsWith('/inbound/') ? next() : express.json({ limit: '5mb' })(req, res, next)), integrationRoutes({ auth, engine, webhooks }));
  app.use('/api/admin', express.json({ limit: '1mb' }), adminRoutes({ db, auth }));
  app.use('/api', (req, res, next) => (/^\/records\/\d+\/files$/.test(req.path) && req.method === 'POST' ? next() : express.json({ limit: '5mb' })(req, res, next)), coreRoutes({ db, auth, records, uploadsDir: uploads }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error?.(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, ...(err.errors ? { errors: err.errors } : {}) });
  });

  const close = () => {
    engine.stop();
    webhooks.stop();
    db.close();
  };

  return { app, db, auth, events, records, engine, webhooks, close };
}

module.exports = { createApp };
