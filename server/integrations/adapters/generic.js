'use strict';
const { getPath, authHeaders, createHttp, parseCSV, toCSV } = require('../util');

const AUTH_FIELDS = [
  { key: 'auth_type', label: 'Authentication', type: 'select', options: ['none', 'bearer', 'basic', 'header'], default: 'bearer' },
  { key: 'token', label: 'Bearer Token', type: 'text', secret: true, showIf: { field: 'auth_type', equals: 'bearer' } },
  { key: 'username', label: 'Username', type: 'text', showIf: { field: 'auth_type', equals: 'basic' } },
  { key: 'password', label: 'Password', type: 'text', secret: true, showIf: { field: 'auth_type', equals: 'basic' } },
  { key: 'header_name', label: 'Header Name', type: 'text', showIf: { field: 'auth_type', equals: 'header' } },
  { key: 'header_value', label: 'Header Value', type: 'text', secret: true, showIf: { field: 'auth_type', equals: 'header' } },
];

/**
 * Generic REST connector – links any system that exposes a JSON REST API
 * (ERP, accounting, HR, CRM, in-house tools). Each remote entity is described
 * in the `endpoints` config so no code changes are needed for a new system.
 */
const rest = {
  key: 'rest',
  name: 'Generic REST API',
  category: 'Generic',
  description: 'Connect any system with a JSON REST API. Define endpoints per entity, map fields, and sync in either direction.',
  freeformEntities: true,
  configSchema: [
    { key: 'base_url', label: 'Base URL', type: 'text', required: true, placeholder: 'https://erp.example.com/api' },
    ...AUTH_FIELDS,
    {
      key: 'endpoints', label: 'Endpoints (JSON)', type: 'json',
      help: 'Map of entity → { "path": "/vendors", "list_path": "data", "id_field": "id", "update_method": "PUT", "update_path": "/vendors/{id}", "page_param": "page" }',
      default: { vendors: { path: '/vendors', list_path: 'data', id_field: 'id', update_method: 'PUT', update_path: '/vendors/{id}' } },
    },
  ],
  entities: [],
  endpoint(ctx, entity) {
    const ep = (ctx.config.endpoints || {})[entity];
    if (!ep) throw new Error(`No endpoint configured for entity "${entity}"`);
    return { list_path: '', id_field: 'id', update_method: 'PUT', update_path: `${ep.path}/{id}`, ...ep };
  },
  http(ctx) {
    return createHttp({ baseUrl: ctx.config.base_url, headers: authHeaders(ctx.config), log: ctx.log });
  },
  async testConnection(ctx) {
    const first = Object.keys(ctx.config.endpoints || {})[0];
    if (!first) return { ok: true, message: 'No endpoints configured yet; base URL accepted.' };
    const ep = this.endpoint(ctx, first);
    await this.http(ctx).get(ep.path, { query: { limit: 1 } });
    return { ok: true, message: `Reached ${ep.path}` };
  },
  async pull(ctx, entity, { since } = {}) {
    const ep = this.endpoint(ctx, entity);
    const http = this.http(ctx);
    const out = [];
    for (let page = 1; page <= (ep.page_param ? 50 : 1); page++) {
      const query = {};
      if (ep.page_param) query[ep.page_param] = page;
      if (since && ep.since_param) query[ep.since_param] = since;
      const body = await http.get(ep.path, { query });
      const items = getPath(body, ep.list_path) || [];
      if (!Array.isArray(items)) throw new Error(`Expected an array at "${ep.list_path}" for ${entity}`);
      out.push(...items.map((data) => ({ remoteId: String(getPath(data, ep.id_field)), data })));
      if (!ep.page_param || !items.length) break;
    }
    return out;
  },
  async push(ctx, entity, payload, remoteId) {
    const ep = this.endpoint(ctx, entity);
    const http = this.http(ctx);
    if (remoteId) {
      await http.request(ep.update_method, ep.update_path.replace('{id}', encodeURIComponent(remoteId)), { body: payload });
      return { remoteId };
    }
    const created = await http.post(ep.path, payload);
    const id = getPath(ep.create_response_path ? getPath(created, ep.create_response_path) : created, ep.id_field);
    if (id == null) throw new Error(`Create response for ${entity} did not include "${ep.id_field}"`);
    return { remoteId: String(id) };
  },
};

/**
 * CSV connector – for legacy systems without an API. Pull from pasted CSV or
 * a CSV URL; push writes a CSV export that can be downloaded from the
 * connection page or fetched by the other system.
 */
const csv = {
  key: 'csv',
  name: 'CSV Import / Export',
  category: 'Generic',
  description: 'Exchange data with legacy systems via CSV files: import from a URL or pasted content, export for download.',
  freeformEntities: true,
  configSchema: [
    { key: 'source_url', label: 'CSV URL (optional)', type: 'text', placeholder: 'https://files.example.com/vendors.csv' },
    { key: 'csv_content', label: 'Or paste CSV content', type: 'textarea' },
    { key: 'id_column', label: 'ID Column', type: 'text', default: 'id' },
  ],
  entities: [],
  async testConnection(ctx) {
    const rows = await this.readRows(ctx);
    return { ok: true, message: `Parsed ${rows.length} row(s).` };
  },
  async readRows(ctx) {
    let text = ctx.config.csv_content || '';
    if (ctx.config.source_url) text = await createHttp({ log: ctx.log }).get(ctx.config.source_url, { raw: true });
    return parseCSV(text);
  },
  async pull(ctx) {
    const idCol = ctx.config.id_column || 'id';
    return (await this.readRows(ctx)).map((data, i) => ({ remoteId: String(data[idCol] || `row-${i + 1}`), data }));
  },
  async push(ctx, entity, payload, remoteId) {
    const exports = (ctx.state.exports = ctx.state.exports || {});
    const rows = (exports[entity] = exports[entity] || []);
    const id = remoteId || payload[ctx.config.id_column || 'id'] || `ks-${rows.length + 1}-${Date.now().toString(36)}`;
    const idx = rows.findIndex((r) => r.__id === id);
    const row = { __id: id, ...payload };
    if (idx >= 0) rows[idx] = row; else rows.push(row);
    return { remoteId: String(id) };
  },
  exportCSV(state, entity) {
    const rows = (state.exports?.[entity] || []).map(({ __id, ...rest }) => ({ id: __id, ...rest }));
    return toCSV(rows);
  },
};

module.exports = { rest, csv, AUTH_FIELDS };
