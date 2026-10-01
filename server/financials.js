'use strict';
const { parseJSON } = require('./db');

/**
 * Financial roll-ups. Everything here is computed on read from the source
 * records (budget lines, contracts, change orders, invoices, direct costs),
 * so numbers are always consistent without denormalised totals to maintain.
 */

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sumLines = (lines) => round((lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0));

const APPROVED_CONTRACT = ['Approved', 'Complete'];
const PENDING_CO = ['Draft', 'Pending'];
const INVOICED = ['Approved', 'Paid'];

function projectRecords(db, projectId, module) {
  return db.prepare('SELECT id, status, data FROM records WHERE module = ? AND project_id = ? AND deleted_at IS NULL')
    .all(module, projectId)
    .map((r) => ({ id: r.id, status: r.status, ...parseJSON(r.data, {}) }));
}

function contractSummary(db, contractModule, record) {
  const refField = contractModule === 'prime_contracts' ? 'prime_contract' : 'commitment';
  const kind = contractModule === 'prime_contracts' ? 'Prime Contract' : 'Commitment';
  // Match on contract kind as well as the reference, consistent with the budget report.
  const belongs = (r) => r.contract_kind === kind && r[refField] === record.id;
  const cos = projectRecords(db, record.project_id, 'change_orders').filter(belongs);
  const invoices = projectRecords(db, record.project_id, 'invoices').filter(belongs);
  const original = sumLines(record.line_items);
  const approved = round(cos.filter((c) => c.status === 'Approved').reduce((s, c) => s + sumLines(c.line_items), 0));
  const pending = round(cos.filter((c) => PENDING_CO.includes(c.status)).reduce((s, c) => s + sumLines(c.line_items), 0));
  const revised = round(original + approved);
  const invoiced = round(invoices.filter((i) => INVOICED.includes(i.status)).reduce((s, i) => s + sumLines(i.line_items), 0));
  const paid = round(invoices.filter((i) => i.status === 'Paid').reduce((s, i) => s + sumLines(i.line_items), 0));
  const retainagePct = Number(record.retainage_percent) || 0;
  return {
    original_contract_value: original,
    approved_change_orders: approved,
    pending_change_orders: pending,
    revised_contract_value: revised,
    pending_revised_value: round(revised + pending),
    invoiced_to_date: invoiced,
    paid_to_date: paid,
    retainage_held: round((invoiced * retainagePct) / 100),
    remaining_balance: round(revised - invoiced),
    percent_invoiced: revised ? round((invoiced / revised) * 100) : 0,
    change_order_count: cos.length,
    invoice_count: invoices.length,
  };
}

/** Per-record computed values shown on detail pages and returned by the API. */
function computeRecord(db, mod, record) {
  if (!mod) return undefined;
  switch (mod.key) {
    case 'prime_contracts':
    case 'commitments':
      return contractSummary(db, mod.key, record);
    case 'change_orders':
    case 'change_events':
    case 'direct_costs':
      return { total: mod.key === 'direct_costs' ? round(record.amount) : sumLines(record.line_items) };
    case 'invoices': {
      const gross = sumLines(record.line_items);
      const retainage = round((gross * (Number(record.retainage_percent) || 0)) / 100);
      return { gross_amount: gross, retainage, net_amount_due: round(gross - retainage) };
    }
    case 'estimates': {
      const subtotal = sumLines(record.line_items);
      const markup = round((subtotal * (Number(record.markup_percent) || 0)) / 100);
      return { subtotal, markup, total: round(subtotal + markup) };
    }
    case 'bid_packages': {
      const bids = (record.bidders || []).filter((b) => Number(b.amount) > 0);
      const amounts = bids.map((b) => Number(b.amount));
      return {
        bids_received: bids.length,
        low_bid: amounts.length ? Math.min(...amounts) : null,
        high_bid: amounts.length ? Math.max(...amounts) : null,
        spread_vs_estimate: amounts.length && record.estimate ? round(Math.min(...amounts) - record.estimate) : null,
      };
    }
    case 'daily_logs': {
      const workers = (record.manpower || []).reduce((s, m) => s + (Number(m.workers) || 0), 0);
      const hours = (record.manpower || []).reduce((s, m) => s + (Number(m.workers) || 0) * (Number(m.hours) || 0), 0);
      return { total_workers: workers, total_man_hours: hours };
    }
    case 'inspections': {
      const items = record.checklist || [];
      return {
        items: items.length,
        passed: items.filter((i) => i.result === 'Pass').length,
        failed: items.filter((i) => i.result === 'Fail').length,
        not_applicable: items.filter((i) => i.result === 'N/A').length,
      };
    }
    case 'timesheets': {
      const reg = Number(record.regular_hours) || 0;
      const ot = Number(record.overtime_hours) || 0;
      const rate = Number(record.hourly_rate) || 0;
      return { total_hours: reg + ot, labor_cost: round(reg * rate + ot * rate * 1.5) };
    }
    case 'action_plans': {
      const steps = record.steps || [];
      return { steps: steps.length, completed: steps.filter((s) => s.done).length };
    }
    default:
      return undefined;
  }
}

/**
 * Budget report modelled on the standard GC budget view:
 *   Revised Budget          = Original + Modifications + Approved (prime) COs
 *   Projected Budget        = Revised + Pending (prime) budget changes
 *   Committed Costs         = Approved commitments + approved commitment COs
 *   Projected Costs         = Committed + Direct Costs + Pending cost changes
 *   Forecast to Complete    = override, else max(Projected Budget − Projected Costs, 0)
 *   Est. Cost at Completion = Projected Costs + Forecast to Complete
 *   Projected Over/Under    = Projected Budget − Est. Cost at Completion
 */
