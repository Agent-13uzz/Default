'use strict';
const { createHttp, getPath, authHeaders } = require('../util');
const { rest, AUTH_FIELDS } = require('./generic');

const SANDBOX_FIELD = { key: 'sandbox', label: 'Sandbox mode (simulate the remote system – no credentials needed)', type: 'boolean', default: true };

/**
 * QuickBooks Online – Accounting API v3.
 * Vendors ↔ Directory, Direct Costs → Bills, Commitments → Purchase Orders,
 * Customers ← Directory (owners). Requires an OAuth2 access token and realm id.
 */
const quickbooks = {
  key: 'quickbooks',
  name: 'QuickBooks Online',
  category: 'Accounting / ERP',
  description: 'Sync vendors, push approved direct costs as Bills and commitments as Purchase Orders.',
  docsUrl: 'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor',
  configSchema: [
    SANDBOX_FIELD,
    { key: 'environment', label: 'Environment', type: 'select', options: ['production', 'sandbox'], default: 'production' },
    { key: 'realm_id', label: 'Company (Realm) ID', type: 'text' },
    { key: 'access_token', label: 'OAuth Access Token', type: 'text', secret: true },
    { key: 'expense_account_id', label: 'Default Expense Account ID', type: 'text', help: 'AccountRef used on Bill / PO lines' },
  ],
  entities: [
    {
      key: 'Vendor', label: 'Vendors', module: 'directory', directions: ['pull', 'push'],
      fields: [
        { local: 'name', remote: 'DisplayName' },
        { local: 'email', remote: 'PrimaryEmailAddr.Address' },
        { local: 'phone', remote: 'PrimaryPhone.FreeFormNumber' },
        { local: 'primary_contact', remote: 'GivenName' },
        { local: 'status', remote: 'Active', map: { true: 'Active', false: 'Inactive' } },
      ],
    },
    {
      key: 'Bill', label: 'Bills (from Direct Costs)', module: 'direct_costs', directions: ['push'], filter: { status: 'Approved' },
      fields: [
        { local: 'invoice_number', remote: 'DocNumber' },
        { local: 'cost_date', remote: 'TxnDate' },
        { local: 'vendor', remote: 'VendorRef.name', transform: 'company_name' },
        { local: 'amount', remote: 'Line.0.Amount' },
        { local: 'description', remote: 'Line.0.Description' },
      ],
    },
    {
      key: 'PurchaseOrder', label: 'Purchase Orders (from Commitments)', module: 'commitments', directions: ['push'],
      fields: [
        { local: 'number', remote: 'DocNumber' },
        { local: 'vendor', remote: 'VendorRef.name', transform: 'company_name' },
        { local: 'title', remote: 'Memo' },
        { local: 'line_items', remote: 'Line', transform: 'lines_to_qbo' },
      ],
    },
  ],
  transforms: {
    lines_to_qbo: {
      push: (lines) => (lines || []).map((l) => ({ Amount: l.amount || 0, Description: [l.cost_code, l.description].filter(Boolean).join(' – ') })),
      pull: (lines) => (lines || []).map((l) => ({ amount: l.Amount, description: l.Description })),
    },
  },
  sandboxSeed: {
    Vendor: [
      { Id: '56', DisplayName: 'Bayside Electric Inc.', PrimaryEmailAddr: { Address: 'ar@baysideelectric.com' }, PrimaryPhone: { FreeFormNumber: '(415) 555-0133' }, Active: true },
      { Id: '57', DisplayName: 'Summit Concrete Pumping', PrimaryEmailAddr: { Address: 'billing@summitpump.com' }, PrimaryPhone: { FreeFormNumber: '(510) 555-0102' }, Active: true },
    ],
  },
  base(ctx) {
    const host = ctx.config.environment === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
    return createHttp({ baseUrl: `${host}/v3/company/${ctx.config.realm_id}`, headers: { Authorization: `Bearer ${ctx.config.access_token}` }, log: ctx.log });
  },
  async testConnection(ctx) {
    const info = await this.base(ctx).get(`/companyinfo/${ctx.config.realm_id}`, { query: { minorversion: 70 } });
    return { ok: true, message: `Connected to ${getPath(info, 'CompanyInfo.CompanyName') || 'QuickBooks company'}` };
  },
  async pull(ctx, entity) {
    const http = this.base(ctx);
    const out = [];
    for (let start = 1; start < 10000; start += 1000) {
      const body = await http.get('/query', { query: { query: `select * from ${entity} STARTPOSITION ${start} MAXRESULTS 1000`, minorversion: 70 } });
      const items = getPath(body, `QueryResponse.${entity}`) || [];
      out.push(...items.map((data) => ({ remoteId: String(data.Id), data })));
      if (items.length < 1000) break;
    }
    return out;
  },
  async push(ctx, entity, payload, remoteId) {
    const http = this.base(ctx);
    const path = `/${entity.toLowerCase()}`;
    const body = { ...payload };
    if (ctx.config.expense_account_id && Array.isArray(body.Line)) {
      body.Line = body.Line.map((l) => ({
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: { AccountRef: { value: ctx.config.expense_account_id } },
        ...l,
      }));
    }
    if (body.VendorRef?.name && !body.VendorRef.value) {
      const res = await http.get('/query', { query: { query: `select Id from Vendor where DisplayName = '${body.VendorRef.name.replace(/'/g, "\\'")}'` } });
      const v = getPath(res, 'QueryResponse.Vendor.0.Id');
      if (!v) throw new Error(`Vendor "${body.VendorRef.name}" not found in QuickBooks – sync Vendors first`);
      body.VendorRef = { value: v };
    }
    if (remoteId) {
      const current = await http.get(`${path}/${remoteId}`);
      const syncToken = getPath(current, `${entity}.SyncToken`);
      await http.post(path, { ...body, Id: remoteId, SyncToken: syncToken, sparse: true });
      return { remoteId };
    }
    const created = await http.post(path, body);
    return { remoteId: String(getPath(created, `${entity}.Id`)) };
  },
};

