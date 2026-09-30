'use strict';
const express = require('express');
const { ROLES, hashPassword } = require('../auth');
const { parseJSON } = require('../db');
const { getAdapter } = require('../integrations/adapters');
const { httpError } = require('./core');

function adminRoutes({ db, auth }) {
  const r = express.Router();
  r.use(auth.authenticate);

  // API keys: any user may manage their own; admins see all.
  r.get('/api-keys', (req, res) => {
    const rows = req.user.role === 'admin'
      ? db.prepare('SELECT k.id, k.name, k.prefix, k.scopes, k.last_used_at, k.created_at, u.name AS owner FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.id').all()
      : db.prepare('SELECT id, name, prefix, scopes, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY id').all(req.user.id);
    res.json(rows);
  });

  r.post('/api-keys', (req, res) => {
    if (req.user.viaApiKey) throw httpError(403, 'API keys cannot create API keys');
    const name = String(req.body?.name || '').trim();
    if (!name) throw Object.assign(httpError(422, 'Validation failed'), { errors: { name: 'is required' } });
    const { id, key } = auth.createApiKey(req.user.id, name, req.body?.scopes);
    res.status(201).json({ id, key, note: 'Store this key now – it will not be shown again.' });
  });

  r.delete('/api-keys/:id', (req, res) => {
    if (req.user.viaApiKey) throw httpError(403, 'API keys cannot revoke API keys');
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(req.params.id));
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'admin')) throw httpError(404, 'API key not found');
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(row.id);
    res.status(204).end();
  });

  r.use(auth.requireAdmin);

  r.get('/users', (req, res) => {
    res.json(db.prepare(`SELECT u.id, u.email, u.name, u.title, u.role, u.company_id, u.active, u.created_at,
      (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id) AS project_count FROM users u ORDER BY u.name`).all());
  });

  r.post('/users', (req, res) => {
    const b = req.body || {};
    const errors = {};
    if (!b.email || !/^\S+@\S+\.\S+$/.test(b.email)) errors.email = 'must be a valid email';
    if (!b.name) errors.name = 'is required';
    if (!ROLES[b.role]) errors.role = `must be one of ${Object.keys(ROLES).join(', ')}`;
    if (!b.password || String(b.password).length < 8) errors.password = 'must be at least 8 characters';
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(String(b.email || ''))) errors.email = 'is already in use';
    if (Object.keys(errors).length) throw Object.assign(httpError(422, 'Validation failed'), { errors });
    const info = db.prepare('INSERT INTO users (email, name, title, role, company_id, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.email, b.name, b.title || null, b.role, b.company_id || null, hashPassword(b.password));
    const id = Number(info.lastInsertRowid);
    for (const pid of b.project_ids || []) db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(Number(pid), id);
    res.status(201).json(db.prepare('SELECT id, email, name, title, role, company_id, active FROM users WHERE id = ?').get(id));
  });

  r.patch('/users/:id', (req, res) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw httpError(404, 'User not found');
    const b = req.body || {};
    if (b.role !== undefined && !ROLES[b.role]) throw Object.assign(httpError(422, 'Validation failed'), { errors: { role: 'is invalid' } });
    if (id === req.user.id && (b.role && b.role !== 'admin' || b.active === false)) throw httpError(422, 'You cannot demote or deactivate yourself');
    db.prepare('UPDATE users SET name = ?, title = ?, role = ?, company_id = ?, active = ? WHERE id = ?').run(
      b.name ?? user.name, b.title ?? user.title, b.role ?? user.role, b.company_id !== undefined ? b.company_id || null : user.company_id,
      b.active !== undefined ? (b.active ? 1 : 0) : user.active, id,
    );
    if (b.password) {
      if (String(b.password).length < 8) throw Object.assign(httpError(422, 'Validation failed'), { errors: { password: 'must be at least 8 characters' } });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (b.active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json(db.prepare('SELECT id, email, name, title, role, company_id, active FROM users WHERE id = ?').get(id));
  });

  r.get('/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const where = [];
    const params = [];
    if (req.query.project_id) { where.push('project_id = ?'); params.push(Number(req.query.project_id)); }
    if (req.query.module) { where.push('module = ?'); params.push(String(req.query.module)); }
    const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...params, limit);
    res.json(rows.map((a) => ({ ...a, changes: parseJSON(a.changes, null) })));
  });

  return r;
}

