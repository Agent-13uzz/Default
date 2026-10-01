'use strict';
const express = require('express');
const { can } = require('../auth');
const { httpError } = require('./core');

/** Drawing set / spec book upload, review and publish endpoints. */
function packageRoutes({ auth, packages }) {
  const r = express.Router();
  r.use(['/projects/:pid/packages', '/packages'], auth.authenticate);
  r.use('/packages', express.json({ limit: '5mb' }));

  const actor = (req) => ({ user_id: req.user.id, name: req.user.name, source: req.user.viaApiKey ? 'api' : 'web' });

  function check(req, projectId, kind, level) {
    if (!auth.canAccessProject(req.user, Number(projectId))) throw httpError(404, 'Project not found');
    if (!['drawings', 'specifications'].includes(kind)) throw httpError(422, 'kind must be drawings or specifications');
    if (!can(req.user, kind, level)) throw httpError(403, `You do not have ${level} access to ${kind}`);
    if (level !== 'read' && req.user.apiScope === 'read') throw httpError(403, 'API key is read-only');
  }

  function load(req, level) {
    const pkg = packages.get(req.params.id);
    if (!pkg) throw httpError(404, 'Package not found');
    check(req, pkg.project_id, pkg.kind, level);
    return pkg;
  }

  r.post('/projects/:pid/packages', express.raw({ type: () => true, limit: '300mb' }), (req, res) => {
    const kind = String(req.query.kind || '');
    check(req, req.params.pid, kind, 'write');
    const q = req.query;
    const { pkg } = packages.create({
      projectId: Number(req.params.pid), kind, buffer: Buffer.isBuffer(req.body) ? req.body : null,
      fileName: decodeURIComponent(req.get('x-filename') || 'upload.pdf').slice(0, 200), userId: req.user.id,
      defaults: { name: q.name, drawing_set: q.drawing_set || q.name, revision: q.revision, drawing_date: q.drawing_date, received_date: q.received_date, issued_date: q.issued_date },
    });
    res.status(202).json(pkg);
  });

  r.get('/projects/:pid/packages', (req, res) => {
    const kind = req.query.kind ? String(req.query.kind) : null;
    if (!auth.canAccessProject(req.user, Number(req.params.pid))) throw httpError(404, 'Project not found');
    const kinds = (kind ? [kind] : ['drawings', 'specifications']).filter((k) => can(req.user, k, 'read'));
    res.json(kinds.flatMap((k) => packages.list(Number(req.params.pid), k)).sort((a, b) => b.id - a.id));
  });

  r.get('/packages/:id', (req, res) => res.json(load(req, 'read')));

  r.patch('/packages/:id', (req, res) => {
    const pkg = load(req, 'write');
    res.json(packages.updateItems(pkg.id, req.body?.items));
  });

  r.post('/packages/:id/publish', async (req, res) => {
    const pkg = load(req, 'write');
    if (req.body?.items) packages.updateItems(pkg.id, req.body.items);
    res.json(await packages.publish(pkg.id, actor(req)));
  });

  r.post('/packages/:id/reprocess', async (req, res) => {
    const pkg = load(req, 'write');
    if (!['review', 'failed'].includes(pkg.status)) throw httpError(409, `Package is ${pkg.status}`);
    res.json(await packages.processPackage(pkg.id));
  });

  r.delete('/packages/:id', (req, res) => {
    const pkg = load(req, 'write');
    if (pkg.status === 'publishing') throw httpError(409, 'Package is being published');
    packages.remove(pkg.id);
    res.status(204).end();
  });

  r.get('/packages/:id/file', (req, res) => {
    const pkg = load(req, 'read');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(pkg.file_name)}"`);
    res.send(packages.readPdf(pkg));
  });

  r.get('/packages/:id/pages/:n', async (req, res) => {
    const pkg = load(req, 'read');
    const pdf = await packages.pagePdf(pkg.id, Number(req.params.n));
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(`${pkg.name}-page-${req.params.n}.pdf`)}"`);
    res.send(pdf);
  });

  return r;
}

module.exports = { packageRoutes };
