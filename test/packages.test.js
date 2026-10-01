'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, waitFor } = require('./helpers');
const { drawingSet, specBook } = require('./fixtures');
const { normalizeSection, toIsoDate, disciplineFor } = require('../server/packages');

let app;
let pm;
before(async () => { app = await startApp(); pm = app.as('pm'); });
after(async () => { await app.stop(); });

async function upload(kind, pdf, query = '', who = pm) {
  const res = await who.post(`/api/projects/1/packages?kind=${kind}${query}`, pdf, { headers: { 'Content-Type': 'application/pdf', 'X-Filename': `${kind}.pdf` } });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.status, 'processing');
  return waitFor(async () => {
    const p = (await pm.get(`/api/packages/${res.body.id}`)).body;
    return p.status !== 'processing' && p;
  }, 15000);
}

test('helpers', () => {
  assert.equal(normalizeSection('033000'), '03 30 00');
  assert.equal(normalizeSection('03300'), '03 30 00');
  assert.equal(toIsoDate('DATE: 3/5/26'), '2026-03-05');
  assert.equal(toIsoDate('2026-04-02'), '2026-04-02');
  assert.equal(toIsoDate('13/45/2026'), null);
  assert.equal(disciplineFor('FP-101'), 'Fire Protection');
  assert.equal(disciplineFor('S2.01'), 'Structural');
  assert.equal(disciplineFor('E0.1'), 'Electrical');
});

test('drawing set: extracts title blocks, flags problems, publishes sheets and supersedes old revisions', async () => {
  const pdf = await drawingSet([
    { number: 'A-101', title: 'FIRST FLOOR PLAN', revs: ['1', '2', '4'] },
    { number: 'S2.01', title: 'LEVEL 2 FRAMING\nPLAN', rev: 'B', date: '04/02/2026' },
    { number: 'M-301', title: 'LEVEL 3 HVAC PLAN', labelled: false },
    { blank: true },
    { number: 'FP-101', title: 'FIRE PROTECTION PLAN', rev: '1' },
  ], { rotateLast: true });
  const pkg = await upload('drawings', pdf, '&name=IFC%20Rev%204&received_date=2026-09-01');
  assert.equal(pkg.status, 'review', pkg.error);
  assert.equal(pkg.page_count, 5);
  assert.match(pkg.error, /1 page\(s\) have no text layer/);
  const [a101, s201, m301, blank, fp] = pkg.items;

  assert.deepEqual(
    { n: a101.sheet_number, t: a101.title, d: a101.discipline, r: a101.revision, dt: a101.drawing_date },
    { n: 'A-101', t: 'First Floor Plan', d: 'Architectural', r: '4', dt: '2026-03-15' },
  );
  assert.equal(a101.confidence.sheet_number, 'high');
  assert.ok(a101.existing, 'seeded A-101 is detected as the sheet to supersede');
  assert.equal(a101.existing.revision, '3');
  assert.deepEqual([s201.sheet_number, s201.title, s201.discipline, s201.revision, s201.drawing_date], ['S2.01', 'Level 2 Framing Plan', 'Structural', 'B', '2026-04-02']);
  assert.equal(m301.title, 'Level 3 HVAC Plan', 'title found without a SHEET TITLE label; acronyms kept');
  assert.equal(m301.confidence.title, 'low');
  assert.equal(blank.has_text, false);
  assert.equal(blank.confidence.sheet_number, 'none');
  assert.deepEqual([fp.sheet_number, fp.title, fp.discipline, fp.revision], ['FP-101', 'Fire Protection Plan', 'Fire Protection', '1'], 'rotated sheet');

  // Publishing with the unreadable page still included is rejected with a clear error.
  const bad = await pm.post(`/api/packages/${pkg.id}/publish`, {});
  assert.equal(bad.status, 422);
  assert.match(bad.body.errors['page 4'], /sheet number is required/);

  // Reviewer fixes page 4 by hand and drops nothing else.
  const items = pkg.items.map((i) => ({ ...i }));
  Object.assign(items[3], { sheet_number: 'e-201', title: 'Level 2 Power Plan' });
  const saved = (await pm.patch(`/api/packages/${pkg.id}`, { items })).body;
  assert.equal(saved.items[3].sheet_number, 'E-201');
  assert.equal(saved.items[3].discipline, 'Electrical', 'discipline derived from corrected number');
  assert.ok(saved.items[3].existing, 'seeded E-201 will be superseded');

  const published = await pm.post(`/api/packages/${pkg.id}/publish`, {});
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.status, 'published');
  assert.equal(published.body.results.created.length, 5);
  assert.deepEqual(published.body.results.superseded.map((x) => x.number).sort(), ['DWG-001', 'DWG-003', 'DWG-004'], 'seeded A-101, M-301 and E-201');

  const current = (await pm.get('/api/projects/1/modules/drawings?q=A-101')).body.items;
  const newA = current.find((d) => d.status === 'Current');
  const oldA = current.find((d) => d.status === 'Superseded');
  assert.equal(newA.revision, '4');
  assert.equal(newA.drawing_set, 'IFC Rev 4');
  assert.equal(newA.received_date, '2026-09-01');
  assert.ok(oldA, 'previous A-101 superseded');
  const files = (await pm.get(`/api/records/${newA.id}/files`)).body;
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^A-101 First Floor Plan rev 4\.pdf$/);
  const sheetPdf = await pm.get(`/api/files/${files[0].id}`, { raw: true });
  assert.ok(sheetPdf.body.startsWith('%PDF-'));

  assert.equal((await pm.post(`/api/packages/${pkg.id}/publish`, {})).status, 409, 'cannot publish twice');
  const list = (await pm.get('/api/projects/1/packages?kind=drawings')).body;
  assert.equal(list[0].id, pkg.id);
});

