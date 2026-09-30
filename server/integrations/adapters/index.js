'use strict';
/**
 * Adapter registry. To link a new management system, create an adapter
 * object implementing the interface below and add it to ADAPTERS.
 *
 *   key, name, category, description, docsUrl?
 *   configSchema: [{ key, label, type, secret?, required?, default?, options? }]
 *   entities:     [{ key, label, module, directions: ['pull'|'push'], fields: [{ local, remote, transform?, map? }], filter?, createMissing? }]
 *   freeformEntities?: true when admins may name their own remote entities
 *   testConnection(ctx) → { ok, message }
 *   pull(ctx, entity, { since }) → [{ remoteId, data }]
 *   push(ctx, entity, payload, remoteId?) → { remoteId }
 *   onEvent(ctx, event)       – optional, for notification-style adapters
 *   transforms: { name: { push(v), pull(v) } } – optional custom field transforms
 *   sandboxSeed: { entity: [remote objects] } – demo data for sandbox mode
 *
 * ctx = { connection, config, state, log(msg) }
 */
const { rest, csv } = require('./generic');
const { quickbooks, sageIntacct, viewpoint, cmic, foundation, acumatica } = require('./accounting');
const { autodesk, primavera, msproject, docusign } = require('./field');
const { slack, teams, procore } = require('./messaging');

const ADAPTERS = [quickbooks, sageIntacct, viewpoint, cmic, foundation, acumatica, autodesk, primavera, msproject, docusign, slack, teams, procore, rest, csv];
const byKey = Object.fromEntries(ADAPTERS.map((a) => [a.key, a]));

const getAdapter = (key) => byKey[key] || null;

function describeAdapter(a) {
  return {
    key: a.key,
    name: a.name,
    category: a.category,
    description: a.description,
    docsUrl: a.docsUrl || null,
    configSchema: a.configSchema,
    entities: a.entities,
    freeformEntities: !!a.freeformEntities,
    notifier: !!a.notifier,
    supportsSandbox: a.configSchema.some((f) => f.key === 'sandbox'),
    capabilities: ['pull', 'push', 'onEvent'].filter((c) => typeof a[c] === 'function'),
  };
}

module.exports = { ADAPTERS, getAdapter, describeAdapter };
