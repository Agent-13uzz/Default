'use strict';
const { createHttp, getPath, authHeaders } = require('../util');
const { SANDBOX_FIELD } = require('./accounting');

/**
 * Autodesk Construction Cloud (ACC / BIM 360) – Issues and RFIs.
 */
const autodesk = {
  key: 'autodesk_acc',
  name: 'Autodesk Construction Cloud',
  category: 'Design / BIM',
  description: 'Two-way sync of ACC Issues with Observations/Punch List and pull ACC RFIs.',
  docsUrl: 'https://aps.autodesk.com/en/docs/acc/v1/reference/http/issues-issues-GET/',
  configSchema: [
    SANDBOX_FIELD,
    { key: 'project_id', label: 'ACC Project ID (without "b.")', type: 'text' },
    { key: 'access_token', label: 'APS Access Token (3-legged)', type: 'text', secret: true },
    { key: 'issue_subtype_id', label: 'Default Issue Subtype ID', type: 'text', help: 'Required by ACC when creating issues' },
  ],
  entities: [
    {
      key: 'issues', label: 'Issues', module: 'observations', directions: ['pull', 'push'],
      fields: [
        { local: 'title', remote: 'title' },
        { local: 'description', remote: 'description' },
        { local: 'due_date', remote: 'dueDate' },
        { local: 'location', remote: 'locationDetails' },
        { local: 'status', remote: 'status', map: { open: 'Initiated', pending: 'Ready for Review', in_review: 'Ready for Review', closed: 'Closed', not_approved: 'Not Accepted' } },
      ],
    },
    {
      key: 'rfis', label: 'RFIs', module: 'rfis', directions: ['pull'],
      fields: [
        { local: 'subject', remote: 'title' },
        { local: 'question', remote: 'question' },
        { local: 'answer', remote: 'officialResponse' },
        { local: 'due_date', remote: 'dueDate' },
        { local: 'status', remote: 'status', map: { draft: 'Draft', open: 'Open', answered: 'Answered', closed: 'Closed' } },
      ],
    },
  ],
  sandboxSeed: {
    issues: [
      { id: 'a1b2c3', title: 'Clash: duct vs. beam at grid C/4', description: 'Coordination clash from model review', status: 'open', dueDate: '2026-10-15', locationDetails: 'Level 3' },
    ],
    rfis: [
      { id: 'r-778', title: 'Curtain wall anchor spacing', question: 'Confirm anchor spacing at slab edge.', status: 'open', dueDate: '2026-10-08' },
    ],
  },
  http(ctx) {
    return createHttp({ baseUrl: 'https://developer.api.autodesk.com', headers: { Authorization: `Bearer ${ctx.config.access_token}` }, log: ctx.log });
  },
  path(ctx, entity) {
    const pid = String(ctx.config.project_id || '').replace(/^b\./, '');
    return entity === 'rfis' ? `/bim360/rfis/v2/containers/${pid}/rfis` : `/construction/issues/v1/projects/${pid}/issues`;
  },
  async testConnection(ctx) {
    await this.http(ctx).get(this.path(ctx, 'issues'), { query: { limit: 1 } });
    return { ok: true, message: 'Connected to ACC project' };
  },
  async pull(ctx, entity) {
    const http = this.http(ctx);
    const out = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const body = await http.get(this.path(ctx, entity), { query: { limit: 100, offset } });
      const items = body?.results || body?.data || [];
      out.push(...items.map((data) => ({ remoteId: String(data.id), data })));
      if (items.length < 100) break;
    }
    return out;
  },
  async push(ctx, entity, payload, remoteId) {
    const http = this.http(ctx);
    if (remoteId) {
      await http.patch(`${this.path(ctx, entity)}/${remoteId}`, payload);
      return { remoteId };
    }
    const created = await http.post(this.path(ctx, entity), { issueSubtypeId: ctx.config.issue_subtype_id, ...payload });
    return { remoteId: String(created.id) };
  },
};

/**
 * Oracle Primavera P6 EPPM – REST web services (activities ↔ Schedule).
 */
