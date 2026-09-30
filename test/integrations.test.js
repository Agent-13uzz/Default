'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startApp, mockServer, waitFor } = require('./helpers');
const { parseCSV, toCSV, getPath, setPath } = require('../server/integrations/util');
const { matchesEvent } = require('../server/events');

let app;
let admin;
before(async () => { app = await startApp(); admin = app.as('admin'); });
after(async () => { await app.stop(); });

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

test('utility helpers', () => {
  const rows = parseCSV('id,name,notes\n1,"Acme, Inc.","said ""hi"""\r\n2,Beta,\n');
  assert.deepEqual(rows, [{ id: '1', name: 'Acme, Inc.', notes: 'said "hi"' }, { id: '2', name: 'Beta', notes: '' }]);
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
  const o = setPath({}, 'a.b.c', 5);
  assert.equal(getPath(o, 'a.b.c'), 5);
  assert.equal(getPath({ items: [{ id: 7 }] }, 'items.0.id'), 7);
  assert.ok(matchesEvent('*', 'rfis.created'));
  assert.ok(matchesEvent('rfis.*', 'rfis.status_changed'));
  assert.ok(matchesEvent('*.created', 'punch_list.created'));
  assert.ok(!matchesEvent('rfis.*', 'submittals.created'));
});

test('integrations are admin-only and list adapters', async () => {
  assert.equal((await app.as('pm').get('/api/integrations/adapters')).status, 403);
  const { body } = await admin.get('/api/integrations/adapters');
  for (const k of ['quickbooks', 'sage_intacct', 'viewpoint', 'autodesk_acc', 'primavera_p6', 'ms_project', 'docusign', 'slack', 'ms_teams', 'procore', 'rest', 'csv']) {
    assert.ok(body.some((a) => a.key === k), `missing adapter ${k}`);
  }
});

test('connection config validation and secret masking', async () => {
  const missing = await admin.post('/api/integrations/connections', { adapter: 'rest', config: {} });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.errors.base_url, 'is required');
  const unknown = await admin.post('/api/integrations/connections', { adapter: 'nope' });
  assert.equal(unknown.status, 422);
  const c = await admin.post('/api/integrations/connections', { adapter: 'rest', config: { base_url: 'http://x', auth_type: 'bearer', token: 'supersecrettoken1234' } });
  assert.equal(c.status, 201);
  assert.match(c.body.config.token, /^••••••1234$/);
  // Saving masked value back keeps the real secret.
  await admin.patch(`/api/integrations/connections/${c.body.id}`, { config: { ...c.body.config, base_url: 'http://y' } });
  const conn = app.ctx.engine.getConnection(c.body.id, { reveal: true });
  assert.equal(conn.config.token, 'supersecrettoken1234');
  assert.equal(conn.config.base_url, 'http://y');
  const badMap = await admin.patch(`/api/integrations/connections/${c.body.id}`, { mappings: [{ entity: 'x', module: 'rfis', fields: [{ local: 'nonexistent', remote: 'a' }] }] });
  assert.equal(badMap.status, 422);
  await admin.del(`/api/integrations/connections/${c.body.id}`);
});

