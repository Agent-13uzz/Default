'use strict';
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const { seed } = require('../server/seed');

/** Boot a fully seeded app on an ephemeral port with an in-memory database. */
async function startApp() {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystone-test-'));
  const ctx = createApp({ dbFile: ':memory:', uploadsDir, background: false, logger: { warn() {}, error() {} } });
  seed(ctx);
  const server = await new Promise((resolve) => { const s = ctx.app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};

  async function request(method, url, { token, body, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || typeof body === 'string') init.body = body;
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    const res = await fetch(base + url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body: raw ? text : json, headers: res.headers };
  }

  async function login(who) {
    if (tokens[who]) return tokens[who];
    const res = await request('POST', '/api/auth/login', { body: { email: `${who}@keystone.test`, password: 'keystone123' } });
    if (res.status !== 200) throw new Error(`login ${who} failed: ${res.status}`);
    tokens[who] = res.body.token;
    return tokens[who];
  }

  const as = (who) => {
    const call = async (method, url, body, opts = {}) => request(method, url, { token: await login(who), body, ...opts });
    return {
      get: (u, o) => call('GET', u, undefined, o),
      post: (u, b, o) => call('POST', u, b, o),
      patch: (u, b, o) => call('PATCH', u, b, o),
      put: (u, b, o) => call('PUT', u, b, o),
      del: (u, o) => call('DELETE', u, undefined, o),
    };
  };

  async function stop() {
    await new Promise((r) => server.close(r));
    ctx.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }

  return { ctx, base, request, login, as, stop };
}

/** Tiny HTTP server that records requests and replies via a handler. */
async function mockServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() };
      calls.push(call);
      const out = handler ? handler(call) : { status: 200, body: { ok: true } };
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const waitFor = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

module.exports = { startApp, mockServer, waitFor };
