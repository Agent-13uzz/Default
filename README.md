# Keystone – Construction Management Platform

Keystone is a Procore-inspired construction management platform: one place for project management,
quality & safety, financials, preconstruction and field resources, with a backend built to **link
other management software** (accounting/ERP, scheduling, design/BIM, e-signature, messaging and anything with an API).

It has no build step and three runtime dependencies (Express, plus pdf.js and pdf-lib for reading and splitting drawing sets). Data is stored in SQLite through Node's built-in `node:sqlite`.

```bash
npm install
npm start            # http://localhost:3000, demo data is seeded on first run
npm test             # 33 API, financial, integration and drawing/spec upload tests
npm run seed         # wipe the local database and re-seed demo data
```

Requires **Node.js 22.5+**.

### Demo accounts (password `keystone123`)

| Email | Role | What you'll see |
|---|---|---|
| `admin@keystone.test` | Company Admin | Everything, including Integrations, Webhooks, Users, Audit Log |
| `pm@keystone.test` | Project Manager | All project tools and financials |
| `super@keystone.test` | Superintendent | Field tools; read-only on most financials |
| `sub@keystone.test` | Subcontractor | Can write RFIs, submittals, punch items, quality/safety items; no financials |
| `owner@keystone.test` | Read Only | View-only; no financials |

---

## Features

### Tools (27 modules)

| Area | Tools |
|---|---|
| **Core** | Portfolio, Project Home dashboard, Company Directory, Tasks, Documents, Photos, Schedule (list, board and **Gantt** views with critical path), Equipment |
| **Project Management** | RFIs (ball-in-court, cost and schedule impact), Submittals (approval workflow, lead times), Drawings, Specifications, Daily Log (manpower, equipment, deliveries, weather), Meetings (action items become tasks), Correspondence, Transmittals, Action Plans |
| **Quality & Safety** | Punch List, Inspections (pass/fail checklists), Observations, Incidents (OSHA recordable, TRIR) |
| **Financial Management** | Budget (live Procore-style columns), Prime Contracts, Commitments (subcontracts and POs), Change Events, Change Orders (prime and commitment), Invoicing / Pay Apps with retainage, Direct Costs |
| **Preconstruction** | Bidding (bid packages, bidder leveling, low bid), Estimating (qty × unit cost and markup) |
| **Resource Management** | Timesheets (labor cost with overtime), Equipment |

### Features shared by every tool
- Auto-numbering (`RFI-001`, `SC-004`, …), configurable statuses, due dates and **overdue** tracking
- List view with search, status, open, overdue and "assigned to me" filters, sorting, and **CSV export**
- **Kanban board** with drag-and-drop status changes
- Detail page with computed summaries, **attachments** (drag and drop, image previews), **comments with @mentions**,
  a **full change history** (field-level diffs), related records and linked external records
- In-app **notifications** when you are assigned or @mentioned; "My Open Items" across all projects
- Workflow shortcuts that pre-fill the next record: RFI → Change Event → Change Order, Observation → Punch Item,
  failed Inspection items → Observation, Bid award → Commitment, Contract → Invoice / Change Order, Meeting action items → Tasks
- Global search, print-friendly pages, dark mode, and a responsive layout for phones

### Drawing set & spec book uploads
On **Drawings** or **Specifications**, click **Upload Drawing Set** or **Upload Spec Book** and select one multi-page PDF.
- **Drawings:** each page becomes a sheet. Keystone reads the title block text and fills in the **sheet number**, **title**,
  **discipline** (from the sheet prefix: A, S, M, P, E, FP…), **revision** (from a "REV" label or the highest entry in a
  revision table) and **date**. It handles rotated sheets, ignores sheet references in the drawing area such as `5/A-501`,
  and keeps sheet numbers as printed.
- **Specifications:** the book is split into sections at `SECTION 03 30 00` headers. The cover and table of contents are skipped.
  Each section gets its number, title, page range and MasterFormat **division**.
- **Review before publishing:** low-confidence fields are highlighted yellow, and missing or duplicate fields red. Click a page
  number to compare against the sheet, edit anything, apply a revision to every item at once, or exclude pages.
- **Publish:** creates one Drawing/Specification per sheet or section, each with its own PDF of just those pages attached.
  If the same sheet or section number is already current, the older one is marked **Superseded**. Lists show current items by default.

Scanned PDFs that have no text layer can't be read automatically (there's no OCR yet). Those pages are flagged, and you
type their details in during review.

### Financials
Every budget column is calculated when it is read, so there are no stored totals to fall out of sync:

| Column | Formula |
|---|---|
| Revised Budget | Original + Budget Modifications + Approved prime-contract COs |
| Projected Budget | Revised + Pending prime-contract COs |
| Committed Costs | Approved/Complete commitments + approved commitment COs |
| Projected Costs | Committed + Approved Direct Costs + Pending commitment COs |
| Job-to-Date Costs | Approved/Paid subcontractor invoices + Direct Costs |
| Forecast to Complete | Manual override, or max(Projected Budget − Projected Costs, 0) |
| Est. Cost at Completion | Projected Costs + Forecast to Complete |
| Projected Over/Under | Projected Budget − Est. Cost at Completion |

Costs with no matching budget line show up as **Unbudgeted** lines. Contracts show original value, approved and pending COs,
revised value, invoiced, paid, retainage held and remaining balance.

