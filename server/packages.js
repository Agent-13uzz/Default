'use strict';
/**
 * Drawing set & spec book packages.
 *
 * A user uploads a multi-page PDF (a drawing set or a project manual). The
 * package is processed in the background: every page's text layer is read
 * with pdf.js and
 *   - drawings: each page becomes a sheet; the title block is located and the
 *     sheet number, title, discipline, revision and date are extracted;
 *   - specifications: pages are split into sections at "SECTION 03 30 00"
 *     headers; section number, title and division are extracted.
 * Results are held in a review state so people can correct anything the
 * extractor got wrong, then published: one Drawing / Specification record per
 * sheet or section, each with its own single-sheet PDF attached. Publishing a
 * sheet or section that already exists supersedes the current version.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseJSON } = require('./db');

const STANDARD_FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
let pdfjsPromise;
const loadPdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

// ─── Reference data ─────────────────────────────────────────────────────
const DISCIPLINE_PREFIXES = [
  ['FP', 'Fire Protection'], ['FA', 'Fire Protection'], ['F', 'Fire Protection'],
  ['G', 'General'], ['CS', 'General'], ['T', 'Telecom'], ['TN', 'Telecom'],
  ['C', 'Civil'], ['L', 'Landscape'], ['LS', 'Landscape'],
  ['A', 'Architectural'], ['AD', 'Architectural'], ['AS', 'Architectural'], ['I', 'Architectural'], ['ID', 'Architectural'],
  ['S', 'Structural'], ['SD', 'Structural'],
  ['M', 'Mechanical'], ['MD', 'Mechanical'], ['H', 'Mechanical'],
  ['P', 'Plumbing'], ['PD', 'Plumbing'],
  ['E', 'Electrical'], ['ED', 'Electrical'], ['EP', 'Electrical'], ['EL', 'Electrical'],
];
const PREFIX_MAP = new Map(DISCIPLINE_PREFIXES);

const DIVISIONS = {
  '00': 'Procurement and Contracting Requirements', '01': 'General Requirements', '02': 'Existing Conditions', '03': 'Concrete',
  '04': 'Masonry', '05': 'Metals', '06': 'Wood, Plastics, and Composites', '07': 'Thermal and Moisture Protection', '08': 'Openings',
  '09': 'Finishes', '10': 'Specialties', '11': 'Equipment', '12': 'Furnishings', '13': 'Special Construction', '14': 'Conveying Equipment',
  '21': 'Fire Suppression', '22': 'Plumbing', '23': 'Heating, Ventilating, and Air Conditioning', '25': 'Integrated Automation',
  '26': 'Electrical', '27': 'Communications', '28': 'Electronic Safety and Security', '31': 'Earthwork', '32': 'Exterior Improvements',
  '33': 'Utilities', '34': 'Transportation', '35': 'Waterway and Marine Construction', '40': 'Process Interconnections',
  '41': 'Material Processing and Handling Equipment', '42': 'Process Heating, Cooling, and Drying Equipment',
  '43': 'Process Gas and Liquid Handling', '44': 'Pollution and Waste Control Equipment', '46': 'Water and Wastewater Equipment',
  '48': 'Electrical Power Generation',
};

const SHEET_RE = /^([A-Z]{1,2})[-.\s]?(\d{1,3}(?:[.-]\d{1,3})?[A-Z]?)$/;
const SHEET_LABEL_RE = /^(SHEET|DRAWING|DWG\.?)\s*(NO\.?|NUMBER|#)?:?$|^SHEET\s*(NO\.?|NUMBER|#)/i;
const TITLE_LABEL_RE = /^(SHEET|DRAWING|DWG\.?)?\s*TITLE:?$/i;
const NOISE_RE = /^(SCALE|DATE|DRAWN|CHECKED|APPROVED|PROJECT|JOB|SHEET|REV|REVISION|ISSUE|NO\.?|BY|DESCRIPTION|NORTH|KEY ?PLAN|SEAL|STAMP|CLIENT|OWNER|ARCHITECT|ENGINEER|CONSULTANT|COPYRIGHT|NOT FOR CONSTRUCTION|FOR CONSTRUCTION|ISSUED FOR)\b/i;
const DATE_RE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/;
const REV_RE = /\bREV(?:ISION)?\.?\s*(?:NO\.?|#)?\s*[:\-]?\s*([0-9]{1,2}|[A-Z])\b/i;
const SECTION_RE = /^SECTION\s+(\d{2}\s?\d{2}\s?\d{2}(?:\.\d{2})?|\d{5})\b\s*[-–—:]?\s*(.*)$/i;
const SPEC_PART_RE = /^(PART\s+\d|\d\.\d+\s|END OF SECTION)/i;

function disciplineFor(sheetNumber) {
  const m = SHEET_RE.exec(String(sheetNumber || '').toUpperCase());
  if (!m) return null;
  return PREFIX_MAP.get(m[1]) || PREFIX_MAP.get(m[1][0]) || null;
}

/** Keep the sheet number as printed, but upper-case it and turn an internal space into a hyphen ("A 101" → "A-101"). */
function normalizeSheetNumber(s) {
  return String(s).trim().toUpperCase().replace(/^([A-Z]{1,2})\s+(?=\d)/, '$1-');
}