test('QuickBooks sandbox: two-way vendor sync, filtered bill push, idempotency, remote edits', async () => {
  const c = (await admin.post('/api/integrations/connections', { adapter: 'quickbooks', name: 'QBO test', config: { sandbox: true } })).body;
  assert.equal(c.sandbox, true);
  assert.equal((await admin.post(`/api/integrations/connections/${c.id}/test`)).body.ok, true);

  const job = (await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'both' })).body;
  assert.equal(job.status, 'succeeded', JSON.stringify(job.log));
  assert.equal(job.stats.pulled, 2);
  // "Bayside Electric Inc." already exists in the directory – it must be linked, not duplicated.
  const bayside = (await admin.get('/api/company/modules/directory?q=Bayside')).body;
  assert.equal(bayside.total, 1);
  assert.ok(job.log.some((l) => /Linked Vendor 56 to existing/.test(l.msg)));
  const summitPump = (await admin.get('/api/company/modules/directory?q=Summit%20Concrete%20Pumping')).body;
  assert.equal(summitPump.total, 1, 'unknown vendor is created');

  const bills = (await admin.get(`/api/integrations/connections/${c.id}/sandbox/Bill`)).body;
  const approvedCosts = [];
  for (const p of [1, 2, 3]) approvedCosts.push(...(await admin.get(`/api/projects/${p}/modules/direct_costs?status=Approved`)).body.items);
  assert.equal(bills.length, approvedCosts.length, 'only Approved direct costs are pushed as bills');
  const bill = bills.find((b) => b.data.DocNumber === 'BABS-88213');
  assert.equal(bill.data.VendorRef.name, 'Bay Area Building Supply');
  assert.equal(bill.data.Line[0].Amount, 3850);
  const po = (await admin.get(`/api/integrations/connections/${c.id}/sandbox/PurchaseOrder`)).body[0];
  assert.ok(Array.isArray(po.data.Line) && po.data.Line[0].Amount > 0, 'custom lines_to_qbo transform applied');

  const again = (await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'push' })).body;
  assert.equal(again.stats.pushed, 0, 'unchanged records are not re-pushed');

  // Simulate an edit in QuickBooks, then pull it back.
  const vendors = (await admin.get(`/api/integrations/connections/${c.id}/sandbox/Vendor`)).body;
  await admin.put(`/api/integrations/connections/${c.id}/sandbox/Vendor`, { remote_id: '57', data: { PrimaryPhone: { FreeFormNumber: '(510) 555-9999' }, Active: false } });
  const pull = (await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull' })).body;
  assert.equal(pull.stats.updated, 1, JSON.stringify(pull.stats));
  assert.equal(pull.stats.skipped, vendors.length - 1);
  const pump = (await admin.get('/api/company/modules/directory?q=Summit%20Concrete%20Pumping')).body.items[0];
  assert.equal(pump.phone, '(510) 555-9999');
  assert.equal(pump.status, 'Inactive', 'value map translated Active=false');
  const links = (await admin.get(`/api/records/${pump.id}/links`)).body;
  assert.equal(links[0].remote_id, '57');
  const audit = (await admin.get(`/api/records/${pump.id}/activity`)).body;
  assert.match(audit[0].actor, /^Integration: QBO test/);
});

test('realtime push fires on record changes and ignores its own echoes', async () => {
  const c = (await admin.post('/api/integrations/connections', { adapter: 'autodesk_acc', project_id: 1, realtime: true, config: { sandbox: true } })).body;
  const obs = (await app.as('super').post('/api/projects/1/modules/observations', { title: 'Realtime issue', observation_type: 'Quality', due_date: '2026-12-01' })).body;
  const store = await waitFor(async () => {
    const s = (await admin.get(`/api/integrations/connections/${c.id}/sandbox/issues`)).body;
    return s.find((i) => i.data.title === 'Realtime issue') && s;
  });
  const issue = store.find((i) => i.data.title === 'Realtime issue');
  assert.equal(issue.data.status, 'open', 'status mapped back to ACC vocabulary');
  assert.equal(issue.data.dueDate, '2026-12-01');
  // Remote closes it; pull brings the status back.
  await admin.put(`/api/integrations/connections/${c.id}/sandbox/issues`, { remote_id: issue.remoteId, data: { status: 'closed' } });
  await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull', entity: 'issues' });
  assert.equal((await admin.get(`/api/projects/1/modules/observations/${obs.id}`)).body.status, 'Closed');
  const jobs = (await admin.get(`/api/integrations/connections/${c.id}/jobs`)).body;
  assert.ok(jobs.some((j) => j.trigger === 'realtime'));
  // The pull-induced update must not trigger another realtime push job.
  await new Promise((r) => setTimeout(r, 100));
  const after = (await admin.get(`/api/integrations/connections/${c.id}/jobs`)).body;
  assert.equal(after.filter((j) => j.trigger === 'realtime').length, jobs.filter((j) => j.trigger === 'realtime').length);
});