const primavera = {
  key: 'primavera_p6',
  name: 'Oracle Primavera P6',
  category: 'Scheduling',
  description: 'Pull P6 activities into the project schedule and push progress (% complete, actual dates) back.',
  docsUrl: 'https://docs.oracle.com/cd/F37125_01/English/Integration_Documentation/rest_api/',
  configSchema: [
    SANDBOX_FIELD,
    { key: 'base_url', label: 'P6 REST Base URL', type: 'text', placeholder: 'https://p6.example.com/p6ws/restapi' },
    { key: 'username', label: 'Username', type: 'text' },
    { key: 'password', label: 'Password', type: 'text', secret: true },
    { key: 'p6_project_object_id', label: 'P6 Project ObjectId', type: 'text' },
  ],
  entities: [
    {
      key: 'activity', label: 'Activities', module: 'schedule', directions: ['pull', 'push'],
      fields: [
        { local: 'name', remote: 'Name' },
        { local: 'wbs', remote: 'WBSCode' },
        { local: 'start_date', remote: 'StartDate', transform: 'date' },
        { local: 'finish_date', remote: 'FinishDate', transform: 'date' },
        { local: 'percent_complete', remote: 'PercentComplete', transform: 'percent_fraction' },
        { local: 'status', remote: 'Status', map: { 'Not Started': 'Not Started', 'In Progress': 'In Progress', Completed: 'Complete' } },
      ],
    },
  ],
  sandboxSeed: {
    activity: [
      { ObjectId: '4101', Name: 'Mobilize & Site Prep', WBSCode: '1.1', StartDate: '2026-03-02T08:00:00', FinishDate: '2026-03-13T17:00:00', PercentComplete: 1, Status: 'Completed' },
      { ObjectId: '4102', Name: 'Foundations', WBSCode: '1.2', StartDate: '2026-03-16T08:00:00', FinishDate: '2026-05-01T17:00:00', PercentComplete: 0.8, Status: 'In Progress' },
    ],
  },
  http(ctx) {
    return createHttp({ baseUrl: ctx.config.base_url, headers: authHeaders({ auth_type: 'basic', ...ctx.config }), log: ctx.log });
  },
  async testConnection(ctx) {
    await this.http(ctx).get('/project', { query: { Fields: 'Name', Filter: `ObjectId = ${ctx.config.p6_project_object_id}` } });
    return { ok: true, message: 'Connected to Primavera P6' };
  },
  async pull(ctx) {
    const items = await this.http(ctx).get('/activity', {
      query: { Fields: 'ObjectId,Name,WBSCode,StartDate,FinishDate,PercentComplete,Status', Filter: `ProjectObjectId = ${ctx.config.p6_project_object_id}` },
    });
    return (items || []).map((data) => ({ remoteId: String(data.ObjectId), data }));
  },
  async push(ctx, entity, payload, remoteId) {
    if (!remoteId) throw new Error('P6 activities must be created in P6; only progress updates are pushed');
    await this.http(ctx).put('/activity', [{ ObjectId: remoteId, ...payload }]);
    return { remoteId };
  },
};

/**
 * Microsoft Project – imports MSPDI XML (File → Save As → XML).
 */
const msproject = {
  key: 'ms_project',
  name: 'Microsoft Project',
  category: 'Scheduling',
  description: 'Import tasks from a Microsoft Project XML (MSPDI) file by URL or pasted content.',
  configSchema: [
    { key: 'xml_url', label: 'MSPDI XML URL', type: 'text' },
    { key: 'xml_content', label: 'Or paste XML content', type: 'textarea' },
  ],
  entities: [
    {
      key: 'Task', label: 'Tasks', module: 'schedule', directions: ['pull'],
      fields: [
        { local: 'name', remote: 'Name' },
        { local: 'wbs', remote: 'WBS' },
        { local: 'start_date', remote: 'Start', transform: 'date' },
        { local: 'finish_date', remote: 'Finish', transform: 'date' },
        { local: 'percent_complete', remote: 'PercentComplete', transform: 'number' },
        { local: 'milestone', remote: 'Milestone', transform: 'bool' },
        { local: 'critical', remote: 'Critical', transform: 'bool' },
      ],
    },
  ],
  async readXml(ctx) {
    if (ctx.config.xml_url) return createHttp({ log: ctx.log }).get(ctx.config.xml_url, { raw: true });
    return ctx.config.xml_content || '';
  },
  parse(xml) {
    const tasks = [];
    const re = /<Task>([\s\S]*?)<\/Task>/g;
    let m;
    while ((m = re.exec(xml))) {
      const body = m[1].replace(/<ExtendedAttribute>[\s\S]*?<\/ExtendedAttribute>|<Baseline>[\s\S]*?<\/Baseline>|<TimephasedData>[\s\S]*?<\/TimephasedData>/g, '');
      const task = {};
      for (const tag of ['UID', 'ID', 'Name', 'WBS', 'Start', 'Finish', 'PercentComplete', 'Milestone', 'Critical', 'Summary']) {
        const t = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        if (t) task[tag] = t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      }
      if (task.Name && task.UID !== '0' && task.Summary !== '1') tasks.push(task);
    }
    return tasks;
  },
  async testConnection(ctx) {
    const tasks = this.parse(await this.readXml(ctx));
    return { ok: true, message: `Found ${tasks.length} task(s) in the project file.` };
  },
  async pull(ctx) {
    return this.parse(await this.readXml(ctx)).map((data) => ({ remoteId: data.UID, data }));
  },
};

