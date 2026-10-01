'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { MODULES, GROUPS, getModule } = require('../modules');
const { ROLES, verifyPassword, permissionMatrix, can } = require('../auth');
const { budgetReport, financialSummary } = require('../financials');
const { parseJSON } = require('../db');
const { toCSV } = require('../integrations/util');
const { describeAdapter, ADAPTERS } = require('../integrations/adapters');
const { buildOpenApi } = require('../openapi');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const today = () => new Date().toISOString().slice(0, 10);

function coreRoutes({ db, auth, records, uploadsDir }) {
  const r = express.Router();
  const actor = (req) => ({ user_id: req.user.id, name: req.user.name, source: req.user.viaApiKey ? 'api' : 'web' });

  // ─── Public ──────────────────────────────────────────────────────────
  r.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || ''));
    if (!user || !verifyPassword(password, user.password_hash)) throw httpError(401, 'Invalid email or password');
    res.json({ token: auth.createSession(user.id), user: auth.publicUser(user) });
  });

  r.get('/openapi.json', (req, res) => res.json(buildOpenApi(`${req.protocol}://${req.get('host')}`)));
  r.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // Everything below requires authentication.
  r.use(auth.authenticate);

  r.post('/auth/logout', (req, res) => {
    if (!req.user.viaApiKey) auth.destroySession(req.token);
    res.status(204).end();
  });

  r.get('/me', (req, res) => {
    res.json({ user: req.user, permissions: permissionMatrix(req.user), unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id).n });
  });

  r.get('/meta', (req, res) => {
    res.json({
      groups: GROUPS,
      modules: MODULES,
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
      role_permissions: Object.fromEntries(Object.keys(ROLES).map((role) => [role, permissionMatrix({ role })])),
      adapters: ADAPTERS.map(describeAdapter),
    });
  });

  r.get('/users', (req, res) => {
    res.json(db.prepare('SELECT id, name, email, title, role, company_id FROM users WHERE active = 1 ORDER BY name').all());
  });

  // ─── Access helpers ──────────────────────────────────────────────────
  function assertProject(req, pid) {
    const id = Number(pid);
    if (!Number.isInteger(id) || !auth.canAccessProject(req.user, id)) throw httpError(404, 'Project not found');
    return id;
  }

  function assertModule(req, moduleKey, level) {
    const mod = getModule(moduleKey);
    if (!mod) throw httpError(404, `Unknown tool "${moduleKey}"`);
    if (!can(req.user, moduleKey, level)) throw httpError(403, `You do not have ${level} access to ${mod.label}`);
    return mod;
  }

  /** Load a record by id and verify the caller can access it at `level`. */
  function assertRecord(req, id, level = 'read') {
    const row = records.getRow(id);
    if (!row) throw httpError(404, 'Record not found');
    assertModule(req, row.module, level);
    if (row.project_id) assertProject(req, row.project_id);
    return row;
  }

  function assertWriteScope(req) {
    if (req.user.apiScope === 'read' && req.method !== 'GET') throw httpError(403, 'API key is read-only');
  }

  // ─── Projects ────────────────────────────────────────────────────────
  const projectFields = ['number', 'name', 'stage', 'address', 'city', 'state', 'zip', 'start_date', 'completion_date', 'contract_value', 'project_type', 'description', 'active'];

  /** Validate and coerce project fields into values SQLite accepts; bad input is a 422, not a 500. */
  function projectValues(body) {
    const out = {};
    const errors = {};
    for (const f of projectFields) {
      let v = body[f];
      if (v === undefined) continue;
      if (v === '' ) v = null;
      if (f === 'active') v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
      else if (f === 'contract_value') {
        if (v != null && !Number.isFinite(Number(v))) { errors[f] = 'must be a number'; continue; }
        if (v != null) v = Number(v);
      } else if (['start_date', 'completion_date'].includes(f)) {
        if (v != null && (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v)))) { errors[f] = 'must be a date (YYYY-MM-DD)'; continue; }
      } else if (v != null) {
        if (typeof v === 'object') { errors[f] = 'must be text'; continue; }
        v = String(v).slice(0, 2000);
      }
      out[f] = v;
    }
    if (out.name === null) errors.name = 'is required';
    if (Object.keys(errors).length) throw Object.assign(httpError(422, 'Validation failed'), { errors });
    return out;
  }

  function projectsFor(user) {
    return user.role === 'admin'
      ? db.prepare('SELECT * FROM projects ORDER BY active DESC, name').all()
      : db.prepare('SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.active DESC, p.name').all(user.id);
  }

  r.get('/projects', (req, res) => res.json(projectsFor(req.user)));

  r.post('/projects', (req, res) => {
    assertWriteScope(req);
    if (!['admin', 'manager'].includes(req.user.role)) throw httpError(403, 'Only admins and project managers can create projects');
    const b = req.body || {};
    if (!b.name) throw Object.assign(httpError(422, 'Validation failed'), { errors: { name: 'is required' } });
    const values = projectValues(b);
    const cols = Object.keys(values);
    const info = db.prepare(`INSERT INTO projects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => values[c]));
    const pid = Number(info.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(pid, req.user.id);
    db.prepare('INSERT INTO audit_log (user_id, actor, action, project_id, summary) VALUES (?, ?, ?, ?, ?)').run(req.user.id, req.user.name, 'created', pid, `Created project ${b.name}`);
    res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(pid));
  });

  r.get('/projects/:pid', (req, res) => {
    const pid = assertProject(req, req.params.pid);
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(pid));
  });

  r.patch('/projects/:pid', (req, res) => {
    assertWriteScope(req);
    const pid = assertProject(req, req.params.pid);
    if (!['admin', 'manager'].includes(req.user.role)) throw httpError(403, 'Only admins and project managers can edit projects');
    const values = projectValues(req.body || {});
    const cols = Object.keys(values);
    if (cols.length) {
      db.prepare(`UPDATE projects SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => values[c]), pid);
    }
    res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(pid));
  });

  r.delete('/projects/:pid', (req, res) => {
    if (req.user.role !== 'admin' || req.user.apiScope === 'read') throw httpError(403, 'Only company admins can delete projects');
    const pid = assertProject(req, req.params.pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    res.status(204).end();
  });

  r.get('/projects/:pid/members', (req, res) => {
    const pid = assertProject(req, req.params.pid);
    res.json(db.prepare('SELECT u.id, u.name, u.email, u.title, u.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name').all(pid));
  });

  r.post('/projects/:pid/members', (req, res) => {
    assertWriteScope(req);
    const pid = assertProject(req, req.params.pid);
    if (!['admin', 'manager'].includes(req.user.role)) throw httpError(403, 'Only admins and project managers can manage the team');
    const uid = Number(req.body?.user_id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) throw httpError(422, 'Unknown user');
    db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(pid, uid);
    res.status(201).json({ ok: true });
  });

  r.delete('/projects/:pid/members/:uid', (req, res) => {
    assertWriteScope(req);
    const pid = assertProject(req, req.params.pid);
    if (!['admin', 'manager'].includes(req.user.role)) throw httpError(403, 'Only admins and project managers can manage the team');
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(pid, Number(req.params.uid));
    res.status(204).end();
  });

  // ─── Dashboards & reports ────────────────────────────────────────────
  function moduleCounts(pid, user) {
    const out = {};
    for (const m of MODULES.filter((x) => x.scope === 'project' && can(user, x.key, 'read'))) {
      const closed = m.closedStatuses;
      const notClosed = closed.length ? `AND status NOT IN (${closed.map(() => '?').join(',')})` : '';
      const base = 'FROM records WHERE module = ? AND project_id = ? AND deleted_at IS NULL';
      const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(m.key, pid).n;
      const open = db.prepare(`SELECT COUNT(*) AS n ${base} ${notClosed}`).get(m.key, pid, ...closed).n;
      const overdue = m.dueField
        ? db.prepare(`SELECT COUNT(*) AS n ${base} ${notClosed} AND json_extract(data, '$.${m.dueField}') < ?`).get(m.key, pid, ...closed, today()).n
        : 0;
      out[m.key] = { total, open, overdue };
    }
    return out;
  }

  function myOpenItems(user, pid = null) {
    const items = [];
    for (const m of MODULES.filter((x) => x.assigneeFields.length && can(user, x.key, 'read'))) {
      const projects = pid ? [pid] : projectsFor(user).map((p) => p.id);
      for (const p of projects) {
        for (const rec of records.list(m.key, { projectId: p, open: true, assignee: user.id, limit: 50, withComputed: false }).items) {
          items.push({ id: rec.id, module: m.key, module_label: m.singular, project_id: p, number: rec.number, title: rec.title, status: rec.status, due: m.dueField ? rec[m.dueField] : null, overdue: !!rec.overdue });
        }
      }
    }
    return items.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
  }

  function recentActivity(pid, user, limit = 25) {
    const allowed = MODULES.filter((m) => can(user, m.key, 'read')).map((m) => m.key);
    return db.prepare(`SELECT id, ts, actor, action, module, record_id, summary FROM audit_log
      WHERE project_id = ? AND (module IS NULL OR module IN (${allowed.map(() => '?').join(',')})) ORDER BY id DESC LIMIT ?`).all(pid, ...allowed, limit);
  }

  r.get('/projects/:pid/dashboard', (req, res) => {
    const pid = assertProject(req, req.params.pid);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    const schedule = can(req.user, 'schedule', 'read') ? records.list('schedule', { projectId: pid, limit: 1000, withComputed: false }).items : [];
    const pct = schedule.length ? Math.round(schedule.reduce((s, a) => s + (Number(a.percent_complete) || 0), 0) / schedule.length) : null;
    const upcoming = schedule.filter((a) => a.status !== 'Complete' && a.finish_date >= today()).slice(0, 6);
    let safety = null;
    if (can(req.user, 'incidents', 'read')) {
      const inc = records.list('incidents', { projectId: pid, limit: 1000, withComputed: false }).items;
      const last = inc.map((i) => String(i.occurred_at).slice(0, 10)).sort().pop();
      safety = {
        incidents: inc.length,
        recordables: inc.filter((i) => i.osha_recordable).length,
        near_misses: inc.filter((i) => i.incident_type === 'Near Miss').length,
        days_since_last_incident: last ? Math.max(0, Math.floor((Date.now() - Date.parse(last)) / 864e5)) : null,
      };
    }
    let weather = null;
    if (can(req.user, 'daily_logs', 'read')) {
      weather = records.list('daily_logs', { projectId: pid, limit: 7, sort: 'log_date', dir: 'desc' }).items
        .map((l) => ({ date: l.log_date, weather: l.weather, high: l.temperature_high, workers: l.computed?.total_workers || 0 }));
    }
    res.json({
      project,
      counts: moduleCounts(pid, req.user),
      my_items: myOpenItems(req.user, pid).slice(0, 20),
      financials: can(req.user, 'budget', 'read') ? financialSummary(db, pid) : null,
      schedule: { activities: schedule.length, percent_complete: pct, upcoming },
      safety,
      manpower: weather,
      activity: recentActivity(pid, req.user, 15),
      team: db.prepare('SELECT u.id, u.name, u.title, u.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name').all(pid),
    });
  });

  r.get('/portfolio', (req, res) => {
    const projects = projectsFor(req.user).map((p) => {
      const counts = moduleCounts(p.id, req.user);
      const open = Object.values(counts).reduce((s, c) => s + c.open, 0);
      const overdue = Object.values(counts).reduce((s, c) => s + c.overdue, 0);
      return {
        ...p,
        open_items: open,
        overdue_items: overdue,
        open_rfis: counts.rfis?.open ?? null,
        open_submittals: counts.submittals?.open ?? null,
        open_punch: counts.punch_list?.open ?? null,
        financials: can(req.user, 'budget', 'read') ? financialSummary(db, p.id) : null,
      };
    });
    res.json({ projects, my_items: myOpenItems(req.user).slice(0, 50) });
  });

  r.get('/projects/:pid/activity', (req, res) => {
    const pid = assertProject(req, req.params.pid);
    res.json(recentActivity(pid, req.user, Math.min(Number(req.query.limit) || 100, 500)));
  });

  r.get('/projects/:pid/budget', (req, res) => {
    const pid = assertProject(req, req.params.pid);
    assertModule(req, 'budget', 'read');
    res.json({ ...budgetReport(db, pid), summary: financialSummary(db, pid) });
  });

  r.get('/projects/:pid/reports/:report', (req, res) => {
    const pid = assertProject(req, req.params.pid);
    const list = (m, opts = {}) => (can(req.user, m, 'read') ? records.list(m, { projectId: pid, limit: 1000, ...opts }).items : []);
    const days = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 864e5));
    const users = Object.fromEntries(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    switch (req.params.report) {
      case 'open-items': {
        const counts = moduleCounts(pid, req.user);
        return res.json({ title: 'Open Items by Tool', rows: Object.entries(counts).filter(([, c]) => c.total).map(([k, c]) => ({ tool: getModule(k).label, ...c })) });
      }
      case 'overdue-by-assignee': {
        const rows = {};
        for (const m of MODULES.filter((x) => x.dueField && x.assigneeFields.length)) {
          for (const rec of list(m.key, { overdue: true })) {
            const who = users[rec[m.assigneeFields[0]]] || 'Unassigned';
            rows[who] = rows[who] || { assignee: who, overdue: 0, tools: {} };
            rows[who].overdue++;
            rows[who].tools[m.label] = (rows[who].tools[m.label] || 0) + 1;
          }
        }
        return res.json({ title: 'Overdue Items by Assignee', rows: Object.values(rows).map((x) => ({ ...x, tools: Object.entries(x.tools).map(([k, v]) => `${k}: ${v}`).join(', ') })).sort((a, b) => b.overdue - a.overdue) });
      }
      case 'rfi-log': {
        const rfis = list('rfis');
        const answered = rfis.filter((x) => ['Answered', 'Closed'].includes(x.status));
        const avg = answered.length ? Math.round(answered.reduce((s, x) => s + days(x.created_at, x.updated_at), 0) / answered.length) : null;
        return res.json({
          title: 'RFI Log', summary: { total: rfis.length, open: rfis.filter((x) => x.status === 'Open').length, overdue: rfis.filter((x) => x.overdue).length, avg_days_to_answer: avg },
          rows: rfis.map((x) => ({ number: x.number, subject: x.subject, status: x.status, ball_in_court: users[x.ball_in_court] || '', due_date: x.due_date, days_open: days(x.created_at, ['Answered', 'Closed'].includes(x.status) ? x.updated_at : new Date().toISOString()), cost_impact: x.cost_impact || '', schedule_impact: x.schedule_impact || '' })),
        });
      }
      case 'submittal-log': {
        const subs = list('submittals');
        return res.json({
          title: 'Submittal Log', summary: { total: subs.length, approved: subs.filter((x) => x.status.startsWith('Approved')).length, overdue: subs.filter((x) => x.overdue).length },
          rows: subs.map((x) => ({ number: x.number, spec_section: x.spec_section, title: x.title, type: x.submittal_type, status: x.status, due_date: x.due_date, required_on_site: x.required_on_site, lead_time_days: x.lead_time_days })),
        });
      }
      case 'safety': {
        const inc = list('incidents');
        const obs = list('observations', { filters: { observation_type: 'Safety' } });
        const hours = list('timesheets').reduce((s, t) => s + (t.computed?.total_hours || 0), 0) + list('daily_logs').reduce((s, l) => s + (l.computed?.total_man_hours || 0), 0);
        const recordables = inc.filter((i) => i.osha_recordable).length;
        return res.json({
          title: 'Safety Summary',
          summary: { incidents: inc.length, recordables, near_misses: inc.filter((i) => i.incident_type === 'Near Miss').length, safety_observations: obs.length, hours_worked: hours, trir: hours ? Math.round(((recordables * 200000) / hours) * 100) / 100 : null },
          rows: inc.map((i) => ({ number: i.number, title: i.title, occurred_at: i.occurred_at, type: i.incident_type, severity: i.severity, recordable: i.osha_recordable ? 'Yes' : 'No', status: i.status })),
        });
      }
      case 'manpower': {
        const byCompany = {};
        for (const l of list('daily_logs')) {
          for (const m of l.manpower || []) {
            const k = m.company || 'Unspecified';
            byCompany[k] = byCompany[k] || { company: k, days: 0, workers: 0, man_hours: 0 };
            byCompany[k].days++;
            byCompany[k].workers += Number(m.workers) || 0;
            byCompany[k].man_hours += (Number(m.workers) || 0) * (Number(m.hours) || 0);
          }
        }
        return res.json({ title: 'Manpower by Company', rows: Object.values(byCompany).sort((a, b) => b.man_hours - a.man_hours) });
      }
      case 'commitments': {
        const companies = Object.fromEntries(db.prepare("SELECT id, json_extract(data, '$.name') AS name FROM records WHERE module = 'directory'").all().map((c) => [c.id, c.name]));
        return res.json({
          title: 'Commitments Summary',
          rows: list('commitments').map((c) => ({ number: c.number, title: c.title, vendor: companies[c.vendor] || '', type: c.commitment_type, status: c.status, original: c.computed.original_contract_value, approved_cos: c.computed.approved_change_orders, revised: c.computed.revised_contract_value, invoiced: c.computed.invoiced_to_date, remaining: c.computed.remaining_balance })),
        });
      }
      case 'change-orders': {
        return res.json({
          title: 'Change Order Log',
          rows: list('change_orders').map((c) => ({ number: c.number, title: c.title, contract: c.contract_kind, status: c.status, amount: c.computed.total, schedule_impact_days: c.schedule_impact_days || 0 })),
        });
      }
      default:
        throw httpError(404, 'Unknown report');
    }
  });

  // ─── Generic resources ───────────────────────────────────────────────
  function listHandler(scope) {
    return (req, res) => {
      const mod = assertModule(req, req.params.module, 'read');
      if (mod.scope !== scope) throw httpError(404, `${mod.label} is a ${mod.scope}-level tool`);
      const pid = scope === 'project' ? assertProject(req, req.params.pid) : null;
      const q = req.query;
      const filters = {};
      for (const [k, v] of Object.entries(q)) {
        const m = /^filter\[(\w+)\]$/.exec(k);
        if (m) filters[m[1]] = v;
      }
      const result = records.list(mod.key, {
        projectId: pid, q: q.q, status: q.status, open: q.open === 'true', overdue: q.overdue === 'true', assignee: q.assignee === 'me' ? req.user.id : q.assignee,
        sort: q.sort, dir: q.dir, limit: q.limit, offset: q.offset, filters, updatedSince: q.updated_since,
      });
      res.json(result);
    };
  }

  function exportHandler(scope) {
    return (req, res) => {
      const mod = assertModule(req, req.params.module, 'read');
      if (mod.scope !== scope) throw httpError(404, 'Wrong scope');
      const pid = scope === 'project' ? assertProject(req, req.params.pid) : null;
      const { items } = records.list(mod.key, { projectId: pid, limit: 1000, q: req.query.q, status: req.query.status });
      const users = Object.fromEntries(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
      const companies = Object.fromEntries(db.prepare("SELECT id, json_extract(data, '$.name') AS name FROM records WHERE module = 'directory'").all().map((c) => [c.id, c.name]));
      const cols = ['number', ...mod.fields.filter((f) => f.type !== 'lines').map((f) => f.key), 'created_at', 'updated_at'];
      const rows = items.map((rec) => Object.fromEntries(cols.map((c) => {
        const f = mod.fields.find((x) => x.key === c);
        let v = rec[c];
        if (f?.type === 'user') v = users[v] || '';
        if (f?.type === 'company') v = companies[v] || '';
        return [f?.label || c, v];
      })));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${mod.key}-${today()}.csv"`);
      res.send(toCSV(rows, cols.map((c) => mod.fields.find((x) => x.key === c)?.label || c)));
    };
  }

  function createHandler(scope) {
    return (req, res) => {
      assertWriteScope(req);
      const mod = assertModule(req, req.params.module, 'write');
      if (mod.scope !== scope) throw httpError(404, 'Wrong scope');
      const pid = scope === 'project' ? assertProject(req, req.params.pid) : null;
      res.status(201).json(records.create(mod.key, pid, req.body || {}, actor(req)));
    };
  }

  function recordInScope(req, scope) {
    const mod = getModule(req.params.module);
    const row = assertRecord(req, req.params.id, req.method === 'GET' ? 'read' : 'write');
    if (!mod || row.module !== mod.key) throw httpError(404, 'Record not found');
    if (scope === 'project' && row.project_id !== Number(req.params.pid)) throw httpError(404, 'Record not found');
    return row;
  }

  for (const [scope, base] of [['project', '/projects/:pid/modules/:module'], ['company', '/company/modules/:module']]) {
    r.get(base, listHandler(scope));
    r.post(base, createHandler(scope));
    r.get(`${base}/export.csv`, exportHandler(scope));
    r.get(`${base}/:id`, (req, res) => { const row = recordInScope(req, scope); res.json(records.get(row.id)); });
    r.patch(`${base}/:id`, (req, res) => { assertWriteScope(req); const row = recordInScope(req, scope); res.json(records.update(row.id, req.body || {}, actor(req))); });
    r.put(`${base}/:id`, (req, res) => { assertWriteScope(req); const row = recordInScope(req, scope); res.json(records.update(row.id, req.body || {}, actor(req))); });
    r.delete(`${base}/:id`, (req, res) => {
      assertWriteScope(req);
      const row = recordInScope(req, scope);
      records.remove(row.id, actor(req));
      res.status(204).end();
    });
  }

  // ─── Record sub-resources: comments, files, activity ─────────────────
  r.get('/records/:id', (req, res) => { const row = assertRecord(req, req.params.id); res.json(records.get(row.id)); });

  r.get('/records/:id/comments', (req, res) => {
    const row = assertRecord(req, req.params.id);
    res.json(db.prepare('SELECT c.id, c.body, c.created_at, c.user_id, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.record_id = ? ORDER BY c.id').all(row.id));
  });

  r.post('/records/:id/comments', (req, res) => {
    assertWriteScope(req);
    const row = assertRecord(req, req.params.id, 'read');
    const body = String(req.body?.body || '').trim();
    if (!body) throw Object.assign(httpError(422, 'Validation failed'), { errors: { body: 'is required' } });
    const info = db.prepare('INSERT INTO comments (record_id, user_id, body) VALUES (?, ?, ?)').run(row.id, req.user.id, body.slice(0, 10000));
    records.audit(actor(req), 'commented', { id: row.id, module: row.module, project_id: row.project_id }, null, `Commented on ${row.number}`);
    // Notify @mentioned users by email handle or name.
    for (const u of db.prepare('SELECT id, name, email FROM users WHERE active = 1').all()) {
      const handle = u.email.split('@')[0];
      if (u.id !== req.user.id && (body.includes(`@${handle}`) || body.includes(`@${u.name}`))) {
        db.prepare('INSERT INTO notifications (user_id, title, link) VALUES (?, ?, ?)')
          .run(u.id, `${req.user.name} mentioned you on ${row.number}`, row.project_id ? `#/p/${row.project_id}/m/${row.module}/${row.id}` : `#/m/${row.module}/${row.id}`);
      }
    }
    res.status(201).json(db.prepare('SELECT c.id, c.body, c.created_at, c.user_id, u.name AS author FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(Number(info.lastInsertRowid)));
  });

  r.get('/records/:id/activity', (req, res) => {
    const row = assertRecord(req, req.params.id);
    res.json(db.prepare('SELECT id, ts, actor, action, summary, changes FROM audit_log WHERE record_id = ? ORDER BY id DESC').all(row.id)
      .map((a) => ({ ...a, changes: parseJSON(a.changes, null) })));
  });

  r.get('/records/:id/links', (req, res) => {
    const row = assertRecord(req, req.params.id);
    res.json(db.prepare('SELECT l.remote_entity, l.remote_id, l.updated_at, c.id AS connection_id, c.name AS connection FROM external_links l JOIN connections c ON c.id = l.connection_id WHERE l.record_id = ?').all(row.id));
  });

  r.get('/records/:id/files', (req, res) => {
    const row = assertRecord(req, req.params.id);
    res.json(db.prepare('SELECT f.id, f.name, f.mime, f.size, f.created_at, u.name AS uploaded_by FROM files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.record_id = ? ORDER BY f.id').all(row.id));
  });

  r.post('/records/:id/files', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
    assertWriteScope(req);
    const row = assertRecord(req, req.params.id, 'read');
    const name = path.basename(decodeURIComponent(req.get('x-filename') || 'upload.bin')).slice(0, 200);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(422, 'Empty upload');
    const key = `${crypto.randomUUID()}${path.extname(name).slice(0, 10)}`;
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, key), req.body);
    const info = db.prepare('INSERT INTO files (record_id, project_id, name, mime, size, storage_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.project_id, name, req.get('content-type') || 'application/octet-stream', req.body.length, key, req.user.id);
    records.audit(actor(req), 'attached', { id: row.id, module: row.module, project_id: row.project_id }, null, `Attached ${name}`);
    res.status(201).json(db.prepare('SELECT id, name, mime, size, created_at FROM files WHERE id = ?').get(Number(info.lastInsertRowid)));
  });

  r.get('/files/:fid', (req, res) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.fid));
    if (!file) throw httpError(404, 'File not found');
    assertRecord(req, file.record_id);
    const safe = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/.test(file.mime || '');
    res.set('Content-Type', safe ? file.mime : 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `${safe && req.query.inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.name)}"`);
    res.sendFile(path.join(uploadsDir, file.storage_path));
  });

  r.delete('/files/:fid', (req, res) => {
    assertWriteScope(req);
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.fid));
    if (!file) throw httpError(404, 'File not found');
    assertRecord(req, file.record_id, 'write');
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    fs.rm(path.join(uploadsDir, file.storage_path), { force: true }, () => {});
    res.status(204).end();
  });

  // ─── Search & notifications ──────────────────────────────────────────
  r.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const projectIds = projectsFor(req.user).map((p) => p.id);
    const allowed = MODULES.filter((m) => can(req.user, m.key, 'read')).map((m) => m.key);
    if (!allowed.length) return res.json([]);
    const rows = db.prepare(`SELECT * FROM records WHERE deleted_at IS NULL AND module IN (${allowed.map(() => '?').join(',')})
      AND (project_id IS NULL OR project_id IN (${projectIds.map(() => '?').join(',') || 'NULL'}))
      AND (number LIKE ? OR data LIKE ?) ORDER BY updated_at DESC LIMIT 30`).all(...allowed, ...projectIds, `%${q}%`, `%${q}%`);
    const projects = Object.fromEntries(projectsFor(req.user).map((p) => [p.id, p.name]));
    res.json(rows.map((row) => {
      const rec = records.hydrate(row, { withComputed: false });
      return { id: rec.id, module: rec.module, module_label: getModule(rec.module).singular, project_id: rec.project_id, project: projects[rec.project_id] || null, number: rec.number, title: rec.title, status: rec.status };
    }));
  });

  r.get('/notifications', (req, res) => {
    res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id));
  });

  r.post('/notifications/read', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    if (ids) db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`).run(req.user.id, ...ids);
    else db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    res.status(204).end();
  });

  r.get('/my-items', (req, res) => res.json(myOpenItems(req.user)));

  return r;
}

module.exports = { coreRoutes, httpError };
