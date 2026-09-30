'use strict';
const { createHttp, authHeaders, getPath } = require('../util');
const { matchesEvent } = require('../../events');
const { getModule } = require('../../modules');
const { SANDBOX_FIELD } = require('./accounting');

const EVENTS_FIELD = {
  key: 'events', label: 'Events to post (comma separated patterns)', type: 'text',
  default: 'rfis.created,submittals.status_changed,incidents.created,change_orders.status_changed,observations.created',
};

function describe(event, appUrl) {
  const mod = getModule(event.module);
  const r = event.record || {};
  const verb = event.type.endsWith('.created') ? 'created' : event.type.endsWith('.deleted') ? 'deleted'
    : event.type.endsWith('.status_changed') ? `moved to *${r.status}*` : 'updated';
  const link = appUrl && r.project_id ? `${appUrl.replace(/\/$/, '')}/#/p/${r.project_id}/m/${event.module}/${r.id}` : null;
  return {
    title: `${mod?.singular || event.module} ${r.number || ''}: ${r.title || ''}`.trim(),
    text: `${mod?.singular || event.module} ${r.number} ${verb} by ${event.actor?.name || 'system'}`,
    link,
  };
}

function wantsEvent(config, event) {
  const patterns = String(config.events || '*').split(',').map((s) => s.trim()).filter(Boolean);
  return patterns.some((p) => matchesEvent(p, event.type));
}

const slack = {
  key: 'slack',
  name: 'Slack',
  category: 'Communication',
  description: 'Post project activity (new RFIs, submittal decisions, incidents, change orders…) to a Slack channel.',
  docsUrl: 'https://api.slack.com/messaging/webhooks',
  configSchema: [
    { key: 'webhook_url', label: 'Incoming Webhook URL', type: 'text', secret: true, required: true },
    EVENTS_FIELD,
    { key: 'app_url', label: 'Keystone URL (for links)', type: 'text', placeholder: 'https://keystone.example.com' },
  ],
  entities: [],
  notifier: true,
  async testConnection(ctx) {
    await createHttp({ log: ctx.log }).post(ctx.config.webhook_url, { text: ':white_check_mark: Keystone is connected to this channel.' }, { raw: true });
    return { ok: true, message: 'Test message posted' };
  },
  async onEvent(ctx, event) {
    if (!wantsEvent(ctx.config, event)) return false;
    const d = describe(event, ctx.config.app_url);
    await createHttp({ log: ctx.log }).post(ctx.config.webhook_url, {
      text: `${d.title} – ${d.text}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${d.link ? `<${d.link}|${d.title}>` : d.title}*\n${d.text}` } },
      ],
    }, { raw: true });
    return true;
  },
};

const teams = {
  key: 'ms_teams',
  name: 'Microsoft Teams',
  category: 'Communication',
  description: 'Post project activity to a Teams channel via a Workflows / incoming webhook URL.',
  docsUrl: 'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
  configSchema: [
    { key: 'webhook_url', label: 'Webhook URL', type: 'text', secret: true, required: true },
    EVENTS_FIELD,
    { key: 'app_url', label: 'Keystone URL (for links)', type: 'text' },
  ],
  entities: [],
  notifier: true,
  card(title, text, link) {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
          body: [{ type: 'TextBlock', text: title, weight: 'Bolder', wrap: true }, { type: 'TextBlock', text, wrap: true }],
          actions: link ? [{ type: 'Action.OpenUrl', title: 'Open in Keystone', url: link }] : [],
        },
      }],
    };
  },
  async testConnection(ctx) {
    await createHttp({ log: ctx.log }).post(ctx.config.webhook_url, this.card('Keystone connected', 'This channel will receive project activity.'), { raw: true });
    return { ok: true, message: 'Test card posted' };
  },
  async onEvent(ctx, event) {
    if (!wantsEvent(ctx.config, event)) return false;
    const d = describe(event, ctx.config.app_url);
    await createHttp({ log: ctx.log }).post(ctx.config.webhook_url, this.card(d.title, d.text.replace(/\*/g, ''), d.link), { raw: true });
    return true;
  },
};