/**
 * Sage Intacct – REST API (objects endpoint).
 * Vendors ↔ Directory, AP Bills ← Direct Costs, Projects ← Projects.
 */
const sageIntacct = {
  key: 'sage_intacct',
  name: 'Sage Intacct',
  category: 'Accounting / ERP',
  description: 'Sync vendors and push AP bills from approved direct costs and subcontractor invoices.',
  docsUrl: 'https://developer.sage.com/intacct/apis/intacct/1/intacct-openapi',
  configSchema: [
    SANDBOX_FIELD,
    { key: 'base_url', label: 'API Base URL', type: 'text', default: 'https://api.intacct.com/ia/api/v1' },
    { key: 'access_token', label: 'OAuth Access Token', type: 'text', secret: true },
  ],
  entities: [
    {
      key: 'accounts-payable/vendor', label: 'Vendors', module: 'directory', directions: ['pull', 'push'],
      fields: [
        { local: 'name', remote: 'name' },
        { local: 'email', remote: 'contacts.default.email1' },
        { local: 'phone', remote: 'contacts.default.phone1' },
        { local: 'status', remote: 'status', map: { active: 'Active', inactive: 'Inactive' } },
      ],
    },
    {
      key: 'accounts-payable/bill', label: 'AP Bills', module: 'direct_costs', directions: ['push'], filter: { status: 'Approved' },
      fields: [
        { local: 'invoice_number', remote: 'billNumber' },
        { local: 'cost_date', remote: 'createdDate' },
        { local: 'vendor', remote: 'vendor.name', transform: 'company_name' },
        { local: 'amount', remote: 'lines.0.txnAmount' },
        { local: 'cost_code', remote: 'lines.0.dimensions.task.id' },
        { local: 'description', remote: 'lines.0.memo' },
      ],
    },
  ],
  sandboxSeed: {
    'accounts-payable/vendor': [
      { key: 'V-1001', name: 'Pacific Steel Erectors', contacts: { default: { email1: 'ap@pacsteel.com', phone1: '555-0199' } }, status: 'active' },
    ],
  },
  base(ctx) {
    return createHttp({ baseUrl: ctx.config.base_url || 'https://api.intacct.com/ia/api/v1', headers: { Authorization: `Bearer ${ctx.config.access_token}` }, log: ctx.log });
  },
  async testConnection(ctx) {
    await this.base(ctx).get('/objects/accounts-payable/vendor', { query: { limit: 1 } });
    return { ok: true, message: 'Connected to Sage Intacct' };
  },
  async pull(ctx, entity) {
    const http = this.base(ctx);
    const list = await http.get(`/objects/${entity}`, { query: { limit: 200 } });
    const refs = list?.['ia::result'] || [];
    const out = [];
    for (const ref of refs) {
      const full = await http.get(`/objects/${entity}/${ref.key}`);
      out.push({ remoteId: String(ref.key), data: full?.['ia::result'] || ref });
    }
    return out;
  },
  async push(ctx, entity, payload, remoteId) {
    const http = this.base(ctx);
    if (remoteId) {
      await http.patch(`/objects/${entity}/${remoteId}`, payload);
      return { remoteId };
    }
    const created = await http.post(`/objects/${entity}`, payload);
    return { remoteId: String(getPath(created, 'ia::result.key')) };
  },
};

