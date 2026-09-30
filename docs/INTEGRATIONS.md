# Integration Guide

Keystone can exchange data with other management software in four ways. Connectors, inbound webhooks and
outbound webhooks are managed by **company admins** under *Integrations* and *Webhooks*. API keys are self-service
under *API & Developers*.

## 1. Connectors

A **connection** is an instance of an adapter plus:

| Setting | Meaning |
|---|---|
| Project scope | Limit to one project. Required to *import* project-level records such as RFIs or schedules. |
| Config | Adapter-specific credentials and options. Secret values are masked in every API response. |
| Mappings | Which remote entity maps to which Keystone tool, in which direction, with which field rules |
| Realtime push | Push a record to the remote system as soon as it is created or updated in Keystone |
| Scheduled sync | Run a full two-way sync every *N* minutes |
| Sandbox | Simulate the remote system (available on vendor adapters) |

### Mappings

```jsonc
{
  "entity": "Vendor",               // remote entity (adapter-defined, or free-form for REST/CSV)
  "module": "directory",            // Keystone tool key
  "direction": "both",              // pull | push | both
  "filter": { "status": "Approved" }, // optional: only push records matching these values
  "matchOn": "name",                // optional: link to existing records by this field on first pull
  "createMissing": true,            // create Keystone records for unknown remote records on pull
  "fields": [
    { "local": "name",  "remote": "DisplayName" },
    { "local": "email", "remote": "PrimaryEmailAddr.Address" },              // dot paths
    { "local": "status", "remote": "Active", "map": { "true": "Active", "false": "Inactive" } }, // remote → local values
    { "local": "vendor", "remote": "VendorRef.name", "transform": "company_name" },
    { "local": "company_type", "remote": "type", "direction": "push" }       // one-way field
  ]
}
```

Built-in transforms: `string`, `number`, `date`, `bool`, `percent_fraction` (0–1 ↔ 0–100), `company_name`,
`company_email` and `user_email`. The last three resolve Directory and user references in either direction. Adapters can add
their own, for example `lines_to_qbo` for QuickBooks line items.

### Sync semantics
- **Pull:** remote records are matched through the link table (`external_links`), then through `matchOn`
  (company-level tools default to matching on their name), and otherwise created. Only mapped fields are overwritten.
  Validation errors are logged per record and do not stop the job.
- **Push:** each record is mapped and hashed. If the hash matches the last synced hash, the record is skipped, so repeated
  syncs are idempotent. New records are created remotely and existing links are updated.
- **Echo suppression:** changes written by a connection never trigger that same connection's realtime push.
- Every job records stats (`pulled`, `created`, `updated`, `pushed`, `skipped`, `failed`) and a log you can view under *Sync History*.
  Changes made by integrations appear in the audit log as `Integration: <name>`.

### Writing a new adapter
Create an object that implements the interface documented in `server/integrations/adapters/index.js` and add it to
`ADAPTERS`. At minimum:

```js
module.exports = {
  key: 'my_erp', name: 'My ERP', category: 'Accounting / ERP', description: '…',
  configSchema: [{ key: 'api_key', label: 'API Key', type: 'text', secret: true, required: true }],
  entities: [{ key: 'vendors', label: 'Vendors', module: 'directory', directions: ['pull', 'push'],
               fields: [{ local: 'name', remote: 'vendor_name' }] }],
  async testConnection(ctx) { /* call the API */ return { ok: true, message: 'Connected' }; },
  async pull(ctx, entity) { return [{ remoteId: '1', data: { vendor_name: 'Acme' } }]; },
  async push(ctx, entity, payload, remoteId) { return { remoteId: remoteId || 'new-id' }; },
};
```

`ctx` provides `config`, persistent `state` and `log()`. `util.createHttp()` gives you a fetch wrapper with timeouts
and useful error messages.

## 2. Inbound webhooks

Each connection has an endpoint and a signing secret (*Integrations → connection → Inbound Webhook*).

```
POST /api/integrations/inbound/{connectionId}
X-Keystone-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>

{ "entity": "vendors", "action": "upsert", "id_field": "id", "records": [ { "id": "V-1", "name": "Acme" } ] }
```

`action: "delete"` soft-deletes the linked Keystone records. The response returns the job stats and any per-record errors.

## 3. Outbound webhooks

Subscribe a URL to event patterns (`*`, `rfis.*`, `*.status_changed`, `change_orders.updated`), optionally for a single project.

```
POST <your url>
X-Keystone-Event: rfis.created
X-Keystone-Delivery: 42
X-Keystone-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>

{ "id": "…", "event": "rfis.created", "occurred_at": "…", "project_id": 1, "module": "rfis",
  "actor": { "user_id": 2, "name": "Jordan Blake", "source": "web" }, "data": { …record… }, "changes": { … } }
```

Failed deliveries are retried up to 6 times (after 30 s, 2 min, 10 min, 30 min and 2 h). Every delivery is logged and can be redelivered.

## 4. REST API

- Authenticate with `Authorization: Bearer <api key>` or `X-API-Key: <api key>`.
- The OpenAPI 3.1 spec is at `GET /api/openapi.json`.
- Project tools: `/api/projects/{projectId}/modules/{tool}[/{id}]`. Company tools: `/api/company/modules/{directory|equipment}[/{id}]`.
- List parameters: `q`, `status` (comma separated), `open`, `overdue`, `assignee` (`me` or id), `filter[field]=value`,
  `updated_since`, `sort`, `dir`, `limit` (≤ 1000) and `offset`.
- Validation errors return `422 { error, errors: { field: message } }`.

## Security notes
- Connection secrets are masked in responses. They are stored in the application database, so protect the database file
  or replace `cleanConfig` with a KMS-backed secret store.
- Only admins can configure connectors and webhooks. Those settings make the server send HTTP requests to admin-supplied
  URLs, so in a multi-tenant deployment add egress allow-listing.
- API keys are stored as SHA-256 hashes and shown only once. Read-only keys can never write.
