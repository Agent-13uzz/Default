'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let app;
let pid;
before(async () => {
  app = await startApp();
  pid = (await app.as('pm').post('/api/projects', { name: 'Finance Test' })).body.id;
});
after(async () => { await app.stop(); });

const line = (cost_code, amount, extra = {}) => ({ cost_code, description: cost_code, amount, ...extra });

test('budget report rolls up contracts, change orders, direct costs and invoices', async () => {
  const pm = app.as('pm');
  const post = async (m, body) => {
    const r = await pm.post(`/api/projects/${pid}/modules/${m}`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const vendor = (await pm.get('/api/company/modules/directory?q=Summit')).body.items[0].id;
  await post('budget', { cost_code: '03-300', description: 'Concrete', original_budget: 100000 });
  await post('budget', { cost_code: '26-000', description: 'Electrical', original_budget: 50000, budget_modifications: 5000 });

  const prime = await post('prime_contracts', { title: 'Prime', status: 'Approved', retainage_percent: 5, line_items: [line('03-300', 110000), line('26-000', 60000)] });
  await post('change_orders', { title: 'PCO approved', contract_kind: 'Prime Contract', prime_contract: prime.id, status: 'Approved', line_items: [line('03-300', 10000)] });
  await post('change_orders', { title: 'PCO pending', contract_kind: 'Prime Contract', prime_contract: prime.id, status: 'Pending', line_items: [line('26-000', 4000)] });

  const sc = await post('commitments', { title: 'Concrete SC', commitment_type: 'Subcontract', vendor, status: 'Approved', line_items: [line('03-300', 80000)] });
  await post('commitments', { title: 'Draft SC', commitment_type: 'Subcontract', vendor, status: 'Draft', line_items: [line('03-300', 99999)] });
  await post('change_orders', { title: 'SCCO approved', contract_kind: 'Commitment', commitment: sc.id, status: 'Approved', line_items: [line('03-300', 7000)] });
  await post('change_orders', { title: 'SCCO pending', contract_kind: 'Commitment', commitment: sc.id, status: 'Pending', line_items: [line('03-300', 3000)] });
  await post('direct_costs', { description: 'Pump truck', cost_code: '03-300', amount: 2500, status: 'Approved' });
  await post('direct_costs', { description: 'Pending', cost_code: '03-300', amount: 999, status: 'Pending' });
  await post('direct_costs', { description: 'Unbudgeted', cost_code: '99-999', amount: 1200, status: 'Approved' });
  await post('invoices', { title: 'Sub pay app', contract_kind: 'Commitment', commitment: sc.id, status: 'Approved', retainage_percent: 10, line_items: [line('03-300', 40000)] });

  const { body } = await pm.get(`/api/projects/${pid}/budget`);
  const concrete = body.lines.find((l) => l.cost_code === '03-300');
  assert.equal(concrete.original_budget, 100000);
  assert.equal(concrete.approved_changes, 10000);
  assert.equal(concrete.revised_budget, 110000);
  assert.equal(concrete.committed_costs, 87000, 'approved commitment + approved SCCO; drafts excluded');
  assert.equal(concrete.pending_cost_changes, 3000);
  assert.equal(concrete.direct_costs, 2500);
  assert.equal(concrete.job_to_date_costs, 42500);
  assert.equal(concrete.projected_costs, 92500);
  assert.equal(concrete.forecast_to_complete, 17500);
  assert.equal(concrete.estimated_cost_at_completion, 110000);
  assert.equal(concrete.projected_over_under, 0);

  const elec = body.lines.find((l) => l.cost_code === '26-000');
  assert.equal(elec.revised_budget, 55000);
  assert.equal(elec.pending_budget_changes, 4000);
  assert.equal(elec.projected_budget, 59000);

  const unbudgeted = body.lines.find((l) => l.cost_code === '99-999');
  assert.equal(unbudgeted.unbudgeted, true);
  assert.equal(unbudgeted.projected_over_under, -1200);
  assert.equal(body.totals.revised_budget, 165000);

  const scDetail = await pm.get(`/api/projects/${pid}/modules/commitments/${sc.id}`);
  assert.deepEqual(
    { o: scDetail.body.computed.original_contract_value, a: scDetail.body.computed.approved_change_orders, p: scDetail.body.computed.pending_change_orders, r: scDetail.body.computed.revised_contract_value, i: scDetail.body.computed.invoiced_to_date, rem: scDetail.body.computed.remaining_balance, ret: scDetail.body.computed.retainage_held },
    { o: 80000, a: 7000, p: 3000, r: 87000, i: 40000, rem: 47000, ret: 4000 },
  );

  const primeDetail = await pm.get(`/api/projects/${pid}/modules/prime_contracts/${prime.id}`);
  assert.equal(primeDetail.body.computed.revised_contract_value, 180000);
  assert.equal(primeDetail.body.computed.pending_change_orders, 4000);
});

test('computed values for invoices, estimates, daily logs, inspections and bids', async () => {
  const pm = app.as('pm');
  const inv = await pm.post(`/api/projects/${pid}/modules/invoices`, { title: 'Owner app', contract_kind: 'Prime Contract', retainage_percent: 10, line_items: [line('01', 1000), line('02', 500.5)] });
  assert.deepEqual(inv.body.computed, { gross_amount: 1500.5, retainage: 150.05, net_amount_due: 1350.45 });

  const est = await pm.post(`/api/projects/${pid}/modules/estimates`, { title: 'Est', markup_percent: 10, line_items: [{ cost_code: '09', quantity: 100, unit_cost: 12.5 }] });
  assert.equal(est.body.line_items[0].amount, 1250, 'qty × unit cost fills amount');
  assert.deepEqual(est.body.computed, { subtotal: 1250, markup: 125, total: 1375 });

  const log = await pm.post(`/api/projects/${pid}/modules/daily_logs`, { log_date: '2026-01-05', manpower: [{ company: 'A', workers: 5, hours: 8 }, { company: 'B', workers: 2, hours: 10 }, {}] });
  assert.equal(log.body.manpower.length, 2, 'empty line rows are dropped');
  assert.deepEqual(log.body.computed, { total_workers: 7, total_man_hours: 60 });

  const ins = await pm.post(`/api/projects/${pid}/modules/inspections`, { title: 'Walk', checklist: [{ item: 'a', result: 'Pass' }, { item: 'b', result: 'Fail' }, { item: 'c', result: 'N/A' }] });
  assert.deepEqual(ins.body.computed, { items: 3, passed: 1, failed: 1, not_applicable: 1 });

  const bid = await pm.post(`/api/projects/${pid}/modules/bid_packages`, { title: 'Drywall', estimate: 100000, bidders: [{ company: 'A', amount: 95000 }, { company: 'B', amount: 110000 }, { company: 'C', status: 'Declined' }] });
  assert.deepEqual(bid.body.computed, { bids_received: 2, low_bid: 95000, high_bid: 110000, spread_vs_estimate: -5000 });

  const ts = await pm.post(`/api/projects/${pid}/modules/timesheets`, { worker: 'W', work_date: '2026-01-05', regular_hours: 8, overtime_hours: 2, hourly_rate: 40 });
  assert.deepEqual(ts.body.computed, { total_hours: 10, labor_cost: 440 });
});

test('change order requires its contract when the kind is chosen', async () => {
  const res = await app.as('pm').post(`/api/projects/${pid}/modules/change_orders`, { title: 'No kind' });
  assert.equal(res.status, 422);
  assert.equal(res.body.errors.contract_kind, 'is required');
});
