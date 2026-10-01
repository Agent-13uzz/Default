'use strict';
const crypto = require('node:crypto');
const { parseJSON } = require('../db');
const { getModule } = require('../modules');
const { getAdapter } = require('./adapters');
const { getPath, setPath, stableHash, hmac, safeEqual } = require('./util');
const { UNCHANGED } = require('../records');

const MASK = '••••••';

/**
 * Integration engine: connection management, field mapping, bidirectional
 * sync jobs, realtime push on record events, notifier adapters, scheduled
 * syncs, inbound webhooks and sandbox (simulated remote) mode.
 */
const PUSH_PAGE = 500;

function createIntegrationEngine({ db, records, events, log = () => {} }) {
  const running = new Set();
  const locks = new Map();

  /**
   * Serialise everything that reads-then-writes a connection's state or its
   * external links (syncs, realtime pushes, inbound webhooks, notifier
   * counters, sandbox edits). Each holder re-reads the connection inside the
   * lock, so concurrent work can neither clobber saved state nor race to
   * create the same remote record twice.
   */
  function withLock(connectionId, fn) {
    const prev = locks.get(connectionId) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    locks.set(connectionId, tail);
    tail.then(() => { if (locks.get(connectionId) === tail) locks.delete(connectionId); });
    return next;
  }
  let timer = null;

  // ─── Connections ─────────────────────────────────────────────────────
  function rowToConnection(row, { reveal = false } = {}) {
    if (!row) return null;
    const adapter = getAdapter(row.adapter);
    const config = parseJSON(row.config, {});
    if (!reveal && adapter) {
      for (const f of adapter.configSchema) {
        if (f.secret && config[f.key]) config[f.key] = MASK + String(config[f.key]).slice(-4);
      }
    }
    return {
      id: row.id,
      adapter: row.adapter,
      adapter_name: adapter?.name || row.adapter,
      name: row.name,
      project_id: row.project_id,
      config,
      mappings: parseJSON(row.mappings, []),
      enabled: !!row.enabled,
      realtime: !!row.realtime,
      schedule_minutes: row.schedule_minutes,
      inbound_secret: reveal ? row.inbound_secret : undefined,
      sandbox: !!(adapter && config.sandbox && adapter.configSchema.some((f) => f.key === 'sandbox')),
      state: reveal ? parseJSON(row.state, {}) : summarizeState(parseJSON(row.state, {})),
      last_sync_at: row.last_sync_at,
      created_at: row.created_at,
    };
  }

  function summarizeState(state) {
    return {
      last_error: state.last_error || null,
      last_event_at: state.last_event_at || null,
      events_sent: state.events_sent || 0,
      exports: state.exports ? Object.fromEntries(Object.entries(state.exports).map(([k, v]) => [k, v.length])) : undefined,
    };
  }

  function defaultMappings(adapter) {
    return (adapter.entities || []).filter((e) => e.module).map((e) => ({
      entity: e.key,
      module: e.module,
      direction: e.directions.length > 1 ? 'both' : e.directions[0],
      fields: e.fields || [],
      filter: e.filter || null,
      createMissing: e.createMissing !== false,
    }));
  }

  function cleanConfig(adapter, input, previous = {}) {
    const out = {};
    const errors = {};
    for (const f of adapter.configSchema) {
      let v = input?.[f.key];
      if (typeof v === 'string' && v.startsWith(MASK)) v = previous[f.key];
      if (v === undefined) v = previous[f.key] !== undefined ? previous[f.key] : f.default;
      if (f.type === 'boolean') v = v === true || v === 'true' || v === 1;
      if (f.type === 'json' && typeof v === 'string') {
        try { v = JSON.parse(v); } catch { errors[f.key] = 'must be valid JSON'; }
      }
      if (f.type === 'select' && v != null && !f.options.includes(v)) errors[f.key] = `must be one of ${f.options.join(', ')}`;
      if (v !== undefined && v !== null && v !== '') out[f.key] = v;
    }
    const sandbox = out.sandbox === true;
    for (const f of adapter.configSchema) {
      if (f.required && !sandbox && (out[f.key] == null || out[f.key] === '')) errors[f.key] = 'is required';
    }
    if (Object.keys(errors).length) {
      const err = new Error('Invalid connection configuration');
      err.status = 422;
      err.errors = errors;
      throw err;
    }
    return out;
  }

  function cleanMappings(adapter, mappings) {
    if (!Array.isArray(mappings)) throw Object.assign(new Error('mappings must be an array'), { status: 422 });
    return mappings.map((m, i) => {
      const mod = getModule(m.module);
      if (!mod) throw Object.assign(new Error(`mappings[${i}]: unknown module "${m.module}"`), { status: 422 });
      const def = (adapter.entities || []).find((e) => e.key === m.entity);
      if (!def && !adapter.freeformEntities) throw Object.assign(new Error(`mappings[${i}]: ${adapter.name} has no entity "${m.entity}"`), { status: 422 });
      let direction = ['pull', 'push', 'both'].includes(m.direction) ? m.direction : 'both';
      if (def && direction === 'both' && def.directions.length === 1) direction = def.directions[0];
      if (def && direction !== 'both' && !def.directions.includes(direction)) {
        throw Object.assign(new Error(`mappings[${i}]: ${m.entity} does not support ${direction}`), { status: 422 });
      }
      const fields = (m.fields || []).filter((f) => f && f.local && f.remote).map((f) => ({
        local: String(f.local), remote: String(f.remote),
        ...(f.transform ? { transform: String(f.transform) } : {}),
        ...(f.map && typeof f.map === 'object' ? { map: f.map } : {}),
        ...(f.direction ? { direction: f.direction } : {}),
      }));
      const localKeys = new Set(['number', 'id', ...mod.fields.map((x) => x.key)]);
      const bad = fields.filter((f) => !localKeys.has(f.local));
      if (bad.length) throw Object.assign(new Error(`mappings[${i}]: unknown ${mod.label} field(s) ${bad.map((b) => b.local).join(', ')}`), { status: 422 });
      const matchOn = m.matchOn && mod.fields.some((x) => x.key === m.matchOn) ? m.matchOn : undefined;
      return { entity: String(m.entity), module: mod.key, direction, fields, filter: m.filter || null, createMissing: m.createMissing !== false, ...(matchOn ? { matchOn } : {}) };
    });
  }

  function createConnection(input) {
    const adapter = getAdapter(input.adapter);
    if (!adapter) throw Object.assign(new Error(`Unknown adapter "${input.adapter}"`), { status: 422 });
    const config = cleanConfig(adapter, input.config || {});
    const mappings = input.mappings ? cleanMappings(adapter, input.mappings) : defaultMappings(adapter);
    const info = db.prepare(`INSERT INTO connections (adapter, name, project_id, config, mappings, enabled, realtime, schedule_minutes, inbound_secret)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      adapter.key, input.name || adapter.name, input.project_id || null, JSON.stringify(config), JSON.stringify(mappings),
      input.enabled === false ? 0 : 1, input.realtime ? 1 : 0, Math.max(0, parseInt(input.schedule_minutes, 10) || 0),
      crypto.randomBytes(24).toString('hex'),
    );
    return getConnection(Number(info.lastInsertRowid));
  }

  function updateConnection(id, input) {
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error('Connection not found'), { status: 404 });
    const adapter = getAdapter(row.adapter);
    const config = input.config ? cleanConfig(adapter, input.config, parseJSON(row.config, {})) : parseJSON(row.config, {});
    const mappings = input.mappings ? cleanMappings(adapter, input.mappings) : parseJSON(row.mappings, []);
    db.prepare(`UPDATE connections SET name = ?, project_id = ?, config = ?, mappings = ?, enabled = ?, realtime = ?, schedule_minutes = ? WHERE id = ?`).run(
      input.name ?? row.name,
      input.project_id !== undefined ? input.project_id || null : row.project_id,
      JSON.stringify(config), JSON.stringify(mappings),
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : row.enabled,
      input.realtime !== undefined ? (input.realtime ? 1 : 0) : row.realtime,
      input.schedule_minutes !== undefined ? Math.max(0, parseInt(input.schedule_minutes, 10) || 0) : row.schedule_minutes,
      id,
    );
    return getConnection(id);
  }

  function getConnection(id, opts) {
    return rowToConnection(db.prepare('SELECT * FROM connections WHERE id = ?').get(id), opts);
  }

  function listConnections() {
    return db.prepare('SELECT * FROM connections ORDER BY id').all().map((r) => rowToConnection(r));
  }

  function deleteConnection(id) {
    db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  }

  function rotateInboundSecret(id) {
    const secret = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE connections SET inbound_secret = ? WHERE id = ?').run(secret, id);
    return secret;
  }

  function saveState(id, state) {
    db.prepare('UPDATE connections SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
  }

  // ─── Context & sandbox ───────────────────────────────────────────────
  function makeContext(conn, logFn) {
    return { connection: conn, config: conn.config, state: conn.state, log: logFn };
  }

  function sandboxStore(conn, adapter, entity) {
    const sb = (conn.state.sandbox = conn.state.sandbox || {});
    if (!sb[entity]) {
      sb[entity] = (adapter.sandboxSeed?.[entity] || []).map((d) => ({
        remoteId: String(d.Id ?? d.id ?? d.ObjectId ?? d.key ?? d.UID ?? d.envelopeId ?? crypto.randomUUID()),
        data: structuredClone(d),
      }));
    }
    return sb[entity];
  }

  const isSandbox = (conn) => conn.sandbox;

  async function remotePull(conn, adapter, ctx, entity, opts) {
    if (isSandbox(conn)) return structuredClone(sandboxStore(conn, adapter, entity));
    if (typeof adapter.pull !== 'function') throw new Error(`${adapter.name} does not support pulling data`);
    return adapter.pull(ctx, entity, opts);
  }

  async function remotePush(conn, adapter, ctx, entity, payload, remoteId) {
    if (isSandbox(conn)) {
      const store = sandboxStore(conn, adapter, entity);
      if (remoteId) {
        const item = store.find((s) => s.remoteId === remoteId);
        if (item) { item.data = { ...item.data, ...payload }; return { remoteId }; }
      }
      const id = `sbx-${entity.replace(/\W+/g, '').toLowerCase()}-${store.length + 1}-${crypto.randomBytes(2).toString('hex')}`;
      store.push({ remoteId: id, data: { id, ...payload, status: payload.status ?? (adapter.key === 'docusign' ? 'sent' : undefined) } });
      return { remoteId: id };
    }
    if (typeof adapter.push !== 'function') throw new Error(`${adapter.name} does not support pushing data`);
    return adapter.push(ctx, entity, payload, remoteId);
  }

  // ─── Field mapping ───────────────────────────────────────────────────
  const BUILTIN_TRANSFORMS = {
    string: { pull: (v) => (v == null ? v : String(v)), push: (v) => (v == null ? v : String(v)) },
    number: { pull: (v) => (v == null || v === '' ? null : Number(v)), push: (v) => (v == null ? v : Number(v)) },
    date: { pull: (v) => (v ? String(v).slice(0, 10) : null), push: (v) => v },
    bool: { pull: (v) => v === true || v === 1 || ['1', 'true', 'yes'].includes(String(v).toLowerCase()), push: (v) => !!v },
    percent_fraction: { pull: (v) => (v == null ? null : Math.round(Number(v) * 10000) / 100), push: (v) => (v == null ? null : Number(v) / 100) },
    company_name: {
      pull: (v) => {
        if (!v) return null;
        const row = db.prepare("SELECT id FROM records WHERE module = 'directory' AND deleted_at IS NULL AND lower(json_extract(data, '$.name')) = lower(?)").get(String(v));
        return row ? row.id : undefined;
      },
      push: (v) => (v ? parseJSON(db.prepare('SELECT data FROM records WHERE id = ?').get(v)?.data, {}).name : null),
    },
    company_email: {
      pull: () => undefined,
      push: (v) => (v ? parseJSON(db.prepare('SELECT data FROM records WHERE id = ?').get(v)?.data, {}).email : null),
    },
    user_email: {
      pull: (v) => (v ? db.prepare('SELECT id FROM users WHERE email = ?').get(String(v))?.id : null),
      push: (v) => (v ? db.prepare('SELECT email FROM users WHERE id = ?').get(v)?.email : null),
    },
  };

  function transform(adapter, name, dir, value) {
    if (!name) return value;
    const t = adapter.transforms?.[name] || BUILTIN_TRANSFORMS[name];
    return t?.[dir] ? t[dir](value) : value;
  }

  function toLocal(adapter, mapping, remote) {
    const out = {};
    for (const f of mapping.fields) {
      if (f.direction === 'push' || f.local === 'number' || f.local === 'id') continue;
      let v = getPath(remote, f.remote);
      if (v === undefined) continue;
      if (f.map) {
        const key = String(v);
        const found = Object.entries(f.map).find(([r]) => r === key || r.toLowerCase() === key.toLowerCase());
        if (found) v = found[1];
      }
      v = transform(adapter, f.transform, 'pull', v);
      if (v !== undefined) out[f.local] = v;
    }
    return out;
  }

  function toRemote(adapter, mapping, record) {
    const out = {};
    for (const f of mapping.fields) {
      if (f.direction === 'pull') continue;
      let v = record[f.local];
      v = transform(adapter, f.transform, 'push', v);
      if (f.map) {
        const found = Object.entries(f.map).find(([, l]) => l === v);
        if (found) v = found[0] === 'true' ? true : found[0] === 'false' ? false : found[0];
      }
      if (v !== undefined && v !== null) setPath(out, f.remote, v);
    }
    return out;
  }

  // ─── Sync jobs ───────────────────────────────────────────────────────
  function startJob(connId, trigger, direction) {
    const info = db.prepare("INSERT INTO sync_jobs (connection_id, trigger, direction, status) VALUES (?, ?, ?, 'running')").run(connId, trigger, direction);
    return Number(info.lastInsertRowid);
  }

  function finishJob(jobId, status, stats, lines) {
    db.prepare("UPDATE sync_jobs SET status = ?, stats = ?, log = ?, finished_at = datetime('now') WHERE id = ?")
      .run(status, JSON.stringify(stats), JSON.stringify(lines.slice(-500)), jobId);
    return getJob(jobId);
  }

  function getJob(id) {
    const r = db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(id);
    return r && { ...r, stats: parseJSON(r.stats, {}), log: parseJSON(r.log, []) };
  }

  function listJobs(connectionId, limit = 25) {
    return db.prepare('SELECT * FROM sync_jobs WHERE connection_id = ? ORDER BY id DESC LIMIT ?').all(connectionId, limit)
      .map((r) => ({ ...r, stats: parseJSON(r.stats, {}), log: undefined }));
  }

  function linkFor(connId, recordId, entity) {
    return db.prepare('SELECT * FROM external_links WHERE connection_id = ? AND record_id = ? AND remote_entity = ?').get(connId, recordId, entity);
  }

  function linkByRemote(connId, entity, remoteId) {
    return db.prepare(`SELECT l.* FROM external_links l JOIN records r ON r.id = l.record_id
      WHERE l.connection_id = ? AND l.remote_entity = ? AND l.remote_id = ? AND r.deleted_at IS NULL`).get(connId, entity, String(remoteId));
  }

  function saveLink(connId, recordId, entity, remoteId, hash) {
    db.prepare(`INSERT INTO external_links (connection_id, record_id, remote_entity, remote_id, hash, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (connection_id, record_id, remote_entity) DO UPDATE SET remote_id = excluded.remote_id, hash = excluded.hash, updated_at = excluded.updated_at`)
      .run(connId, recordId, entity, String(remoteId), hash);
  }

  const actorFor = (conn) => ({ user_id: null, name: `Integration: ${conn.name}`, source: 'integration', connection_id: conn.id });

  function projectIdsFor(conn, mod) {
    if (mod.scope !== 'project') return [null];
    if (conn.project_id) return [conn.project_id];
    return db.prepare('SELECT id FROM projects WHERE active = 1').all().map((r) => r.id);
  }

  function upsertFromRemote(conn, adapter, mapping, item, stats, logLine) {
    const mod = getModule(mapping.module);
    const data = toLocal(adapter, mapping, item.data);
    const link = linkByRemote(conn.id, mapping.entity, item.remoteId);
    const actor = actorFor(conn);
    if (link) {
      const rec = records.update(link.record_id, data, actor);
      saveLink(conn.id, rec.id, mapping.entity, item.remoteId, stableHash(toRemote(adapter, mapping, rec)));
      if (rec[UNCHANGED]) stats.skipped++; else stats.updated++;
      return rec;
    }
    // No link yet: try to match an existing record on a natural key (e.g. company name) before creating.
    const matchOn = mapping.matchOn || (mod.scope === 'company' ? mod.titleField : null);
    if (matchOn && data[matchOn] != null && data[matchOn] !== '') {
      const existing = db.prepare(`SELECT id FROM records WHERE module = ? AND deleted_at IS NULL AND project_id IS ?
        AND lower(json_extract(data, '$.${matchOn}')) = lower(?)`).get(mod.key, mod.scope === 'project' ? conn.project_id : null, String(data[matchOn]));
      if (existing) {
        const rec = records.update(existing.id, data, actor);
        saveLink(conn.id, rec.id, mapping.entity, item.remoteId, stableHash(toRemote(adapter, mapping, rec)));
        stats.updated++;
        logLine('info', `Linked ${mapping.entity} ${item.remoteId} to existing ${mod.singular} ${rec.number} by ${matchOn}`);
        return rec;
      }
    }
    if (!mapping.createMissing) { stats.skipped++; return null; }
    if (mod.scope === 'project' && !conn.project_id) throw new Error(`Connection must be scoped to a project to import ${mod.label}`);
    const rec = records.create(mod.key, conn.project_id, data, actor);
    saveLink(conn.id, rec.id, mapping.entity, item.remoteId, stableHash(toRemote(adapter, mapping, rec)));
    stats.created++;
    logLine('info', `Created ${mod.singular} ${rec.number} from ${mapping.entity} ${item.remoteId}`);
    return rec;
  }

  async function pushRecord(conn, adapter, ctx, mapping, rec, stats, logLine) {
    const payload = toRemote(adapter, mapping, rec);
    const hash = stableHash(payload);
    const link = linkFor(conn.id, rec.id, mapping.entity);
    if (link && link.hash === hash) { stats.skipped++; return; }
    const { remoteId } = await remotePush(conn, adapter, ctx, mapping.entity, payload, link?.remote_id);
    saveLink(conn.id, rec.id, mapping.entity, remoteId, hash);
    stats.pushed++;
    logLine('info', `${link ? 'Updated' : 'Created'} ${mapping.entity} ${remoteId} from ${rec.number}`);
  }

  function matchesFilter(mapping, rec) {
    if (!mapping.filter) return true;
    return Object.entries(mapping.filter).every(([k, v]) => (Array.isArray(v) ? v.includes(rec[k]) : rec[k] === v));
  }

  async function runSync(connectionId, opts = {}) {
    if (!db.prepare('SELECT 1 FROM connections WHERE id = ?').get(connectionId)) throw Object.assign(new Error('Connection not found'), { status: 404 });
    if (running.has(connectionId)) throw Object.assign(new Error('A sync is already running for this connection'), { status: 409 });
    running.add(connectionId);
    try {
      return await withLock(connectionId, () => runSyncLocked(connectionId, opts));
    } finally {
      running.delete(connectionId);
    }
  }

  async function runSyncLocked(connectionId, { direction = 'both', entity = null, trigger = 'manual' } = {}) {
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId);
    if (!row) throw Object.assign(new Error('Connection not found'), { status: 404 });
    const conn = rowToConnection(row, { reveal: true });
    const adapter = getAdapter(conn.adapter);
    const jobId = startJob(conn.id, trigger, direction);
    const lines = [];
    const logLine = (level, msg) => lines.push({ ts: new Date().toISOString(), level, msg });
    const stats = { pulled: 0, created: 0, updated: 0, pushed: 0, skipped: 0, failed: 0 };
    const ctx = makeContext(conn, (msg) => logLine('debug', msg));
    let status = 'succeeded';
    try {
      if (isSandbox(conn)) logLine('info', 'Sandbox mode: exchanging data with a simulated remote system');
      const mappings = conn.mappings.filter((m) => !entity || m.entity === entity);
      if (!mappings.length) logLine('warn', 'No entity mappings configured');
      for (const mapping of mappings) {
        const mod = getModule(mapping.module);
        if (['pull', 'both'].includes(direction) && ['pull', 'both'].includes(mapping.direction)) {
          try {
            const since = conn.state.cursors?.[mapping.entity];
            // Take the cursor before the request so remote changes made while we pull are picked up next time.
            const pullStartedAt = new Date().toISOString();
            const items = await remotePull(conn, adapter, ctx, mapping.entity, { since });
            logLine('info', `Pulled ${items.length} ${mapping.entity} record(s)`);
            let itemFailures = 0;
            for (const item of items) {
              stats.pulled++;
              try { upsertFromRemote(conn, adapter, mapping, item, stats, logLine); } catch (err) {
                stats.failed++;
                itemFailures++;
                logLine('error', `${mapping.entity} ${item.remoteId}: ${err.message}${err.errors ? ' ' + JSON.stringify(err.errors) : ''}`);
              }
            }
            // Keep the old cursor when records failed so they are retried on the next sync.
            if (itemFailures) logLine('warn', `Cursor for ${mapping.entity} not advanced: ${itemFailures} record(s) will be retried`);
            else conn.state.cursors = { ...(conn.state.cursors || {}), [mapping.entity]: pullStartedAt };
          } catch (err) {
            stats.failed++;
            logLine('error', `Pull ${mapping.entity} failed: ${err.message}`);
          }
        }
        if (['push', 'both'].includes(direction) && ['push', 'both'].includes(mapping.direction)) {
          for (const pid of projectIdsFor(conn, mod)) {
            for (let offset = 0; ; offset += PUSH_PAGE) {
              const { items, total } = records.list(mod.key, { projectId: pid, sort: 'number', dir: 'asc', limit: PUSH_PAGE, offset, withComputed: false });
              for (const rec of items.filter((r) => matchesFilter(mapping, r))) {
                try { await pushRecord(conn, adapter, ctx, mapping, rec, stats, logLine); } catch (err) {
                  stats.failed++;
                  logLine('error', `Push ${rec.number} → ${mapping.entity} failed: ${err.message}`);
                }
              }
              if (offset + items.length >= total || !items.length) break;
            }
          }
        }
      }
      if (stats.failed) status = stats.pushed + stats.created + stats.updated + stats.skipped > 0 ? 'partial' : 'failed';
      conn.state.last_error = status === 'succeeded' ? null : lines.filter((l) => l.level === 'error').slice(-1)[0]?.msg;
    } catch (err) {
      status = 'failed';
      logLine('error', err.message);
      conn.state.last_error = err.message;
    } finally {
      saveState(conn.id, conn.state);
      db.prepare("UPDATE connections SET last_sync_at = datetime('now') WHERE id = ?").run(conn.id);
    }
    return finishJob(jobId, status, stats, lines);
  }

  async function testConnection(connectionId) {
    const conn = getConnection(connectionId, { reveal: true });
    if (!conn) throw Object.assign(new Error('Connection not found'), { status: 404 });
    const adapter = getAdapter(conn.adapter);
    if (isSandbox(conn)) return { ok: true, message: 'Sandbox mode – simulated remote system is ready. Disable sandbox and add credentials to go live.' };
    try {
      return await adapter.testConnection(makeContext(conn, () => {}));
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  // ─── Inbound webhooks ────────────────────────────────────────────────
  /**
   * External systems POST changes to /api/integrations/inbound/:id signed with
   * X-Keystone-Signature: sha256=HMAC_SHA256(inbound_secret, raw_body).
   * Body: { entity, action: "upsert"|"delete", id_field?, records: [ {...} ] }
   */
  async function handleInbound(connectionId, rawBody, signature) {
    return withLock(Number(connectionId), () => handleInboundLocked(connectionId, rawBody, signature));
  }

  function handleInboundLocked(connectionId, rawBody, signature) {
    const conn = getConnection(connectionId, { reveal: true });
    if (!conn || !conn.enabled) throw Object.assign(new Error('Connection not found'), { status: 404 });
    if (!signature || !safeEqual(hmac(conn.inbound_secret, rawBody), signature)) {
      throw Object.assign(new Error('Invalid signature'), { status: 401 });
    }
    let body;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }); }
    const mapping = conn.mappings.find((m) => m.entity === body.entity && ['pull', 'both'].includes(m.direction));
    if (!mapping) throw Object.assign(new Error(`No inbound mapping for entity "${body.entity}"`), { status: 422 });
    const adapter = getAdapter(conn.adapter);
    const idField = body.id_field || 'id';
    const items = (Array.isArray(body.records) ? body.records : [body.record || body.data]).filter(Boolean);
    const stats = { pulled: 0, created: 0, updated: 0, pushed: 0, skipped: 0, failed: 0, deleted: 0 };
    const lines = [];
    const logLine = (level, msg) => lines.push({ ts: new Date().toISOString(), level, msg });
    const jobId = startJob(conn.id, 'inbound', 'pull');
    for (const data of items) {
      const remoteId = getPath(data, idField);
      stats.pulled++;
      try {
        if (remoteId == null) throw new Error(`missing ${idField}`);
        if (body.action === 'delete') {
          const link = linkByRemote(conn.id, mapping.entity, remoteId);
          if (link) { records.remove(link.record_id, actorFor(conn)); stats.deleted++; } else stats.skipped++;
        } else {
          upsertFromRemote(conn, adapter, mapping, { remoteId: String(remoteId), data }, stats, logLine);
        }
      } catch (err) {
        stats.failed++;
        logLine('error', `${mapping.entity} ${remoteId}: ${err.message}${err.errors ? ' ' + JSON.stringify(err.errors) : ''}`);
      }
    }
    return finishJob(jobId, stats.failed ? (stats.failed === items.length ? 'failed' : 'partial') : 'succeeded', stats, lines);
  }

  // ─── Event-driven behaviour ──────────────────────────────────────────
  async function onEvent(event) {
    const ids = db.prepare('SELECT id FROM connections WHERE enabled = 1').all().map((r) => r.id);
    await Promise.all(ids.map((id) => withLock(id, () => onEventForConnection(id, event))));
  }

  async function onEventForConnection(id, event) {
    const row = db.prepare('SELECT * FROM connections WHERE id = ? AND enabled = 1').get(id);
    if (!row) return;
    const conn = rowToConnection(row, { reveal: true });
    const adapter = getAdapter(conn.adapter);
    if (!adapter) return;
    if (conn.project_id && event.project_id && conn.project_id !== event.project_id) return;
    try {
      if (typeof adapter.onEvent === 'function' && !conn.mappings.length) {
        const sent = await adapter.onEvent(makeContext(conn, () => {}), event);
        if (sent) {
          conn.state.events_sent = (conn.state.events_sent || 0) + 1;
          conn.state.last_event_at = event.at;
          conn.state.last_error = null;
          saveState(conn.id, conn.state);
        }
        return;
      }
      // Realtime push – skip echoes of changes this connection itself made.
      if (!conn.realtime || event.actor?.connection_id === conn.id || event.type.endsWith('.deleted') || event.type.endsWith('.status_changed')) return;
      const mapping = conn.mappings.find((m) => m.module === event.module && ['push', 'both'].includes(m.direction));
      if (!mapping || !matchesFilter(mapping, event.record)) return;
      const record = records.get(event.record.id);
      if (!record) return;
      const lines = [];
      const logLine = (level, msg) => lines.push({ ts: new Date().toISOString(), level, msg });
      const stats = { pulled: 0, created: 0, updated: 0, pushed: 0, skipped: 0, failed: 0 };
      const jobId = startJob(conn.id, 'realtime', 'push');
      try {
        await pushRecord(conn, adapter, makeContext(conn, (m) => logLine('debug', m)), mapping, record, stats, logLine);
        finishJob(jobId, 'succeeded', stats, lines);
      } catch (err) {
        stats.failed++;
        logLine('error', err.message);
        conn.state.last_error = err.message;
        finishJob(jobId, 'failed', stats, lines);
      }
      saveState(conn.id, conn.state);
    } catch (err) {
      conn.state.last_error = err.message;
      saveState(conn.id, conn.state);
      log(`integration ${conn.id} event error: ${err.message}`);
    }
  }

  function tickScheduler() {
    const due = db.prepare(`SELECT id FROM connections WHERE enabled = 1 AND schedule_minutes > 0
      AND (last_sync_at IS NULL OR last_sync_at <= datetime('now', '-' || schedule_minutes || ' minutes'))`).all();
    for (const { id } of due) {
      if (!running.has(id)) runSync(id, { trigger: 'schedule' }).catch((err) => log(`scheduled sync ${id} failed: ${err.message}`));
    }
  }

  const listener = (event) => { onEvent(event).catch((err) => log(`integration event error: ${err.message}`)); };

  function start({ schedulerMs = 60000 } = {}) {
    events.on('event', listener);
    if (schedulerMs) {
      timer = setInterval(tickScheduler, schedulerMs);
      timer.unref();
    }
  }

  function stop() {
    events.off('event', listener);
    if (timer) clearInterval(timer);
  }

  // ─── Sandbox inspection (lets admins simulate remote-side edits) ─────
  function getSandbox(connectionId, entity) {
    return withLock(Number(connectionId), () => getSandboxLocked(connectionId, entity));
  }

  function getSandboxLocked(connectionId, entity) {
    const conn = getConnection(connectionId, { reveal: true });
    if (!conn) throw Object.assign(new Error('Connection not found'), { status: 404 });
    const store = sandboxStore(conn, getAdapter(conn.adapter), entity);
    saveState(conn.id, conn.state);
    return store;
  }

  function putSandboxRecord(connectionId, entity, remoteId, data) {
    return withLock(Number(connectionId), () => putSandboxRecordLocked(connectionId, entity, remoteId, data));
  }

  function putSandboxRecordLocked(connectionId, entity, remoteId, data) {
    const conn = getConnection(connectionId, { reveal: true });
    if (!conn?.sandbox) throw Object.assign(new Error('Connection is not in sandbox mode'), { status: 409 });
    const store = sandboxStore(conn, getAdapter(conn.adapter), entity);
    const id = remoteId || `sbx-manual-${crypto.randomBytes(3).toString('hex')}`;
    const existing = store.find((s) => s.remoteId === id);
    if (existing) existing.data = { ...existing.data, ...data };
    else store.push({ remoteId: id, data: { id, ...data } });
    saveState(conn.id, conn.state);
    return store.find((s) => s.remoteId === id);
  }

  function exportState(connectionId) {
    return getConnection(connectionId, { reveal: true })?.state || {};
  }

  return {
    listConnections, getConnection, createConnection, updateConnection, deleteConnection, rotateInboundSecret,
    testConnection, runSync, listJobs, getJob, handleInbound, getSandbox, putSandboxRecord, exportState,
    start, stop, tickScheduler, toLocal, toRemote,
  };
}

module.exports = { createIntegrationEngine };