/**
 * Procore – migrate data from an existing Procore account (REST v1.0).
 */
const procore = {
  key: 'procore',
  name: 'Procore (migration)',
  category: 'Construction Management',
  description: 'Import RFIs, submittals, punch items and vendors from an existing Procore project.',
  docsUrl: 'https://developers.procore.com/reference/rest/rfis',
  configSchema: [
    SANDBOX_FIELD,
    { key: 'base_url', label: 'API Base URL', type: 'text', default: 'https://api.procore.com' },
    { key: 'access_token', label: 'OAuth Access Token', type: 'text', secret: true },
    { key: 'company_id', label: 'Procore Company ID', type: 'text' },
    { key: 'procore_project_id', label: 'Procore Project ID', type: 'text' },
  ],
  entities: [
    {
      key: 'rfis', label: 'RFIs', module: 'rfis', directions: ['pull'],
      fields: [
        { local: 'subject', remote: 'subject' },
        { local: 'question', remote: 'questions.0.plain_text_body' },
        { local: 'due_date', remote: 'due_date' },
        { local: 'status', remote: 'status', map: { draft: 'Draft', open: 'Open', closed: 'Closed' } },
      ],
    },
    {
      key: 'submittals', label: 'Submittals', module: 'submittals', directions: ['pull'],
      fields: [
        { local: 'title', remote: 'title' },
        { local: 'spec_section', remote: 'specification_section.number' },
        { local: 'due_date', remote: 'due_date' },
        { local: 'status', remote: 'status.name' },
      ],
    },
    {
      key: 'punch_items', label: 'Punch Items', module: 'punch_list', directions: ['pull'],
      fields: [
        { local: 'title', remote: 'name' },
        { local: 'description', remote: 'description' },
        { local: 'due_date', remote: 'due_date' },
        { local: 'priority', remote: 'priority', map: { low: 'Low', medium: 'Medium', high: 'High' } },
      ],
    },
    {
      key: 'vendors', label: 'Vendors', module: 'directory', directions: ['pull'],
      fields: [
        { local: 'name', remote: 'name' },
        { local: 'email', remote: 'email_address' },
        { local: 'phone', remote: 'business_phone' },
        { local: 'license_number', remote: 'license_number' },
      ],
    },
  ],
  sandboxSeed: {
    rfis: [{ id: 9001, subject: 'Imported: Stair 2 handrail height', questions: [{ plain_text_body: 'Confirm handrail height at landing.' }], due_date: '2026-10-20', status: 'open' }],
    vendors: [{ id: 3301, name: 'Imported: Keller Glazing', email_address: 'info@kellerglazing.com', business_phone: '555-0170' }],
  },
  http(ctx) {
    return createHttp({ baseUrl: ctx.config.base_url || 'https://api.procore.com', headers: { ...authHeaders({ auth_type: 'bearer', token: ctx.config.access_token }), 'Procore-Company-Id': ctx.config.company_id }, log: ctx.log });
  },
  async testConnection(ctx) {
    await this.http(ctx).get('/rest/v1.0/me');
    return { ok: true, message: 'Connected to Procore' };
  },
  async pull(ctx, entity) {
    const pid = ctx.config.procore_project_id;
    const paths = {
      rfis: `/rest/v1.0/projects/${pid}/rfis`,
      submittals: `/rest/v1.1/projects/${pid}/submittals`,
      punch_items: '/rest/v1.0/punch_items',
      vendors: `/rest/v1.0/projects/${pid}/vendors`,
    };
    const http = this.http(ctx);
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const items = await http.get(paths[entity], { query: { project_id: pid, page, per_page: 100 } });
      out.push(...(items || []).map((data) => ({ remoteId: String(getPath(data, 'id')), data })));
      if (!items || items.length < 100) break;
    }
    return out;
  },
};

module.exports = { slack, teams, procore };