function integrationRoutes({ auth, engine, webhooks }) {
  const r = express.Router();

  // Inbound webhooks are authenticated by HMAC signature, not by user session.
  r.post('/inbound/:id', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const job = engine.handleInbound(Number(req.params.id), Buffer.isBuffer(req.body) ? req.body : Buffer.from(''), req.get('x-keystone-signature'));
    res.json({ job_id: job.id, status: job.status, stats: job.stats, errors: job.log.filter((l) => l.level === 'error').map((l) => l.msg) });
  });

  r.use(auth.authenticate, auth.requireAdmin);

  r.get('/adapters', (req, res) => {
    const { ADAPTERS, describeAdapter } = require('../integrations/adapters');
    res.json(ADAPTERS.map(describeAdapter));
  });

  r.get('/connections', (req, res) => res.json(engine.listConnections()));
  r.post('/connections', (req, res) => res.status(201).json(engine.createConnection(req.body || {})));
  r.get('/connections/:id', (req, res) => {
    const c = engine.getConnection(Number(req.params.id));
    if (!c) throw httpError(404, 'Connection not found');
    res.json({ ...c, jobs: engine.listJobs(c.id) });
  });
  r.patch('/connections/:id', (req, res) => res.json(engine.updateConnection(Number(req.params.id), req.body || {})));
  r.delete('/connections/:id', (req, res) => { engine.deleteConnection(Number(req.params.id)); res.status(204).end(); });
  r.post('/connections/:id/test', async (req, res) => res.json(await engine.testConnection(Number(req.params.id))));
  r.post('/connections/:id/sync', async (req, res) => {
    const { direction = 'both', entity = null } = req.body || {};
    if (!['pull', 'push', 'both'].includes(direction)) throw httpError(422, 'direction must be pull, push or both');
    res.json(await engine.runSync(Number(req.params.id), { direction, entity, trigger: 'manual' }));
  });
  r.get('/connections/:id/jobs', (req, res) => res.json(engine.listJobs(Number(req.params.id), 100)));
  r.get('/jobs/:jobId', (req, res) => {
    const job = engine.getJob(Number(req.params.jobId));
    if (!job) throw httpError(404, 'Job not found');
    res.json(job);
  });
  r.get('/connections/:id/inbound', (req, res) => {
    const c = engine.getConnection(Number(req.params.id), { reveal: true });
    if (!c) throw httpError(404, 'Connection not found');
    res.json({ url: `${req.protocol}://${req.get('host')}/api/integrations/inbound/${c.id}`, secret: c.inbound_secret, signature_header: 'X-Keystone-Signature', algorithm: 'sha256=HMAC_SHA256(secret, raw_body) hex' });
  });
  r.post('/connections/:id/rotate-secret', (req, res) => res.json({ secret: engine.rotateInboundSecret(Number(req.params.id)) }));
  r.get('/connections/:id/sandbox/:entity', (req, res) => res.json(engine.getSandbox(Number(req.params.id), req.params.entity)));
  r.put('/connections/:id/sandbox/:entity', (req, res) => {
    const { remote_id: remoteId, data } = req.body || {};
    res.json(engine.putSandboxRecord(Number(req.params.id), req.params.entity, remoteId, data || {}));
  });
  r.get('/connections/:id/export/:entity', (req, res) => {
    const c = engine.getConnection(Number(req.params.id));
    if (!c || c.adapter !== 'csv') throw httpError(404, 'CSV export is only available for CSV connections');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${req.params.entity}.csv"`);
    res.send(getAdapter('csv').exportCSV(engine.exportState(c.id), req.params.entity));
  });

  r.get('/webhooks', (req, res) => res.json(webhooks.list()));
  r.post('/webhooks', (req, res) => res.status(201).json(webhooks.create(req.body || {})));
  r.patch('/webhooks/:id', (req, res) => res.json(webhooks.update(Number(req.params.id), req.body || {})));
  r.delete('/webhooks/:id', (req, res) => { webhooks.remove(Number(req.params.id)); res.status(204).end(); });
  r.post('/webhooks/:id/test', async (req, res) => { await webhooks.sendTest(Number(req.params.id)); res.json(webhooks.deliveries(Number(req.params.id), 1)[0]); });
  r.get('/webhooks/:id/deliveries', (req, res) => res.json(webhooks.deliveries(Number(req.params.id))));
  r.post('/deliveries/:id/redeliver', (req, res) => { webhooks.redeliver(Number(req.params.id)); res.status(202).json({ ok: true }); });

  return r;
}

module.exports = { adminRoutes, integrationRoutes };
