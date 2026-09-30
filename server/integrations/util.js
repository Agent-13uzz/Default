'use strict';
const crypto = require('node:crypto');

/** Read a value from an object using a dot path ("Vendor.DisplayName", "items.0.id"). */
function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Write a value into an object using a dot path, creating intermediate objects. */
function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
  return obj;
}

const stableHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value, Object.keys(flatKeys(value)).sort())).digest('hex');
function flatKeys(v, out = {}) {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out[k] = 1; flatKeys(x, out); }
  return out;
}

const hmac = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Small fetch wrapper with timeout, JSON handling and helpful errors.
 * Adapters receive a pre-configured instance via ctx.http.
 */
function createHttp({ baseUrl = '', headers = {}, timeoutMs = 20000, log = () => {} } = {}) {
  async function request(method, url, { query, body, headers: extra = {}, raw = false } = {}) {
    let full = /^https?:\/\//i.test(url) ? url : baseUrl.replace(/\/$/, '') + '/' + String(url).replace(/^\//, '');
    if (query) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString();
      if (qs) full += (full.includes('?') ? '&' : '?') + qs;
    }
    const init = { method, headers: { Accept: 'application/json', ...headers, ...extra }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      if (typeof body === 'string') init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      }
    }
    log(`${method} ${full.replace(/access_token=[^&]+/, 'access_token=***')}`);
    const res = await fetch(full, init);
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${method} ${full} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return text;
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }
  return {
    request,
    get: (u, o) => request('GET', u, o),
    post: (u, body, o = {}) => request('POST', u, { ...o, body }),
    put: (u, body, o = {}) => request('PUT', u, { ...o, body }),
    patch: (u, body, o = {}) => request('PATCH', u, { ...o, body }),
    delete: (u, o) => request('DELETE', u, o),
  };
}

/** Build standard auth headers from a common config shape. */
function authHeaders(config) {
  switch (config.auth_type) {
    case 'bearer':
      return config.token ? { Authorization: `Bearer ${config.token}` } : {};
    case 'basic':
      return { Authorization: 'Basic ' + Buffer.from(`${config.username || ''}:${config.password || ''}`).toString('base64') };
    case 'header':
      return config.header_name ? { [config.header_name]: config.header_value || '' } : {};
    default:
      return {};
  }
}

/** Minimal RFC-4180 CSV parser / serializer. */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v !== ''));
  if (!nonEmpty.length) return [];
  const [header, ...data] = nonEmpty;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

function toCSV(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = { getPath, setPath, stableHash, hmac, safeEqual, createHttp, authHeaders, parseCSV, toCSV };