test('pulling project records requires a project-scoped connection', async () => {
  const c = (await admin.post('/api/integrations/connections', { adapter: 'procore', config: { sandbox: true } })).body;
  const job = (await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull', entity: 'rfis' })).body;
  assert.equal(job.status, 'failed');
  assert.ok(job.log.some((l) => /must be scoped to a project/.test(l.msg)));
  await admin.patch(`/api/integrations/connections/${c.id}`, { project_id: 2 });
  const ok = (await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull', entity: 'rfis' })).body;
  assert.equal(ok.stats.created, 1);
  const rfis = (await admin.get('/api/projects/2/modules/rfis?q=Imported')).body.items;
  assert.equal(rfis[0].question, 'Confirm handrail height at landing.');
  assert.equal(rfis[0].status, 'Open');
});

test('Generic REST connector talks to a real HTTP API (pull + create + update)', async () => {
  const remote = [{ id: 'v1', company: { name: 'Remote Roofing LLC' }, contact_email: 'r@roof.io' }];
  const api = await mockServer((call) => {
    assert.equal(call.headers.authorization, 'Bearer t0ken');
    if (call.method === 'GET') return { body: { data: remote } };
    if (call.method === 'POST') return { status: 201, body: { id: `new-${call.json.company.name.length}` } };
    return { body: {} };
  });
  try {
    const c = (await admin.post('/api/integrations/connections', {
      adapter: 'rest', name: 'ERP', config: { base_url: api.url, auth_type: 'bearer', token: 't0ken', endpoints: { vendors: { path: '/vendors', list_path: 'data', id_field: 'id', update_method: 'PUT', update_path: '/vendors/{id}' } } },
      mappings: [{ entity: 'vendors', module: 'directory', direction: 'both', filter: { company_type: 'Supplier' }, fields: [{ local: 'name', remote: 'company.name' }, { local: 'email', remote: 'contact_email' }, { local: 'company_type', remote: 'type', direction: 'push' }] }],
    })).body;
    assert.equal((await admin.post(`/api/integrations/connections/${c.id}/test`)).body.ok, true);
    const job = (await admin.post(`/api/integrations/connections/${c.id}/sync`)).body;
    assert.equal(job.status, 'succeeded', JSON.stringify(job.log));
    const roof = (await admin.get('/api/company/modules/directory?q=Remote%20Roofing')).body.items[0];
    assert.equal(roof.email, 'r@roof.io');
    const posts = api.calls.filter((x) => x.method === 'POST');
    assert.ok(posts.length >= 1);
    assert.ok(posts.every((p) => p.json.type === 'Supplier'), 'push filter applied');
    // Change a supplier locally → PUT to the remote id.
    const supplier = (await admin.get('/api/company/modules/directory?filter[company_type]=Supplier')).body.items[0];
    await admin.patch(`/api/company/modules/directory/${supplier.id}`, { email: 'changed@babs.com' });
    await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'push' });
    const put = api.calls.find((x) => x.method === 'PUT');
    assert.ok(put && /^\/vendors\/new-/.test(put.url));
    assert.equal(put.json.contact_email, 'changed@babs.com');
  } finally { await api.close(); }
});

test('CSV connector imports pasted CSV and exports pushed rows', async () => {
  const c = (await admin.post('/api/integrations/connections', {
    adapter: 'csv', project_id: 1, config: { csv_content: 'id,Name,Class,Date,Hours\nE1,Ana Ruiz,Carpenter,2026-02-01,8\nE2,Bo Chen,Laborer,2026-02-01,7.5\n' },
    mappings: [{ entity: 'payroll', module: 'timesheets', direction: 'both', fields: [{ local: 'worker', remote: 'Name' }, { local: 'classification', remote: 'Class' }, { local: 'work_date', remote: 'Date' }, { local: 'regular_hours', remote: 'Hours', transform: 'number' }] }],
  })).body;
  const job = (await admin.post(`/api/integrations/connections/${c.id}/sync`)).body;
  assert.equal(job.stats.created, 2, JSON.stringify(job.log));
  const csv = await admin.get(`/api/integrations/connections/${c.id}/export/payroll`, { raw: true });
  assert.match(csv.body, /Tom Nguyen/, 'local timesheets are exported');
  assert.doesNotMatch(csv.body, /Ana Ruiz/, 'rows that came from the CSV are not echoed back');
  assert.match(csv.body.split('\n')[0], /^id,Name,Class,Date,Hours/);
});

test('MS Project XML import', async () => {
  const xml = `<Project><Tasks><Task><UID>0</UID><Name>Root</Name></Task><Task><UID>1</UID><Name>Pour footings &amp; walls</Name><WBS>1.1</WBS><Start>2026-03-01T08:00:00</Start><Finish>2026-03-10T17:00:00</Finish><PercentComplete>40</PercentComplete><Milestone>0</Milestone><Critical>1</Critical></Task></Tasks></Project>`;
  const c = (await admin.post('/api/integrations/connections', { adapter: 'ms_project', project_id: 2, config: { xml_content: xml } })).body;
  const job = (await admin.post(`/api/integrations/connections/${c.id}/sync`, { direction: 'pull' })).body;
  assert.equal(job.stats.created, 1, JSON.stringify(job.log));
  const act = (await admin.get('/api/projects/2/modules/schedule?q=footings')).body.items[0];
  assert.equal(act.name, 'Pour footings & walls');
  assert.equal(act.start_date, '2026-03-01');
  assert.equal(act.percent_complete, 40);
  assert.equal(act.critical, true);
});