function budgetReport(db, projectId) {
  const rows = new Map();
  const row = (code, description = '') => {
    const key = code || 'UNCODED';
    if (!rows.has(key)) {
      rows.set(key, {
        cost_code: key, description, category: null, budget_line_id: null, unbudgeted: true,
        original_budget: 0, budget_modifications: 0, approved_changes: 0, revised_budget: 0, pending_budget_changes: 0,
        projected_budget: 0, committed_costs: 0, pending_cost_changes: 0, direct_costs: 0, job_to_date_costs: 0,
        projected_costs: 0, forecast_to_complete: 0, estimated_cost_at_completion: 0, projected_over_under: 0, ftc_override: null,
      });
    }
    return rows.get(key);
  };

  for (const b of projectRecords(db, projectId, 'budget')) {
    const r = row(b.cost_code, b.description);
    r.description = b.description;
    r.category = b.category || null;
    r.budget_line_id = b.id;
    r.unbudgeted = false;
    r.original_budget += Number(b.original_budget) || 0;
    r.budget_modifications += Number(b.budget_modifications) || 0;
    if (b.forecast_to_complete != null) r.ftc_override = Number(b.forecast_to_complete);
  }

  const commitments = new Map(projectRecords(db, projectId, 'commitments').map((c) => [c.id, c]));
  for (const c of commitments.values()) {
    if (!APPROVED_CONTRACT.includes(c.status)) continue;
    for (const l of c.line_items || []) row(l.cost_code, l.description).committed_costs += Number(l.amount) || 0;
  }

  for (const co of projectRecords(db, projectId, 'change_orders')) {
    const isPrime = co.contract_kind === 'Prime Contract';
    for (const l of co.line_items || []) {
      const r = row(l.cost_code, l.description);
      const amt = Number(l.amount) || 0;
      if (isPrime && co.status === 'Approved') r.approved_changes += amt;
      else if (isPrime && PENDING_CO.includes(co.status)) r.pending_budget_changes += amt;
      else if (!isPrime && co.status === 'Approved' && commitments.has(co.commitment)) r.committed_costs += amt;
      else if (!isPrime && PENDING_CO.includes(co.status)) r.pending_cost_changes += amt;
    }
  }

  for (const d of projectRecords(db, projectId, 'direct_costs')) {
    if (d.status !== 'Approved') continue;
    row(d.cost_code).direct_costs += Number(d.amount) || 0;
  }

  for (const inv of projectRecords(db, projectId, 'invoices')) {
    if (inv.contract_kind !== 'Commitment' || !INVOICED.includes(inv.status)) continue;
    for (const l of inv.line_items || []) row(l.cost_code, l.description).job_to_date_costs += Number(l.amount) || 0;
  }

  const lines = [...rows.values()].sort((a, b) => a.cost_code.localeCompare(b.cost_code, undefined, { numeric: true }));
  const totals = {};
  for (const r of lines) {
    r.revised_budget = r.original_budget + r.budget_modifications + r.approved_changes;
    r.projected_budget = r.revised_budget + r.pending_budget_changes;
    r.job_to_date_costs += r.direct_costs;
    r.projected_costs = r.committed_costs + r.direct_costs + r.pending_cost_changes;
    r.forecast_to_complete = r.ftc_override != null ? r.ftc_override : Math.max(r.projected_budget - r.projected_costs, 0);
    r.estimated_cost_at_completion = r.projected_costs + r.forecast_to_complete;
    r.projected_over_under = r.projected_budget - r.estimated_cost_at_completion;
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number' && k !== 'budget_line_id' && k !== 'ftc_override') {
        r[k] = round(v);
        totals[k] = round((totals[k] || 0) + v);
      }
    }
  }
  return { lines, totals };
}

/** Project-level financial snapshot for dashboards. */
function financialSummary(db, projectId) {
  const primes = projectRecords(db, projectId, 'prime_contracts').map((p) => ({ ...p, project_id: projectId }));
  const commitments = projectRecords(db, projectId, 'commitments').map((c) => ({ ...c, project_id: projectId }));
  const prime = primes.reduce((acc, p) => {
    const s = contractSummary(db, 'prime_contracts', p);
    acc.revised += s.revised_contract_value;
    acc.invoiced += s.invoiced_to_date;
    acc.pending += s.pending_change_orders;
    return acc;
  }, { revised: 0, invoiced: 0, pending: 0 });
  const committed = commitments.filter((c) => APPROVED_CONTRACT.includes(c.status))
    .reduce((s, c) => s + contractSummary(db, 'commitments', c).revised_contract_value, 0);
  const { totals } = budgetReport(db, projectId);
  return {
    revised_prime_contract: round(prime.revised),
    prime_invoiced: round(prime.invoiced),
    pending_prime_changes: round(prime.pending),
    committed_costs: round(committed),
    revised_budget: totals.revised_budget || 0,
    projected_costs: totals.projected_costs || 0,
    projected_over_under: totals.projected_over_under || 0,
    direct_costs: totals.direct_costs || 0,
    projected_margin: round(prime.revised - (totals.estimated_cost_at_completion || 0)),
  };
}

module.exports = { computeRecord, budgetReport, financialSummary, contractSummary, sumLines };
