'use strict';
/** Regression tests for bugs found in code review. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, mockServer, waitFor } = require('./helpers');
const { setPath } = require('../server/integrations/util');
const { getAdapter } = require('../server/integrations/adapters');

let app;
let admin;
let pm;
before(async () => { app = await startApp(); admin = app.as('admin'); pm = app.as('pm'); });
after(async () => { await app.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

test('pull on a realtime connection does not push the pulled records straight back', async () => {
  const c = (await admin.post('/api/integrations/connections', { adapter: 'autodesk_acc', project_id: 1, realtime: true, config: { sandbox: true } })).body;
  await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull' });
  await settle();
  const jobs = (await admin.get(`/api/integrations/connections/${c.id}/jobs`)).body;
  assert.equal(jobs.filter((j) => j.trigger === 'realtime').length, 0, 'no realtime push for records the pull created');
  const issues = (await admin.get(`/api/integrations/connections/${c.id}/sandbox/issues`)).body;
  assert.equal(issues.length, 1, 'no duplicate remote issue');
});

test('rapid edits on a realtime connection create exactly one remote record', async () => {
  let n = 0;
  const api = await mockServer((call) => (call.method === 'POST' ? { status: 201, body: { id: `r${++n}` }, delay: 150 } : { body: {}, delay: 50 }));
  try {
    const c = (await admin.post('/api/integrations/connections', {
      adapter: 'rest', project_id: 1, realtime: true, config: { base_url: api.url, auth_type: 'none', endpoints: { items: { path: '/items', id_field: 'id' } } },
      mappings: [{ entity: 'items', module: 'punch_list', direction: 'push', fields: [{ local: 'title', remote: 'title' }, { local: 'location', remote: 'location' }] }],
    })).body;
    const rec = (await pm.post('/api/projects/1/modules/punch_list', { title: 'Race me' })).body;
    await pm.patch(`/api/projects/1/modules/punch_list/${rec.id}`, { location: 'L1' });
    await waitFor(() => api.calls.some((x) => x.method === 'PUT' && x.json?.location === 'L1'));
    assert.equal(api.calls.filter((x) => x.method === 'POST').length, 1, 'second edit updates instead of creating a duplicate');
    const links = (await admin.get(`/api/records/${rec.id}/links`)).body.filter((l) => l.connection_id === c.id);
    assert.deepEqual(links.map((l) => l.remote_id), ['r1']);
  } finally { await api.close(); }
});

test('array paths: setPath builds arrays and QuickBooks/Sage bill lines are arrays', async () => {
  assert.deepEqual(setPath({}, 'Line.0.Amount', 5), { Line: [{ Amount: 5 }] });
  assert.deepEqual(setPath({}, 'a.b', 1), { a: { b: 1 } });
  const c = (await admin.post('/api/integrations/connections', { adapter: 'quickbooks', config: { sandbox: true } })).body;
  await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'push', entity: 'Bill' });
  const bill = (await admin.get(`/api/integrations/connections/${c.id}/sandbox/Bill`)).body[0];
  assert.ok(Array.isArray(bill.data.Line), 'QuickBooks requires Line to be an array');
  assert.ok(bill.data.Line[0].Amount > 0);

  const sage = getAdapter('sage_intacct');
  const mapping = { fields: sage.entities.find((e) => e.key === 'accounts-payable/bill').fields };
  const remote = app.ctx.engine.toRemote(sage, mapping, { amount: 10, cost_code: '01-100', description: 'x' });
  assert.ok(Array.isArray(remote.lines));
  assert.equal(remote.lines[0].dimensions.task.id, '01-100');
});

test('QuickBooks live push applies the default expense account to bill lines', async () => {
  const qb = getAdapter('quickbooks');
  const billMapping = { fields: qb.entities.find((e) => e.key === 'Bill').fields };
  const payload = app.ctx.engine.toRemote(qb, billMapping, { invoice_number: 'INV-1', amount: 10, description: 'Fuel' });
  const sent = [];
  const fakeHttp = { get: async () => ({ QueryResponse: { Vendor: [{ Id: '9' }] } }), post: async (path, body) => { sent.push(body); return { Bill: { Id: '77' } }; } };
  const orig = qb.base;
  qb.base = () => fakeHttp;
  try {
    const out = await qb.push({ config: { expense_account_id: '42' }, log() {} }, 'Bill', { ...payload, VendorRef: { name: 'Acme' } });
    assert.equal(out.remoteId, '77');
    assert.ok(Array.isArray(sent[0].Line));
    assert.equal(sent[0].Line[0].Amount, 10);
    assert.equal(sent[0].Line[0].AccountBasedExpenseLineDetail.AccountRef.value, '42');
    assert.equal(sent[0].VendorRef.value, '9');
  } finally { qb.base = orig; }
});

test('pull cursor starts before the request and does not advance past failed records', async () => {
  let failing = true;
  const api = await mockServer((call) => {
    if (call.method !== 'GET') return { body: {} };
    return { body: { data: [{ id: 'ok1', name: 'Cursor Co' }, { id: 'bad1', name: failing ? '' : 'Fixed Co' }] } };
  });
  try {
    const c = (await admin.post('/api/integrations/connections', {
      adapter: 'rest', config: { base_url: api.url, auth_type: 'none', endpoints: { vendors: { path: '/vendors', list_path: 'data', id_field: 'id', since_param: 'since' } } },
      mappings: [{ entity: 'vendors', module: 'directory', direction: 'pull', fields: [{ local: 'name', remote: 'name' }] }],
    })).body;
    const t0 = new Date().toISOString();
    const first = (await admin.post(`/api/integrations/connections/${c.id}/sync`)).body;
    assert.equal(first.status, 'partial');
    assert.ok(first.log.some((l) => /not advanced/.test(l.msg)));
    failing = false;
    await admin.post(`/api/integrations/connections/${c.id}/sync`);
    const gets = api.calls.filter((x) => x.method === 'GET');
    assert.ok(!gets[1].url.includes('since='), 'failed record is retried with the old (empty) cursor');
    assert.equal((await admin.get('/api/company/modules/directory?q=Fixed%20Co')).body.total, 1);
    await admin.post(`/api/integrations/connections/${c.id}/sync`);
    const since = new URL(api.calls.filter((x) => x.method === 'GET')[2].url, api.url).searchParams.get('since');
    assert.ok(since && since >= t0, 'cursor advanced after a clean pull');
  } finally { await api.close(); }
});

test('connection state written during a sync is not lost', async () => {
  // A slow CSV source keeps the pull running while a realtime push writes an export row to state.
  const src = await mockServer(() => ({ body: 'id,Name\n', delay: 300 }));
  try {
    const c = (await admin.post('/api/integrations/connections', {
      adapter: 'csv', project_id: 1, realtime: true, config: { source_url: `${src.url}/tasks.csv` },
      mappings: [{ entity: 'tasks', module: 'tasks', direction: 'both', filter: { category: 'Contract' }, fields: [{ local: 'title', remote: 'Name' }] }],
    })).body;
    const sync = admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull' });
    await waitFor(() => src.calls.length > 0);
    await pm.post('/api/projects/1/modules/tasks', { title: 'Export during sync', category: 'Contract' });
    await sync;
    await waitFor(async () => (await admin.get(`/api/integrations/connections/${c.id}/jobs`)).body.some((j) => j.trigger === 'realtime'));
    const csv = (await admin.get(`/api/integrations/connections/${c.id}/export/tasks`, { raw: true })).body;
    assert.match(csv, /Export during sync/, 'export row written mid-sync survives');
  } finally { await src.close(); }
});

test('DocuSign keeps the commitment title and maps completed envelopes to Approved', async () => {
  const vendor = (await pm.get('/api/company/modules/directory?q=Summit')).body.items[0].id;
  const sc = (await pm.post('/api/projects/1/modules/commitments', { title: 'Sign me', commitment_type: 'Subcontract', vendor, status: 'Out for Signature' })).body;
  const c = (await admin.post('/api/integrations/connections', { adapter: 'docusign', project_id: 1, config: { sandbox: true } })).body;
  await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'push' });
  const env = (await admin.get(`/api/integrations/connections/${c.id}/sandbox/envelopes`)).body.find((e) => e.data.emailSubject === 'Sign me');
  assert.ok(env, 'envelope subject is the commitment title, unprefixed');
  await admin.put(`/api/integrations/connections/${c.id}/sandbox/envelopes`, { remote_id: env.remoteId, data: { status: 'completed', emailSubject: 'Please sign: Sign me' } });
  await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull' });
  const after = (await pm.get(`/api/projects/1/modules/commitments/${sc.id}`)).body;
  assert.equal(after.status, 'Approved');
  assert.equal(after.title, 'Sign me', 'pull never renames the commitment');
});

test('switching a change order to the prime contract stops it counting against the commitment', async () => {
  const sc = (await pm.get('/api/projects/1/modules/commitments?filter[commitment_type]=Subcontract&status=Approved')).body.items[0];
  const prime = (await pm.get('/api/projects/1/modules/prime_contracts')).body.items[0];
  const before = sc.computed.pending_change_orders;
  const co = (await pm.post('/api/projects/1/modules/change_orders', { title: 'Switch', contract_kind: 'Commitment', commitment: sc.id, status: 'Pending', line_items: [{ cost_code: '01-100', amount: 1000 }] })).body;
  assert.equal((await pm.get(`/api/projects/1/modules/commitments/${sc.id}`)).body.computed.pending_change_orders, before + 1000);
  const switched = (await pm.patch(`/api/projects/1/modules/change_orders/${co.id}`, { contract_kind: 'Prime Contract', prime_contract: prime.id })).body;
  assert.equal(switched.commitment ?? null, null, 'hidden commitment reference is cleared');
  assert.equal((await pm.get(`/api/projects/1/modules/commitments/${sc.id}`)).body.computed.pending_change_orders, before);
});

test('project create/update validates input instead of erroring', async () => {
  const ok = await pm.post('/api/projects', { name: 'Flags', active: true, contract_value: '1250000' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.active, 1);
  assert.equal(ok.body.contract_value, 1250000);
  const bad = await pm.post('/api/projects', { name: 'Bad', contract_value: 'lots', start_date: 'soon', city: { x: 1 } });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.body.errors).sort(), ['city', 'contract_value', 'start_date']);
  assert.equal((await pm.patch(`/api/projects/${ok.body.id}`, { active: false })).body.active, 0);
  assert.equal((await pm.patch(`/api/projects/${ok.body.id}`, { name: '' })).status, 422);
});

test('disabling a webhook cancels its queued deliveries', async () => {
  const receiver = await mockServer(() => ({ status: 500 }));
  try {
    const hook = (await admin.post('/api/integrations/webhooks', { url: receiver.url, events: 'tasks.created' })).body;
    await pm.post('/api/projects/1/modules/tasks', { title: 'Queued' });
    const d = await waitFor(async () => (await admin.get(`/api/integrations/webhooks/${hook.id}/deliveries`)).body.find((x) => x.status === 'retrying'));
    const callsBefore = receiver.calls.length;
    await admin.patch(`/api/integrations/webhooks/${hook.id}`, { active: false });
    app.ctx.db.prepare("UPDATE webhook_deliveries SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?").run(d.id);
    await app.ctx.webhooks.drain();
    const after = (await admin.get(`/api/integrations/webhooks/${hook.id}/deliveries`)).body.find((x) => x.id === d.id);
    assert.equal(after.status, 'cancelled');
    assert.equal(receiver.calls.length, callsBefore, 'no further requests to a disabled endpoint');
  } finally { await receiver.close(); }
});

test('push sync covers more than 1000 records', async () => {
  const actor = { user_id: null, name: 'test', source: 'test' };
  for (let i = 0; i < 1050; i++) app.ctx.records.create('equipment', null, { name: `Bulk tool ${i}` }, actor);
  const c = (await admin.post('/api/integrations/connections', { adapter: 'csv', config: {}, mappings: [{ entity: 'equipment', module: 'equipment', direction: 'push', fields: [{ local: 'name', remote: 'Name' }] }] })).body;
  const job = (await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'push' })).body;
  const total = (await admin.get('/api/company/modules/equipment?limit=1')).body.total;
  assert.ok(total > 1000);
  assert.equal(job.stats.pushed, total);
});