test('inbound webhooks verify signatures and upsert/delete records', async () => {
  const c = (await admin.post('/api/integrations/connections', { adapter: 'rest', config: { base_url: 'http://unused' }, mappings: [{ entity: 'vendors', module: 'directory', direction: 'pull', fields: [{ local: 'name', remote: 'name' }, { local: 'trade', remote: 'trade' }] }] })).body;
  const { url, secret } = (await admin.get(`/api/integrations/connections/${c.id}/inbound`)).body;
  const path = new URL(url).pathname;
  const body = JSON.stringify({ entity: 'vendors', records: [{ id: 'x1', name: 'Inbound Insulation', trade: 'thermal & moisture' }] });
  const forged = await app.request('POST', path, { body, headers: { 'Content-Type': 'application/json', 'X-Keystone-Signature': 'sha256=deadbeef' } });
  assert.equal(forged.status, 401);
  const ok = await app.request('POST', path, { body, headers: { 'Content-Type': 'application/json', 'X-Keystone-Signature': sign(secret, body) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.stats.created, 1);
  const rec = (await admin.get('/api/company/modules/directory?q=Inbound%20Insulation')).body.items[0];
  assert.equal(rec.trade, 'Thermal & Moisture');
  const del = JSON.stringify({ entity: 'vendors', action: 'delete', records: [{ id: 'x1' }] });
  const res = await app.request('POST', path, { body: del, headers: { 'X-Keystone-Signature': sign(secret, del) } });
  assert.equal(res.body.stats.deleted, 1);
  assert.equal((await admin.get('/api/company/modules/directory?q=Inbound%20Insulation')).body.total, 0);
  const invalid = JSON.stringify({ entity: 'vendors', records: [{ id: 'x2', trade: 'Not a trade' }] });
  const bad = await app.request('POST', path, { body: invalid, headers: { 'X-Keystone-Signature': sign(secret, invalid) } });
  assert.equal(bad.body.status, 'failed');
  assert.ok(bad.body.errors[0].includes('name'));
});

test('outbound webhooks deliver signed events', async () => {
  const receiver = await mockServer(() => ({ status: 200 }));
  try {
    const hook = (await admin.post('/api/integrations/webhooks', { url: `${receiver.url}/hook`, events: 'punch_list.*', project_id: 1 })).body;
    assert.ok(hook.secret);
    await app.as('pm').post('/api/projects/1/modules/punch_list', { title: 'Webhook punch' });
    await app.as('pm').post('/api/projects/2/modules/punch_list', { title: 'Other project' });
    await app.as('pm').post('/api/projects/1/modules/tasks', { title: 'Not subscribed' });
    const call = await waitFor(() => receiver.calls.find((x) => x.json?.data?.title === 'Webhook punch'));
    assert.equal(call.headers['x-keystone-event'], 'punch_list.created');
    assert.equal(call.headers['x-keystone-signature'], sign(hook.secret, call.body));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(receiver.calls.length, 1, 'filtered by event pattern and project');
    const deliveries = (await admin.get(`/api/integrations/webhooks/${hook.id}/deliveries`)).body;
    assert.equal(deliveries[0].status, 'delivered');
    const test = (await admin.post(`/api/integrations/webhooks/${hook.id}/test`)).body;
    assert.equal(test.event, 'ping');
    assert.equal(test.status, 'delivered');
  } finally { await receiver.close(); }
});

test('failed webhook deliveries are scheduled for retry', async () => {
  const receiver = await mockServer(() => ({ status: 500 }));
  try {
    const hook = (await admin.post('/api/integrations/webhooks', { url: receiver.url, events: ['incidents.created'] })).body;
    await app.as('pm').post('/api/projects/1/modules/incidents', { title: 'Retry me', occurred_at: '2026-01-01T09:00', description: 'x' });
    const d = await waitFor(async () => (await admin.get(`/api/integrations/webhooks/${hook.id}/deliveries`)).body.find((x) => x.status === 'retrying'));
    assert.equal(d.attempts, 1);
    assert.equal(d.response_code, 500);
  } finally { await receiver.close(); }
});

test('Slack notifier posts matching events', async () => {
  const slack = await mockServer(() => ({ status: 200, body: 'ok' }));
  try {
    await admin.post('/api/integrations/connections', { adapter: 'slack', config: { webhook_url: `${slack.url}/services/x`, events: 'rfis.created', app_url: 'https://ks.example' } });
    const rfi = (await app.as('pm').post('/api/projects/1/modules/rfis', { subject: 'Slack me', question: '?' })).body;
    const call = await waitFor(() => slack.calls.find((c) => c.json?.text?.includes('Slack me')));
    assert.match(call.json.blocks[0].text.text, new RegExp(`/#/p/1/m/rfis/${rfi.id}`));
    await app.as('pm').post('/api/projects/1/modules/tasks', { title: 'quiet' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(slack.calls.length, 1);
  } finally { await slack.close(); }
});
