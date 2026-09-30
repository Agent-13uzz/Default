'use strict';
const { MODULES } = require('./modules');

const TYPE_MAP = {
  text: { type: 'string' },
  textarea: { type: 'string' },
  number: { type: 'number' },
  currency: { type: 'number', format: 'double' },
  percent: { type: 'number' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  boolean: { type: 'boolean' },
  user: { type: 'integer', description: 'User id' },
  company: { type: 'integer', description: 'Directory company id' },
};

function fieldSchema(f) {
  if (f.type === 'select') return { type: 'string', enum: f.options };
  if (f.type === 'multiselect') return { type: 'array', items: { type: 'string', enum: f.options } };
  if (f.type === 'ref') return { type: 'integer', description: `${f.module} record id` };
  if (f.type === 'lines') {
    return { type: 'array', items: { type: 'object', properties: Object.fromEntries(f.fields.map((s) => [s.key, fieldSchema(s)])) } };
  }
  return { ...(TYPE_MAP[f.type] || { type: 'string' }) };
}

/** Generates an OpenAPI 3.1 document for the public REST API from the module registry. */
function buildOpenApi(baseUrl = '/') {
  const schemas = {};
  const paths = {};
  for (const m of MODULES) {
    const name = m.singular.replace(/[^A-Za-z]/g, '');
    const props = Object.fromEntries(m.fields.map((f) => [f.key, { ...fieldSchema(f), title: f.label }]));
    schemas[`${name}Input`] = { type: 'object', required: m.fields.filter((f) => f.required && !f.showIf).map((f) => f.key), properties: props };
    schemas[name] = {
      allOf: [
        { $ref: `#/components/schemas/${name}Input` },
        { type: 'object', properties: { id: { type: 'integer' }, number: { type: 'string' }, project_id: { type: ['integer', 'null'] }, created_at: { type: 'string' }, updated_at: { type: 'string' }, computed: { type: 'object' } } },
      ],
    };
    const base = m.scope === 'project' ? `/api/projects/{projectId}/modules/${m.key}` : `/api/company/modules/${m.key}`;
    const params = m.scope === 'project' ? [{ name: 'projectId', in: 'path', required: true, schema: { type: 'integer' } }] : [];
    const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
    const tag = m.label;
    paths[base] = {
      get: {
        tags: [tag], summary: `List ${m.label}`, parameters: [...params,
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Comma-separated statuses' },
          { name: 'open', in: 'query', schema: { type: 'boolean' } },
          { name: 'overdue', in: 'query', schema: { type: 'boolean' } },
          { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'sort', in: 'query', schema: { type: 'string' } },
          { name: 'dir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000 } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: `#/components/schemas/${name}` } }, total: { type: 'integer' } } } } } } },
      },
      post: {
        tags: [tag], summary: `Create ${m.singular}`, parameters: params,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}Input` } } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } }, 422: { description: 'Validation error' } },
      },
    };
    paths[`${base}/{id}`] = {
      get: { tags: [tag], summary: `Get ${m.singular}`, parameters: [...params, idParam], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } } },
      patch: { tags: [tag], summary: `Update ${m.singular}`, parameters: [...params, idParam], requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}Input` } } } }, responses: { 200: { description: 'OK' } } },
      delete: { tags: [tag], summary: `Delete ${m.singular}`, parameters: [...params, idParam], responses: { 204: { description: 'Deleted' } } },
    };
  }
  paths['/api/projects'] = { get: { tags: ['Projects'], summary: 'List projects', responses: { 200: { description: 'OK' } } }, post: { tags: ['Projects'], summary: 'Create project', responses: { 201: { description: 'Created' } } } };
  paths['/api/projects/{projectId}/budget'] = { get: { tags: ['Financial Management'], summary: 'Budget report with computed columns', parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'OK' } } } };
  paths['/api/integrations/inbound/{connectionId}'] = {
    post: {
      tags: ['Integrations'], summary: 'Inbound webhook from an external system', security: [],
      description: 'Sign the raw body with HMAC-SHA256 using the connection inbound secret and send it as `X-Keystone-Signature: sha256=<hex>`.',
      parameters: [{ name: 'connectionId', in: 'path', required: true, schema: { type: 'integer' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { entity: { type: 'string' }, action: { type: 'string', enum: ['upsert', 'delete'] }, id_field: { type: 'string' }, records: { type: 'array', items: { type: 'object' } } } } } } },
      responses: { 200: { description: 'Processed' }, 401: { description: 'Bad signature' } },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Keystone Construction Platform API', version: '1.0.0', description: 'REST API for every Keystone tool. Authenticate with `Authorization: Bearer <api key>` (create keys under Admin → API Keys). Subscribe to changes with webhooks.' },
    servers: [{ url: baseUrl }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas },
    paths,
  };
}

module.exports = { buildOpenApi };