test('spec book: splits sections, skips cover and table of contents, derives divisions', async () => {
  const pdf = await specBook([
    { number: '03 30 00', title: 'Cast-in-Place Concrete', pages: 3 },
    { number: '05 12 00', title: 'Structural Steel Framing', pages: 2, inlineTitle: true },
    { number: '08 44 13', title: 'Glazed Aluminum Curtain Walls', pages: 1 },
  ]);
  const pkg = await upload('specifications', pdf, '&revision=1&issued_date=2026-08-15');
  assert.equal(pkg.status, 'review', pkg.error);
  assert.deepEqual(pkg.items.map((i) => [i.section_number, i.title, i.start_page, i.end_page, i.division]), [
    ['03 30 00', 'Cast-in-Place Concrete', 3, 5, '03 – Concrete'],
    ['05 12 00', 'Structural Steel Framing', 6, 7, '05 – Metals'],
    ['08 44 13', 'Glazed Aluminum Curtain Walls', 8, 8, '08 – Openings'],
  ]);
  assert.ok(pkg.items[0].existing, 'seeded 03 30 00 will be superseded');
  const items = pkg.items.map((i, idx) => ({ ...i, include: idx !== 2 }));
  const res = await pm.post(`/api/packages/${pkg.id}/publish`, { items });
  assert.equal(res.body.results.created.length, 2);
  const concrete = (await pm.get('/api/projects/1/modules/specifications?q=03%2030%2000')).body.items.find((s) => s.status === 'Current');
  assert.equal(concrete.revision, '1');
  assert.equal(concrete.issued_date, '2026-08-15');
  const files = (await pm.get(`/api/records/${concrete.id}/files`)).body;
  const { PDFDocument } = require('pdf-lib');
  const res2 = await fetch(`${app.base}/api/files/${files[0].id}`, { headers: { Authorization: `Bearer ${await app.login('pm')}` } });
  const doc = await PDFDocument.load(Buffer.from(await res2.arrayBuffer()));
  assert.equal(doc.getPageCount(), 3, 'section PDF contains its 3 pages');
  assert.equal((await pm.get('/api/projects/1/modules/specifications?q=08%2044%2013')).body.total, 0, 'excluded section not published');
});

test('short spec book: a two-entry table of contents is not mistaken for sections', async () => {
  const pdf = await specBook([
    { number: '09 29 00', title: 'Gypsum Board', pages: 2 },
    { number: '09 51 13', title: 'Acoustical Panel Ceilings', pages: 1 },
  ]);
  const pkg = await upload('specifications', pdf);
  assert.deepEqual(pkg.items.map((i) => [i.section_number, i.start_page, i.end_page]), [['09 29 00', 3, 4], ['09 51 13', 5, 5]]);
});

test('rejects non-PDF uploads, enforces permissions, serves page previews', async () => {
  const notPdf = await pm.post('/api/projects/1/packages?kind=drawings', Buffer.from('hello'), { headers: { 'Content-Type': 'application/pdf' } });
  assert.equal(notPdf.status, 422);
  const badKind = await pm.post('/api/projects/1/packages?kind=rfis', Buffer.from('%PDF-1.4'), { headers: { 'Content-Type': 'application/pdf' } });
  assert.equal(badKind.status, 422);
  const pdf = await drawingSet([{ number: 'C-100', title: 'SITE PLAN' }]);
  const sub = app.as('sub');
  const denied = await sub.post('/api/projects/1/packages?kind=drawings', pdf, { headers: { 'Content-Type': 'application/pdf' } });
  assert.equal(denied.status, 403);
  const pkg = await upload('drawings', pdf);
  assert.equal((await sub.get(`/api/packages/${pkg.id}`)).status, 200, 'subcontractors can read drawings uploads');
  assert.equal((await sub.patch(`/api/packages/${pkg.id}`, { items: pkg.items })).status, 403);
  assert.equal((await app.as('sub').get('/api/projects/2/packages')).status, 404);
  const page = await pm.get(`/api/packages/${pkg.id}/pages/1`, { raw: true });
  assert.equal(page.status, 200);
  assert.ok(page.body.startsWith('%PDF-'));
  assert.equal((await pm.get(`/api/packages/${pkg.id}/pages/9`)).status, 404);
  assert.equal((await pm.del(`/api/packages/${pkg.id}`)).status, 204);
  assert.equal((await pm.get(`/api/packages/${pkg.id}`)).status, 404);
});

test('corrupt PDF ends in a failed state with a readable error', async () => {
  const pkg = await upload('drawings', Buffer.from('%PDF-1.7\nthis is not really a pdf'));
  assert.equal(pkg.status, 'failed');
  assert.match(pkg.error, /Could not read PDF/);
});
