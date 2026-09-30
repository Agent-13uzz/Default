'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

test('login rejects bad credentials and protects the API', async () => {
  const bad = await app.request('POST', '/api/auth/login', { body: { email: 'admin@keystone.test', password: 'nope' } });
  assert.equal(bad.status, 401);
  const anon = await app.request('GET', '/api/projects');
  assert.equal(anon.status, 401);
  const me = await app.as('admin').get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
  assert.equal(me.body.permissions.commitments, 'admin');
});

test('meta exposes every module, role and adapter', async () => {
  const { body } = await app.as('pm').get('/api/meta');
  const keys = body.modules.map((m) => m.key);
  for (const k of ['rfis', 'submittals', 'daily_logs', 'punch_list', 'inspections', 'observations', 'incidents', 'budget', 'commitments', 'change_orders', 'invoices', 'schedule', 'bid_packages', 'timesheets', 'directory']) {
    assert.ok(keys.includes(k), `missing module ${k}`);
  }
  assert.ok(body.adapters.some((a) => a.key === 'quickbooks'));
  assert.ok(body.role_permissions.subcontractor);
});

test('RFI lifecycle: validation, numbering, update, audit, comments, delete', async () => {
  const pm = app.as('pm');
  const invalid = await pm.post('/api/projects/1/modules/rfis', { subject: '' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.errors.subject, 'is required');
  assert.equal(invalid.body.errors.question, 'is required');

  const badSelect = await pm.post('/api/projects/1/modules/rfis', { subject: 'x', question: 'y', priority: 'Whenever' });
  assert.equal(badSelect.status, 422);
  assert.match(badSelect.body.errors.priority, /must be one of/);

  const created = await pm.post('/api/projects/1/modules/rfis', { subject: 'Test RFI', question: 'Why?', priority: 'high', assignee: 4, due_date: '2020-01-01' });
  assert.equal(created.status, 201);
  assert.match(created.body.number, /^RFI-\d{3}$/);
  assert.equal(created.body.priority, 'High', 'select values are normalised case-insensitively');
  assert.equal(created.body.status, 'Open');
  assert.equal(created.body.overdue, true);

  const updated = await pm.patch(`/api/projects/1/modules/rfis/${created.body.id}`, { status: 'Answered', answer: 'Because.' });
  assert.equal(updated.body.status, 'Answered');
  assert.equal(updated.body.subject, 'Test RFI', 'partial updates keep other fields');

  const history = await pm.get(`/api/records/${created.body.id}/activity`);
  assert.equal(history.body[0].changes.status.from, 'Open');
  assert.equal(history.body[0].changes.status.to, 'Answered');

  const comment = await pm.post(`/api/records/${created.body.id}/comments`, { body: 'Ping @engineer' });
  assert.equal(comment.status, 201);
  const notes = await app.as('engineer').get('/api/notifications');
  assert.ok(notes.body.some((n) => n.title.includes('mentioned you')));
  assert.ok(notes.body.some((n) => n.title.includes('Assignee')), 'assignee is notified');

  const list = await pm.get('/api/projects/1/modules/rfis?q=Test%20RFI');
  assert.equal(list.body.total, 1);

  assert.equal((await pm.del(`/api/projects/1/modules/rfis/${created.body.id}`)).status, 204);
  assert.equal((await pm.get(`/api/projects/1/modules/rfis/${created.body.id}`)).status, 404);
});

test('list filters: open, overdue, status, assignee and field filters', async () => {
  const pm = app.as('pm');
  const open = await pm.get('/api/projects/1/modules/punch_list?open=true');
  assert.ok(open.body.items.every((i) => i.status !== 'Closed'));
  const overdue = await pm.get('/api/projects/1/modules/punch_list?overdue=true');
  assert.ok(overdue.body.items.length > 0);
  assert.ok(overdue.body.items.every((i) => i.overdue));
  const byStatus = await pm.get('/api/projects/1/modules/submittals?status=Approved,Draft');
  assert.ok(byStatus.body.items.every((i) => ['Approved', 'Draft'].includes(i.status)));
  const filtered = await pm.get('/api/projects/1/modules/commitments?filter[commitment_type]=Purchase%20Order');
  assert.ok(filtered.body.items.length >= 1);
  assert.ok(filtered.body.items.every((i) => i.commitment_type === 'Purchase Order'));
  const csv = await pm.get('/api/projects/1/modules/rfis/export.csv', { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.body.split('\n')[0], /^number,Subject/);
});

test('ref fields must point at the same project', async () => {
  const pm = app.as('pm');
  const p2rfi = (await pm.get('/api/projects/2/modules/rfis')).body.items[0];
  const res = await pm.post('/api/projects/1/modules/change_events', { title: 'Cross project', origin_rfi: p2rfi.id });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.origin_rfi, /same project/);
});

test('role permissions are enforced', async () => {
  const sub = app.as('sub');
  assert.equal((await sub.get('/api/projects/1/modules/commitments')).status, 403);
  assert.equal((await sub.get('/api/projects/1/budget')).status, 403);
  assert.equal((await sub.post('/api/projects/1/modules/rfis', { subject: 'Sub RFI', question: 'Q' })).status, 201);
  assert.equal((await sub.post('/api/projects/1/modules/drawings', { sheet_number: 'X', title: 'Y' })).status, 403);
  assert.equal((await sub.get('/api/projects/2')).status, 404, 'non-members cannot see a project');
  const owner = app.as('owner');
  assert.equal((await owner.post('/api/projects/1/modules/punch_list', { title: 'x' })).status, 403);
  assert.equal((await owner.get('/api/projects/1/modules/punch_list')).status, 200);
  assert.equal((await app.as('pm').get('/api/admin/users')).status, 403);
  assert.equal((await app.as('pm').get('/api/integrations/connections')).status, 403);
  const search = await sub.get('/api/search?q=Summit');
  assert.ok(search.body.every((r) => !['commitments', 'invoices'].includes(r.module)), 'search respects permissions');
});

test('API keys: scoped read-only vs write, usable as bearer tokens', async () => {
  const pm = app.as('pm');
  const ro = await pm.post('/api/admin/api-keys', { name: 'BI', scopes: 'read' });
  const rw = await pm.post('/api/admin/api-keys', { name: 'ERP', scopes: 'write' });
  assert.match(ro.body.key, /^ks_live_/);
  const readRes = await app.request('GET', '/api/projects/1/modules/rfis', { token: ro.body.key });
  assert.equal(readRes.status, 200);
  const denied = await app.request('POST', '/api/projects/1/modules/tasks', { token: ro.body.key, body: { title: 'x' } });
  assert.equal(denied.status, 403);
  const ok = await app.request('POST', '/api/projects/1/modules/tasks', { token: rw.body.key, body: { title: 'From ERP' } });
  assert.equal(ok.status, 201);
  const audit = await app.as('admin').get('/api/admin/audit?module=tasks');
  assert.ok(audit.body.some((a) => a.record_id === ok.body.id && a.actor === 'Jordan Blake'));
  const viaHeader = await app.request('GET', '/api/projects', { headers: { 'X-API-Key': rw.body.key } });
  assert.equal(viaHeader.status, 200);
  await pm.del(`/api/admin/api-keys/${rw.body.id}`);
  assert.equal((await app.request('GET', '/api/projects', { token: rw.body.key })).status, 401);
});

test('file attachments upload, list and download', async () => {
  const pm = app.as('pm');
  const doc = (await pm.get('/api/projects/1/modules/documents')).body.items[0];
  const up = await pm.post(`/api/records/${doc.id}/files`, Buffer.from('hello keystone'), { headers: { 'Content-Type': 'text/plain', 'X-Filename': 'note.txt' } });
  assert.equal(up.status, 201);
  const files = await pm.get(`/api/records/${doc.id}/files`);
  assert.equal(files.body[0].name, 'note.txt');
  const dl = await pm.get(`/api/files/${up.body.id}`, { raw: true });
  assert.equal(dl.body, 'hello keystone');
  assert.equal((await app.as('owner').get(`/api/files/${up.body.id}`)).status, 200);
});

test('projects, dashboard, portfolio and reports', async () => {
  const pm = app.as('pm');
  const created = await pm.post('/api/projects', { name: 'Test Tower', contract_value: 1000000 });
  assert.equal(created.status, 201);
  const mine = await pm.get('/api/projects');
  assert.ok(mine.body.some((p) => p.id === created.body.id), 'creator becomes a member');
  assert.equal((await app.as('super').post('/api/projects', { name: 'Nope' })).status, 403);

  const dash = await pm.get('/api/projects/1/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.body.counts.rfis.total > 0);
  assert.ok(dash.body.financials.revised_budget > 0);
  assert.ok(dash.body.safety.recordables >= 1);

  const portfolio = await pm.get('/api/portfolio');
  assert.ok(portfolio.body.projects.length >= 3);

  for (const r of ['open-items', 'overdue-by-assignee', 'rfi-log', 'submittal-log', 'safety', 'manpower', 'commitments', 'change-orders']) {
    const res = await pm.get(`/api/projects/1/reports/${r}`);
    assert.equal(res.status, 200, r);
    assert.ok(Array.isArray(res.body.rows), r);
  }
  const safety = await pm.get('/api/projects/1/reports/safety');
  assert.ok(safety.body.summary.trir > 0);
});

test('OpenAPI document covers every module', async () => {
  const res = await app.request('GET', '/api/openapi.json');
  assert.equal(res.status, 200);
  assert.ok(res.body.paths['/api/projects/{projectId}/modules/rfis']);
  assert.ok(res.body.paths['/api/company/modules/directory/{id}']);
  assert.ok(res.body.components.schemas.RFIInput.properties.subject);
});

test('admin user management', async () => {
  const admin = app.as('admin');
  const bad = await admin.post('/api/admin/users', { email: 'x', name: '', role: 'god', password: '1' });
  assert.equal(bad.status, 422);
  const u = await admin.post('/api/admin/users', { email: 'new@keystone.test', name: 'New Person', role: 'viewer', password: 'password1', project_ids: [1] });
  assert.equal(u.status, 201);
  const login = await app.request('POST', '/api/auth/login', { body: { email: 'new@keystone.test', password: 'password1' } });
  assert.equal(login.status, 200);
  await admin.patch(`/api/admin/users/${u.body.id}`, { active: false });
  assert.equal((await app.request('GET', '/api/me', { token: login.body.token })).status, 401, 'deactivation revokes sessions');
});
