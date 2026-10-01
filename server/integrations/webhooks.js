'use strict';
const crypto = require('node:crypto');
const { parseJSON } = require('../db');
const { matchesEvent } = require('../events');
const { hmac } = require('./util');

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [0, 30, 120, 600, 1800, 7200];

/**
 * Outbound webhooks. Any external system (ERP, BI warehouse, Zapier, Make,
 * n8n, Power Automate, custom middleware) can subscribe to domain events.
 * Deliveries are persisted, signed and retried with exponential backoff.
 *
 * Headers: X-Keystone-Event, X-Keystone-Delivery, X-Keystone-Signature (sha256=HMAC of body)
 */
function createWebhookDispatcher({ db, events, log = () => {}, fetchImpl = (...a) => fetch(...a) }) {
  let timer = null;
  let draining = false;

  function serialize(row, { reveal = false } = {}) {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      events: parseJSON(row.events, ['*']),
      project_id: row.project_id,
      active: !!row.active,
      secret: reveal ? row.secret : `••••••${row.secret.slice(-4)}`,
      created_at: row.created_at,
    };
  }

  function validate(input) {
    let url;
    try { url = new URL(input.url); } catch { throw Object.assign(new Error('url must be a valid URL'), { status: 422 }); }
    if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('url must be http(s)'), { status: 422 });
    const evts = Array.isArray(input.events) ? input.events : String(input.events || '*').split(',').map((s) => s.trim()).filter(Boolean);
    return { url: url.toString(), events: evts.length ? evts : ['*'] };
  }

  function create(input) {
    const { url, events: evts } = validate(input);
    const secret = crypto.randomBytes(24).toString('hex');
    const info = db.prepare('INSERT INTO webhooks (name, url, events, secret, project_id, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.name || url, url, JSON.stringify(evts), secret, input.project_id || null, input.active === false ? 0 : 1);
    return serialize(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(info.lastInsertRowid)), { reveal: true });
  }

  function update(id, input) {
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error('Webhook not found'), { status: 404 });
    const { url, events: evts } = validate({ url: input.url ?? row.url, events: input.events ?? parseJSON(row.events, ['*']) });
    db.prepare('UPDATE webhooks SET name = ?, url = ?, events = ?, project_id = ?, active = ? WHERE id = ?')
      .run(input.name ?? row.name, url, JSON.stringify(evts), input.project_id !== undefined ? input.project_id || null : row.project_id,
        input.active !== undefined ? (input.active ? 1 : 0) : row.active, id);
    return serialize(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id));
  }

  const list = () => db.prepare('SELECT * FROM webhooks ORDER BY id').all().map((r) => serialize(r));
  const remove = (id) => db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  const deliveries = (webhookId, limit = 50) => db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?').all(webhookId, limit)
    .map((d) => ({ ...d, payload: parseJSON(d.payload, null) }));

  function enqueue(event) {
    const hooks = db.prepare('SELECT * FROM webhooks WHERE active = 1').all();
    let n = 0;
    for (const h of hooks) {
      if (h.project_id && event.project_id && h.project_id !== event.project_id) continue;
      if (!parseJSON(h.events, ['*']).some((p) => matchesEvent(p, event.type))) continue;
      const payload = {
        id: crypto.randomUUID(),
        event: event.type,
        occurred_at: event.at,
        project_id: event.project_id ?? null,
        module: event.module,
        actor: event.actor,
        data: event.record,
        changes: event.changes,
      };
      db.prepare('INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES (?, ?, ?)').run(h.id, event.type, JSON.stringify(payload));
      n++;
    }
    if (n) setImmediate(() => drain().catch((err) => log(`webhook drain failed: ${err.message}`)));
  }

  async function deliver(d) {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(d.webhook_id);
    if (!hook) return;
    // Disabling a webhook also stops deliveries that were already queued or retrying.
    if (!hook.active) {
      db.prepare("UPDATE webhook_deliveries SET status = 'cancelled', last_error = 'Webhook disabled' WHERE id = ?").run(d.id);
      return;
    }
    const body = d.payload;
    const attempts = d.attempts + 1;
    let code = null;
    let error = null;
    try {
      const res = await fetchImpl(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Keystone-Webhooks/1.0',
          'X-Keystone-Event': d.event,
          'X-Keystone-Delivery': String(d.id),
          'X-Keystone-Signature': hmac(hook.secret, body),
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      code = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err.message;
    }
    if (!error) {
      db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, response_code = ?, last_error = NULL WHERE id = ?").run(attempts, code, d.id);
    } else if (attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, response_code = ?, last_error = ? WHERE id = ?").run(attempts, code, error, d.id);
    } else {
      db.prepare(`UPDATE webhook_deliveries SET status = 'retrying', attempts = ?, response_code = ?, last_error = ?, next_attempt_at = datetime('now', '+' || ? || ' seconds') WHERE id = ?`)
        .run(attempts, code, error, BACKOFF_SECONDS[attempts], d.id);
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const due = db.prepare("SELECT * FROM webhook_deliveries WHERE status IN ('pending', 'retrying') AND next_attempt_at <= datetime('now') ORDER BY id LIMIT 100").all();
      for (const d of due) await deliver(d);
    } finally {
      draining = false;
    }
  }

  function redeliver(deliveryId) {
    const d = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(deliveryId);
    if (!d) throw Object.assign(new Error('Delivery not found'), { status: 404 });
    db.prepare("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = datetime('now') WHERE id = ?").run(deliveryId);
    setImmediate(() => drain().catch(() => {}));
  }

  function sendTest(id) {
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    if (!row) throw Object.assign(new Error('Webhook not found'), { status: 404 });
    const payload = { id: crypto.randomUUID(), event: 'ping', occurred_at: new Date().toISOString(), data: { message: 'Keystone webhook test' } };
    db.prepare("INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES (?, 'ping', ?)").run(id, JSON.stringify(payload));
    return drain();
  }

  const listener = (event) => enqueue(event);

  function start({ intervalMs = 15000 } = {}) {
    events.on('event', listener);
    if (intervalMs) {
      timer = setInterval(() => drain().catch(() => {}), intervalMs);
      timer.unref();
    }
  }

  function stop() {
    events.off('event', listener);
    if (timer) clearInterval(timer);
  }

  return { create, update, list, remove, deliveries, redeliver, sendTest, drain, start, stop, serialize };
}

module.exports = { createWebhookDispatcher };