function normalizeSection(s) {
  const digits = String(s).replace(/\s+/g, '');
  if (/^\d{6}/.test(digits)) return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4)}`;
  if (/^\d{5}$/.test(digits)) return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4)}0`;
  return String(s).trim();
}

function toIsoDate(text) {
  const m = DATE_RE.exec(text || '');
  if (!m) return null;
  let y; let mo; let d;
  if (m[4]) { y = +m[4]; mo = +m[5]; d = +m[6]; } else { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const ACRONYMS = new Set(['HVAC', 'MEP', 'RCP', 'ADA', 'MRI', 'CMU', 'EIFS', 'MDF', 'IDF', 'UPS', 'ATS', 'LED', 'AV', 'IT', 'TI', 'PV', 'FP', 'DSA', 'OSHA', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'US', 'USA', 'NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W']);
const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'at', 'on', 'a', 'an', 'with', 'or']);
const titleCase = (s) => s.split(/(\s+|[-/&,()])/).map((w, i) => {
  if (!/[A-Za-z]/.test(w)) return w;
  if (ACRONYMS.has(w.toUpperCase()) || /\d/.test(w)) return w.toUpperCase();
  const lower = w.toLowerCase();
  return i > 0 && SMALL_WORDS.has(lower) ? lower : lower[0].toUpperCase() + lower.slice(1);
}).join('');
const tidyTitle = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').replace(/^[-–—:\s]+|[-–—:\s]+$/g, '').trim();
  return t && t === t.toUpperCase() && /[A-Z]{3}/.test(t) ? titleCase(t) : t;
};

// ─── PDF text extraction ───────────────────────────────────────────────
/**
 * Returns [{ page, width, height, items: [{ str, x, y, size }], lines: [{ text, x, y, size, items }] }]
 * Coordinates are in viewport space (origin top-left, page rotation applied).
 */
