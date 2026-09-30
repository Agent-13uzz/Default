'use strict';
const { getModule } = require('./modules');
const { parseJSON } = require('./db');
const { computeRecord } = require('./financials');

class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.status = 422;
    this.errors = errors;
  }
}

class NotFoundError extends Error {
  constructor(msg = 'Not found') {
    super(msg);
    this.status = 404;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
/** Symbol set on the record returned by update() when nothing actually changed. */
const UNCHANGED = Symbol('unchanged');

/**
 * Generic record service used by the REST API, the web client and the
 * integration sync engine. All writes go through here so validation, audit,
 * notifications and events are applied consistently no matter the source.
 */
function createRecordService({ db, events }) {
  // ─── Coercion / validation ────────────────────────────────────────────
  function coerceValue(field, value, ctx, errors, pathLabel) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return field.type === 'boolean' ? false : field.type === 'lines' ? [] : null;
    const fail = (msg) => { errors[pathLabel] = msg; return undefined; };
    switch (field.type) {
      case 'text':
      case 'textarea': {
        const s = String(value);
        return s.length > 20000 ? fail('is too long') : s.trim();
      }
      case 'number':
      case 'currency':
      case 'percent': {
        const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,%\s]/g, ''));
        if (!Number.isFinite(n)) return fail('must be a number');
        return field.type === 'currency' ? Math.round(n * 100) / 100 : n;
      }
      case 'date': {
        const s = String(value).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) return fail('must be a date (YYYY-MM-DD)');
        return s;
      }
      case 'datetime': {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return fail('must be a date/time');
        return String(value).length <= 16 ? String(value) : d.toISOString().slice(0, 16);
      }
      case 'boolean':
        return value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
      case 'select': {
        const s = String(value);
        const match = field.options.find((o) => o === s) || field.options.find((o) => o.toLowerCase() === s.toLowerCase());
        return match || fail(`must be one of: ${field.options.join(', ')}`);
      }
      case 'multiselect': {
        const arr = Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim());
        const bad = arr.filter((v) => !field.options.includes(v));
        return bad.length ? fail(`invalid options: ${bad.join(', ')}`) : arr;
      }
      case 'user': {
        const id = Number(value);
        if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return fail('must reference an existing user');
        return id;
      }
      case 'company': {
        const id = Number(value);
        if (!Number.isInteger(id) || !db.prepare("SELECT 1 FROM records WHERE id = ? AND module = 'directory' AND deleted_at IS NULL").get(id)) {
          return fail('must reference a company in the directory');
        }
        return id;
      }
      case 'ref': {
        const id = Number(value);
        const row = Number.isInteger(id) && db.prepare('SELECT project_id FROM records WHERE id = ? AND module = ? AND deleted_at IS NULL').get(id, field.module);
        if (!row) return fail(`must reference an existing ${getModule(field.module)?.singular || field.module}`);
        if (ctx.projectId && row.project_id !== ctx.projectId) return fail('must reference an item in the same project');
        return id;
      }
      case 'lines': {
        if (!Array.isArray(value)) return fail('must be a list');
        if (value.length > 500) return fail('has too many rows (max 500)');
        const rows = [];
        value.forEach((row, i) => {
          if (!row || typeof row !== 'object') return;
          const clean = {};
          for (const sub of field.fields) {
            const v = coerceValue(sub, row[sub.key], ctx, errors, `${pathLabel}[${i}].${sub.key}`);
            if (v !== undefined && v !== null && v !== '') clean[sub.key] = v;
          }
          // Quantity × unit cost convenience for estimate-style lines.
          if (clean.amount == null && clean.quantity != null && clean.unit_cost != null) {
            clean.amount = Math.round(clean.quantity * clean.unit_cost * 100) / 100;
          }
          if (Object.keys(clean).length) rows.push(clean);
        });
        return rows;
      }
      default:
        return fail(`unsupported field type ${field.type}`);
    }
  }

  function validate(mod, input, { partial = false, projectId = null } = {}) {
    const errors = {};
    const out = {};
    for (const field of mod.fields) {
      let value = input[field.key];
      if (value === undefined && !partial && field.default !== undefined) value = field.default;
      const v = coerceValue(field, value, { projectId }, errors, field.key);
      if (v !== undefined) out[field.key] = v;
      const missing = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      const visible = !field.showIf || (input[field.showIf.field] ?? null) === field.showIf.equals;
      if (field.required && visible && missing && (!partial || value !== undefined) && !errors[field.key]) {
        errors[field.key] = 'is required';
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);
    return out;
  }

  // ─── Serialisation ───────────────────────────────────────────────────
  function hydrate(row, { withComputed = true } = {}) {
    if (!row) return null;
    const mod = getModule(row.module);
    const data = parseJSON(row.data, {});
    const record = {
      id: row.id,
      module: row.module,
      project_id: row.project_id,
      number: row.number,
      ...data,
      status: row.status,
      title: mod ? String(data[mod.titleField] ?? row.number) : row.number,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (mod?.dueField && record[mod.dueField] && !mod.closedStatuses.includes(record.status)) {
      record.overdue = String(record[mod.dueField]).slice(0, 10) < today();
    }
    if (withComputed) record.computed = computeRecord(db, mod, record);
    return record;
  }

  // ─── Queries ─────────────────────────────────────────────────────────
  function list(moduleKey, opts = {}) {
    const mod = getModule(moduleKey);
    if (!mod) throw new NotFoundError(`Unknown module ${moduleKey}`);
    const where = ['module = ?', 'deleted_at IS NULL'];
    const params = [moduleKey];
    if (mod.scope === 'project') {
      where.push('project_id = ?');
      params.push(opts.projectId);
    }
    if (opts.status) {
      const statuses = String(opts.status).split(',');
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (opts.open) {
      if (mod.closedStatuses.length) {
        where.push(`status NOT IN (${mod.closedStatuses.map(() => '?').join(',')})`);
        params.push(...mod.closedStatuses);
      }
    }
    if (opts.overdue && mod.dueField) {
      where.push(`json_extract(data, '$.${mod.dueField}') < ?`);
      params.push(today());
      if (mod.closedStatuses.length) {
        where.push(`status NOT IN (${mod.closedStatuses.map(() => '?').join(',')})`);
        params.push(...mod.closedStatuses);
      }
    }
    if (opts.assignee && mod.assigneeFields.length) {
      where.push('(' + mod.assigneeFields.map((f) => `json_extract(data, '$.${f}') = ?`).join(' OR ') + ')');
      mod.assigneeFields.forEach(() => params.push(Number(opts.assignee)));
    }
    if (opts.updatedSince) {
      where.push('updated_at >= ?');
      params.push(String(opts.updatedSince).replace('T', ' ').slice(0, 19));
    }
    for (const [key, value] of Object.entries(opts.filters || {})) {
      const field = mod.fields.find((f) => f.key === key && f.key !== 'status');
      if (!field) continue;
      where.push(`json_extract(data, '$.${key}') = ?`);
      params.push(['user', 'company', 'ref', 'number', 'currency', 'percent'].includes(field.type) ? Number(value) : field.type === 'boolean' ? (value === 'true' ? 1 : 0) : value);
    }
    if (opts.q) {
      where.push('(number LIKE ? OR data LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    let order = 'seq DESC';
    const dir = String(opts.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    if (opts.sort === 'number') order = `seq ${dir}`;
    else if (['created_at', 'updated_at', 'status'].includes(opts.sort)) order = `${opts.sort} ${dir}, seq ${dir}`;
    else if (opts.sort && mod.fields.find((f) => f.key === opts.sort)) order = `json_extract(data, '$.${opts.sort}') ${dir}, seq ${dir}`;
    else if (moduleKey === 'schedule') order = "json_extract(data, '$.start_date') ASC, seq ASC";
    else if (moduleKey === 'budget') order = "json_extract(data, '$.cost_code') ASC";

    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where.join(' AND ')}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items: rows.map((r) => hydrate(r, { withComputed: opts.withComputed !== false })), total, limit, offset };
  }

  function getRow(id) {
    return db.prepare('SELECT * FROM records WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  }

  function get(id) {
    return hydrate(getRow(id));
  }

  // ─── Mutations ───────────────────────────────────────────────────────
  function audit(actor, action, rec, changes, summary) {
    db.prepare('INSERT INTO audit_log (user_id, actor, action, module, record_id, project_id, summary, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(actor?.user_id ?? null, actor?.name ?? 'system', action, rec.module, rec.id, rec.project_id ?? null, summary || null, changes ? JSON.stringify(changes) : null);
  }

  function notifyAssignees(mod, record, previous, actor) {
    for (const f of mod.assigneeFields) {
      const uid = record[f];
      if (!uid || uid === actor?.user_id || (previous && previous[f] === uid)) continue;
      const label = mod.fields.find((x) => x.key === f)?.label || f;
      const link = record.project_id ? `#/p/${record.project_id}/m/${mod.key}/${record.id}` : `#/m/${mod.key}/${record.id}`;
      db.prepare('INSERT INTO notifications (user_id, title, link) VALUES (?, ?, ?)')
        .run(uid, `You are ${label} on ${mod.singular} ${record.number}: ${record.title}`, link);
    }
  }

  function create(moduleKey, projectId, input, actor) {
    const mod = getModule(moduleKey);
    if (!mod) throw new NotFoundError(`Unknown module ${moduleKey}`);
    const pid = mod.scope === 'project' ? Number(projectId) : null;
    if (mod.scope === 'project' && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid)) throw new NotFoundError('Project not found');
    const clean = validate(mod, input || {}, { projectId: pid });
    const status = clean.status || mod.defaultStatus;
    delete clean.status;

    const record = db.transaction(() => {
      const seq = (db.prepare('SELECT MAX(seq) AS s FROM records WHERE module = ? AND project_id IS ?').get(moduleKey, pid).s || 0) + 1;
      const number = `${mod.prefix}-${String(seq).padStart(3, '0')}`;
      const info = db.prepare('INSERT INTO records (module, project_id, seq, number, status, data, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(moduleKey, pid, seq, number, status, JSON.stringify(clean), actor?.user_id ?? null);
      const rec = get(Number(info.lastInsertRowid));
      audit(actor, 'created', rec, null, `Created ${mod.singular} ${rec.number}`);
      notifyAssignees(mod, rec, null, actor);
      return rec;
    });
    events?.publish(`${moduleKey}.created`, { module: moduleKey, project_id: pid, record, actor: actorInfo(actor) });
    return record;
  }

  function update(id, input, actor) {
    const row = getRow(id);
    if (!row) throw new NotFoundError('Record not found');
    const mod = getModule(row.module);
    const previous = hydrate(row, { withComputed: false });
    const merged = { ...parseJSON(row.data, {}), status: row.status, ...input };
    const clean = validate(mod, merged, { projectId: row.project_id });
    const status = clean.status || row.status;
    delete clean.status;

    const changes = {};
    for (const f of mod.fields) {
      const before = f.key === 'status' ? row.status : previous[f.key];
      const after = f.key === 'status' ? status : clean[f.key];
      if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) changes[f.key] = { from: before ?? null, to: after ?? null };
    }
    if (!Object.keys(changes).length) return Object.assign(get(id), { [UNCHANGED]: true });

    const record = db.transaction(() => {
      db.prepare("UPDATE records SET data = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(clean), status, row.id);
      const rec = get(row.id);
      const summary = changes.status ? `Status changed from ${changes.status.from} to ${changes.status.to}` : `Updated ${Object.keys(changes).map((k) => mod.fields.find((f) => f.key === k)?.label || k).join(', ')}`;
      audit(actor, 'updated', rec, changes, summary);
      notifyAssignees(mod, rec, previous, actor);
      return rec;
    });
    const payload = { module: row.module, project_id: row.project_id, record, previous, changes, actor: actorInfo(actor) };
    events?.publish(`${row.module}.updated`, payload);
    if (changes.status) events?.publish(`${row.module}.status_changed`, payload);
    return record;
  }

  function remove(id, actor) {
    const row = getRow(id);
    if (!row) throw new NotFoundError('Record not found');
    const record = hydrate(row, { withComputed: false });
    db.prepare("UPDATE records SET deleted_at = datetime('now') WHERE id = ?").run(row.id);
    audit(actor, 'deleted', record, null, `Deleted ${getModule(row.module)?.singular || row.module} ${row.number}`);
    events?.publish(`${row.module}.deleted`, { module: row.module, project_id: row.project_id, record, actor: actorInfo(actor) });
    return record;
  }

  function actorInfo(actor) {
    return actor ? { user_id: actor.user_id ?? null, name: actor.name, source: actor.source || 'web' } : null;
  }

  return { list, get, getRow, create, update, remove, validate, hydrate, audit };
}

module.exports = { createRecordService, ValidationError, NotFoundError, UNCHANGED };