/**
 * ERP presets built on the Generic REST connector. Construction ERPs
 * (Viewpoint Vista/Spectrum, CMiC, Foundation, Acumatica, Sage 300 CRE via
 * middleware) expose APIs whose paths vary per customer installation, so the
 * preset supplies sensible endpoint defaults that admins adjust per tenant.
 */
function erpPreset(key, name, description, endpoints, docsUrl) {
  return {
    ...rest,
    key,
    name,
    category: 'Accounting / ERP',
    description,
    docsUrl,
    freeformEntities: true,
    configSchema: [
      SANDBOX_FIELD,
      ...rest.configSchema.map((f) => (f.key === 'endpoints' ? { ...f, default: endpoints } : f)),
    ],
    entities: Object.keys(endpoints).map((k) => ({ key: k, label: k, directions: ['pull', 'push'] })),
  };
}

const viewpoint = erpPreset('viewpoint', 'Viewpoint Vista / Spectrum', 'Sync vendors, jobs, cost codes, subcontracts and AP via Trimble App Xchange or a Vista API gateway.', {
  vendors: { path: '/vendors', list_path: 'items', id_field: 'VendorId', update_method: 'PUT', update_path: '/vendors/{id}' },
  subcontracts: { path: '/subcontracts', list_path: 'items', id_field: 'SL', update_method: 'PUT', update_path: '/subcontracts/{id}' },
  ap_invoices: { path: '/ap/invoices', list_path: 'items', id_field: 'APRef' },
  job_cost: { path: '/jobcost/actuals', list_path: 'items', id_field: 'Id' },
}, 'https://developer.trimble.com/');

const cmic = erpPreset('cmic', 'CMiC', 'Exchange vendors, commitments, change orders and job cost with CMiC ERP REST services.', {
  vendors: { path: '/sc-rest-api/rest/v1/vendors', list_path: 'items', id_field: 'VenCode' },
  commitments: { path: '/sc-rest-api/rest/v1/subcontracts', list_path: 'items', id_field: 'ScCode' },
}, 'https://cmicglobal.com/');

const foundation = erpPreset('foundation', 'Foundation Software', 'Send commitments and AP to Foundation; pull job cost actuals back into the budget.', {
  vendors: { path: '/vendors', list_path: 'data', id_field: 'id' },
  commitments: { path: '/commitments', list_path: 'data', id_field: 'id' },
}, 'https://www.foundationsoft.com/');

const acumatica = erpPreset('acumatica', 'Acumatica Construction', 'Contract-based REST API: vendors, projects, subcontracts, AP bills.', {
  vendors: { path: '/entity/Default/22.200.001/Vendor', list_path: '', id_field: 'VendorID.value', update_method: 'PUT', update_path: '/entity/Default/22.200.001/Vendor' },
  subcontracts: { path: '/entity/Default/22.200.001/Subcontract', list_path: '', id_field: 'SubcontractNbr.value' },
}, 'https://help.acumatica.com/');

module.exports = { quickbooks, sageIntacct, viewpoint, cmic, foundation, acumatica, SANDBOX_FIELD, AUTH_FIELDS, authHeaders };