### Reports
Open Items by Tool, Overdue by Assignee, RFI Log (average days to answer), Submittal Log, Safety Summary (TRIR),
Manpower by Company, Commitments Summary and Change Order Log. Every report can be exported to CSV.

### Permissions
Role templates (Admin, Project Manager, Superintendent, Subcontractor, Read Only) grant `none`, `read`, `write` or `admin` per tool group,
with per-tool overrides. Access is also limited to project membership. These rules are enforced on every API call,
including API keys, and the matrix is shown under **Users & Permissions**.

---

## Linking other management software

The integration layer lives in [`server/integrations/`](server/integrations) and is documented in
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md). There are four ways to connect a system:

1. **Connectors (adapters):** two-way sync with field mapping, run manually, on a schedule or in **realtime**
   on every change.
   | Category | Connectors |
   |---|---|
   | Accounting / ERP | QuickBooks Online, Sage Intacct, Viewpoint Vista/Spectrum, CMiC, Foundation, Acumatica |
   | Scheduling | Oracle Primavera P6, Microsoft Project (MSPDI XML) |
   | Design / BIM | Autodesk Construction Cloud (Issues, RFIs) |
   | E-Signature | DocuSign (send commitments for signature; completed envelopes mark them Approved) |
   | Communication | Slack, Microsoft Teams (activity notifications) |
   | Migration | Procore (import RFIs, submittals, punch items, vendors) |
   | Generic | **Any JSON REST API** (configure endpoints, no code needed), **CSV** import/export |
2. **Inbound webhooks:** any system can POST HMAC-signed changes to `/api/integrations/inbound/:connectionId`.
   They are mapped and upserted (or deleted) through the connection's mappings.
3. **Outbound webhooks:** subscribe any URL (Zapier, Make, n8n, Power Automate, middleware) to events such as
   `rfis.created` or `change_orders.status_changed`. Deliveries are signed, logged, retried with backoff and can be redelivered.
4. **REST API:** every tool exposes list/create/get/update/delete, with an **OpenAPI 3.1** spec at `/api/openapi.json`.
   Read-only or read/write **API keys** can be created under *API & Developers*. `updated_since` supports incremental sync.

**Sandbox mode:** vendor connectors can run against a simulated remote system, so you can try the full flow
(mapping, pull, push, remote edits, conflicts, sync history) before entering real credentials. The demo data includes a
QuickBooks connection in sandbox mode. Open **Integrations → QuickBooks Online (Sandbox) → Sync Now** to try it.

---

## Architecture

```
server/
  modules.js            Declarative registry of all 27 tools (fields, statuses, numbering, workflow metadata)
  records.js            Generic record service: validation/coercion, numbering, audit, notifications, events
  financials.js         Budget report, contract/invoice/estimate/bid/daily-log roll-ups (computed on read)
  auth.js               Password hashing (scrypt), sessions, API keys, role permission templates
  events.js             Domain event bus (<tool>.created|updated|deleted|status_changed)
  openapi.js            OpenAPI generator driven by the module registry
  routes/core.js        Projects, generic CRUD, dashboards, reports, search, files, comments
  routes/admin.js       Users, API keys, audit log, integration and webhook endpoints
  packages.js           Drawing set / spec book extraction (pdf.js), review, publish, per-sheet PDF splitting (pdf-lib)
  routes/packages.js    Upload, review, publish and page-preview endpoints
  integrations/
    engine.js           Connections, field mapping, sync jobs, realtime push, scheduler, inbound webhooks, sandbox
    webhooks.js         Outbound webhook dispatcher with persistence, HMAC signatures and retries
    adapters/           One file per family of connectors (interface documented in adapters/index.js)
public/                 Dependency-free single-page web client (driven by /api/meta)
test/                   node:test suites: API, permissions, financial math, integrations against live mock servers
```

Adding a tool usually means adding one entry to `MODULES`: the API, validation, OpenAPI docs, UI forms, lists, boards,
exports and integration mappings all come from that entry.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `KEYSTONE_DB` | `data/keystone.db` | SQLite file (`:memory:` for ephemeral) |
| `KEYSTONE_UPLOADS` | `data/uploads` | Attachment storage directory |
| `KEYSTONE_SEED` | `true` | Set to `false` to skip seeding demo data into an empty database |

### Current limitations
- **Vendor connectors** are written against each vendor's published REST API, but they have only been tested in
  sandbox mode and against mock servers, not against live vendor accounts. OAuth authorization-code flows are not
  built in: admins paste an access token. For production use you would add token refresh per vendor and validate against a real tenant.
- ERP presets (Viewpoint, CMiC, Foundation, Acumatica) use the Generic REST connector with default endpoints. Paths vary
  between installations, so adjust them per tenant.
- Drawing/spec extraction uses the PDF's text layer. Scanned sets without one need OCR first (e.g. Acrobat's "Recognize Text")
  or manual entry during review. Title-block layouts vary widely, so expect to correct some fields; the review step is there for that.
- Not yet implemented: drawing markup/BIM viewer, email delivery of notifications, native mobile apps, SSO/SAML,
  and multi-company tenancy. The data model assumes one company per deployment.
- SQLite fits a single-server deployment. For scale-out you would swap `db.js` for Postgres (the queries use standard SQL plus JSON functions).