async function extractPages(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONTS, verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const t = pdfjs.Util.transform(viewport.transform, it.transform);
        const size = Math.hypot(t[2], t[3]) || it.height || 1;
        const horizontal = Math.abs(t[0]) >= Math.abs(t[1]);
        items.push({ str: it.str.trim(), x: t[4], y: t[5], size, w: horizontal ? it.width || 0 : 0, horizontal });
      }
      pages.push({ page: n, width: viewport.width, height: viewport.height, items, lines: groupLines(items.filter((i) => i.horizontal)) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, Math.min(l.size, it.size) * 0.4) && Math.abs(l.size - it.size) < Math.max(l.size, it.size) * 0.5
      && it.x - (l.x + l.w) < it.size * 6 && it.x >= l.x - it.size);
    if (line) {
      line.items.push(it);
      line.w = Math.max(line.w, it.x + it.w - line.x);
      line.size = Math.max(line.size, it.size);
    } else {
      lines.push({ y: it.y, x: it.x, w: it.w, size: it.size, items: [it] });
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

// ─── Drawing sheet detection ───────────────────────────────────────────
function analyzeSheet(p) {
  const { width: W, height: H } = p;
  const result = { page: p.page, sheet_number: '', title: '', discipline: null, revision: '', drawing_date: null, confidence: {}, has_text: p.items.length > 0 };
  if (!p.items.length) { result.confidence = { sheet_number: 'none', title: 'none' }; return result; }
  const maxSize = Math.max(...p.items.map((i) => i.size));
  const labels = p.items.filter((i) => SHEET_LABEL_RE.test(i.str));

  // Candidates: whole items or single tokens matching a sheet-number pattern.
  const candidates = [];
  for (const it of p.items) {
    const tokens = SHEET_RE.test(it.str.toUpperCase()) ? [it.str] : it.str.split(/\s+/).filter((t) => SHEET_RE.test(t.toUpperCase()));
    for (const tok of tokens) {
      const prefix = SHEET_RE.exec(tok.toUpperCase())[1];
      const nearLabel = labels.some((l) => Math.abs(l.x - it.x) < W * 0.12 && it.y - l.y > -it.size && it.y - l.y < Math.max(80, it.size * 4));
      const score = (it.x / W) * 2 + (it.y / H) * 2 + (it.size / maxSize) * 3 + (nearLabel ? 4 : 0) + (PREFIX_MAP.has(prefix) || PREFIX_MAP.has(prefix[0]) ? 1 : -2);
      candidates.push({ it, tok, score, nearLabel });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best) {
    result.sheet_number = normalizeSheetNumber(best.tok);
    result.discipline = disciplineFor(result.sheet_number);
    const inTitleBlock = best.it.x > W * 0.55 && best.it.y > H * 0.55;
    result.confidence.sheet_number = best.nearLabel || (inTitleBlock && best.it.size >= maxSize * 0.6) ? 'high' : 'low';
  } else {
    result.confidence.sheet_number = 'none';
  }

  // Title: text under an explicit "SHEET TITLE" label, otherwise the nearest wordy line above the sheet number.
  const usable = (l) => l.text.length >= 3 && /[A-Za-z]{3}/.test(l.text) && !NOISE_RE.test(l.text) && !SHEET_LABEL_RE.test(l.text)
    && !TITLE_LABEL_RE.test(l.text) && !DATE_RE.test(l.text) && !(best && l.items.includes(best.it)) && !/\b(LLC|INC\.?|LLP|P\.?C\.?)$/i.test(l.text)
    && !/^\d/.test(l.text) && !/\b(SCALE|=)\b/i.test(l.text);
  const titleLabel = p.lines.find((l) => TITLE_LABEL_RE.test(l.text));
  let titleLines = [];
  if (titleLabel) {
    titleLines = p.lines.filter((l) => l.y > titleLabel.y && l.y - titleLabel.y < titleLabel.size * 8 && Math.abs(l.x - titleLabel.x) < W * 0.15 && usable(l)).slice(0, 2);
    // Value printed beside the label on the same line, e.g. "SHEET TITLE: FLOOR PLAN".
    if (!titleLines.length) {
      const inline = p.lines.find((l) => /^(SHEET |DRAWING )?TITLE:\s*\S/i.test(l.text));
      if (inline) titleLines = [{ ...inline, text: inline.text.replace(/^(SHEET |DRAWING )?TITLE:\s*/i, '') }];
    }
  }
  if (!titleLines.length && best) {
    const ref = best.it;
    const above = p.lines.filter((l) => l.y < ref.y - ref.size * 0.3 && ref.y - l.y < Math.max(H * 0.2, 160) && l.x > W * 0.45 && Math.abs((l.x + l.w / 2) - (ref.x + ref.w / 2)) < W * 0.25 && usable(l))
      .sort((a, b) => b.y - a.y);
    if (above.length) {
      titleLines = [above[0]];
      const next = above[1];
      if (next && above[0].y - next.y < above[0].size * 2.2 && Math.abs(next.size - above[0].size) < 1.5) titleLines.unshift(next);
    }
  }
  if (!titleLines.length) {
    // Last resort: the largest wordy line in the bottom-right quadrant.
    const tb = p.lines.filter((l) => l.x > W * 0.5 && l.y > H * 0.5 && usable(l)).sort((a, b) => b.size - a.size);
    if (tb[0]) titleLines = [tb[0]];
  }
  result.title = tidyTitle(titleLines.map((l) => l.text).join(' '));
  result.confidence.title = titleLines.length ? (titleLabel ? 'high' : 'low') : 'none';

  // Revision and date from the title block region (bottom-right), falling back to the whole sheet.
  const tbLines = p.lines.filter((l) => l.x > W * 0.5 && l.y > H * 0.5);
  result.revision = findRevision(tbLines) || findRevision(p.lines) || '';
  const dateLine = tbLines.find((l) => /DATE/i.test(l.text) && DATE_RE.test(l.text)) || tbLines.find((l) => DATE_RE.test(l.text));
  if (dateLine) result.drawing_date = toIsoDate(dateLine.text);
  return result;
}

/**
 * Revision from an explicit "REV: 3" / "REVISION B" label, or from a revision
 * table: a header row containing REV and DATE/DESCRIPTION followed by rows that
 * start with the revision mark. The highest mark in the table wins.
 */
function findRevision(lines) {
  const header = lines.findIndex((l) => /\bREV(ISION)?\.?\b/i.test(l.text) && /\b(DATE|DESCRIPTION|ISSUE)\b/i.test(l.text));
  if (header >= 0) {
    const h = lines[header];
    const marks = lines.slice(header + 1)
      .filter((l) => l.y - h.y < h.size * 20 && Math.abs(l.x - h.x) < h.size * 6)
      .map((l) => /^([0-9]{1,2}|[A-Z])\b(?=\s+\S)/.exec(l.text)?.[1])
      .filter(Boolean);
    if (marks.length) {
      const nums = marks.filter((m) => /^\d+$/.test(m)).map(Number);
      return nums.length ? String(Math.max(...nums)) : marks.sort().pop();
    }
  }
  for (const l of lines) {
    const m = REV_RE.exec(l.text);
    if (m && !/\b(DATE|DESCRIPTION)\b/i.test(l.text)) return m[1].toUpperCase();
  }
  return null;
}

// ─── Spec book detection ───────────────────────────────────────────────
function analyzeSpecBook(pages) {
  const starts = [];
  const seen = new Set();
  for (const p of pages) {
    const headers = [];
    p.lines.forEach((l, idx) => {
      const m = SECTION_RE.exec(l.text);
      if (m) headers.push({ number: normalizeSection(m[1]), rest: m[2], idx, line: l });
    });
    const distinct = new Set(headers.map((h) => h.number));
    // Tables of contents list many sections; real section starts head the page.
    if (distinct.size > 2 || p.lines.slice(0, 4).some((l) => /^(TABLE OF CONTENTS|CONTENTS|INDEX)\b/i.test(l.text))) continue;
    for (const h of headers.filter((x) => x.line.y < p.height * 0.35)) {
      if (seen.has(h.number)) continue;
      seen.add(h.number);
      let title = h.rest.replace(/^[-–—:\s]+/, '');
      if (!title) {
        const next = p.lines.slice(h.idx + 1).filter((l) => l.text && !SPEC_PART_RE.test(l.text) && !SECTION_RE.test(l.text)).slice(0, 2);
        const titleParts = [];
        for (const l of next) {
          if (titleParts.length && (l.text !== l.text.toUpperCase() || l.y - next[0].y > next[0].size * 3)) break;
          titleParts.push(l.text);
        }
        title = titleParts.join(' ');
      }
      starts.push({ section_number: h.number, title: tidyTitle(title), start_page: p.page, confidence: { section_number: 'high', title: title ? 'high' : 'none' } });
    }
  }
  const endOf = new Map();
  for (const p of pages) {
    if (p.lines.some((l) => /^END OF SECTION/i.test(l.text))) endOf.set(p.page, true);
  }
  return starts.map((s, i) => {
    const nextStart = starts[i + 1]?.start_page ?? pages.length + 1;
    let end = Math.max(s.start_page, nextStart - 1);
    for (let pg = s.start_page; pg < nextStart; pg++) if (endOf.has(pg)) { end = pg; break; }
    // A new section starting on the same page as the previous one shares that page.
    if (starts[i + 1] && starts[i + 1].start_page === s.start_page) end = s.start_page;
    const div = s.section_number.slice(0, 2);
    return { ...s, end_page: end, division: DIVISIONS[div] ? `${div} – ${DIVISIONS[div]}` : div };
  });
}

// ─── PDF splitting ─────────────────────────────────────────────────────
async function extractPdfPages(buffer, from, to) {
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const indices = [];
  for (let i = from; i <= Math.min(to, src.getPageCount()); i++) indices.push(i - 1);
  for (const p of await out.copyPages(src, indices)) out.addPage(p);
  return Buffer.from(await out.save());
}

// ─── Service ───────────────────────────────────────────────────────────
function createPackageService({ db, records, uploadsDir, log = () => {} }) {
  const MODULE = { drawings: 'drawings', specifications: 'specifications' };

  function serialize(row) {
    if (!row) return null;
    return {
      id: row.id, project_id: row.project_id, kind: row.kind, name: row.name, file_name: row.file_name, file_size: row.file_size,
      status: row.status, page_count: row.page_count, defaults: parseJSON(row.defaults, {}), items: parseJSON(row.items, []),
      results: parseJSON(row.results, null), error: row.error, created_by: row.created_by, created_at: row.created_at, published_at: row.published_at,
    };
  }

  const get = (id) => serialize(db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(id)));
  const list = (projectId, kind) => db.prepare(`SELECT * FROM packages WHERE project_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY id DESC`)
    .all(...[projectId, kind].filter(Boolean)).map((r) => { const p = serialize(r); return { ...p, items: undefined, item_count: p.items.length }; });

  const filePath = (row) => path.join(uploadsDir, row.storage_path);

  function readPdf(pkg) {
    const row = db.prepare('SELECT storage_path FROM packages WHERE id = ?').get(pkg.id);
    return fs.readFileSync(filePath(row));
  }

  function cleanDefaults(kind, d = {}) {
    const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return kind === 'drawings'
      ? { drawing_set: String(d.drawing_set || '').slice(0, 200), revision: String(d.revision || '').slice(0, 20), drawing_date: date(d.drawing_date), received_date: date(d.received_date) || new Date().toISOString().slice(0, 10) }
      : { revision: String(d.revision || '').slice(0, 20), issued_date: date(d.issued_date) || new Date().toISOString().slice(0, 10) };
  }

  /** Store an uploaded PDF and queue it for background processing. */
  function create({ projectId, kind, buffer, fileName, defaults, userId }) {
    if (!MODULE[kind]) throw Object.assign(new Error('kind must be drawings or specifications'), { status: 422 });
    if (!buffer?.length || buffer.subarray(0, 1024).indexOf('%PDF-') === -1) throw Object.assign(new Error('Upload must be a PDF file'), { status: 422 });
    fs.mkdirSync(uploadsDir, { recursive: true });
    const key = `pkg-${crypto.randomUUID()}.pdf`;
    fs.writeFileSync(path.join(uploadsDir, key), buffer);
    const name = String(defaults?.name || fileName || 'Upload').replace(/\.pdf$/i, '').slice(0, 200);
    const info = db.prepare(`INSERT INTO packages (project_id, kind, name, file_name, file_size, storage_path, status, defaults, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)`).run(projectId, kind, name, fileName || 'upload.pdf', buffer.length, key, JSON.stringify(cleanDefaults(kind, { drawing_set: name, ...defaults })), userId);
    const id = Number(info.lastInsertRowid);
    const job = processPackage(id).catch((err) => log(`package ${id} failed: ${err.message}`));
    return { pkg: get(id), job };
  }

  function existingFor(projectId, kind, number) {
    const field = kind === 'drawings' ? 'sheet_number' : 'section_number';
    const row = db.prepare(`SELECT id, number, status, json_extract(data, '$.revision') AS revision FROM records
      WHERE module = ? AND project_id = ? AND deleted_at IS NULL AND upper(json_extract(data, '$.${field}')) = upper(?) AND status = 'Current' ORDER BY id DESC`)
      .get(MODULE[kind], projectId, number);
    return row ? { id: row.id, number: row.number, revision: row.revision } : null;
  }

  async function processPackage(id) {
    const pkg = get(id);
    try {
      const pages = await extractPages(readPdf(pkg));
      let items;
      if (pkg.kind === 'drawings') {
        items = pages.map((p) => {
          const a = analyzeSheet(p);
          if (!a.sheet_number && pages.length === 1) {
            // Single sheet uploads often carry the sheet number in the file name ("A-101 Floor Plan.pdf").
            const m = /^([A-Z]{1,2}[-.]?\d{1,3}(?:[.-]\d{1,3})?[A-Z]?)\s*[-_ ]\s*(.*)$/i.exec(pkg.file_name.replace(/\.pdf$/i, ''));
            if (m) { a.sheet_number = normalizeSheetNumber(m[1]); a.discipline = disciplineFor(a.sheet_number); a.title ||= tidyTitle(m[2].replace(/[_-]+/g, ' ')); a.confidence = { sheet_number: 'low', title: 'low' }; }
          }
          return {
            page: a.page, include: true, sheet_number: a.sheet_number, title: a.title || (a.has_text ? '' : `Page ${a.page}`),
            discipline: a.discipline, revision: a.revision || pkg.defaults.revision || '', drawing_date: a.drawing_date || pkg.defaults.drawing_date || null,
            confidence: a.confidence, has_text: a.has_text,
          };
        });
        // Duplicate sheet numbers inside one set usually mean a misread – flag them.
        const counts = items.reduce((m, i) => m.set(i.sheet_number, (m.get(i.sheet_number) || 0) + 1), new Map());
        for (const i of items) if (i.sheet_number && counts.get(i.sheet_number) > 1) i.confidence.sheet_number = 'duplicate';
      } else {
        items = analyzeSpecBook(pages).map((s) => ({ ...s, include: true, revision: pkg.defaults.revision || '' }));
      }
      for (const i of items) {
        const num = pkg.kind === 'drawings' ? i.sheet_number : i.section_number;
        if (num) i.existing = existingFor(pkg.project_id, pkg.kind, num);
      }
      const textless = pages.filter((p) => !p.items.length).length;
      db.prepare("UPDATE packages SET status = 'review', page_count = ?, items = ?, error = ? WHERE id = ?")
        .run(pages.length, JSON.stringify(items), textless ? `${textless} page(s) have no text layer (scanned images) – enter their details manually or upload an OCR'd PDF.` : null, id);
    } catch (err) {
      db.prepare("UPDATE packages SET status = 'failed', error = ? WHERE id = ?").run(`Could not read PDF: ${err.message}`, id);
    }
    return get(id);
  }

  function updateItems(id, items) {
    const pkg = get(id);
    if (!pkg) throw Object.assign(new Error('Package not found'), { status: 404 });
    if (pkg.status !== 'review') throw Object.assign(new Error(`Package is ${pkg.status}`), { status: 409 });
    if (!Array.isArray(items) || items.length !== pkg.items.length) throw Object.assign(new Error('items must match the extracted items'), { status: 422 });
    const str = (v, n = 200) => (v == null ? '' : String(v).slice(0, n).trim());
    const clean = items.map((it, i) => {
      const base = pkg.items[i];
      const out = { ...base, include: it.include !== false, revision: str(it.revision, 20), title: str(it.title, 300) };
      if (pkg.kind === 'drawings') {
        out.sheet_number = str(it.sheet_number, 30).toUpperCase();
        out.discipline = it.discipline || disciplineFor(out.sheet_number);
        out.drawing_date = it.drawing_date && /^\d{4}-\d{2}-\d{2}$/.test(it.drawing_date) ? it.drawing_date : null;
        out.existing = out.sheet_number ? existingFor(pkg.project_id, pkg.kind, out.sheet_number) : null;
      } else {
        out.section_number = str(it.section_number, 30);
        out.division = str(it.division, 100);
        out.existing = out.section_number ? existingFor(pkg.project_id, pkg.kind, out.section_number) : null;
      }
      return out;
    });
    db.prepare('UPDATE packages SET items = ? WHERE id = ?').run(JSON.stringify(clean), id);
    return get(id);
  }

  function attach(recordId, projectId, buffer, name, userId) {
    const key = `${crypto.randomUUID()}.pdf`;
    fs.writeFileSync(path.join(uploadsDir, key), buffer);
    db.prepare('INSERT INTO files (record_id, project_id, name, mime, size, storage_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(recordId, projectId, name, 'application/pdf', buffer.length, key, userId);
  }

  /** Create one record per included sheet/section, attach its pages, supersede older versions. */
  async function publish(id, actor) {
    const pkg = get(id);
    if (!pkg) throw Object.assign(new Error('Package not found'), { status: 404 });
    if (pkg.status !== 'review') throw Object.assign(new Error(`Package is ${pkg.status}`), { status: 409 });
    const included = pkg.items.filter((i) => i.include);
    const numberField = pkg.kind === 'drawings' ? 'sheet_number' : 'section_number';
    const errors = {};
    included.forEach((i) => {
      const at = pkg.kind === 'drawings' ? `page ${i.page}` : `section starting page ${i.start_page}`;
      if (!i[numberField]) errors[at] = `${numberField.replace('_', ' ')} is required`;
      else if (!i.title) errors[at] = 'title is required';
    });
    const nums = included.map((i) => String(i[numberField]).toUpperCase());
    nums.forEach((n, idx) => { if (n && nums.indexOf(n) !== idx) errors[`${numberField} ${n}`] = 'appears more than once in this package'; });
    if (Object.keys(errors).length) throw Object.assign(new Error('Fix the highlighted items before publishing'), { status: 422, errors });

    db.prepare("UPDATE packages SET status = 'publishing' WHERE id = ?").run(id);
    const pdf = readPdf(pkg);
    const created = [];
    const superseded = [];
    try {
      for (const item of included) {
        const prev = existingFor(pkg.project_id, pkg.kind, item[numberField]);
        const data = pkg.kind === 'drawings'
          ? { sheet_number: item.sheet_number, title: item.title, discipline: item.discipline || undefined, revision: item.revision || undefined, drawing_set: pkg.defaults.drawing_set || pkg.name, drawing_date: item.drawing_date || undefined, received_date: pkg.defaults.received_date, notes: `Imported from package "${pkg.name}" (page ${item.page})`, status: 'Current' }
          : { section_number: item.section_number, title: item.title, division: item.division || undefined, revision: item.revision || undefined, issued_date: pkg.defaults.issued_date, notes: `Imported from package "${pkg.name}" (pages ${item.start_page}–${item.end_page})`, status: 'Current' };
        const rec = records.create(pkg.kind, pkg.project_id, data, actor);
        const from = pkg.kind === 'drawings' ? item.page : item.start_page;
        const to = pkg.kind === 'drawings' ? item.page : item.end_page;
        const safe = `${item[numberField]} ${item.title}`.replace(/[^\w .()-]+/g, '_').slice(0, 120);
        attach(rec.id, pkg.project_id, await extractPdfPages(pdf, from, to), `${safe}${item.revision ? ` rev ${item.revision}` : ''}.pdf`, actor?.user_id);
        if (prev && prev.id !== rec.id) {
          records.update(prev.id, { status: 'Superseded' }, actor);
          superseded.push(prev);
        }
        created.push({ id: rec.id, number: rec.number, [numberField]: item[numberField], title: item.title });
      }
    } catch (err) {
      db.prepare("UPDATE packages SET status = 'review', error = ? WHERE id = ?").run(`Publishing stopped: ${err.message}`, id);
      throw err;
    }
    db.prepare("UPDATE packages SET status = 'published', results = ?, published_at = datetime('now'), error = NULL WHERE id = ?")
      .run(JSON.stringify({ created, superseded }), id);
    return get(id);
  }

  function remove(id) {
    const row = db.prepare('SELECT * FROM packages WHERE id = ?').get(Number(id));
    if (!row) throw Object.assign(new Error('Package not found'), { status: 404 });
    db.prepare('DELETE FROM packages WHERE id = ?').run(row.id);
    fs.rm(filePath(row), { force: true }, () => {});
  }

  async function pagePdf(id, page) {
    const pkg = get(id);
    if (!pkg || !pkg.page_count || page < 1 || page > pkg.page_count) throw Object.assign(new Error('Page not found'), { status: 404 });
    return extractPdfPages(readPdf(pkg), page, page);
  }

  return { create, get, list, processPackage, updateItems, publish, remove, pagePdf, readPdf };
}

module.exports = { createPackageService, extractPages, analyzeSheet, analyzeSpecBook, normalizeSheetNumber, normalizeSection, disciplineFor, toIsoDate };