/**
 * DocuSign eSignature – send contracts/commitments for signature and pull
 * envelope status back (completed → Approved).
 */
const docusign = {
  key: 'docusign',
  name: 'DocuSign eSignature',
  category: 'E-Signature',
  description: 'Send commitments and prime contracts for e-signature; completed envelopes mark the contract Approved.',
  docsUrl: 'https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create/',
  configSchema: [
    SANDBOX_FIELD,
    { key: 'base_url', label: 'Base URI', type: 'text', default: 'https://demo.docusign.net/restapi' },
    { key: 'account_id', label: 'Account ID', type: 'text' },
    { key: 'access_token', label: 'Access Token', type: 'text', secret: true },
    { key: 'default_signer_email', label: 'Fallback Signer Email', type: 'text' },
  ],
  entities: [
    {
      key: 'envelopes', label: 'Envelopes (Commitments)', module: 'commitments', directions: ['push', 'pull'], createMissing: false,
      filter: { status: 'Out for Signature' },
      fields: [
        { local: 'title', remote: 'emailSubject', direction: 'push' },
        { local: 'vendor', remote: 'signer.email', transform: 'company_email' },
        { local: 'vendor', remote: 'signer.name', transform: 'company_name' },
        { local: 'scope', remote: 'document.body' },
        { local: 'status', remote: 'status', map: { sent: 'Out for Signature', delivered: 'Out for Signature', completed: 'Approved', declined: 'Draft', voided: 'Draft' }, direction: 'pull' },
      ],
    },
  ],
  http(ctx) {
    return createHttp({ baseUrl: `${ctx.config.base_url || 'https://demo.docusign.net/restapi'}/v2.1/accounts/${ctx.config.account_id}`, headers: { Authorization: `Bearer ${ctx.config.access_token}` }, log: ctx.log });
  },
  async testConnection(ctx) {
    await this.http(ctx).get('/envelopes', { query: { from_date: new Date(Date.now() - 864e5).toISOString() } });
    return { ok: true, message: 'Connected to DocuSign' };
  },
  async pull(ctx) {
    const body = await this.http(ctx).get('/envelopes', { query: { from_date: new Date(Date.now() - 90 * 864e5).toISOString() } });
    return (body?.envelopes || []).map((data) => ({ remoteId: data.envelopeId, data }));
  },
  async push(ctx, entity, payload, remoteId) {
    if (remoteId) return { remoteId }; // envelopes are immutable once sent
    const email = payload.signer?.email || ctx.config.default_signer_email;
    if (!email) throw new Error('No signer email: set the vendor email in the Directory or a fallback signer');
    const html = `<h1>${payload.emailSubject || 'Contract'}</h1><pre>${String(payload.document?.body || '').replace(/</g, '&lt;')}</pre><p>Signature: <span style="color:white">/sn1/</span></p>`;
    const created = await this.http(ctx).post('/envelopes', {
      emailSubject: payload.emailSubject || 'Contract for signature',
      documents: [{ documentBase64: Buffer.from(html).toString('base64'), name: payload.emailSubject || 'Contract', fileExtension: 'html', documentId: '1' }],
      recipients: { signers: [{ email, name: payload.signer?.name || email, recipientId: '1', routingOrder: '1', tabs: { signHereTabs: [{ anchorString: '/sn1/' }] } }] },
      status: 'sent',
    });
    return { remoteId: created.envelopeId };
  },
};

module.exports = { autodesk, primavera, msproject, docusign };
